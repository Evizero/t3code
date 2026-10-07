import { describe, expect, it } from "@effect/vitest";

import { unpackedArtifactDir } from "./SpeechEngine.ts";

describe("unpackedArtifactDir", () => {
  it("points into the unpacked copy of whichever archive the desktop app loads from", () => {
    expect(
      unpackedArtifactDir(
        "/Applications/T3 Code.app/Contents/Resources/app.asar/node_modules/@transcribe-cpp/darwin-arm64-metal",
      ),
    ).toBe(
      "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/node_modules/@transcribe-cpp/darwin-arm64-metal",
    );
    expect(
      unpackedArtifactDir(
        "C:\\Program Files\\T3 Code\\resources\\server.asar\\node_modules\\@transcribe-cpp\\win32-x64-cpu-vulkan",
      ),
    ).toBe(
      "C:\\Program Files\\T3 Code\\resources\\server.asar.unpacked\\node_modules\\@transcribe-cpp\\win32-x64-cpu-vulkan",
    );
    // outside an archive, and already unpacked, it stays put
    const dev = "/repo/node_modules/@transcribe-cpp/darwin-arm64-metal";
    expect(unpackedArtifactDir(dev)).toBe(dev);
    const unpacked = "/app/resources/app.asar.unpacked/node_modules/@transcribe-cpp/linux-x64";
    expect(unpackedArtifactDir(unpacked)).toBe(unpacked);
  });
});
