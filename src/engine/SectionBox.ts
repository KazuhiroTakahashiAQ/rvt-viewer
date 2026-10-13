/*
 * 3D view section box: an axis-aligned box that clips the model, drawn as
 * an outline with an arrow grip on each face. Dragging a grip moves that
 * face along its normal.
 */

import * as THREE from 'three';

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

const MIN_SIZE = 0.05;

export class SectionBox {
  readonly root = new THREE.Group();
  readonly box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  readonly planes: THREE.Plane[] = AXES.map(() => new THREE.Plane());
  private readonly outline: THREE.LineSegments;
  private readonly grips: THREE.Mesh[] = [];
  private readonly gripMaterial = new THREE.MeshBasicMaterial({ color: 0x1f6fff, depthTest: false });
  private readonly gripHoverMaterial = new THREE.MeshBasicMaterial({ color: 0x00a2ff, depthTest: false });
  private hovered: THREE.Mesh | null = null;

  constructor() {
    this.root.name = 'section-box';
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x1f6fff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.outline.renderOrder = 10;
    this.root.add(this.outline);
    const cone = new THREE.ConeGeometry(0.35, 1, 16);
    cone.translate(0, 0.5, 0);
    AXES.forEach((axis, i) => {
      const grip = new THREE.Mesh(cone, this.gripMaterial);
      grip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      grip.userData.face = i;
      grip.renderOrder = 11;
      this.grips.push(grip);
      this.root.add(grip);
    });
    this.root.visible = false;
  }

  setBox(box: THREE.Box3): void {
    this.box.copy(box);
    this.sync();
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** Keeps grips a constant size on screen. */
  updateScale(worldPerPixel: number): void {
    const s = worldPerPixel * 18;
    for (const g of this.grips) g.scale.setScalar(s);
  }

  /** Index of the face whose grip is under the ray, or null. */
  pickGrip(raycaster: THREE.Raycaster): number | null {
    if (!this.root.visible) return null;
    const hit = raycaster.intersectObjects(this.grips, false)[0];
    return hit ? (hit.object.userData.face as number) : null;
  }

  setHoveredGrip(face: number | null): boolean {
    const grip = face === null ? null : (this.grips[face] ?? null);
    if (grip === this.hovered) return false;
    if (this.hovered) this.hovered.material = this.gripMaterial;
    this.hovered = grip;
    if (grip) grip.material = this.gripHoverMaterial;
    return true;
  }

  faceCenter(face: number): THREE.Vector3 {
    const c = this.box.getCenter(new THREE.Vector3());
    const axis = AXES[face]!;
    const half = this.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    return c.add(axis.clone().multiply(half));
  }

  faceAxis(face: number): THREE.Vector3 {
    return AXES[face]!.clone();
  }

  /** Moves a face outward by `amount` world units (negative = inward). */
  moveFace(face: number, amount: number): void {
    const b = this.box;
    switch (face) {
      case 0: b.max.x = Math.max(b.max.x + amount, b.min.x + MIN_SIZE); break;
      case 1: b.min.x = Math.min(b.min.x - amount, b.max.x - MIN_SIZE); break;
      case 2: b.max.y = Math.max(b.max.y + amount, b.min.y + MIN_SIZE); break;
      case 3: b.min.y = Math.min(b.min.y - amount, b.max.y - MIN_SIZE); break;
      case 4: b.max.z = Math.max(b.max.z + amount, b.min.z + MIN_SIZE); break;
      case 5: b.min.z = Math.min(b.min.z - amount, b.max.z - MIN_SIZE); break;
    }
    this.sync();
  }

  private sync(): void {
    const b = this.box;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    this.outline.scale.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4));
    this.outline.position.copy(center);
    this.grips.forEach((g, i) => g.position.copy(this.faceCenter(i)));
    // Keep-inside planes (three.js keeps n·p + c ≥ 0).
    this.planes[0]!.set(new THREE.Vector3(-1, 0, 0), b.max.x);
    this.planes[1]!.set(new THREE.Vector3(1, 0, 0), -b.min.x);
    this.planes[2]!.set(new THREE.Vector3(0, -1, 0), b.max.y);
    this.planes[3]!.set(new THREE.Vector3(0, 1, 0), -b.min.y);
    this.planes[4]!.set(new THREE.Vector3(0, 0, -1), b.max.z);
    this.planes[5]!.set(new THREE.Vector3(0, 0, 1), -b.min.z);
  }

  dispose(): void {
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.grips[0]?.geometry.dispose();
    this.gripMaterial.dispose();
    this.gripHoverMaterial.dispose();
  }
}
