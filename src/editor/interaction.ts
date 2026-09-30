/**
 * Pointer interaction for the plate editor: turns WorldView pointer events into EditorCore
 * operations for the active tool (strokes, paths, clicks, seed and motion drags), and gives
 * feedback while hovering (cursor shape, grabbable arrow / seed highlight, live readouts).
 */
import { DEG, EARTH_RADIUS_KM, RAD } from '../core/constants';
import { angleBetween, latLonToVec, vecToLatLon } from '../core/math3';
import type { BrushCursor, RGB, Vec3, WorldPointerEvent, WorldView } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import type { EditorCore, OpResult, StrokeTool } from './editorCore';
import type { ArrowHandle } from './motion';
import {
  arrowHead, dragMotion, formatMotion, hitArrow, leverHead, motionAt, motionFromArrow, omegaFromMotion, rotateFromTo,
} from './motion';
import { extendCut, pathCells } from './paths';
import { slerp } from './stroke';
import type { PreviewStyle } from './preview';
import type { ToolId } from './tools';
import { toolInfo } from './tools';

export interface ToolSettings {
  tool: ToolId;
  brushKm: number;
  continentMode: 'land' | 'ocean';
  raiseMode: 'raise' | 'lower';
  raiseAmount: number;
  lassoTarget: 'new' | 'selected';
  seedRoughness: number;
  style: PreviewStyle;
}

/** Live readout of a motion drag (shown next to the arrow head and in the status line). */
export interface MotionReadout {
  plate: number;
  /** Where the arrow now ends. */
  head: Vec3;
  /** Short label for the map ("4.5 cm/yr · 60°"). */
  label: string;
  /** Status-line text. */
  text: string;
}

/** What the interaction needs from the editor shell. */
export interface InteractionHost {
  readonly core: EditorCore;
  readonly settings: ToolSettings;
  readonly seeds: Vec3[];
  view(): WorldView | null;
  selectedIndex(): number;
  select(index: number): void;
  /** Seeds were added / moved / removed. */
  seedsChanged(): void;
  /** Mark cells as part of the tool path being drawn (null clears all). */
  highlight(cells: number[] | null): void;
  /** The draft or overlays changed: schedule a preview frame. */
  changed(): void;
  /** An operation finished (status message, list refresh, full render). */
  opDone(res: OpResult): void;
  /** Motion drag of plate index k in progress (null: ended). */
  motionDrag(k: number | null): void;
  setCursor(c: BrushCursor | null): void;
  hover(text: string | null): void;
  /** CSS cursor for the view (null: the view's default for its mode). */
  pointerCursor?(css: string | null): void;
  /** The motion arrow of plate k is under the pointer (null: none). */
  hoverArrow?(k: number | null): void;
  /** The seed marker k is under the pointer (null: none). */
  hoverSeed?(k: number | null): void;
  /** Live motion-drag readout (null clears). */
  motionReadout?(r: MotionReadout | null): void;
}

type Action =
  | { kind: 'stroke' }
  | { kind: 'path'; tool: 'split' | 'lasso'; points: Array<Vec3 | null>; last: Vec3 | null }
  | {
    kind: 'motion'; plate: number; anchor: Vec3; spin: number; started: boolean;
    /**
     * 'head': the arrow head was grabbed (it follows the pointer, grab offset kept); 'shaft': the
     * shaft was grabbed (the arrow pivots and stretches about its anchor like a lever); 'draw': a new
     * arrow grows out of the anchor along the drag.
     */
    mode: 'head' | 'shaft' | 'draw';
    /** Press point and the arrow head at press time. */
    grab: Vec3; head0: Vec3; x: number; y: number;
  }
  | { kind: 'seed'; index: number }
  | { kind: 'click'; x: number; y: number; moved: number };

/** Hit radius around arrow shafts and seeds, CSS px (arrow heads get 1.4×). */
const HIT_PX = 12;
const CLICK_SLOP_PX = 5;
/** A motion drag starts after the pointer moved this far (a click only selects the plate). */
const DRAG_SLOP_PX = 4;
/** Shift-drag snapping of motions: bearing (degrees) and speed (km/Myr = 0.5 cm/yr). */
export const SNAP_BEARING_DEG = 15;
export const SNAP_SPEED_KM_MYR = 5;

const CURSOR_COLORS: Record<string, RGB> = {
  land: [226, 196, 140],
  ocean: [96, 170, 240],
  raise: [255, 255, 255],
  lower: [140, 170, 200],
  smooth: [200, 210, 225],
};

