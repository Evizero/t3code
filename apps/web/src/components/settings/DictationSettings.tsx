import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DICTATION_MODELS,
  type DictationClientSettings,
  type DictationModel,
  type DictationModelState,
  type DictationStatus,
  dictationModel,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { dictationEnvironment } from "../../state/dictation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatMegabytes } from "../dictation/DictationDownloadToasts";
import { selectDictationSettings } from "../dictation/dictationStore";
import { useDictationEnvironmentId } from "../dictation/useDictationEnvironment";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };
const AUTO_LANGUAGE = "auto";

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });
function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function languagesSummary(model: DictationModel): string {
  if (model.languages.length > 4) return `${model.languages.length} languages`;
  return model.languages.map(languageName).join(", ");
}

const FILTERS = [
  { id: "recommended", label: "Recommended", matches: (model) => model.recommended },
  { id: "multilingual", label: "Multilingual", matches: (model) => model.languages.length > 1 },
  { id: "live", label: "Live", matches: (model) => model.streaming },
  { id: "downloaded", label: "Downloaded", matches: (_model, state) => state !== undefined },
  { id: "all", label: "All", matches: () => true },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly matches: (model: DictationModel, state: DictationModelState | undefined) => boolean;
}>;
type FilterId = (typeof FILTERS)[number]["id"];

/**
 * Dictation on this device: whether it is on, and the speech models the environment on this
 * machine transcribes with. Audio never goes to another machine, so a device without one can't
 * dictate.
 */
export function DictationSettings() {
  const settings = useClientSettings(selectDictationSettings);
  const updateSettings = useUpdateClientSettings();
  const environmentId = useDictationEnvironmentId();
  const setting = searchableSetting("dictation");
  const update = (patch: Partial<DictationClientSettings>) =>
    void updateSettings({ dictation: { ...settings, ...patch } });

  return (
    <>
      <SettingsSection id={setting.id} title={setting.title}>
        <SettingsRow
          title="Local dictation"
          description="Speak into any text box; Enter inserts what you said, Esc discards it. A speech model you download transcribes on this machine, and no cloud service hears you."
          control={
            <Switch
              checked={settings.enabled}
              onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
              aria-label="Local dictation"
            />
          }
        />
        {settings.enabled ? (
          environmentId === null ? (
            <SettingsRow
              title="Speech model"
              description="Dictation transcribes on this machine, so it needs T3 Code running here: the desktop app, or a server opened on localhost."
            />
          ) : (
            <DictationOptions environmentId={environmentId} settings={settings} onChange={update} />
          )
        ) : null}
      </SettingsSection>
      {settings.enabled && environmentId !== null ? (
        <DictationModels environmentId={environmentId} settings={settings} onChange={update} />
      ) : null}
    </>
  );
}

function useDictationStatus(environmentId: EnvironmentId) {
  return useEnvironmentQuery(dictationEnvironment.status({ environmentId, input: {} }));
}

