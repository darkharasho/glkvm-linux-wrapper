import { Menu } from 'electron';
import type { WebContents, BaseWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron';

// The subset of Electron's ContextMenuParams we base the menu on. Kept as its own
// interface so buildContextMenuTemplate is a pure function testable without Electron.
export interface CtxParams {
  isEditable: boolean;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
  selectionText: string;
}

/**
 * Decide the context-menu items for a right-click inside a device's remote UI.
 * Editable fields (e.g. the GLKVM "paste to remote" box) get the full editing set,
 * each enabled per the page's editFlags; a plain text selection gets Copy only;
 * anything else gets no menu (returns []).
 */
export function buildContextMenuTemplate(p: CtxParams): MenuItemConstructorOptions[] {
  if (p.isEditable) {
    return [
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll },
    ];
  }
  if (p.selectionText.trim().length > 0) {
    return [{ role: 'copy', enabled: p.editFlags.canCopy }];
  }
  return [];
}

/**
 * Wire a native editing context menu onto a device's WebContents. Without this an
 * Electron WebContentsView has no right-click menu at all, so users can't paste into
 * the remote UI's input fields.
 */
export function attachContextMenu(wc: WebContents, window: BaseWindow): void {
  wc.on('context-menu', (_e, params: ContextMenuParams) => {
    const template = buildContextMenuTemplate({
      isEditable: params.isEditable,
      editFlags: params.editFlags,
      selectionText: params.selectionText,
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}
