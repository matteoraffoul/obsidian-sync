import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, MarkdownView, type App } from "obsidian";

export interface EditorLockHost {
  /** Who holds the lock on this file, when it is someone else (undefined = editable). */
  lockedBy(path: string): string | undefined;
  /** Called on every keystroke-like edit, so the host can take the lock and reset its idle timer. */
  onUserEdit(path: string): void;
}

const setLockedBy = StateEffect.define<string | null>();

const USER_EDITS = ["input", "delete", "move", "undo", "redo"];

function filePath(state: EditorState): string | undefined {
  return state.field(editorInfoField, false)?.file?.path;
}

/**
 * Makes the editor read-only (with a visible banner) while another person holds the file's
 * lock, and reports user edits so the lock can be taken on the first keystroke.
 */
export function createEditorLock(host: EditorLockHost): { extension: Extension; refresh(app: App): void } {
  const lockedBy = StateField.define<string | null>({
    create: (state) => {
      const path = filePath(state);
      return (path && host.lockedBy(path)) ?? null;
    },
    update: (value, tr) => {
      for (const effect of tr.effects) if (effect.is(setLockedBy)) value = effect.value;
      return value;
    },
  });

  const reportEdits = EditorState.transactionFilter.of((tr) => {
    // Only typing, pasting, deleting... Programmatic changes (e.g. a reload after a remote update) pass through.
    if (!tr.docChanged || !USER_EDITS.some((event) => tr.isUserEvent(event))) return tr;
    const path = filePath(tr.startState);
    if (!path) return tr;
    if (host.lockedBy(path)) return [];
    host.onUserEdit(path);
    return tr;
  });

  const extension: Extension = [
    lockedBy,
    EditorState.readOnly.from(lockedBy, (owner) => owner !== null),
    EditorView.editable.from(lockedBy, (owner) => owner === null),
    EditorView.editorAttributes.from(lockedBy, (owner): Record<string, string> =>
      owner === null ? {} : { class: "team-sync-readonly", "data-team-sync-user": owner },
    ),
    reportEdits,
  ];

  const refresh = (app: App) => {
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      // `editor.cm` is Obsidian's CodeMirror 6 view (not in the public typings).
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      const owner = host.lockedBy(view.file.path) ?? null;
      if (cm.state.field(lockedBy, false) !== owner) cm.dispatch({ effects: setLockedBy.of(owner) });
    });
  };

  return { extension, refresh };
}
