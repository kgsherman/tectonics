/** Resolve the user's lighting choice into the view's LightingMode. */
import type { LayerId, LightingMode } from '../core/types';
import { solarDeclination } from './climateFields';
import type { LightingChoice } from './state';

/** Layers with physical colors (relief shading helps); the rest are data maps read against a legend. */
const NATURAL_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>(['satellite', 'elevation']);

/**
 * 'auto': data layers flat (exact legend colors); satellite/elevation with relief shading, and the
 * satellite in a specific month lit by that month's sun (seasons show the day/night terminator
 * moving with the declination).
 */
export function resolveLighting(choice: LightingChoice, layer: LayerId, month: number, axialTiltDeg: number): LightingMode {
  const sun = (): LightingMode => ({ mode: 'sun', declination: solarDeclination(month, axialTiltDeg) });
  switch (choice) {
    case 'flat':
      return { mode: 'flat' };
    case 'relief':
      return { mode: 'relief' };
    case 'sun':
      return sun();
    case 'auto':
      if (!NATURAL_LAYERS.has(layer)) return { mode: 'flat' };
      return layer === 'satellite' && month >= 0 ? sun() : { mode: 'relief' };
  }
}
