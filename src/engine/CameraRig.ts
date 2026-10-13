/*
 * Camera pose as target + yaw/pitch + distance (Y-up, three.js frame where
 * X = east, -Z = north). Orientation is built from Euler YXZ, so straight
 * top/bottom views have no lookAt singularity and keep north up on screen.
 *
 *   yaw = 0, pitch = 0      → looking north (Revit "前" / south elevation)
 *   pitch = -π/2            → looking straight down (plan)
 */

import * as THREE from 'three';

export type Projection = 'ortho' | 'perspective';

export interface CameraPose {
  target: THREE.Vector3;
  yaw: number;
  pitch: number;
  distance: number;
  projection: Projection;
}

export interface SerializedPose {
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
  projection: Projection;
}

const FOV_DEG = 50;
const HALF_PI = Math.PI / 2;
const EPS = 1e-6;

export function clonePose(p: CameraPose): CameraPose {
  return { ...p, target: p.target.clone() };
}

export function serializePose(p: CameraPose): SerializedPose {
  return { target: p.target.toArray() as [number, number, number], yaw: p.yaw, pitch: p.pitch, distance: p.distance, projection: p.projection };
}

export function deserializePose(p: SerializedPose): CameraPose {
  return { ...p, target: new THREE.Vector3(...p.target) };
}

/** Yaw/pitch for a camera placed along `dir` (from the target toward the eye). */
export function anglesFromDirection(dir: THREE.Vector3): { yaw: number; pitch: number } {
  const d = dir.clone().normalize();
  const pitch = -Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  const horizontal = Math.hypot(d.x, d.z);
  const yaw = horizontal < EPS ? 0 : Math.atan2(d.x, d.z);
  return { yaw, pitch };
}

