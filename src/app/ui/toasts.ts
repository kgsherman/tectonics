/** Stacked toast notifications (errors stay until dismissed or 9 s; others 4 s). Duplicates collapse. */
import { h } from './dom';
import { button } from './controls';
import { icon, type IconName } from './icons';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

const ICONS: Record<ToastKind, IconName> = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };
const MAX_TOASTS = 4;

export class Toasts {
  readonly el = h('div', { class: 'wg-toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly live = new Map<string, { el: HTMLElement; timer: number; count: number; title: HTMLElement }>();

  show(kind: ToastKind, title: string, detail?: string, timeoutMs?: number): void {
    const key = `${kind}|${title}|${detail ?? ''}`;
    const existing = this.live.get(key);
    const ms = timeoutMs ?? (kind === 'error' ? 9000 : 4000);
    if (existing) {
      existing.count++;
      existing.title.textContent = `${title} (×${existing.count})`;
      clearTimeout(existing.timer);
      existing.timer = window.setTimeout(() => this.dismiss(key), ms);
      return;
    }
    const titleEl = h('div', { class: 'wg-toast-title', text: title });
    const el = h('div', { class: `wg-toast wg-toast-${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'status' } },
      icon(ICONS[kind], 16),
      h('div', null, titleEl, detail ? h('div', { class: 'wg-toast-detail', text: detail }) : null),
      button({ icon: 'close', variant: 'ghost', title: 'Dismiss', onClick: () => this.dismiss(key) }),
    );
    this.el.appendChild(el);
    this.live.set(key, { el, timer: window.setTimeout(() => this.dismiss(key), ms), count: 1, title: titleEl });
    while (this.live.size > MAX_TOASTS) this.dismiss(this.live.keys().next().value!);
  }

  error(title: string, detail?: string): void {
    this.show('error', title, detail);
  }

  private dismiss(key: string): void {
    const t = this.live.get(key);
    if (!t) return;
    this.live.delete(key);
    clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    window.setTimeout(() => t.el.remove(), 200);
  }
}
