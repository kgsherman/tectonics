import { describe, expect, it } from 'vitest';
import { earthSnapshot } from '../scripts/lib/earthWorld';
import { CRUST_CONTINENTAL } from '../src/core/types';
import { smallMesh } from './helpers/fixtures';

describe('earthSnapshot', () => {
  it('builds a one-plate Earth snapshot with an Earth-like land fraction', () => {
    const mesh = smallMesh(20000);
    const s = earthSnapshot(mesh);
    expect(s.n).toBe(mesh.n);
    expect(s.plates.length).toBe(1);
    let land = 0, cont = 0;
    for (let i = 0; i < s.n; i++) {
      expect(Number.isFinite(s.elev[i])).toBe(true);
      if (s.elev[i] > 0) land++;
      if (s.crust[i] === CRUST_CONTINENTAL) cont++;
    }
    // Fibonacci cells are equal-area: plain fractions are area fractions.
    expect(land / s.n).toBeGreaterThan(0.26);
    expect(land / s.n).toBeLessThan(0.32);
    expect(cont).toBeGreaterThan(land); // shelves are continental crust
  });
});
