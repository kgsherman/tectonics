/**
 * Where the plate editor draws each plate's motion arrow (display only — a plate's ω is the same
 * everywhere; the arrow shows the surface velocity ω × p at its tail p).
 *
 * Preferred tail: the point where the user last set the plate's motion (the drag start), else the
 * plate's anchor (interior point). When that point is on the hidden side of the globe (or off
 * screen), the arrow moves to the visible well-interior point of the plate nearest the view centre
 * and stays there while it remains visible (no hopping while the globe turns).
 */
import { dot3, latLonToVec, vecToLatLon } from '../core/math3';
import type { GeoPoint, SphereMesh, Vec3, WorldView } from '../core/types';
import { plateInteriorPoints } from './topology';

/** What the handles need from the editor model. */
export interface HandleModel {
  readonly mesh: SphereMesh;
  readonly plates: ReadonlyArray<{ id: number }>;
  readonly draft: { plate: Int16Array };
  anchors(): Array<Vec3 | null>;
  plateAt(p: Vec3): number;
}

/** Visibility of points in the current view. */
export interface HandleVisibility {
  /** Point at the view centre (unit vector), null if unknown. */
  readonly center: Vec3 | null;
  /** The point is on screen and comfortably visible (not at the globe's limb). */
  good(p: Vec3): boolean;
}

export class MotionHandles {
  /** Plate id → tail chosen by the user (where they dragged the motion). */
  private readonly user = new Map<number, Vec3>();
  /** Plate id → visible stand-in for a hidden preferred tail. */
  private readonly standIn = new Map<number, Vec3>();
  private candidates: { anchors: Array<Vec3 | null>; points: Vec3[][] } | null = null;
  /** Tails as last laid out, per plate index (what is drawn and hit-tested). */
  private laid: Array<Vec3 | null> = [];

  /** The user set plate `id`'s motion from point p: draw its arrow there from now on. */
  pin(id: number, p: Vec3): void {
    this.user.set(id, [p[0], p[1], p[2]]);
    this.standIn.delete(id);
  }

  /** The user's tail for plate `id` (undefined: none). */
  pinned(id: number): Vec3 | undefined {
    return this.user.get(id);
  }

  /** Restore a previous pin (undefined removes it), e.g. when a drag is cancelled. */
  restore(id: number, p: Vec3 | undefined): void {
    if (p) this.user.set(id, p);
    else this.user.delete(id);
  }

  /** Forget everything (new draft). */
  clear(): void {
    this.user.clear();
    this.standIn.clear();
    this.candidates = null;
    this.laid = [];
  }

  /** Tails as last laid out by `layout` (plate index → point, null for plates without cells). */
  get tails(): ReadonlyArray<Vec3 | null> {
    return this.laid;
  }

  /** The tail plate k would prefer: the user's point while it is still on the plate, else its anchor. */
  preferred(model: HandleModel, k: number): Vec3 | null {
    const a = model.anchors()[k] ?? null;
    if (!a) return null;
    const id = model.plates[k]?.id;
    const u = id === undefined ? undefined : this.user.get(id);
    if (u) {
      if (model.plateAt(u) === k) return u;
      this.user.delete(id);
    }
    return a;
  }

  /** Lay out every plate's arrow tail for the view (vis null: no view → preferred tails). */
  layout(model: HandleModel, vis: HandleVisibility | null): Array<Vec3 | null> {
    const out: Array<Vec3 | null> = [];
    const live = new Set<number>();
    model.plates.forEach((pl, k) => {
      live.add(pl.id);
      const pref = this.preferred(model, k);
      if (!pref || !vis || vis.good(pref)) {
        this.standIn.delete(pl.id);
        out.push(pref);
        return;
      }
      const s = this.standIn.get(pl.id);
      if (s && model.plateAt(s) === k && vis.good(s)) {
        out.push(s);
        return;
      }
      const c = this.nearestVisible(model, k, vis);
      if (c) this.standIn.set(pl.id, c);
      else this.standIn.delete(pl.id);
      out.push(c ?? pref);
    });
    for (const id of [...this.user.keys()]) if (!live.has(id)) this.user.delete(id);
    for (const id of [...this.standIn.keys()]) if (!live.has(id)) this.standIn.delete(id);
    this.laid = out;
    return out;
  }

  /**
   * The layout would change for this view: a drawn tail is no longer comfortably visible, or a
   * plate's preferred tail came back into view (cheap: ≤ 2 visibility tests per plate).
   */
  stale(model: HandleModel, vis: HandleVisibility): boolean {
    if (this.laid.length !== model.plates.length) return true;
    for (let k = 0; k < this.laid.length; k++) {
      const t = this.laid[k];
      const pref = this.preferred(model, k);
      if (!t || !pref) {
        if (t !== pref) return true;
        continue;
      }
      if (t !== pref) {
        // A stand-in is drawn: back to the preferred tail once it is visible again.
        if (vis.good(pref) || !vis.good(t)) return true;
      } else if (!vis.good(t) && this.hasVisibleCandidate(model, k, vis)) return true;
    }
    return false;
  }

  private interior(model: HandleModel): Vec3[][] {
    const anchors = model.anchors();
    if (!this.candidates || this.candidates.anchors !== anchors) {
      this.candidates = { anchors, points: plateInteriorPoints(model.mesh, model.draft.plate, model.plates.length) };
    }
    return this.candidates.points;
  }

  private nearestVisible(model: HandleModel, k: number, vis: HandleVisibility): Vec3 | null {
    const pts = this.interior(model)[k] ?? [];
    let best: Vec3 | null = null;
    let bestDot = -Infinity;
    for (const p of pts) {
      const d = vis.center ? dot3(p, vis.center) : 0;
      if (d <= bestDot || !vis.good(p)) continue;
      best = p;
      bestDot = d;
    }
    return best;
  }

  private hasVisibleCandidate(model: HandleModel, k: number, vis: HandleVisibility): boolean {
    return this.nearestVisible(model, k, vis) !== null;
  }
}

/** Globe points farther than this from the view centre count as "at the limb" (≈ 72°). */
const LIMB_COS = Math.cos((72 * Math.PI) / 180);
/** Keep arrow tails this far (CSS px) inside the view. */
const EDGE_PX = 18;

/** Visibility in a WorldView: projected on screen, inside the element, and (globe) not at the limb. */
export function viewVisibility(view: WorldView): HandleVisibility {
  const r = view.element.getBoundingClientRect();
  const c = (view as { getView?: () => { center: GeoPoint } }).getView?.().center ?? view.pick(r.left + r.width / 2, r.top + r.height / 2);
  const center = c ? latLonToVec(c.lat, c.lon) : null;
  const globe = view.kind === 'globe';
  return {
    center,
    good(p: Vec3): boolean {
      if (globe && center && dot3(p, center) < LIMB_COS) return false;
      const pr = view.project(vecToLatLon(p[0], p[1], p[2]));
      return pr.visible && pr.x >= r.left + EDGE_PX && pr.x <= r.right - EDGE_PX && pr.y >= r.top + EDGE_PX && pr.y <= r.bottom - EDGE_PX;
    },
  };
}
