/*
 * The bodies of one saved-mesh shape in one look, drawn with GPU
 * instancing: the shape's triangles and edges once, a matrix and an entity
 * index per body. Picking tests each body's box, then the shape's bounds
 * tree in the body's frame.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { EDGE_LAYER, type SharedUniforms, blendedPass, createEdgeMaterial, createFaceMaterial } from './modelMaterials';

/** A part of the shape in one colour and opacity (a run of its materials). */
export interface InstancePart {
  positions: Float32Array;
  indices: Uint32Array;
  color: THREE.Color;
  opacity: number;
}

/** Copies drawing one entity alone ([`ModelMesh.drawOf`]). */
export interface EntityDraw {
  faces: THREE.Object3D[];
  edges: THREE.Object3D[];
  /** Some of it is drawn in the transparent pass (blended, so it cannot be drawn over itself). */
  transparent: boolean;
  /** The copies' own buffers. */
  disposables: { dispose(): void }[];
}

export interface InstanceHit {
  entity: number;
  point: THREE.Vector3;
  distance: number;
}

/** A collapsed body: all its vertices on one point, so it draws nothing. */
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);

export class InstanceGroup {
  readonly root = new THREE.Group();
  private capacity = 0;
  /** Slots handed out so far, live or freed. */
  private used = 0;
  private readonly free: number[] = [];
  private entities = new Int32Array(0);
  private boxes: THREE.Box3[] = [];
  private matrix!: THREE.InstancedBufferAttribute;
  private entity!: THREE.InstancedBufferAttribute;
  private meshes: THREE.InstancedMesh[] = [];
  private lines: THREE.LineSegments | null = null;
  private readonly geometries: THREE.BufferGeometry[];
  private readonly bvhs: MeshBVH[];
  private readonly edgePositions: THREE.BufferAttribute | null;
  private readonly materials: THREE.Material[] = [];

