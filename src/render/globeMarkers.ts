/**
 * Screen-space marker sprites (constant pixel size) on the globe plus optional DOM text labels.
 * Sprites cull themselves on the far hemisphere in the vertex shader; labels are positioned from
 * GlobeView.project() after each render.
 */
import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import type { GeoPoint, MarkerSpec } from '../core/types';
import { MARKER_FRAGMENT, MARKER_VERTEX } from './shadersPrimitives';
import { geoToThree, srgbToLinear } from './viewUtil';

export class GlobeMarkers {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private markers: MarkerSpec[] = [];
  private readonly labelLayer: HTMLDivElement;
  private labels: HTMLDivElement[] = [];
  /** Last applied transform per label ('' = hidden): style is written only when it changes. */
  private labelState: string[] = [];

  constructor(labelParent: HTMLElement, dpr: number) {
    const material = new ShaderMaterial({
      uniforms: { uDpr: { value: dpr } },
      vertexShader: MARKER_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new Points(new BufferGeometry(), material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.visible = false;
    this.labelLayer = document.createElement('div');
    Object.assign(this.labelLayer.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden',
      font: '600 11px/1.2 system-ui, sans-serif', color: '#fff',
    });
    labelParent.appendChild(this.labelLayer);
  }

  /** radiusAt: display radius (unit sphere + relief + lift) of a marker at a lat/lon. */
  set(markers: MarkerSpec[], radiusAt: (p: GeoPoint) => number): void {
    this.markers = markers.slice();
    const n = markers.length;
    const pos = new Float32Array(3 * n), col = new Float32Array(3 * n);
    const size = new Float32Array(n), hi = new Float32Array(n);
    const p: [number, number, number] = [0, 0, 0];
    markers.forEach((m, i) => {
      geoToThree(m.lat, m.lon, radiusAt(m), p);
      pos.set(p, 3 * i);
      col[3 * i] = srgbToLinear(m.color[0]);
      col[3 * i + 1] = srgbToLinear(m.color[1]);
      col[3 * i + 2] = srgbToLinear(m.color[2]);
      size[i] = Math.max(1, m.radiusPx);
      hi[i] = m.highlighted ? 1 : 0;
    });
    const g = this.points.geometry;
    g.dispose();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.setAttribute('aHighlight', new BufferAttribute(hi, 1));
    g.setDrawRange(0, n);
    this.points.visible = n > 0;
    this.syncLabels();
  }

  /**
   * Re-evaluates marker radii (after relief/sea-level/height-map changes, i.e. every playback frame):
   * positions are rewritten in place; geometry and DOM labels are kept.
   */
  refresh(radiusAt: (p: GeoPoint) => number): void {
    const n = this.markers.length;
    if (n === 0) return;
    const attr = this.points.geometry.getAttribute('position') as BufferAttribute;
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const m = this.markers[i];
      geoToThree(m.lat, m.lon, radiusAt(m), p);
      attr.setXYZ(i, p[0], p[1], p[2]);
    }
    attr.needsUpdate = true;
  }

  setDpr(dpr: number): void {
    this.points.material.uniforms.uDpr.value = dpr;
  }

  private syncLabels(): void {
    for (const l of this.labels) l.remove();
    this.labels = [];
    this.labelState = [];
    for (const m of this.markers) {
      const el = document.createElement('div');
      el.textContent = m.label ?? '';
      Object.assign(el.style, {
        position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', textShadow: '0 0 3px #000, 0 0 2px #000',
        display: 'none',
      });
      this.labelLayer.appendChild(el);
      this.labels.push(el);
      this.labelState.push('');
    }
  }

  /** Positions labels; project returns viewport-relative CSS px. */
  updateLabels(project: (m: MarkerSpec) => { x: number; y: number; visible: boolean }): void {
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const el = this.labels[i];
      if (!m.label) continue;
      const p = project(m);
      const next = p.visible ? `translate(${Math.round(p.x + m.radiusPx + 4)}px, ${Math.round(p.y - 7)}px)` : '';
      if (next === this.labelState[i]) continue;
      this.labelState[i] = next;
      if (next) {
        el.style.transform = next;
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    }
  }

  get hasLabels(): boolean {
    return this.markers.some((m) => !!m.label);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.labelLayer.remove();
  }
}
