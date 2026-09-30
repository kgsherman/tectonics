import { describe, expect, it } from 'vitest';
import { climographScale, nicePrecipMax } from '../src/app/climographScale';
import { cloudSpec, currentFieldSpec, monthField, solarDeclination, windFieldSpec } from '../src/app/climateFields';
import { compass, fmtElev, fmtLat, fmtLon, fmtMyr, fmtNum, fmtPlateSpeed, monthLabel } from '../src/app/format';
import { inspectAt } from '../src/app/inspect';
import { exportName } from '../src/app/exportImage';
import { layerShortcut, layerShortLabel, LAYER_GROUPS, LAYER_SWATCH } from '../src/app/layerMeta';
import { labelIndices } from '../src/app/ui/legendView';
import { LAYER_ORDER } from '../src/worker/layerInfo';
import { snapshotFromDraft } from '../src/tectonics/draft';
import { BOUNDARY_CONVERGENT } from '../src/core/types';
import { smallMesh, syntheticSnapshot, twoPlateDraft, zonalClimate } from './helpers/fixtures';

describe('climograph scale', () => {
  it('spans 0 °C and ≥ 30 °C in steps of 10 and a nice precipitation max', () => {
    const t = [-25, -22, -12, 0, 8, 14, 17, 15, 8, -2, -14, -22];
    const p = [20, 18, 25, 30, 45, 70, 90, 80, 55, 40, 30, 25];
    const s = climographScale(t, p);
    expect(s.tMin).toBe(-30);
    expect(s.tMax).toBe(20);
    expect(s.tTicks).toEqual([-30, -20, -10, 0, 10, 20]);
    expect(s.pMax).toBe(100);
    expect(s.pTicks[0]).toBe(0);
    expect(s.pTicks[s.pTicks.length - 1]).toBe(100);
    expect(s.pTicks.length).toBeLessThanOrEqual(6);
    for (const v of t) {
      expect(s.tFrac(v)).toBeGreaterThanOrEqual(0);
      expect(s.tFrac(v)).toBeLessThanOrEqual(1);
    }
    expect(s.pFrac(1e9)).toBe(1);
  });

  it('handles hot, wet, dry and degenerate inputs', () => {
    const hot = climographScale(new Array(12).fill(28), new Array(12).fill(420));
    expect(hot.tMin).toBe(0);
    expect(hot.tMax).toBe(30);
    expect(hot.pMax).toBe(500);
    const dry = climographScale(new Array(12).fill(20), new Array(12).fill(0));
    expect(dry.pMax).toBe(50);
    const nan = climographScale([NaN, NaN], [NaN]);
    expect(nan.tMax - nan.tMin).toBeGreaterThanOrEqual(30);
    expect(nan.tFrac(NaN)).toBe(0);
    expect(nicePrecipMax(7000)).toBe(7000);
    expect(nicePrecipMax(123)).toBe(150);
  });
});

describe('format', () => {
  it('formats readouts', () => {
    expect(fmtNum(-3.14159, 2)).toBe('−3.14');
    expect(fmtNum(-0.001, 1)).toBe('0.0');
    expect(fmtNum(NaN)).toBe('—');
    expect(fmtNum(12345)).toBe('12,345');
    expect(fmtElev(-4200)).toContain('−4,200');
    expect(fmtMyr(12.34)).toContain('12.3');
    expect(fmtPlateSpeed(50)).toContain('5.0');
    expect(fmtLat(-Math.PI / 4)).toBe('45.0°S');
    expect(fmtLon(Math.PI)).toBe('180.0°W');
    expect(fmtLon(0.5)).toBe('28.6°E');
    expect(monthLabel(-1)).toBe('Annual');
    expect(monthLabel(6)).toBe('Jul');
    expect(compass(0)).toBe('N');
    expect(compass(225)).toBe('SW');
    expect(compass(-45)).toBe('NW');
  });
});

