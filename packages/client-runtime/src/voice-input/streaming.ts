import { DICTATION_MAX_FEED_BYTES } from "@t3tools/contracts";

/** One dictation session on an environment. Each call settles once the environment answered. */
export interface StreamingDictationTransport {
  readonly start: () => Promise<void>;
  /** Sends PCM recorded since the last feed and returns the whole transcript so far. */
  readonly feed: (audio: Uint8Array) => Promise<string>;
  readonly finish: () => Promise<string>;
  readonly cancel: () => Promise<void>;
}

interface StreamingDictationCallbacks {
  readonly onTranscript: (text: string) => void;
  /** Called once when the session can no longer transcribe. */
  readonly onError: (error: unknown) => void;
}

/** 128 ms of 16 kHz 16-bit audio, enough for the model to make progress on each round trip. */
export const STREAMING_DICTATION_MIN_FEED_BYTES = 4_096;

/** A minute of audio. A backlog this deep means the environment cannot keep up. */
const MAX_BACKLOG_BYTES = 1_920_000;

/**
 * Streams microphone PCM to an environment one request at a time. Audio that
 * arrives while a feed is in flight joins the next one, so a slow link sends
 * fewer, larger requests instead of building a queue.
 */
export class StreamingDictation {
  readonly #transport: StreamingDictationTransport;
  readonly #callbacks: StreamingDictationCallbacks;
  #pending: Array<Uint8Array> = [];
  #pendingBytes = 0;
  #pump: Promise<void>;
  #pumping = false;
  #accepting = true;
  #ended = false;
  #failure: { readonly error: unknown } | null = null;

  constructor(transport: StreamingDictationTransport, callbacks: StreamingDictationCallbacks) {
    this.#transport = transport;
    this.#callbacks = callbacks;
    this.#pump = transport.start().catch((error: unknown) => this.#fail(error));
  }

  push(chunk: Uint8Array): void {
    if (!this.#accepting || this.#failure !== null) return;
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.byteLength;
    if (this.#pendingBytes > MAX_BACKLOG_BYTES) {
      this.#fail(new Error("Dictation fell too far behind the microphone. Try again."));
      return;
    }
    if (!this.#pumping && this.#pendingBytes >= STREAMING_DICTATION_MIN_FEED_BYTES) {
      this.#pumping = true;
      this.#pump = this.#pump.then(async () => {
        while (
          !this.#ended &&
          this.#failure === null &&
          this.#pendingBytes >= STREAMING_DICTATION_MIN_FEED_BYTES
        ) {
          await this.#feedPending();
        }
        this.#pumping = false;
      });
    }
  }

  /** Sends the remaining audio and resolves with the final transcript. */
  async finish(): Promise<string> {
    this.#throwIfFailed();
    if (!this.#accepting) throw new Error("This dictation session has already ended.");
    this.#accepting = false;
    await this.#pump;
    // a cancel can land during any of these waits: it wins, and nothing more is sent
    while (this.#pendingBytes >= 2 && this.#failure === null && !this.#ended) {
      await this.#feedPending();
    }
    this.#throwIfFailed();
    if (this.#ended) throw new Error("This dictation session was cancelled.");
    this.#ended = true;
    return this.#transport.finish();
  }

  /** Drops unsent audio and releases the environment's session once `start` has settled. */
  cancel(): void {
    if (this.#ended) return;
    this.#accepting = false;
    this.#ended = true;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#release();
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure.error;
  }

  #release(): void {
    void this.#pump.then(() => this.#transport.cancel()).catch(() => undefined);
  }

  /** Sends up to one feed's worth of the oldest pending audio. */
  async #feedPending(): Promise<void> {
    const audio = this.#takePending(Math.min(this.#pendingBytes, DICTATION_MAX_FEED_BYTES));
    try {
      const text = await this.#transport.feed(audio);
      if (!this.#ended && this.#failure === null) this.#callbacks.onTranscript(text);
    } catch (error) {
      this.#fail(error);
    }
  }

  #takePending(byteLength: number): Uint8Array {
    // Whole 16-bit samples only; chunks from the recorder are always even-sized.
    const size = byteLength - (byteLength % 2);
    const audio = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.#pending[0];
      if (chunk === undefined) break;
      const take = Math.min(chunk.byteLength, size - offset);
      audio.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.byteLength) this.#pending.shift();
      else this.#pending[0] = chunk.subarray(take);
    }
    this.#pendingBytes -= size;
    return audio;
  }

  /** Ends the session on the client's side too: the environment's is released, not left busy. */
  #fail(error: unknown): void {
    if (this.#failure !== null || this.#ended) return;
    this.#failure = { error };
    this.#accepting = false;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#release();
    this.#callbacks.onError(error);
  }
}