  constructor(
    private readonly parts: InstancePart[],
    edges: Float32Array,
    private readonly uniforms: SharedUniforms,
    capacity: number,
  ) {
    this.geometries = parts.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeBoundingBox();
      return g;
    });
    this.bvhs = this.geometries.map((g) => new MeshBVH(g));
    this.edgePositions = edges.length > 0 ? new THREE.BufferAttribute(edges, 3) : null;
    this.root.name = 'rvt-instances';
    this.allocate(Math.max(1, capacity));
  }

  /** Bodies drawn now. */
  get count(): number {
    return this.used - this.free.length;
  }

  /** Draw `entity` with `matrix`, its world `box`; returns its slot. */
  add(entity: number, matrix: THREE.Matrix4, box: THREE.Box3): number {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.used === this.capacity) this.allocate(this.capacity * 2);
      slot = this.used++;
    }
    this.entities[slot] = entity;
    this.boxes[slot] = box.clone();
    this.write(slot, matrix, entity);
    return slot;
  }

  /** Stop drawing the body in `slot`. */
  remove(slot: number): void {
    if (this.entities[slot] === -1) return;
    const m = new THREE.Matrix4().fromArray(this.matrix.array as Float32Array, slot * 16);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    this.entities[slot] = -1;
    this.free.push(slot);
    this.write(slot, new THREE.Matrix4().compose(at, new THREE.Quaternion(), ZERO_SCALE), -1);
  }

  /** The visible bodies' hits along the ray, at most one per body. */
  raycast(ray: THREE.Ray, isVisible: (entity: number) => boolean, out: InstanceHit[]): void {
    const m = new THREE.Matrix4();
    const inverse = new THREE.Matrix4();
    const local = new THREE.Ray();
    const array = this.matrix.array as Float32Array;
    for (let slot = 0; slot < this.used; slot++) {
      const entity = this.entities[slot]!;
      if (entity < 0 || !isVisible(entity) || !ray.intersectsBox(this.boxes[slot]!)) continue;
      m.fromArray(array, slot * 16);
      local.copy(ray).applyMatrix4(inverse.copy(m).invert());
      let best: THREE.Vector3 | null = null;
      let bestDistance = Infinity;
      for (const bvh of this.bvhs) {
        const hit = bvh.raycastFirst(local, THREE.DoubleSide);
        if (!hit) continue;
        const point = hit.point.clone().applyMatrix4(m);
        const distance = ray.origin.distanceTo(point);
        if (distance < bestDistance) {
          best = point;
          bestDistance = distance;
        }
      }
      if (best) out.push({ entity, point: best, distance: bestDistance });
    }
  }

  /** Add copies drawing the body in `slot` alone, with this group's materials and its matrix, to `draw`. */
  drawOf(slot: number, draw: EntityDraw): void {
    const entity = this.entities[slot]!;
    if (entity < 0) return;
    const matrix = new THREE.InstancedBufferAttribute((this.matrix.array as Float32Array).slice(slot * 16, slot * 16 + 16), 16);
    const ids = new THREE.InstancedBufferAttribute(new Float32Array([entity]), 1);
    const copies = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    for (const mesh of this.meshes) {
      if (!mesh.visible) continue;
      const material = mesh.material as THREE.Material;
      if (material.userData.rvtPass === 1) {
        draw.transparent ||= blendedPass(material);
        continue;
      }
      let geometry = copies.get(mesh.geometry);
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.geometry.getAttribute('position').array, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.geometry.index!.array, 1));
        geometry.setAttribute('aEntity', ids);
        copies.set(mesh.geometry, geometry);
        draw.disposables.push(geometry);
      }
      const copy = new THREE.InstancedMesh(geometry, material, 1);
      copy.instanceMatrix = matrix;
      copy.matrixAutoUpdate = false;
      copy.renderOrder = mesh.renderOrder;
      copy.frustumCulled = false;
      draw.faces.push(copy);
      draw.disposables.push(copy);
    }
    if (this.lines && this.edgePositions) {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(this.edgePositions.array, 3));
      geometry.setAttribute('instanceMatrix', matrix);
      geometry.setAttribute('aEntity', ids);
      geometry.instanceCount = 1;
      const lines = new THREE.LineSegments(geometry, this.lines.material);
      lines.matrixAutoUpdate = false;
      lines.renderOrder = this.lines.renderOrder;
      lines.frustumCulled = false;
      draw.edges.push(lines);
      draw.disposables.push(geometry);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    this.lines?.geometry.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.clear();
  }

  private write(slot: number, matrix: THREE.Matrix4, entity: number): void {
    matrix.toArray(this.matrix.array as Float32Array, slot * 16);
    if (entity >= 0) (this.entity.array as Float32Array)[slot] = entity;
    this.matrix.addUpdateRange(slot * 16, 16);
    this.matrix.needsUpdate = true;
    this.entity.addUpdateRange(slot, 1);
    this.entity.needsUpdate = true;
    for (const mesh of this.meshes) {
      mesh.count = this.used;
      mesh.computeBoundingSphere();
    }
    if (this.lines) (this.lines.geometry as THREE.InstancedBufferGeometry).instanceCount = this.used;
  }

  /**
   * Room for `capacity` bodies: new buffers holding the old, and new meshes
   * to draw them (an instanced mesh's buffers are freed with the mesh).
   */
  private allocate(capacity: number): void {
    const matrices = new Float32Array(capacity * 16);
    const entities = new Float32Array(capacity);
    if (this.capacity > 0) {
      matrices.set(this.matrix.array as Float32Array);
      entities.set(this.entity.array as Float32Array);
    }
    const ids = new Int32Array(capacity).fill(-1);
    ids.set(this.entities);
    this.entities = ids;
    this.capacity = capacity;
    this.matrix = new THREE.InstancedBufferAttribute(matrices, 16);
    this.entity = new THREE.InstancedBufferAttribute(entities, 1);
    // Free the old buffers on the GPU (the shapes' are uploaded again).
    if (this.meshes.length > 0) for (const g of this.geometries) g.dispose();
    for (const mesh of this.meshes) mesh.dispose();
    if (this.lines) this.lines.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.root.clear();
    this.meshes = [];
    for (const [i, part] of this.parts.entries()) {
      const geometry = this.geometries[i]!;
      geometry.setAttribute('aEntity', this.entity);
      // Opaque and transparent passes, as for the merged meshes.
      for (const pass of [0, 1] as const) {
        const material = createFaceMaterial(this.uniforms, part.color, part.opacity, pass);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceMatrix = this.matrix;
        mesh.count = this.used;
        mesh.matrixAutoUpdate = false;
        if (pass === 1) mesh.renderOrder = 1;
        mesh.raycast = () => {};
        this.materials.push(material);
        this.meshes.push(mesh);
        this.root.add(mesh);
      }
    }
    this.lines = null;
    if (this.edgePositions) {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position', this.edgePositions);
      geometry.setAttribute('instanceMatrix', this.matrix);
      geometry.setAttribute('aEntity', this.entity);
      geometry.instanceCount = this.used;
      const material = createEdgeMaterial(this.uniforms, true);
      const lines = new THREE.LineSegments(geometry, material);
      lines.matrixAutoUpdate = false;
      lines.renderOrder = 2;
      lines.layers.set(EDGE_LAYER);
      lines.frustumCulled = false;
      lines.raycast = () => {};
      this.materials.push(material);
      this.lines = lines;
      this.root.add(lines);
    }
    for (const mesh of this.meshes) mesh.computeBoundingSphere();
  }
}
