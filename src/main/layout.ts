import type { BaseWindow } from 'electron';

export const RAIL_H = 40;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The window is frameless (frame:false), so there are no frame insets and the
// outer window bounds equal the content area. We deliberately use getBounds()
// rather than getContentBounds(): on Linux/X11 a window-manager-driven maximize
// (e.g. dragging the window to the top edge) leaves getContentBounds() reporting
// the stale pre-maximize size while getBounds() reports the correct new size, so
// getContentBounds() would leave the child views un-scaled.
export function railArea(win: BaseWindow): Rect {
  if (win.isFullScreen()) return { x: 0, y: 0, width: 0, height: 0 }; // hidden in fullscreen
  const b = win.getBounds();
  return { x: 0, y: 0, width: b.width, height: RAIL_H };
}

export function contentArea(win: BaseWindow): Rect {
  const b = win.getBounds();
  const rail = win.isFullScreen() ? 0 : RAIL_H;
  return { x: 0, y: rail, width: b.width, height: Math.max(0, b.height - rail) };
}
