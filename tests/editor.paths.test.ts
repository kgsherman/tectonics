import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/constants';
import { angleBetween, latLonToVec } from '../src/core/math3';
import type { Vec3 } from '../src/core/types';
import { cellsInsidePolygon, pathCells } from '../src/editor/paths';
import { BRUSH_MAX_KM, BRUSH_MIN_KM } from '../src/editor/editorConstants';
import { BRUSH_SLIDER_MAX, keyAction, kmToSlider, sliderToKm, stepBrushKm, toolForKey, TOOLS } from '../src/editor/tools';
import { smallMesh } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);

function isAdjacent(a: number, b: number): boolean {
  for (let e = mesh.adjOffset[a]; e < mesh.adjOffset[a + 1]; e++) if (mesh.adj[e] === b) return true;
  return false;
}

function circle(c: [number, number], rDeg: number, n = 60): Vec3[] {
  const center = ll(c[0], c[1]);
  // Build a small circle around `center` in its tangent frame.
  const up: Vec3 = Math.abs(center[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(up, center));
  const e2 = cross(center, e1);
  const out: Vec3[] = [];
  const r = rDeg * DEG;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 2 * Math.PI;
    const t = [Math.cos(a) * Math.sin(r), Math.sin(a) * Math.sin(r)];
    out.push(normalize([
      center[0] * Math.cos(r) + e1[0] * t[0] + e2[0] * t[1],
      center[1] * Math.cos(r) + e1[1] * t[0] + e2[1] * t[1],
      center[2] * Math.cos(r) + e1[2] * t[0] + e2[2] * t[1],
    ]));
  }
  return out;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
}

