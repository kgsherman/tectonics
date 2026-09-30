import type { LayerId } from '../core/types';

/** Every layer in display order (keyboard shortcuts 1–9 follow this order). */
export const LAYER_ORDER: readonly LayerId[] = [
  'satellite', 'elevation', 'plates', 'koppen', 'temperature', 'precipitation', 'crust', 'crustAge', 'pressure', 'wind', 'sst', 'currents',
];

/** Layers painted from climate fields (neutral fallback without a climate). */
const CLIMATE_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>([
  'satellite', 'temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen',
]);

/** Layers that are meaningless without a climate (satellite still renders a neutral planet). */
const CLIMATE_ONLY_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>([
  'temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen',
]);

/** Layers whose colors depend on the month. */
const MONTHLY_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>([
  'satellite', 'temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents',
]);

export function layerUsesClimate(layer: LayerId): boolean {
  return CLIMATE_LAYERS.has(layer);
}

export function layerNeedsClimate(layer: LayerId): boolean {
  return CLIMATE_ONLY_LAYERS.has(layer);
}

export function layerIsMonthly(layer: LayerId): boolean {
  return MONTHLY_LAYERS.has(layer);
}

export function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && (LAYER_ORDER as readonly string[]).includes(v);
}