function DictationOptions(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: DictationClientSettings;
  readonly onChange: (patch: Partial<DictationClientSettings>) => void;
}) {
  const { settings, onChange } = props;
  const statusQuery = useDictationStatus(props.environmentId);
  const status = statusQuery.data;
  if (status === null || !status.supported) {
    return (
      <SettingsRow
        title="Speech model"
        description={
          status !== null
            ? "This machine's platform has no local speech runtime."
            : statusQuery.error === null
              ? "Checking dictation…"
              : "Update T3 Code on this machine to use dictation."
        }
      />
    );
  }

  const model = dictationModel(settings.modelId);
  const installed = DICTATION_MODELS.filter((entry) => status.models[entry.id]?.phase === "ready");
  const languages = model?.languages ?? [];
  const language =
    settings.language !== null && languages.includes(settings.language) ? settings.language : null;

  return (
    <>
      <SettingsRow
        title="Model"
        description={
          installed.length === 0
            ? "Download a model below to dictate."
            : "Transcribes on this machine. Audio goes from this window to it and nowhere else."
        }
        control={
          <Select
            value={settings.modelId}
            disabled={installed.length === 0}
            onValueChange={(value) => {
              if (value !== null) onChange({ modelId: value });
            }}
          >
            <SelectTrigger aria-label="Dictation model" className="w-56" size="sm">
              <SelectValue>{model?.name ?? "Choose a model"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {installed.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {model !== undefined && languages.length > 1 ? (
        <SettingsRow
          title="Language"
          description={
            model.languageDetection
              ? "What you speak, or Auto to let the model tell."
              : "What you speak."
          }
          control={
            <Select
              value={language ?? AUTO_LANGUAGE}
              onValueChange={(value) => {
                if (value !== null) onChange({ language: value === AUTO_LANGUAGE ? null : value });
              }}
            >
              <SelectTrigger aria-label="Dictation language" className="w-56" size="sm">
                <SelectValue>
                  {language === null
                    ? model.languageDetection
                      ? "Auto"
                      : languageName(languages[0] ?? "")
                    : languageName(language)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {model.languageDetection ? (
                  <SelectItem value={AUTO_LANGUAGE}>Auto</SelectItem>
                ) : null}
                {languages.map((code) => (
                  <SelectItem key={code} value={code}>
                    {languageName(code)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        title="Live preview"
        description={
          model === undefined || model.streaming
            ? "Words appear at the cursor as you speak. Off, the recording is transcribed when you stop."
            : `${model.name} transcribes the recording when you stop.`
        }
        control={
          <Switch
            checked={settings.livePreview && model?.streaming !== false}
            disabled={model?.streaming === false}
            onCheckedChange={(checked) => onChange({ livePreview: Boolean(checked) })}
            aria-label="Live preview"
          />
        }
      />
    </>
  );
}

function DictationModels(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: DictationClientSettings;
  readonly onChange: (patch: Partial<DictationClientSettings>) => void;
}) {
  const [filter, setFilter] = useState<FilterId>("recommended");
  const status = useDictationStatus(props.environmentId).data;
  if (status === null || !status.supported) return null;
  const matches = FILTERS.find((entry) => entry.id === filter)?.matches ?? (() => true);
  const models = DICTATION_MODELS.filter((model) => matches(model, status.models[model.id]));

  return (
    <SettingsSection
      title="Dictation models"
      headerAction={
        <ToggleGroup
          aria-label="Which models to list"
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            const selected = FILTERS.find((entry) => entry.id === next[0]);
            if (selected) setFilter(selected.id);
          }}
        >
          {FILTERS.map((entry) => (
            <Toggle key={entry.id} value={entry.id}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      }
    >
      {models.length === 0 ? (
        <SettingsRow title="No models" description="None downloaded yet." />
      ) : (
        models.map((model) => (
          <DictationModelRow
            key={model.id}
            environmentId={props.environmentId}
            model={model}
            status={status}
            inUse={props.settings.modelId === model.id}
            onUse={() => props.onChange({ modelId: model.id })}
          />
        ))
      )}
    </SettingsSection>
  );
}

function DictationModelRow(props: {
  readonly environmentId: EnvironmentId;
  readonly model: DictationModel;
  readonly status: DictationStatus;
  readonly inUse: boolean;
  readonly onUse: () => void;
}) {
  const { environmentId, model } = props;
  const state = props.status.models[model.id];
  const installModel = useAtomCommand(dictationEnvironment.installModel, COMMAND_OPTIONS);
  const removeModel = useAtomCommand(dictationEnvironment.removeModel, COMMAND_OPTIONS);
  const canInstall = useAtomValue(dictationEnvironment.installModel.permissionAtom(environmentId));
  const canRemove = useAtomValue(dictationEnvironment.removeModel.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = { environmentId, input: { modelId: model.id } };

  const run = async (request: () => Promise<AtomCommandResult<void, unknown>>) => {
    setPending(true);
    setError(null);
    const result = await request();
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Dictation setup failed.");
    }
  };
  const remove = async () => {
    const confirmed =
      state?.phase !== "ready" ||
      (await ensureLocalApi().dialogs.confirm(
        `Remove ${model.name}? It frees ${formatMegabytes(model.size)}, and other apps that share the Hugging Face cache will download it again.`,
      ));
    if (confirmed) await run(() => removeModel(target));
  };

  const progress =
    state?.phase === "downloading" || state?.phase === "paused" ? (
      <div className="flex flex-col gap-1">
        <progress
          aria-label={`${model.name} download`}
          className="block h-1 w-full max-w-64 accent-foreground"
          value={state.downloadedBytes}
          max={model.size}
        />
        <p className="text-muted-foreground tabular-nums">
          {state.phase === "downloading" ? "Downloading" : "Paused at"}{" "}
          {formatMegabytes(state.downloadedBytes)} of {formatMegabytes(model.size)}
        </p>
      </div>
    ) : null;
  const message = error ?? state?.message ?? null;

  return (
    <SettingsRow
      title={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {model.name}
          {model.streaming ? (
            <Badge variant="info" size="sm">
              Live
            </Badge>
          ) : null}
          {props.inUse && state?.phase === "ready" ? (
            <Badge variant="success" size="sm">
              In use
            </Badge>
          ) : null}
        </span>
      }
      description={`${model.description} · ${languagesSummary(model)} · ${formatMegabytes(model.size)}`}
      status={
        progress !== null || message !== null ? (
          <>
            {progress}
            {message !== null ? (
              <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
                {message}
              </p>
            ) : null}
          </>
        ) : undefined
      }
      control={
        <div className="flex items-center gap-1.5">
          {state?.phase === "ready" && !props.inUse ? (
            <Button size="sm" variant="outline" onClick={props.onUse}>
              Use
            </Button>
          ) : null}
          {state === undefined || state.phase === "paused" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !canInstall}
              onClick={() => void run(() => installModel(target))}
            >
              {state === undefined ? "Download" : "Resume"}
            </Button>
          ) : null}
          {state !== undefined ? (
            <Button
              size="sm"
              variant={state.phase === "downloading" ? "outline" : "ghost"}
              disabled={pending || !canRemove}
              onClick={() => void remove()}
            >
              {state.phase === "ready" ? "Remove" : state.phase === "paused" ? "Discard" : "Cancel"}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
