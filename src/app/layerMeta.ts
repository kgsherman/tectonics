/** UI metadata for layers: grouping, swatches, shortcuts. */
import type { LayerId } from '../core/types';
import { LAYER_LABELS } from '../render/paint';
import { LAYER_ORDER } from '../worker/layerInfo';

export const LAYER_GROUPS: ReadonlyArray<{ title: string; layers: LayerId[] }> = [
  { title: 'Surface', layers: ['satellite', 'elevation'] },
  { title: 'Tectonics', layers: ['plates', 'crust', 'crustAge'] },
  { title: 'Climate', layers: ['koppen', 'temperature', 'precipitation', 'pressure', 'wind', 'sst', 'currents'] },
];

/** Small CSS swatch evoking each layer's colormap. */
export const LAYER_SWATCH: Record<LayerId, string> = {
  satellite: 'linear-gradient(135deg, #1f4a2c 0%, #5d7a3a 35%, #c2a878 60%, #2a5f8a 61%, #173d63 100%)',
  elevation: 'linear-gradient(135deg, #14325e 0%, #3a78b8 38%, #4b8c4a 52%, #c7b27d 76%, #f4f4f4 100%)',
  plates: 'conic-gradient(#e66154 0 25%, #4898d6 0 50%, #f5b542 0 75%, #68ba6e 0)',
  crust: 'linear-gradient(135deg, #c4a470 0 50%, #3e608e 50% 100%)',
  crustAge: 'linear-gradient(135deg, #d62628, #f5d64a 35%, #3ca0be 70%, #683aa0)',
  koppen: 'conic-gradient(#0000ff 0 20%, #ff0000 0 40%, #ffff00 0 60%, #00c8ff 0 80%, #b2b2b2 0)',
  temperature: 'linear-gradient(135deg, #42409f, #a8dee9 40%, #f7d45d 70%, #c0302b)',
  precipitation: 'linear-gradient(135deg, #785434, #e2d68c 35%, #2a968c 70%, #2861bd)',
  pressure: 'linear-gradient(135deg, #18286e, #f0ede6 50%, #ce5d40)',
  wind: 'linear-gradient(135deg, #121c2c, #2868a4 40%, #68c476 70%, #fac446)',
  sst: 'linear-gradient(135deg, #241e60, #2c9cba 40%, #eed85c 75%, #a81e2a)',
  currents: 'linear-gradient(135deg, #0a142c, #2868a4 55%, #a8d6ec)',
};

export function layerLabel(layer: LayerId): string {
  return LAYER_LABELS[layer];
}

/** Compact names for the layer tiles (full names in tooltips and the picker). */
const SHORT_LABELS: Partial<Record<LayerId, string>> = {
  koppen: 'Köppen', sst: 'Sea temp.', currents: 'Currents', wind: 'Wind', precipitation: 'Rainfall',
};

export function layerShortLabel(layer: LayerId): string {
  return SHORT_LABELS[layer] ?? LAYER_LABELS[layer];
}

/** Keyboard shortcut digit for a layer ('' if none). */
export function layerShortcut(layer: LayerId): string {
  const i = LAYER_ORDER.indexOf(layer);
  return i >= 0 && i < 9 ? String(i + 1) : '';
}