export class CameraRig {
  readonly perspective = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 1e6);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
  pose: CameraPose = {
    target: new THREE.Vector3(),
    yaw: Math.PI / 4,
    pitch: -Math.atan(1 / Math.SQRT2),
    distance: 50,
    projection: 'ortho',
  };
  /** Whether the pose may orbit (false for plans and elevations). */
  orbitEnabled = true;
  /** Scene bounds, used for near/far planes. */
  readonly bounds = new THREE.Sphere(new THREE.Vector3(), 50);
  private aspect = 1;
  private animation: { from: CameraPose; to: CameraPose; start: number; duration: number } | null = null;
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.pose.projection === 'ortho' ? this.ortho : this.perspective;
  }

  get fovRad(): number {
    return THREE.MathUtils.degToRad(FOV_DEG);
  }

  setAspect(aspect: number): void {
    this.aspect = Math.max(aspect, 1e-3);
    this.update();
  }

  get viewAspect(): number {
    return this.aspect;
  }

  /** Half the height of the view at the target, in world units. */
  get halfHeight(): number {
    return this.pose.distance * Math.tan(this.fovRad / 2);
  }

  orientation(out = new THREE.Quaternion()): THREE.Quaternion {
    this.euler.set(this.pose.pitch, this.pose.yaw, 0, 'YXZ');
    return out.setFromEuler(this.euler);
  }

  /** Unit vector from the target toward the eye. */
  backward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.orientation(this.quat));
  }

  update(): void {
    const q = this.orientation(this.quat);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const p = this.pose;

    const r = this.bounds.radius;

    this.perspective.aspect = this.aspect;
    this.perspective.position.copy(p.target).addScaledVector(back, p.distance);
    this.perspective.quaternion.copy(q);
    const eyeToCenter = this.perspective.position.distanceTo(this.bounds.center);
    const far = eyeToCenter + r + 1;
    this.perspective.far = far;
    this.perspective.near = eyeToCenter > r ? Math.max((eyeToCenter - r) * 0.5, far / 20000, 0.01) : Math.max(far / 20000, 0.01);
    this.perspective.updateProjectionMatrix();
    this.perspective.updateMatrixWorld(true);

    const h = this.halfHeight;
    this.ortho.left = -h * this.aspect;
    this.ortho.right = h * this.aspect;
    this.ortho.top = h;
    this.ortho.bottom = -h;
    // The ortho eye is pulled back far enough that the whole scene lies in
    // front of it, with a depth range just covering the scene.
    const eyeOffset = p.target.distanceTo(this.bounds.center) + r + 1;
    this.ortho.position.copy(p.target).addScaledVector(back, eyeOffset);
    this.ortho.quaternion.copy(q);
    this.ortho.near = 0.01;
    this.ortho.far = eyeOffset * 2 + 1;
    this.ortho.updateProjectionMatrix();
    this.ortho.updateMatrixWorld(true);
  }

  setPose(pose: CameraPose): void {
    this.animation = null;
    this.pose = clonePose(pose);
    this.pose.pitch = THREE.MathUtils.clamp(this.pose.pitch, -HALF_PI, HALF_PI);
    this.update();
  }

  animateTo(pose: CameraPose, duration = 350): void {
    const to = clonePose(pose);
    // Shortest way round for yaw.
    let dy = to.yaw - this.pose.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    to.yaw = this.pose.yaw + dy;
    this.animation = { from: clonePose(this.pose), to, start: performance.now(), duration };
  }

  get animating(): boolean {
    return this.animation !== null;
  }

  /** Advances an animation; returns true while it is running. */
  tick(now: number): boolean {
    const a = this.animation;
    if (!a) return false;
    const t = Math.min(1, (now - a.start) / a.duration);
    const k = 1 - Math.pow(1 - t, 3);
    this.pose.target.lerpVectors(a.from.target, a.to.target, k);
    this.pose.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k;
    this.pose.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
    this.pose.distance = Math.exp(Math.log(a.from.distance) + (Math.log(a.to.distance) - Math.log(a.from.distance)) * k);
    this.pose.projection = a.to.projection;
    if (t >= 1) this.animation = null;
    this.update();
    return true;
  }

  cancelAnimation(): void {
    this.animation = null;
  }

  /** Pose that frames `box` from the current (or given) direction. */
  framePose(box: THREE.Box3, angles?: { yaw: number; pitch: number }, margin = 1.15): CameraPose {
    const yaw = angles?.yaw ?? this.pose.yaw;
    const pitch = angles?.pitch ?? this.pose.pitch;
    const center = box.getCenter(new THREE.Vector3());
    // Fit the box's projection onto the view plane.
    this.euler.set(pitch, yaw, 0, 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(this.euler);
    const inv = q.clone().invert();
    const corners = boxCorners(box);
    let maxX = 0;
    let maxY = 0;
    for (const c of corners) {
      const local = c.sub(center).applyQuaternion(inv);
      maxX = Math.max(maxX, Math.abs(local.x));
      maxY = Math.max(maxY, Math.abs(local.y));
    }
    const half = Math.max(maxY, maxX / this.aspect, 0.25) * margin;
    let distance = half / Math.tan(this.fovRad / 2);
    if (this.pose.projection === 'perspective') {
      const size = box.getSize(new THREE.Vector3()).length();
      distance = Math.max(distance, size * 0.6);
    }
    return { target: center, yaw, pitch, distance, projection: this.pose.projection };
  }

  // --- interaction primitives -------------------------------------------

  /** World point on the plane through the target under NDC (x, y). */
  pointOnTargetPlane(ndcX: number, ndcY: number, out = new THREE.Vector3()): THREE.Vector3 {
    const cam = this.camera;
    const normal = this.backward();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.pose.target);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    if (!ray.ray.intersectPlane(plane, out)) out.copy(this.pose.target);
    return out;
  }

  /** Pans by a screen delta in pixels (content follows the cursor). */
  panPixels(dx: number, dy: number, viewportHeight: number): void {
    const worldPerPixel = (2 * this.halfHeight) / Math.max(viewportHeight, 1);
    const q = this.orientation(this.quat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.pose.target.addScaledVector(right, -dx * worldPerPixel).addScaledVector(up, dy * worldPerPixel);
    this.update();
  }

  /** Zooms by `factor` (<1 = in) keeping the world point under NDC fixed. */
  zoomAt(factor: number, ndcX: number, ndcY: number, minDistance = 0.05, maxDistance = 1e5): void {
    const before = this.pointOnTargetPlane(ndcX, ndcY);
    this.pose.distance = THREE.MathUtils.clamp(this.pose.distance * factor, minDistance, maxDistance);
    this.update();
    const after = this.pointOnTargetPlane(ndcX, ndcY);
    this.pose.target.add(before.sub(after));
    this.update();
  }

  /** Orbits around `pivot` by yaw/pitch deltas (radians). */
  orbit(dYaw: number, dPitch: number, pivot: THREE.Vector3): void {
    if (!this.orbitEnabled) return;
    const before = this.orientation(new THREE.Quaternion());
    this.pose.yaw += dYaw;
    this.pose.pitch = THREE.MathUtils.clamp(this.pose.pitch + dPitch, -HALF_PI, HALF_PI);
    const after = this.orientation(new THREE.Quaternion());
    const delta = after.multiply(before.invert());
    const offset = this.pose.target.clone().sub(pivot).applyQuaternion(delta);
    this.pose.target.copy(pivot).add(offset);
    this.update();
  }
}

export function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}
