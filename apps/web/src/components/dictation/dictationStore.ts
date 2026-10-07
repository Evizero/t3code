import type { ClientSettings } from "@t3tools/contracts";
import { create } from "zustand";

/** Whether this device dictates; a stable selector for `useClientSettings`. */
export const selectDictationEnabled = (settings: ClientSettings) => settings.dictation.enabled;
export const selectDictationSettings = (settings: ClientSettings) => settings.dictation;

export type DictationPhase = "idle" | "starting" | "recording" | "finishing";

interface DictationStore {
  readonly phase: DictationPhase;
  /** The words show in a composer, whose send then counts them. */
  readonly inComposer: boolean;
  /**
   * Dictates into `box` (see `dictationBox`). The mounted `DictationCoordinator` provides it and
   * `stop` while dictation is on and this device can transcribe.
   */
  readonly start: (box: HTMLElement) => void;
  /** Inserts what was said. */
  readonly stop: () => void;
}

export const idleDictation = {
  phase: "idle",
  inComposer: false,
  start: () => undefined,
  stop: () => undefined,
} satisfies DictationStore;

export const useDictationStore = create<DictationStore>(() => idleDictation);
