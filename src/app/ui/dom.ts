/** Tiny DOM builder: h('div', { class: 'x', onClick }, child, …). */
export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  html?: string;
  [on: `on${string}`]: ((e: never) => void) | undefined;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, p: Props): void {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = v as string;
    else if (k === 'text') el.textContent = v as string;
    else if (k === 'html') el.innerHTML = v as string;
    else if (k === 'title') el.title = v as string;
    else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else Object.assign(el.style, v);
    } else if (k === 'attrs') {
      for (const [a, av] of Object.entries(v as Record<string, unknown>)) {
        if (av === false || av === null || av === undefined) continue;
        el.setAttribute(a, av === true ? '' : String(av));
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    }
  }
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replace all children. */
export function setChildren(el: Node, ...children: Child[]): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  append(el, children);
}

export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function rgbCss(c: readonly [number, number, number], alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}