function fmtLatLon(lat: number, lon: number): string {
  const la = lat * RAD, lo = lon * RAD;
  return `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`;
}

export class PointerInteraction {
  private action: Action | null = null;
  private lastPoint: Vec3 | null = null;
  private lastEvent: WorldPointerEvent | null = null;
  private shift = false;
  private hoveredArrow: number | null = null;
  private hoveredSeed: number | null = null;
  private cursorCss: string | null = null;

  constructor(private readonly host: InteractionHost) {}

  /** True while a drag/stroke is in progress. */
  get busy(): boolean {
    return this.action !== null;
  }

  handle(e: WorldPointerEvent): void {
    const p = e.point ? latLonToVec(e.point.lat, e.point.lon) : null;
    this.shift = e.shiftKey;
    this.lastEvent = e.type === 'leave' ? null : e;
    switch (e.type) {
      case 'down':
        if (this.action || (e.buttons & 1) === 0 || e.altKey) return;
        this.begin(e, p);
        this.updateFeedback(e, p);
        break;
      case 'move':
      case 'hover':
        this.lastPoint = p;
        if (this.action) {
          // The left button was released where the view could not report an 'up' (outside the
          // canvas): the views then send 'hover' with no button. Finish the action instead of
          // continuing it (a stroke would otherwise keep painting under a released pointer).
          if ((e.buttons & 1) === 0) this.end(e, p);
          else this.continue(e, p);
        }
        this.updateHover(e, p);
        break;
      case 'up':
        if (this.action) this.end(e, p);
        this.updateHover(e, p);
        break;
      case 'leave':
        this.lastPoint = null;
        if (this.action?.kind === 'stroke') {
          this.host.core.strokeTo(null);
          this.host.changed();
        }
        this.host.setCursor(null);
        this.host.hover(null);
        this.setHoverArrow(null);
        this.setHoverSeed(null);
        this.setPointerCursor(null);
        break;
    }
  }

  /** Abandon the current action (Escape, tool switch, deactivate). */
  cancel(): void {
    const a = this.action;
    if (!a) return;
    this.action = null;
    if (a.kind === 'stroke' || (a.kind === 'motion' && a.started)) this.host.core.cancel();
    if (a.kind === 'path') this.host.highlight(null);
    if (a.kind === 'motion') {
      this.host.motionDrag(null);
      this.host.motionReadout?.(null);
    }
    this.host.changed();
    this.refreshCursor();
  }

  /** Refresh the brush cursor and pointer feedback (after tool / size / selection changes). */
  refreshCursor(): void {
    this.updateCursor(this.lastPoint);
    const e = this.lastEvent;
    if (e) this.updateFeedback(e, this.lastPoint);
    else {
      this.setHoverArrow(null);
      this.setHoverSeed(null);
      this.setPointerCursor(null);
    }
  }

  /** Re-describe the cell under the pointer (after undo / load changed what is there). */
  refreshHover(): void {
    const e = this.lastEvent;
    if (e) this.updateHover(e, this.lastPoint);
  }

  private strokeTool(): StrokeTool | null {
    const s = this.host.settings;
    switch (s.tool) {
      case 'plate':
        return 'plate';
      case 'continent':
        return (s.continentMode === 'land') !== this.shift ? 'continent' : 'ocean';
      case 'raise':
        return (s.raiseMode === 'raise') !== this.shift ? 'raise' : 'lower';
      case 'smooth':
        return 'smooth';
      default:
        return null;
    }
  }

  private atCap(): boolean {
    const core = this.host.core;
    return core.plates.length >= core.cap;
  }

  private refuse(message: string): void {
    this.host.opDone({ ok: false, message, created: [], removed: [] });
  }

