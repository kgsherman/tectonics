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
  (window as unknown as { __qa: unknown }).__qa = qaHooks(editor, getView);
}

/**
 * Scripted QA helpers (window.__qa): synthetic pointer drags in lat/lon, synchronous preview
 * flush + view capture, and a DOM capture of the panel — usable while the page is in a hidden tab
 * (no requestAnimationFrame). Captures are POSTed to the dev server's /__snap endpoint.
 */
function qaHooks(editor: PlateEditor, getView: () => WorldView) {
  type LL = [number, number] | { x: number; y: number };
  const DEGR = Math.PI / 180;
  const renderer = () => (editor as unknown as { renderer: { flush(): void; cancelFrame(): void } }).renderer;
  const toXY = (p: LL) => {
    if (!Array.isArray(p)) return p;
    const pr = getView().project({ lat: p[0] * DEGR, lon: p[1] * DEGR });
    return { x: pr.x, y: pr.y };
  };
  const target = () => {
    const el = getView().element;
    return (el.querySelector('canvas')?.parentElement ?? el) as HTMLElement;
  };
  const fire = (type: string, p: LL, buttons: number, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
    const { x, y } = toXY(p);
    target().dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons,
      shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl,
    }));
  };
  const status = () => document.querySelector('.pe-status')?.textContent ?? '';
  const post = async (name: string, dataUrl: string) => (await fetch(`/__snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: dataUrl })).text();
  return {
    /** Press at pts[0], move through the rest, release (optionally holding keys). Returns the status line. */
    drag(pts: LL[], mods: { shift?: boolean; ctrl?: boolean; noUp?: boolean } = {}): string {
      fire('pointermove', pts[0], 0, mods);
      fire('pointerdown', pts[0], 1, mods);
      for (let i = 1; i < pts.length; i++) fire('pointermove', pts[i], 1, mods);
      if (!mods.noUp) fire('pointerup', pts[pts.length - 1], 0, mods);
      return status();
    },
    /** Pointer move with the left button held (continues a drag started with drag(..., { noUp: true })). */
    move(p: LL, mods: { shift?: boolean } = {}): string {
      fire('pointermove', p, 1, mods);
      return status();
    },
    hover(p: LL, mods: { shift?: boolean } = {}): string {
      fire('pointermove', p, 0, mods);
      return status();
    },
    up(p: LL): string {
      fire('pointerup', p, 0);
      return status();
    },
    key(key: string, mods: { shift?: boolean; ctrl?: boolean } = {}): void {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, bubbles: true, cancelable: true }));
    },
    status,
    flush(): void {
      renderer().cancelFrame();
      renderer().flush();
    },
    xy: toXY,
    async snapView(name: string): Promise<string> {
      renderer().cancelFrame();
      renderer().flush();
      return post(name, getView().toDataURL());
    },
    /** Rasterise the editor panel through an SVG foreignObject (2× scale). */
    async snapPanel(name: string): Promise<string> {
      const node = document.getElementById('panel') as HTMLElement;
      const rect = node.getBoundingClientRect();
      const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
      const clone = node.cloneNode(true) as HTMLElement;
      const src = node.querySelectorAll('input'), dst = clone.querySelectorAll('input');
      src.forEach((s, i) => dst[i].setAttribute('value', s.value));
      const html = new XMLSerializer().serializeToString(clone);
      const w = Math.ceil(rect.width), h = Math.ceil(rect.height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}"><foreignObject x="0" y="0" width="${w}" height="${h}" transform="scale(2)">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:#0b0f14;color:#d7e0ea;font:13px system-ui,sans-serif">` +
        `<style>${css.replace(/</g, '&lt;')}</style>${html}</div></foreignObject></svg>`;
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
      const c = document.createElement('canvas');
      c.width = w * 2;
      c.height = h * 2;
      c.getContext('2d')?.drawImage(img, 0, 0);
      return post(name, c.toDataURL('image/png'));
    },
  };
}

main().catch((err) => {
  console.error(err);
  boot.textContent = `Demo failed to start:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  boot.classList.add('err');
});
