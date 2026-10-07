// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DictationModel, DictationStatus } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as Dictation from "./Dictation.ts";
import * as SpeechEngine from "./SpeechEngine.ts";

const modelBytes = new TextEncoder().encode("fake gguf weights");
/** Same length as the model, other bytes: only the checksum tells them apart. */
const damaged = new TextEncoder().encode("fake gguf w3ights");
const testModel = (id: string, repository: string): DictationModel => ({
  id,
  name: `Model ${id}`,
  description: "",
  repository,
  revision: "abc123",
  filename: "model.gguf",
  size: modelBytes.byteLength,
  sha256: NodeCrypto.createHash("sha256").update(modelBytes).digest("hex"),
  languages: ["en", "de"],
  streaming: true,
  languageDetection: false,
  recommended: true,
});
const model = testModel("test-model", "test-org/test-model");
const otherModel = testModel("other-model", "test-org/other-model");

/** A promise the test opens by hand; the fake engine's native calls wait on these. */
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

interface EngineGates {
  /** Holds model loading open. Like the native call, it finishes even if its caller is interrupted. */
  readonly load?: Promise<void>;
  /** Each feed waits for the promise this returns. */
  readonly feed?: () => Promise<void>;
  readonly loadEntered?: () => void;
  readonly feedEntered?: () => void;
}

/**
 * Transcribes each feed as the number of samples it carried, so assertions can see the audio
 * arrive; a whole recording as its length and language.
 */
const fakeEngine = (
  options: { readonly available?: boolean; readonly gates?: EngineGates } = {},
) => {
  const counts = { loads: 0, openStreams: 0, closedStreams: 0, disposedModels: 0 };
  const gates = options.gates ?? {};
  const engine = SpeechEngine.SpeechEngine.of({
    available: Effect.succeed(options.available ?? true),
    load: () =>
      Effect.promise(async () => {
        gates.loadEntered?.();
        await gates.load;
        counts.loads += 1;
        return {
          streaming: true,
          openStream: () =>
            Effect.sync(() => {
              counts.openStreams += 1;
              const words: Array<string> = [];
              return {
                feed: (pcm: Float32Array) =>
                  Effect.promise(async () => {
                    gates.feedEntered?.();
                    await gates.feed?.();
                    words.push(`${pcm.length}`);
                    return words.join(" ");
                  }),
                finish: Effect.sync(() => `${words.join(" ")}.`),
                close: Effect.sync(() => {
                  counts.closedStreams += 1;
                }),
              };
            }),
          transcribe: (pcm: Float32Array, language: string | null) =>
            Effect.succeed(`${pcm.length} samples in ${language ?? "any language"}`),
          dispose: Effect.sync(() => {
            counts.disposedModels += 1;
          }),
        } satisfies SpeechEngine.SpeechModel;
      }),
  });
  return { engine, counts };
};

/** What the fake Hugging Face answers: the whole file, unless a test says otherwise. */
type Respond = (input: { readonly range: string | undefined; readonly attempt: number }) => {
  readonly status: number;
  readonly body: Stream.Stream<Uint8Array, unknown>;
};

