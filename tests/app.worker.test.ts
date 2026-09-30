import { describe, expect, it } from 'vitest';
import { ClimateShelf, climateBytes } from '../src/worker/climateShelf';
import { KeyframeStore, snapshotBytes } from '../src/worker/keyframes';
import { FrameGate, isStaleEpoch, LatestWins, transferList } from '../src/worker/protocol';
import { layerIsMonthly, layerNeedsClimate, layerUsesClimate, LAYER_ORDER } from '../src/worker/layerInfo';
import type { ClimateResult, WorldSnapshot } from '../src/core/types';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

describe('protocol helpers', () => {
  it('transferList dedupes buffers and skips nulls/empties', () => {
    const a = new Float32Array(8);
    const b = new Uint8Array(a.buffer, 4, 4);
    const c = new Uint8ClampedArray(16);
    const list = transferList(a, null, b, undefined, c, new Float32Array(0));
    expect(list).toEqual([a.buffer, c.buffer]);
  });

  it('FrameGate caps unacknowledged frames and ignores stale acks', () => {
    const g = new FrameGate(2);
    expect(g.canSend()).toBe(true);
    g.sent(1);
    g.sent(2);
    expect(g.canSend()).toBe(false);
    expect(g.ack(7)).toBe(false);
    expect(g.ack(1)).toBe(true);
    expect(g.canSend()).toBe(true);
    g.reset();
    expect(g.pending).toBe(0);
    expect(g.ack(2)).toBe(false);
    expect(() => new FrameGate(0)).toThrow();
  });

  it('LatestWins keeps one request in flight and the latest pending', () => {
    const sent: string[] = [];
    let id = 0;
    const lw = new LatestWins<string>((r) => {
      sent.push(r);
      return ++id;
    });
    lw.submit('a');
    lw.submit('b');
    lw.submit('c');
    expect(sent).toEqual(['a']);
    lw.complete(99); // unknown id
    expect(sent).toEqual(['a']);
    lw.complete(1);
    expect(sent).toEqual(['a', 'c']);
    lw.complete(2);
    expect(lw.busy).toBe(false);
    lw.submit('d');
    expect(sent).toEqual(['a', 'c', 'd']);
    lw.reset();
    expect(lw.busy).toBe(false);
  });

  it('LatestWins merges pending requests when asked to', () => {
    const sent: string[] = [];
    let id = 0;
    const lw = new LatestWins<string>((r) => {
      sent.push(r);
      return ++id;
    }, (a, b) => (a === 'all' || b === 'all' ? 'all' : b));
    lw.submit('overlay');
    lw.submit('all');
    lw.submit('overlay');
    lw.complete(1);
    expect(sent).toEqual(['overlay', 'all']);
  });

  it('epochs', () => {
    expect(isStaleEpoch(3, 4)).toBe(true);
    expect(isStaleEpoch(4, 4)).toBe(false);
  });

  it('layer metadata covers every layer', () => {
    expect(new Set(LAYER_ORDER).size).toBe(12);
    expect(layerUsesClimate('satellite')).toBe(true);
    expect(layerNeedsClimate('satellite')).toBe(false);
    expect(layerNeedsClimate('koppen')).toBe(true);
    expect(layerUsesClimate('plates')).toBe(false);
    expect(layerIsMonthly('koppen')).toBe(false);
    expect(layerIsMonthly('temperature')).toBe(true);
  });
});

function fakeSnapshot(id: number, n = 1000): WorldSnapshot {
  return {
    id, time: id, n, plate: new Int16Array(n), elev: new Float32Array(n), crust: new Uint8Array(n), age: new Float32Array(n),
    boundary: new Uint8Array(n), orogeny: new Float32Array(n), plates: [], hotspots: [],
  };
}

describe('KeyframeStore', () => {
  it('records every interval and halves density when over budget', () => {
    const per = snapshotBytes(fakeSnapshot(0));
    const store = new KeyframeStore(5, per * 10.5);
    let built = 0;
    for (let t = 0; t <= 100; t++) {
      store.offer(t, t, () => {
        built++;
        return fakeSnapshot(t);
      });
    }
    // 0,5,…,45 fit (10); adding 50 overflows → keep 0,10,…,40,50? (evens of 0..50) and interval 10.
    expect(store.bytes).toBeLessThanOrEqual(store.budgetBytes);
    expect(store.interval).toBeGreaterThanOrEqual(10);
    const times = store.list().map((k) => k.time);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(5);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeGreaterThan(80);
    // Evenly spaced at the final interval after the last halving.
    const gaps = new Set(times.slice(1).map((t, i) => t - times[i]));
    expect(gaps.size).toBeLessThanOrEqual(2);
    expect(built).toBeLessThan(40); // provider called only when due
  });

  it('truncates for "play from here", finds nearest, validates', () => {
    const store = new KeyframeStore(1, 1e9);
    for (let t = 0; t < 10; t++) store.add(t, t, fakeSnapshot(t + 1));
    store.truncateAfter(4);
    expect(store.count).toBe(5);
    expect(store.at(4).time).toBe(4);
    expect(store.isDue(4.5)).toBe(false);
    expect(store.isDue(5)).toBe(true);
    expect(store.nearestIndex(3.4)).toBe(3);
    expect(() => store.at(9)).toThrow();
    expect(() => store.add(1, 1, fakeSnapshot(99))).toThrow();
    store.clear();
    expect(store.count).toBe(0);
    expect(store.bytes).toBe(0);
    expect(store.nearestIndex(3)).toBe(-1);
  });
});

describe('ClimateShelf', () => {
  const mk = (id: number, sourceTime: number, tilt = 23.44): ClimateResult => {
    const c = zonalClimate(24, 12);
    return { ...c, id, sourceTime, params: { ...c.params, axialTilt: tilt } };
  };

  it('picks the nearest older climate and never a future one when an older exists', () => {
    const shelf = new ClimateShelf(1e9);
    shelf.add(mk(1, 0));
    shelf.add(mk(2, 50));
    shelf.add(mk(3, 100));
    expect(shelf.forTime(75)!.id).toBe(2);
    expect(shelf.forTime(100)!.id).toBe(3);
    expect(shelf.forTime(1000)!.id).toBe(3);
    expect(shelf.latest()!.id).toBe(3);
    shelf.dropAfter(60);
    expect(shelf.count).toBe(2);
    expect(shelf.forTime(75)!.id).toBe(2);
  });

  it('falls back to the closest when all are younger; evicts by bytes; drops other physics', () => {
    const one = climateBytes(mk(1, 0));
    const shelf = new ClimateShelf(one * 2.5);
    shelf.add(mk(1, 30));
    shelf.add(mk(2, 40));
    expect(shelf.forTime(10)!.id).toBe(1);
    shelf.add(mk(3, 50));
    expect(shelf.count).toBe(2);
    expect(shelf.forTime(0)!.id).toBe(2);
    shelf.add(mk(4, 60, 40));
    expect(shelf.count).toBe(1);
    expect(shelf.latest()!.id).toBe(4);
    shelf.clear();
    expect(shelf.forTime(0)).toBeNull();
  });
});

describe('snapshot bytes', () => {
  it('counts the per-cell arrays', () => {
    const s = syntheticSnapshot(smallMesh(4000), 1, 6);
    expect(snapshotBytes(s)).toBeGreaterThan(4000 * 16);
  });
});
