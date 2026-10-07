import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DEFAULT_DICTATION_MODEL_ID } from "./dictationModels.ts";

export * from "./dictationModels.ts";

const DictationModelId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * One catalog model's files on the environment. `paused` holds part of a download, kept so it
 * continues where it stopped, or a copy that failed its check; `message` says why.
 */
export const DictationModelState = Schema.Struct({
  phase: Schema.Literals(["downloading", "paused", "ready"]),
  downloadedBytes: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
});
export type DictationModelState = typeof DictationModelState.Type;

/**
 * Dictation on an environment. `supported` is false when this server has no native transcription
 * runtime for its platform; it never changes at runtime. A catalog model absent from `models` has
 * no files there.
 */
export const DictationStatus = Schema.Struct({
  supported: Schema.Boolean,
  models: Schema.Record(DictationModelId, DictationModelState),
});
export type DictationStatus = typeof DictationStatus.Type;

export const DictationModelInput = Schema.Struct({ modelId: DictationModelId });
export type DictationModelInput = typeof DictationModelInput.Type;

/**
 * Dictation on this device: whether it is on, and how this device's environment transcribes.
 * Off until turned on in Settings.
 */
export const DictationClientSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  modelId: DictationModelId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DICTATION_MODEL_ID)),
  ),
  /** A language the model knows; null lets a model that tells languages apart choose. */
  language: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Shows words as they are spoken, for models that stream. */
  livePreview: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type DictationClientSettings = typeof DictationClientSettings.Type;

/** About 30 seconds of audio. Clients split larger backlogs across feeds. */
export const DICTATION_MAX_FEED_BYTES = 1_000_000;

/** Chosen by the client so a lost `start` response can still be cancelled. */
const DictationSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const DictationSessionInput = Schema.Struct({
  sessionId: DictationSessionId,
});
export type DictationSessionInput = typeof DictationSessionInput.Type;

export const DictationStartInput = Schema.Struct({
  sessionId: DictationSessionId,
  modelId: DictationModelId,
  language: Schema.NullOr(Schema.String),
  /** Transcribe while recording and report partial text; otherwise the whole recording on finish. */
  live: Schema.Boolean,
});
export type DictationStartInput = typeof DictationStartInput.Type;

export const DictationFeedInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** Mono 16 kHz signed 16-bit little-endian PCM recorded since the previous feed. */
  audio: Schema.Uint8Array,
});
export type DictationFeedInput = typeof DictationFeedInput.Type;

/** The whole transcript so far, not a delta. */
export const DictationTranscript = Schema.Struct({
  text: Schema.String,
});
export type DictationTranscript = typeof DictationTranscript.Type;

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: Schema.Literals([
    "unsupported",
    "unknown-model",
    "model-missing",
    "busy",
    "session-not-found",
    "invalid-audio",
    "transcription-failed",
    "remove-failed",
    "too-long",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Dictation is not available on this environment's platform.";
      case "unknown-model":
        return "This environment doesn't know that dictation model. Update T3 Code.";
      case "model-missing":
        return "Download the dictation model in Settings first.";
      case "busy":
        return "Someone is already dictating on this environment. Try again when they finish.";
      case "session-not-found":
        return "This dictation session has ended.";
      case "invalid-audio":
        return "Dictation audio was not 16-bit PCM.";
      case "transcription-failed":
        return "Dictation could not transcribe the recording.";
      case "remove-failed":
        return "Could not delete the dictation model files.";
      case "too-long":
        return "The recording is longer than this model can transcribe at once.";
    }
  }
}
