/*
 * Turns the rvt-rs GLB (one node per element, `extras.entityIndex`) into a
 * handful of merged meshes — one per material — plus one merged edge
 * LineSegments. Per-element state lives in EntityState textures; picking
 * uses a BVH over the merged triangles and maps hits back to entities.
 * A saved-mesh body drawn in several of Revit's materials (a window's frame
 * and glass) is split into its material runs first.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { BodyMaterials, MaterialRun } from '../wasm/types';
import { EntityState } from './EntityState';
import { type SharedUniforms, createEdgeMaterial, createFaceMaterial } from './modelMaterials';

const EDGE_THRESHOLD_DEG = 25;

interface SourceMesh {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  entity: number;
}

interface Batch {
  color: THREE.Color;
  opacity: number;
  items: SourceMesh[];
  triangles: number;
}

/**
 * Triangles of one merged mesh, at most: a batch of one material is split
 * so that no single merge or BVH build blocks the page for long.
 */
const MAX_BATCH_TRIANGLES = 400_000;

/** Work between yields to the browser, milliseconds. */
const SLICE_MS = 12;

/** Let the browser handle input and paint before going on. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Yields every [`SLICE_MS`] of work, reporting the share done as it does. */
class Slicer {
  private last = performance.now();

  constructor(private readonly onProgress?: (fraction: number) => void) {}

  async at(fraction: number): Promise<void> {
    if (performance.now() - this.last < SLICE_MS) return;
    this.onProgress?.(Math.min(1, fraction));
    await yieldToBrowser();
    this.last = performance.now();
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}

export interface ModelHit {
  entity: number;
  point: THREE.Vector3;
  distance: number;
}

export class ModelMesh {
  readonly root = new THREE.Group();
  readonly state: EntityState;
  readonly entityBoxes = new Map<number, THREE.Box3>();
  readonly box = new THREE.Box3();
  private readonly pickMeshes: THREE.Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  private constructor(entityCount: number) {
    this.state = new EntityState(entityCount);
    this.root.name = 'rvt-model';
  }

  /**
   * Build from `glb`, yielding to the browser every few milliseconds so the
   * page stays responsive, and reporting the share done (0..1).
   */
  static async fromGlb(
    glb: Uint8Array,
    entityCount: number,
    uniforms: SharedUniforms,
    materials: BodyMaterials[] = [],
    onProgress?: (fraction: number) => void,
  ): Promise<ModelMesh> {
    const model = new ModelMesh(entityCount);
    // The GLB of a large model is hundreds of megabytes: no copy where it
    // is its buffer's only content.
    const buffer =
      glb.byteOffset === 0 && glb.byteLength === glb.buffer.byteLength
        ? (glb.buffer as ArrayBuffer)
        : (glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer);
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    gltf.scene.updateMatrixWorld(true);
    try {
      await model.build(gltf.scene, uniforms, new Map(materials.map((m) => [m.entity, m.runs])), onProgress);
    } catch (err) {
      model.dispose();
      throw err;
    } finally {
      disposeScene(gltf.scene);
    }
    return model;
  }

  private async build(
    scene: THREE.Object3D,
    uniforms: SharedUniforms,
    runs: Map<number, MaterialRun[]>,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const meshes: THREE.Mesh[] = [];
    scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
    });
    // Collecting and finding edges is about half the work; merging and
    // indexing the batches the other half.
    const slicer = new Slicer(onProgress);
    const batches = new Map<string, Batch[]>();
    const edgeCache = new Map<string, Float32Array>();
    const edgeChunks: { positions: Float32Array; matrix: THREE.Matrix4; entity: number }[] = [];
    const parts: THREE.BufferGeometry[] = [];
    const add = (color: THREE.Color, opacity: number, item: SourceMesh) => {
      const key = `${color.getHexString()}-${opacity.toFixed(3)}`;
      const list = batches.get(key) ?? [];
      batches.set(key, list);
      const triangles = triangleCount(item.geometry);
      let batch = list.at(-1);
      if (!batch || (batch.items.length > 0 && batch.triangles + triangles > MAX_BATCH_TRIANGLES)) {
        batch = { color, opacity, items: [], triangles: 0 };
        list.push(batch);
      }
      batch.items.push(item);
      batch.triangles += triangles;
    };

