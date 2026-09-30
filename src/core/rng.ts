import type { Vec3 } from './types';

/** 32-bit string hash (cyrb53 truncated to 32 bits) for turning text seeds into numbers. */
export function hashString(s: string): number {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Deterministic seeded PRNG (sfc32 seeded through splitmix32). Same seed => same sequence on every platform. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private readonly seed: number;

  constructor(seed: number) {
    // Accept any finite number (fractions/negatives folded in deterministically).
    const s = Number.isFinite(seed) ? seed : 0;
    const folded = (Math.floor(s) ^ Math.floor((s - Math.floor(s)) * 4294967296)) >>> 0;
    this.seed = folded;
    const sm = splitmix32(folded);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  private nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform [min, max). */
  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  /** Gaussian (Box-Muller). */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Uniformly distributed unit vector on the sphere. */
  unitVector(): Vec3 {
    const z = 2 * this.next() - 1;
    const phi = 2 * Math.PI * this.next();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  }

  /** Independent child stream derived from this seed and a salt (does not advance this stream). */
  fork(salt: number): Rng {
    const h = hashString(`${this.seed}:${salt}`);
    return new Rng(h);
  }
}
