/** The plate editor's side panel: start options, tool palette + options, plate list, apply. */
import type { RGB } from '../../core/types';
import { BRUSH_MAX_KM, BRUSH_MIN_KM, RAISE_MAX_M, RAISE_MIN_M } from '../editorConstants';
import type { PreviewStyle } from '../preview';
import { PREVIEW_BOUNDARY_COLORS } from '../preview';
import type { ToolId } from '../tools';
import { BRUSH_SLIDER_MAX, kmToSlider, sliderToKm, TOOLS, toolInfo } from '../tools';
import { ICONS, TOOL_ICONS } from './icons';
import { button, el, iconEl, rgbCss, segmented } from './dom';
import type { PlateListActions, PlateRow } from './plateList';
import { PlateListView } from './plateList';
import { injectEditorStyles } from './styles';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM } from '../../core/types';

export type StartSource = 'blank' | 'random' | 'current';

export interface PanelState {
  tool: ToolId;
  brushKm: number;
  /** Smallest meaningful brush (one mesh spacing), km. */
  minBrushKm: number;
  continentMode: 'land' | 'ocean';
  raiseMode: 'raise' | 'lower';
  raiseAmount: number;
  lassoTarget: 'new' | 'selected';
  seedRoughness: number;
  seedCount: number;
  cap: number;
  plateCount: number;
  selected: { name: string; color: RGB } | null;
  style: PreviewStyle;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Context-aware usage hint for the current tool (defaults to the tool's static hint). */
  hint?: string;
  /** The hint is a warning (e.g. the tool cannot act at the plate cap). */
  hintWarn?: boolean;
  /** Plates without cells (offer a clean-up). */
  emptyPlates?: number;
  /** "Start drawing" checklist (null: hidden). */
  guide?: { continents: boolean; plates: boolean; motions: boolean } | null;
}

export interface PanelActions extends PlateListActions {
  tool(id: ToolId): void;
  brushKm(km: number): void;
  continentMode(m: 'land' | 'ocean'): void;
  raiseMode(m: 'raise' | 'lower'): void;
  raiseAmount(m: number): void;
  lassoTarget(t: 'new' | 'selected'): void;
  seedRoughness(v: number): void;
  seedsGenerate(): void;
  seedsClear(): void;
  smoothAll(): void;
  randomizeMotions(): void;
  addPlate(): void;
  undo(): void;
  redo(): void;
  start(src: StartSource): void;
  style(s: PreviewStyle): void;
  apply(): void;
  /** Hide the "Start drawing" checklist. */
  dismissGuide?(): void;
  /** Delete every plate without cells. */
  removeEmpty?(): void;
}

export type StatusKind = 'info' | 'ok' | 'warn' | 'error';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export class EditorPanel {
  readonly root: HTMLDivElement;
  readonly plates: PlateListView;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly startButtons: HTMLButtonElement[] = [];
  private readonly optName: HTMLSpanElement;
  private readonly optKey: HTMLElement;
  private readonly optHint: HTMLDivElement;
  private readonly rows: Record<string, HTMLElement> = {};
  private readonly brushRange: HTMLInputElement;
  private readonly brushValue: HTMLSpanElement;
  private readonly raiseRange: HTMLInputElement;
  private readonly raiseValue: HTMLSpanElement;
  private readonly roughRange: HTMLInputElement;
  private readonly roughValue: HTMLSpanElement;
  private readonly seedInfo: HTMLSpanElement;
  private readonly seedGenerate: HTMLButtonElement;
  private readonly seedClear: HTMLButtonElement;
  private readonly targetDot: HTMLSpanElement;
  private readonly targetName: HTMLSpanElement;
  private readonly setContinent: (v: 'land' | 'ocean') => void;
  private readonly setRaise: (v: 'raise' | 'lower') => void;
  private readonly setLasso: (v: 'new' | 'selected') => void;
  private readonly lassoButtons: Map<'new' | 'selected', HTMLButtonElement>;
  private readonly guideEl: HTMLDivElement;
  private readonly guideSteps: HTMLLIElement[] = [];
  private readonly keysEl: HTMLDivElement;
  private readonly keysBtn: HTMLButtonElement;
  private readonly emptyBtn: HTMLButtonElement;
  private readonly setStyle: (v: PreviewStyle) => void;
  private readonly countEl: HTMLSpanElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly statusEl: HTMLDivElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly busyText: HTMLDivElement;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private message: { text: string; kind: StatusKind } | null = null;
  private hover: string | null = null;
  private lastTool: ToolId | null = null;
  private lastLassoTarget: 'new' | 'selected' | null = null;

  constructor(host: HTMLElement, actions: PanelActions) {
    injectEditorStyles(host.ownerDocument);
    const root = el('div', 'pe-root');
    this.root = root;

    // Header: title + undo/redo.
    this.undoBtn = button('pe-btn pe-icon-btn', `Undo (${MOD}+Z)`, ICONS.undo);
    this.redoBtn = button('pe-btn pe-icon-btn', `Redo (${MOD}+Shift+Z)`, ICONS.redo);
    this.undoBtn.addEventListener('click', () => actions.undo());
    this.redoBtn.addEventListener('click', () => actions.redo());
    this.keysBtn = button('pe-btn pe-icon-btn', 'Keyboard shortcuts', KEYBOARD_ICON);
    this.keysEl = buildKeysSheet();
    this.keysEl.hidden = true;
    this.keysBtn.addEventListener('click', () => {
      this.keysEl.hidden = !this.keysEl.hidden;
      this.keysBtn.classList.toggle('pe-active', !this.keysEl.hidden);
      this.keysBtn.setAttribute('aria-expanded', String(!this.keysEl.hidden));
    });
    const head = el(
      'div', 'pe-head', null,
      el('div', 'pe-title', null, 'Plate editor', el('small', null, null, 'Sketch a world, then simulate it')),
      el('div', 'pe-btn-group', null, this.keysBtn, this.undoBtn, this.redoBtn),
    );

    // "Start drawing" checklist (blank / simple worlds).
    const step = (label: string, tool: ToolId, rest: string) => {
      const link = el('button', 'pe-link', { type: 'button' }, label);
      link.addEventListener('click', () => actions.tool(tool));
      const li = el('li', null, null, el('span', null, null, link, rest));
      this.guideSteps.push(li);
      return li;
    };
    const guideClose = button('pe-guide-close', 'Hide these tips', ICONS.close);
    guideClose.addEventListener('click', () => actions.dismissGuide?.());
    const seedsLink = el('button', 'pe-link', { type: 'button' }, 'place seeds');
    seedsLink.addEventListener('click', () => actions.tool('seeds'));
    // Created in display order: guideSteps[0..2] = continents, plates, motions (see update()).
    const continentStep = step('Paint continents', 'continent', ' (C) — land gets shelves and relief');
    const cutStep = step('Cut it into plates', 'split', ' (S), or ');
    cutStep.querySelector('span')?.append(seedsLink, ' (D)');
    const motionStep = step('Set how plates move', 'motion', ' (V) — drag the arrows');
    this.guideEl = el('div', 'pe-guide', { role: 'note' },
      guideClose,
      el('div', 'pe-guide-title', null, 'Draw your own world'),
      el('div', 'pe-guide-sub', null, 'Your planet starts as one ocean plate. From here:'),
      el('ol', null, null,
        continentStep,
        cutStep,
        motionStep,
        el('li', null, null, el('span', null, null, 'Press ', el('b', null, null, 'Simulate this world'), ' below')),
      ));
    this.guideEl.hidden = true;

    // Start from.
    const start = el('div', 'pe-seg');
    const starts: Array<[StartSource, string, string, string]> = [
      ['blank', 'Blank', 'Start over with one ocean plate', ICONS.blank],
      ['random', 'Random', 'Generate a random world to edit', ICONS.random],
      ['current', 'Current', 'Edit the running simulation', ICONS.current],
    ];
    for (const [src, label, title, svg] of starts) {
      const b = el('button', null, { type: 'button', title });
      b.append(iconEl(svg), el('span', null, null, label));
      b.addEventListener('click', () => actions.start(src));
      this.startButtons.push(b);
      start.append(b);
    }
    const startSec = el('div', 'pe-section', null, el('div', 'pe-label', null, 'Start from'), start);

    // Tools.
    const grid = el('div', 'pe-toolgrid', { role: 'toolbar', 'aria-label': 'Editor tools' });
    for (const t of TOOLS) {
      const b = el('button', 'pe-tool', { type: 'button', title: `${t.label} (${t.key})`, 'aria-label': t.label, 'aria-pressed': 'false' });
      b.append(iconEl(TOOL_ICONS[t.id]), el('span', 'pe-key', null, t.key));
      b.addEventListener('click', () => actions.tool(t.id));
      this.toolButtons.set(t.id, b);
      grid.append(b);
    }

    // Tool options (all rows built once, shown per tool).
    this.optName = el('span');
    this.optKey = el('kbd');
    this.optHint = el('div', 'pe-hint');

    this.brushRange = el('input', 'pe-range', { type: 'range', min: 0, max: BRUSH_SLIDER_MAX, step: 1, 'aria-label': 'Brush size' });
    this.brushValue = el('span', 'pe-value');
    this.brushRange.addEventListener('input', () => actions.brushKm(sliderToKm(+this.brushRange.value)));
    this.rows.brush = el('div', 'pe-row', { title: `Brush radius (${BRUSH_MIN_KM}–${BRUSH_MAX_KM} km). Keys [ and ]` },
      el('span', 'pe-row-label', null, 'Size'), el('div', 'pe-grow', null, this.brushRange), this.brushValue);

    this.targetDot = el('span', 'pe-dot');
    this.targetName = el('span');
    this.rows.target = el('div', 'pe-row', null, el('span', 'pe-row-label', null, 'Plate'),
      el('div', 'pe-target pe-grow', null, this.targetDot, this.targetName));

    const cont = segmented<'land' | 'ocean'>(
      [{ value: 'land', label: 'Land', title: 'Paint continental crust (X toggles, Shift inverts)' },
        { value: 'ocean', label: 'Ocean', title: 'Paint ocean floor (X toggles, Shift inverts)' }],
      (v) => actions.continentMode(v),
    );
    this.setContinent = cont.set;
    this.rows.continent = el('div', 'pe-row', null, el('span', 'pe-row-label', null, 'Paint'), el('div', 'pe-grow', null, cont.root));

    const raise = segmented<'raise' | 'lower'>(
      [{ value: 'raise', label: 'Raise', title: 'Raise terrain (Shift inverts)' }, { value: 'lower', label: 'Lower', title: 'Lower terrain (Shift inverts)' }],
      (v) => actions.raiseMode(v),
    );
    this.setRaise = raise.set;
    this.rows.raiseMode = el('div', 'pe-row', null, el('span', 'pe-row-label', null, 'Mode'), el('div', 'pe-grow', null, raise.root));
    this.raiseRange = el('input', 'pe-range', { type: 'range', min: RAISE_MIN_M, max: RAISE_MAX_M, step: 10, 'aria-label': 'Strength' });
    this.raiseValue = el('span', 'pe-value');
    this.raiseRange.addEventListener('input', () => actions.raiseAmount(+this.raiseRange.value));
    this.rows.raiseAmount = el('div', 'pe-row', { title: 'Elevation change per dab at the brush centre' },
      el('span', 'pe-row-label', null, 'Strength'), el('div', 'pe-grow', null, this.raiseRange), this.raiseValue);

    const lasso = segmented<'new' | 'selected'>(
      [{ value: 'new', label: 'New plate' }, { value: 'selected', label: 'Selected plate' }],
      (v) => actions.lassoTarget(v),
    );
    this.setLasso = lasso.set;
    this.lassoButtons = lasso.buttons;
    this.rows.lasso = el('div', 'pe-row', null, el('span', 'pe-row-label', null, 'Into'), el('div', 'pe-grow', null, lasso.root));

    this.roughRange = el('input', 'pe-range', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Boundary roughness' });
    this.roughValue = el('span', 'pe-value');
    this.roughRange.addEventListener('input', () => actions.seedRoughness(+this.roughRange.value / 100));
    this.rows.rough = el('div', 'pe-row', { title: 'How irregular the generated plate boundaries are' },
      el('span', 'pe-row-label', null, 'Rough'), el('div', 'pe-grow', null, this.roughRange), this.roughValue);
    this.seedInfo = el('span', 'pe-hint pe-num');
    this.seedGenerate = button('pe-btn', 'Replace all plates with Voronoi regions around the seeds (Enter)', ICONS.sparkle, 'Generate');
    this.seedClear = button('pe-btn', 'Remove all seeds', null, 'Clear');
    this.seedGenerate.addEventListener('click', () => actions.seedsGenerate());
    this.seedClear.addEventListener('click', () => actions.seedsClear());
    this.rows.seeds = el('div', 'pe-row', null, el('div', 'pe-grow', null, this.seedInfo), this.seedClear, this.seedGenerate);

    const rnd = button('pe-btn', 'Give every plate a new random motion', ICONS.dice, 'Randomize motions');
    rnd.addEventListener('click', () => actions.randomizeMotions());
    this.rows.motion = el('div', 'pe-row', null, rnd);
    const smoothAll = button('pe-btn', 'Straighten every plate boundary', null, 'Smooth all boundaries');
    smoothAll.addEventListener('click', () => actions.smoothAll());
    this.rows.smooth = el('div', 'pe-row', null, smoothAll);

    const opts = el('div', 'pe-toolopts', null,
      el('div', 'pe-toolname', null, this.optName, this.optKey),
      this.rows.target, this.rows.brush, this.rows.continent, this.rows.raiseMode, this.rows.raiseAmount,
      this.rows.lasso, this.rows.rough, this.rows.seeds, this.rows.motion, this.rows.smooth, this.optHint);
    const toolSec = el('div', 'pe-section', null, el('div', 'pe-label', null, 'Tools'), grid, opts);

    // Plates.
    this.countEl = el('span', 'pe-count');
    this.addBtn = button('pe-btn pe-icon-btn', 'Add a plate (then paint it)', ICONS.plus);
    this.addBtn.addEventListener('click', () => actions.addPlate());
    this.emptyBtn = button('pe-btn pe-small', 'Delete every plate that has no cells on the map', null, 'Remove empty');
    this.emptyBtn.addEventListener('click', () => actions.removeEmpty?.());
    this.emptyBtn.hidden = true;
    const rndSmall = button('pe-btn pe-icon-btn', 'Randomize all motions', ICONS.dice);
    rndSmall.addEventListener('click', () => actions.randomizeMotions());
    const list = el('div', 'pe-list', { role: 'listbox', 'aria-label': 'Plates' });
    this.plates = new PlateListView(list, actions);
    const platesSec = el('div', 'pe-plates', null,
      el('div', 'pe-plates-head', null, el('div', 'pe-label', null, 'Plates', this.countEl), el('div', 'pe-btn-group', null, this.emptyBtn, rndSmall, this.addBtn)),
      list);

    // Footer.
    this.statusEl = el('div', 'pe-status', { role: 'status', 'aria-live': 'polite' });
    const legend = el('div', 'pe-legend', null,
      legendItem(PREVIEW_BOUNDARY_COLORS[BOUNDARY_CONVERGENT], 'Convergent'),
      legendItem(PREVIEW_BOUNDARY_COLORS[BOUNDARY_DIVERGENT], 'Divergent'),
      legendItem(PREVIEW_BOUNDARY_COLORS[BOUNDARY_TRANSFORM], 'Transform'));
    const style = segmented<PreviewStyle>(
      [{ value: 'plates', label: 'Plates', title: 'Colour by plate' }, { value: 'relief', label: 'Relief', title: 'Colour by elevation' }],
      (v) => actions.style(v),
    );
    this.setStyle = style.set;
    this.applyBtn = el('button', 'pe-primary', { type: 'button', title: 'Finalize this draft and run the tectonic simulation' });
    this.applyBtn.append(iconEl(ICONS.play), el('span', null, null, 'Simulate this world'));
    this.applyBtn.addEventListener('click', () => actions.apply());
    const foot = el('div', 'pe-foot', null, this.statusEl, el('div', 'pe-foot-row', null, legend, style.root), this.applyBtn);

    this.busyText = el('div');
    const busy = el('div', 'pe-busy', { 'aria-live': 'polite' }, el('div', 'pe-spinner'), this.busyText);

    const scroll = el('div', 'pe-scroll', null, head, this.keysEl, this.guideEl, startSec, toolSec, platesSec);
    root.append(scroll, foot, busy);
    host.append(root);
    this.renderStatus();
  }

  update(s: PanelState): void {
    for (const [id, b] of this.toolButtons) {
      b.classList.toggle('pe-on', id === s.tool);
      b.setAttribute('aria-pressed', String(id === s.tool));
    }
    const info = toolInfo(s.tool);
    const hint = s.hint ?? info.hint;
    if (this.optHint.textContent !== hint) this.optHint.textContent = hint;
    this.optHint.classList.toggle('pe-warn-text', !!s.hintWarn);
    const atCap = s.plateCount >= s.cap;
    for (const id of ['split', 'lasso'] as const) {
      const b = this.toolButtons.get(id);
      if (!b) continue;
      const capped = atCap && (id === 'split' || s.lassoTarget === 'new');
      b.classList.toggle('pe-capped', capped);
      const t = toolInfo(id);
      b.title = capped ? `${t.label} (${t.key}) — plate limit reached (${s.cap})` : `${t.label} (${t.key})`;
    }
    const lassoNew = this.lassoButtons.get('new');
    if (lassoNew) {
      lassoNew.disabled = atCap;
      lassoNew.title = atCap ? `Plate limit reached (${s.cap})` : 'The lassoed region becomes a new plate';
    }
    const empties = s.emptyPlates ?? 0;
    this.emptyBtn.hidden = empties === 0;
    if (empties > 0) {
      const label = this.emptyBtn.querySelector('span');
      const txt = `Remove ${empties} empty`;
      if (label && label.textContent !== txt) label.textContent = txt;
    }
    const g = s.guide ?? null;
    this.guideEl.hidden = !g;
    if (g) {
      this.guideSteps[0]?.classList.toggle('pe-done', g.continents);
      this.guideSteps[1]?.classList.toggle('pe-done', g.plates);
      this.guideSteps[2]?.classList.toggle('pe-done', g.motions);
    }
    if (this.lastTool !== s.tool || this.lastLassoTarget !== s.lassoTarget) {
      this.lastTool = s.tool;
      this.lastLassoTarget = s.lassoTarget;
      this.optName.textContent = info.label;
      this.optKey.textContent = info.key;
      const show: Record<string, boolean> = {
        brush: info.brush,
        target: s.tool === 'plate' || s.tool === 'fill' || (s.tool === 'lasso' && s.lassoTarget === 'selected'),
        continent: s.tool === 'continent',
        raiseMode: s.tool === 'raise',
        raiseAmount: s.tool === 'raise',
        lasso: s.tool === 'lasso',
        rough: s.tool === 'seeds',
        seeds: s.tool === 'seeds',
        motion: s.tool === 'motion',
        smooth: s.tool === 'smooth',
      };
      for (const [k, row] of Object.entries(this.rows)) row.hidden = !show[k];
    }
    const km = Math.max(s.brushKm, s.minBrushKm);
    if (document.activeElement !== this.brushRange) this.brushRange.value = String(kmToSlider(s.brushKm));
    this.brushValue.textContent = `${Math.round(km).toLocaleString('en-US')} km`;
    this.setContinent(s.continentMode);
    this.setRaise(s.raiseMode);
    this.raiseRange.value = String(s.raiseAmount);
    this.raiseValue.textContent = `${s.raiseMode === 'raise' ? '+' : '−'}${s.raiseAmount} m`;
    this.setLasso(s.lassoTarget);
    this.roughRange.value = String(Math.round(s.seedRoughness * 100));
    this.roughValue.textContent = `${Math.round(s.seedRoughness * 100)}%`;
    this.seedInfo.textContent = `${s.seedCount} / ${s.cap} seeds`;
    this.seedGenerate.disabled = s.seedCount === 0;
    this.seedClear.disabled = s.seedCount === 0;
    if (s.selected) {
      this.targetDot.style.background = rgbCss(s.selected.color);
      this.targetName.textContent = s.selected.name;
    } else {
      this.targetDot.style.background = 'transparent';
      this.targetName.textContent = 'None selected';
    }
    this.setStyle(s.style);
    this.undoBtn.disabled = !s.canUndo;
    this.redoBtn.disabled = !s.canRedo;
    this.undoBtn.title = s.undoLabel ? `Undo ${s.undoLabel} (${MOD}+Z)` : `Undo (${MOD}+Z)`;
    this.redoBtn.title = s.redoLabel ? `Redo ${s.redoLabel} (${MOD}+Shift+Z)` : `Redo (${MOD}+Shift+Z)`;
    this.countEl.textContent = `${s.plateCount} / ${s.cap}`;
    this.countEl.classList.toggle('pe-full', s.plateCount >= s.cap);
    this.addBtn.disabled = s.plateCount >= s.cap;
    this.addBtn.title = s.plateCount >= s.cap ? `Plate limit reached (${s.cap})` : 'Add a plate (then paint it)';
  }

  updatePlates(rows: PlateRow[], selectedId: number): void {
    this.plates.update(rows, selectedId, rows.length > 1);
  }

  /** Transient message (operation results); falls back to hover info after a few seconds. */
  setStatus(text: string, kind: StatusKind = 'info', ms = 4500): void {
    this.message = { text, kind };
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.message = null;
      this.statusTimer = null;
      this.renderStatus();
    }, ms);
    this.renderStatus();
  }

