import type { Editor } from "@tiptap/core";

import { editorGhost } from "./editorGhost";
import { type TextField, textFieldGhost } from "./textFieldGhost";

/** A text box being dictated into, showing the transcript as ghost text at its cursor. */
export interface DictationTarget {
  readonly element: HTMLElement;
  /** Shows the transcript so far; null before the first words. */
  readonly show: (text: string | null) => void;
  /** Inserts the transcript where it showed and clears the ghost; false if the box takes no text. */
  readonly commit: (text: string) => boolean;
  /** Clears the ghost without inserting. */
  readonly discard: () => void;
}

const COMPOSER_SURFACE = '[data-chat-composer-surface="true"]';
// Inputs whose cursor a script can place; email and number inputs keep theirs to themselves.
const TEXT_INPUT_TYPES = new Set(["text", "search", "url"]);

// Tiptap keeps its editor on the element it renders into.
const tiptapEditor = (element: Element) =>
  element.closest<HTMLElement & { editor?: Editor }>(".ProseMirror")?.editor;

const isTextField = (element: Element): element is TextField =>
  (element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type))) &&
  !element.disabled &&
  !element.readOnly;

/** The text box `element` belongs to, if it takes dictation: a Tiptap editor, textarea or input. */
export function dictationBox(element: Element | null): HTMLElement | null {
  if (element === null) return null;
  const editor = tiptapEditor(element);
  if (editor !== undefined) return editor.isEditable ? editor.view.dom : null;
  return isTextField(element) ? element : null;
}

/** The composer's editor, which the shortcut dictates into when no other text box has focus. */
export function composerDictationBox(): HTMLElement | null {
  return dictationBox(document.querySelector(`${COMPOSER_SURFACE} .ProseMirror`));
}

/** Whether `box` is a composer's editor, which a thread's page shows again on return. */
export function isComposerBox(box: HTMLElement): boolean {
  return box.closest(COMPOSER_SURFACE) !== null;
}

/** Starts showing dictation in `box`, which `dictationBox` returned. */
export function dictationTargetFor(box: HTMLElement): DictationTarget | null {
  const editor = tiptapEditor(box);
  if (editor !== undefined) return editor.isEditable ? editorGhost(editor) : null;
  return isTextField(box) ? textFieldGhost(box) : null;
}
