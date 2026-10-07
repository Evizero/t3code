import { DICTATION_MAX_FEED_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  STREAMING_DICTATION_MIN_FEED_BYTES,
  StreamingDictation,
  type StreamingDictationTransport,
} from "./streaming.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const MIN = STREAMING_DICTATION_MIN_FEED_BYTES;

const joined = (chunks: ReadonlyArray<Uint8Array>) =>
  Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)));

function createHarness(overrides: Partial<StreamingDictationTransport> = {}) {
  const calls: Array<string> = [];
  const feeds: Array<number> = [];
  const transcripts: Array<string> = [];
  const errors: Array<unknown> = [];
  const transport: StreamingDictationTransport = {
    start: async () => {
      calls.push("start");
    },
    feed: async (audio) => {
      calls.push("feed");
      feeds.push(audio.byteLength);
      return `${feeds.length} feeds`;
    },
    finish: async () => {
      calls.push("finish");
      return "final";
    },
    cancel: async () => {
      calls.push("cancel");
    },
    ...overrides,
  };
  const session = new StreamingDictation(transport, {
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error),
  });
  return { session, calls, feeds, transcripts, errors };
}

describe("StreamingDictation", () => {
  it("batches audio recorded during a slow feed into the next request", async () => {
    const firstFeedSent = deferred<void>();
    const firstFeed = deferred<string>();
    const feeds: Array<number> = [];
    const h = createHarness({
      feed: async (audio) => {
        feeds.push(audio.byteLength);
        if (feeds.length > 1) return "second";
        firstFeedSent.resolve();
        return firstFeed.promise;
      },
    });

    h.session.push(new Uint8Array(MIN));
    await firstFeedSent.promise;
    h.session.push(new Uint8Array(MIN));
    h.session.push(new Uint8Array(MIN));
    firstFeed.resolve("first");

    expect(await h.session.finish()).toBe("final");
    expect(feeds).toEqual([MIN, MIN * 2]);
    expect(h.transcripts).toEqual(["first", "second"]);
  });

  it("holds short audio until finish, then flushes it before finishing", async () => {
    const h = createHarness();
    h.session.push(new Uint8Array(MIN / 2));
    expect(await h.session.finish()).toBe("final");
    expect(h.calls).toEqual(["start", "feed", "finish"]);
    expect(h.feeds).toEqual([MIN / 2]);
  });

  it("stops feeding after a failure and reports it from finish", async () => {
    const failure = new Error("model unloaded");
    const h = createHarness({
      feed: async () => {
        throw failure;
      },
    });
    h.session.push(new Uint8Array(MIN));
    await expect(h.session.finish()).rejects.toBe(failure);
    expect(h.errors).toEqual([failure]);
  });

  it("cancels the environment session only after start settles", async () => {
    const started = deferred<void>();
    const cancelled = deferred<void>();
    let cancelledBeforeStart = false;
    let startSettled = false;
    const h = createHarness({
      start: () => started.promise.then(() => void (startSettled = true)),
      cancel: async () => {
        cancelledBeforeStart = !startSettled;
        cancelled.resolve();
      },
    });
    h.session.push(new Uint8Array(MIN));
    h.session.cancel();

    started.resolve();
    await cancelled.promise;
    expect(cancelledBeforeStart).toBe(false);
    expect(h.feeds).toEqual([]);
  });

  it("splits a backlog built during a slow start into feeds the environment accepts", async () => {
    const started = deferred<void>();
    const sent: Array<Uint8Array> = [];
    const h = createHarness({
      start: () => started.promise,
      feed: async (audio) => {
        sent.push(audio);
        return "";
      },
    });
    const pushed: Array<Uint8Array> = [];
    for (let index = 0; index < Math.ceil((DICTATION_MAX_FEED_BYTES * 1.5) / MIN); index += 1) {
      const chunk = new Uint8Array(MIN).fill(index % 251);
      pushed.push(chunk);
      h.session.push(chunk);
    }
    started.resolve();

    await h.session.finish();
    expect(Math.max(...sent.map((audio) => audio.byteLength))).toBeLessThanOrEqual(
      DICTATION_MAX_FEED_BYTES,
    );
    // every byte arrives once, in the order it was recorded
    expect(joined(sent)).toEqual(joined(pushed));
  });

  it("releases the environment's session when it fails, and ignores a late transcript", async () => {
    const feedSent = deferred<void>();
    const stuckFeed = deferred<string>();
    const cancelled = deferred<void>();
    const h = createHarness({
      feed: () => {
        feedSent.resolve();
        return stuckFeed.promise;
      },
      cancel: async () => cancelled.resolve(),
    });
    h.session.push(new Uint8Array(MIN));
    await feedSent.promise;
    // the microphone keeps going while the feed hangs, until the backlog gives out
    for (let index = 0; h.errors.length === 0 && index < 10_000; index += 1) {
      h.session.push(new Uint8Array(MIN));
    }
    expect(h.errors).toHaveLength(1);

    stuckFeed.resolve("late words");
    await cancelled.promise;
    expect(h.transcripts).toEqual([]);
  });

  it("sends nothing more once cancelled while finishing", async () => {
    const started = deferred<void>();
    const h = createHarness({
      start: () => started.promise.then(() => void h.calls.push("start")),
    });
    h.session.push(new Uint8Array(MIN / 2));
    const finishing = h.session.finish();
    h.session.cancel();
    started.resolve();

    await expect(finishing).rejects.toThrow();
    expect(h.calls).not.toContain("finish");
    expect(h.feeds).toEqual([]);
  });
});
