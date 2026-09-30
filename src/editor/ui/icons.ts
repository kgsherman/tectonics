/** Inline SVG icons (20×20, stroke = currentColor) for the plate editor. */
import type { ToolId } from '../tools';

const svg = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const TOOL_ICONS: Record<ToolId, string> = {
  select: svg('<path d="M5 2.8l10.2 6.6-4.6 1.1 2.7 5.1-2 1-2.7-5.1L5 14.8z"/>'),
  plate: svg(
    '<path d="M16.8 3.2a1.3 1.3 0 0 1 0 1.9l-6.7 6.7-2-2 6.8-6.6a1.3 1.3 0 0 1 1.9 0z"/>' +
      '<path d="M7.6 10.3c-1.9-.3-3.4 1-3.4 2.9 0 1.2-.6 2-1.6 2.4 2.9 1.2 6.6.4 7.1-3.2z"/>',
  ),
  continent: svg(
    '<path d="M3.2 8.6c.6-2.6 3.2-4.4 5.6-3.5 1.4.5 2.1 1.6 3.8 1.2 2.1-.5 4.4.8 4.2 3.1-.1 1.3-1.2 1.8-.9 3.1.4 1.6-1 3-3 2.6-1.6-.3-2.2-1.5-4-1-1.7.5-3.9.3-4.6-1.4-.6-1.4.5-2.2-.2-3.3-.3-.3-.9-.4-.9-.8z"/>',
  ),
  raise: svg('<path d="M1.8 16.5l5.3-7.6 3 4 2.1-2.6 5.9 6.2z"/><path d="M15 2.8v5.4M12.7 5.1L15 2.8l2.3 2.3"/>'),
  fill: svg(
    '<path d="M9.2 2.6l6.2 6.2-6.1 6.1a1.4 1.4 0 0 1-2 0l-4.2-4.2a1.4 1.4 0 0 1 0-2z"/><path d="M3.4 9.2h11.9"/>' +
      '<path d="M17 12.3s1.6 2 1.6 3.1a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3.1 1.6-3.1z"/>',
  ),
  split: svg(
    '<path d="M4.5 4.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/>' +
      '<path d="M11.6 1.8L8.4 18.2" stroke-dasharray="2.2 2"/>',
  ),
  lasso: svg(
    '<path d="M4.2 11.2C2.6 9.4 3.3 6.4 6.4 4.9c3.2-1.6 8-1.3 9.8 1 1.8 2.3-.1 5.4-4 6.4-2 .5-4.1.4-5.8-.3"/>' +
      '<path d="M6.4 12c-1.6.1-2.3 1.2-1.7 2.2.5.9 1.8.9 1.7 2.2-.1.9-.8 1.4-1.6 1.6"/>',
  ),
  seeds: svg(
    '<path d="M10 10L4.5 5.5M10 10l6-3.5M10 10l-.5 6.5" stroke-dasharray="1.6 1.8" stroke-width="1.2"/>' +
      '<circle cx="4.5" cy="5.5" r="1.9" fill="currentColor" stroke="none"/><circle cx="16" cy="6.5" r="1.9" fill="currentColor" stroke="none"/>' +
      '<circle cx="9.5" cy="16.5" r="1.9" fill="currentColor" stroke="none"/>',
  ),
  motion: svg('<path d="M3 15.5c2.4-5.6 6.4-9 12.8-10.2"/><path d="M11.8 3.6l4.3 1.6-1.8 4.3"/><circle cx="3.4" cy="15.4" r="1.3" fill="currentColor" stroke="none"/>'),
  smooth: svg('<path d="M2.5 12.5l2-3 2 3 2-3 2 3"/><path d="M10.5 12.5c1.5-3 3.5-3 5 0 .6 1.2 1.3 1.7 2 1.5" opacity=".9"/>'),
};

export const ICONS = {
  undo: svg('<path d="M7.2 4.6L3.6 8.2l3.6 3.6"/><path d="M3.9 8.2h8.4a4.3 4.3 0 0 1 0 8.6H9"/>'),
  redo: svg('<path d="M12.8 4.6l3.6 3.6-3.6 3.6"/><path d="M16.1 8.2H7.7a4.3 4.3 0 0 0 0 8.6H11"/>'),
  plus: svg('<path d="M10 4.5v11M4.5 10h11"/>'),
  close: svg('<path d="M5.8 5.8l8.4 8.4M14.2 5.8l-8.4 8.4"/>'),
  dice: svg(
    '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/>' +
      '<circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="13" cy="13" r="1.1" fill="currentColor" stroke="none"/>' +
      '<circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/>',
  ),
  play: svg('<path d="M6.2 4.2l9.4 5.8-9.4 5.8z" fill="currentColor"/>'),
  blank: svg('<circle cx="10" cy="10" r="6.8"/>'),
  random: svg(
    '<circle cx="10" cy="10" r="6.8"/><path d="M5 7.5c2 .8 3 2.6 2.4 4.6M12 4c-.5 2 .5 3.6 2.6 4.2M10.5 16.6c.3-2 2-3.2 4-3"/>',
  ),
  current: svg('<circle cx="10" cy="10" r="6.8"/><path d="M10 6.2V10l2.6 1.6"/>'),
  sparkle: svg('<path d="M10 2.8l1.6 4.6 4.6 1.6-4.6 1.6L10 15.2l-1.6-4.6L3.8 9l4.6-1.6z"/>'),
} as const;

/** Small arrow pointing up (north); rotate by the compass bearing. */
export const BEARING_ARROW =
  '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 1.2l3.2 4.4H7v5.2H5V5.6H2.8z" fill="currentColor"/></svg>';
