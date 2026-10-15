/*
 * Parses a Revit file with rvt-rs (WebAssembly) off the main thread.
 *
 * One worker per opened file: wasm32 linear memory never shrinks, so the
 * client terminates this worker and starts a fresh one for the next file.
 * The file's bytes and the decoded model live inside wasm (`openDocument`);
 * the page gets the model without its bodies and the GLB, and exports are
 * written from the model here. Nothing large is kept twice: the bytes are
 * dropped once wasm holds them, and the GLB is transferred, not copied.
 *
 * The heavy steps run one at a time: the saved-mesh pass waits for the
 * page's `refine` message, sent once it has drawn the first geometry.
 */

import init, {
  documentAttachSavedMeshes,
  documentGlb,
  documentIfcStep,
  documentPlanSvg,
  documentScene,
  documentSchedule,
  documentScheduleCsv,
  fileMetadata,
  openDocument,
  quickSummary,
} from '../wasm/pkg/rvt.js';
import type {
  BodyMaterials,
  ExportDiagnostics,
  FileMetadata,
  IfcModel,
  SceneNode,
  Schedule,
  Summary,
} from '../wasm/types';
import type { ExportKind, FromWorker, RefineStage, SavedMeshReport, ToWorker } from './protocol';

let opened = false;
/** Whether the saved-mesh pass is wanted and has not run yet. */
let refinePending = false;

const send = (msg: FromWorker, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function tryOr<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function open(bytes: Uint8Array, savedMeshes: boolean): Promise<void> {
  send({ type: 'progress', step: 'init' });
  await init();

  send({ type: 'progress', step: 'metadata' });
  const summary = tryOr(() => quickSummary(bytes) as Summary, null);
  const metadata = tryOr(() => fileMetadata(bytes) as FileMetadata, null);
  send({ type: 'summary', summary, metadata });

  send({ type: 'progress', step: 'parse' });
  const result = openDocument(bytes, 'scaffold') as { model: IfcModel; diagnostics: ExportDiagnostics };
  opened = true;

  send({ type: 'progress', step: 'scene' });
  const { scene, types } = documentScene() as { scene: SceneNode; types: string[] };

  send({ type: 'progress', step: 'geometry' });
  const glb = documentGlb();

  send({ type: 'progress', step: 'schedule' });
  const schedule = documentSchedule() as Schedule;

  send({ type: 'ready', model: result.model, diagnostics: result.diagnostics, scene, types, glb, schedule }, [
    glb.buffer as ArrayBuffer,
  ]);
  refinePending = savedMeshes;
}

/**
 * Second pass: draw the bodies rvt-rs could only box (doors, windows,
 * furniture, …) from the meshes Revit saved for display. Slow on large
 * files, so the boxed model is shown first; it reports its stages as it
 * goes.
 */
function refine(): void {
  if (!opened || !refinePending) return;
  refinePending = false;
  const progress = (stage: RefineStage, done: number, total: number): void => {
    send({ type: 'refine-progress', stage, done, total });
  };
  try {
    const result = documentAttachSavedMeshes(progress) as {
      model: IfcModel | null;
      report: SavedMeshReport;
      materials: BodyMaterials[];
    };
    if (!result.model) {
      send({ type: 'refined', refined: null, report: result.report });
      return;
    }
    progress('glb', 0, 1);
    const glb = documentGlb();
    send(
      {
        type: 'refined',
        refined: { model: result.model, glb, materials: result.materials, report: result.report },
        report: result.report,
      },
      [glb.buffer as ArrayBuffer],
    );
  } catch (err) {
    send({ type: 'refined', refined: null, report: null, error: errorText(err) });
  }
}

function runExport(kind: ExportKind): Uint8Array | string {
  if (!opened) throw new Error('no model');
  switch (kind) {
    case 'ifc':
      return documentIfcStep();
    case 'glb':
      return documentGlb();
    case 'plan-svg':
      return documentPlanSvg(null);
    case 'csv-elements':
      return documentScheduleCsv('elements', true, true);
    case 'csv-rooms':
      return documentScheduleCsv('rooms', true, true);
  }
}

self.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'open':
      open(msg.bytes, msg.savedMeshes).catch((err: unknown) => send({ type: 'error', message: errorText(err) }));
      return;
    case 'refine':
      refine();
      return;
    case 'export': {
      try {
        const data = runExport(msg.kind);
        send(
          { type: 'export', requestId: msg.requestId, kind: msg.kind, data },
          data instanceof Uint8Array ? [data.buffer as ArrayBuffer] : [],
        );
      } catch (err) {
        send({ type: 'export', requestId: msg.requestId, kind: msg.kind, data: null, error: errorText(err) });
      }
      return;
    }
  }
});
