import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { StreamingDictation } from "@t3tools/client-runtime/voice-input/streaming";
import { dictationModel, type DictationStartInput, type EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand } from "../../keybindings";
import {
  composerDictationBox,
  type DictationTarget,
  dictationBox,
  dictationTargetFor,
  isComposerBox,
} from "../../lib/dictation/dictationTarget";
import {
  type MicrophoneCapture,
  startMicrophoneCapture,
} from "../../lib/dictation/microphoneCapture";
import { isEditableFocused } from "../../lib/editableFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { randomUUID } from "../../lib/utils";
import { dictationEnvironment } from "../../state/dictation";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { searchableSetting } from "../settings/settingsSearch";
import { toastManager } from "../ui/toast";
import { DictationDownloadToasts } from "./DictationDownloadToasts";
import { DictationPill } from "./DictationPill";
import {
  type DictationPhase,
  idleDictation,
  selectDictationEnabled,
  useDictationStore,
} from "./dictationStore";
import { useDictationEnvironmentId } from "./useDictationEnvironment";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };

async function unwrap<A, E>(result: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const settled = await result;
  if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
  return settled.value;
}

function reportDictationError(error: unknown, keptTranscript: boolean): void {
  const denied = error instanceof DOMException && error.name === "NotAllowedError";
  const reason = denied
    ? "Microphone access was denied. Allow it in your browser or system settings."
    : error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "Dictation failed. Try again.";
  toastManager.add({
    type: "error",
    title: "Dictation stopped",
    description: keptTranscript ? `${reason} What was transcribed so far was kept.` : reason,
  });
}

const setPhase = (phase: DictationPhase) => useDictationStore.setState({ phase });

