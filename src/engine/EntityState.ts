import * as THREE from 'three';

/** Per-entity display flags, read by the model shaders (`modelMaterials.ts`). */
export const FLAG_VISIBLE = 1;
export const FLAG_SELECTED = 2;
export const FLAG_HOVER = 4;
export const FLAG_HALFTONE = 8;
export const FLAG_REVEALED = 16;

export const STATE_TEXTURE_WIDTH = 1024;

/**
 * Two RGBA8 textures indexed by entity index:
 * - state:    r = flags, a = opacity override (255 = none, else a/254)
 * - override: rgb = surface colour override, a = 255 when active
 */
export class EntityState {
  readonly count: number;
  readonly state: THREE.DataTexture;
  readonly override: THREE.DataTexture;
  private readonly stateData: Uint8Array;
  private readonly overrideData: Uint8Array;

  constructor(count: number) {
    this.count = Math.max(1, count);
    const height = Math.ceil(this.count / STATE_TEXTURE_WIDTH);
    this.stateData = new Uint8Array(STATE_TEXTURE_WIDTH * height * 4);
    this.overrideData = new Uint8Array(STATE_TEXTURE_WIDTH * height * 4);
    for (let i = 0; i < this.count; i++) {
      this.stateData[i * 4] = FLAG_VISIBLE;
      this.stateData[i * 4 + 3] = 255;
    }
    this.state = makeTexture(this.stateData, height);
    this.override = makeTexture(this.overrideData, height);
  }

  flags(index: number): number {
    return this.stateData[index * 4] ?? 0;
  }

  isVisible(index: number): boolean {
    return (this.flags(index) & FLAG_VISIBLE) !== 0;
  }

  setFlags(index: number, flags: number): void {
    if (index < 0 || index >= this.count) return;
    this.stateData[index * 4] = flags;
  }

  /** `opacity` in 0..1, or null to use the material's own opacity. */
  setOpacity(index: number, opacity: number | null): void {
    if (index < 0 || index >= this.count) return;
    this.stateData[index * 4 + 3] = opacity === null ? 255 : Math.round(THREE.MathUtils.clamp(opacity, 0, 1) * 254);
  }

  setColor(index: number, color: THREE.Color | null): void {
    if (index < 0 || index >= this.count) return;
    const o = index * 4;
    if (!color) {
      this.overrideData[o + 3] = 0;
      return;
    }
    // Store sRGB bytes; the shader converts to linear.
    const c = color.clone().convertLinearToSRGB();
    this.overrideData[o] = Math.round(c.r * 255);
    this.overrideData[o + 1] = Math.round(c.g * 255);
    this.overrideData[o + 2] = Math.round(c.b * 255);
    this.overrideData[o + 3] = 255;
  }

  commit(): void {
    this.state.needsUpdate = true;
    this.override.needsUpdate = true;
  }

  dispose(): void {
    this.state.dispose();
    this.override.dispose();
  }
}

function makeTexture(data: Uint8Array, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, STATE_TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
