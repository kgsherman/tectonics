/** Renders a LegendSpec (gradient bar with labeled stops, or a categorical swatch list). */
import type { LegendSpec } from '../../core/types';
import { h, rgbCss, setChildren } from './dom';

/** At most about this many gradient labels (first and last always shown). */
const MAX_LABELS = 6;

function trimLabel(label: string, unit?: string): string {
  // Painter labels may repeat the unit ("-8000 m"); the unit is shown in the title.
  const s = unit && label.endsWith(` ${unit}`) ? label.slice(0, -unit.length - 1) : label;
  return s.replace(/^-/, '−');
}

/** Indices of the stops to label: evenly thinned, never crowding the last one. */
export function labelIndices(n: number, maxLabels = MAX_LABELS): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const every = Math.max(1, Math.ceil((n - 1) / (maxLabels - 1)));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += every) if (i === 0 || n - 1 - i >= every / 2) out.push(i);
  out.push(n - 1);
  return out;
}

export function renderLegend(target: HTMLElement, spec: LegendSpec | null, emptyText = 'No legend for this layer'): void {
  if (!spec) {
    setChildren(target, h('div', { class: 'wg-legend-empty', text: emptyText }));
    return;
  }
  if (spec.kind === 'gradient') {
    const n = spec.stops.length;
    const pos = (i: number): number => (n > 1 ? (100 * i) / (n - 1) : 0);
    // Stops are spaced evenly: several painter scales are logarithmic or piecewise.
    const css = spec.stops.map((s, i) => `${rgbCss(s.color)} ${pos(i)}%`).join(', ');
    const labels = labelIndices(n).map((i) =>
      h('span', { style: { left: `${pos(i)}%` }, text: trimLabel(spec.stops[i].label ?? String(spec.stops[i].value), spec.unit) }),
    );
    setChildren(target,
      h('div', { class: 'wg-legend-title' }, h('b', { text: spec.title }), spec.unit ? h('span', { text: spec.unit }) : null),
      h('div', { class: 'wg-gradient', style: { background: `linear-gradient(to right, ${css})` } }),
      h('div', { class: 'wg-gradient-labels' }, ...labels),
    );
    return;
  }
  // Numeric codes (plate ids) carry no information for the reader.
  const coded = spec.items.some((it) => it.code && !/^\d+$/.test(it.code));
  setChildren(target,
    h('div', { class: 'wg-legend-title' }, h('b', { text: spec.title })),
    h('div', { class: 'wg-cats' },
      ...spec.items.map((it) =>
        h('div', { class: `wg-cat${coded ? '' : ' is-plain'}`, title: it.code && coded ? `${it.code} — ${it.label}` : it.label },
          h('i', { class: 'wg-swatch', style: { background: rgbCss(it.color) } }),
          coded ? h('code', { text: it.code ?? '' }) : null,
          h('span', { text: it.label }),
        ),
      ),
    ),
  );
}
