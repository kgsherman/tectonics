/**
 * Equirect DataTextures for the globe. Each slot owns a CPU copy of the caller's data (the contract
 * lets callers reuse/transfer their buffers right after a set* call; uploads happen at render time),
 * reuses the GPU texture while the size is unchanged, and only uploads when new data arrives.
 * Textures are row-0-north and sampled at (uv.x, 1 − uv.y) in the shaders, so flipY stays false.
 */
import {
  ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RedFormat,
  RepeatWrapping, RGBAFormat, RGFormat, SRGBColorSpace, UnsignedByteType,
} from 'three';
import type { ColorSpace, PixelFormat, TextureDataType } from 'three';

interface TextureSpec {
  format: PixelFormat;
  type: TextureDataType;
  colorSpace: ColorSpace;
  /** Sized internal format override (e.g. R16F fed from Float32 data). */
  internalFormat: 'R16F' | 'RG16F' | null;
  mipmaps: 'gpu' | 'cpu' | 'none';
  unpackAlignment: 1 | 4;
}

function createTexture(spec: TextureSpec, data: Uint8Array | Float32Array, w: number, h: number, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, w, h, spec.format, spec.type);
  tex.colorSpace = spec.colorSpace;
  if (spec.internalFormat) tex.internalFormat = spec.internalFormat;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = spec.mipmaps === 'none' ? LinearFilter : LinearMipmapLinearFilter;
  tex.generateMipmaps = spec.mipmaps === 'gpu';
  tex.anisotropy = anisotropy;
  tex.flipY = false;
  tex.unpackAlignment = spec.unpackAlignment;
  tex.needsUpdate = true;
  return tex;
}

/**
 * RGBA8 equirect image (base: sRGB texture, decoded by the GPU; overlay: raw sRGB bytes premultiplied
 * on copy for fringe-free filtering, un-premultiplied and decoded in the shader).
 */
export class RgbaTextureSlot {
  texture: DataTexture | null = null;
  private data: Uint8Array | null = null;
  private w = 0;
  private h = 0;

  constructor(
    private readonly srgb: boolean,
    private readonly premultiply: boolean,
    private readonly anisotropy: number,
  ) {}

  /** Copies rgba (w*h*4) and schedules an upload. Returns true when the texture object changed. */
  set(rgba: Uint8ClampedArray, w: number, h: number): boolean {
    if (!(w > 0 && h > 0) || rgba.length < w * h * 4) throw new Error(`RgbaTextureSlot: expected ${w}x${h}x4 bytes, got ${rgba.length}`);
    const recreate = !this.texture || w !== this.w || h !== this.h;
    if (recreate) {
      this.dispose();
      this.data = new Uint8Array(w * h * 4);
      this.w = w;
      this.h = h;
    }
    const dst = this.data!;
    if (this.premultiply) {
      for (let i = 0; i < w * h * 4; i += 4) {
        const a = rgba[i + 3];
        const s = a / 255;
        dst[i] = rgba[i] * s + 0.5;
        dst[i + 1] = rgba[i + 1] * s + 0.5;
        dst[i + 2] = rgba[i + 2] * s + 0.5;
        dst[i + 3] = a;
      }
    } else {
      dst.set(rgba.subarray(0, w * h * 4));
    }
    if (recreate) {
      this.texture = createTexture(
        {
          format: RGBAFormat, type: UnsignedByteType, colorSpace: this.srgb ? SRGBColorSpace : NoColorSpace,
          internalFormat: null, mipmaps: 'gpu', unpackAlignment: 4,
        },
        dst, w, h, this.anisotropy,
      );
    } else {
      this.texture!.needsUpdate = true;
    }
    return recreate;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.data = null;
    this.w = this.h = 0;
  }
}

export interface FloatMip {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Box-filtered mip chain (level 0 = src) for a single-channel float image. Buffers of `reuse`
 * (a previous chain of the same size) are recycled.
 */
export function buildFloatMips(src: Float32Array, w: number, h: number, reuse?: FloatMip[]): FloatMip[] {
  const levels: FloatMip[] = [{ data: src, width: w, height: h }];
  let cw = w, ch = h, cur = src;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const old = reuse?.[levels.length];
    const next = old && old.width === nw && old.height === nh ? old.data : new Float32Array(nw * nh);
    for (let r = 0; r < nh; r++) {
      const r0 = Math.min(ch - 1, 2 * r) * cw;
      const r1 = Math.min(ch - 1, 2 * r + 1) * cw;
      for (let c = 0; c < nw; c++) {
        const c0 = Math.min(cw - 1, 2 * c), c1 = Math.min(cw - 1, 2 * c + 1);
        next[r * nw + c] = 0.25 * (cur[r0 + c0] + cur[r0 + c1] + cur[r1 + c0] + cur[r1 + c1]);
      }
    }
    levels.push({ data: next, width: nw, height: nh });
    cur = next;
    cw = nw;
    ch = nh;
  }
  return levels;
}

