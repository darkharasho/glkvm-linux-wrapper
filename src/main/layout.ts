import type { BaseWindow } from 'electron';

export const RAIL_H = 40;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function railArea(win: BaseWindow): Rect {
  const b = win.getContentBounds();
  return { x: 0, y: 0, width: b.width, height: RAIL_H };
}

export function contentArea(win: BaseWindow): Rect {
  const b = win.getContentBounds();
  return { x: 0, y: RAIL_H, width: b.width, height: Math.max(0, b.height - RAIL_H) };
}
