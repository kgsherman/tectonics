import type {
  ArrowSpec, BrushCursor, CloudSpec, GeoPoint, LightingMode, MarkerSpec, VectorFieldSpec, WorldPointerEvent, WorldView,
} from '../core/types';

// CONTRACT STUB — implemented by the views owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

/** Three.js 3D globe implementation of WorldView (SPEC.md §8.1). */
export class GlobeView implements WorldView {
  readonly kind = 'globe' as const;
  readonly element: HTMLElement;
  constructor(container: HTMLElement) {
    this.element = container;
  }
  setBaseImage(rgba: Uint8ClampedArray, width: number, height: number): void { return NI(); }
  setHeightMap(height: Float32Array | null, width: number, height_: number): void { return NI(); }
  setSeaLevel(seaLevel: number): void { return NI(); }
  setOverlayImage(rgba: Uint8ClampedArray | null, width: number, height: number): void { return NI(); }
  setVectorField(field: VectorFieldSpec | null): void { return NI(); }
  setClouds(clouds: CloudSpec | null): void { return NI(); }
  setArrows(arrows: ArrowSpec[]): void { return NI(); }
  setMarkers(markers: MarkerSpec[]): void { return NI(); }
  setBrushCursor(cursor: BrushCursor | null): void { return NI(); }
  setInteractionMode(mode: 'navigate' | 'paint'): void { return NI(); }
  setLighting(lighting: LightingMode): void { return NI(); }
  setReliefScale(scale: number): void { return NI(); }
  pick(clientX: number, clientY: number): GeoPoint | null { return NI(); }
  project(point: GeoPoint): { x: number; y: number; visible: boolean } { return NI(); }
  onPointer(handler: (e: WorldPointerEvent) => void): () => void { return NI(); }
  resize(): void { return NI(); }
  toDataURL(): string { return NI(); }
  dispose(): void { return NI(); }
}
