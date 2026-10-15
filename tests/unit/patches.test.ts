import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelMesh, transformed } from '../../src/engine/ModelMesh';
import { createSharedUniforms } from '../../src/engine/modelMaterials';
import type { RefinePatch } from '../../src/worker/protocol';

/** A GLB of unit cubes, one node per entity at `centres`, as rvt-rs writes them. */
function cubesGlb(centres: [number, number, number][]): Uint8Array {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5,
    -0.5, 0.5, 0.5,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: centres.map((_, i) => i) }],
    nodes: centres.map((c, i) => ({ mesh: 0, translation: c, extras: { entityIndex: i } })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  text = Uint8Array.from([...text, ...new Array(pad(text.length)).fill(0x20)]);
  const binPadded = Uint8Array.from([...bin, ...new Array(pad(bin.length)).fill(0)]);
  const total = 12 + 8 + text.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, binPadded.length, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(binPadded, 28 + text.length);
  return out;
}

interface TestBody {
  entity: number;
  centre: [number, number, number];
  /** Defaults to one of its own. */
  shape?: number;
  /** Send the shape's mesh (the first body of a shape does). */
  mesh?: boolean;
  glass?: boolean;
  turn?: number;
}

let nextShape = 1000;

/**
 * A patch drawing each body as a quad of two triangles (in the XZ plane,
 * facing +Y) placed at `centre`; the second triangle is glass where asked.
 */
function trianglesPatch(bodies: TestBody[]): RefinePatch {
  const positions: number[] = [];
  const triangles: number[] = [];
  const vertexStarts = [0];
  const triangleStarts = [0];
  const edgeStarts = [0];
  const edges: number[] = [];
  const shapes: number[] = [];
  const placements: number[] = [];
  const runs = [];
  for (const b of bodies) {
    const shape = b.shape ?? nextShape++;
    if (b.mesh ?? b.shape === undefined) {
      positions.push(-0.2, 0, -0.2, 0.2, 0, -0.2, 0.2, 0, 0.2, -0.2, 0, 0.2);
      triangles.push(0, 2, 1, 0, 3, 2);
      edges.push(-0.2, 0, -0.2, 0.2, 0, -0.2);
    }
    vertexStarts.push(positions.length / 3);
    triangleStarts.push(triangles.length / 3);
    edgeStarts.push(edges.length / 6);
    shapes.push(shape);
    placements.push(...b.centre, b.turn ?? 0);
    if (b.glass) {
      runs.push({
        entity: b.entity,
        runs: [
          { triangles: 1, color: [1, 0, 0] as [number, number, number], opacity: 1 },
          { triangles: 1, color: null, opacity: 0.3 },
        ],
      });
    }
  }
  return {
    done: Uint32Array.from(bodies.map((b) => b.entity)),
    entities: Uint32Array.from(bodies.map((b) => b.entity)),
    shapes: Uint32Array.from(shapes),
    placements: Float32Array.from(placements),
    vertexStarts: Uint32Array.from(vertexStarts),
    triangleStarts: Uint32Array.from(triangleStarts),
    edgeStarts: Uint32Array.from(edgeStarts),
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    edges: Float32Array.from(edges),
    runs,
    report: { candidates: bodies.length, replaced: bodies.length, triangles: 2 * bodies.length },
    finished: false,
    next: 'none',
  };
}

/** The entity a vertical ray down through (x, z) hits first, if any. */
function hitAt(model: ModelMesh, x: number, z: number): number | null {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0));
  return model.raycast(raycaster, [])[0]?.entity ?? null;
}

