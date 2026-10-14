import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { frontHalf, splitByRuns } from '../../src/engine/ModelMesh';

/** A two-sided face set as rvt-rs writes it: the triangles, then each reversed. */
function twoSided(vertices: number[], triangles: number[][]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([...triangles.flat(), ...triangles.flatMap(([a, b, c]) => [a!, c!, b!])]);
  return geometry;
}

describe('splitByRuns', () => {
  // Two quads: a frame (triangles 0–1) and a pane of glass (triangles 2–3).
  const geometry = twoSided(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0],
    [
      [0, 1, 2],
      [0, 2, 3],
      [4, 5, 6],
      [4, 6, 7],
    ],
  );

  it('cuts a two-sided face set into compact runs, transparent ones single-sided', () => {
    const parts = splitByRuns(geometry, [
      { triangles: 2, color: [0.5, 0.5, 0.5], opacity: 1 },
      { triangles: 2, color: null, opacity: 0.2 },
    ])!;
    expect(parts).toHaveLength(2);
    // The frame keeps both windings; the glass, drawn double-sided, one.
    expect(parts.map((p) => p.geometry.index!.count)).toEqual([12, 6]);
    expect(parts.map((p) => p.geometry.getAttribute('position').count)).toEqual([4, 4]);
    expect(Array.from(parts[0]!.geometry.index!.array).slice(6)).toEqual([0, 2, 1, 0, 3, 2]);
    const glass = parts[1]!.geometry;
    const xs = Array.from({ length: 4 }, (_, i) => glass.getAttribute('position').getX(i));
    expect(Math.min(...xs)).toBe(2);
    expect(Array.from(glass.index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(parts[1]!.opacity).toBe(0.2);
  });

  it('leaves a body alone whose triangle count does not match its runs', () => {
    expect(splitByRuns(geometry, [{ triangles: 3, color: null, opacity: 1 }])).toBeNull();
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