describe('pathCells', () => {
  it('returns a chain of mesh-adjacent cells along the path (watertight cut)', () => {
    const cells = pathCells(mesh, [ll(-40, -30), ll(10, 20), ll(60, 170)]);
    expect(cells.length).toBeGreaterThan(20);
    for (let k = 1; k < cells.length; k++) expect(isAdjacent(cells[k - 1], cells[k])).toBe(true);
  });

  it('breaks at null points and can close the loop', () => {
    const open = pathCells(mesh, [ll(0, 0), ll(0, 20), null, ll(30, 0), ll(30, 20)]);
    const p = (i: number): Vec3 => [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
    // Nothing between the two segments.
    expect(open.some((i) => angleBetween(p(i), ll(15, 10)) < 5 * DEG)).toBe(false);
    const closed = pathCells(mesh, [ll(0, 0), ll(0, 20), ll(20, 20)], true);
    expect(closed.some((i) => angleBetween(p(i), ll(10, 10)) < 2 * DEG)).toBe(true);
  });
});

describe('cellsInsidePolygon', () => {
  const capCount = (rDeg: number) => ((1 - Math.cos(rDeg * DEG)) / 2) * mesh.n;

  it('finds the cells of a spherical cap, across the antimeridian', () => {
    const inside = cellsInsidePolygon(mesh, circle([10, 180], 15));
    expect(inside.length / capCount(15)).toBeGreaterThan(0.9);
    expect(inside.length / capCount(15)).toBeLessThan(1.1);
    for (const i of inside) {
      const p: Vec3 = [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
      expect(angleBetween(p, ll(10, 180))).toBeLessThan(15.5 * DEG);
    }
  });

  it('works around a pole and for large loops', () => {
    const pole = cellsInsidePolygon(mesh, circle([90, 0], 25));
    expect(pole.length / capCount(25)).toBeGreaterThan(0.9);
    expect(pole.length / capCount(25)).toBeLessThan(1.1);
    const big = cellsInsidePolygon(mesh, circle([-20, 60], 70, 120));
    expect(big.length / capCount(70)).toBeGreaterThan(0.93);
    expect(big.length / capCount(70)).toBeLessThan(1.07);
  });

  it('handles concave (crescent) outlines', () => {
    // A "C" shape: outer arc radius 20°, inner arc radius 10°, open to the east.
    const c = [0, 0] as [number, number];
    const outer = circle(c, 20, 72).slice(9, 64);
    const inner = circle(c, 10, 72).slice(9, 64).reverse();
    const inside = new Set(cellsInsidePolygon(mesh, [...outer, ...inner]));
    const probe = (lat: number, lon: number) => {
      let best = -1, bd = Infinity;
      const q = ll(lat, lon);
      for (let i = 0; i < mesh.n; i++) {
        const d = angleBetween([mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]], q);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return inside.has(best);
    };
    expect(probe(0, 0)).toBe(false); // the hollow of the C
    expect(probe(0, -15)).toBe(true); // the back of the C
  });
});

describe('tool helpers', () => {
  it('maps keys to tools (case-insensitive) with unique shortcuts', () => {
    expect(toolForKey('b')).toBe('plate');
    expect(toolForKey('C')).toBe('continent');
    expect(toolForKey('v')).toBe('motion');
    expect(toolForKey('d')).toBe('seeds');
    expect(toolForKey('q')).toBeNull();
    expect(new Set(TOOLS.map((t) => t.key)).size).toBe(TOOLS.length);
    for (const k of ['B', 'C', 'R', 'F', 'S', 'L', 'V', 'D']) expect(toolForKey(k)).not.toBeNull();
  });

  it('brush slider is logarithmic, monotone and round-trips', () => {
    expect(sliderToKm(0)).toBe(BRUSH_MIN_KM);
    expect(sliderToKm(BRUSH_SLIDER_MAX)).toBe(BRUSH_MAX_KM);
    let prev = 0;
    for (let v = 0; v <= BRUSH_SLIDER_MAX; v += 50) {
      const km = sliderToKm(v);
      expect(km).toBeGreaterThanOrEqual(prev);
      prev = km;
      expect(Math.abs(sliderToKm(kmToSlider(km)) - km) / km).toBeLessThan(0.05);
    }
  });

  it('[ and ] step the brush size and clamp', () => {
    expect(stepBrushKm(600, 1)).toBe(750);
    expect(stepBrushKm(600, -1)).toBe(480);
    expect(stepBrushKm(BRUSH_MAX_KM, 1)).toBe(BRUSH_MAX_KM);
    expect(stepBrushKm(BRUSH_MIN_KM, -1)).toBe(BRUSH_MIN_KM);
  });

  it('keyboard map: tools, brush size, undo/redo, escape, enter, X', () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
      ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    const idle = { tool: 'plate' as const, busy: false };
    expect(keyAction(k('z', { ctrlKey: true }), idle)).toEqual({ kind: 'undo' });
    expect(keyAction(k('Z', { ctrlKey: true, shiftKey: true }), idle)).toEqual({ kind: 'redo' });
    expect(keyAction(k('z', { metaKey: true }), idle)).toEqual({ kind: 'undo' });
    expect(keyAction(k('y', { ctrlKey: true }), idle)).toEqual({ kind: 'redo' });
    expect(keyAction(k('['), idle)).toEqual({ kind: 'brush', dir: -1 });
    expect(keyAction(k(']'), idle)).toEqual({ kind: 'brush', dir: 1 });
    expect(keyAction(k('l'), idle)).toEqual({ kind: 'tool', tool: 'lasso' });
    expect(keyAction(k('S', { shiftKey: true }), idle)).toEqual({ kind: 'tool', tool: 'split' });
    expect(keyAction(k('b', { ctrlKey: true }), idle)).toBeNull();
    expect(keyAction(k('b', { altKey: true }), idle)).toBeNull();
    expect(keyAction(k('Escape'), idle)).toBeNull();
    expect(keyAction(k('Escape'), { tool: 'plate', busy: true })).toEqual({ kind: 'cancel' });
    expect(keyAction(k('Enter'), idle)).toBeNull();
    expect(keyAction(k('Enter'), { tool: 'seeds', busy: false })).toEqual({ kind: 'generateSeeds' });
    expect(keyAction(k('x'), { tool: 'continent', busy: false })).toEqual({ kind: 'toggleContinent' });
    expect(keyAction(k('x'), idle)).toBeNull();
    expect(keyAction(k(' '), idle)).toBeNull();
    expect(keyAction(k('Shift'), idle)).toBeNull();
  });
});
