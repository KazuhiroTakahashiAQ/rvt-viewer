import type {
  BodyMaterials,
  ExportDiagnostics,
  FileMetadata,
  IfcModel,
  SceneNode,
  Schedule,
  Summary,
} from '../wasm/types';

export type ExportKind = 'ifc' | 'glb' | 'plan-svg' | 'csv-elements' | 'csv-rooms';

/** Loading phases, reported in order. Labels live in the i18n catalog (`loading.step.*`). */
export type LoadStep = 'init' | 'metadata' | 'parse' | 'scene' | 'geometry' | 'schedule';

export type ToWorker =
  | { type: 'open'; bytes: Uint8Array; savedMeshes: boolean }
  /** Start the saved-mesh pass: the page has drawn the first geometry. */
  | { type: 'refine-begin' }
  /**
   * The candidates in the order the page wants them, most wanted first: the
   * first `visible` are on screen. Replaces any earlier order.
   */
  | { type: 'refine-order'; order: Uint32Array; visible: number }
  /** The page has drawn the last patch: send the next. */
  | { type: 'refine-ack' }
  | { type: 'export'; requestId: number; kind: ExportKind };

/**
 * Stages of the saved-mesh pass: reading the saved materials, then drawing
 * the elements from their saved graphics (`done` of `total` elements).
 */
export type RefineStage = 'materials' | 'meshes';

export interface ReadyPayload {
  model: IfcModel;
  diagnostics: ExportDiagnostics;
  scene: SceneNode;
  types: string[];
  glb: Uint8Array;
  schedule: Schedule;
}

/** What rvt-rs did when drawing bounding-box bodies from Revit's saved display meshes. */
export interface SavedMeshReport {
  candidates: number;
  replaced: number;
  triangles: number;
}

/**
 * Bodies drawn from saved meshes, replacing the boxes of their entities.
 * Per body (`entities`): its shape (`shapes`; bodies of one shape are the
 * same mesh in their placement's frame), its placement (`placements`, four
 * a body: origin x, y, z in the GLB's frame and turn about +Y), and, where
 * the shape comes for the first time, the shape's slices of `positions`
 * (x, y, z in the placement's frame), `triangles` (indices from the
 * shape's first vertex, wound outward) and `edges` (segment end points),
 * from `*Starts[i]` to `*Starts[i + 1]` in vertices, triangles and
 * segments; empty slices after. A body can come again when its materials
 * change.
 */
export interface RefinePatch {
  /** The candidates the batch took, drawn or not. */
  done: Uint32Array;
  entities: Uint32Array;
  shapes: Uint32Array;
  placements: Float32Array;
  vertexStarts: Uint32Array;
  triangleStarts: Uint32Array;
  edgeStarts: Uint32Array;
  positions: Float32Array;
  triangles: Uint32Array;
  edges: Float32Array;
  /** The bodies with a transparent face, in runs of one material. */
  runs: BodyMaterials[];
  report: SavedMeshReport;
  /** No candidate is left. */
  finished: boolean;
  /**
   * What the next batch draws: candidates on screen (made ahead, sent as
   * soon as the page asks), the others (made only once the page asks, which
   * it does when the user leaves the view alone), or nothing.
   */
  next: 'screen' | 'rest' | 'none';
}

export type FromWorker =
  | { type: 'progress'; step: LoadStep }
  | { type: 'summary'; summary: Summary | null; metadata: FileMetadata | null }
  | ({ type: 'ready' } & ReadyPayload)
  | { type: 'refine-progress'; stage: RefineStage; done: number; total: number }
  /** The saved-mesh pass's candidates; empty when it has nothing to do. */
  | { type: 'refine-candidates'; candidates: Uint32Array }
  | { type: 'refine-patch'; patch: RefinePatch }
  | { type: 'refine-failed'; error: string }
  | { type: 'export'; requestId: number; kind: ExportKind; data: Uint8Array | string | null; error?: string }
  | { type: 'error'; message: string };

/** The transferable buffers of a patch. */
export function patchBuffers(patch: RefinePatch): ArrayBuffer[] {
  return [
    patch.done,
    patch.entities,
    patch.shapes,
    patch.placements,
    patch.vertexStarts,
    patch.triangleStarts,
    patch.edgeStarts,
    patch.positions,
    patch.triangles,
    patch.edges,
  ].map((a) => a.buffer as ArrayBuffer);
}
