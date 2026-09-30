/** Plate list: swatch, editable name, area, speed/direction, delete; motion fields for the selected plate. */
import { RAD } from '../../core/constants';
import type { RGB } from '../../core/types';
import { BEARING_ARROW, ICONS } from './icons';
import { el, hexToRgb, iconEl, rgbCss, rgbToHex } from './dom';

export interface PlateRow {
  id: number;
  name: string;
  color: RGB;
  /** Fraction of the sphere, 0..1. */
  area: number;
  cells: number;
  /** km/Myr at the plate's anchor (null: no cells yet). */
  speed: number | null;
  /** Compass bearing, degrees. */
  bearing: number;
  /** rad/Myr about the anchor. */
  spin: number;
  /** Connected pieces on the map (0 when empty). */
  pieces?: number;
  /** Detached pieces under MIN_FRAGMENT_CELLS (merged into neighbours when simulated). */
  tinyPieces?: number;
}

export interface PlateListActions {
  select(id: number): void;
  remove(id: number): void;
  rename(id: number, name: string): void;
  recolor(id: number, color: RGB): void;
  /** Numeric motion edit: speed cm/yr, bearing degrees, spin degrees/Myr. */
  setMotion(id: number, speedCmYr: number, bearingDeg: number, spinDegMyr: number): void;
}

interface RowEls {
  root: HTMLDivElement;
  swatch: HTMLLabelElement;
  color: HTMLInputElement;
  name: HTMLInputElement;
  badge: HTMLSpanElement;
  area: HTMLSpanElement;
  speed: HTMLSpanElement;
  arrow: HTMLSpanElement;
  speedText: HTMLSpanElement;
  del: HTMLButtonElement;
  detail: HTMLDivElement | null;
  fSpeed: HTMLInputElement | null;
  fDir: HTMLInputElement | null;
  fSpin: HTMLInputElement | null;
}

const fmtArea = (a: number) => (a <= 0 ? 'empty' : a < 0.001 ? '<0.1%' : `${(a * 100).toFixed(1)}%`);

/** Badge text and tooltip for a plate in several pieces. */
export function piecesBadge(pieces: number, tiny: number): { text: string; title: string } | null {
  if (pieces <= 1) return null;
  let title = `This plate is in ${pieces} separate pieces. They keep its colour and move together as one rigid plate when simulated.`;
  if (tiny > 0) title += ` ${tiny === 1 ? 'One small piece' : `${tiny} small pieces`} (under 20 cells) will merge into the surrounding plate${tiny === 1 ? '' : 's'} when simulated.`;
  return { text: `${pieces} pieces`, title };
}

export class PlateListView {
  private rows = new Map<number, RowEls>();
  private order: number[] = [];
  private selected = -1;
  private data = new Map<number, PlateRow>();

  constructor(
    private readonly container: HTMLElement,
    private readonly actions: PlateListActions,
  ) {}