  setHover(text: string | null): void {
    if (text === this.hover) return;
    this.hover = text;
    this.renderStatus();
  }

  private renderStatus(): void {
    const m = this.message;
    const text = m ? m.text : (this.hover ?? 'Hover the planet to inspect it.');
    const kind = m ? m.kind : 'info';
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
    this.statusEl.className = `pe-status${kind === 'info' ? '' : ` pe-${kind}`}`;
  }

  /** Busy overlay (e.g. while a draft is generated); null hides it. */
  setBusy(text: string | null): void {
    this.root.classList.toggle('pe-is-busy', text !== null);
    this.busyText.textContent = text ?? '';
    for (const b of this.startButtons) b.disabled = text !== null;
  }

  setApplyBusy(busy: boolean): void {
    this.applyBtn.disabled = busy;
    const label = this.applyBtn.querySelector('span:last-child');
    if (label) label.textContent = busy ? 'Preparing world…' : 'Simulate this world';
  }

  dispose(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.root.remove();
  }
}

function legendItem(c: RGB, label: string): HTMLSpanElement {
  const i = el('i');
  i.style.background = rgbCss(c);
  return el('span', null, null, i, label);
}

const KEYBOARD_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
  '<rect x="2.2" y="5" width="15.6" height="10" rx="2"/><path d="M5.2 8.2h.01M8.1 8.2h.01M11 8.2h.01M14 8.2h.01M5.2 11.6h.01M14.8 11.6h.01M7.6 11.6h4.8"/></svg>';

