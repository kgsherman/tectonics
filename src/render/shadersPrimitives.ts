/** Shaders for globe arrows (instanced great-circle ribbons), markers (sprites) and particle trails. */
import { GLSL_SRGB } from './shadersCommon';

/**
 * Arrow template vertex: aShape = (t along the part [0,1], side [−1,1], part: 0 shaft / 1 head).
 * Same geometry as viewArrows.ts: P(a) = tail·cos a + dir·sin a, sideways rotation about the
 * travel tangent; dims from the arc length with a zoom-dependent minimum half-width.
 * uOutline > 0 renders the enlarged dark (or highlight) outline pass.
 */
export const ARROW_VERTEX = /* glsl */ `
attribute vec3 aShape;
attribute vec3 iTail;
attribute vec3 iDir;
attribute float iLength;
attribute vec3 iColor;
attribute float iHighlight;
uniform float uRadius;
uniform float uOutline;
uniform float uMinHalfWidth;
varying vec3 vColor;
void main() {
  float L = iLength;
  float shaftHW = max(uMinHalfWidth, min(0.012, 0.05 * L));
  float headHW = 2.6 * shaftHW;
  float headLen = min(0.45 * L, 2.4 * headHW);
  float shaftLen = L - headLen;
  float o = uOutline * (1.0 + 0.9 * iHighlight);
  float a;
  float hw;
  if (aShape.z < 0.5) {
    a = mix(-o, shaftLen, aShape.x);
    hw = shaftHW + o;
  } else {
    a = mix(shaftLen - o, L + 2.6 * o, aShape.x);
    hw = (headHW + 1.8 * o) * (1.0 - aShape.x);
  }
  vec3 P = iTail * cos(a) + iDir * sin(a);
  vec3 T = -iTail * sin(a) + iDir * cos(a);
  vec3 S = cross(P, T);
  float side = aShape.y * hw;
  vec3 Q = P * cos(side) + S * sin(side);
  if (uOutline > 0.0) {
    vColor = mix(vec3(0.012), vec3(1.0), iHighlight);
  } else {
    vColor = mix(iColor, vec3(1.0), 0.2 * iHighlight);
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(Q * uRadius, 1.0);
}
`;

export const FLAT_COLOR_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Marker sprites. Depth testing is off (markers stay crisp at the limb); instead markers on the far
 * hemisphere are culled here. aSize = disc radius in CSS px.
 */
export const MARKER_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aHighlight;
uniform float uDpr;
varying vec3 vColor;
varying float vCore;
varying float vRadius;
varying float vHighlight;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float facing = dot(normalize(position), normalize(cameraPosition - wp.xyz));
  vColor = aColor;
  vHighlight = aHighlight;
  vCore = aSize * uDpr;
  vRadius = vCore + (1.5 + 2.5 * aHighlight) * uDpr + 1.0;
  gl_PointSize = 2.0 * vRadius;
  gl_Position = facing > 0.0 ? projectionMatrix * viewMatrix * wp : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const MARKER_FRAGMENT = /* glsl */ `
uniform float uDpr;
varying vec3 vColor;
varying float vCore;
varying float vRadius;
varying float vHighlight;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0) * vRadius;
  float outer = vRadius - 1.0;
  float alpha = 1.0 - smoothstep(outer - 1.0, outer, r);
  if (alpha <= 0.0) discard;
  vec3 col = mix(vColor, vec3(0.02), smoothstep(vCore - 0.6, vCore + 0.6, r));
  float ring = vCore + 1.5 * uDpr;
  if (vHighlight > 0.5) col = mix(col, vec3(1.0), smoothstep(ring - 0.6, ring + 0.6, r));
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

/** Particle trail segments: alpha fades with vertex age; color from speed via a 5-stop sRGB ramp. */
export const PARTICLE_VERTEX = /* glsl */ `
${GLSL_SRGB}
attribute float aTime;
attribute float aSpeed;
uniform float uNow;
uniform float uTrail;
uniform float uSpeedMax;
uniform float uOpacity;
uniform vec3 uRamp[5];
varying vec4 vColor;
vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * 4.0;
  float k = min(floor(x), 3.0);
  int i = int(k);
  return mix(uRamp[i], uRamp[i + 1], x - k);
}
void main() {
  float a = clamp(1.0 - (uNow - aTime) / uTrail, 0.0, 1.0);
  vColor = vec4(srgbToLinear(ramp(aSpeed / uSpeedMax)), a * a * uOpacity);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
varying vec4 vColor;
void main() {
  if (vColor.a <= 0.002) discard;
  gl_FragColor = vColor;
  #include <colorspace_fragment>
}
`;