  /** Render rows (keyed by plate id); only changed values are touched so edits in progress survive. */
  update(rows: PlateRow[], selectedId: number, canDelete: boolean): void {
    const ids = rows.map((r) => r.id);
    const structural = ids.length !== this.order.length || ids.some((id, k) => id !== this.order[k]);
    if (structural) {
      for (const [id, r] of this.rows) if (!ids.includes(id)) r.root.remove();
      for (const id of [...this.rows.keys()]) if (!ids.includes(id)) this.rows.delete(id);
      for (const r of rows) if (!this.rows.has(r.id)) this.rows.set(r.id, this.buildRow(r.id));
      this.container.replaceChildren(...rows.map((r) => (this.rows.get(r.id) as RowEls).root));
      this.order = ids;
    }
    this.data = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) this.patchRow(this.rows.get(r.id) as RowEls, r, r.id === selectedId, canDelete);
    // Reveal after patching: the selected row has just grown its detail fields.
    if (selectedId !== this.selected || structural) {
      this.selected = selectedId;
      const row = this.rows.get(selectedId)?.root;
      if (row) this.revealRow(row);
    }
  }

  /** Scroll only the list (not the panel) so the row is visible. */
  private revealRow(row: HTMLElement): void {
    const list = this.container; // position: relative, so row.offsetTop is list-relative
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  private buildRow(id: number): RowEls {
    const root = el('div', 'pe-plate', { role: 'option', 'data-id': id });
    const color = el('input', null, { type: 'color', title: 'Plate color', 'aria-label': 'Plate color' });
    const swatch = el('label', 'pe-swatch', null, color);
    const name = el('input', 'pe-name', { type: 'text', maxlength: 48, spellcheck: 'false', 'aria-label': 'Plate name' });
    const badge = el('span', 'pe-badge');
    badge.hidden = true;
    const nameWrap = el('div', 'pe-name-wrap', null, name, badge);
    const area = el('span', 'pe-area', { title: 'Share of the planet surface' });
    const arrow = el('span', null, null);
    arrow.innerHTML = BEARING_ARROW;
    arrow.style.display = 'inline-flex';
    const speedText = el('span');
    const speed = el('span', 'pe-speed', { title: 'Speed and direction at the plate centre' }, arrow, speedText);
    const del = el('button', 'pe-del', { type: 'button', title: 'Delete plate (merges into its largest neighbour)', 'aria-label': 'Delete plate' });
    del.append(iconEl(ICONS.close));
    root.append(swatch, nameWrap, area, speed, del);

    root.addEventListener('pointerdown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target !== name) return;
      if (this.selected !== id) this.actions.select(id);
    });
    color.addEventListener('input', () => {
      const c = hexToRgb(color.value);
      if (c) swatch.style.background = rgbCss(c);
    });
    color.addEventListener('change', () => {
      const c = hexToRgb(color.value);
      if (c) this.actions.recolor(id, c);
    });
    const commitName = () => {
      const cur = this.data.get(id);
      if (cur && name.value.trim() && name.value.trim() !== cur.name) this.actions.rename(id, name.value);
      else if (cur) name.value = cur.name;
    };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        const cur = this.data.get(id);
        if (cur) name.value = cur.name;
        name.blur();
      }
      e.stopPropagation();
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.remove(id);
    });
    return { root, swatch, color, name, badge, area, speed, arrow, speedText, del, detail: null, fSpeed: null, fDir: null, fSpin: null };
  }

  private patchRow(r: RowEls, d: PlateRow, selected: boolean, canDelete: boolean): void {
    r.root.classList.toggle('pe-sel', selected);
    r.root.setAttribute('aria-selected', String(selected));
    const css = rgbCss(d.color);
    if (r.swatch.style.background !== css) r.swatch.style.background = css;
    const hex = rgbToHex(d.color);
    if (r.color.value !== hex) r.color.value = hex;
    if (document.activeElement !== r.name && r.name.value !== d.name) r.name.value = d.name;
    r.name.title = d.name;
    setText(r.area, fmtArea(d.area));
    r.root.classList.toggle('pe-empty', d.cells === 0);
    r.area.title = d.cells === 0 ? 'No cells on the map: paint it back, or delete it' : 'Share of the planet surface';
    const badge = piecesBadge(d.pieces ?? 1, d.tinyPieces ?? 0);
    r.badge.hidden = !badge;
    if (badge) {
      setText(r.badge, badge.text);
      r.badge.title = badge.title;
    }
    if (d.speed === null) {
      setText(r.speedText, '—');
      r.arrow.style.visibility = 'hidden';
      r.speed.title = 'Not on the map';
    } else {
      setText(r.speedText, `${(d.speed / 10).toFixed(1)} cm/yr`);
      r.arrow.style.visibility = d.speed > 0.05 ? 'visible' : 'hidden';
      r.arrow.style.transform = `rotate(${d.bearing.toFixed(0)}deg)`;
      r.speed.title = `${(d.speed / 10).toFixed(1)} cm/yr toward ${Math.round(d.bearing)}°, spin ${(d.spin * RAD).toFixed(2)}°/Myr`;
    }
    r.del.disabled = !canDelete;
    if (selected) this.ensureDetail(r, d);
    else if (r.detail) {
      r.detail.remove();
      r.detail = r.fSpeed = r.fDir = r.fSpin = null;
    }
  }

  private ensureDetail(r: RowEls, d: PlateRow): void {
    const id = d.id;
    const wantEmpty = d.speed === null;
    const isEmpty = r.detail?.classList.contains('pe-empty-note') ?? false;
    if (r.detail && wantEmpty !== isEmpty) {
      r.detail.remove();
      r.detail = r.fSpeed = r.fDir = r.fSpin = null;
    }
    if (!r.detail) {
      if (wantEmpty) {
        r.detail = el('div', 'pe-empty-note', null, 'Not on the map — paint it with the plate brush (B), Fill (F) or Lasso (L), or delete it.');
      } else {
        const mk = (label: string, title: string, step: string, min?: string, max?: string) => {
          const input = el('input', null, { type: 'number', step, min, max, title, 'aria-label': title });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            e.stopPropagation();
          });
          input.addEventListener('change', () => this.commitMotion(id));
          return { wrap: el('label', 'pe-field', null, label, input), input };
        };
        const s = mk('cm/yr', 'Speed at the plate centre, cm/yr', '0.1', '0', '15');
        const b = mk('Heading °', 'Direction of motion, compass degrees (0 = north, 90 = east)', '1', '0', '359');
        const w = mk('Spin °/Myr', 'Rotation about the plate centre, degrees per Myr (positive = counter-clockwise)', '0.01');
        r.detail = el('div', 'pe-detail', null, s.wrap, b.wrap, w.wrap);
        r.fSpeed = s.input;
        r.fDir = b.input;
        r.fSpin = w.input;
      }
      r.root.append(r.detail);
    }
    if (r.fSpeed && r.fDir && r.fSpin && d.speed !== null) {
      setValue(r.fSpeed, (d.speed / 10).toFixed(1));
      setValue(r.fDir, String(Math.round(d.bearing) % 360));
      setValue(r.fSpin, (d.spin * RAD).toFixed(2));
    }
  }

  private commitMotion(id: number): void {
    const r = this.rows.get(id);
    if (!r || !r.fSpeed || !r.fDir || !r.fSpin) return;
    const s = parseFloat(r.fSpeed.value), b = parseFloat(r.fDir.value), w = parseFloat(r.fSpin.value);
    if (![s, b, w].every(Number.isFinite)) return;
    this.actions.setMotion(id, Math.max(0, Math.min(15, s)), ((b % 360) + 360) % 360, w);
  }
}

function setText(e: HTMLElement, t: string): void {
  if (e.textContent !== t) e.textContent = t;
}

function setValue(e: HTMLInputElement, v: string): void {
  if (document.activeElement !== e && e.value !== v) e.value = v;
}
