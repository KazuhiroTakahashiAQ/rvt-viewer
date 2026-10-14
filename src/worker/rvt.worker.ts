/*
 * Parses a Revit file with rvt-rs (WebAssembly) off the main thread.
 *
 * One worker per opened file: wasm32 linear memory never shrinks, so the
 * client terminates this worker and starts a fresh one for the next file.
 * The decoded model stays here so export requests reuse it instead of
 * shipping it back into a second wasm instance on the main thread.
 */

import init, {
  attachSavedMeshes,
  buildSceneGraph,
  buildSchedule,
  distinctIfcTypes,
  fileMetadata,
  modelToGlb,
  modelToIfcStep,
  openRvtBytesWithDiagnosticsMode,
  quickSummary,
  renderPlanSvg,
  scheduleCsv,
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
import type { ExportKind, FromWorker, SavedMeshReport, ToWorker } from './protocol';

let model: IfcModel | null = null;
let glb: Uint8Array | null = null;

const send = (msg: FromWorker, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The model as the page needs it: bodies only as present or not (the page
 * draws the GLB), so that posting a model of millions of triangles does not
 * stall it. The worker keeps the whole model for the exports.
 */
function forPage(model: IfcModel): IfcModel {
  return {
    ...model,
    entities: model.entities.map((e) => ('solid_shape' in e && e.solid_shape ? { ...e, solid_shape: true } : e)),
    representation_maps: [],
  };
}

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
  const result = openRvtBytesWithDiagnosticsMode(bytes, 'scaffold') as {
    model: IfcModel;
    diagnostics: ExportDiagnostics;
  };
  model = result.model;

  send({ type: 'progress', step: 'scene' });
  const scene = buildSceneGraph(model) as SceneNode;
  const types = distinctIfcTypes(scene) as string[];

  send({ type: 'progress', step: 'geometry' });
  glb = modelToGlb(model);

  send({ type: 'progress', step: 'schedule' });
  const schedule = buildSchedule(model) as Schedule;

  // The GLB is copied so the worker keeps its own copy for "export glTF".
  const glbCopy = glb.slice();
  send(
    { type: 'ready', model: forPage(model), diagnostics: result.diagnostics, scene, types, glb: glbCopy, schedule },
    [glbCopy.buffer as ArrayBuffer],
  );

  if (savedMeshes) refine(bytes);
}

/**
 * Second pass: draw the bodies rvt-rs could only box (doors, windows,
 * furniture, …) from the meshes Revit saved for display. Slow on large
 * files, so the boxed model is shown first.
 */
function refine(bytes: Uint8Array): void {
  if (!model) return;
  try {
    const result = attachSavedMeshes(bytes, model) as {
      model: IfcModel | null;
      report: SavedMeshReport;
      materials: BodyMaterials[];
    };
    if (!result.model) {
      send({ type: 'refined', refined: null, report: result.report });
      return;
    }
    model = result.model;
    glb = modelToGlb(model);
    const glbCopy = glb.slice();
    send(
      {
        type: 'refined',
        refined: { model: forPage(model), glb: glbCopy, materials: result.materials, report: result.report },
        report: result.report,
      },
      [glbCopy.buffer as ArrayBuffer],
    );
  } catch (err) {
    send({ type: 'refined', refined: null, report: null, error: errorText(err) });
  }
}

function runExport(kind: ExportKind): Uint8Array | string {
  if (!model) throw new Error('no model');
  switch (kind) {
    case 'ifc':
      return modelToIfcStep(model);
    case 'glb':
      if (!glb) throw new Error('no glb');
      return glb.slice();
    case 'plan-svg':
      return renderPlanSvg(model, null);
    case 'csv-elements':
      return scheduleCsv(model, 'elements', true, true);
    case 'csv-rooms':
      return scheduleCsv(model, 'rooms', true, true);
  }
}

self.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'open':
      open(msg.bytes, msg.savedMeshes).catch((err: unknown) => send({ type: 'error', message: errorText(err) }));
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
