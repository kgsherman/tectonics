import { describe, expect, it } from 'vitest';
import { smallMesh, syntheticSnapshot, twoPlateDraft, zonalClimate, zonalDynamics } from './helpers/fixtures';

describe('fixtures', () => {
  it('build without throwing and are finite', () => {
    const mesh = smallMesh();
    const s = syntheticSnapshot(mesh, 3);
    expect(s.plates.length).toBe(8);
    expect(s.elev.every(Number.isFinite)).toBe(true);
    const cont = s.crust.reduce((a, b) => a + b, 0) / s.n;
    expect(cont).toBeGreaterThan(0.1);
    expect(cont).toBeLessThan(0.6);
    const d1 = twoPlateDraft(mesh, 'transform');
    const d2 = twoPlateDraft(mesh, 'cap');
    expect(d1.plate.some((k) => k === 1)).toBe(true);
    expect(d2.plate.some((k) => k === 1)).toBe(true);
    const dyn = zonalDynamics(90, 45);
    expect(dyn.temp.every(Number.isFinite)).toBe(true);
    const c = zonalClimate(90, 45);
    expect(c.koppenAll.every((k) => k > 0)).toBe(true);
    expect(c.koppen.some((k) => k > 0)).toBe(true);
  });
});
