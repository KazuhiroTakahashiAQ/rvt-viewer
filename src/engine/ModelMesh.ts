/*
 * Turns the rvt-rs GLB (one node per element, `extras.entityIndex`) into a
 * handful of merged meshes — one per material — plus one merged edge
 * LineSegments. Per-element state lives in EntityState textures; picking
 * uses a BVH over the merged triangles and maps hits back to entities.
 *
 * Bodies drawn from Revit's saved meshes arrive later, a patch at a time
 * (`applyPatch`): an entity's earlier triangles and edges are collapsed to a
 * point where they lie, and the patch is drawn as meshes of its own, merged
 * with the other patches a few at a time so that draw calls stay few. A body
 * drawn in several of Revit's materials (a window's frame and glass) is
 * split into its material runs.
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTFLoaderPlugin, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { MaterialRun } from '../wasm/types';
import type { RefinePatch } from '../worker/protocol';
import { buildBoundsTree } from './boundsTree';
import { EntityState } from './EntityState';
import { InstanceGroup, type InstanceHit, type InstancePart } from './InstanceGroup';
import { type SharedUniforms, createEdgeMaterial, createFaceMaterial, passVisible } from './modelMaterials';

const EDGE_THRESHOLD_DEG = 25;

interface SourceMesh {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  entity: number;
}

/** An element's colour and opacity, as its GLB material gives them. */
interface Look {
  color: THREE.Color;
  opacity: number;
}

const DEFAULT_LOOK: Look = { color: new THREE.Color(0xb2b4b8), opacity: 1 };

/** Where one entity's vertices lie in a drawn buffer, to hide them when its body is replaced. */
interface Span {
  attribute: THREE.BufferAttribute;
  start: number;
  count: number;
  /** The patch chunk drawing them; null for the first build. */
  owner: Chunk | null;
  item: { live: boolean } | null;
}

/** One entity's triangles (or a run of them) in one look, for a patch chunk. */
interface Part {
  entity: number;
  look: Look;
  /** x, y, z of the part's own vertices. */
  positions: Float32Array;
  /** Into `positions`, three a triangle. */
  indices: Uint32Array;
}

interface PartEdges {
  entity: number;
  /** Segment end points. */
  positions: Float32Array;
}

/** A part's place in a chunk's buffers. */
interface ChunkItem {
  entity: number;
  look: Look;
  start: number;
  count: number;
  indexStart: number;
  indexCount: number;
  live: boolean;
}

interface ChunkEdgeItem {
  entity: number;
  start: number;
  count: number;
  live: boolean;
}

/** One or more patches' bodies, drawn together. */
interface Chunk {
  /** 0 for a single patch, 1 for patches merged. */
  level: number;
  groups: { geometry: THREE.BufferGeometry; items: ChunkItem[]; meshes: THREE.Mesh[] }[];
  edges: { geometry: THREE.BufferGeometry; lines: THREE.LineSegments; items: ChunkEdgeItem[] } | null;
  disposables: { dispose(): void }[];
}

/**
 * Single patches are merged this many at a time, and merged chunks no
 * further: merging those again would build (and upload to the GPU) much of
 * the model at once, stopping the page and the GPU for most of a second.
 */
const MERGE_FAN_IN = 6;

/**
 * A saved-mesh shape: the mesh, in its placement's frame, that every body
 * of it draws (instances of one family type, mostly).
 */
interface Shape {
  positions: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
  /** Entities drawn with it now. */
  users: Set<number>;
  /** Drawn by instancing rather than in the merged meshes. */
  instanced: boolean;
}

/** A body drawn from a shape. */
interface Placed {
  shape: number;
  matrix: THREE.Matrix4;
  look: Look;
  runs: MaterialRun[] | null;
}

/** Shapes instanced at most: each costs a few draw calls. */
const MAX_INSTANCED_SHAPES = 128;

interface Batch {
  color: THREE.Color;
  opacity: number;
  items: SourceMesh[];
  triangles: number;
}

/**
 * Triangles of one merged mesh, at most: a batch of one material is split
 * so that no single merge blocks the page for long (the BVHs are built in
 * a worker: [`buildBoundsTree`]).
 */
