/** Atmosphere halo shell and a subtle starfield. */
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Group, Mesh, Points, ShaderMaterial, SphereGeometry,
} from 'three';
import { Rng } from '../core/rng';
import type { SharedUniforms } from './globeSurface';
import { SHELL_VERTEX } from './shadersCommon';
import { ATMOSPHERE_FRAGMENT, STARS_FRAGMENT, STARS_VERTEX } from './shadersSky';

const ATMOSPHERE_RADIUS = 1.045;
const STAR_COUNT = 2600;
const STAR_DISTANCE = 60;

export class GlobeSky {
  readonly group = new Group();
  private readonly atmosphere: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly stars: Points<BufferGeometry, ShaderMaterial>;

  constructor(shared: SharedUniforms, dpr: number) {
    const atmoMat = new ShaderMaterial({
      uniforms: {
        uShellRadius: { value: ATMOSPHERE_RADIUS },
        uIntensity: { value: 1.35 },
        uAtmoColor: shared.uAtmoColor,
        uLightMode: shared.uLightMode,
        uSunDir: shared.uSunDir,
      },
      vertexShader: SHELL_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.atmosphere = new Mesh(new SphereGeometry(1, 96, 48), atmoMat);
    this.atmosphere.renderOrder = 5;

    const rng = new Rng(0x57a125);
    const pos = new Float32Array(3 * STAR_COUNT);
    const size = new Float32Array(STAR_COUNT);
    const bright = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      const v = rng.unitVector();
      pos[3 * i] = v[0] * STAR_DISTANCE;
      pos[3 * i + 1] = v[1] * STAR_DISTANCE;
      pos[3 * i + 2] = v[2] * STAR_DISTANCE;
      // Many faint stars, few bright ones.
      const m = Math.pow(rng.next(), 4);
      size[i] = 1.2 + 2.2 * m;
      bright[i] = 0.12 + 0.75 * m;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.setAttribute('aBright', new BufferAttribute(bright, 1));
    const starMat = new ShaderMaterial({
      uniforms: { uDpr: { value: dpr }, uIntensity: { value: 1 } },
      vertexShader: STARS_VERTEX,
      fragmentShader: STARS_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.stars = new Points(g, starMat);
    this.stars.renderOrder = -10;
    this.stars.frustumCulled = false;
    this.group.add(this.stars, this.atmosphere);
  }

  setDpr(dpr: number): void {
    this.stars.material.uniforms.uDpr.value = dpr;
  }

  dispose(): void {
    this.atmosphere.geometry.dispose();
    this.atmosphere.material.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
  }
}
