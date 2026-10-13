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
  | { type: 'open'; bytes: Uint8Array }
  | { type: 'export'; requestId: number; kind: ExportKind };

export interface ReadyPayload {
  model: IfcModel;
  diagnostics: ExportDiagnostics;
  scene: SceneNode;
  types: string[];
  glb: Uint8Array;
  schedule: Schedule;
}

export type FromWorker =
  | { type: 'progress'; step: LoadStep }
  | { type: 'summary'; summary: Summary | null; metadata: FileMetadata | null }
  | ({ type: 'ready' } & ReadyPayload)
  | { type: 'export'; requestId: number; kind: ExportKind; data: Uint8Array | string | null; error?: string }
  | { type: 'error'; message: string };
