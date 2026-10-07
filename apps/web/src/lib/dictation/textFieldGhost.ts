import { DICTATION_GHOST_CLASS, ghostContent, spacedInsertion } from "./dictationText";

export type TextField = HTMLTextAreaElement | HTMLInputElement;

// What lays text out, so the overlay wraps the field's text exactly as the field does.
const MIRRORED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "textAlign",
  "tabSize",
  "direction",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

/**
 * Where the anchor moves after an edit `delta` characters long that left the caret at `caret`:
 * along with edits in front of it, to the caret when a deletion took it.
 */
function shiftedAnchor(anchor: number, caret: number, delta: number): number {
  if (delta >= 0) return caret - delta <= anchor ? anchor + delta : anchor;
  return caret <= anchor ? Math.max(caret, anchor + delta) : anchor;
}

/**
 * Dictates into a textarea or text input. A field can't style part of its text, so while dictating
 * an overlay laid over it draws the field's text with the ghost in it, and the field's own text,
 * which the ghost would otherwise cover, is hidden. The caret stays the field's own.
 */
export function textFieldGhost(field: TextField) {
  let anchor = field.selectionEnd ?? field.value.length;
  let length = field.value.length;
  let text: string | null = null;

  const overlay = document.createElement("div");
  const before = document.createElement("span");
  const ghost = document.createElement("span");
  const after = document.createElement("span");
  const ghostEnd = document.createElement("span");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    overflow: "hidden",
    pointerEvents: "none",
  });
  ghost.className = DICTATION_GHOST_CLASS;
  overlay.append(before, ghost, after);
  document.body.append(overlay);

  const { color } = getComputedStyle(field);
  const restore = {
    color: field.style.color,
    caretColor: field.style.caretColor,
    placeholder: field.placeholder,
  };
  overlay.style.color = color;
  field.style.caretColor = color;
  field.style.color = "transparent";
  // The overlay shows "Listening…" where an empty field shows its placeholder.
  field.placeholder = "";

  const layout = () => {
    const rect = field.getBoundingClientRect();
    const style = getComputedStyle(field);
    for (const name of MIRRORED_STYLES) overlay.style[name] = style[name];
    // The client box leaves out the border and any scrollbar, which the text never runs under.
    overlay.style.left = `${rect.left + field.clientLeft}px`;
    overlay.style.top = `${rect.top + field.clientTop}px`;
    overlay.style.width = `${field.clientWidth}px`;
    overlay.style.height = `${field.clientHeight}px`;
    overlay.style.boxSizing = "border-box";
    overlay.style.overflowWrap = "break-word";
    if (field instanceof HTMLTextAreaElement) {
      overlay.style.whiteSpace = "pre-wrap";
    } else {
      // An input centres its one line.
      overlay.style.whiteSpace = "pre";
      overlay.style.lineHeight = `${field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)}px`;
    }
    const value = field.value;
    const head = value.slice(0, anchor);
    before.textContent = head;
    after.textContent = value.slice(anchor);
    ghost.replaceChildren(ghostContent(head, value.slice(anchor), text), ghostEnd);
    // The newest words stay in view: the overlay scrolls past the field's own text, which the
    // ghost makes longer than the field can scroll.
    const endBottom = ghostEnd.offsetTop + ghostEnd.offsetHeight + parseFloat(style.paddingBottom);
    const endRight = ghostEnd.offsetLeft + parseFloat(style.paddingRight);
    overlay.scrollTop = Math.max(field.scrollTop, Math.ceil(endBottom - overlay.clientHeight));
    overlay.scrollLeft = Math.max(field.scrollLeft, Math.ceil(endRight - overlay.clientWidth));
  };

  const onInput = () => {
    const delta = field.value.length - length;
    length = field.value.length;
    anchor = Math.min(shiftedAnchor(anchor, field.selectionStart ?? length, delta), length);
    layout();
  };
  field.addEventListener("input", onInput);
  field.addEventListener("scroll", layout);
  window.addEventListener("scroll", layout, true);
  window.addEventListener("resize", layout);
  layout();

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    field.removeEventListener("input", onInput);
    field.removeEventListener("scroll", layout);
    window.removeEventListener("scroll", layout, true);
    window.removeEventListener("resize", layout);
    overlay.remove();
    field.style.color = restore.color;
    field.style.caretColor = restore.caretColor;
    field.placeholder = restore.placeholder;
  };

  return {
    element: field,
    show: (next: string | null) => {
      text = next;
      layout();
    },
    commit: (transcript: string) => {
      end();
      if (!field.isConnected || field.disabled || field.readOnly) return false;
      const at = Math.min(anchor, field.value.length);
      const insertion = spacedInsertion(
        field.value.slice(0, at),
        field.value.slice(at),
        transcript,
      );
      field.focus();
      field.setSelectionRange(at, at);
      // insertText keeps the insertion on the field's undo stack and reaches React's onChange.
      if (!document.execCommand("insertText", false, insertion)) {
        field.setRangeText(insertion, at, at, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    },
    discard: end,
  };
}