describe('ModelMesh patches', () => {
  const centres: [number, number, number][] = Array.from({ length: 10 }, (_, i) => [i * 3, 0, 0]);

  it('draws a patch in place of its entities’ boxes', async () => {
    const model = await ModelMesh.fromGlb(cubesGlb(centres), centres.length, createSharedUniforms());
    expect(hitAt(model, 3, 0)).toBe(1);
    // Entity 1 moves to z = 10: its box is gone, its new body is drawn and picked.
    await model.applyPatch(trianglesPatch([{ entity: 1, centre: [3, 0, 10] }]), createSharedUniforms());
    expect(hitAt(model, 3, 0)).toBeNull();
    expect(hitAt(model, 3, 10)).toBe(1);
    expect(hitAt(model, 6, 0)).toBe(2);
    const box = model.entityBoxes.get(1)!;
    expect(box.min.z).toBeCloseTo(9.8);
    expect(box.max.x).toBeCloseTo(3.2);
    expect(model.patchChunks).toBe(1);
  });

  it('splits a body into its material runs and replaces a body sent again', async () => {
    const model = await ModelMesh.fromGlb(cubesGlb(centres), centres.length, createSharedUniforms());
    await model.applyPatch(trianglesPatch([{ entity: 2, centre: [6, 0, 10], glass: true }]), createSharedUniforms());
    // The red frame and the glass are meshes of their own (two looks), both picked as entity 2.
    const looks = new Set<string>();
    model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshLambertMaterial).color) {
        looks.add(`${(mesh.material as THREE.MeshLambertMaterial).color.getHexString()}`);
      }
    });
    expect(looks.has('ff0000')).toBe(true);
    expect(hitAt(model, 6, 10)).toBe(2);
    // Sent again elsewhere, its shape known: the first patch's body no longer draws.
    await model.applyPatch(trianglesPatch([{ entity: 2, centre: [6, 0, 20], shape: 7, mesh: true }]), createSharedUniforms());
    expect(hitAt(model, 6, 10)).toBeNull();
    expect(hitAt(model, 6, 20)).toBe(2);
    await model.applyPatch(trianglesPatch([{ entity: 2, centre: [6, 0, 30], shape: 7, mesh: false }]), createSharedUniforms());
    expect(hitAt(model, 6, 20)).toBeNull();
    expect(hitAt(model, 6, 30)).toBe(2);
  });

  it('draws the bodies of a shape by instancing once that saves enough', async () => {
    const saving = ModelMesh.instanceSaving;
    // Two triangles a shape: every second body saves enough here.
    ModelMesh.instanceSaving = 2;
    try {
      const model = await ModelMesh.fromGlb(cubesGlb(centres), centres.length, createSharedUniforms());
      await model.applyPatch(trianglesPatch([{ entity: 0, centre: [0, 0, 5], shape: 1, mesh: true }]), createSharedUniforms());
      expect(model.instanced.bodies).toBe(0);
      // The second body of the shape: both instanced, the first moved out of the merged meshes.
      await model.applyPatch(
        trianglesPatch([
          { entity: 1, centre: [3, 0, 5], shape: 1, mesh: false },
          { entity: 2, centre: [6, 0, 5], shape: 1, mesh: false, turn: Math.PI / 2 },
        ]),
        createSharedUniforms(),
      );
      expect(model.instanced).toEqual({ bodies: 3, groups: 1 });
      expect(hitAt(model, 0, 5)).toBe(0);
      expect(hitAt(model, 3, 5)).toBe(1);
      expect(hitAt(model, 6, 5)).toBe(2);
      expect(hitAt(model, 3, 0)).toBeNull();
      expect(model.entityBoxes.get(2)!.min.x).toBeCloseTo(5.8);
      // Glass in one body: a group of its own, in two looks.
      await model.applyPatch(trianglesPatch([{ entity: 3, centre: [9, 0, 5], shape: 1, mesh: false, glass: true }]), createSharedUniforms());
      expect(model.instanced).toEqual({ bodies: 4, groups: 2 });
      expect(hitAt(model, 9, 5)).toBe(3);
      // Sent again elsewhere: the old instance goes.
      await model.applyPatch(trianglesPatch([{ entity: 0, centre: [0, 0, 15], shape: 1, mesh: false }]), createSharedUniforms());
      expect(hitAt(model, 0, 5)).toBeNull();
      expect(hitAt(model, 0, 15)).toBe(0);
      expect(model.instanced.bodies).toBe(4);
      // Many more bodies than the group's first room.
      const many = Array.from({ length: 30 }, (_, k) => ({ entity: 4 + (k % 6), centre: [k, 0, 40] as [number, number, number], shape: 1, mesh: false }));
      for (const body of many) await model.applyPatch(trianglesPatch([body]), createSharedUniforms());
      expect(hitAt(model, 29, 40)).toBe(4 + (29 % 6));
      expect(hitAt(model, 28, 40)).toBe(4 + (28 % 6));
      model.dispose();
    } finally {
      ModelMesh.instanceSaving = saving;
    }
  });

  it('merges patches a few at a time and keeps every body', async () => {
    const model = await ModelMesh.fromGlb(cubesGlb(centres), centres.length, createSharedUniforms());
    for (let i = 0; i < 8; i++) {
      await model.applyPatch(trianglesPatch([{ entity: i, centre: [i * 3, 0, 5] }]), createSharedUniforms());
    }
    // Six single patches merged into one; two more left on their own.
    expect(model.patchChunks).toBe(3);
    for (let i = 0; i < 8; i++) expect(hitAt(model, i * 3, 5)).toBe(i);
    await model.compactPatches(createSharedUniforms());
    expect(model.patchChunks).toBe(2);
    for (let i = 0; i < 8; i++) expect(hitAt(model, i * 3, 5)).toBe(i);
    expect(hitAt(model, 27, 0)).toBe(9);
    // A merged body sent again moves out of its merged chunk.
    await model.applyPatch(trianglesPatch([{ entity: 0, centre: [0, 0, 30] }]), createSharedUniforms());
    expect(hitAt(model, 0, 5)).toBeNull();
    expect(hitAt(model, 0, 30)).toBe(0);
  });
});

describe('transformed', () => {
  it('turns about +Y and moves, as the placements say', () => {
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(1, 2, 3);
    // +X turns to -Z (the model's +Y, a quarter turn about its Z).
    expect(Array.from(transformed(Float32Array.from([1, 0, 0]), m)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 2, 2]);
  });
});
