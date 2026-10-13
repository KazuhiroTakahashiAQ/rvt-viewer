/*
 * Materials for the merged model geometry. Every face/edge vertex carries an
 * `aEntity` attribute; the shaders look the entity up in the EntityState
 * textures to hide it, tint it (selection / pre-highlight / reveal hidden),
 * override its colour or opacity, or halftone it — without changing
 * geometry or adding draw calls.
 */

import * as THREE from 'three';
import { STATE_TEXTURE_WIDTH } from './EntityState';

export type VisualStyle = 'wireframe' | 'hiddenLine' | 'shaded' | 'consistentColors';

const STYLE_CODE: Record<VisualStyle, number> = {
  shaded: 0,
  hiddenLine: 1,
  consistentColors: 2,
  wireframe: 3,
};

/** Uniforms shared by every model material, so one update reaches all batches. */
export interface SharedUniforms {
  uRvtState: { value: THREE.Texture | null };
  uRvtOverride: { value: THREE.Texture | null };
  uRvtSelect: { value: THREE.Color };
  uRvtHover: { value: THREE.Color };
  uRvtReveal: { value: THREE.Color };
  uRvtCut: { value: THREE.Color };
  uRvtEdge: { value: THREE.Color };
  uRvtStyle: { value: number };
  uRvtCutFill: { value: boolean };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uRvtState: { value: null },
    uRvtOverride: { value: null },
    uRvtSelect: { value: new THREE.Color('#0a64ff') },
    uRvtHover: { value: new THREE.Color('#3d8bff') },
    uRvtReveal: { value: new THREE.Color('#d400d4') },
    uRvtCut: { value: new THREE.Color('#4a4a4a') },
    uRvtEdge: { value: new THREE.Color('#000000') },
    uRvtStyle: { value: 0 },
    uRvtCutFill: { value: false },
  };
}

export function setVisualStyle(uniforms: SharedUniforms, style: VisualStyle): void {
  uniforms.uRvtStyle.value = STYLE_CODE[style];
}

const VERTEX_HEAD = /* glsl */ `
attribute float aEntity;
uniform highp sampler2D uRvtState;
uniform highp sampler2D uRvtOverride;
flat varying vec4 vRvtState;
flat varying vec4 vRvtOverride;
`;

const VERTEX_LOOKUP = /* glsl */ `
{
  int rvtId = int(aEntity + 0.5);
  ivec2 rvtCoord = ivec2(rvtId % ${STATE_TEXTURE_WIDTH}, rvtId / ${STATE_TEXTURE_WIDTH});
  vRvtState = texelFetch(uRvtState, rvtCoord, 0);
  vRvtOverride = texelFetch(uRvtOverride, rvtCoord, 0);
  uint rvtFlags = uint(vRvtState.r * 255.0 + 0.5);
  if ((rvtFlags & 1u) == 0u) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uRvtSelect;
uniform vec3 uRvtHover;
uniform vec3 uRvtReveal;
uniform vec3 uRvtCut;
uniform vec3 uRvtEdge;
uniform int uRvtStyle;
uniform bool uRvtCutFill;
uniform int uRvtPass;
uniform float uRvtBaseAlpha;
flat varying vec4 vRvtState;
flat varying vec4 vRvtOverride;

vec3 rvtSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

/** Faces: resolve colour/opacity before lighting. */
const FACE_COLOR = /* glsl */ `
uint rvtFlags = uint(vRvtState.r * 255.0 + 0.5);
if (vRvtOverride.a > 0.5) diffuseColor.rgb = rvtSrgbToLinear(vRvtOverride.rgb);
float rvtAlpha = vRvtState.a > 0.999 ? uRvtBaseAlpha : vRvtState.a * (255.0 / 254.0);
if (uRvtStyle == 3) discard;
bool rvtCutFace = !gl_FrontFacing && uRvtCutFill && uRvtPass == 0 && rvtAlpha >= 0.999;
if (!rvtCutFace) {
  if (uRvtPass == 0 && rvtAlpha < 0.999) discard;
  if (uRvtPass == 1 && rvtAlpha >= 0.999) discard;
}
diffuseColor.a = rvtCutFace ? 1.0 : rvtAlpha;
vec3 rvtBase = diffuseColor.rgb;
`;

/** Faces: after lighting, apply style and state tints. */
const FACE_FINAL = /* glsl */ `
if (uRvtStyle == 1) gl_FragColor.rgb = vec3(1.0);
else if (uRvtStyle == 2) gl_FragColor.rgb = rvtBase;
if (rvtCutFace) gl_FragColor = vec4(uRvtCut, 1.0);
if ((rvtFlags & 8u) != 0u) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), 0.6);
if ((rvtFlags & 16u) != 0u) gl_FragColor.rgb = mix(gl_FragColor.rgb, uRvtReveal, 0.75);
if ((rvtFlags & 2u) != 0u) gl_FragColor.rgb = mix(gl_FragColor.rgb, uRvtSelect, 0.55);
else if ((rvtFlags & 4u) != 0u) gl_FragColor.rgb = mix(gl_FragColor.rgb, uRvtHover, 0.35);
#ifdef RVT_CUT
// The cut fill is the inside (back faces) of a clipped solid, often
// coplanar with something else (a wall's base on the slab top). Pull it
// slightly toward the viewer so it reads as the cap at the cut.
gl_FragDepth = gl_FragCoord.z - (rvtCutFace ? 0.0004 : 0.0);
#endif
`;

const EDGE_FINAL = /* glsl */ `
{
  uint rvtFlags = uint(vRvtState.r * 255.0 + 0.5);
  vec3 rvtLine = uRvtEdge;
  if ((rvtFlags & 8u) != 0u) rvtLine = mix(rvtLine, vec3(1.0), 0.6);
  if ((rvtFlags & 16u) != 0u) rvtLine = uRvtReveal;
  if ((rvtFlags & 2u) != 0u) rvtLine = uRvtSelect;
  else if ((rvtFlags & 4u) != 0u) rvtLine = uRvtHover;
  gl_FragColor.rgb = rvtLine;
}
`;

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_LOOKUP}`);
}

export function createFaceMaterial(
  shared: SharedUniforms,
  color: THREE.Color,
  baseAlpha: number,
  pass: 0 | 1,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    color,
    flatShading: true,
    side: THREE.DoubleSide,
    transparent: pass === 1,
    depthWrite: pass === 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, {
      uRvtPass: { value: pass },
      uRvtBaseAlpha: { value: baseAlpha },
    });
    patchVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACE_COLOR}`)
      .replace('#include <tonemapping_fragment>', `${FACE_FINAL}\n#include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `rvt-face-${pass}`;
  return material;
}

export function createEdgeMaterial(shared: SharedUniforms): THREE.LineBasicMaterial {
  const material = new THREE.LineBasicMaterial({ color: 0x000000 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, {
      uRvtPass: { value: 0 },
      uRvtBaseAlpha: { value: 1 },
    });
    patchVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <tonemapping_fragment>', `${EDGE_FINAL}\n#include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => 'rvt-edge';
  return material;
}