const makeHarness = Effect.fn("test.makeDictation")(function* (
  input: {
    readonly available?: boolean;
    /** A copy already in the cache: the model, or one damaged without changing its length. */
    readonly cached?: "intact" | "damaged";
    readonly cachedOther?: boolean;
    readonly corruptBlob?: boolean;
    /** The first bytes of an earlier download, left in the partial file. */
    readonly partial?: Uint8Array;
    readonly respond?: Respond;
    readonly gates?: EngineGates;
    /** Wraps the filesystem the service sees (the harness's own setup uses the real one). */
    readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const hubCache = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dictation-test-" });
  const filesOf = (repository: string) => {
    const directory = `${hubCache}/models--${repository.replaceAll("/", "--")}`;
    return {
      directory,
      modelPath: `${directory}/snapshots/${model.revision}/${model.filename}`,
      blobPath: `${directory}/blobs/${model.sha256}`,
    };
  };
  const { modelPath, blobPath } = filesOf(model.repository);
  const partialPath = `${blobPath}.t3-test.incomplete`;
  const cache = Effect.fn(function* (repository: string, bytes: Uint8Array) {
    const files = filesOf(repository);
    yield* fs.makeDirectory(`${files.directory}/snapshots/${model.revision}`, { recursive: true });
    yield* fs.writeFile(files.modelPath, bytes);
  });
  if (input.cached)
    yield* cache(model.repository, input.cached === "intact" ? modelBytes : damaged);
  if (input.cachedOther) yield* cache(otherModel.repository, modelBytes);
  if (input.corruptBlob || input.partial) {
    yield* fs.makeDirectory(`${filesOf(model.repository).directory}/blobs`, { recursive: true });
  }
  if (input.corruptBlob) yield* fs.writeFile(blobPath, damaged);
  if (input.partial) yield* fs.writeFile(partialPath, input.partial);
  const { engine, counts } = fakeEngine({
    available: input.available ?? true,
    ...(input.gates ? { gates: input.gates } : {}),
  });
  const ranges: Array<string | undefined> = [];
  const respond: Respond =
    input.respond ?? (() => ({ status: 200, body: Stream.succeed(modelBytes) }));
  const dictation = yield* Dictation.makeDictation([model, otherModel], "test").pipe(
    Effect.provideService(SpeechEngine.SpeechEngine, engine),
    Effect.provideService(FileSystem.FileSystem, input.fileSystem ? input.fileSystem(fs) : fs),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const range = request.headers["range"];
          ranges.push(range);
          const answer = respond({ range, attempt: ranges.length });
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null, { status: answer.status })),
            "stream",
            { value: answer.body },
          );
        }),
      ),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HF_HUB_CACHE: hubCache } })),
    ),
  );
  return { dictation, fs, modelPath, blobPath, partialPath, counts, ranges };
});

