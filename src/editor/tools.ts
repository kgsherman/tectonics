/** Editor tool catalogue and small pure UI helpers (keyboard map, brush-size slider mapping). */
import { BRUSH_MAX_KM, BRUSH_MIN_KM } from './editorConstants';

export type ToolId = 'select' | 'plate' | 'continent' | 'raise' | 'fill' | 'split' | 'lasso' | 'seeds' | 'motion' | 'smooth';

export interface ToolInfo {
  id: ToolId;
  label: string;
  /** Keyboard shortcut (single letter, upper case). */
  key: string;
  /** One-line usage hint shown under the tool options. */
  hint: string;
  /** Uses the brush radius (shows the brush cursor and size slider). */
  brush: boolean;
  /** Left-drag edits (view in 'paint' mode) rather than navigating. */
  paint: boolean;
}

export const TOOLS: readonly ToolInfo[] = [
  { id: 'select', label: 'Select', key: 'A', hint: 'Click a plate to select it. Drag to rotate the view.', brush: false, paint: false },
  { id: 'plate', label: 'Plate brush', key: 'B', hint: 'Paint the selected plate. Ctrl+click picks a plate.', brush: true, paint: true },
  { id: 'continent', label: 'Continent', key: 'C', hint: 'Paint land (shelf included). Shift paints ocean, X swaps.', brush: true, paint: true },
  { id: 'raise', label: 'Raise / Lower', key: 'R', hint: 'Sculpt elevation. Shift lowers.', brush: true, paint: true },
  { id: 'fill', label: 'Fill', key: 'F', hint: 'Click a region to give it to the selected plate.', brush: false, paint: true },
  { id: 'split', label: 'Split', key: 'S', hint: 'Drag a line on a plate (it continues to the plate\'s edges) to cut it in two.', brush: false, paint: true },
  { id: 'lasso', label: 'Lasso', key: 'L', hint: 'Draw a loop around a region to make it a plate.', brush: false, paint: true },
  { id: 'seeds', label: 'Seeds', key: 'D', hint: 'Click to place seeds, drag to move, Shift+click removes. Enter generates.', brush: false, paint: true },
  { id: 'motion', label: 'Motion', key: 'V', hint: 'Drag from a plate (or its arrow tip) to set its velocity. Shift snaps to 15°.', brush: false, paint: true },
  { id: 'smooth', label: 'Smooth', key: 'O', hint: 'Brush over jagged plate boundaries to straighten them.', brush: true, paint: true },
];

export function toolInfo(id: ToolId): ToolInfo {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tool '${id}'`);
  return t;
}

/** Tool for a key press (case-insensitive), or null. */
export function toolForKey(key: string): ToolId | null {
  const k = key.toUpperCase();
  return TOOLS.find((t) => t.key === k)?.id ?? null;
}

const SLIDER_STEPS = 1000;

/** Logarithmic brush slider: position 0..SLIDER_STEPS → km. */
export function sliderToKm(v: number): number {
  const t = Math.max(0, Math.min(1, v / SLIDER_STEPS));
  return roundKm(BRUSH_MIN_KM * Math.pow(BRUSH_MAX_KM / BRUSH_MIN_KM, t));
}

export function kmToSlider(km: number): number {
  const k = Math.max(BRUSH_MIN_KM, Math.min(BRUSH_MAX_KM, km));
  return Math.round((SLIDER_STEPS * Math.log(k / BRUSH_MIN_KM)) / Math.log(BRUSH_MAX_KM / BRUSH_MIN_KM));
}

export const BRUSH_SLIDER_MAX = SLIDER_STEPS;

/** Brush size after pressing [ (dir −1) or ] (dir +1): ×/÷ 1.25, rounded, clamped. */
export function stepBrushKm(km: number, dir: 1 | -1): number {
  const next = dir > 0 ? km * 1.25 : km / 1.25;
  return roundKm(Math.max(BRUSH_MIN_KM, Math.min(BRUSH_MAX_KM, next)));
}

/** Nice rounding: 10 km below 1000 km, 50 km above. */
export function roundKm(km: number): number {
  const q = km < 1000 ? 10 : 50;
  return Math.max(BRUSH_MIN_KM, Math.min(BRUSH_MAX_KM, Math.round(km / q) * q));
}

/** What a key press does in the editor (null: not an editor shortcut). */
export type KeyAction =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'brush'; dir: 1 | -1 }
  | { kind: 'cancel' }
  | { kind: 'generateSeeds' }
  | { kind: 'toggleContinent' }
  | { kind: 'tool'; tool: ToolId };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Editor keyboard map: tool letters, [ / ] brush size, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and
 * Ctrl+Y redo, Escape cancels a drag, Enter generates seed plates, X swaps land/ocean.
 */
export function keyAction(e: KeyInput, ctx: { tool: ToolId; busy: boolean }): KeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && (k === 'z' || k === 'Z')) return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  if (mod && (k === 'y' || k === 'Y')) return { kind: 'redo' };
  if (mod || e.altKey) return null;
  if (k === '[' || k === ']') return { kind: 'brush', dir: k === ']' ? 1 : -1 };
  if (k === 'Escape') return ctx.busy ? { kind: 'cancel' } : null;
  if (k === 'Enter') return ctx.tool === 'seeds' ? { kind: 'generateSeeds' } : null;
  if ((k === 'x' || k === 'X') && ctx.tool === 'continent') return { kind: 'toggleContinent' };
  const t = k.length === 1 ? toolForKey(k) : null;
  return t ? { kind: 'tool', tool: t } : null;
}
