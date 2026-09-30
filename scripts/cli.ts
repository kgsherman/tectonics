/**
 * Tiny `--key value` / `--flag` argument parser for the headless scripts.
 * Values are coerced to the type of the default (number / boolean / string).
 */
export type ArgValue = string | number | boolean;

export function parseArgs<T extends Record<string, ArgValue>>(argv: string[], defaults: T): T {
  const out: Record<string, ArgValue> = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" (expected --key value)`);
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!(key in defaults)) throw new Error(`unknown option --${key}; known: ${Object.keys(defaults).map((k) => `--${k}`).join(' ')}`);
    const def = defaults[key];
    let raw: string | undefined = eq > 0 ? a.slice(eq + 1) : undefined;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (typeof def === 'boolean' && (next === undefined || next.startsWith('--'))) {
        out[key] = true;
        continue;
      }
      raw = next;
      i++;
    }
    if (raw === undefined) throw new Error(`--${key} needs a value`);
    if (typeof def === 'number') {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`--${key} expects a number, got "${raw}"`);
      out[key] = v;
    } else if (typeof def === 'boolean') {
      out[key] = raw === 'true' || raw === '1' || raw === 'yes';
    } else {
      out[key] = raw;
    }
  }
  return out as T;
}
