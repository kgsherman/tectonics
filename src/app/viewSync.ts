/**
 * Pushes state-derived presentation into the viewport and right panel: lighting, relief, sea level,
 * graticule, particles and clouds (from the main thread's climate copy) and the legend.
 */
import type { ClimateResult, SphereMesh, WorldSnapshot } from '../core/types';
import { getLegend } from '../render/paint';
import { layerNeedsClimate } from '../worker/layerInfo';
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
    this.viewport.setLighting(resolveLighting(v.lighting, v.layer, s.runtime.month, s.settings.climate.axialTilt));
    this.viewport.setReliefScale(v.reliefScale);
    this.viewport.setGraticule(v.overlays.graticule);
  }

  /** Particles and clouds for the current climate and month (clouds only over the satellite layer). */
  weather(): void {
    const s = this.store.getState();
    const c = this.data.climate();
    const v = s.settings.view;
    const m = s.runtime.month;
    this.viewport.setParticleCount(v.particleCount);
    this.viewport.setVectorField(!c || v.particles === 'off' ? null : v.particles === 'wind' ? windFieldSpec(c, m) : currentFieldSpec(c, m));
    this.viewport.setClouds(c && v.clouds && v.layer === 'satellite' ? cloudSpec(c, m, v.cloudDensity) : null);
  }

  legend(): void {
    const s = this.store.getState();
    const layer = s.settings.view.layer;
    if (s.runtime.editorActive) {
      this.right.setLegend(null, 'The plate editor is drawing the view. Leave the Plates tab to return to the simulation layers.');
      return;
    }
    const climate = this.data.climate();
    const note = layerNeedsClimate(layer) && !climate ? 'No climate yet: showing a neutral map. Compute one in the Climate tab.' : undefined;
    const mesh = this.data.mesh();
    if (!mesh) {
      this.right.setLegend(null, note);
      return;
    }
    try {
      const d = displaySettings(s);
      const spec = getLegend(layer, { mesh, snapshot: this.data.snapshot(), climate }, {
        width: d.fullWidth, height: d.fullHeight, month: d.month, seaLevel: d.seaLevel, hillshade: false, seed: s.runtime.worldSeed, detail: d.detail,
      });
      this.right.setLegend(spec, note);
    } catch (e) {
      this.right.setLegend(null, `Legend unavailable: ${errorMessage(e)}`);
    }
  }
}
