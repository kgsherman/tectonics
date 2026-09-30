/**
 * Plate editor demo: hosts PlateEditor with the real MapView / GlobeView, a local requestDraft
 * (blank / random generator / last applied draft) and an onApply that just reports the result.
 * URL params: ?n=100000 (mesh cells), ?seed=5. Debug handle: window.__editor.
 */
import { createSphereMesh } from '../src/core/sphereMesh';
import type { WorldDraft, WorldView } from '../src/core/types';
import { PlateEditor } from '../src/editor/plateEditor';
import { GlobeView } from '../src/render/globeView';
import { MapView } from '../src/render/mapView';
import { blankDraft } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';

const params = new URLSearchParams(location.search);
const N = Number(params.get('n') ?? 100_000);
const SEED = Number(params.get('seed') ?? 5);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const boot = $('boot');
const toastEl = $('toast');
let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 3500);
}

async function main(): Promise<void> {
  // Let the "Building mesh…" message paint first (setTimeout: rAF is paused in hidden tabs).
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const mesh = createSphereMesh(N);
  const views: Record<'map' | 'globe', WorldView | null> = { map: null, globe: null };
  let current: 'map' | 'globe' = 'map';
  const getView = (): WorldView => {
    let v = views[current];
    if (!v) {
      v = current === 'map' ? new MapView($('map')) : new GlobeView($('globe'));
      views[current] = v;
    }
    return v;
  };
  let applied: WorldDraft | null = null;

  const editor = new PlateEditor({
    mesh,
    panel: $('panel'),
    getView,
    onApply: (draft) => {
      applied = draft;
      const cont = draft.crust.reduce((s, c) => s + c, 0) / draft.n;
      toast(`Applied: ${draft.plates.length} plates, ${(cont * 100).toFixed(0)}% continental crust (revision ${draft.revision})`);
      console.info('[demo] onApply', draft);
    },
    onDraftChange: (d) => {
      (window as unknown as { __lastDraft: WorldDraft }).__lastDraft = d;
    },
    requestDraft: async (source, gen) => {
      await new Promise((r) => setTimeout(r, 30));
      if (source === 'blank') return blankDraft(mesh, (Math.random() * 1e6) | 0);
      if (source === 'random') return generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, ...gen, seed: gen?.seed ?? SEED });
      if (!applied) throw new Error('no simulation is running yet — press "Simulate this world" first');
      return applied;
    },
  });
  editor.setDraft(generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: SEED }), 'random');
  editor.activate();
  boot.remove();
  console.info(`[demo] mesh ${N} + editor ready in ${(performance.now() - t0).toFixed(0)} ms`);

  const seg = $('viewSeg');
  const show = (v: 'map' | 'globe') => {
    if (v === current) return;
    current = v;
    $('map').style.display = v === 'map' ? '' : 'none';
    $('globe').style.display = v === 'globe' ? '' : 'none';
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
    editor.onViewChanged();
    getView().resize();
  };
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.v === 'map' || b?.dataset.v === 'globe') show(b.dataset.v);
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'g' || e.key === 'G') show('globe');
    if (e.key === 'm' || e.key === 'M') show('map');
  });
  (window as unknown as { __editor: PlateEditor }).__editor = editor;
}

main().catch((err) => {
  console.error(err);
  boot.textContent = `Demo failed to start:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  boot.classList.add('err');
});
