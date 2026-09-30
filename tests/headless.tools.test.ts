import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../scripts/cli';
import {
  applyCombo, combinations, formatTable, getPath, gridSize, parseRanges, rankRows, runSweep, setPath,
} from '../scripts/lib/calibration';
import { areaMean, cellAt, monthSlice, parseSize, resampleNearest } from '../scripts/lib/gridUtil';
import { isNotImplemented, runStage, type StageLog } from '../scripts/lib/stage';
import { colorAt, colormapImage, createImage, drawArrows, upscale, writePng, type ColorStops } from '../scripts/png';

const SCRATCH = 'scratch/headless/tests';

describe('cli.parseArgs', () => {
  it('coerces by default type and supports --k=v and bare flags', () => {
    const a = parseArgs(['--n', '5', '--name=x', '--fast', '--scale', '2.5'], { n: 1, name: 'a', fast: false, scale: 1 });
    expect(a).toEqual({ n: 5, name: 'x', fast: true, scale: 2.5 });
  });
  it('rejects unknown options and bad numbers', () => {
    expect(() => parseArgs(['--nope', '1'], { n: 1 })).toThrow(/unknown option/);
    expect(() => parseArgs(['--n', 'abc'], { n: 1 })).toThrow(/number/);
  });
});

describe('png helpers', () => {
  it('writes a PNG that decodes to the same pixels', () => {
    mkdirSync(SCRATCH, { recursive: true });
    const img = colormapImage(Float32Array.from([0, 0.5, 1, 1, 0.5, 0]), 3, 2, [[0, [0, 0, 0]], [1, [200, 100, 50]]]);
    const path = join(SCRATCH, 'roundtrip.png');
    writePng(path, img);
    const png = PNG.sync.read(readFileSync(path));
    expect(png.width).toBe(3);
    expect(png.height).toBe(2);
    expect(Array.from(png.data.subarray(0, 12))).toEqual([0, 0, 0, 255, 100, 50, 25, 255, 200, 100, 50, 255]);
  });
  it('maps non-finite values to magenta and clamps outside the stops', () => {
    const stops: ColorStops = [[0, [10, 20, 30]], [10, [110, 120, 130]]];
    expect(colorAt(stops, NaN)).toEqual([255, 0, 255]);
    expect(colorAt(stops, -5)).toEqual([10, 20, 30]);
    expect(colorAt(stops, 50)).toEqual([110, 120, 130]);
    expect(colorAt(stops, 5)).toEqual([60, 70, 80]);
  });
  it('upscales and draws arrows inside the image', () => {
    const img = upscale(createImage(4, 2, [1, 2, 3]), 3);
    expect(img.width).toBe(12);
    expect(img.height).toBe(6);
    const u = new Float32Array(8).fill(5), v = new Float32Array(8);
    drawArrows(img, 4, 2, u, v, 2, 1, [255, 255, 255]);
    let white = 0;
    for (let i = 0; i < img.width * img.height; i++) if (img.rgba[4 * i] === 255) white++;
    expect(white).toBeGreaterThan(0);
  });
});

describe('gridUtil', () => {
  it('area mean of a constant is the constant; masks restrict', () => {
    const f = new Float32Array(36 * 18).fill(7);
    expect(areaMean(f, 36, 18)).toBeCloseTo(7, 6);
    const mask = new Uint8Array(36 * 18);
    f[0] = 100;
    mask[0] = 1;
    expect(areaMean(f, 36, 18, mask)).toBeCloseTo(100, 6);
  });
  it('finds cells, slices months and resamples', () => {
    expect(cellAt(360, 180, 89.9, -179.9)).toBe(0);
    expect(cellAt(360, 180, -89.9, 179.9)).toBe(360 * 180 - 1);
    const monthly = new Float32Array(12 * 2);
    for (let m = 0; m < 12; m++) monthly[m * 2] = m;
    expect(monthSlice(monthly, 2, 3)[0]).toBe(3);
    expect(monthSlice(monthly, 2, -1)[0]).toBeCloseTo(5.5, 6);
    const r = resampleNearest(Uint8Array.from([1, 2, 3, 4]), 2, 2, 4, 4);
    expect(Array.from(r)).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
    expect(parseSize('1024x512')).toEqual([1024, 512]);
    expect(parseSize('2048')).toEqual([2048, 1024]);
    expect(() => parseSize('1024y')).toThrow();
    expect(() => parseSize('x512')).toThrow();
  });
});

