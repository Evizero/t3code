// @effect-diagnostics nodeBuiltinImport:off
// (node:crypto hashes a model file as it streams from disk, where Effect's Crypto digests whole
// buffers; node:os finds the home directory for the Hugging Face cache, as pathExpansion.ts does)
/**
 * Dictation - speech-to-text on the environment that runs on the user's own machine.
 *
 * Clients capture the microphone and feed 16 kHz PCM; this service owns the catalog models' files,
 * the loaded model, and the one session dictating. Models live in the standard Hugging Face cache,
 * so a copy another local tool downloaded is used as is, and a download stopped part way, by a
 * failure or a restart, continues where it stopped.
 *
 * @module Dictation
 */
import {
  DICTATION_MAX_FEED_BYTES,
  DICTATION_MODELS,
  DictationError,
  type DictationFeedInput,
  type DictationModel,
  type DictationModelState,
  type DictationStartInput,
  type DictationStatus,
  type DictationTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as SpeechEngine from "./SpeechEngine.ts";

/**
 * Clients feed every 128 ms while recording, so a session this quiet lost its
 * client. It is measured from the end of the last feed, never during one.
 */
const SESSION_IDLE_MS = 10_000;
/** A loaded model holds most of a gigabyte, so it is released between bursts of use. */
const MODEL_IDLE_MS = 5 * 60_000;
/** Ten minutes: what a recording transcribed on finish may hold in memory. */
const MAX_RECORDING_SAMPLES = 16_000 * 600;

class DictationModelDownloadError extends Schema.TaggedError<DictationModelDownloadError>()(
  "DictationModelDownloadError",
  {
    stage: Schema.Literals(["request", "write", "verify"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "request":
        return "Could not download the dictation model.";
      case "write":
        return "Could not save the dictation model.";
      case "verify":
        return "The downloaded dictation model failed its size or SHA-256 check.";
    }
  }
}

export class Dictation extends Context.Service<
  Dictation,
  {
    readonly status: Stream.Stream<DictationStatus>;
    readonly installModel: (modelId: string) => Effect.Effect<void, DictationError>;
    readonly removeModel: (modelId: string) => Effect.Effect<void, DictationError>;
    readonly start: (input: DictationStartInput) => Effect.Effect<void, DictationError>;
    readonly feed: (
      input: DictationFeedInput,
    ) => Effect.Effect<DictationTranscript, DictationError>;
    readonly finish: (sessionId: string) => Effect.Effect<DictationTranscript, DictationError>;
    readonly cancel: (sessionId: string) => Effect.Effect<void>;
  }
>()("t3/dictation/Dictation") {}

const HuggingFaceConfig = Config.all({
  hubCache: Config.String("HF_HUB_CACHE").pipe(Config.option),
  home: Config.String("HF_HOME").pipe(Config.option),
  xdgCache: Config.String("XDG_CACHE_HOME").pipe(Config.option),
  token: Config.Redacted("HF_TOKEN").pipe(Config.option),
});

/** Little-endian 16-bit PCM to the [-1, 1) floats the engine takes. */
function decodePcm16(audio: Uint8Array): Float32Array {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const pcm = new Float32Array(audio.byteLength / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return pcm;
}

function concatPcm(chunks: ReadonlyArray<Float32Array>, samples: number): Float32Array {
  const pcm = new Float32Array(samples);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return pcm;
}

/** Streams transcribe as audio arrives; a recording is kept and transcribed on finish. */
type SessionMode =
  | { readonly _tag: "stream"; readonly stream: SpeechEngine.SpeechStream }
  | {
      readonly _tag: "recording";
      readonly language: string | null;
      readonly chunks: Array<Float32Array>;
      samples: number;
    };

interface ActiveSession {
  readonly id: string;
  readonly modelId: string;
  readonly mode: SessionMode;
  lastActivityAt: number;
}

/**
 * `owner` names this server's partial downloads in the shared cache. Each T3 server on a machine
 * downloads into its own file, so the bytes it checks and publishes are only ever its own, and
 * the same server continues it after a restart.
 */
export const makeDictation = Effect.fn("makeDictation")(function* (
  catalog: ReadonlyArray<DictationModel>,
  owner: string,
) {
  const engine = yield* SpeechEngine.SpeechEngine;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* HuggingFaceConfig.pipe(
    Effect.orElseSucceed(() => ({
      hubCache: Option.none<string>(),
      home: Option.none<string>(),
      xdgCache: Option.none<string>(),
      token: Option.none<Redacted.Redacted<string>>(),
    })),
  );

  // Mirrors huggingface_hub's cache resolution and layout.
  const hubCache = Option.getOrElse(config.hubCache, () =>
    path.join(
      Option.getOrElse(config.home, () =>
        path.join(
          Option.getOrElse(config.xdgCache, () => path.join(NodeOS.homedir(), ".cache")),
          "huggingface",
        ),
      ),
      "hub",
    ),
  );
  const filesOf = (model: DictationModel) => {
    const repositoryDirectory = path.join(
      hubCache,
      `models--${model.repository.replaceAll("/", "--")}`,
    );
    const blobPath = path.join(repositoryDirectory, "blobs", model.sha256);
    return {
      blobPath,
      modelPath: path.join(repositoryDirectory, "snapshots", model.revision, model.filename),
      // One name per model and server, so a download stopped by a restart continues, and no
      // other tool or T3 server ever writes into it.
      partialPath: `${blobPath}.t3-${owner}.incomplete`,
      url: `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`,
    };
  };

  const status = yield* SubscriptionRef.make<DictationStatus>({ supported: true, models: {} });
  const setModel = (modelId: string, state: DictationModelState | null) =>
    SubscriptionRef.update(status, (current) => {
      const { [modelId]: _previous, ...models } = current.models;
      return { ...current, models: state === null ? models : { ...models, [modelId]: state } };
    });
  const lifecycle = yield* Semaphore.make(1);
  const downloads = yield* FiberMap.make<string, void, never>();
  const janitorFiber = yield* FiberHandle.make<void, never>();
  // transcribe.cpp allows one active stream per model, so there is at most one session.
  const sessionLock = yield* Semaphore.make(1);
  let active: ActiveSession | null = null;
  let loaded: { readonly modelId: string; readonly model: SpeechEngine.SpeechModel } | null = null;
  let idleSince = 0;
  /** Models whose bytes were hashed since this server started; the others are before they load. */
  const checked = new Set<string>();

  /**
   * Every change to `active` and `loaded` runs here: one at a time, and never
   * cut short by a client disconnecting, so native handles always reach an
   * owner. Never interrupt a fiber that may be waiting here while holding the
   * lock.
   */
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptible(sessionLock.withPermit(effect));

  const catalogModel = (modelId: string) => {
    const model = catalog.find((candidate) => candidate.id === modelId);
    return model === undefined
      ? Effect.fail(new DictationError({ reason: "unknown-model" }))
      : Effect.succeed(model);
  };

  const fileSize = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.option,
    );

  const writeFailed = (cause: unknown) =>
    new DictationModelDownloadError({ stage: "write", cause });

  /** The bytes at `file` are the model's: its size, then its SHA-256. */
  const verified = (file: string, model: DictationModel) =>
    Effect.gen(function* () {
      if (Option.getOrNull(yield* fileSize(file)) !== model.size) return false;
      const hash = NodeCrypto.createHash("sha256");
      yield* fileSystem
        .stream(file)
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
      return hash.digest("hex") === model.sha256;
    }).pipe(Effect.orElseSucceed(() => false));

  // Status is settled on first use, so an environment that never dictates never loads the binding.
  // A cached copy of the right size counts as ready here; its hash is checked before it loads.
  const probe = yield* Effect.cached(
    Effect.gen(function* () {
      if (!(yield* engine.available)) {
        yield* SubscriptionRef.update(status, (current) => ({ ...current, supported: false }));
        return;
      }
      const models: Record<string, DictationModelState> = {};
      yield* Effect.forEach(
        catalog,
        (model) =>
          Effect.gen(function* () {
            const files = filesOf(model);
            if (Option.getOrNull(yield* fileSize(files.modelPath)) === model.size) {
              models[model.id] = { phase: "ready", downloadedBytes: model.size, message: null };
              return;
            }
            const partial = yield* fileSize(files.partialPath);
            if (Option.isSome(partial)) {
              models[model.id] = { phase: "paused", downloadedBytes: partial.value, message: null };
            }
          }),
        { concurrency: 8, discard: true },
      );
      yield* SubscriptionRef.update(status, (current) => ({ ...current, models }));
    }),
  );

  /**
   * Downloads into this server's partial file, continuing what is there, then moves it into the
   * cache once the whole file on disk checks out.
   */
  const fetchBlob = (model: DictationModel) =>
    Effect.gen(function* () {
      const files = filesOf(model);
      let offset = Option.getOrElse(yield* fileSize(files.partialPath), () => 0);
      if (offset >= model.size) offset = 0;

      const response = yield* http
        .execute(
          HttpClientRequest.get(files.url).pipe(
            Option.isSome(config.token)
              ? HttpClientRequest.bearerToken(Redacted.value(config.token.value))
              : (request) => request,
            offset > 0 ? HttpClientRequest.setHeader("range", `bytes=${offset}-`) : (r) => r,
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError((cause) => new DictationModelDownloadError({ stage: "request", cause })),
        );
      // A server that ignores the range sends the whole file again.
      if (response.status !== 206) offset = 0;

      let downloadedBytes = offset;
      let lastProgressAt = 0;
      yield* setModel(model.id, { phase: "downloading", downloadedBytes, message: null });
      yield* response.stream.pipe(
        Stream.mapError((cause) => new DictationModelDownloadError({ stage: "request", cause })),
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > model.size) {
              return yield* new DictationModelDownloadError({ stage: "verify" });
            }
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250) {
              lastProgressAt = now;
              yield* setModel(model.id, { phase: "downloading", downloadedBytes, message: null });
            }
          }),
        ),
        Stream.run(
          Sink.mapError(
            fileSystem.sink(files.partialPath, { flag: offset > 0 ? "a" : "w" }),
            writeFailed,
          ),
        ),
      );
      if (!(yield* verified(files.partialPath, model))) {
        // Bytes that fail the check are no base to continue from.
        yield* fileSystem.remove(files.partialPath, { force: true }).pipe(Effect.ignore);
        return yield* new DictationModelDownloadError({ stage: "verify" });
      }
      yield* fileSystem
        .rename(files.partialPath, files.blobPath)
        .pipe(Effect.mapError(writeFailed));
    });

  const download = (model: DictationModel) =>
    Effect.gen(function* () {
      const files = filesOf(model);
      yield* fileSystem
        .makeDirectory(path.dirname(files.blobPath), { recursive: true })
        .pipe(Effect.mapError(writeFailed));
      yield* fileSystem
        .makeDirectory(path.dirname(files.modelPath), { recursive: true })
        .pipe(Effect.mapError(writeFailed));
      // A blob left by another tool or an older run is used only if it verifies.
      if (!(yield* verified(files.blobPath, model))) {
        yield* fileSystem
          .remove(files.blobPath, { force: true })
          .pipe(Effect.mapError(writeFailed));
        yield* fetchBlob(model);
      }
      yield* fileSystem.remove(files.modelPath, { force: true }).pipe(Effect.mapError(writeFailed));
      yield* fileSystem
        .symlink(path.relative(path.dirname(files.modelPath), files.blobPath), files.modelPath)
        .pipe(
          // Hugging Face falls back to a copy where symlinks are unavailable (Windows without
          // developer mode).
          Effect.catch(() => fileSystem.copyFile(files.blobPath, files.modelPath)),
          Effect.mapError(writeFailed),
        );
      checked.add(model.id);
    });

  const supported = SubscriptionRef.get(status).pipe(
    Effect.flatMap((current) =>
      current.supported ? Effect.void : Effect.fail(new DictationError({ reason: "unsupported" })),
    ),
  );

  const installModel: Dictation["Service"]["installModel"] = (modelId) =>
    lifecycle.withPermit(
      Effect.gen(function* () {
        yield* probe;
        yield* supported;
        const model = yield* catalogModel(modelId);
        const current = (yield* SubscriptionRef.get(status)).models[modelId];
        if (current?.phase === "ready" || current?.phase === "downloading") return;
        yield* setModel(modelId, {
          phase: "downloading",
          downloadedBytes: current?.downloadedBytes ?? 0,
          message: null,
        });
        // Owned by the service, so it outlives the request and the client that made it. A failure
        // keeps what arrived, to continue from; stopping the server keeps it too.
        yield* FiberMap.run(
          downloads,
          modelId,
          download(model).pipe(
            Effect.andThen(
              setModel(modelId, { phase: "ready", downloadedBytes: model.size, message: null }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.gen(function* () {
                    yield* Effect.logWarning("dictation model download failed", cause);
                    const kept = yield* fileSize(filesOf(model).partialPath);
                    yield* setModel(modelId, {
                      phase: "paused",
                      downloadedBytes: Option.getOrElse(kept, () => 0),
                      message: Option.match(Cause.findErrorOption(cause), {
                        onNone: () => "Could not download the dictation model.",
                        onSome: (error) => error.message,
                      }),
                    });
                  }),
            ),
          ),
          { onlyIfMissing: true },
        );
      }),
    );

  // The helpers below run inside `exclusive`.
  const closeActive = Effect.gen(function* () {
    if (active === null) return;
    const closing = active;
    active = null;
    idleSince = yield* Clock.currentTimeMillis;
    if (closing.mode._tag === "stream") yield* closing.mode.stream.close;
  });

  const unloadModel = Effect.gen(function* () {
    if (loaded === null || active !== null) return;
    const unloading = loaded;
    loaded = null;
    yield* unloading.model.dispose;
  });

  /** Reclaims an abandoned session, then the idle model. Returns ms until the next check. */
  const tidy = exclusive(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (active !== null) {
        const quietFor = now - active.lastActivityAt;
        if (quietFor < SESSION_IDLE_MS) return SESSION_IDLE_MS - quietFor;
        yield* closeActive;
      }
      if (loaded === null) return null;
      const unusedFor = now - idleSince;
      if (unusedFor < MODEL_IDLE_MS) return MODEL_IDLE_MS - unusedFor;
      yield* unloadModel;
      return null;
    }),
  );

  const janitor = Effect.gen(function* () {
    let wait = yield* tidy;
    while (wait !== null) {
      yield* Effect.sleep(wait);
      wait = yield* tidy;
    }
  });

  const activeSession = (sessionId: string) =>
    active?.id === sessionId
      ? Effect.succeed(active)
      : Effect.fail(new DictationError({ reason: "session-not-found" }));

  const transcriptionFailed = (cause: unknown) =>
    new DictationError({ reason: "transcription-failed", cause });

  const start: Dictation["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      yield* probe;
      const model = yield* catalogModel(input.modelId);
      // A language the model doesn't know falls back to its default.
      const language =
        input.language !== null && model.languages.includes(input.language) ? input.language : null;
      yield* exclusive(
        Effect.gen(function* () {
          if (active !== null) {
            if (active.id === input.sessionId) return;
            return yield* new DictationError({ reason: "busy" });
          }
          yield* supported;
          if ((yield* SubscriptionRef.get(status)).models[model.id]?.phase !== "ready") {
            return yield* new DictationError({ reason: "model-missing" });
          }
          const { modelPath } = filesOf(model);
          if (!checked.has(model.id)) {
            if (!(yield* verified(modelPath, model))) {
              yield* setModel(model.id, {
                phase: "paused",
                downloadedBytes: 0,
                message: "The model on disk failed its check. Download it again.",
              });
              return yield* new DictationError({ reason: "model-missing" });
            }
            checked.add(model.id);
          }
          if (loaded !== null && loaded.modelId !== model.id) yield* unloadModel;
          loaded ??= {
            modelId: model.id,
            model: yield* engine.load(modelPath).pipe(Effect.mapError(transcriptionFailed)),
          };
          const mode: SessionMode =
            input.live && loaded.model.streaming
              ? {
                  _tag: "stream",
                  stream: yield* loaded.model
                    .openStream(language)
                    .pipe(Effect.mapError(transcriptionFailed)),
                }
              : { _tag: "recording", language, chunks: [], samples: 0 };
          active = {
            id: input.sessionId,
            modelId: model.id,
            mode,
            lastActivityAt: yield* Clock.currentTimeMillis,
          };
        }),
      ).pipe(
        // Runs even when the client disconnected mid-start, so a registered session is always
        // watched. Outside the lock: interrupting a janitor waiting on it would deadlock.
        Effect.ensuring(FiberHandle.run(janitorFiber, janitor)),
      );
    });

  const feed: Dictation["Service"]["feed"] = ({ sessionId, audio }) =>
    Effect.gen(function* () {
      if (audio.byteLength % 2 !== 0 || audio.byteLength > DICTATION_MAX_FEED_BYTES) {
        return yield* new DictationError({ reason: "invalid-audio" });
      }
      const pcm = decodePcm16(audio);
      return yield* exclusive(
        Effect.gen(function* () {
          const session = yield* activeSession(sessionId);
          const { mode } = session;
          let text = "";
          if (mode._tag === "stream") {
            text = yield* mode.stream.feed(pcm).pipe(
              Effect.mapError(transcriptionFailed),
              Effect.tapError(() => closeActive),
            );
          } else {
            if (mode.samples + pcm.length > MAX_RECORDING_SAMPLES) {
              yield* closeActive;
              return yield* new DictationError({ reason: "too-long" });
            }
            mode.chunks.push(pcm);
            mode.samples += pcm.length;
          }
          session.lastActivityAt = yield* Clock.currentTimeMillis;
          return { text };
        }),
      );
    });

  const finish: Dictation["Service"]["finish"] = (sessionId) =>
    exclusive(
      Effect.gen(function* () {
        const session = yield* activeSession(sessionId);
        const { mode } = session;
        const transcribed =
          mode._tag === "stream"
            ? mode.stream.finish
            : Effect.suspend(() =>
                mode.samples === 0 || loaded === null
                  ? Effect.succeed("")
                  : loaded.model.transcribe(concatPcm(mode.chunks, mode.samples), mode.language),
              );
        const text = yield* transcribed.pipe(
          Effect.mapError(transcriptionFailed),
          Effect.ensuring(closeActive),
        );
        return { text };
      }),
    );

  const cancel: Dictation["Service"]["cancel"] = (sessionId) =>
    exclusive(Effect.suspend(() => (active?.id === sessionId ? closeActive : Effect.void)));

  // Uninterruptible: a disconnect between cancelling the download and settling the status would
  // leave it showing progress that never comes.
  const removeModel: Dictation["Service"]["removeModel"] = (modelId) =>
    lifecycle.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* probe;
          const model = yield* catalogModel(modelId);
          const files = filesOf(model);
          yield* FiberMap.remove(downloads, modelId);
          const removal = yield* exclusive(
            Effect.gen(function* () {
              if (active?.modelId === modelId) yield* closeActive;
              if (loaded?.modelId === modelId) yield* unloadModel;
              checked.delete(modelId);
              // The pointer is a symlink into blobs/; drop both so the space is actually freed.
              const removed = yield* Effect.exit(
                Effect.all([
                  fileSystem.remove(files.modelPath, { force: true }),
                  fileSystem.remove(files.blobPath, { force: true }),
                  fileSystem.remove(files.partialPath, { force: true }),
                ]),
              );
              const present = Option.getOrNull(yield* fileSize(files.modelPath)) === model.size;
              yield* setModel(
                modelId,
                present
                  ? {
                      phase: "ready",
                      downloadedBytes: model.size,
                      message: "Could not delete the dictation model files.",
                    }
                  : null,
              );
              return removed;
            }),
          );
          if (Exit.isFailure(removal)) {
            return yield* new DictationError({
              reason: "remove-failed",
              cause: Cause.squash(removal.cause),
            });
          }
        }),
      ),
    );

  yield* Effect.addFinalizer(() =>
    exclusive(
      closeActive.pipe(
        Effect.andThen(
          Effect.suspend(() => (loaded === null ? Effect.void : loaded.model.dispose)),
        ),
      ),
    ),
  );

  return Dictation.of({
    status: Stream.unwrap(probe.pipe(Effect.as(SubscriptionRef.changes(status)))),
    installModel,
    removeModel,
    start,
    feed,
    finish,
    cancel,
  });
});

export const layer = Layer.effect(
  Dictation,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const owner = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
    return yield* makeDictation(DICTATION_MODELS, owner);
  }),
);