function swallow(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

interface ActiveDictation {
  /** Where the words show; null while that box is off screen. */
  target: DictationTarget | null;
  /** The page it started on, and whether in its composer, which shows the words again on return. */
  readonly origin: { readonly pathname: string; readonly composer: boolean };
  readonly startedAt: number;
  /** Opened once the microphone records. */
  session: StreamingDictation | null;
  capture: MicrophoneCapture | null;
  finishing: boolean;
  /** Latest partial transcript, kept if the session fails before finishing. */
  transcript: string;
  /** Sends waiting on the words, run once they went into the box they were dictated into. */
  readonly afterInsert: Array<() => void>;
}

/** Tells a composer whether the words show in it, so its send counts them. */
const publishTarget = (active: ActiveDictation | null) =>
  useDictationStore.setState({
    inComposer: active?.target != null && isComposerBox(active.target.element),
  });

/**
 * Dictation into whichever text box has focus, when it is on and this device can transcribe: the
 * browser records, the environment on this machine transcribes, and the words show as ghost text at
 * the cursor. Enter or the shortcut inserts them there, Escape discards them. One session at a
 * time, which the composer's mic drives too.
 */
export function DictationCoordinator() {
  const enabled = useClientSettings(selectDictationEnabled);
  const environmentId = useDictationEnvironmentId();
  if (!enabled || environmentId === null) return null;
  return (
    <>
      <DictationSession environmentId={environmentId} />
      <DictationDownloadToasts environmentId={environmentId} />
    </>
  );
}

function DictationSession(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const status = useEnvironmentQuery(
    dictationEnvironment.status({ environmentId, input: {} }),
  ).data;
  // Read by handlers that outlive a render: the keyboard shortcut and the session's callbacks.
  const pathnameRef = useRef(pathname);
  const statusRef = useRef(status);
  useLayoutEffect(() => {
    pathnameRef.current = pathname;
    statusRef.current = status;
  });
  const startSession = useAtomCommand(dictationEnvironment.start, COMMAND_OPTIONS);
  const feedSession = useAtomCommand(dictationEnvironment.feed, COMMAND_OPTIONS);
  const finishSession = useAtomCommand(dictationEnvironment.finish, COMMAND_OPTIONS);
  const cancelSession = useAtomCommand(dictationEnvironment.cancel, COMMAND_OPTIONS);
  const activeRef = useRef<ActiveDictation | null>(null);
  /** The recording while its text box is off screen; null while the box shows it. */
  const [pill, setPill] = useState<{
    readonly startedAt: number;
    readonly transcript: string;
  } | null>(null);
  const phase = useDictationStore((state) => state.phase);

  /**
   * Lets go of the box once it is gone or its page is: a thread's page keeps its composer for the
   * next thread, so the box only belongs to the dictation on the page it started on.
   */
  const releaseLostTarget = useCallback((active: ActiveDictation) => {
    if (
      active.target !== null &&
      (!active.target.element.isConnected || pathnameRef.current !== active.origin.pathname)
    ) {
      active.target.discard();
      active.target = null;
    }
  }, []);

  /** Shows the words in their box, back in it once its page is open again, or in the pill. */
  const place = useCallback(
    (active: ActiveDictation) => {
      releaseLostTarget(active);
      if (
        active.target === null &&
        active.origin.composer &&
        pathnameRef.current === active.origin.pathname
      ) {
        const box = composerDictationBox();
        active.target = box === null ? null : dictationTargetFor(box);
      }
      if (active.target === null) {
        setPill({ startedAt: active.startedAt, transcript: active.transcript });
        publishTarget(active);
        return;
      }
      setPill(null);
      // Until the first words, each chunk of audio reports an empty transcript.
      active.target.show(active.transcript.trim().length > 0 ? active.transcript : null);
      publishTarget(active);
    },
    [releaseLostTarget],
  );

  /**
   * Inserts a transcript where it shows, else into the text box with focus, else the composer on
   * screen, else onto the clipboard. Says whether it went where it was dictated.
   */
  const deliver = useCallback(
    (active: ActiveDictation, text: string) => {
      releaseLostTarget(active);
      const current = active.target;
      active.target = null;
      const tried = new Set<HTMLElement>();
      for (const box of [
        current?.element ?? null,
        dictationBox(document.activeElement),
        composerDictationBox(),
      ]) {
        if (box === null || tried.has(box)) continue;
        tried.add(box);
        // A commit clears its ghost whether or not the box took the text.
        const target = box === current?.element ? current : dictationTargetFor(box);
        if (target?.commit(text)) return box === current?.element ? "origin" : "elsewhere";
      }
      void navigator.clipboard.writeText(text).then(
        () =>
          toastManager.add({
            type: "info",
            title: "Transcript copied",
            description: "No text box could take the dictated text, so it is on your clipboard.",
          }),
        () =>
          toastManager.add({
            type: "error",
            title: "Transcript not inserted",
            description: `No text box could take it and the clipboard was unavailable: ${text}`,
          }),
      );
      return "clipboard";
    },
    [releaseLostTarget],
  );

  const end = useCallback((active: ActiveDictation) => {
    if (activeRef.current !== active) return false;
    activeRef.current = null;
    setPhase("idle");
    setPill(null);
    publishTarget(null);
    return true;
  }, []);

  const cancel = useCallback(() => {
    const active = activeRef.current;
    if (active === null) return;
    active.capture?.cancel();
    active.session?.cancel();
    active.target?.discard();
    end(active);
  }, [end]);

  /** Ends a failed session, inserting whatever was transcribed so the words are not lost. */
  const fail = useCallback(
    (active: ActiveDictation, error: unknown) => {
      if (!end(active)) return;
      const kept = active.transcript.trim().length > 0;
      if (kept) deliver(active, active.transcript);
      else active.target?.discard();
      reportDictationError(error, kept);
    },
    [deliver, end],
  );

  const openSession = useCallback(
    (active: ActiveDictation, input: Omit<DictationStartInput, "sessionId">) => {
      const sessionId = randomUUID();
      return new StreamingDictation(
        {
          start: () => unwrap(startSession({ environmentId, input: { ...input, sessionId } })),
          feed: (audio) =>
            unwrap(feedSession({ environmentId, input: { sessionId, audio } })).then(
              (transcript) => transcript.text,
            ),
          finish: () =>
            unwrap(finishSession({ environmentId, input: { sessionId } })).then(
              (transcript) => transcript.text,
            ),
          cancel: () => unwrap(cancelSession({ environmentId, input: { sessionId } })),
        },
        {
          onTranscript: (text) => {
            if (activeRef.current !== active) return;
            const changed = text !== active.transcript;
            active.transcript = text;
            // Most chunks leave the transcript as it was; while the box is away, each checks
            // whether the user came back to it.
            if (changed || active.target === null) place(active);
          },
          onError: (error) => {
            // A failure while finishing is reported once, by `stop`.
            if (activeRef.current !== active || active.finishing) return;
            active.capture?.cancel();
            fail(active, error);
          },
        },
      );
    },
    [cancelSession, environmentId, fail, feedSession, finishSession, place, startSession],
  );

  const start = useCallback(
    (box: HTMLElement) => {
      if (activeRef.current !== null) return;
      const settings = getClientSettings().dictation;
      const model = dictationModel(settings.modelId);
      if (model === undefined || statusRef.current?.models[model.id]?.phase !== "ready") {
        toastManager.add({
          type: "info",
          title: "Choose a dictation model",
          description: "Download one in Settings to dictate on this device.",
          actionProps: {
            children: "Open Settings",
            onClick: () =>
              void navigate({ to: "/settings/general", hash: searchableSetting("dictation").id }),
          },
        });
        return;
      }
      const target = dictationTargetFor(box);
      if (target === null) return;
      const active: ActiveDictation = {
        target,
        origin: { pathname: pathnameRef.current, composer: isComposerBox(box) },
        startedAt: Date.now(),
        session: null,
        capture: null,
        finishing: false,
        transcript: "",
        afterInsert: [],
      };
      activeRef.current = active;
      publishTarget(active);
      setPhase("starting");
      target.show(null);
      // The environment's session opens once the microphone records: one held open through a slow
      // permission prompt would be reclaimed as abandoned. Audio waits in the session until the
      // model is ready, so nothing said in the meantime is lost.
      void startMicrophoneCapture(
        (pcm) => active.session?.push(pcm),
        (error) => {
          // The microphone went away: keep what was transcribed and release the environment.
          if (activeRef.current !== active) return;
          active.session?.cancel();
          fail(active, error);
        },
      ).then(
        (capture) => {
          if (activeRef.current !== active) {
            capture.cancel();
            return;
          }
          active.capture = capture;
          active.session = openSession(active, {
            modelId: model.id,
            language: settings.language,
            live: settings.livePreview && model.streaming,
          });
          setPhase("recording");
        },
        (error: unknown) => fail(active, error),
      );
    },
    [fail, navigate, openSession],
  );

  /**
   * Inserts what was said. `afterInsert` runs once the words went into the box they were dictated
   * into, or nothing was said there; a stop already finishing takes it on too.
   */
  const stop = useCallback(
    (afterInsert?: () => void) => {
      const active = activeRef.current;
      if (active === null) return;
      if (afterInsert !== undefined) active.afterInsert.push(afterInsert);
      if (active.finishing) return;
      if (active.capture === null) {
        // Nothing recorded yet: the dictation goes, and a send waiting on it goes ahead.
        releaseLostTarget(active);
        const here = active.target !== null;
        cancel();
        if (here) for (const run of active.afterInsert) run();
        return;
      }
      active.finishing = true;
      setPhase("finishing");
      void active.capture
        .stop()
        .then(() => active.session?.finish() ?? "")
        .then(
          (text) => {
            if (!end(active)) return;
            releaseLostTarget(active);
            let here = active.target !== null;
            if (text.trim().length === 0) active.target?.discard();
            else here = deliver(active, text) === "origin";
            if (here) for (const run of active.afterInsert) run();
          },
          (error: unknown) => fail(active, error),
        );
    },
    [cancel, deliver, end, fail, releaseLostTarget],
  );

  useLayoutEffect(() => {
    useDictationStore.setState({ start, stop });
  }, [start, stop]);

  // Leaving the page moves the words to the pill at once, before the next thread's draft shows
  // them; coming back puts them in the box again.
  useLayoutEffect(() => {
    const active = activeRef.current;
    if (active !== null) place(active);
  }, [pathname, place]);

  // Turning dictation off, or this device losing its environment, discards an unfinished
  // recording; in the layout phase, before a settling request could insert it.
  useLayoutEffect(
    () => () => {
      cancel();
      useDictationStore.setState(idleDictation);
    },
    [cancel],
  );

  // Sending while dictating into the composer sends what was said too: the click waits for the
  // words to go in, then goes through as it was made.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const active = activeRef.current;
      const box = active?.target?.element;
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('button[type="submit"]')
          : null;
      const form = button?.form;
      if (active == null || box === undefined || !button || !form?.contains(box)) return;
      swallow(event);
      const { metaKey, ctrlKey, shiftKey, altKey } = event;
      stop(() =>
        // After the composer has rendered the inserted words. The words changing the draft can
        // change what the button does, or remove it; then it waits for another click.
        window.requestAnimationFrame(() => {
          if (!button.isConnected || button.disabled || button.form !== form) return;
          button.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              metaKey,
              ctrlKey,
              shiftKey,
              altKey,
            }),
          );
        }),
      );
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [stop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const active = activeRef.current;
      if (active !== null && event.key === "Escape") {
        swallow(event);
        cancel();
        return;
      }
      // Enter in the box being dictated into inserts the words rather than sending the draft.
      if (
        active !== null &&
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        active.target?.element.contains(document.activeElement)
      ) {
        swallow(event);
        stop();
        return;
      }
      const focused = dictationBox(document.activeElement);
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          editableFocus: isEditableFocused(event.target),
          composerFocus: focused !== null && isComposerBox(focused),
        },
      });
      if (command !== "composer.dictate") return;
      // Holding the shortcut down neither stops what it just started nor starts another.
      if (event.repeat) {
        swallow(event);
        return;
      }
      if (active !== null) {
        swallow(event);
        stop();
        return;
      }
      const box = focused ?? composerDictationBox();
      if (box === null) return;
      swallow(event);
      start(box);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, keybindings, start, stop]);

  return pill === null || phase === "idle" ? null : (
    <DictationPill
      startedAt={pill.startedAt}
      transcript={pill.transcript}
      finishing={phase === "finishing"}
      onInsert={() => stop()}
      onDiscard={cancel}
    />
  );
}