const MAX_BATCH_TRIANGLES = 400_000;

/**
 * The same for the saved-mesh patches, which come while the user looks
 * around: a BVH takes about 0.25 ms a thousand triangles to build, so a
 * chunk waits about 30 ms for the worker's before it shows.
 */
const MAX_PATCH_TRIANGLES = 120_000;

/** Work between yields to the browser, milliseconds. */
const SLICE_MS = 12;

/** Let the browser handle input and paint before going on. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Yields every [`SLICE_MS`] of work, reporting the share done as it does,
 * and waiting at `gate` (while the user moves the view) before going on.
 */
class Slicer {
  private last = performance.now();

  constructor(
    private readonly onProgress?: (fraction: number) => void,
    private readonly gate?: () => Promise<void>,
  ) {}

  async at(fraction = 0): Promise<void> {
    if (performance.now() - this.last < SLICE_MS) return;
    this.onProgress?.(Math.min(1, fraction));
    await yieldToBrowser();
    await this.gate?.();
    this.last = performance.now();
  }
}

/** Parse work between yields to the browser, ms: the nodes' later steps come on top. */
const PARSE_SLICE_MS = 4;

/**
 * A GLTFLoader plugin loading the nodes a slice at a time: once the parse
 * has run for [`PARSE_SLICE_MS`], the nodes asked for wait for the next
 * task (all one, which slices them again). The loader's own steps all run
 * in one go else, a large model's for a tenth of a second.
 */
