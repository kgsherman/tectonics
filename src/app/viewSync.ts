/**
 * Pushes state-derived presentation into the viewport and right panel: lighting, relief, sea level,
 * graticule, particles and clouds (from the main thread's climate copy) and the legend.
 */
import type { ClimateResult, CloudQuality, SphereMesh, WorldSnapshot } from '../core/types';
import { getLegend } from '../render/paint';
import { layerNeedsClimate } from '../worker/layerInfo';
import type { PaintOptionsExt } from '../worker/framePainter';
import { errorMessage } from '../worker/protocol';
import { cloudSpec, currentFieldSpec, windFieldSpec } from './climateFields';
import { displaySettings } from './display';
import { resolveLighting } from './lighting';
import type { Action, AppState } from './state';
import type { Store } from './store';
import type { RightPanel } from './ui/rightPanel';
import type { Viewport } from './ui/viewport';

export interface WorldData {
  mesh(): SphereMesh | null;
  snapshot(): WorldSnapshot | null;
  climate(): ClimateResult | null;
}

export class ViewSync {
  /** What the view last received: rebuilding clouds or particles costs main-thread time, skip repeats. */
  private cloudKey = '';
  private fieldKey = '';

  constructor(
    private readonly store: Store<AppState, Action>,
    private readonly viewport: Viewport,
    private readonly right: RightPanel,
    private readonly data: WorldData,
  ) {}

  /** Sea level, lighting (month/tilt dependent), relief exaggeration, graticule. */
  viewProps(): void {
    const s = this.store.getState();
    const v = s.settings.view;
    this.viewport.setSeaLevel(s.settings.seaLevel);
    this.viewport.setLighting(resolveLighting(v.lighting, v.layer, s.runtime.month, s.settings.climate.axialTilt, this.viewport.kind ?? v.view));
    this.viewport.setReliefScale(v.reliefScale);
    this.viewport.setGraticule(v.overlays.graticule);
    this.viewport.setSurfaceDetail(Math.min(1, Math.max(0, v.detail)));
  }

  /**
   * Particles and clouds for the current climate and month (clouds only over the satellite layer).
   * Only what changed is rebuilt: a cloud layer costs the view tens of milliseconds to set up, and
   * this runs for every related setting (particle count, layer, month, a new climate).
   */
  weather(): void {
    const s = this.store.getState();
    const c = this.data.climate();
    const v = s.settings.view;
    const m = s.runtime.month;
    this.viewport.setParticleCount(v.particleCount);
    const field = !c || v.particles === 'off' ? null : v.particles;
    const fieldKey = field && c ? `${c.id}|${m}|${field}` : '';
    if (fieldKey !== this.fieldKey || !field) {
      this.fieldKey = fieldKey;
      this.viewport.setVectorField(!c || !field ? null : field === 'wind' ? windFieldSpec(c, m) : currentFieldSpec(c, m));
    }
    const clouds = !!c && v.clouds && v.layer === 'satellite';
    // Full-quality clouds follow every climate / month / density change. While the seasons play on the
    // map, standard ones: re-tiling a zoomed map every month (seconds of worker time) cannot keep up,
    // so its sharp tiles would flicker in and out; full quality returns when the playback stops.
    const quality: CloudQuality = s.runtime.seasonsPlaying && v.view === 'map' ? 'standard' : 'high';
    const cloudKey = clouds && c ? `${c.id}|${m}|${v.cloudDensity}|${quality}` : '';
    if (cloudKey !== this.cloudKey) {
      this.cloudKey = cloudKey;
      this.viewport.setClouds(clouds && c ? { ...cloudSpec(c, m, v.cloudDensity), quality } : null);
    }
  }

  legend(): void {
    const s = this.store.getState();
    const layer = s.settings.view.layer;
    if (s.runtime.editorActive) {
      this.right.setLegend(null, 'The plate editor is drawing the view. Leave the Plates tab to return to the simulation layers.');
      return;
    }
    const climate = this.data.climate();
    const computing = s.runtime.climate.phase === 'computing';
    const note = !layerNeedsClimate(layer) || climate ? undefined
      : computing ? 'Computing the climate: this map fills in when it is ready.'
      : 'No climate yet: showing a neutral map. Compute one in the Climate tab.';
    const mesh = this.data.mesh();
    if (!mesh) {
      this.right.setLegend(null, note);
      return;
    }
    try {
      const d = displaySettings(s);
      // Same painter hints as the frames (a legend may describe the currents' arrows).
      const opts: PaintOptionsExt = {
        width: d.fullWidth, height: d.fullHeight, month: d.month, seaLevel: d.seaLevel, hillshade: false, seed: s.runtime.worldSeed, detail: d.detail,
        flowGlyphs: d.flowGlyphs !== false,
      };
      const spec = getLegend(layer, { mesh, snapshot: this.data.snapshot(), climate }, opts);
      this.right.setLegend(spec, note);
    } catch (e) {
      this.right.setLegend(null, `Legend unavailable: ${errorMessage(e)}`);
    }
  }
}
