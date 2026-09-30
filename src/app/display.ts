/** Pure mappings from app state to worker request payloads. */
import type { GenerateParams } from '../core/types';
import type { DisplaySettings } from '../worker/protocol';
import { PAINT_FULL, PAINT_PREVIEW } from './schema';
import type { AppState, WorldSettings } from './state';

let displaySeq = 0;

/** What the painter needs to render the current layer/month/overlays (stamped with a creation order). */
export function displaySettings(s: AppState): DisplaySettings {
  return {
    seq: ++displaySeq,
    layer: s.settings.view.layer,
    month: s.runtime.month,
    overlays: { ...s.settings.view.overlays },
    seaLevel: s.settings.seaLevel,
    detail: s.settings.view.detail,
    fullWidth: PAINT_FULL.w,
    fullHeight: PAINT_FULL.h,
    previewWidth: PAINT_PREVIEW.w,
    previewHeight: PAINT_PREVIEW.h,
  };
}

/** World settings minus the app-only mesh resolution. */
export function generateParams(w: WorldSettings): GenerateParams {
  return {
    seed: w.seed, plateCount: w.plateCount, continentalFraction: w.continentalFraction, continentMode: w.continentMode,
    hotspotCount: w.hotspotCount, plateSpeed: w.plateSpeed, boundaryRoughness: w.boundaryRoughness,
  };
}
