/**
 * Stateless per-cell random numbers for stochastic per-cell processes: independent of loop order,
 * so passes may visit cells in any order and step(k) ≡ k × step(1) stays exact.
 */
export function hash01(seed: number, step: number, a: number, b: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15) ^ (step | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ (a | 0), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16) ^ (b | 0), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
