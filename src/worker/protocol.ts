import type {
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
  | { type: 'export'; requestId: number; kind: ExportKind };

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

/** Sent after `ready` when saved meshes replaced bodies: same entity indices, better bodies. */
export interface RefinedPayload {
  model: IfcModel;
  glb: Uint8Array;
  report: SavedMeshReport;
}

export type FromWorker =
  | { type: 'progress'; step: LoadStep }
  | { type: 'summary'; summary: Summary | null; metadata: FileMetadata | null }
  | ({ type: 'ready' } & ReadyPayload)
  | { type: 'refined'; refined: RefinedPayload | null; report: SavedMeshReport | null; error?: string }
  | { type: 'export'; requestId: number; kind: ExportKind; data: Uint8Array | string | null; error?: string }
  | { type: 'error'; message: string };
