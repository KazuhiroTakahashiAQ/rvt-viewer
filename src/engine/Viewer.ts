/*
 * The 3D/2D model canvas. One WebGL renderer serves every model view; the
 * active view's camera pose, clipping and display state are swapped in when
 * the view changes, so each view keeps its own state like Revit's.
 *
 * Mouse (Revit):  wheel = zoom at cursor, middle drag = pan,
 *                 Shift + middle drag = orbit, middle double-click = zoom to fit,
 *                 left click = select (Ctrl add, Shift remove),
 *                 left drag → right = window selection, ← left = crossing selection.
 * Touch:          one finger = orbit (pan in 2D views), two fingers = pan + pinch zoom.
 */

import * as THREE from 'three';
import type { CategoryKey } from '../model/categories';
import type { RefinePatch } from '../worker/protocol';
import { pickPriority } from '../model/categories';
import { CameraRig, type CameraPose, type Projection, anglesFromDirection, boxCorners, clonePose } from './CameraRig';
import { FLAG_HALFTONE, FLAG_HOVER, FLAG_REVEALED, FLAG_SELECTED, FLAG_VISIBLE } from './EntityState';
import { ModelMesh } from './ModelMesh';
import { type SharedUniforms, createEdgeMaterial, createFaceMaterial, createSharedUniforms, setVisualStyle } from './modelMaterials';
import { SectionBox } from './SectionBox';
import { type DisplayConfig, type ModelViewConfig, type NavMode, type SectionBoxState, type ThemeConfig, UNASSIGNED_LEVEL } from './types';
import { ViewCube, type ViewCubeLabels } from './ViewCube';

export interface SelectEvent {
  entity: number | null;
  mode: 'replace' | 'add' | 'remove';
}

export interface BoxSelectEvent {
  entities: number[];
  mode: 'replace' | 'add' | 'remove';
}

/** Per-entity lookups the viewer needs for display rules and picking. */
export interface EntityMeta {
  categoryOf: (entity: number) => CategoryKey | undefined;
  /** Storey index, or UNASSIGNED_LEVEL. */
  levelOf: (entity: number) => number;
}

export interface ViewerCallbacks {
  onSelect: (ev: SelectEvent) => void;
  onBoxSelect: (ev: BoxSelectEvent) => void;
  onHover: (entity: number | null, clientX: number, clientY: number) => void;
  onContextMenu: (clientX: number, clientY: number, entity: number | null) => void;
  onViewCubeMenu: (clientX: number, clientY: number) => void;
  onSectionBoxChange: (viewId: string, box: SectionBoxState) => void;
  onNavModeChange: (mode: NavMode) => void;
  /** The camera or what is shown changed and has stayed so for a moment. */
  onViewSettled?: () => void;
}

/** How long the view must stay put before `onViewSettled`, ms. */
const VIEW_SETTLE_MS = 250;
/** A wheel turn counts as moving the view for this long, ms. */
const WHEEL_ACTIVE_MS = 200;
/** Saved-mesh candidates smaller on screen than this, pixels, wait with those off screen. */
const MIN_PRIORITY_PIXELS = 3;

const CLICK_SLOP = 4;
const DOUBLE_MIDDLE_MS = 350;
const ORBIT_SPEED = Math.PI / 420;
const VIEWCUBE_SIZE = 116;
/** How far (world metres) the cut fill is pulled toward the viewer. */
const CUT_BIAS_METRES = 0.002;

interface ViewMemory {
  pose: CameraPose;
  home: CameraPose;
  history: CameraPose[];
}

type Drag =
  | { kind: 'pan'; id: number; x: number; y: number }
  | { kind: 'orbit'; id: number; x: number; y: number; pivot: THREE.Vector3 }
  | { kind: 'select'; id: number; x0: number; y0: number; x: number; y: number; moved: boolean; mode: SelectEvent['mode'] }
  | { kind: 'zoomRegion'; id: number; x0: number; y0: number; x: number; y: number }
  | { kind: 'grip'; id: number; face: number; x: number; y: number };

export class Viewer {
  readonly rig = new CameraRig();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly uniforms: SharedUniforms = createSharedUniforms();
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly sectionBox = new SectionBox();
  private readonly viewCube: ViewCube;
  private readonly overlay: HTMLDivElement;
  private readonly boxEl: HTMLDivElement;
  private readonly pivotEl: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();

  private model: ModelMesh | null = null;
  private categoryOf: (entity: number) => CategoryKey | undefined = () => undefined;
  private levelOf: (entity: number) => number = () => UNASSIGNED_LEVEL;
  private view: ModelViewConfig | null = null;
  private memory = new Map<string, ViewMemory>();
  private display: DisplayConfig | null = null;
  private planMask: Set<number> | null = null;
  private clipPlanes: THREE.Plane[] = [];
  private clipBox: THREE.Box3 | null = null;
  private selection = new Set<number>();
  private hover: number | null = null;
  private navMode: NavMode = 'select';
  private drag: Drag | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private touchGesture: { dist: number; cx: number; cy: number; moved: boolean } | null = null;
  private lastMiddleDown = 0;
  private hoverQueued: { x: number; y: number } | null = null;
  private dirty = true;
  private frame = 0;
  private lastWheel = 0;
  /** When the user last moved the view. */
  private lastActive = 0;
  private lastCamera = new THREE.Matrix4();
  private lastProjection = new THREE.Matrix4();
  /** When the view last changed, while `onViewSettled` is due. */
  private viewChangedAt: number | null = null;
  /** Patches are drawn one after another. */
  private patches: Promise<void> = Promise.resolve();
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    labels: ViewCubeLabels,
    private readonly callbacks: ViewerCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.className = 'viewer-canvas';
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'viewer-overlay';
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'box-select';
    this.boxEl.hidden = true;
    this.pivotEl = document.createElement('div');
    this.pivotEl.className = 'orbit-pivot';
    this.pivotEl.hidden = true;
    this.overlay.append(this.boxEl, this.pivotEl);
    container.appendChild(this.overlay);