  private begin(e: WorldPointerEvent, p: Vec3 | null): void {
    const { core, settings } = this.host;
    const tool = settings.tool;
    // Ctrl/Cmd+click: eyedropper for the plate tools.
    if ((e.ctrlKey || (e as { metaKey?: boolean }).metaKey) && p && (tool === 'plate' || tool === 'fill' || tool === 'lasso' || tool === 'select')) {
      this.host.select(core.plateAt(p));
      return;
    }
    if (tool === 'select') {
      this.action = { kind: 'click', x: e.clientX, y: e.clientY, moved: 0 };
      return;
    }
    if (tool === 'seeds') {
      this.beginSeed(e, p);
      return;
    }
    if (tool === 'motion') {
      this.beginMotion(e, p);
      return;
    }
    if (!p) return;
    const st = this.strokeTool();
    if (st) {
      const sel = this.host.selectedIndex();
      if (st === 'plate' && sel < 0) {
        this.refuse('Select a plate to paint with');
        return;
      }
      core.beginStroke(st, { radius: settings.brushKm / EARTH_RADIUS_KM, plate: sel, amount: settings.raiseAmount });
      core.strokeTo(p);
      this.action = { kind: 'stroke' };
      this.host.changed();
      return;
    }
    if (tool === 'fill') {
      const sel = this.host.selectedIndex();
      if (sel < 0) return;
      this.host.opDone(core.fill(p, sel));
      return;
    }
    if (tool === 'split' || tool === 'lasso') {
      // Refuse up front instead of after the user has drawn the whole path.
      if (this.atCap() && (tool === 'split' || settings.lassoTarget === 'new')) {
        this.refuse(`Plate limit reached (${core.cap}): delete a plate first${tool === 'lasso' ? ', or lasso into the selected plate' : ''}`);
        return;
      }
      this.action = { kind: 'path', tool, points: [p], last: p };
      this.host.highlight(pathCells(core.mesh, [p]));
      this.host.changed();
    }
  }

  private continue(e: WorldPointerEvent, p: Vec3 | null): void {
    const a = this.action;
    if (!a) return;
    const core = this.host.core;
    switch (a.kind) {
      case 'stroke':
        core.strokeTo(p);
        this.host.changed();
        break;
      case 'path':
        if (!p) {
          if (a.last) a.points.push(null);
          a.last = null;
          break;
        }
        if (a.last && angleBetween(a.last, p) < 0.3 * core.mesh.spacing) break;
        a.points.push(p);
        a.last = p;
        if (a.tool === 'split') {
          // Preview the whole cut, including its straight continuation to the plate's edges.
          this.host.highlight(null);
          this.host.highlight(pathCells(core.mesh, extendCut(core.mesh, core.draft.plate, a.points)));
        } else {
          // Lasso: the outline so far plus the closing edge back to the start (what release will enclose).
          this.host.highlight(null);
          this.host.highlight(pathCells(core.mesh, a.points, true));
        }
        this.host.changed();
        break;
      case 'motion': {
        if (!p) break;
        if (!a.started) {
          if (Math.hypot(e.clientX - a.x, e.clientY - a.y) < DRAG_SLOP_PX) break;
          core.beginMotion(a.plate);
          a.started = true;
          this.host.motionDrag(a.plate);
        }
        const snap = e.shiftKey;
        const snapDeg = snap ? SNAP_BEARING_DEG : 0, snapSpeed = snap ? SNAP_SPEED_KM_MYR : 0;
        let m: { speed: number; bearing: number };
        if (a.mode === 'shaft') {
          const lv = leverHead(a.anchor, a.grab, a.head0, p);
          m = motionFromArrow(lv.dist, lv.bearing, snapDeg, snapSpeed);
        } else {
          const head = rotateFromTo(a.grab, a.mode === 'head' ? a.head0 : a.anchor, p);
          m = dragMotion(a.anchor, head, snapDeg, snapSpeed);
        }
        const omega = omegaFromMotion(a.anchor, m.speed, m.bearing, a.spin);
        core.updateMotion(omega);
        const name = core.plates[a.plate]?.name ?? 'Plate';
        const label = m.speed < 0.05 ? 'stationary' : `${(m.speed / 10).toFixed(1)} cm/yr · ${Math.round(m.bearing) % 360}°`;
        const tip = arrowHead(a.anchor, omega);
        const len = angleBetween(a.anchor, tip);
        this.host.motionReadout?.({
          plate: a.plate,
          // Label just beyond the arrow tip, so it never hides the arrowhead.
          head: len > 1e-6 ? slerp(a.anchor, tip, (len + Math.max(1.2 * DEG, 0.12 * len)) / len, len) : tip,
          label,
          text: `${name}: ${formatMotion(m.speed, m.bearing)}${snap ? ' (snapped to 15° / 0.5 cm/yr)' : ' · hold Shift to snap'} · Esc cancels`,
        });
        this.host.changed();
        break;
      }
      case 'seed':
        if (!p) break;
        this.host.seeds[a.index] = p;
        this.host.seedsChanged();
        break;
      case 'click':
        a.moved = Math.max(a.moved, Math.hypot(e.clientX - a.x, e.clientY - a.y));
        break;
    }
  }

