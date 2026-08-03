import type { OsKind } from '@shared/types';
import keyRoundSvg from 'lucide-static/icons/key-round.svg?raw';

const P: Record<OsKind, string> = {
  macos: '<path d="M16.4 12.9c0-2 1.6-3 1.7-3-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6 1.1 0 1.5.6 2.5.6s1.7-.9 2.3-1.9c.7-1.1 1-2.1 1-2.2 0 0-2-.8-2.2-3.6zM14.6 6.3c.5-.7.9-1.6.8-2.6-.8 0-1.8.6-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1z" fill="currentColor"/>',
  windows: '<path d="M3 5.5 10.5 4.4v7.1H3zM11.6 4.2 21 3v8.5h-9.4zM3 12.5h7.5v7.1L3 18.5zM11.6 12.5H21V21l-9.4-1.3z" fill="currentColor"/>',
  linux: '<path d="M12 2c-1.9 0-3.2 1.7-3.2 4 0 1 .1 1.8-.5 2.8-.7 1-2.3 2.6-2.9 4.6-.5 1.6-.2 2.6-.5 3.4-.3.7-1 1.2-1 1.9 0 .6.5.9 1.2 1 .8.1 1.9.5 2.8 1 .7.4 1.4.2 1.7-.2.5.1 1.1.2 1.9.2s1.4-.1 1.9-.2c.3.4 1 .6 1.7.2.9-.5 2-.9 2.8-1 .7-.1 1.2-.4 1.2-1 0-.7-.7-1.2-1-1.9-.3-.8 0-1.8-.5-3.4-.6-2-2.2-3.6-2.9-4.6-.6-1-.5-1.8-.5-2.8 0-2.3-1.3-4-3.2-4zm-1.6 5.1c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9zm3.2 0c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9zM12 10c.9 0 1.9.5 2 1 .1.4-.9 1-2 1s-2.1-.6-2-1c.1-.5 1.1-1 2-1z" fill="currentColor"/>',
  generic: '<rect x="2" y="4" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8" fill="none" stroke="currentColor" stroke-width="2"/>',
};

export function osIcon(os: OsKind): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${P[os] ?? P.generic}</svg>`;
}

// Small key glyph (Lucide "key-round") marking a device with a saved autofill password.
export function keyIcon(): string {
  return keyRoundSvg;
}
