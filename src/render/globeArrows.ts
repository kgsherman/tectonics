/**
 * Instanced great-circle arrows: one template ribbon (shaft strip + head triangle) instanced per
 * ArrowSpec, drawn twice (dark/highlight outline, then color) with polygonOffset to keep the
 * color pass on top without z-fighting.
 */
import {
  BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial,
} from 'three';
import type { ArrowSpec } from '../core/types';
import { ARROW_VERTEX, FLAT_COLOR_FRAGMENT } from './shadersPrimitives';
import { arrowFrame, srgbToLinear, vecToThree } from './viewUtil';

const SHAFT_SEGMENTS = 24;

function buildTemplate(): { shape: Float32Array; index: Uint16Array } {
  const shape: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= SHAFT_SEGMENTS; i++) {
    const t = i / SHAFT_SEGMENTS;
    shape.push(t, -1, 0, t, 1, 0);
    if (i < SHAFT_SEGMENTS) {
      const a = 2 * i;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const h = shape.length / 3;
  // Head: right base, left base, tip (side +1 = left of travel).
  shape.push(0, -1, 1, 0, 1, 1, 1, 0, 1);
  index.push(h, h + 2, h + 1);
  return { shape: new Float32Array(shape), index: new Uint16Array(index) };
}

export class GlobeArrows {
  readonly group = new Group();
  private readonly geometry = new InstancedBufferGeometry();
  private readonly outline: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly body: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private capacity = 0;

  constructor() {
    const { shape, index } = buildTemplate();
    this.geometry.setAttribute('aShape', new BufferAttribute(shape, 3));
    // Three needs a `position` attribute for bounding volumes; culling is disabled anyway.
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(shape.length), 3));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.ensureCapacity(16);
    const make = (outline: boolean): ShaderMaterial =>
      new ShaderMaterial({
        uniforms: {
          uRadius: { value: 1.003 },
          uOutline: { value: outline ? 0.0022 : 0 },
          uMinHalfWidth: { value: 0.004 },
        },
        vertexShader: ARROW_VERTEX,
        fragmentShader: FLAT_COLOR_FRAGMENT,
        polygonOffset: true,
        polygonOffsetFactor: outline ? -1 : -3,
        polygonOffsetUnits: outline ? -1 : -3,
      });
    this.outline = new Mesh(this.geometry, make(true));
    this.body = new Mesh(this.geometry, make(false));
    for (const m of [this.outline, this.body]) {
      m.frustumCulled = false;
      m.visible = false;
    }
    this.outline.renderOrder = 1;
    this.body.renderOrder = 2;
    this.group.add(this.outline, this.body);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(n, this.capacity * 2);
    // Free the GPU buffers of the old (smaller) instance attributes; everything re-uploads lazily.
    if (this.capacity > 0) this.geometry.dispose();
    this.geometry.setAttribute('iTail', new InstancedBufferAttribute(new Float32Array(3 * cap), 3));
    this.geometry.setAttribute('iDir', new InstancedBufferAttribute(new Float32Array(3 * cap), 3));
    this.geometry.setAttribute('iLength', new InstancedBufferAttribute(new Float32Array(cap), 1));
    this.geometry.setAttribute('iColor', new InstancedBufferAttribute(new Float32Array(3 * cap), 3));
    this.geometry.setAttribute('iHighlight', new InstancedBufferAttribute(new Float32Array(cap), 1));
    this.capacity = cap;
  }

  set(arrows: ArrowSpec[]): void {
    this.ensureCapacity(arrows.length);
    const tail = this.geometry.getAttribute('iTail') as InstancedBufferAttribute;
    const dir = this.geometry.getAttribute('iDir') as InstancedBufferAttribute;
    const len = this.geometry.getAttribute('iLength') as InstancedBufferAttribute;
    const col = this.geometry.getAttribute('iColor') as InstancedBufferAttribute;
    const hi = this.geometry.getAttribute('iHighlight') as InstancedBufferAttribute;
    const T = tail.array as Float32Array, D = dir.array as Float32Array, Ln = len.array as Float32Array;
    const C = col.array as Float32Array, H = hi.array as Float32Array;
    let n = 0;
    const tmp: [number, number, number] = [0, 0, 0];
    for (const a of arrows) {
      const f = arrowFrame(a);
      if (!f) continue;
      vecToThree(f.tail[0], f.tail[1], f.tail[2], tmp);
      T.set(tmp, 3 * n);
      vecToThree(f.dir[0], f.dir[1], f.dir[2], tmp);
      D.set(tmp, 3 * n);
      Ln[n] = f.length;
      C[3 * n] = srgbToLinear(a.color[0]);
      C[3 * n + 1] = srgbToLinear(a.color[1]);
      C[3 * n + 2] = srgbToLinear(a.color[2]);
      H[n] = a.highlighted ? 1 : 0;
      n++;
    }
    for (const attr of [tail, dir, len, col, hi]) attr.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.outline.visible = this.body.visible = n > 0;
  }

  /** Radius at which arrows float (above the highest displaced terrain). */
  setRadius(r: number): void {
    this.outline.material.uniforms.uRadius.value = r;
    this.body.material.uniforms.uRadius.value = r;
  }

  /** Keeps shafts ≥ ~1.5 px wide: pxPerRadian = screen pixels per radian of arc near the view center. */
  setPixelScale(pxPerRadian: number): void {
    const minHalf = 1.6 / Math.max(1, pxPerRadian);
    this.outline.material.uniforms.uMinHalfWidth.value = minHalf;
    this.body.material.uniforms.uMinHalfWidth.value = minHalf;
    this.outline.material.uniforms.uOutline.value = 1.1 / Math.max(1, pxPerRadian);
  }

  dispose(): void {
    this.geometry.dispose();
    this.outline.material.dispose();
    this.body.material.dispose();
  }
}
