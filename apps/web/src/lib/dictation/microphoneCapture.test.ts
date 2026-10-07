import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startMicrophoneCapture } from "./microphoneCapture";

class FakeTrack extends EventTarget {
  stopped = false;
  stop() {
    // Like a real track, stopping it ourselves never fires `ended`.
    this.stopped = true;
  }
}

class FakeAudioContext {
  state = "running";
  readonly destination = {};
  readonly audioWorklet = { addModule: async () => undefined };
  async resume() {}
  async close() {
    this.state = "closed";
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
}

class FakeWorkletNode extends EventTarget {
  readonly port = { addEventListener: () => undefined, start: () => undefined };
  connect() {}
}

function microphone() {
  const track = new FakeTrack();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  return track;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startMicrophoneCapture", () => {
  it("hands the microphone back when audio cannot start", async () => {
    const track = microphone();
    vi.stubGlobal("AudioContext", function AudioContext() {
      throw new Error("no audio device");
    });

    await expect(
      startMicrophoneCapture(
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("no audio device");
    expect(track.stopped).toBe(true);
  });

  it("reports a microphone that goes away mid-recording once, and releases it", async () => {
    const track = microphone();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const onInterrupted = vi.fn();

    const capture = await startMicrophoneCapture(() => undefined, onInterrupted);
    track.dispatchEvent(new Event("ended"));
    track.dispatchEvent(new Event("ended"));
    await capture.stop();

    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
  });
});