    this.scene.add(this.hemi, this.sun, this.sun.target, this.sectionBox.root);

    this.viewCube = new ViewCube(VIEWCUBE_SIZE, labels, {
      onPickDirection: (dir) => this.lookFrom(dir),
      onOrbit: (dYaw, dPitch) => {
        this.rig.cancelAnimation();
        this.rig.orbit(dYaw, dPitch, this.orbitPivot(null));
        this.showPivot(this.orbitPivot(null));
        this.requestRender();
      },
      onOrbitEnd: () => this.hidePivot(),
      onContextMenu: (x, y) => this.callbacks.onViewCubeMenu(x, y),
    });
    this.viewCube.canvas.classList.add('viewcube');
    container.appendChild(this.viewCube.canvas);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('auxclick', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.warmUpPrograms();
    this.loop();
  }

  /** Kept so that the programs they compiled stay (three.js frees a program with its last material). */
  private warmUp: { dispose(): void }[] = [];

  /**
   * Compile the model's shaders in the background (KHR_parallel_shader_compile)
   * before anything is drawn with them: merged and instanced faces and edges.
   * Compiling at the first draw stops the page for a moment.
   */
  private warmUpPrograms(): void {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute('aEntity', new THREE.Float32BufferAttribute([0, 0, 0], 1));
    const instanced = new THREE.BufferGeometry();
    instanced.setAttribute('position', geometry.getAttribute('position'));
    instanced.setAttribute('aEntity', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    const lines = new THREE.InstancedBufferGeometry();
    lines.setAttribute('position', geometry.getAttribute('position'));
    lines.setAttribute('aEntity', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    lines.setAttribute('instanceMatrix', new THREE.InstancedBufferAttribute(new THREE.Matrix4().toArray(new Float32Array(16)), 16));
    const color = new THREE.Color(0x808080);
    const materials = [
      createFaceMaterial(this.uniforms, color, 1, 0),
      createFaceMaterial(this.uniforms, color, 1, 1),
      createEdgeMaterial(this.uniforms),
      createFaceMaterial(this.uniforms, color, 1, 0),
      createFaceMaterial(this.uniforms, color, 1, 1),
      createEdgeMaterial(this.uniforms, true),
    ];
    scene.add(
      new THREE.Mesh(geometry, materials[0]),
      new THREE.Mesh(geometry, materials[1]),
      new THREE.LineSegments(geometry, materials[2]),
      new THREE.InstancedMesh(instanced, materials[3], 1),
      new THREE.InstancedMesh(instanced, materials[4], 1),
      new THREE.LineSegments(lines, materials[5]),
    );
    this.warmUp = [geometry, instanced, lines, ...materials];
    void this.renderer.compileAsync(scene, this.rig.camera, this.scene).catch(() => {});
  }

  // --- model ------------------------------------------------------------

  async loadModel(
    glb: Uint8Array,
    entityCount: number,
    meta: EntityMeta,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const mesh = await ModelMesh.fromGlb(glb, entityCount, this.uniforms, onProgress);
    if (this.disposed) {
      mesh.dispose();
      return;
    }
    this.setModel(mesh, meta);
  }

  setModel(model: ModelMesh | null, meta: EntityMeta): void {
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.model = model;
    this.categoryOf = meta.categoryOf;
    this.levelOf = meta.levelOf;
    this.memory.clear();
    this.selection.clear();
    this.hover = null;
    if (model) {
      this.scene.add(model.root);
      this.uniforms.uRvtState.value = model.state.state;
      this.uniforms.uRvtOverride.value = model.state.override;
      const sphere = model.box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 10) : model.box.getBoundingSphere(new THREE.Sphere());
      this.rig.bounds.copy(sphere);
    }
    this.view = null;
    this.requestRender();
  }

  /**
   * Draw `patch`'s bodies in place of their entities' boxes (the saved-mesh
   * pass), after the patches before it and while the view is still: the
   * view, camera, selection and display settings stay as they are.
   */
  applyPatch(patch: RefinePatch): Promise<void> {
    // The patch belongs to the model shown now, not to one opened before it is drawn.
    const model = this.model;
    const run = async () => {
      if (!model || this.model !== model || this.disposed) return;
      await this.whenIdle();
      await model.applyPatch(patch, this.uniforms, () => this.whenIdle());
      if (this.model !== model) return;
      this.afterGeometryChange();
    };
    this.patches = this.patches.then(run, run);
    return this.patches;
  }

  /** The last patch has come: merge what is left of them. */
  finishPatches(): Promise<void> {
    const model = this.model;
    const run = async () => {
      if (!model || this.model !== model || this.disposed) return;
      await model.compactPatches(this.uniforms, () => this.whenIdle());
      if (this.model === model) this.afterGeometryChange();
    };
    this.patches = this.patches.then(run, run);
    return this.patches;
  }

  private afterGeometryChange(): void {
    // The entities stay the same, and so do their hover and selection.
    // New materials need the cut planes; plan ranges go by element boxes.
    this.applyClipPlanesToMaterials();
    if (this.view?.kind === 'plan') {
      this.computePlanMask();
      if (this.display) this.applyDisplay(this.display);
    }
    this.requestRender();
  }

  /** Whether the user is moving the view: dragging, touching, turning the wheel. */
  get interacting(): boolean {
    return (
      this.drag !== null || this.touches.size > 0 || performance.now() - this.lastWheel < WHEEL_ACTIVE_MS || this.rig.animating
    );
  }

  /** Resolves once the user is not moving the view. */
  whenIdle(): Promise<void> {
    if (!this.interacting || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.interacting && !this.disposed) requestAnimationFrame(check);
        else resolve();
      };
      requestAnimationFrame(check);
    });
  }

  /**
   * Resolves once the user has left the view alone for `ms` (never while
   * the page is hidden: animation frames stop).
   */
  whenIdleFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed || (!this.interacting && performance.now() - this.lastActive >= ms)) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  /**
   * `candidates` in the order to draw their saved meshes: first those on
   * screen (shown, in the view and its clip box, a few pixels or more),
   * larger on screen first; then the others, by `groupOf` (instances of one
   * family type draw the same symbols, which a batch reads once), larger
   * first. `visible` counts the first.
   */
  refineOrder(candidates: Iterable<number>, groupOf: (entity: number) => string): { order: Uint32Array; visible: number } {
    const model = this.model;
    const list = [...candidates];
    if (!model) return { order: Uint32Array.from(list), visible: 0 };
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    const perspective = this.rig.pose.projection === 'perspective';
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const halfHeight = Math.max(this.rig.halfHeight, 1e-6);
    const tanHalfFov = perspective ? Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov / 2)) : 1;
    const pixelsPerUnit = this.height / 2;
    const center = new THREE.Vector3();
    const shown: { entity: number; size: number }[] = [];
    const rest: { entity: number; size: number; group: string }[] = [];
    for (const entity of list) {
      const box = model.entityBoxes.get(entity);
      if (!box || box.isEmpty()) {
        rest.push({ entity, size: 0, group: groupOf(entity) });
        continue;
      }
      box.getCenter(center);
      const radius = box.min.distanceTo(box.max) / 2;
      // Share of the screen's half height the box's bounding sphere spans.
      const size = perspective ? radius / (Math.max(center.distanceTo(eye), radius, 1e-6) * tanHalfFov) : radius / halfHeight;
      const onScreen =
        model.state.isVisible(entity) &&
        frustum.intersectsBox(box) &&
        (!this.clipBox || this.clipBox.intersectsBox(box)) &&
        size * pixelsPerUnit >= MIN_PRIORITY_PIXELS;
      if (onScreen) shown.push({ entity, size });
      else rest.push({ entity, size, group: groupOf(entity) });
    }
    shown.sort((a, b) => b.size - a.size);
    rest.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : b.size - a.size));
    const order = new Uint32Array(list.length);
    let k = 0;
    for (const c of shown) order[k++] = c.entity;
    for (const c of rest) order[k++] = c.entity;
    return { order, visible: shown.length };
  }

  get modelBox(): THREE.Box3 | null {
    return this.model && !this.model.box.isEmpty() ? this.model.box.clone() : null;
  }

  entityBox(entity: number): THREE.Box3 | null {
    return this.model?.entityBoxes.get(entity)?.clone() ?? null;
  }

  // --- views ------------------------------------------------------------

  setView(config: ModelViewConfig): void {
    const prev = this.view;
    if (prev && this.memory.has(prev.id)) this.memory.get(prev.id)!.pose = clonePose(this.rig.pose);
    const switching = prev?.id !== config.id;
    this.view = config;

    this.rig.orbitEnabled = config.kind === '3d';
    this.viewCube.setEnabled(config.kind === '3d');
    setVisualStyle(this.uniforms, config.visualStyle);
    this.computePlanMask();
    this.updateClipping();

    let mem = this.memory.get(config.id);
    if (!mem) {
      const home = this.defaultPose(config);
      mem = { pose: clonePose(home), home, history: [] };
      this.memory.set(config.id, mem);
    }
    if (switching) {
      this.rig.setPose(mem.pose);
    }
    if (config.kind === '3d' && this.rig.pose.projection !== config.projection) {
      this.setProjectionInternal(config.projection);
    }
    if (this.display) this.applyDisplay(this.display);
    this.viewCube.sync(this.rig.orientation());
    this.requestRender();
  }

  /** Camera pose of the active view (for persistence). */
  get pose(): CameraPose {
    return clonePose(this.rig.pose);
  }

  private defaultPose(config: ModelViewConfig): CameraPose {
    const box = this.focusBox(config);
    const prevProjection = this.rig.pose.projection;
    this.rig.pose.projection = config.kind === '3d' ? config.projection : 'ortho';
    let angles: { yaw: number; pitch: number };
    switch (config.kind) {
      case 'plan':
        angles = { yaw: 0, pitch: -Math.PI / 2 };
        break;
      case 'elevation':
        angles = { yaw: { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 }[config.direction ?? 'south'], pitch: 0 };
        break;
      default:
        angles = { yaw: Math.PI / 4, pitch: -Math.atan(1 / Math.SQRT2) };
    }
    const pose = this.rig.framePose(box, angles, config.kind === '3d' ? 1.1 : 1.08);
    this.rig.pose.projection = prevProjection;
    return pose;
  }

  private focusBox(config: ModelViewConfig): THREE.Box3 {
    const model = this.model;
    const box = new THREE.Box3();
    if (!model || model.box.isEmpty()) return new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    if (config.kind === 'plan' && this.planMask && this.planMask.size > 0) {
      for (const e of this.planMask) {
        const b = model.entityBoxes.get(e);
        if (b) box.union(b);
      }
      if (this.clipBox) box.intersect(this.clipBox);
      if (!box.isEmpty()) return box;
    }
    return model.box.clone();
  }

  private computePlanMask(): void {
    const view = this.view;
    const model = this.model;
    this.planMask = null;
    if (!view || !model || view.kind !== 'plan' || view.levelElevation === undefined) return;
    const level = view.levelElevation;
    const cut = level + (view.planRange?.cutMm ?? 1200) / 1000;
    const bottom = level + (view.planRange?.bottomMm ?? 0) / 1000;
    const mask = new Set<number>();
    for (const [entity, b] of model.entityBoxes) {
      const cat = this.categoryOf(entity);
      const floorLike = cat === 'floors' || cat === 'rooms' || cat === 'ceilings' || cat === 'roofs';
      const spans = b.max.y > bottom + 0.02 && b.min.y < cut;
      const atLevel = floorLike && Math.abs(b.max.y - level) < 0.06;
      if (spans || atLevel) mask.add(entity);
    }
    this.planMask = mask;
  }

  private updateClipping(): void {
    const view = this.view;
    const planes: THREE.Plane[] = [];
    this.clipBox = null;
    this.sectionBox.visible = false;
    if (view?.kind === 'plan' && view.levelElevation !== undefined) {
      const level = view.levelElevation;
      const cut = level + (view.planRange?.cutMm ?? 1200) / 1000;
      const bottom = level + Math.min(view.planRange?.bottomMm ?? 0, 0) / 1000 - 0.06;
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), cut), new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottom));
      this.clipBox = new THREE.Box3(new THREE.Vector3(-Infinity, bottom, -Infinity), new THREE.Vector3(Infinity, cut, Infinity));
    } else if (view?.kind === '3d' && view.sectionBox?.enabled) {
      const sb = view.sectionBox;
      const box =
        sb.min && sb.max
          ? new THREE.Box3(new THREE.Vector3(...sb.min), new THREE.Vector3(...sb.max))
          : (this.modelBox?.expandByScalar(0.3) ?? new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10)));
      this.sectionBox.setBox(box);
      this.sectionBox.visible = true;
      planes.push(...this.sectionBox.planes);
      this.clipBox = box.clone();
    }
    this.clipPlanes = planes;
    this.uniforms.uRvtCutFill.value = planes.length > 0;
    this.applyClipPlanesToMaterials();
  }

  private applyClipPlanesToMaterials(): void {
    if (!this.model) return;
    const cut = this.clipPlanes.length > 0;
    this.model.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const before = m.clippingPlanes?.length ?? 0;
        m.clippingPlanes = cut ? this.clipPlanes : null;
        const hadCut = !!m.defines && 'RVT_CUT' in m.defines;
        if (cut) m.defines = { ...m.defines, RVT_CUT: '' };
        else if (m.defines) delete m.defines.RVT_CUT;
        if (before !== this.clipPlanes.length || hadCut !== cut) m.needsUpdate = true;
      }
    });
  }

  // --- display state ----------------------------------------------------

  applyDisplay(display: DisplayConfig): void {
    this.display = display;
    const model = this.model;
    if (!model) return;
    const state = model.state;
    for (const entity of model.entityBoxes.keys()) {
      const cat = this.categoryOf(entity);
      const ov = cat ? display.overrides[cat] : undefined;
      let hiddenByUser =
        (cat !== undefined && display.hiddenCategories.has(cat)) ||
        display.hiddenElements.has(entity) ||
        display.hiddenLevels.has(this.levelOf(entity));
      if (display.tempMode === 'hide' && display.tempElements.has(entity)) hiddenByUser = true;
      if (display.tempMode === 'isolate' && !display.tempElements.has(entity)) hiddenByUser = true;
      const outOfRange = this.planMask !== null && !this.planMask.has(entity);

      let flags = 0;
      if (!outOfRange) {
        if (!hiddenByUser) flags |= FLAG_VISIBLE;
        else if (display.reveal) flags |= FLAG_VISIBLE | FLAG_REVEALED;
      }
      if (ov?.halftone || (display.reveal && !hiddenByUser)) flags |= FLAG_HALFTONE;
      if (this.selection.has(entity)) flags |= FLAG_SELECTED;
      if (this.hover === entity) flags |= FLAG_HOVER;
      state.setFlags(entity, flags);
      state.setOpacity(entity, ov?.transparency !== undefined && ov.transparency > 0 ? 1 - ov.transparency / 100 : null);
      state.setColor(entity, ov?.color ? new THREE.Color(ov.color) : null);
    }
    state.commit();
    this.viewChanged();
    this.requestRender();
  }

  setSelection(entities: Iterable<number>): void {
    const next = new Set(entities);
    const model = this.model;
    if (model) {
      for (const e of this.selection) if (!next.has(e)) model.state.setFlags(e, model.state.flags(e) & ~FLAG_SELECTED);
      for (const e of next) model.state.setFlags(e, model.state.flags(e) | FLAG_SELECTED);
      model.state.commit();
    }
    this.selection = next;
    this.requestRender();
  }

  private setHover(entity: number | null): void {
    if (entity === this.hover) return;
    const model = this.model;
    if (model) {
      if (this.hover !== null) model.state.setFlags(this.hover, model.state.flags(this.hover) & ~FLAG_HOVER);
      if (entity !== null) model.state.setFlags(entity, model.state.flags(entity) | FLAG_HOVER);
      model.state.commit();
    }
    this.hover = entity;
    this.requestRender();
  }

  /** Entities currently drawn (visible and in the view range). */
  visibleEntities(): number[] {
    const model = this.model;
    if (!model) return [];
    return model.drawnEntities.filter((e) => (model.state.flags(e) & FLAG_VISIBLE) !== 0 && (model.state.flags(e) & FLAG_REVEALED) === 0);
  }

  setTheme(theme: ThemeConfig): void {
    this.renderer.setClearColor(new THREE.Color(theme.background), 1);
    this.uniforms.uRvtEdge.value.set(theme.dark ? 0xe6e6e6 : 0x000000);
    this.uniforms.uRvtCut.value.set(theme.dark ? 0x9a9a9a : 0x4a4a4a);
    this.viewCube.setDark(theme.dark);
    this.requestRender();
  }

  setViewCubeVisible(visible: boolean): void {
    this.viewCube.canvas.hidden = !visible;
  }

  // --- navigation commands ---------------------------------------------

  setNavMode(mode: NavMode): void {
    if (this.navMode === mode) return;
    this.navMode = mode;
    this.renderer.domElement.dataset.nav = mode;
    this.callbacks.onNavModeChange(mode);
  }

  private remember(): void {
    const mem = this.view ? this.memory.get(this.view.id) : undefined;
    if (!mem) return;
    mem.history.push(clonePose(this.rig.pose));
    if (mem.history.length > 50) mem.history.shift();
  }

  zoomExtents(): void {
    if (!this.view) return;
    this.remember();
    const box = this.clipBox && this.view.kind === '3d' ? this.clipBox.clone() : this.focusBox(this.view);
    if (this.view.kind !== 'plan' && this.clipBox && this.model) box.intersect(this.model.box);
    this.rig.animateTo(this.rig.framePose(box.isEmpty() ? this.focusBox(this.view) : box));
    this.requestRender();
  }

  zoomToEntities(entities: Iterable<number>): void {
    const box = new THREE.Box3();
    for (const e of entities) {
      const b = this.model?.entityBoxes.get(e);
      if (b) box.union(b);
    }
    if (box.isEmpty()) return;
    if (this.clipBox) {
      const clipped = box.clone().intersect(this.clipBox);
      if (!clipped.isEmpty()) box.copy(clipped);
    }
    this.remember();
    this.rig.animateTo(this.rig.framePose(box, undefined, 1.6));
    this.requestRender();
  }

  zoomOut(): void {
    this.remember();
    const pose = clonePose(this.rig.pose);
    pose.distance *= 2;
    this.rig.animateTo(pose);
    this.requestRender();
  }

  zoomPrevious(): boolean {
    const mem = this.view ? this.memory.get(this.view.id) : undefined;
    const pose = mem?.history.pop();
    if (!pose) return false;
    this.rig.animateTo(pose);
    this.requestRender();
    return true;
  }

  goHome(): void {
    const mem = this.view ? this.memory.get(this.view.id) : undefined;
    if (!mem) return;
    this.remember();
    const home = clonePose(mem.home);
    home.projection = this.rig.pose.projection;
    this.rig.animateTo(home);
    this.requestRender();
  }

  setCurrentAsHome(): void {
    const mem = this.view ? this.memory.get(this.view.id) : undefined;
    if (mem) mem.home = clonePose(this.rig.pose);
  }

  setProjection(projection: Projection): void {
    if (this.view?.kind !== '3d') return;
    this.view = { ...this.view, projection };
    this.setProjectionInternal(projection);
  }

  private setProjectionInternal(projection: Projection): void {
    this.rig.pose.projection = projection;
    this.rig.update();
    this.requestRender();
  }

  /** Animates to a view from `dir` (model → eye), framing the model. */
  lookFrom(dir: THREE.Vector3): void {
    if (!this.view || this.view.kind !== '3d') return;
    this.remember();
    const angles = anglesFromDirection(dir);
    const box = this.clipBox ? this.clipBox.clone() : this.focusBox(this.view);
    if (this.model && this.clipBox) box.intersect(this.model.box);
    this.rig.animateTo(this.rig.framePose(box.isEmpty() ? this.focusBox(this.view) : box, angles));
    this.requestRender();
  }

  /** Section box around the given entities (Revit "選択ボックス"). */
  sectionBoxAround(entities: Iterable<number>): SectionBoxState | null {
    const box = new THREE.Box3();
    for (const e of entities) {
      const b = this.model?.entityBoxes.get(e);
      if (b) box.union(b);
    }
    if (box.isEmpty()) return null;
    box.expandByScalar(0.3);
    return { enabled: true, min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number] };
  }

  // --- rendering --------------------------------------------------------

  requestRender(): void {
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.rig.tick(now)) this.dirty = true;
    if (this.interacting) this.lastActive = now;
    if (this.viewChangedAt !== null && now - this.viewChangedAt > VIEW_SETTLE_MS && !this.interacting) {
      this.viewChangedAt = null;
      this.callbacks.onViewSettled?.();
    }
    if (this.hoverQueued) {
      const { x, y } = this.hoverQueued;
      this.hoverQueued = null;
      this.updateHover(x, y);
    }
    if (!this.dirty) return;
    this.dirty = false;
    const cam = this.rig.camera;
    // Key light from the upper left of the viewer, so shading reads the same
    // from every direction.
    const q = this.rig.orientation();
    this.sun.position.copy(this.rig.pose.target).add(new THREE.Vector3(-0.6, 1.2, 1).applyQuaternion(q).multiplyScalar(100));
    this.sun.target.position.copy(this.rig.pose.target);
    this.sun.target.updateMatrixWorld();
    this.sectionBox.updateScale(this.worldPerPixel());
    this.uniforms.uRvtCutBias.value = this.cutBias();
    this.renderer.render(this.scene, cam);
    this.viewCube.sync(q);
    if (!cam.matrixWorld.equals(this.lastCamera) || !cam.projectionMatrix.equals(this.lastProjection)) {
      this.lastCamera.copy(cam.matrixWorld);
      this.lastProjection.copy(cam.projectionMatrix);
      this.viewChanged();
    }
  };

  /** What is on screen changed: tell `onViewSettled` once it stays. */
  private viewChanged(): void {
    this.viewChangedAt = performance.now();
  }

  /** CUT_BIAS_METRES expressed as a window-space depth offset for the active camera. */
  private cutBias(): number {
    const cam = this.rig.camera;
    const range = Math.max(cam.far - cam.near, 1e-6);
    if (this.rig.pose.projection === 'ortho') return CUT_BIAS_METRES / range;
    // Perspective depth is z_w = f(n-d)… ; its slope at the target distance d
    // is f·n / (d²·(f−n)).
    const d = Math.max(this.rig.pose.distance, cam.near);
    return (CUT_BIAS_METRES * cam.far * cam.near) / (d * d * range);
  }

  private worldPerPixel(): number {
    return (2 * this.rig.halfHeight) / Math.max(this.height, 1);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
    this.requestRender();
  }

  // --- picking ----------------------------------------------------------

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private castRay(clientX: number, clientY: number): THREE.Raycaster {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.rig.camera);
    return this.raycaster;
  }

  /** Entity under the cursor (rooms only when nothing else is hit). */
  pick(clientX: number, clientY: number): { entity: number; point: THREE.Vector3 } | null {
    if (!this.model) return null;
    const hits = this.model.raycast(this.castRay(clientX, clientY), this.clipPlanes);
    if (hits.length === 0) return null;
    let best = hits[0]!;
    let bestPriority = this.priority(best.entity);
    for (const h of hits) {
      const p = this.priority(h.entity);
      if (p < bestPriority) {
        best = h;
        bestPriority = p;
      }
    }
    return { entity: best.entity, point: best.point };
  }

  private priority(entity: number): number {
    const cat = this.categoryOf(entity);
    return cat ? pickPriority(cat) : 0;
  }

  private updateHover(clientX: number, clientY: number): void {
    if (this.drag || this.touches.size > 0) return;
    const grip = this.sectionBox.pickGrip(this.castRay(clientX, clientY));
    if (this.sectionBox.setHoveredGrip(grip)) this.requestRender();
    if (grip !== null) {
      this.renderer.domElement.dataset.cursor = 'grip';
      this.setHover(null);
      this.callbacks.onHover(null, clientX, clientY);
      return;
    }
    delete this.renderer.domElement.dataset.cursor;
    const hit = this.navMode === 'select' ? this.pick(clientX, clientY) : null;
    const entity = hit?.entity ?? null;
    if (entity !== this.hover) {
      this.setHover(entity);
    }
    this.callbacks.onHover(entity, clientX, clientY);
  }

  private orbitPivot(clientPos: { x: number; y: number } | null): THREE.Vector3 {
    if (this.selection.size > 0 && this.model) {
      const box = new THREE.Box3();
      for (const e of this.selection) {
        const b = this.model.entityBoxes.get(e);
        if (b) box.union(b);
      }
      if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
    }
    if (clientPos) {
      const hit = this.pick(clientPos.x, clientPos.y);
      if (hit) return hit.point;
    }
    if (this.model && !this.model.box.isEmpty()) {
      const box = this.clipBox ? this.model.box.clone().intersect(this.clipBox) : this.model.box;
      if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
    }
    return this.rig.pose.target.clone();
  }

  private showPivot(p: THREE.Vector3): void {
    const v = p.clone().project(this.rig.camera);
    this.pivotEl.hidden = false;
    this.pivotEl.style.left = `${((v.x + 1) / 2) * this.width}px`;
    this.pivotEl.style.top = `${((1 - v.y) / 2) * this.height}px`;
  }

  private hidePivot(): void {
    this.pivotEl.hidden = true;
  }

  // --- box selection ----------------------------------------------------

  private entitiesInRect(x0: number, y0: number, x1: number, y1: number, crossing: boolean): number[] {
    const model = this.model;
    if (!model) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    const minX = Math.min(x0, x1) - rect.left;
    const maxX = Math.max(x0, x1) - rect.left;
    const minY = Math.min(y0, y1) - rect.top;
    const maxY = Math.max(y0, y1) - rect.top;
    const cam = this.rig.camera;
    const out: number[] = [];
    const v = new THREE.Vector3();
    for (const [entity, b] of model.entityBoxes) {
      const flags = model.state.flags(entity);
      if ((flags & FLAG_VISIBLE) === 0 || (flags & FLAG_REVEALED) !== 0) continue;
      const box = this.clipBox ? b.clone().intersect(this.clipBox) : b;
      if (box.isEmpty()) continue;
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      for (const c of boxCorners(box)) {
        v.copy(c).project(cam);
        const sx = ((v.x + 1) / 2) * this.width;
        const sy = ((1 - v.y) / 2) * this.height;
        sx0 = Math.min(sx0, sx);
        sy0 = Math.min(sy0, sy);
        sx1 = Math.max(sx1, sx);
        sy1 = Math.max(sy1, sy);
      }
      const inside = sx0 >= minX && sx1 <= maxX && sy0 >= minY && sy1 <= maxY;
      const touches = sx1 >= minX && sx0 <= maxX && sy1 >= minY && sy0 <= maxY;
      if (inside || (crossing && touches)) out.push(entity);
    }
    return out;
  }

  private drawRect(x0: number, y0: number, x1: number, y1: number, crossing: boolean | null): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.boxEl.hidden = false;
    this.boxEl.classList.toggle('crossing', crossing === true);
    this.boxEl.classList.toggle('zoom', crossing === null);
    this.boxEl.style.left = `${Math.min(x0, x1) - rect.left}px`;
    this.boxEl.style.top = `${Math.min(y0, y1) - rect.top}px`;
    this.boxEl.style.width = `${Math.abs(x1 - x0)}px`;
    this.boxEl.style.height = `${Math.abs(y1 - y0)}px`;
  }

  // --- pointer handling -------------------------------------------------

  private selectMode(ev: PointerEvent | MouseEvent): SelectEvent['mode'] {
    if (ev.ctrlKey || ev.metaKey) return 'add';
    if (ev.shiftKey) return 'remove';
    return 'replace';
  }

  private onPointerDown = (ev: PointerEvent): void => {
    const el = this.renderer.domElement;
    el.focus({ preventScroll: true });
    this.rig.cancelAnimation();
    if (ev.pointerType === 'touch') {
      this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      el.setPointerCapture(ev.pointerId);
      this.setHover(null);
      this.beginTouchGesture();
      return;
    }
    if (this.drag) return;
    if (ev.button === 1) {
      ev.preventDefault();
      const now = performance.now();
      if (now - this.lastMiddleDown < DOUBLE_MIDDLE_MS) {
        this.lastMiddleDown = 0;
        this.zoomExtents();
        return;
      }
      this.lastMiddleDown = now;
      this.startNavDrag(ev, ev.shiftKey && this.rig.orbitEnabled ? 'orbit' : 'pan');
      return;
    }
    if (ev.button !== 0) return;
    const grip = this.sectionBox.pickGrip(this.castRay(ev.clientX, ev.clientY));
    if (grip !== null) {
      this.drag = { kind: 'grip', id: ev.pointerId, face: grip, x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
      return;
    }
    if (this.navMode === 'pan' || (this.navMode === 'orbit' && !this.rig.orbitEnabled)) {
      this.startNavDrag(ev, 'pan');
      return;
    }
    if (this.navMode === 'orbit') {
      this.startNavDrag(ev, 'orbit');
      return;
    }
    if (this.navMode === 'zoomRegion') {
      this.drag = { kind: 'zoomRegion', id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
      return;
    }
    this.drag = {
      kind: 'select',
      id: ev.pointerId,
      x0: ev.clientX,
      y0: ev.clientY,
      x: ev.clientX,
      y: ev.clientY,
      moved: false,
      mode: this.selectMode(ev),
    };
    el.setPointerCapture(ev.pointerId);
  };

  private startNavDrag(ev: PointerEvent, kind: 'pan' | 'orbit'): void {
    this.renderer.domElement.setPointerCapture(ev.pointerId);
    this.setHover(null);
    this.callbacks.onHover(null, ev.clientX, ev.clientY);
    if (kind === 'orbit') {
      const pivot = this.orbitPivot({ x: ev.clientX, y: ev.clientY });
      this.drag = { kind: 'orbit', id: ev.pointerId, x: ev.clientX, y: ev.clientY, pivot };
      this.showPivot(pivot);
    } else {
      this.drag = { kind: 'pan', id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    }
    this.renderer.domElement.dataset.dragging = kind;
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch') {
      if (this.touches.has(ev.pointerId)) {
        this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        this.updateTouchGesture();
      }
      return;
    }
    const drag = this.drag;
    if (!drag) {
      this.hoverQueued = { x: ev.clientX, y: ev.clientY };
      return;
    }
    if (drag.id !== ev.pointerId) return;
    switch (drag.kind) {
      case 'pan': {
        this.rig.panPixels(ev.clientX - drag.x, ev.clientY - drag.y, this.height);
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        this.requestRender();
        break;
      }
      case 'orbit': {
        this.rig.orbit(-(ev.clientX - drag.x) * ORBIT_SPEED, -(ev.clientY - drag.y) * ORBIT_SPEED, drag.pivot);
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        this.showPivot(drag.pivot);
        this.requestRender();
        break;
      }
      case 'select': {
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        if (!drag.moved && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > CLICK_SLOP) {
          drag.moved = true;
          this.setHover(null);
        }
        if (drag.moved) this.drawRect(drag.x0, drag.y0, drag.x, drag.y, drag.x < drag.x0);
        break;
      }
      case 'zoomRegion': {
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        this.drawRect(drag.x0, drag.y0, drag.x, drag.y, null);
        break;
      }
      case 'grip': {
        const center = this.sectionBox.faceCenter(drag.face);
        const axis = this.sectionBox.faceAxis(drag.face);
        const cam = this.rig.camera;
        const a = center.clone().project(cam);
        const b = center.clone().add(axis).project(cam);
        const ax = ((b.x - a.x) / 2) * this.width;
        const ay = (-(b.y - a.y) / 2) * this.height;
        const len2 = ax * ax + ay * ay;
        if (len2 > 1e-6) {
          const mx = ev.clientX - drag.x;
          const my = ev.clientY - drag.y;
          this.sectionBox.moveFace(drag.face, (mx * ax + my * ay) / len2);
          this.clipBox = this.sectionBox.box.clone();
          this.requestRender();
        }
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        break;
      }
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const el = this.renderer.domElement;
    if (ev.pointerType === 'touch') {
      this.endTouch(ev);
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== ev.pointerId) return;
    this.drag = null;
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    delete el.dataset.dragging;
    this.boxEl.hidden = true;
    this.hidePivot();
    switch (drag.kind) {
      case 'select': {
        if (!drag.moved) {
          const hit = this.pick(ev.clientX, ev.clientY);
          this.callbacks.onSelect({ entity: hit?.entity ?? null, mode: drag.mode });
        } else {
          const crossing = drag.x < drag.x0;
          const entities = this.entitiesInRect(drag.x0, drag.y0, drag.x, drag.y, crossing);
          this.callbacks.onBoxSelect({ entities, mode: drag.mode });
        }
        break;
      }
      case 'zoomRegion': {
        this.zoomToRect(drag.x0, drag.y0, drag.x, drag.y);
        this.setNavMode('select');
        break;
      }
      case 'grip': {
        if (this.view) {
          const b = this.sectionBox.box;
          this.view = { ...this.view, sectionBox: { enabled: true, min: b.min.toArray() as [number, number, number], max: b.max.toArray() as [number, number, number] } };
          this.callbacks.onSectionBoxChange(this.view.id, this.view.sectionBox!);
        }
        break;
      }
      default:
        break;
    }
  };

  private onPointerLeave = (ev: PointerEvent): void => {
    if (this.drag || ev.pointerType === 'touch') return;
    this.hoverQueued = null;
    this.setHover(null);
    this.callbacks.onHover(null, ev.clientX, ev.clientY);
  };

  private zoomToRect(x0: number, y0: number, x1: number, y1: number): void {
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w < 8 || h < 8) return;
    this.remember();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const ndc = this.ndc(cx, cy);
    const center = this.rig.pointOnTargetPlane(ndc.x, ndc.y);
    const factor = Math.max(w / rect.width, h / rect.height);
    const pose = clonePose(this.rig.pose);
    pose.target.copy(center);
    pose.distance *= factor;
    this.rig.animateTo(pose, 250);
    this.requestRender();
  }

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.lastWheel = performance.now();
    this.rig.cancelAnimation();
    let delta = ev.deltaY;
    if (ev.deltaMode === 1) delta *= 33;
    else if (ev.deltaMode === 2) delta *= this.height;
    // Pinch on trackpads arrives as ctrl+wheel with small deltas.
    const k = ev.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(THREE.MathUtils.clamp(delta, -400, 400) * k);
    const ndc = this.ndc(ev.clientX, ev.clientY);
    this.rig.zoomAt(factor, ndc.x, ndc.y);
    this.requestRender();
  };

  private onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.navMode !== 'select') {
      this.setNavMode('select');
      return;
    }
    const hit = this.pick(ev.clientX, ev.clientY);
    this.callbacks.onContextMenu(ev.clientX, ev.clientY, hit?.entity ?? null);
  };

  // --- touch --------------------------------------------------------------

  private touchCentroid(): { cx: number; cy: number; dist: number } {
    const pts = [...this.touches.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
    return { cx, cy, dist };
  }

  private touchStart: { x: number; y: number; t: number } | null = null;

  private beginTouchGesture(): void {
    const c = this.touchCentroid();
    const moved = this.touchGesture?.moved ?? false;
    this.touchGesture = { ...c, moved: moved || this.touches.size > 1 };
    if (this.touches.size === 1) {
      const p = [...this.touches.values()][0]!;
      this.touchStart = { x: p.x, y: p.y, t: performance.now() };
    }
  }

  private updateTouchGesture(): void {
    const g = this.touchGesture;
    if (!g) return;
    const c = this.touchCentroid();
    const dx = c.cx - g.cx;
    const dy = c.cy - g.cy;
    if (this.touches.size === 1) {
      if (!g.moved && this.touchStart && Math.hypot(c.cx - this.touchStart.x, c.cy - this.touchStart.y) < CLICK_SLOP * 2) return;
      g.moved = true;
      if (this.rig.orbitEnabled) {
        this.rig.orbit(-dx * ORBIT_SPEED, -dy * ORBIT_SPEED, this.orbitPivot(null));
      } else {
        this.rig.panPixels(dx, dy, this.height);
      }
    } else {
      g.moved = true;
      this.rig.panPixels(dx, dy, this.height);
      if (g.dist > 0 && c.dist > 0) {
        const ndc = this.ndc(c.cx, c.cy);
        this.rig.zoomAt(g.dist / c.dist, ndc.x, ndc.y);
      }
    }
    this.touchGesture = { ...c, moved: g.moved };
    this.requestRender();
  }

  private endTouch(ev: PointerEvent): void {
    const el = this.renderer.domElement;
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    const wasTap = this.touches.size === 1 && this.touchGesture && !this.touchGesture.moved;
    this.touches.delete(ev.pointerId);
    if (wasTap && ev.type === 'pointerup') {
      const hit = this.pick(ev.clientX, ev.clientY);
      this.callbacks.onSelect({ entity: hit?.entity ?? null, mode: 'replace' });
    }
    if (this.touches.size === 0) {
      this.touchGesture = null;
      this.touchStart = null;
    } else {
      this.beginTouchGesture();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
      this.model = null;
    }
    this.sectionBox.dispose();
    this.viewCube.dispose();
    for (const d of this.warmUp) d.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.viewCube.canvas.remove();
  }
}
