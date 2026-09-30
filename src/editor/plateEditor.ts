import type { GenerateParams, SphereMesh, WorldDraft, WorldView } from '../core/types';

// CONTRACT STUB — implemented by the editor owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

export interface PlateEditorOptions {
  mesh: SphereMesh;
  /** The editor renders its tool UI (tools, brush settings, plate list) into this element. */
  panel: HTMLElement;
  /** Current view (the app may switch between globe and map while editing; see onViewChanged). */
  getView: () => WorldView;
  /** Called (throttled) whenever the draft changes. */
  onDraftChange?: (draft: WorldDraft) => void;
  /** User pressed "Simulate this world": the app should load the draft into the simulation. */
  onApply: (draft: WorldDraft) => void;
  /**
   * Obtain a starting draft: 'blank' (one ocean plate), 'random' (generator; may run in a worker),
   * or 'current' (the running simulation's state). The editor shows a busy state while pending.
   */
  requestDraft: (source: 'blank' | 'random' | 'current', gen?: Partial<GenerateParams>) => Promise<WorldDraft>;
  /** Display sea level used for preview rendering (m). */
  seaLevel?: number;
  /** Plate cap (default MAX_PLATES). */
  maxPlates?: number;
}

/**
 * Interactive tectonic plate drawing tool (SPEC.md §9). Owns a WorldDraft and edits it with
 * brushes/tools; renders a preview (plates layer + velocity arrows) into the current view while active.
 */
export class PlateEditor {
  constructor(opts: PlateEditorOptions) {
    void opts;
  }
  setDraft(draft: WorldDraft): void { return NI(); }
  getDraft(): WorldDraft { return NI(); }
  /** Start editing: subscribe to view pointer events, switch view to paint mode, render preview. */
  activate(): void { return NI(); }
  /** Stop editing: unsubscribe, restore navigate mode, clear brush cursor/arrows. */
  deactivate(): void { return NI(); }
  readonly isActive: boolean = false;
  /** The app swapped globe <-> map: re-bind pointer handlers and re-render the preview. */
  onViewChanged(): void { return NI(); }
  dispose(): void { return NI(); }
}
