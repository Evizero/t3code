/**
 * SpeechEngine - the native speech-to-text runtime behind dictation.
 *
 * `layer` binds transcribe.cpp. The binding and its platform library load on
 * first use, so environments that never dictate pay nothing at startup.
 *
 * @module SpeechEngine
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const nativeLibraryName = (platform: NodeJS.Platform) =>
  platform === "darwin"
    ? "libtranscribe.dylib"
    : platform === "win32"
      ? "transcribe.dll"
      : "libtranscribe.so";

/** Where Electron unpacks a directory that resolves inside an `.asar` archive; others unchanged. */
export const unpackedArtifactDir = (dir: string) =>
  dir.replace(/([\\/][^\\/]+\.asar)(?=[\\/])/, "$1.unpacked");

export class SpeechEngineError extends Schema.TaggedError<SpeechEngineError>()(
  "SpeechEngineError",
  {
    operation: Schema.Literals(["bind", "load", "open", "feed", "finish", "transcribe"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Speech engine failed to ${this.operation}.`;
  }
}

/** One live transcription. Calls must not overlap. */
export interface SpeechStream {
  /** Returns the whole transcript so far. */
  readonly feed: (pcm: Float32Array) => Effect.Effect<string, SpeechEngineError>;
  /** Flushes buffered audio and returns the final transcript. */
  readonly finish: Effect.Effect<string, SpeechEngineError>;
  readonly close: Effect.Effect<void>;
}

export interface SpeechModel {
  /** Whether it transcribes while audio arrives; otherwise only `transcribe` works. */
  readonly streaming: boolean;
  /** `language` is a code the model knows, or null for its default or own detection. */
  readonly openStream: (language: string | null) => Effect.Effect<SpeechStream, SpeechEngineError>;
  /** Transcribes a whole recording. */
  readonly transcribe: (
    pcm: Float32Array,
    language: string | null,
  ) => Effect.Effect<string, SpeechEngineError>;
  readonly dispose: Effect.Effect<void>;
}

export class SpeechEngine extends Context.Service<
  SpeechEngine,
  {
    /** Whether this platform has a native runtime. Cached after the first call. */
    readonly available: Effect.Effect<boolean>;
    readonly load: (modelPath: string) => Effect.Effect<SpeechModel, SpeechEngineError>;
  }
>()("t3/dictation/SpeechEngine") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const binding = yield* Effect.cached(
    Effect.tryPromise({
      try: async () => {
        const module = await import("transcribe-cpp");
        // Resolves the platform package without dlopen, so a missing build fails here.
        const artifactDir = module.artifactDir();
        // In the desktop app the package resolves inside an archive (app.asar, or server.asar
        // on Windows) that dlopen cannot read. Electron unpacks the native files beside it.
        const unpacked = unpackedArtifactDir(artifactDir);
        const library =
          unpacked !== artifactDir && process.env.TRANSCRIBE_LIBRARY === undefined
            ? path.join(unpacked, nativeLibraryName(platform))
            : null;
        return { module, library };
      },
      catch: (cause) => new SpeechEngineError({ operation: "bind", cause }),
    }),
  );

  const load: SpeechEngine["Service"]["load"] = (modelPath) =>
    Effect.gen(function* () {
      const { module, library } = yield* binding;
      const model = yield* Effect.tryPromise({
        try: () => {
          if (library !== null) {
            // The loader reads this override only from the environment, which every process
            // this server starts inherits. Set it just for the load, so an agent or dev server
            // started from here never picks up this app's copy of the library.
            process.env.TRANSCRIBE_LIBRARY = library;
            try {
              module.libraryPath();
            } finally {
              delete process.env.TRANSCRIBE_LIBRARY;
            }
          }
          return module.TranscribeModel.load(modelPath);
        },
        catch: (cause) => new SpeechEngineError({ operation: "load", cause }),
      });
      const languageOption = (language: string | null) => (language === null ? {} : { language });

      const openStream = Effect.fn("SpeechModel.openStream")(function* (language: string | null) {
        const session = yield* Effect.try({
          try: () => model.createSession(),
          catch: (cause) => new SpeechEngineError({ operation: "open", cause }),
        });
        const stream = yield* Effect.tryPromise({
          try: () =>
            session.stream({
              commitPolicy: "auto",
              timestamps: "none",
              ...languageOption(language),
            }),
          catch: (cause) => new SpeechEngineError({ operation: "open", cause }),
        }).pipe(Effect.tapError(() => Effect.sync(() => session.dispose())));
        // Most feeds leave the hypothesis untouched; reread the snapshot only when it moved.
        let text = "";
        return {
          feed: (pcm) =>
            Effect.tryPromise({
              try: async () => {
                const update = await stream.feed(pcm);
                if (update.resultChanged) text = stream.snapshot.text.trim();
                return text;
              },
              catch: (cause) => new SpeechEngineError({ operation: "feed", cause }),
            }),
          finish: Effect.tryPromise({
            try: async () => {
              await stream.finalize();
              text = stream.snapshot.text.trim();
              return text;
            },
            catch: (cause) => new SpeechEngineError({ operation: "finish", cause }),
          }),
          close: Effect.sync(() => {
            stream.reset();
            session.dispose();
          }),
        } satisfies SpeechStream;
      });

      return {
        streaming: model.capabilities.supportsStreaming,
        openStream,
        transcribe: (pcm, language) =>
          Effect.tryPromise({
            try: async () => {
              const result = await model.transcribe(pcm, {
                timestamps: "none",
                ...languageOption(language),
              });
              return result.text.trim();
            },
            catch: (cause) => new SpeechEngineError({ operation: "transcribe", cause }),
          }),
        dispose: Effect.sync(() => model.dispose()),
      } satisfies SpeechModel;
    });

  return SpeechEngine.of({
    available: binding.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    load,
  });
});

export const layer = Layer.effect(SpeechEngine, make);
