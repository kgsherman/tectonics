import { Color, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type {
  ArrowSpec, BrushCursor, CloudSpec, GeoPoint, LightingMode, MarkerSpec, VectorFieldSpec, WorldPointerEvent, WorldView,
} from '../core/types';
import { GlobeClouds } from './cloudsGlobe';
import { GlobeArrows } from './globeArrows';
import { DEFAULT_DISTANCE, GlobeControls } from './globeControls';
import { GlobeInput } from './globeInput';
import { GlobeMarkers } from './globeMarkers';
import { GlobeSky } from './globeSky';
import { GlobeSurface, LIGHT_FLAT, LIGHT_RELIEF, LIGHT_SUN, type SharedUniforms } from './globeSurface';
import { copyVectorField, DEFAULT_PARTICLE_COUNT, ParticleSystem } from './particles';
import { GlobeParticles } from './particlesGlobe';
import { HeightField } from './viewHeight';
import { PointerHub } from './viewPointer';
import {
  clientToNdc, facesCamera, geoToThree, ndcToClient, pickDisplacedSphere, projectWorld, rayFromNdc,
  RELIEF_BASE_EXAGGERATION, srgbToLinear, sunDirectionThree, threeToGeo, wrapLon, type ViewRect,
} from './viewUtil';

/** In 'sun' mode the subsolar longitude trails the camera by this much (terminator on the right third of the disk). */
const SUN_LON_OFFSET = (-55 * Math.PI) / 180;
const MARKER_LIFT = 0.004;
const ARROW_LIFT = 0.003;
const PARTICLE_LIFT = 0.0025;
const ATMOSPHERE_COLOR = new Color(0.32, 0.55, 1.0);
const BACKGROUND = new Color(0x020308);
const FOV = 35;

/** Three.js 3D globe implementation of WorldView (SPEC.md §8.1). */
export class GlobeView implements WorldView {
  readonly kind = 'globe' as const;
  readonly element: HTMLElement;

  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: GlobeControls;
  private readonly shared: SharedUniforms;
  private readonly surface: GlobeSurface;
  private readonly sky: GlobeSky;
  private readonly clouds: GlobeClouds;
  private readonly arrows: GlobeArrows;
  private readonly markers: GlobeMarkers;
  private readonly particleLines: GlobeParticles;
  private readonly heights = new HeightField();
  private readonly pointers = new PointerHub();
  private readonly input: GlobeInput;
  private readonly resizeObserver: ResizeObserver;

  private particles: ParticleSystem | null = null;
  private particleCount = DEFAULT_PARTICLE_COUNT;
  private seaLevel = 0;
  private reliefScale = 1;
  private lighting: LightingMode = { mode: 'relief' };
  private fixedSunLon: number | null = null;
  private mode: 'navigate' | 'paint' = 'navigate';

  private raf = 0;
  private disposed = false;
  private needsRender = true;
  private lastFrameMs = -1;
  /** Animation clock (s): advances only while something animates. */
  private clock = 0;
  private readonly tmpMat = new Matrix4();
  private readonly tmpV = new Vector3();
  private readonly tmpV2 = new Vector3();

  constructor(container: HTMLElement) {
    this.element = container;
    this.root = document.createElement('div');
    Object.assign(this.root.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' });
    container.appendChild(this.root);

    try {
      this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      // No WebGL: leave the container as we found it (callers fall back to the map).
      this.root.remove();
      throw e;
    }
    this.renderer.setPixelRatio(this.dpr());
    this.renderer.setClearColor(BACKGROUND, 1);
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' });
    this.root.appendChild(this.canvas);

    this.camera = new PerspectiveCamera(FOV, 1, 0.005, 200);
    this.setView({ lat: (20 * Math.PI) / 180, lon: 0 }, DEFAULT_DISTANCE);

    this.shared = {
      uLightMode: { value: LIGHT_RELIEF },
      uSunDir: { value: new Vector3(1, 0, 0) },
      uAtmoColor: { value: ATMOSPHERE_COLOR.clone() },
    };
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.surface = new GlobeSurface(this.shared, aniso);
    this.sky = new GlobeSky(this.shared, this.dpr());
    this.clouds = new GlobeClouds(this.shared);
    this.arrows = new GlobeArrows();
    this.markers = new GlobeMarkers(this.root, this.dpr());
    this.particleLines = new GlobeParticles();
    this.scene.add(this.sky.group, this.surface.mesh, this.arrows.group, this.clouds.mesh, this.particleLines.lines, this.markers.points);

    this.controls = new GlobeControls(this.camera, this.canvas);
    this.controls.orbit.addEventListener('change', this.onControlsChange);
    this.applyRelief();
    this.input = new GlobeInput({
      root: this.root,
      canvas: this.canvas,
      pointers: this.pointers,
      controls: this.controls,
      mode: () => this.mode,
      pick: (x, y) => this.pick(x, y),
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ------------------------------------------------------------------ */
  /* WorldView data setters                                              */
  /* ------------------------------------------------------------------ */

  setBaseImage(rgba: Uint8ClampedArray, width: number, height: number): void {
    this.surface.setBase(rgba, width, height);
    this.invalidate();
  }

  setHeightMap(height: Float32Array | null, width: number, height_: number): void {
    if (height) this.heights.set(height, width, height_);
    else this.heights.clear();
    this.surface.setHeight(height, width, height_);
    this.applyRelief();
  }

  setSeaLevel(seaLevel: number): void {
    // The app re-sends view props on every month change: skip the relief re-application when unchanged.
    if (seaLevel === this.seaLevel) return;
    this.seaLevel = seaLevel;
    this.surface.setSeaLevel(seaLevel);
    this.applyRelief();
  }

  setOverlayImage(rgba: Uint8ClampedArray | null, width: number, height: number): void {
    this.surface.setOverlay(rgba, width, height);
    this.invalidate();
  }

  setVectorField(spec: VectorFieldSpec | null): void {
    const field = spec ? copyVectorField(spec) : null;
    if (!field) {
      this.particles = null;
      this.particleLines.reset();
      this.particleLines.setVisible(false);
    } else if (this.particles && this.particles.kind === field.kind && this.particles.count === this.particleCount) {
      this.particles.setField(field);
    } else {
      this.particles = new ParticleSystem(field, { count: this.particleCount, blocked: this.blockedFor(field.kind) });
      this.particleLines.reset();
    }
    this.invalidate();
  }

  setClouds(clouds: CloudSpec | null): void {
    this.clouds.set(clouds);
    this.invalidate();
  }

  setArrows(arrows: ArrowSpec[]): void {
    this.arrows.set(arrows); // converted to instance buffers immediately (no references kept)
    this.invalidate();
  }

  setMarkers(markers: MarkerSpec[]): void {
    this.markers.set(markers.map((m) => ({ ...m, color: [m.color[0], m.color[1], m.color[2]] })), this.markerRadius);
    this.invalidate();
  }

  setBrushCursor(cursor: BrushCursor | null): void {
    if (!cursor) {
      this.surface.setBrush(null, 0, new Color(1, 1, 1));
    } else {
      const c = geoToThree(cursor.point.lat, cursor.point.lon, 1);
      const rgb = cursor.color ?? [255, 255, 255];
      this.surface.setBrush(
        this.tmpV.set(c[0], c[1], c[2]),
        cursor.radius,
        new Color(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])),
      );
    }
    this.invalidate();
  }

  setInteractionMode(mode: 'navigate' | 'paint'): void {
    this.mode = mode;
    this.controls.setMode(mode);
    this.canvas.style.cursor = mode === 'paint' ? 'crosshair' : 'grab';
  }

  setLighting(lighting: LightingMode): void {
    this.lighting = { ...lighting };
    this.shared.uLightMode.value = lighting.mode === 'flat' ? LIGHT_FLAT : lighting.mode === 'relief' ? LIGHT_RELIEF : LIGHT_SUN;
    this.invalidate();
  }

  setReliefScale(scale: number): void {
    const next = Math.max(0, Number.isFinite(scale) ? scale : 0);
    if (next === this.reliefScale) return;
    this.reliefScale = next;
    this.applyRelief();
  }

  /* ------------------------------------------------------------------ */
  /* Optional extras (not in the WorldView contract)                     */
  /* ------------------------------------------------------------------ */

  /** Analytic graticule drawn in the surface shader (every stepDeg degrees; equator/prime meridian emphasized). */
  setGraticule(enabled: boolean, stepDeg = 15): void {
    this.surface.setGraticule(enabled, (Math.max(1, stepDeg) * Math.PI) / 180);
    this.invalidate();
  }

  /** Fixes the subsolar longitude (radians) in 'sun' lighting; null = follow the camera. */
  setSunLongitude(lon: number | null): void {
    this.fixedSunLon = lon;
    this.invalidate();
  }

  /** Number of flow particles (default 8000). Takes effect immediately. */
  setParticleCount(count: number): void {
    this.particleCount = Math.max(1, Math.floor(count));
    if (this.particles && this.particles.count !== this.particleCount) {
      const kind = this.particles.kind;
      this.particles = new ParticleSystem(this.particles.fieldSpec, { count: this.particleCount, blocked: this.blockedFor(kind) });
      this.particleLines.reset();
    }
  }

  /**
   * Points the camera at a geo point from `distance` planet radii (from the planet center; values
   * ≤ 1 select the default distance; the orbit controls then clamp to their zoom limits).
   */
  setView(center: GeoPoint, distance?: number): void {
    const d = distance ?? this.camera.position.length();
    const p = geoToThree(center.lat, center.lon, d > 1 ? d : DEFAULT_DISTANCE);
    this.camera.position.set(p[0], p[1], p[2]);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.invalidate();
  }

  /** Geo point at the view center and the camera distance (planet radii). */
  getView(): { center: GeoPoint; distance: number } {
    const p = this.camera.position;
    return { center: threeToGeo(p.x, p.y, p.z), distance: p.length() };
  }

  /* ------------------------------------------------------------------ */
  /* Picking & projection                                                */
  /* ------------------------------------------------------------------ */

  pick(clientX: number, clientY: number): GeoPoint | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const [nx, ny] = clientToNdc(clientX, clientY, rect);
    this.camera.updateMatrixWorld();
    this.tmpMat.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).invert();
    const ray = rayFromNdc(this.tmpMat.elements, nx, ny);
    const E = this.exaggeration();
    const sea = this.seaLevel;
    const hit = pickDisplacedSphere(
      ray.origin, ray.dir,
      (X, Y, Z) => this.heights.displacementAt(X, -Z, Y, sea, E),
      this.heights.maxDisplacement(sea, E),
      3,
    );
    return hit ? threeToGeo(hit[0], hit[1], hit[2]) : null;
  }

  project(point: GeoPoint): { x: number; y: number; visible: boolean } {
    this.camera.updateMatrixWorld();
    this.tmpMat.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    return this.projectWith(point, this.canvas.getBoundingClientRect(), this.tmpMat);
  }

  /** project() with a precomputed canvas rect and view-projection matrix (per-frame label layout). */
  private projectWith(point: GeoPoint, rect: ViewRect, viewProj: Matrix4): { x: number; y: number; visible: boolean } {
    const r = 1 + this.surfaceDisplacement(point);
    const n = geoToThree(point.lat, point.lon, 1);
    const [nx, ny, , w] = projectWorld(viewProj.elements, n[0] * r, n[1] * r, n[2] * r);
    const [x, y] = ndcToClient(nx, ny, rect);
    const cam = this.camera.position;
    const visible = w > 0 && Math.abs(nx) <= 1 && Math.abs(ny) <= 1 && facesCamera(n, r, [cam.x, cam.y, cam.z]);
    return { x, y, visible };
  }

  onPointer(handler: (e: WorldPointerEvent) => void): () => void {
    return this.pointers.on(handler);
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = this.dpr();
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.sky.setDpr(dpr);
    this.markers.setDpr(dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  toDataURL(): string {
    this.renderNow(0);
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.controls.orbit.removeEventListener('change', this.onControlsChange);
    this.controls.dispose();
    this.pointers.clear();
    this.surface.dispose();
    this.sky.dispose();
    this.clouds.dispose();
    this.arrows.dispose();
    this.markers.dispose();
    this.particleLines.dispose();
    this.particles = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private dpr(): number {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  private invalidate(): void {
    this.needsRender = true;
  }

  private exaggeration(): number {
    return this.reliefScale * RELIEF_BASE_EXAGGERATION;
  }

  private surfaceDisplacement(p: GeoPoint): number {
    if (!this.heights.present) return 0;
    const cl = Math.cos(p.lat);
    return this.heights.displacementAt(cl * Math.cos(p.lon), cl * Math.sin(p.lon), Math.sin(p.lat), this.seaLevel, this.exaggeration());
  }

  private readonly markerRadius = (p: GeoPoint): number => 1 + this.surfaceDisplacement(p) + MARKER_LIFT;

  /** Land mask for ocean-current particles (from the height map, when one is set). */
  private blockedFor(kind: VectorFieldSpec['kind']): ((x: number, y: number, z: number) => boolean) | undefined {
    if (kind !== 'current') return undefined;
    return (x, y, z) => this.heights.present && this.heights.atVec(x, y, z) > this.seaLevel;
  }

  /** Pushes relief-dependent state (displacement, radii of floating layers, camera limit). */
  private applyRelief(): void {
    const E = this.exaggeration();
    this.surface.setExaggeration(E);
    const maxDisp = this.heights.maxDisplacement(this.seaLevel, E);
    this.arrows.setRadius(1 + maxDisp + ARROW_LIFT);
    this.clouds.setRadius(1.008 + 0.5 * maxDisp);
    this.markers.refresh(this.markerRadius);
    this.controls.setMinAltitude(maxDisp);
    this.invalidate();
  }

  private readonly onControlsChange = (): void => {
    this.invalidate();
  };

  private readonly frame = (t: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrameMs < 0 ? 0 : Math.min(0.1, Math.max(0, (t - this.lastFrameMs) / 1000));
    this.lastFrameMs = t;
    if (this.root.clientWidth === 0 || this.root.clientHeight === 0) return;
    const moved = this.controls.update(dt);
    const animating = this.particles !== null || this.clouds.active;
    if (moved || animating || this.needsRender) this.renderNow(animating ? dt : 0);
  };

  /** Updates per-frame uniforms and animated layers, then renders. */
  private renderNow(dt: number): void {
    this.needsRender = false;
    this.clock += dt;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const right = this.tmpV.set(e[0], e[1], e[2]);
    this.surface.setCameraFrame(this.tmpV2.set(e[4], e[5], e[6]).sub(right).normalize());

    if (this.lighting.mode === 'sun') {
      const camGeo = threeToGeo(cam.position.x, cam.position.y, cam.position.z);
      const lon = this.fixedSunLon ?? wrapLon(camGeo.lon + SUN_LON_OFFSET);
      const s = sunDirectionThree(this.lighting.declination, lon);
      this.shared.uSunDir.value.set(s[0], s[1], s[2]);
    }

    const dist = cam.position.length();
    const pxPerRad = this.root.clientHeight / (2 * Math.tan((FOV * Math.PI) / 360) * Math.max(1e-3, dist - 1));
    this.arrows.setPixelScale(pxPerRad);
    this.clouds.setTime(this.clock);

    if (this.particles) {
      // Roughly constant on-screen speed across zoom levels.
      const speedScale = Math.min(1.6, Math.max(0.06, (dist - 1) / (DEFAULT_DISTANCE - 1)));
      this.particles.step(dt, speedScale);
      const E = this.exaggeration();
      const sea = this.seaLevel;
      const heights = this.heights;
      this.particleLines.update(this.particles, this.clock, (x, y, z, out, o) => {
        const r = 1 + heights.displacementAt(x, y, z, sea, E) + PARTICLE_LIFT;
        out[o] = x * r;
        out[o + 1] = z * r;
        out[o + 2] = -y * r;
      });
    }

    this.renderer.render(this.scene, cam);
    if (this.markers.hasLabels) {
      // One layout read per frame: label style writes between per-marker getBoundingClientRect
      // calls would force a style/layout flush for every marker.
      const rect = this.canvas.getBoundingClientRect();
      const local: ViewRect = { left: 0, top: 0, width: rect.width, height: rect.height };
      const vp = this.tmpMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.markers.updateLabels((m) => this.projectWith(m, local, vp));
    }
  }
}
