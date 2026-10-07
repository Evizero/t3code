import { createElement, Mic } from "lucide";

// Text that hugs the word before it, or after it, without a space.
const OPENING = /[\s([{"'“‘/-]$/;
const CLOSING = /^[\s.,!?;:)\]}"'”’…/-]/;

/**
 * A transcript as it goes in between `before` and `after`: trimmed, and with the spaces that set
 * it apart from the words on either side.
 */
export function spacedInsertion(before: string, after: string, transcript: string): string {
  const text = transcript.trim();
  const leading = before.length > 0 && !OPENING.test(before) && !CLOSING.test(text) ? " " : "";
  const trailing = after.length > 0 && !CLOSING.test(after) ? " " : "";
  return `${leading}${text}${trailing}`;
}

/** The ghost's look, shared by the editor and plain text boxes. */
export const DICTATION_GHOST_CLASS = "pointer-events-none select-none text-muted-foreground";

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-md bg-foreground/8 px-1.5 text-xs leading-5";
const MARK_CLASS =
  "ms-0.5 inline-flex size-4 items-center justify-center rounded bg-foreground/8 align-text-bottom";

function micIcon(): SVGElement {
  return createElement(Mic, { class: "size-3 shrink-0 text-primary" });
}

/**
 * What a text box shows at the cursor between `before` and `after`: a Listening chip until the
 * first words, then the words so far ending in a mic mark, set apart like `spacedInsertion`.
 */
export function ghostContent(before: string, after: string, transcript: string | null) {
  const spaced = spacedInsertion(
    before,
    transcript === null ? "" : after,
    transcript ?? "Listening",
  );
  const body = document.createElement("span");
  if (transcript === null) {
    body.className = CHIP_CLASS;
    body.append(micIcon(), "Listening");
  } else {
    const mark = document.createElement("span");
    mark.className = MARK_CLASS;
    mark.append(micIcon());
    body.append(spaced.trim(), mark);
  }
  const fragment = document.createDocumentFragment();
  fragment.append(spaced.startsWith(" ") ? " " : "", body, spaced.endsWith(" ") ? " " : "");
  return fragment;
}