describe('climate-derived view fields', () => {
  const c = zonalClimate(36, 18);
  const n = c.w * c.h;

  it('slices months without copying and averages the annual view', () => {
    const jan = monthField(c.windU, n, 0);
    expect(jan.buffer).toBe(c.windU.buffer);
    expect(jan.length).toBe(n);
    const annual = monthField(c.windU, n, -1);
    let s = 0;
    for (let m = 0; m < 12; m++) s += c.windU[m * n + 5];
    expect(annual[5]).toBeCloseTo(s / 12, 5);
    expect(() => monthField(new Float32Array(5), n, 0)).toThrow();
  });

  it('builds particle and cloud specs; currents are NaN on land only', () => {
    const w = windFieldSpec(c, 3);
    expect(w).toMatchObject({ kind: 'wind', w: c.w, h: c.h });
    const cur = currentFieldSpec(c, 3);
    for (let i = 0; i < n; i++) {
      if (c.land[i]) expect(Number.isNaN(cur.u[i])).toBe(true);
      else expect(Number.isFinite(cur.u[i]) && Number.isFinite(cur.v[i])).toBe(true);
    }
    expect(c.currentU[3 * n]).not.toBeNaN(); // source untouched
    const cl = cloudSpec(c, -1);
    expect(cl.cover.length).toBe(n);
    expect(cl.u?.length).toBe(n);
    const thin = cloudSpec(c, 2, 0.5);
    const full = cloudSpec(c, 2);
    expect(full.cover.buffer).toBe(c.cloud.buffer);
    for (let i = 0; i < n; i += 37) expect(thin.cover[i]).toBeCloseTo(full.cover[i] * 0.5, 6);
  });

  it('declination follows the seasons', () => {
    const tilt = 23.44;
    expect(solarDeclination(-1, tilt)).toBe(0);
    expect((solarDeclination(5, tilt) * 180) / Math.PI).toBeGreaterThan(22);
    expect((solarDeclination(11, tilt) * 180) / Math.PI).toBeLessThan(-22);
    expect(Math.abs((solarDeclination(2, tilt) * 180) / Math.PI)).toBeLessThan(3);
    expect(solarDeclination(5, 0)).toBe(0);
    expect((solarDeclination(5, 90) * 180) / Math.PI).toBeGreaterThan(80);
  });
});

describe('hover inspector', () => {
  const mesh = smallMesh(4000);

  it('samples plate, crust, motion and climate at a point', () => {
    const snap = syntheticSnapshot(mesh, 3, 8);
    const climate = zonalClimate(90, 45, undefined, {});
    const s = inspectAt({ mesh, snapshot: snap, climate, heightMap: null, month: 6, seaLevel: 0 }, 0.3, 1.2);
    expect(s.tectonic).not.toBeNull();
    const t = s.tectonic!;
    expect(t.plateName.length).toBeGreaterThan(0);
    expect(t.speed).toBeGreaterThanOrEqual(0);
    expect(t.bearing).toBeGreaterThanOrEqual(0);
    expect(t.bearing).toBeLessThan(360);
    expect(s.elevation).toBe(t.meshElevation);
    expect(s.climate).not.toBeNull();
    const k = s.climate!;
    expect(k.temp).toHaveLength(12);
    expect(k.code.length).toBeGreaterThan(0);
    expect(k.monthTemp).toBeCloseTo(k.temp[6], 5);
    for (const v of [k.tempAnnual, k.precipAnnual, k.sst, k.windSpeed, k.pressure, k.cloud]) expect(Number.isFinite(v)).toBe(true);
  });

  it('prefers the displayed height map and lapse-corrects the climate to it', () => {
    const snap = syntheticSnapshot(mesh, 3, 8);
    const climate = zonalClimate(90, 45);
    const w = 64, h = 32;
    const low = { data: new Float32Array(w * h).fill(10), w, h };
    const high = { data: new Float32Array(w * h).fill(3010), w, h };
    const a = inspectAt({ mesh, snapshot: snap, climate, heightMap: low, month: -1, seaLevel: 0 }, 0.2, 0.2);
    const b = inspectAt({ mesh, snapshot: snap, climate, heightMap: high, month: -1, seaLevel: 0 }, 0.2, 0.2);
    expect(a.elevation).toBe(10);
    expect(a.land).toBe(true);
    expect(b.elevation).toBe(3010);
    expect(a.climate!.tempAnnual - b.climate!.tempAnnual).toBeCloseTo(3000 * 0.0065, 1);
  });

  it('reports the boundary type and works with partial data', () => {
    const draft = twoPlateDraft(mesh, 'cap', { speed: 60 });
    const snap = snapshotFromDraft(mesh, draft);
    let conv = -1;
    for (let i = 0; i < mesh.n && conv < 0; i++) if (snap.boundary[i] === BOUNDARY_CONVERGENT) conv = i;
    expect(conv).toBeGreaterThanOrEqual(0);
    const s = inspectAt({ mesh, snapshot: snap, climate: null, heightMap: null, month: -1, seaLevel: 0 }, mesh.lat[conv], mesh.lon[conv]);
    expect(s.tectonic!.boundary).toBe('convergent');
    expect(s.climate).toBeNull();
    const empty = inspectAt({ mesh: null, snapshot: null, climate: null, heightMap: null, month: -1, seaLevel: 0 }, 0, 0);
    expect(empty).toMatchObject({ elevation: null, tectonic: null, climate: null });
  });
});

