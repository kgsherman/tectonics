/**
 * Main-thread presentation of playback frames (pure, DOM-free; tested):
 *  - frames from several painters are shown in show order (PlaybackSequencer): a frame whose
 *    predecessor is still being painted waits up to ~3 frame intervals for it (frames are only
 *    missing when a painter died, so waiting — a brief hold of the picture — beats skipping), an
 *    older frame than the one on screen is dropped;
 *  - at most one playback frame per display frame: a frame arriving before the view drew the
 *    previous one waits for the next animation frame (else the previous one would never be seen);
 *  - a still frame painted just before playback started (a helper's playback frames can overtake
 *    it) is older than the picture and is skipped.
 */
import { PlaybackSequencer } from '../worker/protocol';

export interface PresentableFrame {
  kind: 'play' | 'still';
  epoch: number;
  showSeq?: number;
}

export interface PlaybackPresenterDeps<F> {
  /** Put the frame on screen. */
  present(frame: F): void;
  /** The frame belongs to an older epoch than the main thread's (dropped). */
  isStale(frame: F): boolean;
  now(): number;
  /** Next display frame (FrameTask): calls `onDisplayFrame` once. */
  scheduleDisplayFrame(): void;
  /** One-shot timer. */
  setTimer(fn: () => void, ms: number): void;
}

export class PlaybackPresenter<F extends PresentableFrame> {
  readonly sequencer = new PlaybackSequencer<F>();
  private presentedThisFrame = false;
  private timerArmed = false;

  constructor(private readonly deps: PlaybackPresenterDeps<F>) {}

  /** A frame (not stale) arrived. */
  receive(f: F): void {
    if (f.kind === 'play') {
      this.sequencer.push(f, this.deps.now());
      this.pump();
      return;
    }
    if (this.sequencer.hasShown(f.epoch)) return;
    this.sequencer.clear();
    this.deps.present(f);
  }

  /** A playback frame was presented (the caller counts it): pace the next one. */
  private showPlay(f: F): void {
    this.presentedThisFrame = true;
    this.deps.scheduleDisplayFrame();
    this.deps.present(f);
  }

  /** The view had a display frame since the last playback frame was presented. */
  onDisplayFrame(): void {
    this.presentedThisFrame = false;
    this.pump();
  }

  /** Tune the wait for a late frame to the frame rate (≈ 3 intervals, 100–400 ms). */
  setFrameRate(fps: number): void {
    if (fps > 0) this.sequencer.holdMs = Math.max(100, Math.min(400, 3000 / fps));
  }

  private pump(): void {
    if (this.presentedThisFrame) return;
    const now = this.deps.now();
    for (let f = this.sequencer.take(now); f; f = this.sequencer.take(now)) {
      if (this.deps.isStale(f)) continue; // buffered before a pause / scrub
      this.showPlay(f);
      return;
    }
    // Waiting for a late predecessor: look again when the hold expires.
    const wait = this.sequencer.waitMs(now);
    if (wait !== null && !this.timerArmed) {
      this.timerArmed = true;
      this.deps.setTimer(() => {
        this.timerArmed = false;
        this.pump();
      }, wait + 1);
    }
  }
}