  private end(e: WorldPointerEvent, p: Vec3 | null): void {
    const a = this.action;
    this.action = null;
    if (!a) return;
    const { core, settings } = this.host;
    switch (a.kind) {
      case 'stroke':
        this.host.opDone(core.endStroke());
        break;
      case 'path': {
        this.host.highlight(null);
        if (a.tool === 'split') this.host.opDone(core.split(a.points));
        else {
          const poly = a.points.filter((q): q is Vec3 => q !== null);
          const target = settings.lassoTarget === 'new' ? 'new' : this.host.selectedIndex();
          if (target !== 'new' && target < 0) this.refuse('Select a plate first');
          else this.host.opDone(core.lasso(poly, target));
        }
        break;
      }
      case 'motion':
        this.host.motionDrag(null);
        this.host.motionReadout?.(null);
        if (a.started) this.host.opDone(core.endMotion());
        else {
          const m = core.plateMotion(a.plate);
          const name = core.plates[a.plate]?.name ?? 'Plate';
          this.host.opDone({
            ok: true,
            message: `${name}: ${m ? formatMotion(m.speed, m.bearing) : 'no cells'} — drag its arrow (or anywhere on it) to change`,
            created: [],
            removed: [],
          });
        }
        break;
      case 'seed':
        this.host.seedsChanged();
        break;
      case 'click': {
        const moved = Math.max(a.moved, Math.hypot(e.clientX - a.x, e.clientY - a.y));
        if (moved <= CLICK_SLOP_PX && p) this.host.select(core.plateAt(p));
        break;
      }
    }
    this.host.changed();
  }

  /** Seed index under the pointer (screen distance ≤ HIT_PX), or -1. */
  private seedAt(e: WorldPointerEvent): number {
    const view = this.host.view();
    if (!view) return -1;
    let hit = -1;
    let best = HIT_PX;
    this.host.seeds.forEach((s, k) => {
      const pr = view.project(toGeo(s));
      if (!pr.visible) return;
      const d = Math.hypot(pr.x - e.clientX, pr.y - e.clientY);
      if (d < best) {
        best = d;
        hit = k;
      }
    });
    return hit;
  }

  private beginSeed(e: WorldPointerEvent, p: Vec3 | null): void {
    const seeds = this.host.seeds;
    const hit = this.seedAt(e);
    if (hit >= 0 && e.shiftKey) {
      seeds.splice(hit, 1);
      this.host.seedsChanged();
      return;
    }
    if (hit >= 0) {
      this.action = { kind: 'seed', index: hit };
      return;
    }
    if (!p || e.shiftKey) return;
    if (seeds.length >= this.host.core.cap) {
      this.refuse(`At most ${this.host.core.cap} seeds (the plate limit)`);
      return;
    }
    seeds.push(p);
    this.action = { kind: 'seed', index: seeds.length - 1 };
    this.host.seedsChanged();
  }

  /** Radians of arc per CSS pixel around the pointer (for pixel hit tolerances in geo space). */
  private radPerPx(e: WorldPointerEvent, p: Vec3): number {
    const view = this.host.view();
    if (view) {
      for (const [dx, dy] of [[10, 0], [-10, 0], [0, 10], [0, -10]] as const) {
        const q = view.pick(e.clientX + dx, e.clientY + dy);
        if (q) {
          const a = angleBetween(p, latLonToVec(q.lat, q.lon)) / 10;
          if (a > 0 && Number.isFinite(a)) return a;
        }
      }
    }
    return 0.25 * DEG;
  }

  private arrowHandles(): ArrowHandle[] {
    const core = this.host.core;
    const anchors = core.anchors();
    const out: ArrowHandle[] = [];
    core.plates.forEach((pl, k) => {
      const a = anchors[k];
      if (a) out.push({ plate: k, anchor: a, head: arrowHead(a, pl.omega) });
    });
    return out;
  }

  /** The arrow (plate index + part) under the pointer, or null. */
  private arrowAt(e: WorldPointerEvent, p: Vec3 | null): { plate: number; part: 'head' | 'shaft' } | null {
    if (!p) return null;
    return hitArrow(this.arrowHandles(), p, HIT_PX * this.radPerPx(e, p));
  }

  private beginMotion(e: WorldPointerEvent, p: Vec3 | null): void {
    const core = this.host.core;
    if (!p) return;
    const anchors = core.anchors();
    const hit = this.arrowAt(e, p);
    const k = hit ? hit.plate : core.plateAt(p);
    const anchor = anchors[k];
    if (!anchor) return;
    this.host.select(k);
    const omega = core.plates[k].omega;
    const spin = motionAt(omega, anchor).spin;
    // Grabbing an arrow's head moves it with the pointer (no jump: the grab offset is kept), its
    // shaft levers it about the anchor; pressing anywhere else on the plate draws a new arrow.
    this.action = {
      kind: 'motion', plate: k, anchor, spin, started: false, mode: hit ? hit.part : 'draw', grab: p, head0: arrowHead(anchor, omega),
      x: e.clientX, y: e.clientY,
    };
  }

