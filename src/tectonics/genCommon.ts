import { Rng } from '../core/rng';
import type { RGB, SphereMesh } from '../core/types';

// Leaf helpers shared by draft.ts (which re-exports them) and the gen* modules. Kept dependency-free
// (core only) so the generator modules never import draft.ts, avoiding an import cycle with
// finalizeDraft / resampleDraft.

const PALETTE: RGB[] = [
  [230, 97, 84], [72, 152, 214], [245, 181, 66], [104, 186, 110], [166, 110, 204], [64, 196, 190],
  [236, 132, 176], [150, 172, 64], [238, 146, 70], [96, 120, 222], [196, 84, 128], [120, 200, 160],
  [214, 196, 92], [84, 164, 150], [206, 120, 88], [140, 140, 230], [110, 206, 222], [226, 110, 214],
  [176, 146, 104], [96, 180, 84], [240, 206, 150], [124, 104, 170], [206, 70, 70], [70, 120, 150],
];

function hslToRgb(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Distinct, pleasant plate color for the k-th plate (cycles a curated palette, then golden-angle hues). */
export function plateColor(k: number): RGB {
  const i = Math.max(0, Math.floor(k));
  if (i < PALETTE.length) return [...PALETTE[i]] as RGB;
  const h = (i * 0.61803398875) % 1;
  const l = 0.5 + 0.12 * (((i * 7) % 3) - 1);
  return hslToRgb(h, 0.55, l);
}

const SYL_A = ['Ka', 'Tho', 'Ve', 'Mar', 'Ise', 'Or', 'Lu', 'Sa', 'Dra', 'Ny', 'Pel', 'Qua', 'Ro', 'Tir', 'Ul', 'Ze', 'Aru', 'Bel', 'Cor', 'Hes'];
const SYL_B = ['ra', 'len', 'thi', 'mos', 'dar', 'nia', 'vel', 'ros', 'ka', 'tan', 'lis', 'gor', 'phe', 'dun', 'mar', 'sen'];
const SYL_C = ['', 'an', 'ic', 'ia', 'ean', 'ine', 'is', 'on'];

/** Evocative plate name for the k-th plate, deterministic in (k, seed). */
export function plateName(k: number, seed: number): string {
  const r = new Rng(((seed | 0) * 7919 + k * 104729 + 17) >>> 0);
  const name = r.pick(SYL_A) + r.pick(SYL_B) + r.pick(SYL_C);
  return `${name} Plate`;
}

/**
 * Ocean-floor depth (m, negative) for crust of the given age (Myr): GDH1 plate-cooling model
 * (Stein & Stein 1992): 2600 + 365·sqrt(t) for t < 20 Myr, 5651 − 2473·exp(−0.0278·t) after.
 */
export function oceanDepthForAge(ageMyr: number): number {
  const t = Math.max(0, ageMyr);
  if (t < 20) return -(2600 + 365 * Math.sqrt(t));
  return -(5651 - 2473 * Math.exp(-0.0278 * t));
}

/** Keep only the largest connected component of each label; reassign the rest by flood fill from neighbors. */
export function enforceConnectivity(mesh: SphereMesh, label: Int16Array, numLabels: number): void {
  const { n, adjOffset, adj } = mesh;
  const comp = new Int32Array(n).fill(-1);
  const compSize: number[] = [];
  const compLabel: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || label[s] < 0) continue;
    const c = compSize.length;
    const lab = label[s];
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = c;
    while (head < tail) {
      const i = queue[head++];
      for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
        const j = adj[k];
        if (comp[j] < 0 && label[j] === lab) {
          comp[j] = c;
          queue[tail++] = j;
        }
      }
    }
    compSize.push(tail);
    compLabel.push(lab);
  }
  const bestComp = new Int32Array(numLabels).fill(-1);
  for (let c = 0; c < compSize.length; c++) {
    const lab = compLabel[c];
    if (lab < 0 || lab >= numLabels) continue;
    if (bestComp[lab] < 0 || compSize[c] > compSize[bestComp[lab]]) bestComp[lab] = c;
  }
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const lab = label[i];
    if (lab >= 0 && lab < numLabels && comp[i] !== bestComp[lab]) label[i] = -1;
  }
  // Multi-source BFS from labeled cells into unlabeled ones. Each cell is queued at most once (a cell
  // queued once per labeled neighbour overflowed the n-slot queue when > ~n/3 cells were unlabeled).
  const queued = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0) continue;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      if (label[adj[k]] >= 0) {
        queue[tail++] = i;
        queued[i] = 1;
        break;
      }
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    if (label[i] >= 0) continue;
    // Take the most common labeled neighbor.
    let bestLab = -1, bestCnt = 0;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const lj = label[adj[k]];
      if (lj < 0) continue;
      let c = 0;
      for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) if (label[adj[q]] === lj) c++;
      if (c > bestCnt) { bestCnt = c; bestLab = lj; }
    }
    if (bestLab < 0) continue;
    label[i] = bestLab;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      if (label[j] < 0 && !queued[j]) {
        queued[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  for (let i = 0; i < n; i++) if (label[i] < 0) label[i] = 0;
}
