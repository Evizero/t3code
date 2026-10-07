// Always its own file: a worklet module loads under the page's script policy, which refuses the
// data: URL a small asset would otherwise be inlined as.
import pcmCaptureWorkletUrl from "./pcmCaptureWorklet.js?url&no-inline";

export interface MicrophoneCapture {
  /** Stops recording after delivering the audio still buffered in the worklet. */
  readonly stop: () => Promise<void>;
  /** Stops recording and drops buffered audio. */
  readonly cancel: () => void;
}

/** Microphone access needs HTTPS or localhost; plain-HTTP LAN origins never get it. */
export function microphoneCaptureAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode === "function"
  );
}

const FLUSH_TIMEOUT_MS = 1_000;

type WorkletMessage =
  | { readonly type: "chunk"; readonly pcm: ArrayBuffer }
  | { readonly type: "flushed"; readonly pcm: ArrayBuffer };

/** The microphone went away mid-recording: unplugged, taken by the system, or access revoked. */
const MICROPHONE_INTERRUPTED_MESSAGE =
  "The microphone stopped. It may have been disconnected or its access turned off.";

/**
 * Records mono 16 kHz 16-bit little-endian PCM and hands it over in 128 ms chunks.
 * `onInterrupted` is called at most once, if recording ends before `stop` or `cancel`; the
 * microphone is already released by then.
 */
export async function startMicrophoneCapture(
  onPcm: (pcm: Uint8Array) => void,
  onInterrupted: (error: Error) => void,
): Promise<MicrophoneCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let context: AudioContext | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const track of stream.getTracks()) track.stop();
    void context?.close();
  };
  // Every failure from here on must hand the microphone back.
  try {
    // The device rate is kept; the worklet resamples, since some browsers refuse
    // to connect a microphone to a context running at a different rate.
    context = new AudioContext();
    return await record(stream, context, release, onPcm, onInterrupted);
  } catch (error) {
    release();
    throw error;
  }
}

async function record(
  stream: MediaStream,
  context: AudioContext,
  release: () => void,
  onPcm: (pcm: Uint8Array) => void,
  onInterrupted: (error: Error) => void,
): Promise<MicrophoneCapture> {
  // Created after the permission prompt, so some browsers start it suspended.
  await context.resume();
  await context.audioWorklet.addModule(pcmCaptureWorkletUrl);
  const node = new AudioWorkletNode(context, "t3-pcm-capture");
  context.createMediaStreamSource(stream).connect(node);
  // The node writes silence; connecting it keeps the graph pulling audio through it.
  node.connect(context.destination);

  let flushed: (() => void) | null = null;
  let delivering = true;
  node.port.addEventListener("message", (event: MessageEvent<WorkletMessage>) => {
    if (!delivering) return;
    if (event.data.pcm.byteLength > 0) onPcm(new Uint8Array(event.data.pcm));
    if (event.data.type === "flushed") flushed?.();
  });
  node.port.start();

  let stopped = false;
  const interrupt = () => {
    if (stopped) return;
    stopped = true;
    delivering = false;
    release();
    onInterrupted(new Error(MICROPHONE_INTERRUPTED_MESSAGE));
  };
  // `ended` fires only when the track ends on its own, never for our own `track.stop()`.
  for (const track of stream.getTracks()) track.addEventListener("ended", interrupt);
  node.addEventListener("processorerror", interrupt);

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      if (context.state === "running") {
        await new Promise<void>((resolve) => {
          flushed = resolve;
          // A worklet that never answers loses only its last 128 ms, not the recording.
          setTimeout(resolve, FLUSH_TIMEOUT_MS);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no target origin
          node.port.postMessage("flush");
        });
      }
      release();
    },
    // Also valid while `stop` waits for the flush.
    cancel: () => {
      stopped = true;
      delivering = false;
      flushed?.();
      release();
    },
  };
}
