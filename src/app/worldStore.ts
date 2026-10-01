/**
 * The current world survives page reloads: the live simulation state (a WorldDraft, ~2.4 MB at
 * 160k cells, stored as typed arrays) is saved to IndexedDB when it settles (world loaded, pause,
 * step, every ~20 s of playback, tab hidden).
 *
 * Restore policy (`startupDecision`):
 *  - a reload of the same tab (navigation type 'reload', same sessionStorage token) restores that
 *    tab's world automatically ("Restored previous world", with "Start fresh");
 *  - a fresh visit generates the World-tab world as before and only OFFERS the most recent saved
 *    world (toast with "Restore");
 *  - a saved world that the World-tab settings would regenerate exactly (t = 0, same parameters)
 *    is never restored or offered — generating it is just as quick;
 *  - `?fresh` in the URL skips both and does not save (a session that leaves saved worlds alone).
 * Every storage failure (private mode, quota, blocked IndexedDB) is swallowed: persistence is a
 * convenience, never an error.
 */
import { MAX_PLATES } from '../core/constants';
import type { Hotspot, PlateSpec, WorldDraft } from '../core/types';

export interface SavedWorldMeta {
  /** Tab session token (sessionStorage) the world was saved from. */
  token: string;
  /** Date.now() at save. */
  savedAt: number;
  time: number;
  meshN: number;
  seed: number;
  steps: number;
  plates: number;
  /** worldParamsKey of the World-tab settings it was generated with; '' for edited worlds. */
  paramsKey: string;
}

export interface SavedWorld {
  meta: SavedWorldMeta;
  draft: WorldDraft;
}

export interface WorldStore {
  save(world: SavedWorld): Promise<boolean>;
  load(token: string): Promise<SavedWorld | null>;
  /** Forget a tab's saved world. */
  remove(token: string): Promise<void>;
  /** Most recently saved world's meta (any tab). */
  latest(): Promise<SavedWorldMeta | null>;
}

/** Saved worlds kept (one per tab session, oldest dropped). */
export const MAX_SAVED_WORLDS = 3;
const DB_NAME = 'worldgen';
const DB_VERSION = 1;
const META = 'worldMeta';
const DRAFTS = 'worldDrafts';
export const SESSION_KEY = 'worldgen.session.v1';

/* ------------------------------------------------------------------ */
/* Pure policy                                                          */
/* ------------------------------------------------------------------ */

/** The World-tab settings would rebuild this world exactly (nothing worth restoring). */
export function isReproducible(meta: SavedWorldMeta, currentParamsKey: string): boolean {
  return meta.time === 0 && meta.steps === 0 && meta.paramsKey !== '' && meta.paramsKey === currentParamsKey;
}

export type StartupDecision =
  | { kind: 'restore'; token: string }
  | { kind: 'offer'; meta: SavedWorldMeta }
  | { kind: 'none' };

export interface StartupInputs {
  /** PerformanceNavigationTiming.type ('navigate' | 'reload' | 'back_forward' | 'prerender'). */
  navigationType: string;
  /** This tab's session token, if the tab saved worlds before (null on a fresh tab). */
  sessionToken: string | null;
  /** Meta of this tab's saved world (null: none). */
  own: SavedWorldMeta | null;
  /** Most recent saved world from any tab (null: none). */
  latest: SavedWorldMeta | null;
  currentParamsKey: string;
  /** `?fresh` in the URL. */
  fresh: boolean;
}

export function startupDecision(i: StartupInputs): StartupDecision {
  if (i.fresh) return { kind: 'none' };
  if (i.navigationType === 'reload' && i.sessionToken && i.own && i.own.token === i.sessionToken && !isReproducible(i.own, i.currentParamsKey)) {
    return { kind: 'restore', token: i.own.token };
  }
  if (i.latest && !isReproducible(i.latest, i.currentParamsKey)) return { kind: 'offer', meta: i.latest };
  return { kind: 'none' };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validPlate(p: unknown): p is PlateSpec {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  const vec = (v: unknown, len: number) => Array.isArray(v) && v.length === len && v.every(isFiniteNum);
  return isFiniteNum(q.id) && typeof q.name === 'string' && vec(q.color, 3) && vec(q.omega, 3) && (q.frame === undefined || vec(q.frame, 4));
}

function validHotspot(h: unknown): h is Hotspot {
  if (typeof h !== 'object' || h === null) return false;
  const q = h as Record<string, unknown>;
  return Array.isArray(q.pos) && q.pos.length === 3 && q.pos.every(isFiniteNum) && isFiniteNum(q.strength) && isFiniteNum(q.radius);
}

/** A stored world read back from storage: a well-formed draft, or null. */
export function validateSavedWorld(raw: unknown): SavedWorld | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { meta, draft } = raw as { meta?: Record<string, unknown>; draft?: Record<string, unknown> };
  if (!meta || !draft) return null;
  if (typeof meta.token !== 'string' || !isFiniteNum(meta.savedAt) || !isFiniteNum(meta.time) || typeof meta.paramsKey !== 'string') return null;
  const n = draft.n;
  if (!isFiniteNum(n) || !Number.isInteger(n) || n < 100 || n > 2_000_000) return null;
  const typed = <T>(v: unknown, ctor: new (...a: never[]) => T): v is T => v instanceof ctor && (v as unknown as { length: number }).length === n;
  if (!typed(draft.plate, Int16Array) || !typed(draft.crust, Uint8Array) || !typed(draft.elev, Float32Array) || !typed(draft.age, Float32Array)) return null;
  if (draft.orogeny !== undefined && !typed(draft.orogeny, Float32Array)) return null;
  const plates = draft.plates;
  if (!Array.isArray(plates) || plates.length < 1 || plates.length > MAX_PLATES || !plates.every(validPlate)) return null;
  if (!Array.isArray(draft.hotspots) || !draft.hotspots.every(validHotspot)) return null;
  if (!isFiniteNum(draft.time) || !isFiniteNum(draft.seed) || !isFiniteNum(draft.nextPlateId)) return null;
  const plate = draft.plate as Int16Array;
  for (let i = 0; i < n; i++) if (plate[i] < 0 || plate[i] >= plates.length) return null;
  const elev = draft.elev as Float32Array, age = draft.age as Float32Array;
  for (let i = 0; i < n; i++) if (!Number.isFinite(elev[i]) || !Number.isFinite(age[i])) return null;
  return { meta: meta as unknown as SavedWorldMeta, draft: draft as unknown as WorldDraft };
}

