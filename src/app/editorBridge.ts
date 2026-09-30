/**
 * Plate editor lifecycle inside the Plates tab: (re)creates the PlateEditor for the current mesh,
 * seeds it with the running world the first time, activates/deactivates it with the tab and shows
 * a clear fallback in the panel when the editor cannot run.
 */
import { MAX_PLATES } from '../core/constants';
import type { GenerateParams, SphereMesh, WorldDraft, WorldView } from '../core/types';
import { PlateEditor } from '../editor/plateEditor';
import { errorMessage } from '../worker/protocol';
import { hint } from './ui/controls';
import { h, setChildren } from './ui/dom';
import { icon } from './ui/icons';

export interface EditorBridgeOptions {
  /** Panel element the editor renders its tools into. */
  host: HTMLElement;
  getView: () => WorldView | null;
  getMesh: () => SphereMesh | null;
  requestDraft: (source: 'blank' | 'random' | 'current', gen?: Partial<GenerateParams>) => Promise<WorldDraft>;
  onApply: (draft: WorldDraft) => void;
  seaLevel: () => number;
  onError: (title: string, detail: string) => void;
}

export class EditorBridge {
  private editor: PlateEditor | null = null;
  private editorMeshN = 0;
  private seeded = false;
  private active = false;

  constructor(private readonly o: EditorBridgeOptions) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Enter editing. Resolves true when the editor is active, false if it is unavailable. */
  async enter(): Promise<boolean> {
    const mesh = this.o.getMesh();
    const view = this.o.getView();
    if (!mesh || !view) {
      this.showMessage('No world yet', 'Generate a world first (World tab), then draw and edit its plates here.');
      return false;
    }
    try {
      if (!this.editor || this.editorMeshN !== mesh.n) this.create(mesh);
      if (!this.seeded) {
        const draft = await this.o.requestDraft('current');
        this.editor!.setDraft(draft);
        this.seeded = true;
      }
      // One sea level (SPEC §2): it may have changed since the editor was created.
      this.editor!.setSeaLevel(this.o.seaLevel());
      this.editor!.activate();
      this.active = true;
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      this.fail(msg);
      this.o.onError('Plate editor unavailable', msg);
      return false;
    }
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.editor?.deactivate();
    } catch (e) {
      this.o.onError('Plate editor error', errorMessage(e));
    }
  }

  /** The app swapped globe ⇄ map. */
  viewChanged(): void {
    if (!this.active || !this.editor) return;
    try {
      this.editor.onViewChanged();
    } catch (e) {
      this.o.onError('Plate editor error', errorMessage(e));
    }
  }

  /** New mesh resolution or new world: the next entry rebuilds and reseeds the editor (undo cleared). */
  worldChanged(meshChanged: boolean): void {
    if (meshChanged) this.disposeEditor();
    this.seeded = false;
  }

  dispose(): void {
    this.disposeEditor();
  }

  private create(mesh: SphereMesh): void {
    this.disposeEditor();
    setChildren(this.o.host);
    this.editor = new PlateEditor({
      mesh,
      panel: this.o.host,
      getView: () => {
        const v = this.o.getView();
        if (!v) throw new Error('no view');
        return v;
      },
      onApply: (d) => this.o.onApply(d),
      requestDraft: (source, gen) => this.o.requestDraft(source, gen),
      seaLevel: this.o.seaLevel(),
      maxPlates: MAX_PLATES,
    });
    this.editorMeshN = mesh.n;
    this.seeded = false;
  }

  private disposeEditor(): void {
    const ed = this.editor;
    this.editor = null;
    this.active = false;
    this.editorMeshN = 0;
    if (!ed) return;
    try {
      ed.dispose();
    } catch {
      // A half-constructed editor may not dispose cleanly; it is discarded either way.
    }
  }

  private fail(message: string): void {
    this.disposeEditor();
    this.showMessage('Plate editor unavailable', `The editor could not start: ${message}`);
  }

  private showMessage(title: string, detail: string): void {
    setChildren(this.o.host,
      h('div', { class: 'wg-editor-fallback' },
        h('div', { class: 'wg-insp-empty' }, icon('plate', 22), h('b', { text: title }), h('span', { text: detail })),
      ),
      h('section', { class: 'wg-section' }, hint('Tip: the World tab generates random plates; the Simulate tab evolves them.')),
    );
  }
}
