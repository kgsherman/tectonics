/** Scoped plate-editor styles ('pe-' prefix), injected once per document. */

const CSS = `
.pe-root {
  --pe-bg: var(--wg-bg, #0b0f14);
  --pe-panel: var(--wg-panel, #121821);
  --pe-panel-2: var(--wg-panel-2, #18202b);
  --pe-border: var(--wg-border, #243042);
  --pe-text: var(--wg-text, #d7e0ea);
  --pe-dim: var(--wg-text-dim, #8b9bb0);
  --pe-accent: var(--wg-accent, #4fa3ff);
  --pe-accent-2: var(--wg-accent-2, #7fd1b9);
  --pe-danger: var(--wg-danger, #ff6b6b);
  --pe-warn: var(--wg-warn, #f5b942);
  --pe-radius: 8px;
  position: relative; display: flex; flex-direction: column;
  height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden;
  color: var(--pe-text); background: var(--pe-panel);
  font: 13px "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased;
  user-select: none;
}
.pe-root *, .pe-root *::before, .pe-root *::after { box-sizing: border-box; }
.pe-root [hidden] { display: none !important; }
.pe-num { font-variant-numeric: tabular-nums; }
.pe-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 12px;
  padding: 12px 12px 10px; scrollbar-width: thin; scrollbar-color: #2b3a50 transparent;
}
.pe-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pe-title { font-weight: 600; font-size: 14px; letter-spacing: .01em; }
.pe-title small { display: block; font-weight: 400; font-size: 11.5px; color: var(--pe-dim); margin-top: 1px; }
.pe-section { display: flex; flex-direction: column; gap: 6px; }
.pe-label { color: var(--pe-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
.pe-btn {
  appearance: none; border: 1px solid var(--pe-border); background: var(--pe-panel-2); color: var(--pe-text);
  border-radius: 6px; height: 28px; padding: 0 10px; font: inherit; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
  transition: background .12s, border-color .12s, color .12s;
}
.pe-btn:hover:not(:disabled) { border-color: #3a4d68; background: #1e2835; }
.pe-btn:active:not(:disabled) { transform: translateY(1px); }
.pe-btn:disabled { opacity: .4; cursor: default; }
.pe-btn:focus-visible, .pe-tool:focus-visible, .pe-seg button:focus-visible, .pe-primary:focus-visible {
  outline: 2px solid var(--pe-accent); outline-offset: 1px;
}
.pe-icon-btn { width: 28px; padding: 0; }
.pe-btn-group { display: flex; gap: 4px; }
.pe-seg { display: flex; background: var(--pe-bg); border: 1px solid var(--pe-border); border-radius: 7px; padding: 2px; gap: 2px; }
.pe-seg button {
  flex: 1; border: 0; background: transparent; color: var(--pe-dim); height: 26px; border-radius: 5px;
  font: inherit; font-size: 12.5px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  transition: background .12s, color .12s;
}
.pe-seg button:hover:not(:disabled) { color: var(--pe-text); background: rgba(255,255,255,.04); }
.pe-seg button.pe-on { background: var(--pe-panel-2); color: var(--pe-text); box-shadow: inset 0 0 0 1px var(--pe-border); }
.pe-seg button:disabled { opacity: .45; cursor: default; }
.pe-seg svg { width: 15px; height: 15px; }
.pe-toolgrid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.pe-tool {
  position: relative; height: 38px; border-radius: 7px; border: 1px solid transparent; background: var(--pe-panel-2);
  color: var(--pe-dim); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
  transition: background .12s, color .12s, border-color .12s;
}
.pe-tool:hover { color: var(--pe-text); border-color: var(--pe-border); background: #1d2734; }
.pe-tool.pe-on { color: #fff; background: color-mix(in srgb, var(--pe-accent) 24%, var(--pe-panel-2)); border-color: var(--pe-accent); }
.pe-tool .pe-key { position: absolute; right: 4px; bottom: 1px; font-size: 9px; color: var(--pe-dim); font-weight: 600; }
.pe-tool.pe-on .pe-key { color: color-mix(in srgb, var(--pe-accent) 60%, #fff); }
.pe-toolopts {
  background: var(--pe-bg); border: 1px solid var(--pe-border); border-radius: var(--pe-radius);
  padding: 10px; display: flex; flex-direction: column; gap: 9px;
}
.pe-toolname { display: flex; align-items: baseline; justify-content: space-between; font-weight: 600; }
.pe-toolname kbd, .pe-root kbd {
  font: 600 10.5px "Inter", system-ui, sans-serif; color: var(--pe-dim); border: 1px solid var(--pe-border);
  border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--pe-panel-2);
}
.pe-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.pe-row > .pe-grow { flex: 1; min-width: 0; }
.pe-row-label { color: var(--pe-dim); font-size: 12px; min-width: 58px; }
.pe-value { font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; font-size: 12.5px; }
.pe-range { width: 100%; margin: 0; accent-color: var(--pe-accent); cursor: pointer; }
.pe-hint { color: var(--pe-dim); font-size: 12px; line-height: 1.45; }
.pe-target { display: flex; align-items: center; gap: 8px; font-size: 12.5px; min-width: 0; }
.pe-target .pe-dot { width: 12px; height: 12px; border-radius: 3px; flex: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }
.pe-target span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-plates { flex: 1 1 auto; min-height: 190px; display: flex; flex-direction: column; gap: 6px; }
.pe-plates-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pe-count { font-variant-numeric: tabular-nums; color: var(--pe-dim); font-size: 12px; margin-left: 6px; font-weight: 500; text-transform: none; letter-spacing: 0; }
.pe-count.pe-full { color: var(--pe-warn); }
.pe-list {
  position: relative; flex: 1 1 auto; overflow-y: auto; min-height: 0; border: 1px solid var(--pe-border);
  border-radius: var(--pe-radius); background: var(--pe-bg); scrollbar-width: thin; scrollbar-color: #2b3a50 transparent;
}
.pe-plate {
  display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto 22px; align-items: center; column-gap: 8px;
  padding: 4px 6px 4px 9px; border-bottom: 1px solid rgba(36, 48, 66, .55); cursor: pointer; min-height: 32px;
}
.pe-plate:last-child { border-bottom: 0; }
.pe-plate:hover { background: rgba(255,255,255,.025); }
.pe-plate.pe-sel { background: color-mix(in srgb, var(--pe-accent) 11%, transparent); box-shadow: inset 2px 0 0 var(--pe-accent); }
.pe-swatch { position: relative; width: 14px; height: 14px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); cursor: pointer; }
.pe-swatch input { position: absolute; inset: -2px; opacity: 0; cursor: pointer; width: 18px; height: 18px; padding: 0; border: 0; }
.pe-name {
  background: transparent; border: 1px solid transparent; color: var(--pe-text); font: inherit; padding: 2px 5px;
  border-radius: 4px; min-width: 0; width: 100%; text-overflow: ellipsis; user-select: text;
}
.pe-name:hover { border-color: var(--pe-border); }
.pe-name:focus { border-color: var(--pe-accent); outline: none; background: var(--pe-panel-2); }
.pe-area, .pe-speed { font-size: 11.5px; color: var(--pe-dim); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.pe-area { min-width: 38px; }
.pe-speed { min-width: 58px; display: inline-flex; align-items: center; justify-content: flex-end; gap: 3px; }
.pe-speed svg { flex: none; transition: transform .15s; }
.pe-del {
  width: 22px; height: 22px; border-radius: 5px; border: 0; background: transparent; color: var(--pe-dim); cursor: pointer;
  display: flex; align-items: center; justify-content: center; opacity: 0; padding: 0; transition: opacity .12s, color .12s, background .12s;
}
.pe-del svg { width: 14px; height: 14px; }
.pe-plate:hover .pe-del, .pe-plate.pe-sel .pe-del, .pe-del:focus-visible { opacity: 1; }
.pe-del:hover:not(:disabled) { color: var(--pe-danger); background: rgba(255, 107, 107, .12); }
.pe-del:disabled { opacity: 0 !important; cursor: default; }
.pe-detail { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 6px 0 4px 22px; }
.pe-field { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--pe-dim); text-transform: uppercase; letter-spacing: .05em; }
.pe-field input {
  width: 100%; background: var(--pe-panel-2); border: 1px solid var(--pe-border); color: var(--pe-text); border-radius: 5px;
  height: 26px; padding: 0 6px; font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; text-transform: none; user-select: text;
}
.pe-field input:focus { border-color: var(--pe-accent); outline: none; }
.pe-field input:disabled { opacity: .5; }
.pe-empty-note { grid-column: 1 / -1; padding: 2px 0 4px 22px; font-size: 11.5px; color: var(--pe-warn); }
.pe-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--pe-border); }
.pe-status {
  min-height: 36px; font-size: 12px; color: var(--pe-dim); line-height: 1.4; padding: 6px 9px; border-radius: 6px;
  background: var(--pe-bg); border: 1px solid var(--pe-border); overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-variant-numeric: tabular-nums;
}
.pe-status.pe-ok { color: var(--pe-accent-2); }
.pe-status.pe-warn { color: var(--pe-warn); }
.pe-status.pe-error { color: var(--pe-danger); }
.pe-legend { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--pe-dim); line-height: 1.3; }
.pe-legend i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
.pe-foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pe-foot-row .pe-seg { flex: 0 0 150px; }
.pe-primary {
  height: 40px; border: 0; border-radius: var(--pe-radius); background: var(--pe-accent); color: #031222; font: inherit;
  font-weight: 650; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
  box-shadow: 0 6px 18px rgba(79, 163, 255, .22); transition: filter .12s, transform .06s;
}
.pe-primary:hover:not(:disabled) { filter: brightness(1.08); }
.pe-primary:active:not(:disabled) { transform: translateY(1px); }
.pe-primary:disabled { opacity: .5; cursor: progress; }
.pe-busy {
  position: absolute; inset: 0; background: rgba(11, 15, 20, .62); display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 12px; z-index: 5; color: var(--pe-text); font-size: 13px;
}
.pe-root.pe-is-busy .pe-busy { display: flex; }
.pe-spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(79, 163, 255, .22); border-top-color: var(--pe-accent); animation: pe-spin .8s linear infinite; }
@keyframes pe-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pe-spinner { animation-duration: 2.4s; } }
`;

const STYLE_ID = 'pe-editor-styles';

/** Add the editor stylesheet to `doc` once. */
export function injectEditorStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}
