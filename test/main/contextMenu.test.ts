import { describe, it, expect, vi } from 'vitest';

// Electron isn't available in the vitest node env; buildContextMenuTemplate is pure and
// doesn't touch it, but the module imports { Menu } from 'electron' at top level, so stub it.
vi.mock('electron', () => ({ Menu: {} }));

import { buildContextMenuTemplate } from '../../src/main/services/contextMenu';

const flags = (o: Partial<CtxFlags> = {}): CtxFlags => ({
  canCut: false, canCopy: false, canPaste: false, canSelectAll: false, ...o,
});
interface CtxFlags { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean; }

describe('buildContextMenuTemplate', () => {
  it('gives an editable field the full editing set, enabled per editFlags', () => {
    const t = buildContextMenuTemplate({
      isEditable: true,
      editFlags: flags({ canPaste: true, canSelectAll: true }),
      selectionText: '',
    });
    const roles = t.map((i) => ('role' in i ? i.role : `sep`));
    expect(roles).toEqual(['cut', 'copy', 'paste', 'sep', 'selectAll']);
    const paste = t.find((i) => 'role' in i && i.role === 'paste')!;
    const cut = t.find((i) => 'role' in i && i.role === 'cut')!;
    expect((paste as { enabled: boolean }).enabled).toBe(true);  // canPaste true
    expect((cut as { enabled: boolean }).enabled).toBe(false);   // canCut false
  });

  it('gives a non-editable text selection a Copy-only menu', () => {
    const t = buildContextMenuTemplate({
      isEditable: false,
      editFlags: flags({ canCopy: true }),
      selectionText: 'some selected text',
    });
    expect(t).toHaveLength(1);
    expect((t[0] as { role: string }).role).toBe('copy');
  });

  it('gives no menu when not editable and nothing is selected', () => {
    const t = buildContextMenuTemplate({
      isEditable: false,
      editFlags: flags(),
      selectionText: '   ',
    });
    expect(t).toEqual([]);
  });
});