    for (const [i, mesh] of meshes.entries()) {
      await slicer.at((0.5 * i) / meshes.length);
      const entity = entityIndexOf(mesh);
      if (entity === null) continue;
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      const color = material?.color?.clone() ?? new THREE.Color(0xb2b4b8);
      const opacity = material?.transparent ? (material.opacity ?? 1) : 1;
      const matrix = mesh.matrixWorld.clone();
      // A face set comes two-sided: drawn double-sided, one winding does.
      const front = frontHalf(mesh.geometry);
      if (front) parts.push(front);
      const geometry = front ?? mesh.geometry;
      const split = runs.has(entity) ? splitByRuns(geometry, runs.get(entity)!) : null;
      if (split) {
        for (const part of split) {
          parts.push(part.geometry);
          const own = part.color ? new THREE.Color().setRGB(...part.color, THREE.SRGBColorSpace) : color;
          add(own, part.opacity < 1 ? part.opacity : opacity, { geometry: part.geometry, matrix, entity });
        }
      } else {
        add(color, opacity, { geometry, matrix, entity });
      }

      let edges = edgeCache.get(mesh.geometry.uuid);
      if (!edges) {
        const eg = new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_DEG);
        edges = eg.getAttribute('position').array as Float32Array;
        eg.dispose();
        edgeCache.set(mesh.geometry.uuid, edges);
      }
      edgeChunks.push({ positions: edges, matrix, entity });
    }

    const all = [...batches.values()].flat();
    const totalItems = Math.max(1, all.reduce((n, b) => n + b.items.length, 0));
    let merged = 0;
    const volumeCache = new Map<string, number>();
    for (const batch of all) {
      await this.buildBatch(batch, uniforms, volumeCache, async (items) => {
        await slicer.at(0.5 + (0.48 * (merged + items)) / totalItems);
      });
      merged += batch.items.length;
    }
    await slicer.at(0.98);
    this.buildEdges(edgeChunks, uniforms);
    for (const part of parts) part.dispose();
    onProgress?.(1);
  }

  private async buildBatch(
    batch: Batch,
    uniforms: SharedUniforms,
    volumeCache: Map<string, number>,
    progress: (items: number) => Promise<void>,
  ): Promise<void> {
    let vertexCount = 0;
    let indexCount = 0;
    for (const item of batch.items) {
      const pos = item.geometry.getAttribute('position');
      vertexCount += pos.count;
      indexCount += item.geometry.index ? item.geometry.index.count : pos.count;
    }
    const positions = new Float32Array(vertexCount * 3);
    const entities = new Float32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    const v = new THREE.Vector3();
    let vOffset = 0;
    let iOffset = 0;

    for (const [k, item] of batch.items.entries()) {
      await progress(k);
      const pos = item.geometry.getAttribute('position');
      const box = this.boxFor(item.entity);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(item.matrix);
        positions[(vOffset + i) * 3] = v.x;
        positions[(vOffset + i) * 3 + 1] = v.y;
        positions[(vOffset + i) * 3 + 2] = v.z;
        entities[vOffset + i] = item.entity;
        box.expandByPoint(v);
      }
      // Front faces must point outward: the section cut fill draws back
      // faces. Some rvt-rs bodies come out inside-out (e.g. slabs whose
      // sketch runs clockwise) and mirroring transforms flip winding too,
      // so orient by the signed volume in world space.
      const flip = signedVolume(item.geometry, volumeCache) * item.matrix.determinant() < 0;
      const index = item.geometry.index;
      const n = index ? index.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i + 1) : i + 1;
        const c = index ? index.getX(i + 2) : i + 2;
        indices[iOffset + i] = vOffset + a;
        indices[iOffset + i + 1] = vOffset + (flip ? c : b);
        indices[iOffset + i + 2] = vOffset + (flip ? b : c);
      }
      vOffset += pos.count;
      iOffset += n;
    }
    await progress(batch.items.length);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aEntity', new THREE.BufferAttribute(entities, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.boundsTree = new MeshBVH(geometry);
    this.disposables.push(geometry);
    if (geometry.boundingBox) this.box.union(geometry.boundingBox);

    // Opaque pass draws everything whose effective opacity is 1 (and the
    // section cut fill); the transparent pass draws the rest. Both share the
    // geometry, so per-element opacity overrides need no re-batching.
    const opaque = new THREE.Mesh(geometry, createFaceMaterial(uniforms, batch.color, batch.opacity, 0));
    const transparent = new THREE.Mesh(geometry, createFaceMaterial(uniforms, batch.color, batch.opacity, 1));
    transparent.renderOrder = 1;
    opaque.raycast = acceleratedRaycast;
    for (const m of [opaque, transparent]) {
      m.matrixAutoUpdate = false;
      this.disposables.push(m.material as THREE.Material);
      this.root.add(m);
    }
    this.pickMeshes.push(opaque);
  }

  private buildEdges(
    chunks: { positions: Float32Array; matrix: THREE.Matrix4; entity: number }[],
    uniforms: SharedUniforms,
  ): void {
    let count = 0;
    for (const c of chunks) count += c.positions.length / 3;
    if (count === 0) return;
    const positions = new Float32Array(count * 3);
    const entities = new Float32Array(count);
    const v = new THREE.Vector3();
    let o = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.positions.length; i += 3) {
        v.set(c.positions[i]!, c.positions[i + 1]!, c.positions[i + 2]!).applyMatrix4(c.matrix);
        positions[o * 3] = v.x;
        positions[o * 3 + 1] = v.y;
        positions[o * 3 + 2] = v.z;
        entities[o] = c.entity;
        o++;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aEntity', new THREE.BufferAttribute(entities, 1));
    geometry.computeBoundingSphere();
    const material = createEdgeMaterial(uniforms);
    const lines = new THREE.LineSegments(geometry, material);
    lines.matrixAutoUpdate = false;
    lines.renderOrder = 2;
    lines.raycast = () => {};
    this.disposables.push(geometry, material);
    this.root.add(lines);
  }

  private boxFor(entity: number): THREE.Box3 {
    let box = this.entityBoxes.get(entity);
    if (!box) {
      box = new THREE.Box3();
      this.entityBoxes.set(entity, box);
    }
    return box;
  }

  /** Entities with a body, i.e. anything that can be drawn or picked. */
  get drawnEntities(): number[] {
    return [...this.entityBoxes.keys()];
  }

  /**
   * All visible, unclipped hits along the ray, nearest first.
   * `planes` are the active clipping planes (three.js convention: keep n·p + c ≥ 0).
   */
  raycast(raycaster: THREE.Raycaster, planes: THREE.Plane[]): ModelHit[] {
    const hits: THREE.Intersection[] = [];
    for (const mesh of this.pickMeshes) {
      raycaster.intersectObject(mesh, false, hits);
    }
    const seen = new Set<number>();
    const result: ModelHit[] = [];
    hits.sort((a, b) => a.distance - b.distance);
    for (const hit of hits) {
      const geometry = (hit.object as THREE.Mesh).geometry;
      const entityAttr = geometry.getAttribute('aEntity');
      if (!hit.face || !entityAttr) continue;
      const entity = Math.round(entityAttr.getX(hit.face.a));
      if (seen.has(entity) || !this.state.isVisible(entity)) continue;
      if (planes.some((p) => p.distanceToPoint(hit.point) < -1e-4)) continue;
      seen.add(entity);
      result.push({ entity, point: hit.point.clone(), distance: hit.distance });
    }
    return result;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const m of this.pickMeshes) m.geometry.boundsTree = undefined;
    this.state.dispose();
    this.root.clear();
  }
}

