/** Tiny DOM helpers for the editor panel (no framework). */

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Create an element with a class list, attributes and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  attrs?: Attrs | null,
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

/** Element whose content is a trusted inline SVG string from icons.ts. */
export function iconEl(svg: string, cls = 'pe-ico'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.style.display = 'inline-flex';
  s.innerHTML = svg;
  return s;
}

/** Button with an icon and optional text label. */
export function button(cls: string, title: string, svg: string | null, label?: string): HTMLButtonElement {
  const b = el('button', cls, { type: 'button', title, 'aria-label': title });
  if (svg) b.append(iconEl(svg));
  if (label) b.append(el('span', null, null, label));
  return b;
}

/** Segmented control; returns the container and a setter for the active value. */
export function segmented<T extends string>(
  options: Array<{ value: T; label: string; title?: string; svg?: string }>,
  onPick: (v: T) => void,
): { root: HTMLDivElement; set: (v: T) => void; buttons: Map<T, HTMLButtonElement> } {
  const root = el('div', 'pe-seg', { role: 'group' });
  const buttons = new Map<T, HTMLButtonElement>();
  for (const o of options) {
    const b = el('button', null, { type: 'button', title: o.title ?? o.label, 'aria-pressed': 'false' });
    if (o.svg) b.append(iconEl(o.svg));
    b.append(el('span', null, null, o.label));
    b.addEventListener('click', () => onPick(o.value));
    buttons.set(o.value, b);
    root.append(b);
  }
  const set = (v: T) => {
    for (const [val, b] of buttons) {
      b.classList.toggle('pe-on', val === v);
      b.setAttribute('aria-pressed', String(val === v));
    }
  };
  return { root, set, buttons };
}

export function rgbCss(c: readonly number[]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function rgbToHex(c: readonly number[]): string {
  return '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** True if keyboard events on this target belong to a text field (shortcuts must not fire). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type.toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(type);
  }
  return false;
}