/**
 * Height map as an R16F texture (uploaded from Float32 data; the GPU stores half floats) with a CPU
 * box-filtered mip chain (R16F is not guaranteed renderable, so GPU mip generation is avoided).
 */
export class HeightTextureSlot {
  texture: DataTexture | null = null;
  private w = 0;
  private h = 0;
  /** Mean of the northern/southern-most rows (closes the displaced mesh at the poles). */
  poleNorth = 0;
  poleSouth = 0;

  constructor(private readonly anisotropy: number) {}

  set(height: Float32Array, w: number, h: number): void {
    if (!(w > 0 && h > 0) || height.length < w * h) throw new Error(`HeightTextureSlot: expected ${w}x${h} floats, got ${height.length}`);
    const sameSize = this.texture !== null && w === this.w && h === this.h;
    const prev = sameSize ? (this.texture!.mipmaps as FloatMip[]) : undefined;
    const level0 = prev ? prev[0].data : new Float32Array(w * h);
    level0.set(height.subarray(0, w * h));
    let sn = 0, ss = 0;
    for (let c = 0; c < w; c++) {
      sn += level0[c];
      ss += level0[(h - 1) * w + c];
    }
    this.poleNorth = sn / w;
    this.poleSouth = ss / w;
    const mips = buildFloatMips(level0, w, h, prev);
    if (!sameSize) {
      this.dispose();
      this.w = w;
      this.h = h;
      this.texture = createTexture(
        {
          format: RedFormat, type: FloatType, colorSpace: NoColorSpace,
          internalFormat: 'R16F', mipmaps: 'cpu', unpackAlignment: 4,
        },
        level0, w, h, this.anisotropy,
      );
    }
    const tex = this.texture!;
    tex.image = { data: level0, width: w, height: h };
    tex.mipmaps = mips;
    tex.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.w = this.h = 0;
  }
}

/** Small single/dual-channel data grids (cloud cover as R8, wind as RG16F), linear filtered. */
export class GridTextureSlot {
  texture: DataTexture | null = null;
  private w = 0;
  private h = 0;

  constructor(private readonly kind: 'r8' | 'rg16f') {}

  /** cover: values 0..1 → R8. */
  setScalar(values: Float32Array, w: number, h: number): void {
    if (values.length < w * h) throw new Error(`GridTextureSlot: expected ${w * h} values`);
    const data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = values[i];
      data[i] = v === v ? Math.round(Math.min(1, Math.max(0, v)) * 255) : 0;
    }
    this.upload(data, w, h);
  }

  /** (u, v) vectors → RG16F; NaN becomes 0. */
  setVector(u: Float32Array, v: Float32Array, w: number, h: number): void {
    if (u.length < w * h || v.length < w * h) throw new Error(`GridTextureSlot: expected ${w * h} vectors`);
    const data = new Float32Array(2 * w * h);
    for (let i = 0; i < w * h; i++) {
      const a = u[i], b = v[i];
      data[2 * i] = a === a ? a : 0;
      data[2 * i + 1] = b === b ? b : 0;
    }
    this.upload(data, w, h);
  }

  private upload(data: Uint8Array | Float32Array, w: number, h: number): void {
    if (!this.texture || w !== this.w || h !== this.h) {
      this.dispose();
      this.w = w;
      this.h = h;
      const r8 = this.kind === 'r8';
      this.texture = createTexture(
        {
          format: r8 ? RedFormat : RGFormat, type: r8 ? UnsignedByteType : FloatType, colorSpace: NoColorSpace,
          internalFormat: r8 ? null : 'RG16F', mipmaps: 'none', unpackAlignment: r8 ? 1 : 4,
        },
        data, w, h, 1,
      );
      return;
    }
    this.texture.image = { data, width: w, height: h };
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.w = this.h = 0;
  }
}