/** Static keyboard / mouse reference. */
function buildKeysSheet(): HTMLDivElement {
  const rows: Array<[string, string] | string> = [
    'Tools',
    ...TOOLS.map((t): [string, string] => [t.key, t.label]),
    'Brushes',
    ['[ ]', 'Smaller / larger brush'],
    ['Shift', 'Invert: paint ocean, lower terrain'],
    ['X', 'Swap land / ocean (Continent)'],
    [`${MOD}+click`, 'Pick the plate under the cursor'],
    'Motion & seeds',
    ['Drag', 'An arrow, or anywhere on a plate'],
    ['Shift+drag', 'Snap to 15° and 0.5 cm/yr'],
    ['Shift+click', 'Remove a seed'],
    ['Enter', 'Generate plates from seeds'],
    'Everywhere',
    [`${MOD}+Z`, 'Undo'],
    [`${MOD}+Shift+Z`, 'Redo'],
    ['Esc', 'Cancel the current drag'],
    ['Right-drag', 'Move the view (also Space/Alt+drag)'],
  ];
  const root = el('div', 'pe-keys', { role: 'region', 'aria-label': 'Keyboard shortcuts' });
  for (const r of rows) {
    if (typeof r === 'string') root.append(el('div', 'pe-keys-h', null, r));
    else root.append(el('kbd', null, null, r[0]), el('span', null, null, r[1]));
  }
  return root;
}
