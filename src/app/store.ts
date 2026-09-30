/** Minimal observable store: dispatch through a pure reducer, subscribe, watch derived values. */
export type Listener<S> = (state: S, prev: S) => void;

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(listener: Listener<S>): () => void;
  /**
   * Call `fn(value, prev)` whenever `select(state)` changes (Object.is, or `equal` when given).
   * With `immediate`, also call once now with prev = undefined.
   */
  watch<T>(select: (s: S) => T, fn: (value: T, prev: T | undefined) => void, opts?: { immediate?: boolean; equal?: (a: T, b: T) => boolean }): () => void;
}

export function createStore<S, A>(initial: S, reducer: (s: S, a: A) => S): Store<S, A> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  let dispatching = false;
  const queue: A[] = [];

  function dispatch(action: A): void {
    // Actions dispatched from listeners are queued so every listener sees states in order.
    queue.push(action);
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length) {
        const a = queue.shift()!;
        const prev = state;
        const next = reducer(prev, a);
        if (next === prev) continue;
        state = next;
        for (const l of [...listeners]) l(state, prev);
      }
    } finally {
      dispatching = false;
      queue.length = 0;
    }
  }

  function subscribe(listener: Listener<S>): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function watch<T>(
    select: (s: S) => T,
    fn: (value: T, prev: T | undefined) => void,
    opts: { immediate?: boolean; equal?: (a: T, b: T) => boolean } = {},
  ): () => void {
    const eq = opts.equal ?? Object.is;
    let last = select(state);
    if (opts.immediate) fn(last, undefined);
    return subscribe((s) => {
      const v = select(s);
      if (eq(v, last)) return;
      const p = last;
      last = v;
      fn(v, p);
    });
  }

  return { getState: () => state, dispatch, subscribe, watch };
}

/** Shallow equality of plain objects / arrays (for `watch` on composite selections). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}
