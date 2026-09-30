/** Hover inspector: position, elevation, plate & crust, Köppen class and a climograph. */
import {
  compass, fmtElev, fmtLat, fmtLon, fmtMyr, fmtNum, fmtPercent, fmtPlateSpeed, fmtPrecip, fmtTemp, monthLabel,
} from '../format';
import type { InspectSample } from '../inspect';
import { Climograph } from './climograph';
import { miniStats } from './controls';
import { h, rgbCss, setChildren, setText, toggleClass } from './dom';
import { icon } from './icons';

export class InspectorView {
  readonly el = h('div', { class: 'wg-inspector' });
  private readonly empty = h('div', { class: 'wg-insp-empty' }, icon('cursor', 18), h('span', { text: 'Hover the planet to inspect a location' }));
  private readonly coordsLat = h('b');
  private readonly coordsLon = h('b');
  private readonly coordsElev = h('b');
  private readonly body = h('div', { class: 'wg-inspector' });

  private readonly plateSwatch = h('i', { class: 'wg-swatch' });
  private readonly plateName = h('span', { class: 'wg-grow' });
  private readonly boundaryTag = h('span', { class: 'wg-tag' });
  private readonly tecStats = miniStats([
    { key: 'crust', label: 'Crust' },
    { key: 'age', label: 'Crust age' },
    { key: 'motion', label: 'Plate motion' },
    { key: 'uplift', label: 'Recent uplift' },
  ]);
  private readonly tecBlock = h('div', { class: 'wg-insp-block' },
    h('div', { class: 'wg-insp-head' }, this.plateSwatch, this.plateName, this.boundaryTag), this.tecStats.el);

  private readonly kChip = h('span', { class: 'wg-koppen-chip' });
  private readonly kName = h('span', { class: 'wg-grow' });
  private readonly climograph = new Climograph();
  private readonly climStats = miniStats([
    { key: 'tAnnual', label: 'Mean temp.' },
    { key: 'pAnnual', label: 'Precipitation' },
    { key: 'month', label: 'Month' },
    { key: 'wind', label: 'Wind' },
    { key: 'sea', label: 'Sea surface' },
    { key: 'cover', label: 'Cloud · snow' },
  ]);
  private readonly climBlock = h('div', { class: 'wg-insp-block' },
    h('div', { class: 'wg-insp-head' }, this.kChip, this.kName), this.climograph.canvas, this.climStats.el);
  private readonly noClimate = h('div', { class: 'wg-insp-block' },
    h('p', { class: 'wg-hint' }, icon('thermometer', 14), h('span', { text: 'Compute a climate to see temperature, rainfall and the Köppen class here.' })));

  constructor() {
    this.body.append(
      h('div', { class: 'wg-insp-coords' }, h('span', null, this.coordsLat, ' ', this.coordsLon), h('span', null, this.coordsElev)),
      this.tecBlock,
      this.climBlock,
      this.noClimate,
    );
    setChildren(this.el, this.empty);
  }

  /** `stale`: the sample is the last one (pointer left the planet). */
  update(s: InspectSample | null, month: number, stale: boolean): void {
    if (!s) {
      setChildren(this.el, this.empty);
      return;
    }
    if (this.body.parentNode !== this.el) setChildren(this.el, this.body);
    toggleClass(this.body, 'is-stale', stale);
    setText(this.coordsLat, fmtLat(s.lat));
    setText(this.coordsLon, fmtLon(s.lon));
    setText(this.coordsElev, s.elevation === null ? '' : `${fmtElev(s.elevation)} · ${s.land ? 'land' : 'sea'}`);

    const t = s.tectonic;
    this.tecBlock.hidden = !t;
    if (t) {
      this.plateSwatch.style.background = rgbCss(t.plateColor);
      setText(this.plateName, t.plateName);
      this.boundaryTag.hidden = !t.boundary;
      if (t.boundary) {
        setText(this.boundaryTag, t.boundary);
        this.boundaryTag.className = `wg-tag is-${t.boundary}`;
      }
      this.tecStats.set('crust', t.continental ? 'Continental' : 'Oceanic');
      this.tecStats.set('age', fmtMyr(t.age));
      this.tecStats.set('motion', t.speed > 0.05 ? `${fmtPlateSpeed(t.speed)} ${compass(t.bearing)}` : 'stationary');
      this.tecStats.set('uplift', t.orogeny > 1 ? fmtElev(t.orogeny) : '—');
    }

    const c = s.climate;
    this.climBlock.hidden = !c;
    this.noClimate.hidden = !!c || !t;
    if (c) {
      this.kChip.style.background = rgbCss(c.color);
      this.kChip.style.color = c.color[0] * 0.3 + c.color[1] * 0.55 + c.color[2] * 0.15 > 140 ? '#0b0f14' : '#fff';
      setText(this.kChip, c.code);
      setText(this.kName, c.name);
      this.climograph.draw(c.temp, c.precip, month);
      this.climStats.set('tAnnual', fmtTemp(c.tempAnnual));
      this.climStats.set('pAnnual', `${fmtPrecip(c.precipAnnual)}/yr`);
      this.climStats.set('month', month < 0 ? 'Annual view' : `${monthLabel(month)} ${fmtTemp(c.monthTemp, 0)} · ${fmtPrecip(c.monthPrecip)}`);
      // Meteorological convention: the direction the wind blows from.
      this.climStats.set('wind', `${fmtNum(c.windSpeed, 1)} m/s from ${compass(c.windBearing + 180)}`);
      this.climStats.set('sea', s.land ? '—' : `${fmtTemp(c.sst)}${c.seaIce > 0.02 ? ` · ice ${fmtPercent(c.seaIce)}` : ''}`);
      this.climStats.set('cover', `${fmtPercent(c.cloud)} · ${fmtPercent(c.snow)}`);
    }
  }
}
