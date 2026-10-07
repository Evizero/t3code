import { createDictationEnvironmentAtoms } from "@t3tools/client-runtime/state/dictation";

import { connectionAtomRuntime } from "../connection/runtime";

export const dictationEnvironment = createDictationEnvironmentAtoms(connectionAtomRuntime);
