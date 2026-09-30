/** Climograph canvas: monthly precipitation bars (right axis) and temperature line (left axis). */
import { climographScale } from '../climographScale';

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const COLORS = {
  grid: 'rgba(139, 155, 176, 0.14)',
  zero: 'rgba(139, 155, 176, 0.38)',
  axis: '#8b9bb0',
  bar: 'rgba(79, 163, 255, 0.78)',
  barDim: 'rgba(79, 163, 255, 0.42)',
  line: '#ff8a5c',
  highlight: 'rgba(215, 224, 234, 0.07)',
};

export class Climograph {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wg-climograph';
    this.canvas.setAttribute('role', 'img');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Climograph: 2D canvas unavailable');
    this.ctx = ctx;
  }

  draw(temp: ArrayLike<number>, precip: ArrayLike<number>, month: number): void {
    const cssW = this.canvas.clientWidth || 260;
    const cssH = this.canvas.clientHeight || 132;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const s = climographScale(temp, precip);
    const padL = 26, padR = 30, padT = 8, padB = 16;
    const pw = cssW - padL - padR;
    const ph = cssH - padT - padB;
    const x = (m: number): number => padL + ((m + 0.5) * pw) / 12;
    const yT = (t: number): number => padT + ph * (1 - s.tFrac(t));
    const yP = (p: number): number => padT + ph * (1 - s.pFrac(p));
    g.font = '10px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';

    // Selected month.
    if (month >= 0) {
      g.fillStyle = COLORS.highlight;
      g.fillRect(padL + (month * pw) / 12, padT, pw / 12, ph);
    }
    // Temperature grid + left labels.
    g.textAlign = 'right';
    for (const t of s.tTicks) {
      const y = Math.round(yT(t)) + 0.5;
      g.strokeStyle = t === 0 ? COLORS.zero : COLORS.grid;
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(padL + pw, y);
      g.stroke();
      g.fillStyle = COLORS.axis;
      g.fillText(`${t < 0 ? '−' : ''}${Math.abs(t)}°`, padL - 5, y);
    }
    // Precipitation right labels.
    g.textAlign = 'left';
    for (const p of s.pTicks) g.fillText(String(p), padL + pw + 5, yP(p));
    // Bars.
    const bw = Math.max(2, (pw / 12) * 0.62);
    for (let m = 0; m < 12; m++) {
      const v = precip[m];
      if (!Number.isFinite(v) || v <= 0) continue;
      const y = yP(v);
      g.fillStyle = month < 0 || m === month ? COLORS.bar : COLORS.barDim;
      g.fillRect(x(m) - bw / 2, y, bw, padT + ph - y);
    }
    // Temperature line.
    g.strokeStyle = COLORS.line;
    g.lineWidth = 1.8;
    g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (let m = 0; m < 12; m++) {
      const v = temp[m];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      if (started) g.lineTo(x(m), yT(v));
      else g.moveTo(x(m), yT(v));
      started = true;
    }
    g.stroke();
    g.fillStyle = COLORS.line;
    for (let m = 0; m < 12; m++) {
      const v = temp[m];
      if (!Number.isFinite(v)) continue;
      g.beginPath();
      g.arc(x(m), yT(v), m === month ? 3.2 : 1.8, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = 1;
    // Month initials.
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let m = 0; m < 12; m++) {
      g.fillStyle = m === month ? '#d7e0ea' : COLORS.axis;
      g.fillText(MONTH_INITIALS[m], x(m), cssH - 3);
    }
  }
}