function slicedNodes(parser: GLTFParser): GLTFLoaderPlugin {
  let last = performance.now();
  let next: Promise<void> | null = null;
  const loadNode = (nodeIndex: number): Promise<THREE.Object3D> | null => {
    if (performance.now() - last < PARSE_SLICE_MS) return null;
    next ??= yieldToBrowser().then(() => {
      next = null;
      last = performance.now();
    });
    return next.then(() => loadNode(nodeIndex) ?? parser.loadNode(nodeIndex));
  };
  return { name: 'rvt_sliced_nodes', loadNode };
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
  private pickMeshes: THREE.Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  /** Each entity's colour and opacity in the first build. */
  private readonly looks = new Map<number, Look>();
  /** Where each entity's current body lies in the buffers. */
  private readonly spans = new Map<number, Span[]>();
  private chunks: Chunk[] = [];
  private disposed = false;
  private readonly shapes = new Map<number, Shape>();
  private readonly placed = new Map<number, Placed>();
  /** Instanced bodies by shape, look and runs. */
  private readonly groups = new Map<string, InstanceGroup>();
  private readonly slots = new Map<number, { group: InstanceGroup; slot: number }>();
  private instancedShapes = 0;
  /** Some element has an opacity override: the transparent pass draws every batch. */
  private opacityOverrides = false;

  /**
   * A shape is drawn by instancing once that saves this many triangles
   * (its triangles times its bodies but one): fewer, larger shapes, as each
   * instanced one is a few more draw calls.
   */
  static instanceSaving = 10_000;

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
    onProgress?: (fraction: number) => void,
  ): Promise<ModelMesh> {
    const model = new ModelMesh(entityCount);
    // The GLB of a large model is hundreds of megabytes: no copy where it
    // is its buffer's only content.
    const buffer =
      glb.byteOffset === 0 && glb.byteLength === glb.buffer.byteLength
        ? (glb.buffer as ArrayBuffer)
        : (glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer);
    // Not in the task that asked (the page's first render, for one).
    await yieldToBrowser();
    const gltf = await new GLTFLoader().register(slicedNodes).parseAsync(buffer, '');
    gltf.scene.updateMatrixWorld(true);
    try {
      await model.build(gltf.scene, uniforms, onProgress);
    } catch (err) {
      model.dispose();
      throw err;
    } finally {
      disposeScene(gltf.scene);
    }
    return model;
  }

  private async build(scene: THREE.Object3D, uniforms: SharedUniforms, onProgress?: (fraction: number) => void): Promise<void> {
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
    const fronts: THREE.BufferGeometry[] = [];
    const add = (color: THREE.Color, opacity: number, item: SourceMesh) => {
      if (!this.looks.has(item.entity)) this.looks.set(item.entity, { color, opacity });
      const key = lookKey({ color, opacity });
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
      if (front) fronts.push(front);
      const geometry = front ?? mesh.geometry;
      add(color, opacity, { geometry, matrix, entity });

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
    const trees: Promise<void>[] = [];
    for (const batch of all) {
      await this.buildBatch(batch, uniforms, volumeCache, trees, async (items) => {
        await slicer.at(0.5 + (0.48 * (merged + items)) / totalItems);
      });
      merged += batch.items.length;
    }
    await slicer.at(0.98);
    this.buildEdges(edgeChunks, uniforms);
    for (const front of fronts) front.dispose();
    this.updatePasses();
    // The batches lent their buffers to the worker: drawn once back.
    await Promise.all(trees);
    onProgress?.(1);
  }

  private async buildBatch(
    batch: Batch,
    uniforms: SharedUniforms,
    volumeCache: Map<string, number>,
    trees: Promise<void>[],
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
    const ranges: { entity: number; start: number; count: number }[] = [];

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
      ranges.push({ entity: item.entity, start: vOffset, count: pos.count });
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
    attachBoundsTree(geometry, false, trees);
    this.disposables.push(geometry);
    if (geometry.boundingBox) this.box.union(geometry.boundingBox);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const r of ranges) this.addSpan(r.entity, { attribute: position, start: r.start, count: r.count, owner: null, item: null });

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
    const ranges: { entity: number; start: number; count: number }[] = [];
    for (const c of chunks) {
      ranges.push({ entity: c.entity, start: o, count: c.positions.length / 3 });
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
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const r of ranges) this.addSpan(r.entity, { attribute: position, start: r.start, count: r.count, owner: null, item: null });
  }

  private addSpan(entity: number, span: Span): void {
    const list = this.spans.get(entity);
    if (list) list.push(span);
    else this.spans.set(entity, [span]);
  }

  // --- patches ------------------------------------------------------------

  /**
   * Draw `patch`'s bodies in place of their entities' current ones,
   * yielding to the browser every few milliseconds and waiting at `gate`.
   */
  async applyPatch(patch: RefinePatch, uniforms: SharedUniforms, gate?: () => Promise<void>): Promise<void> {
    const slicer = new Slicer(undefined, gate);
    const runs = new Map(patch.runs.map((r) => [r.entity, r.runs]));
    const parts: Part[] = [];
    const edges: PartEdges[] = [];
    for (let i = 0; i < patch.entities.length; i++) {
      await slicer.at();
      if (this.disposed) return;
      const entity = patch.entities[i]!;
      const shapeId = patch.shapes[i]!;
      const indices = patch.triangles.subarray(patch.triangleStarts[i]! * 3, patch.triangleStarts[i + 1]! * 3);
      // The shape's mesh comes with its first body.
      if (indices.length > 0) {
        const positions = patch.positions.slice(patch.vertexStarts[i]! * 3, patch.vertexStarts[i + 1]! * 3);
        this.shapes.set(shapeId, {
          positions,
          indices: indices.slice(),
          edges: patch.edges.slice(patch.edgeStarts[i]! * 6, patch.edgeStarts[i + 1]! * 6),
          users: new Set(),
          instanced: false,
        });
      }
      const shape = this.shapes.get(shapeId);
      if (!shape) continue;
      this.retire(entity);
      const [x, y, z, turn] = patch.placements.subarray(i * 4, i * 4 + 4);
      const matrix = new THREE.Matrix4().makeRotationY(turn!).setPosition(x!, y!, z!);
      const placed: Placed = { shape: shapeId, matrix, look: this.looks.get(entity) ?? DEFAULT_LOOK, runs: runs.get(entity) ?? null };
      this.placed.set(entity, placed);
      shape.users.add(entity);
      // From the vertices: a turned shape's box turned would be larger.
      const box = placedBox(shape.positions, matrix);
      this.entityBoxes.set(entity, box);
      this.box.union(box);
      if (!shape.instanced && this.shouldInstance(shape)) {
        // From now on every body of the shape is instanced, the ones drawn already too.
        shape.instanced = true;
        this.instancedShapes++;
        for (const other of shape.users) {
          if (other === entity) continue;
          this.collapse(other);
          this.addInstance(other, uniforms);
        }
      }
      if (shape.instanced) {
        this.addInstance(entity, uniforms);
        continue;
      }
      for (const part of shapeParts(shape, placed)) {
        parts.push({ entity, look: part.look, positions: transformed(part.positions, matrix), indices: part.indices });
      }
      edges.push({ entity, positions: transformed(shape.edges, matrix) });
    }
    if (parts.length > 0) this.show(await this.buildChunk(parts, edges, 0, uniforms, slicer), []);
    const single = this.chunks.filter((c) => c.level === 0);
    if (single.length >= MERGE_FAN_IN) await this.merge(single, 1, uniforms, slicer);
    this.updatePasses();
  }

  /**
   * Merge the chunks of single patches left: no more will come. (Merging
   * everything would hold a copy of every body at once.)
   */
  async compactPatches(uniforms: SharedUniforms, gate?: () => Promise<void>): Promise<void> {
    const small = this.chunks.filter((c) => c.level === 0);
    if (small.length < 2) return;
    await this.merge(small, 1, uniforms, new Slicer(undefined, gate));
    this.updatePasses();
  }

  /** Patch chunks drawn now. */
  get patchChunks(): number {
    return this.chunks.length;
  }

  /** Instanced bodies drawn now, and the groups drawing them. */
  get instanced(): { bodies: number; groups: number } {
    let bodies = 0;
    for (const g of this.groups.values()) bodies += g.count;
    return { bodies, groups: this.groups.size };
  }

  private shouldInstance(shape: Shape): boolean {
    const saving = (shape.users.size - 1) * (shape.indices.length / 3);
    return saving >= ModelMesh.instanceSaving && this.instancedShapes < MAX_INSTANCED_SHAPES;
  }

  /** Draw `entity`'s placed body in the instance group of its shape, look and runs. */
  private addInstance(entity: number, uniforms: SharedUniforms): void {
    const placed = this.placed.get(entity)!;
    const shape = this.shapes.get(placed.shape)!;
    const key = `${placed.shape}|${lookKey(placed.look)}|${runsKey(placed.runs)}`;
    let group = this.groups.get(key);
    if (!group) {
      const parts: InstancePart[] = shapeParts(shape, placed).map((p) => ({
        positions: p.positions,
        indices: p.indices,
        color: p.look.color,
        opacity: p.look.opacity,
      }));
      group = new InstanceGroup(parts, shape.edges, uniforms, Math.max(8, shape.users.size * 2));
      this.groups.set(key, group);
      this.root.add(group.root);
    }
    const slot = group.add(entity, placed.matrix, this.entityBoxes.get(entity)!);
    this.slots.set(entity, { group, slot });
  }

  /** Hide `entity`'s current body, merged or instanced, and forget its shape. */
  private retire(entity: number): void {
    this.collapse(entity);
    const placed = this.placed.get(entity);
    if (placed) {
      this.shapes.get(placed.shape)?.users.delete(entity);
      this.placed.delete(entity);
    }
  }

  /** Stop drawing `entity`'s current body: its vertices collapse onto its first. */
  private collapse(entity: number): void {
    const slot = this.slots.get(entity);
    if (slot) {
      slot.group.remove(slot.slot);
      this.slots.delete(entity);
    }
    for (const span of this.spans.get(entity) ?? []) {
      const a = span.attribute.array as Float32Array;
      const s = span.start * 3;
      const end = (span.start + span.count) * 3;
      for (let k = s + 3; k < end; k += 3) {
        a[k] = a[s]!;
        a[k + 1] = a[s + 1]!;
        a[k + 2] = a[s + 2]!;
      }
      span.attribute.addUpdateRange(s, end - s);
      span.attribute.needsUpdate = true;
      if (span.item) span.item.live = false;
    }
    this.spans.delete(entity);
  }

  /** Put `chunk` in the scene in place of `old`, at once. */
  private show(chunk: Chunk, old: Chunk[]): void {
    if (this.disposed) {
      for (const d of chunk.disposables) d.dispose();
      return;
    }
    for (const group of chunk.groups) {
      for (const mesh of group.meshes) this.root.add(mesh);
      this.pickMeshes.push(group.meshes[0]!);
    }
    if (chunk.edges) this.root.add(chunk.edges.lines);
    for (const c of old) {
      for (const group of c.groups) for (const mesh of group.meshes) this.root.remove(mesh);
      if (c.edges) this.root.remove(c.edges.lines);
      const picks = new Set(c.groups.map((g) => g.meshes[0]));
      this.pickMeshes = this.pickMeshes.filter((m) => !picks.has(m));
      for (const group of c.groups) for (const item of group.items) if (item.live) this.dropSpans(item.entity, c);
      for (const item of c.edges?.items ?? []) if (item.live) this.dropSpans(item.entity, c);
      for (const d of c.disposables) d.dispose();
      for (const group of c.groups) group.geometry.boundsTree = undefined;
    }
    this.chunks = this.chunks.filter((c) => !old.includes(c));
    this.chunks.push(chunk);
  }

  private dropSpans(entity: number, owner: Chunk): void {
    const list = this.spans.get(entity);
    if (!list) return;
    const kept = list.filter((s) => s.owner !== owner);
    if (kept.length > 0) this.spans.set(entity, kept);
    else this.spans.delete(entity);
  }

  /** Draw the live bodies of `chunks` as one chunk of `level`. */
  private async merge(chunks: Chunk[], level: number, uniforms: SharedUniforms, slicer: Slicer): Promise<void> {
    const parts: Part[] = [];
    const edges: PartEdges[] = [];
    for (const chunk of chunks) {
      for (const group of chunk.groups) {
        const positions = group.geometry.getAttribute('position').array as Float32Array;
        const index = group.geometry.index!.array as Uint32Array;
        for (const item of group.items) {
          if (!item.live) continue;
          await slicer.at();
          const local = index.slice(item.indexStart, item.indexStart + item.indexCount);
          for (let k = 0; k < local.length; k++) local[k] = local[k]! - item.start;
          parts.push({
            entity: item.entity,
            look: item.look,
            positions: positions.subarray(item.start * 3, (item.start + item.count) * 3),
            indices: local,
          });
        }
      }
      if (chunk.edges) {
        const positions = chunk.edges.geometry.getAttribute('position').array as Float32Array;
        for (const item of chunk.edges.items) {
          if (item.live) edges.push({ entity: item.entity, positions: positions.subarray(item.start * 3, (item.start + item.count) * 3) });
        }
      }
    }
    const merged = await this.buildChunk(parts, edges, level, uniforms, slicer);
    this.show(merged, chunks);
  }

  /** Meshes for `parts`, one per look (split at MAX_PATCH_TRIANGLES), and one edge set. */
  private async buildChunk(parts: Part[], edges: PartEdges[], level: number, uniforms: SharedUniforms, slicer: Slicer): Promise<Chunk> {
    const chunk: Chunk = { level, groups: [], edges: null, disposables: [] };
    const trees: Promise<void>[] = [];
    const byLook = new Map<string, Part[][]>();
    const sizes = new Map<Part[], number>();
    for (const part of parts) {
      const key = lookKey(part.look);
      const lists = byLook.get(key) ?? [];
      byLook.set(key, lists);
      let list = lists.at(-1);
      const triangles = part.indices.length / 3;
      if (!list || (list.length > 0 && sizes.get(list)! + triangles > MAX_PATCH_TRIANGLES)) {
        list = [];
        lists.push(list);
        sizes.set(list, 0);
      }
      list.push(part);
      sizes.set(list, sizes.get(list)! + triangles);
    }
    for (const list of [...byLook.values()].flat()) {
      let vertexCount = 0;
      let indexCount = 0;
      for (const part of list) {
        vertexCount += part.positions.length / 3;
        indexCount += part.indices.length;
      }
      const positions = new Float32Array(vertexCount * 3);
      const entities = new Float32Array(vertexCount);
      const index = new Uint32Array(indexCount);
      const items: ChunkItem[] = [];
      let v = 0;
      let o = 0;
      for (const part of list) {
        await slicer.at();
        const count = part.positions.length / 3;
        positions.set(part.positions, v * 3);
        entities.fill(part.entity, v, v + count);
        for (let k = 0; k < part.indices.length; k++) index[o + k] = part.indices[k]! + v;
        items.push({ entity: part.entity, look: part.look, start: v, count, indexStart: o, indexCount: part.indices.length, live: true });
        v += count;
        o += part.indices.length;
      }
      const geometry = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(positions, 3);
      geometry.setAttribute('position', position);
      geometry.setAttribute('aEntity', new THREE.BufferAttribute(entities, 1));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      await slicer.at();
      // Indirect: the index keeps its order, so that a merge can read each part back.
      attachBoundsTree(geometry, true, trees);
      const look = list[0]!.look;
      const meshes = ([0, 1] as const).map((pass) => {
        const mesh = new THREE.Mesh(geometry, createFaceMaterial(uniforms, look.color, look.opacity, pass));
        mesh.matrixAutoUpdate = false;
        if (pass === 1) mesh.renderOrder = 1;
        chunk.disposables.push(mesh.material as THREE.Material);
        return mesh;
      });
      meshes[0]!.raycast = acceleratedRaycast;
      chunk.disposables.push(geometry);
      chunk.groups.push({ geometry, items, meshes });
      for (const item of items) this.addSpan(item.entity, { attribute: position, start: item.start, count: item.count, owner: chunk, item });
    }
    let segmentPoints = 0;
    for (const e of edges) segmentPoints += e.positions.length / 3;
    if (segmentPoints > 0) {
      const positions = new Float32Array(segmentPoints * 3);
      const entities = new Float32Array(segmentPoints);
      const items: ChunkEdgeItem[] = [];
      let v = 0;
      for (const e of edges) {
        const count = e.positions.length / 3;
        positions.set(e.positions, v * 3);
        entities.fill(e.entity, v, v + count);
        items.push({ entity: e.entity, start: v, count, live: true });
        v += count;
      }
      const geometry = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(positions, 3);
      geometry.setAttribute('position', position);
      geometry.setAttribute('aEntity', new THREE.BufferAttribute(entities, 1));
      geometry.computeBoundingSphere();
      const material = createEdgeMaterial(uniforms);
      const lines = new THREE.LineSegments(geometry, material);
      lines.matrixAutoUpdate = false;
      lines.renderOrder = 2;
      lines.raycast = () => {};
      chunk.disposables.push(geometry, material);
      chunk.edges = { geometry, lines, items };
      for (const item of items) this.addSpan(item.entity, { attribute: position, start: item.start, count: item.count, owner: chunk, item });
    }
    // The meshes lent their buffers to the worker: shown once back.
    await Promise.all(trees);
    return chunk;
  }

  private boxFor(entity: number): THREE.Box3 {
    let box = this.entityBoxes.get(entity);
    if (!box) {
      box = new THREE.Box3();
      this.entityBoxes.set(entity, box);
    }
    return box;
  }

  /** Tell whether some element has an opacity override (the transparent pass is drawn for all then). */
  setOpacityOverrides(on: boolean): void {
    this.opacityOverrides = on;
    this.updatePasses();
  }

  /** Show only the passes that can draw something ([`passVisible`]). */
  private updatePasses(): void {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) mesh.visible = passVisible(mesh.material, this.opacityOverrides);
    });
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
    const candidates: InstanceHit[] = [];
    for (const hit of hits) {
      const geometry = (hit.object as THREE.Mesh).geometry;
      const entityAttr = geometry.getAttribute('aEntity');
      if (!hit.face || !entityAttr) continue;
      candidates.push({ entity: Math.round(entityAttr.getX(hit.face.a)), point: hit.point, distance: hit.distance });
    }
    const visible = (e: number) => this.state.isVisible(e);
    for (const group of this.groups.values()) group.raycast(raycaster.ray, visible, candidates);
    const seen = new Set<number>();
    const result: ModelHit[] = [];
    candidates.sort((a, b) => a.distance - b.distance);
    for (const hit of candidates) {
      if (hit.distance < raycaster.near || hit.distance > raycaster.far) continue;
      if (seen.has(hit.entity) || !this.state.isVisible(hit.entity)) continue;
      if (planes.some((p) => p.distanceToPoint(hit.point) < -1e-4)) continue;
      seen.add(hit.entity);
      result.push({ entity: hit.entity, point: hit.point.clone(), distance: hit.distance });
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    for (const c of this.chunks) for (const d of c.disposables) d.dispose();
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    this.chunks = [];
    this.spans.clear();
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
 * A body's triangles in `runs` of one material, in order, each with its
 * own vertices. Null where the counts disagree.
 */
export function splitRuns(
  positions: Float32Array,
  indices: Uint32Array,
  runs: MaterialRun[],
): { positions: Float32Array; indices: Uint32Array; color: [number, number, number] | null; opacity: number }[] | null {
  const total = runs.reduce((n, r) => n + r.triangles, 0);
  if (total === 0 || total * 3 !== indices.length) return null;
  const remap = new Int32Array(positions.length / 3);
  const result = [];
  let start = 0;
  for (const run of runs) {
    remap.fill(-1);
    const out = new Float32Array(Math.min(positions.length, run.triangles * 9));
    const own = new Uint32Array(run.triangles * 3);
    let n = 0;
    for (let k = 0; k < own.length; k++) {
      const v = indices[start * 3 + k]!;
      let m = remap[v]!;
      if (m < 0) {
        m = n++;
        remap[v] = m;
        out[m * 3] = positions[v * 3]!;
        out[m * 3 + 1] = positions[v * 3 + 1]!;
        out[m * 3 + 2] = positions[v * 3 + 2]!;
      }
      own[k] = m;
    }
    result.push({ positions: out.slice(0, n * 3), indices: own, color: run.color, opacity: run.opacity });
    start += run.triangles;
  }
  return result;
}

/**
 * Give `geometry`, not drawn yet, its BVH: at once where small, else once
 * the worker sends it back (`trees` gets the wait) with the buffers it lent.
 * Without one, picking it falls back to testing every triangle.
 */
function attachBoundsTree(geometry: THREE.BufferGeometry, indirect: boolean, trees: Promise<void>[]): void {
  const tree = buildBoundsTree(geometry, { indirect, lend: true });
  if (tree instanceof MeshBVH) geometry.boundsTree = tree;
  else {
    trees.push(
      tree.then(
        (t) => {
          geometry.boundsTree = t;
        },
        () => {},
      ),
    );
  }
}

function lookKey(look: Look): string {
  return `${look.color.getHexString()}-${look.opacity.toFixed(3)}`;
}

function runsKey(runs: MaterialRun[] | null): string {
  return runs ? runs.map((r) => `${r.triangles}:${r.color?.join(',') ?? ''}:${r.opacity}`).join(';') : '';
}

/** A shape's triangles as `placed` draws them: in its runs' looks, or whole in its own. */
function shapeParts(shape: Shape, placed: Placed): { positions: Float32Array; indices: Uint32Array; look: Look }[] {
  const split = placed.runs ? splitRuns(shape.positions, shape.indices, placed.runs) : null;
  if (!split) return [{ positions: shape.positions, indices: shape.indices, look: placed.look }];
  return split.map((part) => ({
    positions: part.positions,
    indices: part.indices,
    look: {
      color: part.color ? new THREE.Color().setRGB(...part.color, THREE.SRGBColorSpace) : placed.look.color,
      opacity: part.opacity < 1 ? part.opacity : placed.look.opacity,
    },
  }));
}

/** The box of `positions` (x, y, z each) moved by `matrix`. */
function placedBox(positions: Float32Array, matrix: THREE.Matrix4): THREE.Box3 {
  const e = matrix.elements;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k]!;
    const y = positions[k + 1]!;
    const z = positions[k + 2]!;
    box.expandByPoint(
      v.set(
        e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
        e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
        e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
      ),
    );
  }
  return box;
}

/** `positions` (x, y, z each) moved by `matrix`, a turn about +Y and a translation. */
export function transformed(positions: Float32Array, matrix: THREE.Matrix4): Float32Array {
  const e = matrix.elements;
  const out = new Float32Array(positions.length);
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k]!;
    const y = positions[k + 1]!;
    const z = positions[k + 2]!;
    out[k] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    out[k + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    out[k + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  }
  return out;
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
