/**
 * Pipeline stage runner for the headless tools: times a stage, catches its failure and classifies it,
 * so a pipeline can keep going while other modules are still contract stubs.
 */

export type StageStatus = 'ok' | 'fallback' | 'not-implemented' | 'error' | 'skipped';

export interface StageReport {
  status: StageStatus;
  ms: number;
  /** Error message (for not-implemented / error / fallback). */
  message?: string;
  /** What was used instead when status is 'fallback'. */
  fallback?: string;
}

export type StageLog = Record<string, StageReport>;

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/** True for the contract stubs' `throw new Error('not implemented')`. */
export function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && /not implemented/i.test(e.message);
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Run `fn` as stage `name`. On failure, runs `fallback` (if given) and records status 'fallback';
 * otherwise records 'not-implemented' / 'error' and returns undefined. Never throws for stage errors
 * (a throwing fallback is recorded as an error too). `fn` may be async (e.g. a dynamic import of a
 * module that is still being written).
 */
export async function runStage<T>(
  log: StageLog,
  name: string,
  fn: () => T | Promise<T>,
  fallback?: { label: string; run: () => T | Promise<T> },
  verbose = true,
): Promise<T | undefined> {
  const t0 = now();
  try {
    const v = await fn();
    log[name] = { status: 'ok', ms: now() - t0 };
    if (verbose) console.log(`  ${name}: ok (${(now() - t0).toFixed(0)} ms)`);
    return v;
  } catch (e) {
    const primary = isNotImplemented(e) ? 'not implemented yet' : describe(e);
    if (!isNotImplemented(e) && verbose) console.error(e);
    if (fallback) {
      try {
        const v = await fallback.run();
        log[name] = { status: 'fallback', ms: now() - t0, message: primary, fallback: fallback.label };
        if (verbose) console.log(`  ${name}: ${primary} → fallback: ${fallback.label} (${(now() - t0).toFixed(0)} ms)`);
        return v;
      } catch (e2) {
        if (verbose) console.error(e2);
        log[name] = { status: 'error', ms: now() - t0, message: `${primary}; fallback failed: ${describe(e2)}` };
        if (verbose) console.log(`  ${name}: FAILED (${log[name].message})`);
        return undefined;
      }
    }
    log[name] = { status: isNotImplemented(e) ? 'not-implemented' : 'error', ms: now() - t0, message: primary };
    if (verbose) console.log(`  ${name}: ${log[name].status} (${primary})`);
    return undefined;
  }
}

export function skipStage(log: StageLog, name: string, reason: string, verbose = true): void {
  log[name] = { status: 'skipped', ms: 0, message: reason };
  if (verbose) console.log(`  ${name}: skipped (${reason})`);
}
