// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { editorGhost } from "./editorGhost";

let editor: Editor;

/** A one-line draft with the cursor `cursor` characters in, as dictation starts. */
function dictatingInto(text: string, cursor: number) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit],
    content: `<p>${text}</p>`,
  });
  editor.commands.setTextSelection(cursor + 1);
  return editorGhost(editor);
}

const ghostShown = () => editor.view.dom.querySelector("[data-dictation-ghost-end]") !== null;

afterEach(() => {
  editor.destroy();
});

describe("editorGhost", () => {
  it("inserts the transcript where the cursor was, spaced from the words around it", () => {
    const ghost = dictatingInto("Fix thetest", 7);
    ghost.show("flaky");
    expect(ghostShown()).toBe(true);
    // the ghost is shown, not written into the draft
    expect(editor.getText()).toBe("Fix thetest");

    expect(ghost.commit("flaky")).toBe(true);
    expect(editor.getText()).toBe("Fix the flaky test");
    expect(editor.state.selection.from).toBe(1 + "Fix the flaky ".length);
    expect(ghostShown()).toBe(false);
  });

  it("stays put while words are typed in front of it, and goes after words typed at it", () => {
    const ghost = dictatingInto("Hello three", 5);
    editor.commands.insertContentAt(1, "Say ");
    editor.commands.insertContentAt(10, ",");
    ghost.commit("world");
    expect(editor.getText()).toBe("Say Hello, world three");
  });

  it("clears the ghost when discarded, so the next dictation can start", () => {
    dictatingInto("Draft", 5).discard();
    expect(ghostShown()).toBe(false);
    expect(editor.getText()).toBe("Draft");

    const next = editorGhost(editor);
    next.show("again");
    expect(ghostShown()).toBe(true);
  });
});