describe('legend & layer metadata', () => {
  it('thins gradient labels, keeping both ends and never crowding the last', () => {
    expect(labelIndices(0)).toEqual([]);
    expect(labelIndices(1)).toEqual([0]);
    expect(labelIndices(5)).toEqual([0, 1, 2, 3, 4]);
    const many = labelIndices(12);
    expect(many[0]).toBe(0);
    expect(many[many.length - 1]).toBe(11);
    expect(many.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < many.length; i++) expect(many[i] - many[i - 1]).toBeGreaterThanOrEqual(1.5);
  });

  it('groups every layer exactly once, with swatches and shortcuts 1–9', () => {
    const grouped = LAYER_GROUPS.flatMap((g) => g.layers);
    expect(new Set(grouped)).toEqual(new Set(LAYER_ORDER));
    expect(grouped).toHaveLength(LAYER_ORDER.length);
    for (const l of LAYER_ORDER) {
      expect(LAYER_SWATCH[l]).toMatch(/gradient/);
      expect(layerShortLabel(l).length).toBeLessThanOrEqual(13);
    }
    expect(layerShortcut(LAYER_ORDER[0])).toBe('1');
    expect(layerShortcut(LAYER_ORDER[8])).toBe('9');
    expect(layerShortcut(LAYER_ORDER[11])).toBe('');
  });

  it('export file names', () => {
    expect(exportName('satellite', 123.6)).toBe('worldgen-satellite-t124Myr.png');
  });
});

describe('review regressions: inspector over the sea', () => {
  it('reports Ocean instead of a land Köppen class where the displayed surface is sea', () => {
    const mesh = smallMesh(4000);
    const snap = syntheticSnapshot(mesh, 3, 8);
    const climate = zonalClimate(90, 45);
    const w = 64, h = 32;
    const sea = { data: new Float32Array(w * h).fill(-2500), w, h };
    const land = { data: new Float32Array(w * h).fill(300), w, h };
    const a = inspectAt({ mesh, snapshot: snap, climate, heightMap: sea, month: 0, seaLevel: 0 }, 0.1, 0.4);
    expect(a.land).toBe(false);
    expect(a.climate!.code).toBe('Ocean');
    expect(a.climate!.koppenId).toBe(0);
    const b = inspectAt({ mesh, snapshot: snap, climate, heightMap: land, month: 0, seaLevel: 0 }, 0.1, 0.4);
    expect(b.land).toBe(true);
    expect(b.climate!.koppenId).toBeGreaterThan(0);
  });
});