const settledStatus = (dictation: Dictation.Dictation["Service"]) =>
  dictation.status.pipe(
    Stream.filter(
      (status) => !Object.values(status.models).some((state) => state.phase === "downloading"),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
const stateOf = (status: DictationStatus) => status.models[model.id];

const startInput = (sessionId: string, overrides: { language?: string; live?: boolean } = {}) => ({
  sessionId,
  modelId: model.id,
  language: overrides.language ?? null,
  live: overrides.live ?? true,
});

const pcm16 = (samples: number) => new Uint8Array(samples * 2);

it.layer(NodeServices.layer)("Dictation", (it) => {
  it.effect("downloads a model into the Hugging Face cache layout", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      expect(stateOf(yield* settledStatus(h.dictation))).toBeUndefined();

      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))).toEqual({
        phase: "ready",
        downloadedBytes: model.size,
        message: null,
      });
      expect(new Uint8Array(yield* h.fs.readFile(h.modelPath))).toEqual(modelBytes);
      expect(yield* h.fs.readLink(h.modelPath)).toBe(`../../blobs/${model.sha256}`);
      expect(h.ranges).toEqual([undefined]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps what a broken-off download received, to continue from", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        respond: () => ({
          status: 200,
          body: Stream.concat(
            Stream.succeed(modelBytes.subarray(0, 4)),
            Stream.fail(new Error("connection reset")),
          ),
        }),
      });
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))).toMatchObject({
        phase: "paused",
        downloadedBytes: 4,
      });
      expect(new Uint8Array(yield* h.fs.readFile(h.partialPath))).toEqual(
        modelBytes.subarray(0, 4),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("continues a download an earlier run left part way", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        partial: modelBytes.subarray(0, 6),
        respond: () => ({ status: 206, body: Stream.succeed(modelBytes.subarray(6)) }),
      });
      expect(stateOf(yield* settledStatus(h.dictation))).toEqual({
        phase: "paused",
        downloadedBytes: 6,
        message: null,
      });
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      expect(h.ranges).toEqual(["bytes=6-"]);
      expect(new Uint8Array(yield* h.fs.readFile(h.modelPath))).toEqual(modelBytes);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a download that fails its check, and keeps nothing", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        respond: () => ({ status: 200, body: Stream.succeed(damaged) }),
      });
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))).toEqual({
        phase: "paused",
        downloadedBytes: 0,
        message: "The downloaded dictation model failed its size or SHA-256 check.",
      });
      // bytes that fail the check are no base to continue from
      expect(yield* h.fs.exists(h.partialPath)).toBe(false);
      expect(yield* h.fs.exists(h.blobPath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("downloads into a partial file no other T3 server on this machine writes to", () =>
    Effect.gen(function* () {
      const sinks: Array<string> = [];
      const h = yield* makeHarness({
        respond: () => ({ status: 200, body: Stream.succeed(modelBytes) }),
        fileSystem: (real) => ({
          ...real,
          sink: (path, options) => {
            sinks.push(path);
            return real.sink(path, options);
          },
        }),
      });
      // another server's half-done download of the same model, under its own name
      const theirs = h.partialPath.replace(".t3-test.", ".t3-other.");
      yield* h.fs.makeDirectory(h.blobPath.slice(0, h.blobPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* h.fs.writeFile(theirs, damaged.subarray(0, 6));
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      expect(sinks).toEqual([h.partialPath]);
      expect(new Uint8Array(yield* h.fs.readFile(theirs))).toEqual(damaged.subarray(0, 6));
    }).pipe(Effect.scoped),
  );

  it.effect("starts over when the server sends the whole file instead of the rest", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ partial: modelBytes.subarray(0, 6) });
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      expect(new Uint8Array(yield* h.fs.readFile(h.modelPath))).toEqual(modelBytes);
    }).pipe(Effect.scoped),
  );

  it.effect("uses a copy another tool already put in the cache", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      yield* h.dictation.installModel(model.id);
      expect(h.ranges).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("streams a session's transcript and ends it on finish", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      yield* h.dictation.start(startInput("session-1"));
      expect(yield* h.dictation.feed({ sessionId: "session-1", audio: pcm16(4) })).toEqual({
        text: "4",
      });
      expect(yield* h.dictation.feed({ sessionId: "session-1", audio: pcm16(2) })).toEqual({
        text: "4 2",
      });
      expect(yield* h.dictation.finish("session-1")).toEqual({ text: "4 2." });
      expect(h.counts.closedStreams).toBe(1);

      const afterFinish = yield* Effect.exit(
        h.dictation.feed({ sessionId: "session-1", audio: pcm16(1) }),
      );
      expect(afterFinish).toEqual(
        Exit.fail(expect.objectContaining({ reason: "session-not-found" })),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("without live preview, transcribes the whole recording on finish", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      yield* h.dictation.start(startInput("session-1", { live: false, language: "de" }));
      expect(yield* h.dictation.feed({ sessionId: "session-1", audio: pcm16(4) })).toEqual({
        text: "",
      });
      yield* h.dictation.feed({ sessionId: "session-1", audio: pcm16(2) });
      expect(yield* h.dictation.finish("session-1")).toEqual({ text: "6 samples in de" });
      expect(h.counts.openStreams).toBe(0);

      // a language the model doesn't know is left to the model
      yield* h.dictation.start(startInput("session-2", { live: false, language: "xx" }));
      yield* h.dictation.feed({ sessionId: "session-2", audio: pcm16(1) });
      expect(yield* h.dictation.finish("session-2")).toEqual({
        text: "1 samples in any language",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("switching models releases the one loaded before", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact", cachedOther: true });
      yield* h.dictation.start(startInput("session-1"));
      yield* h.dictation.finish("session-1");
      yield* h.dictation.start({ ...startInput("session-2"), modelId: otherModel.id });
      expect(h.counts.loads).toBe(2);
      expect(h.counts.disposedModels).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects audio that is not whole 16-bit samples", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      yield* h.dictation.start(startInput("session-1"));
      const exit = yield* Effect.exit(
        h.dictation.feed({ sessionId: "session-1", audio: new Uint8Array(3) }),
      );
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "invalid-audio" })));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to start before the model is downloaded, or with one it doesn't know", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const exit = yield* Effect.exit(h.dictation.start(startInput("session-1")));
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "model-missing" })));
      const unknown = yield* Effect.exit(
        h.dictation.start({ ...startInput("session-1"), modelId: "no-such-model" }),
      );
      expect(unknown).toEqual(Exit.fail(expect.objectContaining({ reason: "unknown-model" })));
      expect(h.counts.loads).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("reclaims a session whose client stopped feeding, then the idle model", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      yield* h.dictation.start(startInput("session-1"));
      yield* TestClock.adjust("11 seconds");
      expect(h.counts.closedStreams).toBe(1);
      const exit = yield* Effect.exit(h.dictation.finish("session-1"));
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "session-not-found" })));

      yield* TestClock.adjust("5 minutes");
      expect(h.counts.disposedModels).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("removing a model ends its session and frees the cache files", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.dictation.installModel(model.id);
      yield* settledStatus(h.dictation);
      yield* h.dictation.start(startInput("session-1"));

      yield* h.dictation.removeModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))).toBeUndefined();
      expect(h.counts.closedStreams).toBe(1);
      expect(h.counts.disposedModels).toBe(1);
      expect(yield* h.fs.exists(h.modelPath)).toBe(false);
      expect(yield* h.fs.exists(h.blobPath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("reports platforms without a native runtime as unsupported", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ available: false, cached: "intact" });
      expect((yield* settledStatus(h.dictation)).supported).toBe(false);
      const exit = yield* Effect.exit(h.dictation.installModel(model.id));
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "unsupported" })));
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a corrupt cached blob instead of linking it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ corruptBlob: true });
      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      expect(new Uint8Array(yield* h.fs.readFile(h.modelPath))).toEqual(modelBytes);
      expect(h.ranges).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a second client the model is busy while one is dictating", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "intact" });
      yield* h.dictation.start(startInput("first"));
      const second = yield* Effect.exit(h.dictation.start(startInput("second")));
      expect(second).toEqual(Exit.fail(expect.objectContaining({ reason: "busy" })));

      yield* h.dictation.cancel("first");
      yield* h.dictation.start(startInput("second"));
      expect(h.counts.openStreams).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a session through a feed slower than the idle timeout", () =>
    Effect.gen(function* () {
      const feedGate = gate();
      const feedEntered = gate();
      const h = yield* makeHarness({
        cached: "intact",
        gates: {
          feed: () => feedGate.promise,
          feedEntered: feedEntered.open,
        },
      });
      yield* h.dictation.start(startInput("session-1"));
      const slowFeed = yield* Effect.forkChild(
        h.dictation.feed({ sessionId: "session-1", audio: pcm16(4) }),
      );
      yield* Effect.promise(() => feedEntered.promise);
      yield* TestClock.adjust("31 seconds");
      feedGate.open();
      expect(yield* Fiber.join(slowFeed)).toEqual({ text: "4" });

      expect(yield* h.dictation.feed({ sessionId: "session-1", audio: pcm16(2) })).toEqual({
        text: "4 2",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("releases a model whose start was interrupted mid-load", () =>
    Effect.gen(function* () {
      const loadGate = gate();
      const loadEntered = gate();
      const h = yield* makeHarness({
        cached: "intact",
        gates: {
          load: loadGate.promise,
          loadEntered: loadEntered.open,
        },
      });
      const starting = yield* Effect.forkChild(h.dictation.start(startInput("session-1")));
      yield* Effect.promise(() => loadEntered.promise);
      // Signal the disconnect synchronously, before loading can finish on its own.
      starting.interruptUnsafe();
      loadGate.open();
      yield* Fiber.await(starting);

      yield* TestClock.adjust("31 seconds");
      yield* TestClock.adjust("5 minutes");
      expect(h.counts.loads).toBe(1);
      expect(h.counts.disposedModels).toBe(1);
      expect(h.counts.closedStreams).toBe(h.counts.openStreams);
    }).pipe(Effect.scoped),
  );

  it.effect("cancelling while the model loads ends the session once it starts", () =>
    Effect.gen(function* () {
      const loadGate = gate();
      const loadEntered = gate();
      const h = yield* makeHarness({
        cached: "intact",
        gates: {
          load: loadGate.promise,
          loadEntered: loadEntered.open,
        },
      });
      const starting = yield* Effect.forkChild(h.dictation.start(startInput("session-1")));
      yield* Effect.promise(() => loadEntered.promise);
      const cancelling = yield* Effect.forkChild(h.dictation.cancel("session-1"));
      loadGate.open();
      yield* Fiber.join(starting);
      yield* Fiber.join(cancelling);

      expect(h.counts.closedStreams).toBe(1);
      yield* h.dictation.start(startInput("session-2"));
    }).pipe(Effect.scoped),
  );

  it.effect("checks a cached copy before loading it, and downloads a damaged one again", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: "damaged" });
      const exit = yield* Effect.exit(h.dictation.start(startInput("session-1")));
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "model-missing" })));
      expect(h.counts.loads).toBe(0);
      expect(stateOf(yield* settledStatus(h.dictation))).toMatchObject({
        phase: "paused",
        message: "The model on disk failed its check. Download it again.",
      });

      yield* h.dictation.installModel(model.id);
      expect(stateOf(yield* settledStatus(h.dictation))?.phase).toBe("ready");
      expect(new Uint8Array(yield* h.fs.readFile(h.modelPath))).toEqual(modelBytes);
      yield* h.dictation.start(startInput("session-1"));
    }).pipe(Effect.scoped),
  );

  it.effect("reports a removal the filesystem refused, and keeps the model usable", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        cached: "intact",
        fileSystem: (real) => ({
          ...real,
          remove: () => Effect.die(new Error("EACCES")),
        }),
      });
      const exit = yield* Effect.exit(h.dictation.removeModel(model.id));
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ reason: "remove-failed" })));
      expect(stateOf(yield* settledStatus(h.dictation))).toMatchObject({
        phase: "ready",
        message: "Could not delete the dictation model files.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("settles a cancelled download even if the client leaves mid-cancel", () =>
    Effect.gen(function* () {
      const downloading = gate();
      const cleanupEntered = gate();
      const cleanupGate = gate();
      const h = yield* makeHarness({
        respond: () => ({
          status: 200,
          body: Stream.concat(Stream.succeed(modelBytes.subarray(0, 4)), Stream.never),
        }),
        fileSystem: (real) => ({
          ...real,
          sink: (path, options) => {
            if (path.endsWith(".incomplete")) downloading.open();
            return real.sink(path, options);
          },
          // the download's partial file is removed as it's cancelled: hold that open
          remove: (path, options) =>
            path.endsWith(".incomplete")
              ? Effect.promise(async () => {
                  cleanupEntered.open();
                  await cleanupGate.promise;
                }).pipe(Effect.andThen(real.remove(path, options)))
              : real.remove(path, options),
        }),
      });
      yield* h.dictation.installModel(model.id);
      yield* Effect.promise(() => downloading.promise);
      const removing = yield* Effect.forkChild(Effect.exit(h.dictation.removeModel(model.id)));
      yield* Effect.promise(() => cleanupEntered.promise);
      removing.interruptUnsafe();
      cleanupGate.open();
      yield* Fiber.await(removing);

      const now = yield* h.dictation.status.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(stateOf(now)).toBeUndefined();
      expect(yield* h.fs.exists(h.partialPath)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
