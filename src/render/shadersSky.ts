/** Atmosphere halo and starfield shaders for the globe. */
import { GLSL_CONSTANTS } from './shadersCommon';

/**
 * Atmosphere: back faces of a shell of radius uShellRadius, additive. Brightness falls off with the
 * ray's impact parameter b (closest approach to the planet center): max at the limb (b = 1), zero at
 * the shell edge. Fragments over the planet disk are hidden by the planet's depth.
 */
export const ATMOSPHERE_FRAGMENT = /* glsl */ `
${GLSL_CONSTANTS}
uniform vec3 uAtmoColor;
uniform float uShellRadius;
uniform float uIntensity;
uniform int uLightMode;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  vec3 closest = cameraPosition - d * dot(cameraPosition, d);
  float b = length(closest);
  float x = clamp((b - 1.0) / (uShellRadius - 1.0), 0.0, 1.0);
  float glow = exp(-5.0 * x) * (1.0 - x) * (1.0 - x);
  float lit = 1.0;
  if (uLightMode == 2) lit = 0.04 + 0.96 * smoothstep(-0.3, 0.3, dot(closest / max(b, 1e-6), uSunDir));
  gl_FragColor = vec4(uAtmoColor * glow * uIntensity * lit, 1.0);
  #include <colorspace_fragment>
}
`;

export const STARS_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aBright;
uniform float uDpr;
varying float vBright;
void main() {
  vBright = aBright;
  gl_PointSize = aSize * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const STARS_FRAGMENT = /* glsl */ `
uniform float uIntensity;
varying float vBright;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = 1.0 - smoothstep(0.3, 1.0, dot(c, c));
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vBright * uIntensity, a);
  #include <colorspace_fragment>
}
`;
