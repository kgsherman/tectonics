/**
 * Pointer interaction for the plate editor: turns WorldView pointer events into EditorCore
 * operations for the active tool (strokes, paths, clicks, seed and motion drags).
 */
import { EARTH_RADIUS_KM, RAD } from '../core/constants';
import { angleBetween, latLonToVec, vecToLatLon } from '../core/math3';
import type { BrushCursor, RGB, Vec3, WorldPointerEvent, WorldView } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import type { EditorCore, OpResult, StrokeTool } from './editorCore';
import { arrowHead, motionAt, omegaFromDrag } from './motion';
import { pathCells } from './paths';
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
}

type Action =
  | { kind: 'stroke' }
  | { kind: 'path'; tool: 'split' | 'lasso'; points: Array<Vec3 | null>; last: Vec3 | null }
  | { kind: 'motion'; plate: number; anchor: Vec3; spin: number; started: boolean }
  | { kind: 'seed'; index: number }
  | { kind: 'click'; x: number; y: number; moved: number };

/** Handle hit radius around arrow heads and seeds, CSS px. */
const HIT_PX = 14;
const CLICK_SLOP_PX = 5;

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
    if (a.kind === 'motion') this.host.motionDrag(null);
    this.host.changed();
  }

  /** Refresh the brush cursor (after tool / size / selection changes). */
  refreshCursor(): void {
    this.updateCursor(this.lastPoint);
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
        this.host.opDone({ ok: false, message: 'Select a plate to paint with', created: [], removed: [] });
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
        this.host.highlight(pathCells(core.mesh, a.last ? [a.last, p] : [p]));
        a.points.push(p);
        a.last = p;
        this.host.changed();
        break;
      case 'motion': {
        if (!p) break;
        if (!a.started) {
          core.beginMotion(a.plate);
          a.started = true;
          this.host.motionDrag(a.plate);
        }
        core.updateMotion(omegaFromDrag(a.anchor, p, a.spin, e.shiftKey ? 15 : 0));
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
          if (target !== 'new' && target < 0) this.host.opDone({ ok: false, message: 'Select a plate first', created: [], removed: [] });
          else this.host.opDone(core.lasso(poly, target));
        }
        break;
      }
      case 'motion':
        this.host.motionDrag(null);
        if (a.started) this.host.opDone(core.endMotion());
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

  private beginSeed(e: WorldPointerEvent, p: Vec3 | null): void {
    const view = this.host.view();
    const seeds = this.host.seeds;
    let hit = -1;
    if (view) {
      let best = HIT_PX;
      seeds.forEach((s, k) => {
        const ll = toGeo(s);
        const pr = view.project(ll);
        if (!pr.visible) return;
        const d = Math.hypot(pr.x - e.clientX, pr.y - e.clientY);
        if (d < best) {
          best = d;
          hit = k;
        }
      });
    }
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
      this.host.opDone({ ok: false, message: `At most ${this.host.core.cap} seeds (the plate limit)`, created: [], removed: [] });
      return;
    }
    seeds.push(p);
    this.action = { kind: 'seed', index: seeds.length - 1 };
    this.host.seedsChanged();
  }

  private beginMotion(e: WorldPointerEvent, p: Vec3 | null): void {
    const core = this.host.core;
    const view = this.host.view();
    const anchors = core.anchors();
    let k = -1;
    if (view) {
      // Arrow heads first: they may lie over a neighbouring plate.
      let best = HIT_PX;
      core.plates.forEach((pl, i) => {
        const a = anchors[i];
        if (!a) return;
        const pr = view.project(toGeo(arrowHead(a, pl.omega)));
        if (!pr.visible) return;
        const d = Math.hypot(pr.x - e.clientX, pr.y - e.clientY);
        if (d < best) {
          best = d;
          k = i;
        }
      });
    }
    if (k < 0 && p) k = core.plateAt(p);
    if (k < 0) return;
    const anchor = anchors[k];
    if (!anchor) return;
    this.host.select(k);
    this.action = { kind: 'motion', plate: k, anchor, spin: motionAt(core.plates[k].omega, anchor).spin, started: false };
  }

  private updateHover(e: WorldPointerEvent, p: Vec3 | null): void {
    this.updateCursor(p);
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
    this.host.hover(`${fmtLatLon(e.point.lat, e.point.lon)} · ${plate?.name ?? '—'} · ${crust} · ${elevText}`);
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
