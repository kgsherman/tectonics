/**
 * Hover inspector driver: pointer events from the view → (once per animation frame) a sample of
 * the main thread's mesh / snapshot / climate / displayed height map → InspectorView.
 */
import type { ClimateResult, SphereMesh, WorldPointerEvent, WorldSnapshot } from '../core/types';
import { FrameTask } from './frameTask';
import { inspectAt, type HeightMapRef, type InspectSample } from './inspect';
import type { Action, AppState } from './state';
import type { Store } from './store';
import type { InspectorView } from './ui/inspectorView';

export interface HoverSources {
  mesh(): SphereMesh | null;
  snapshot(): WorldSnapshot | null;
  climate(): ClimateResult | null;
  heightMap(): HeightMapRef | null;
}

export class HoverController {
  private point: { lat: number; lon: number } | null = null;
  /** Pointer left the planet: keep showing the last sample, dimmed. */
  private stale = false;
  private hint: number | undefined;
  private readonly task = new FrameTask(() => this.sample());

  constructor(
    private readonly store: Store<AppState, Action>,
    private readonly view: InspectorView,
    private readonly src: HoverSources,
  ) {}

  onPointer(e: WorldPointerEvent): void {
    if (this.store.getState().runtime.editorActive) return;
    if ((e.type === 'hover' || e.type === 'move') && e.point) {
      this.point = { lat: e.point.lat, lon: e.point.lon };
      this.stale = false;
      this.refresh();
    } else if ((e.type === 'leave' || !e.point) && this.point && !this.stale) {
      this.stale = true;
      this.refresh();
    }
  }

  /** Forget the sample (new world, editor entry). */
  clear(): void {
    this.point = null;
    this.hint = undefined;
    this.view.update(null, this.store.getState().runtime.month, false);
  }

  /** Re-sample at the last position (data changed or pointer moved), at most once per frame. */
  refresh(): void {
    if (this.point) this.task.schedule();
  }

  private sample(): void {
    const p = this.point;
    const s = this.store.getState();
    if (!p || s.runtime.editorActive) return;
    let sample: InspectSample;
    try {
      sample = inspectAt({
        mesh: this.src.mesh(), snapshot: this.src.snapshot(), climate: this.src.climate(), heightMap: this.src.heightMap(),
        month: s.runtime.month, seaLevel: s.settings.seaLevel,
      }, p.lat, p.lon, this.hint);
    } catch (err) {
      console.error('worldgen: hover sampling failed', err);
      return;
    }
    this.hint = sample.tectonic?.cell;
    this.view.update(sample, s.runtime.month, this.stale);
  }
}
