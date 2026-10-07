// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { textFieldGhost } from "./textFieldGhost";

/** A textarea holding `value`, with the cursor `cursor` characters in. */
function field(value: string, cursor: number) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.placeholder = "Leave a comment";
  document.body.append(textarea);
  textarea.setSelectionRange(cursor, cursor);
  return textarea;
}

/** An edit as the user makes it: the text changes, the caret lands after it, `input` fires. */
function edit(textarea: HTMLTextAreaElement, start: number, end: number, text: string) {
  textarea.setRangeText(text, start, end, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  // jsdom has no editing commands, so insertion takes the field's own fallback.
  document.execCommand = () => false;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("textFieldGhost", () => {
  it("inserts where the cursor was, after words typed in front of it or at it", () => {
    const textarea = field("one three", 4);
    const ghost = textFieldGhost(textarea);
    edit(textarea, 0, 0, "and ");
    edit(textarea, 8, 8, "more");
    expect(ghost.commit("two")).toBe(true);
    expect(textarea.value).toBe("and one more two three");
  });

  it("lands where a deletion across it ended", () => {
    const textarea = field("keep this away", 9);
    const ghost = textFieldGhost(textarea);
    edit(textarea, 5, 13, "");
    ghost.commit("that");
    expect(textarea.value).toBe("keep that y");
  });

  it("hides the field's own text while dictating and gives it back after", () => {
    const textarea = field("draft", 5);
    const before = document.body.childElementCount;
    const ghost = textFieldGhost(textarea);
    ghost.show(null);
    expect(textarea.style.color).toBe("transparent");
    expect(textarea.placeholder).toBe("");
    expect(document.body.childElementCount).toBe(before + 1);

    ghost.discard();
    expect(textarea.style.color).toBe("");
    expect(textarea.placeholder).toBe("Leave a comment");
    expect(document.body.childElementCount).toBe(before);
    expect(textarea.value).toBe("draft");
  });

  it("refuses to insert into a field that went read-only, leaving it untouched", () => {
    const textarea = field("draft", 5);
    const ghost = textFieldGhost(textarea);
    textarea.readOnly = true;
    expect(ghost.commit("more")).toBe(false);
    expect(textarea.value).toBe("draft");
  });
});
