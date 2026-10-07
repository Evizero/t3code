import type { Editor } from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { DICTATION_GHOST_CLASS, ghostContent, spacedInsertion } from "./dictationText";

interface Ghost {
  /** Where the transcript goes, kept in place through edits made while dictating. */
  readonly pos: number;
  /** The transcript so far; null before the first words. */
  readonly text: string | null;
}

const ghostKey = new PluginKey<Ghost>("dictationGhost");

// Mentions and other inline nodes read as a word, so a transcript is set apart from them.
const textAround = (state: EditorState, pos: number) => ({
  before: state.doc.textBetween(Math.max(0, pos - 1), pos, "\n", "￼"),
  after: state.doc.textBetween(pos, Math.min(state.doc.content.size, pos + 1), "\n", "￼"),
});

/**
 * Shows a transcript at the cursor as a decoration: it reads inline with the draft but stays out
 * of the document, so the draft only changes when the transcript is inserted.
 */
function dictationGhostPlugin(): Plugin<Ghost> {
  return new Plugin<Ghost>({
    key: ghostKey,
    state: {
      init: (_, state) => ({ pos: state.selection.to, text: null }),
      apply: (tr, ghost) => {
        const update = tr.getMeta(ghostKey) as { text: string | null } | undefined;
        // Typing at the ghost goes in front of it, as it would in front of the cursor.
        const pos = tr.docChanged ? tr.mapping.map(ghost.pos, 1) : ghost.pos;
        if (update === undefined && pos === ghost.pos) return ghost;
        return { pos, text: update === undefined ? ghost.text : update.text };
      },
    },
    props: {
      attributes: { "data-dictating": "" },
      decorations: (state) => {
        const ghost = ghostKey.getState(state);
        if (ghost === undefined) return null;
        const { before, after } = textAround(state, ghost.pos);
        return DecorationSet.create(state.doc, [
          Decoration.widget(ghost.pos, () => ghostElement(before, after, ghost.text), {
            side: 1,
            // Redrawn only when what it shows changes.
            key: `dictation:${JSON.stringify([before, after, ghost.text])}`,
            ignoreSelection: true,
          }),
        ]);
      },
    },
  });
}

// Marks where the ghost ends, which is kept in view as the transcript grows.
const GHOST_END = "data-dictation-ghost-end";

function ghostElement(before: string, after: string, text: string | null): HTMLElement {
  const element = document.createElement("span");
  element.className = DICTATION_GHOST_CLASS;
  element.append(ghostContent(before, after, text));
  const end = document.createElement("span");
  end.setAttribute(GHOST_END, "");
  element.append(end);
  return element;
}

/** Updates the transcript the ghost shows; null for the placeholder. */
function showAtGhost(state: EditorState, text: string | null): Transaction {
  return state.tr.setMeta(ghostKey, { text });
}

/**
 * Puts `transcript` where the ghost stands, spaced from the words around it, with the cursor
 * after it. Null without a ghost, or when it no longer stands in text.
 */
function insertAtGhost(state: EditorState, transcript: string): Transaction | null {
  const ghost = ghostKey.getState(state);
  if (ghost === undefined || ghost.pos > state.doc.content.size) return null;
  if (!state.doc.resolve(ghost.pos).parent.inlineContent) return null;
  const { before, after } = textAround(state, ghost.pos);
  const text = spacedInsertion(before, after, transcript);
  const tr = state.tr.insertText(text, ghost.pos);
  return tr.setSelection(TextSelection.create(tr.doc, ghost.pos + text.length));
}

// The composer draws its placeholder over an empty draft, where it would cover the ghost.
const PLACEHOLDER_STYLE_ID = "dictation-ghost-style";
const PLACEHOLDER_STYLE =
  ":has(> * > .ProseMirror[data-dictating]) > .pointer-events-none { visibility: hidden; }";

function hidePlaceholdersWhileDictating() {
  if (document.getElementById(PLACEHOLDER_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = PLACEHOLDER_STYLE_ID;
  style.textContent = PLACEHOLDER_STYLE;
  document.head.append(style);
}

/**
 * Scrolls the editor's own scroll area, the nearest one around it, just enough to show `element`:
 * the newest words stay in view once the transcript outgrows the editor. The page and the
 * timeline around the composer stay where they are.
 */
function keepInScrollArea(element: Element, editorElement: HTMLElement) {
  let area: HTMLElement | null = editorElement;
  while (area !== null && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) {
    area = area.parentElement;
  }
  if (area === null || area === document.scrollingElement) return;
  const target = element.getBoundingClientRect();
  const bounds = area.getBoundingClientRect();
  if (target.bottom > bounds.bottom) area.scrollTop += target.bottom - bounds.bottom;
  else if (target.top < bounds.top) area.scrollTop -= bounds.top - target.top;
}

/** Dictates into a Tiptap editor, such as the composer's. */
export function editorGhost(editor: Editor) {
  hidePlaceholdersWhileDictating();
  editor.unregisterPlugin(ghostKey);
  editor.registerPlugin(dictationGhostPlugin());
  const end = () => {
    editor.unregisterPlugin(ghostKey);
  };
  return {
    element: editor.view.dom,
    show: (text: string | null) => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(showAtGhost(editor.state, text));
      const end = editor.view.dom.querySelector(`[${GHOST_END}]`);
      if (end !== null) keepInScrollArea(end, editor.view.dom);
    },
    commit: (text: string) => {
      const tr =
        editor.isEditable && !editor.isDestroyed ? insertAtGhost(editor.state, text) : null;
      if (tr !== null) {
        editor.view.dispatch(tr);
        editor.view.focus();
      }
      end();
      return tr !== null;
    },
    discard: end,
  };
}
