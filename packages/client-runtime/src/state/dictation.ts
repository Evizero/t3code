import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createDictationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // A second click on one model's button joins the request in flight; another model's runs.
  const perModel = {
    mode: "singleFlight" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly modelId: string };
    }) => JSON.stringify([environmentId, input.modelId]),
  };
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:dictation:status",
      tag: WS_METHODS.dictationSubscribeStatus,
    }),
    installModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:install-model",
      tag: WS_METHODS.dictationInstallModel,
      concurrency: perModel,
    }),
    removeModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:remove-model",
      tag: WS_METHODS.dictationRemoveModel,
      concurrency: perModel,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:start",
      tag: WS_METHODS.dictationStart,
    }),
    feed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:feed",
      tag: WS_METHODS.dictationFeed,
    }),
    finish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:finish",
      tag: WS_METHODS.dictationFinish,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:cancel",
      tag: WS_METHODS.dictationCancel,
    }),
  };
}
