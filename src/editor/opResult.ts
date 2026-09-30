import type { TopologyResult } from './plateOps';

export interface OpResult {
  /** False when the operation was refused (nothing changed). */
  ok: boolean;
  /** Human-readable outcome for the status line. */
  message: string;
  /** Ids of plates created / removed by the operation. */
  created: number[];
  removed: number[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Status text including what topology maintenance did behind the scenes. */
function withTopology(message: string, topo?: TopologyResult): string {
  if (!topo) return message;
  const parts = [message];
  if (topo.created.length) parts.push(`${plural(topo.created.length, 'new plate', 'new plates')}`);
  if (topo.removed.length) parts.push(`${plural(topo.removed.length, 'empty plate', 'empty plates')} removed`);
  if (topo.merged) parts.push(`${plural(topo.merged, 'stray sliver', 'stray slivers')} tidied into neighbours`);
  return parts.join(' · ');
}

export function ok(message: string, topo?: TopologyResult, created: number[] = []): OpResult {
  return { ok: true, message: withTopology(message, topo), created: [...created, ...(topo?.created ?? [])], removed: topo?.removed ?? [] };
}

export function refuse(message: string): OpResult {
  return { ok: false, message, created: [], removed: [] };
}
