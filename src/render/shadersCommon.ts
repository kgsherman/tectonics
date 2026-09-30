/** GLSL snippets shared by the globe shaders (Three.js ShaderMaterial, WebGL2 / GLSL ES 3.0). */

export const GLSL_CONSTANTS = /* glsl */ `
#define PI 3.141592653589793
#define TWO_PI 6.283185307179586
`;

/** Exact sRGB → linear transfer (for colors not coming from sRGB textures). */
export const GLSL_SRGB = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;

/**
 * Local east/north unit vectors in Three world axes (Y = north) at a geo lat/lon. Matches the
 * derivatives of the SphereGeometry parameterisation: P = (cosφ cosλ, sinφ, −cosφ sinλ).
 */
export const GLSL_BASIS = /* glsl */ `
void geoBasis(float lat, float lon, out vec3 east, out vec3 north) {
  float sl = sin(lon), cl = cos(lon), sp = sin(lat), cp = cos(lat);
  east = vec3(-sl, 0.0, -cl);
  north = vec3(-sp * cl, cp, sp * sl);
}
`;

/** Minimal vertex shader for a unit SphereGeometry scaled to `uShellRadius`. */
export const SHELL_VERTEX = /* glsl */ `
uniform float uShellRadius;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(vDir * uShellRadius, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
