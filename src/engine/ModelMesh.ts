/*
 * Turns the rvt-rs GLB (one node per element, `extras.entityIndex`) into a
 * handful of merged meshes — one per material — plus one merged edge
 * LineSegments. Per-element state lives in EntityState textures; picking
 * uses a BVH over the merged triangles and maps hits back to entities.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
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

  static async fromGlb(glb: Uint8Array, entityCount: number, uniforms: SharedUniforms): Promise<ModelMesh> {
    const model = new ModelMesh(entityCount);
    const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    gltf.scene.updateMatrixWorld(true);
    model.build(gltf.scene, uniforms);
    disposeScene(gltf.scene);
    return model;
  }

  private build(scene: THREE.Object3D, uniforms: SharedUniforms): void {
    const batches = new Map<string, Batch>();
    const edgeCache = new Map<string, Float32Array>();
    const edgeChunks: { positions: Float32Array; matrix: THREE.Matrix4; entity: number }[] = [];

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const entity = entityIndexOf(mesh);
      if (entity === null) return;
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      const color = material?.color?.clone() ?? new THREE.Color(0xb2b4b8);
      const opacity = material?.transparent ? (material.opacity ?? 1) : 1;
      const key = `${color.getHexString()}-${opacity.toFixed(3)}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { color, opacity, items: [] };
        batches.set(key, batch);
      }
      const matrix = mesh.matrixWorld.clone();
      batch.items.push({ geometry: mesh.geometry, matrix, entity });

      let edges = edgeCache.get(mesh.geometry.uuid);
      if (!edges) {
        const eg = new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD_DEG);
        edges = eg.getAttribute('position').array as Float32Array;
        eg.dispose();
        edgeCache.set(mesh.geometry.uuid, edges);
      }
      edgeChunks.push({ positions: edges, matrix, entity });
    });

    for (const batch of batches.values()) this.buildBatch(batch, uniforms);
    this.buildEdges(edgeChunks, uniforms);
  }

  private buildBatch(batch: Batch, uniforms: SharedUniforms): void {
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

    for (const item of batch.items) {
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
      // A mirroring transform flips triangle winding; flip it back so
      // front faces stay outward (the section cut fill relies on it).
      const flip = item.matrix.determinant() < 0;
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
