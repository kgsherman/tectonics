/**
 * A coalesced "run once on the next frame" callback that never stalls. requestAnimationFrame is
 * paused while the page is hidden (background tab, minimized or occluded window), which used to leave
 * a history scrub (or a hover refresh) pending until the page was shown again. Here the callback
 * runs on whichever comes first: the next animation frame, or a fallback — a MessageChannel
 * macrotask right away when the page is hidden (setTimeout is clamped to ≥ 1 s in background tabs),
 * else a short timeout. When the timeout had to fire although rAF was requested, animation frames
 * are stalled (a page that reports itself visible but does not paint): later runs go straight to the
 * macrotask until an animation frame shows up again, so frame pacing never throttles such a page.
 */
export interface FrameEnv {
  /** requestAnimationFrame / cancelAnimationFrame; absent outside browsers. */
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** Run `fn` in a soon-as-possible macrotask (not throttled in hidden pages). */
  macrotask?: (fn: () => void) => void;
  /** The page is hidden (rAF will not fire). */
  hidden?: () => boolean;
}

/** Fallback delay (ms) when rAF does not fire on a visible page. */
export const FRAME_FALLBACK_MS = 100;

let sharedMacrotask: ((fn: () => void) => void) | undefined;

function channelMacrotask(): ((fn: () => void) => void) | undefined {
  if (sharedMacrotask || typeof MessageChannel === 'undefined') return sharedMacrotask;
  const ch = new MessageChannel();
  const queue: Array<() => void> = [];
  ch.port1.onmessage = () => queue.shift()?.();
  sharedMacrotask = (fn) => {
    queue.push(fn);
    ch.port2.postMessage(0);
  };
  return sharedMacrotask;
}

export function browserFrameEnv(): FrameEnv {
  const g = globalThis as typeof globalThis & { document?: Document };
  return {
    raf: typeof g.requestAnimationFrame === 'function' ? (cb) => g.requestAnimationFrame(() => cb()) : undefined,
    caf: typeof g.cancelAnimationFrame === 'function' ? (id) => g.cancelAnimationFrame(id) : undefined,
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id as ReturnType<typeof setTimeout>),
    macrotask: channelMacrotask(),
    hidden: () => g.document?.visibilityState === 'hidden',
  };
}

export class FrameTask {
  private pending = false;
  /** Outstanding animation-frame request (at most one). */
  private rafId = 0;
  private timer: unknown = null;
  /** The last fallback fired while an animation frame was requested: rAF is not running. */
  private stalled = false;

  constructor(
    private readonly fn: () => void,
    private readonly env: FrameEnv = browserFrameEnv(),
    private readonly fallbackMs = FRAME_FALLBACK_MS,
  ) {}

  get scheduled(): boolean {
    return this.pending;
  }

  /** Animation frames are not arriving (diagnostics). */
  get rafStalled(): boolean {
    return this.stalled;
  }

  /** Run `fn` once, soon; repeated calls before it runs coalesce. */
  schedule(): void {
    if (this.pending) return;
    this.pending = true;
    const env = this.env;
    const hidden = env.hidden?.() ?? false;
    if ((hidden || this.stalled) && env.macrotask) {
      env.macrotask(this.run);
      // Visible but stalled: keep one frame request out to notice when painting resumes.
      if (!hidden) this.requestFrame();
      return;
    }
    this.requestFrame();
    this.timer = env.setTimeout(this.onTimeout, env.raf ? this.fallbackMs : 0);
  }

  cancel(): void {
    if (!this.pending) return;
    this.pending = false;
    this.clearTimer();
  }

  private requestFrame(): void {
    if (this.env.raf && !this.rafId) this.rafId = this.env.raf(this.onFrame);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly onFrame = (): void => {
    this.rafId = 0;
    this.stalled = false;
    this.run();
  };

  private readonly onTimeout = (): void => {
    this.timer = null;
    if (this.pending && this.rafId) this.stalled = true;
    this.run();
  };

  private readonly run = (): void => {
    if (!this.pending) return;
    this.pending = false;
    this.clearTimer();
    this.fn();
  };
}
