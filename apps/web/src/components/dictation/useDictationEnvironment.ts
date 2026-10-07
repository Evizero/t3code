import type { EnvironmentId } from "@t3tools/contracts";

import { resolveRemoteOpenState } from "../../remoteOpen";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentPresentation } from "../../state/presentation";

/**
 * The environment that transcribes for this device: the one running on this machine, which is
 * the desktop app's own or a server opened on localhost. Null when there is none, as on the hosted
 * app or a server reached over the network: a microphone's audio stays on the machine it is on.
 */
export function useDictationEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { presentation } = useEnvironmentPresentation(primaryEnvironmentId);
  if (primaryEnvironmentId === null || presentation === null) return null;
  // Open-in-editor makes the same call: whether this client runs on the environment's machine.
  const local =
    resolveRemoteOpenState({
      target: presentation.entry.target,
      sshAlias: null,
      remoteOpenTargets: undefined,
      isDesktopRenderer: window.desktopBridge !== undefined,
    }).mode === "local-exec";
  return local ? primaryEnvironmentId : null;
}
