import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { frontHalf, splitRuns, trianglesIn } from '../../src/engine/ModelMesh';
import { blendedPass, createFaceMaterial, createSharedUniforms, passVisible } from '../../src/engine/modelMaterials';

/** A two-sided face set as rvt-rs writes it: the triangles, then each reversed. */
function twoSided(vertices: number[], triangles: number[][]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([...triangles.flat(), ...triangles.flatMap(([a, b, c]) => [a!, c!, b!])]);
  return geometry;
}

describe('splitRuns', () => {
  // Two quads: a frame (triangles 0–1) and a pane of glass (triangles 2–3).
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  it('cuts a body into runs, each with its own vertices', () => {
    const parts = splitRuns(positions, indices, [
      { triangles: 2, color: [0.5, 0.5, 0.5], opacity: 1 },
      { triangles: 2, color: null, opacity: 0.2 },
    ])!;
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.indices.length)).toEqual([6, 6]);
    expect(parts.map((p) => p.positions.length / 3)).toEqual([4, 4]);
    expect(Array.from(parts[1]!.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    const xs = Array.from({ length: 4 }, (_, i) => parts[1]!.positions[i * 3]!);
    expect(Math.min(...xs)).toBe(2);
    expect(parts[1]!.opacity).toBe(0.2);
    expect(parts[0]!.color).toEqual([0.5, 0.5, 0.5]);
  });

  it('leaves a body alone whose triangle count does not match its runs', () => {
    expect(splitRuns(positions, indices, [{ triangles: 3, color: null, opacity: 1 }])).toBeNull();
  });
});

describe('trianglesIn', () => {
  it("picks one entity's triangles out of a reordered merged index, renumbered", () => {
    // Entity A on vertices 0–3, B on 4–6; the bounds tree has shuffled the triangles.
    const index = new Uint32Array([4, 5, 6, 2, 3, 0, 0, 1, 2]);
    expect(Array.from(trianglesIn(index, 0, 4))).toEqual([2, 3, 0, 0, 1, 2]);
    expect(Array.from(trianglesIn(index, 4, 3))).toEqual([0, 1, 2]);
  });
});

describe('blendedPass', () => {
  it('tells the transparent passes that blend something', () => {
    const uniforms = createSharedUniforms();
    const grey = new THREE.Color(0x808080);
    expect(blendedPass(createFaceMaterial(uniforms, grey, 0.4, 1))).toBe(true);
    expect(blendedPass(createFaceMaterial(uniforms, grey, 0.4, 0))).toBe(false);
    expect(blendedPass(createFaceMaterial(uniforms, grey, 1, 1))).toBe(false);
    expect(blendedPass(createFaceMaterial(uniforms, grey, 0, 1))).toBe(false);
  });
});

describe('frontHalf', () => {
  it('keeps the first winding of a two-sided face set', () => {
    const geometry = twoSided([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [
      [0, 1, 2],
      [0, 2, 3],
    ]);
    expect(Array.from(frontHalf(geometry)!.index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('leaves other geometry alone', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    expect(frontHalf(geometry)).toBeNull();
  });
});

describe('passVisible', () => {
  const uniforms = createSharedUniforms();
  const color = new THREE.Color(0x808080);
  it('draws an opaque batch once, in the opaque pass, unless opacity is overridden', () => {
    expect(passVisible(createFaceMaterial(uniforms, color, 1, 0), false)).toBe(true);
    expect(passVisible(createFaceMaterial(uniforms, color, 1, 1), false)).toBe(false);
    expect(passVisible(createFaceMaterial(uniforms, color, 1, 1), true)).toBe(true);
  });
  it('draws a transparent batch in the transparent pass only', () => {
    expect(passVisible(createFaceMaterial(uniforms, color, 0.3, 0), false)).toBe(false);
    expect(passVisible(createFaceMaterial(uniforms, color, 0.3, 0), true)).toBe(false);
    expect(passVisible(createFaceMaterial(uniforms, color, 0.3, 1), false)).toBe(true);
  });
});