  private updateHover(e: WorldPointerEvent, p: Vec3 | null): void {
    this.updateCursor(p);
    this.updateFeedback(e, p);
    if (!p || !e.point) {
      this.host.hover(null);
      return;
    }
    const core = this.host.core;
    const d = core.draft;
    const i = core.cellAt(p);
    const k = d.plate[i];
    const plate = d.plates[k];
    const crust = d.crust[i] === CRUST_CONTINENTAL ? 'continental' : 'oceanic';
    const elev = Math.round(d.elev[i]);
    const elevText = `${elev > 0 ? '+' : elev < 0 ? '−' : ''}${Math.abs(elev).toLocaleString('en-US')} m`;
    let extra = '';
    const tool = this.host.settings.tool;
    if (tool === 'motion' && !this.action) {
      const hk = this.hoveredArrow ?? k;
      const m = core.plateMotion(hk);
      if (m) extra = ` · ${core.plates[hk].name} ${formatMotion(m.speed, m.bearing)}`;
    }
    if (this.action?.kind === 'motion' && this.action.started) return; // the readout owns the status line
    this.host.hover(`${fmtLatLon(e.point.lat, e.point.lon)} · ${plate?.name ?? '—'} · ${crust} · ${elevText}${extra}`);
  }

  /** Cursor shape and grabbable-handle highlights for the current tool and pointer position. */
  private updateFeedback(e: WorldPointerEvent, p: Vec3 | null): void {
    const { settings } = this.host;
    const tool = settings.tool;
    const a = this.action;
    let css: string | null = null;
    let arrow: number | null = null;
    let seed: number | null = null;
    if (tool === 'motion') {
      if (a?.kind === 'motion') {
        arrow = a.plate;
        css = 'grabbing';
      } else if (p) {
        const hit = this.arrowAt(e, p);
        arrow = hit ? hit.plate : null;
        css = hit ? 'grab' : 'crosshair';
      }
    } else if (tool === 'seeds') {
      if (a?.kind === 'seed') {
        seed = a.index;
        css = 'grabbing';
      } else {
        const hit = this.seedAt(e);
        seed = hit >= 0 ? hit : null;
        if (hit >= 0) css = e.shiftKey ? 'pointer' : 'move';
        else if (p) css = this.host.seeds.length >= this.host.core.cap ? 'not-allowed' : 'copy';
      }
    } else if (tool === 'select') {
      css = p ? 'pointer' : null;
    } else if (tool === 'fill') {
      css = p ? 'cell' : null;
    } else if ((tool === 'split' || (tool === 'lasso' && settings.lassoTarget === 'new')) && this.atCap() && !a) {
      css = p ? 'not-allowed' : null;
    }
    this.setHoverArrow(arrow);
    this.setHoverSeed(seed);
    this.setPointerCursor(css);
  }

  private setHoverArrow(k: number | null): void {
    if (k === this.hoveredArrow) return;
    this.hoveredArrow = k;
    this.host.hoverArrow?.(k);
  }

  private setHoverSeed(k: number | null): void {
    if (k === this.hoveredSeed) return;
    this.hoveredSeed = k;
    this.host.hoverSeed?.(k);
  }

  private setPointerCursor(css: string | null): void {
    if (css === this.cursorCss) return;
    this.cursorCss = css;
    this.host.pointerCursor?.(css);
  }

  private updateCursor(p: Vec3 | null): void {
    const s = this.host.settings;
    if (!p || !toolInfo(s.tool).brush) {
      this.host.setCursor(null);
      return;
    }
    const st = this.strokeTool();
    let color: RGB;
    if (st === 'plate') {
      const k = this.host.selectedIndex();
      color = k >= 0 ? this.host.core.plates[k].color : [255, 255, 255];
    } else color = CURSOR_COLORS[st === 'continent' ? 'land' : (st ?? 'smooth')] ?? [255, 255, 255];
    const radius = Math.max(s.brushKm / EARTH_RADIUS_KM, this.host.core.mesh.spacing);
    this.host.setCursor({ point: toGeo(p), radius, color });
  }
}

function toGeo(v: Vec3): { lat: number; lon: number } {
  return vecToLatLon(v[0], v[1], v[2]);
}
