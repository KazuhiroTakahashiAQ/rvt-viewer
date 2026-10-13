/*
 * Revit-style ViewCube in its own small canvas: faces, edges and corners
 * (26 directions) are clickable, dragging the cube orbits, and dragging the
 * compass ring turns the view about the vertical axis.
 *
 * Faces: 上 (+Y) 下 (−Y) 前 (+Z, south) 後 (−Z, north) 右 (+X, east) 左 (−X, west).
 */

import * as THREE from 'three';

export interface ViewCubeLabels {
  top: string;
  bottom: string;
  front: string;
  back: string;
  left: string;
  right: string;
  north: string;
  east: string;
  south: string;
  west: string;
}

export interface ViewCubeCallbacks {
  /** `dir` points from the model toward the eye (e.g. (0,1,0) = top view). */
  onPickDirection: (dir: THREE.Vector3) => void;
  onOrbit: (dYaw: number, dPitch: number) => void;
  onOrbitEnd: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
}

const ZONE = 0.55;
const DRAG_SLOP = 3;

export class ViewCube {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-2.1, 2.1, 2.1, -2.1, 0.1, 20);
  private readonly cube: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly highlight: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly textures: THREE.Texture[] = [];
  private dark = false;
  private drag: { x: number; y: number; moved: boolean; onRing: boolean; id: number } | null = null;
  private dirty = true;
  private enabled = true;

  constructor(
    private readonly size: number,
    labels: ViewCubeLabels,
    private readonly callbacks: ViewCubeCallbacks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewcube-canvas';
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(size, size, false);

    const faceOrder: (keyof ViewCubeLabels)[] = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    const materials = faceOrder.map((k) => {
      const tex = this.labelTexture(labels[k]);
      this.textures.push(tex);
      return new THREE.MeshBasicMaterial({ map: tex });
    });
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x8a8f96 }),
    );
    this.cube.add(edges);
    this.scene.add(this.cube);

    this.highlight = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.45, depthTest: false }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 5;
    this.scene.add(this.highlight);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.75, 2.05, 64),
      new THREE.MeshBasicMaterial({ color: 0xb9bec5, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = -1.15;
    this.scene.add(this.ring);
    const compass: [keyof ViewCubeLabels, number, number][] = [
      ['north', 0, -1.9],
      ['east', 1.9, 0],
      ['south', 0, 1.9],
      ['west', -1.9, 0],
    ];
    for (const [key, x, z] of compass) {
      const tex = this.letterTexture(labels[key]);
      this.textures.push(tex);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.scale.set(0.78, 0.78, 1);
      sprite.position.set(x, -1.15, z);
      sprite.renderOrder = 4;
      this.scene.add(sprite);
    }

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.canvas.style.display = enabled ? '' : 'none';
  }

  setDark(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    (this.ring.material as THREE.MeshBasicMaterial).color.set(dark ? 0x5b616a : 0xb9bec5);
    this.dirty = true;
    this.render();
  }

  /** Orients the cube like the main camera. */
  sync(orientation: THREE.Quaternion): void {
    this.camera.quaternion.copy(orientation);
    this.camera.position.set(0, 0, 8).applyQuaternion(orientation);
    this.camera.updateMatrixWorld(true);
    this.dirty = true;
    this.render();
  }

  render(): void {
    if (!this.dirty || !this.enabled) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    for (const t of this.textures) t.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) mat.dispose();
    });
    this.renderer.dispose();
  }

  // --- picking ------------------------------------------------------------

  private hit(ev: PointerEvent): { zone: THREE.Vector3 | null; onRing: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const cubeHit = this.raycaster.intersectObject(this.cube, false)[0];
    if (cubeHit) {
      const p = cubeHit.point;
      const zone = new THREE.Vector3(
        Math.abs(p.x) > ZONE ? Math.sign(p.x) : 0,
        Math.abs(p.y) > ZONE ? Math.sign(p.y) : 0,
        Math.abs(p.z) > ZONE ? Math.sign(p.z) : 0,
      );
      if (zone.lengthSq() > 0) return { zone, onRing: false };
    }
    const ringHit = this.raycaster.intersectObject(this.ring, false)[0];
    return { zone: null, onRing: !!ringHit };
  }

  private showZone(zone: THREE.Vector3 | null): void {
    if (!zone) {
      if (this.highlight.visible) {
        this.highlight.visible = false;
        this.dirty = true;
      }
      return;
    }
    const range = (s: number): [number, number] => (s === 0 ? [-ZONE, ZONE] : s > 0 ? [ZONE, 1.02] : [-1.02, -ZONE]);
    const [x0, x1] = range(zone.x);
    const [y0, y1] = range(zone.y);
    const [z0, z1] = range(zone.z);
    this.highlight.scale.set(x1 - x0, y1 - y0, z1 - z0);
    this.highlight.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.highlight.visible = true;
    this.dirty = true;
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const { onRing } = this.hit(ev);
    this.drag = { x: ev.clientX, y: ev.clientY, moved: false, onRing, id: ev.pointerId };
    this.canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const drag = this.drag;
    if (drag && drag.id === ev.pointerId) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      this.showZone(null);
      const k = Math.PI / this.size;
      this.callbacks.onOrbit(-dx * k, drag.onRing ? 0 : -dy * k);
      return;
    }
    this.showZone(this.hit(ev).zone);
    this.render();
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== ev.pointerId) return;
    this.drag = null;
    this.canvas.releasePointerCapture(ev.pointerId);
    if (drag.moved) {
      this.callbacks.onOrbitEnd();
      return;
    }
    const { zone } = this.hit(ev);
    if (zone) this.callbacks.onPickDirection(zone.clone().normalize());
  };

  private onPointerLeave = (): void => {
    if (this.drag) return;
    this.showZone(null);
    this.render();
  };

  private onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    this.callbacks.onContextMenu(ev.clientX, ev.clientY);
  };

  // --- textures -----------------------------------------------------------

  private labelTexture(text: string): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#fbfbfc');
    grad.addColorStop(1, '#dfe2e6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#3b4048';
    g.font = '600 44px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 64, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  private letterTexture(text: string): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#5b616a';
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '600 36px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
