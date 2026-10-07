import { useAtomValue } from "@effect/atom-react";
import {
  dictationModel,
  type DictationModelState,
  type DictationStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { dictationEnvironment } from "../../state/dictation";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

interface TrackedToast {
  readonly toastId: ReturnType<typeof toastManager.add>;
  /** What the toast shows, so a status update that changes nothing visible leaves it alone. */
  readonly key: string;
}

/**
 * Model downloads run on the environment whatever page is open; away from Settings, which lists
 * them, a toast shows each one's progress and how it ended.
 */
export function DictationDownloadToasts(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const status = useEnvironmentQuery(
    dictationEnvironment.status({ environmentId, input: {} }),
  ).data;
  const inSettings = useLocation({
    select: (location) => location.pathname.startsWith("/settings"),
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const installModel = useAtomCommand(dictationEnvironment.installModel, COMMAND_OPTIONS);
  const removeModel = useAtomCommand(dictationEnvironment.removeModel, COMMAND_OPTIONS);
  const toasts = useRef(new Map<string, TrackedToast>());
  const previous = useRef<DictationStatus["models"] | null>(null);

  useEffect(() => {
    if (status === null) return;
    const before = previous.current;
    previous.current = status.models;
    const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(status.models)]);
    for (const id of ids) {
      const model = dictationModel(id);
      if (model === undefined) continue;
      const tracked = toasts.current.get(id);
      const close = () => {
        if (tracked === undefined) return;
        toastManager.close(tracked.toastId);
        toasts.current.delete(id);
      };
      const show = (key: string, options: Parameters<typeof toastManager.add>[0]) => {
        if (tracked?.key === key) return;
        if (tracked === undefined) {
          toasts.current.set(id, { toastId: toastManager.add(options), key });
        } else {
          toastManager.update(tracked.toastId, options);
          toasts.current.set(id, { ...tracked, key });
        }
      };
      const state: DictationModelState | undefined = status.models[id];
      const was = before?.[id]?.phase;

      if (inSettings) {
        close();
      } else if (state?.phase === "downloading") {
        const label = `${formatMegabytes(state.downloadedBytes)} of ${formatMegabytes(model.size)}`;
        show(`downloading:${label}`, {
          type: "loading",
          title: `Downloading ${model.name}`,
          description: label,
          timeout: 0,
          actionProps: {
            children: "Cancel",
            onClick: () => void removeModel({ environmentId, input: { modelId: id } }),
          },
          data: { hideCopyButton: true },
        });
      } else if (was === "downloading" && state?.phase === "ready") {
        const shortcut = shortcutLabelForCommand(keybindings, "composer.dictate");
        show("ready", {
          type: "success",
          title: `${model.name} is ready`,
          description: shortcut
            ? `Press ${shortcut} in any text box to dictate.`
            : "Click the microphone in the composer to dictate.",
          timeout: 8_000,
          data: { hideCopyButton: true },
        });
      } else if (was === "downloading" && state?.phase === "paused") {
        show("paused", {
          type: "error",
          title: `Download of ${model.name} stopped`,
          description: state.message ?? "It continues where it stopped.",
          timeout: 0,
          actionProps: {
            children: "Resume",
            onClick: () => void installModel({ environmentId, input: { modelId: id } }),
          },
        });
      } else if (state === undefined || tracked?.key.startsWith("downloading")) {
        close();
      }
    }
  }, [environmentId, inSettings, installModel, keybindings, removeModel, status]);

  useEffect(() => {
    const tracked = toasts.current;
    return () => {
      for (const toast of tracked.values()) toastManager.close(toast.toastId);
      tracked.clear();
    };
  }, []);

  return null;
}
