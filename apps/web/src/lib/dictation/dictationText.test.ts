import { describe, expect, it } from "vite-plus/test";

import { spacedInsertion } from "./dictationText";

describe("spacedInsertion", () => {
  it("sets a transcript apart from the words on both sides", () => {
    expect(spacedInsertion("Fix the", "test", " flaky ")).toBe(" flaky ");
  });

  it("adds no space where there already is one, or nothing to separate", () => {
    expect(spacedInsertion("Fix the ", " test", "flaky")).toBe("flaky");
    expect(spacedInsertion("", "", "flaky")).toBe("flaky");
  });

  it("lets punctuation and brackets hug the transcript", () => {
    expect(spacedInsertion("Hello", "", ", world")).toBe(", world");
    expect(spacedInsertion("(", ")", "aside")).toBe("aside");
    expect(spacedInsertion("Fix it", ".", "now")).toBe(" now");
  });
});