const newToken = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * This tab's world-lineage token (sessionStorage: survives reloads of the tab). `create` makes one
 * when missing; null when sessionStorage is unavailable.
 */
export function sessionToken(create: boolean): string | null {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    let t = s.getItem(SESSION_KEY);
    if (!t && create) {
      t = newToken();
      s.setItem(SESSION_KEY, t);
    }
    return t;
  } catch {
    return null;
  }
}

/**
 * A new lineage for this tab (a fresh visit, not a reload): the world saved under the previous
 * token stays in storage as the "previous world" that can be restored, instead of being
 * overwritten by the newly generated one.
 */
export function rotateSessionToken(): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_KEY, newToken());
  } catch {
    // No sessionStorage: worlds are not saved (sessionToken returns null).
  }
}

/** How this page was reached ('reload' after F5 / location.reload()). */
export function navigationType(): string {
  try {
    const e = globalThis.performance?.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    return e?.type ?? 'navigate';
  } catch {
    return 'navigate';
  }
}

/* ------------------------------------------------------------------ */
/* Stores                                                               */
/* ------------------------------------------------------------------ */

/** In-memory store (tests). */
export function memoryWorldStore(): WorldStore {
  const worlds = new Map<string, SavedWorld>();
  return {
    async save(w) {
      worlds.set(w.meta.token, structuredClone(w));
      const old = [...worlds.values()].sort((a, b) => b.meta.savedAt - a.meta.savedAt).slice(MAX_SAVED_WORLDS);
      for (const o of old) worlds.delete(o.meta.token);
      return true;
    },
    async load(token) {
      const w = worlds.get(token);
      return w ? validateSavedWorld(structuredClone(w)) : null;
    },
    async remove(token) {
      worlds.delete(token);
    },
    async latest() {
      let best: SavedWorldMeta | null = null;
      for (const w of worlds.values()) if (!best || w.meta.savedAt > best.savedAt) best = w.meta;
      return best ? { ...best } : null;
    },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IndexedDB-backed store, or null where IndexedDB is unavailable. */
export function idbWorldStore(): WorldStore | null {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'token' });
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'token' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    }).catch((e) => {
      dbp = null;
      throw e;
    });
    return dbp;
  };
  const allMeta = async (db: IDBDatabase): Promise<SavedWorldMeta[]> => {
    const tx = db.transaction(META, 'readonly');
    const list = (await req(tx.objectStore(META).getAll())) as SavedWorldMeta[];
    return list.filter((m) => m && typeof m.token === 'string' && isFiniteNum(m.savedAt));
  };
  return {
    async save(w) {
      try {
        const db = await open();
        const tx = db.transaction([META, DRAFTS], 'readwrite');
        tx.objectStore(META).put(w.meta);
        tx.objectStore(DRAFTS).put({ token: w.meta.token, draft: w.draft });
        await done(tx);
        const old = (await allMeta(db)).sort((a, b) => b.savedAt - a.savedAt).slice(MAX_SAVED_WORLDS);
        if (old.length) {
          const del = db.transaction([META, DRAFTS], 'readwrite');
          for (const m of old) {
            del.objectStore(META).delete(m.token);
            del.objectStore(DRAFTS).delete(m.token);
          }
          await done(del);
        }
        return true;
      } catch {
        return false;
      }
    },
    async load(token) {
      try {
        const db = await open();
        const tx = db.transaction([META, DRAFTS], 'readonly');
        const [meta, row] = await Promise.all([req(tx.objectStore(META).get(token)), req(tx.objectStore(DRAFTS).get(token))]);
        return validateSavedWorld({ meta, draft: (row as { draft?: unknown } | undefined)?.draft });
      } catch {
        return null;
      }
    },
    async remove(token) {
      try {
        const db = await open();
        const tx = db.transaction([META, DRAFTS], 'readwrite');
        tx.objectStore(META).delete(token);
        tx.objectStore(DRAFTS).delete(token);
        await done(tx);
      } catch {
        // Nothing to forget, or storage unavailable.
      }
    },
    async latest() {
      try {
        const list = await allMeta(await open());
        let best: SavedWorldMeta | null = null;
        for (const m of list) if (!best || m.savedAt > best.savedAt) best = m;
        return best;
      } catch {
        return null;
      }
    },
  };
}

/** Resolve `p`, or `fallback` after `ms` (a hung IndexedDB must not hold up the first world). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, () => {
      clearTimeout(t);
      resolve(fallback);
    });
  });
}