describe('stage runner', () => {
  it('classifies not-implemented, errors and fallbacks without throwing', async () => {
    const log: StageLog = {};
    expect(await runStage(log, 'a', () => 1, undefined, false)).toBe(1);
    expect(await runStage(log, 'b', () => { throw new Error('not implemented'); }, undefined, false)).toBeUndefined();
    expect(await runStage(log, 'c', () => { throw new Error('boom'); }, undefined, false)).toBeUndefined();
    expect(await runStage(log, 'd', () => { throw new Error('not implemented'); }, { label: 'fb', run: () => 2 }, false)).toBe(2);
    expect(await runStage(log, 'e', async () => Promise.reject(new Error('x')), { label: 'fb', run: () => { throw new Error('y'); } }, false)).toBeUndefined();
    expect(log.a.status).toBe('ok');
    expect(log.b.status).toBe('not-implemented');
    expect(log.c.status).toBe('error');
    expect(log.d).toMatchObject({ status: 'fallback', fallback: 'fb' });
    expect(log.e.status).toBe('error');
    expect(isNotImplemented(new Error('not implemented'))).toBe(true);
  });
});

describe('calibration machinery', () => {
  it('parses explicit, linear and log ranges', () => {
    const r = parseRanges({ a: [1, 2], b: { from: 0, to: 1, steps: 3 }, c: { from: 1, to: 100, steps: 3, log: true }, d: { values: [5] } });
    expect(r.a).toEqual([1, 2]);
    expect(r.b).toEqual([0, 0.5, 1]);
    expect(r.c[1]).toBeCloseTo(10, 9);
    expect(r.d).toEqual([5]);
    expect(gridSize(r)).toBe(18);
    expect(() => parseRanges({ x: { from: 0, to: 1, steps: 0 } })).toThrow();
    expect(() => parseRanges({ x: [] })).toThrow();
  });
  it('enumerates the full grid or a deterministic sample', () => {
    const r = { a: [1, 2, 3], b: [10, 20] };
    const all = combinations(r, 100);
    expect(all.length).toBe(6);
    expect(new Set(all.map((c) => `${c.a},${c.b}`)).size).toBe(6);
    const s1 = combinations(r, 4, 7), s2 = combinations(r, 4, 7);
    expect(s1).toEqual(s2);
    expect(new Set(s1.map((c) => `${c.a},${c.b}`)).size).toBe(4);
  });
  it('gets/sets dotted paths and restores', () => {
    const t = { x: 1, nested: { y: 2 }, s: 'str' };
    expect(getPath(t, 'nested.y')).toBe(2);
    setPath(t, 'nested.y', 3);
    expect(t.nested.y).toBe(3);
    expect(() => getPath(t, 'nested.z')).toThrow(/not found/);
    expect(() => getPath(t, 's')).toThrow(/not a number/);
    const restore = applyCombo(t, { x: 9, 'nested.y': 8 });
    expect([t.x, t.nested.y]).toEqual([9, 8]);
    restore();
    expect([t.x, t.nested.y]).toEqual([1, 3]);
  });
  it('sweeps with a fake evaluator, restores the target, records failures and ranks', async () => {
    const t = { p: 0, q: 1 };
    const combos = combinations({ p: [1, 2, 3], q: [1] }, 10);
    const rows = await runSweep(t, combos, async () => {
      if (t.p === 2) throw new Error('diverged');
      return { err: Math.abs(t.p - 3) + t.q };
    });
    expect(t).toEqual({ p: 0, q: 1 });
    expect(rows.length).toBe(4);
    expect(rows[0].baseline).toBe(true);
    const ranked = rankRows(rows, (m) => m.err);
    expect(ranked[0].combo.p).toBe(3);
    expect(ranked[ranked.length - 1].error).toBe('diverged');
    expect(formatTable(['a', 'bb'], [['1', '2'], ['333', '4']]).split('\n').length).toBe(4);
  });
});
