import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, SquareIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { dictationBox } from "../../lib/dictation/dictationTarget";
import { dictationEnvironment } from "../../state/dictation";
import { useEnvironmentQuery } from "../../state/query";
import { selectDictationSettings, useDictationStore } from "../dictation/dictationStore";
import { useDictationEnvironmentId } from "../dictation/useDictationEnvironment";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The composer's mic, while dictation is on and this device can transcribe: starts dictating into
 * the composer, and shows the session the `DictationCoordinator` runs.
 */
export function ComposerDictationControl(props: {
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const settings = useClientSettings(selectDictationSettings);
  const environmentId = useDictationEnvironmentId();
  if (!settings.enabled || environmentId === null) return null;
  return (
    <DictationButton
      environmentId={environmentId}
      modelId={settings.modelId}
      keybindings={props.keybindings}
    />
  );
}

function DictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly modelId: string;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const { environmentId, keybindings } = props;
  const navigate = useNavigate();
  const status = useEnvironmentQuery(
    dictationEnvironment.status({ environmentId, input: {} }),
  ).data;
  const canDictate = useAtomValue(dictationEnvironment.start.permissionAtom(environmentId));
  const phase = useDictationStore((state) => state.phase);
  if (status === null || !status.supported || !canDictate) return null;

  const active = phase !== "idle";
  const ready = status.models[props.modelId]?.phase === "ready";
  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.dictate");
  const label = active ? "Stop and insert" : ready ? "Dictate" : "Set up dictation";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={active ? "destructive-outline" : "ghost"}
            size="icon-sm"
            disabled={phase === "finishing"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const dictation = useDictationStore.getState();
              if (active) {
                dictation.stop();
                return;
              }
              if (!ready) {
                void navigate({ to: "/settings/general", hash: searchableSetting("dictation").id });
                return;
              }
              const box = dictationBox(
                event.currentTarget
                  .closest('[data-chat-composer-surface="true"]')
                  ?.querySelector(".ProseMirror") ?? null,
              );
              if (box !== null) dictation.start(box);
            }}
            aria-label={label}
          />
        }
      >
        {phase === "starting" || phase === "finishing" ? (
          <Spinner />
        ) : active ? (
          <SquareIcon />
        ) : (
          <MicIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {label}
        {shortcutLabel && (ready || active) ? ` (${shortcutLabel})` : null}
        {active ? " · Esc discards" : null}
      </TooltipPopup>
    </Tooltip>
  );
}