/**
 * Signed volume of a triangle mesh (positive when triangles wind
 * counter-clockwise seen from outside). Open or flat meshes give ~0 and
 * are treated as outward-facing.
 */
export function signedVolume(geometry: THREE.BufferGeometry, cache?: Map<string, number>): number {
  const cached = cache?.get(geometry.uuid);
  if (cached !== undefined) return cached;
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const n = index ? index.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, index ? index.getX(i) : i);
    b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2);
    volume += a.dot(b.cross(c));
  }
  volume /= 6;
  const result = Math.abs(volume) < 1e-12 ? 1 : volume;
  cache?.set(geometry.uuid, result);
  return result;
}

/**
 * The first half of a face set rvt-rs wrote two-sided (every triangle, then
 * the same reversed), for edge finding: half the work, and each crease once.
 * Null for any other geometry.
 */
export function frontHalf(geometry: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const index = geometry.index;
  if (!index || index.count === 0 || index.count % 6 !== 0) return null;
  const half = index.count / 2;
  const ids = index.array;
  for (let i = 0; i < half; i += 3) {
    if (ids[half + i] !== ids[i] || ids[half + i + 1] !== ids[i + 2] || ids[half + i + 2] !== ids[i + 1]) return null;
  }
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', geometry.getAttribute('position'));
  front.setIndex(new THREE.BufferAttribute(ids.slice(0, half), 1));
  return front;
}

/**
 * `geometry`'s triangles in `runs`, each its own compact geometry. rvt-rs
 * writes a face set two-sided, every triangle then the same reversed, so a
 * run covers its range in both halves; a transparent run takes the first
 * only, as the faces are drawn double-sided and would blend twice. Null
 * where the counts disagree.
 */
export function splitByRuns(
  geometry: THREE.BufferGeometry,
  runs: MaterialRun[],
): { geometry: THREE.BufferGeometry; color: [number, number, number] | null; opacity: number }[] | null {
  const index = geometry.index;
  if (!index) return null;
  const total = runs.reduce((n, r) => n + r.triangles, 0);
  const triangles = index.count / 3;
  const halves = triangles === total ? 1 : triangles === 2 * total ? 2 : 0;
  if (!halves || total === 0) return null;
  const position = geometry.getAttribute('position');
  const result = [];
  let start = 0;
  for (const run of runs) {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (let half = 0; half < (run.opacity < 1 ? 1 : halves); half++) {
      const first = half * total + start;
      for (let t = first; t < first + run.triangles; t++) {
        for (let k = 0; k < 3; k++) {
          const v = index.getX(t * 3 + k);
          let m = remap.get(v);
          if (m === undefined) {
            m = remap.size;
            remap.set(v, m);
            positions.push(position.getX(v), position.getY(v), position.getZ(v));
          }
          indices.push(m);
        }
      }
    }
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    part.setIndex(indices);
    result.push({ geometry: part, color: run.color, opacity: run.opacity });
    start += run.triangles;
  }
  return result;
}

function entityIndexOf(obj: THREE.Object3D): number | null {
  let o: THREE.Object3D | null = obj;
  while (o) {
    const idx = (o.userData as { entityIndex?: unknown }).entityIndex;
    if (typeof idx === 'number') return idx;
    o = o.parent;
  }
  return null;
}

function disposeScene(scene: THREE.Object3D): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  });
}
