/*
 * Parses a Revit file with rvt-rs (WebAssembly) off the main thread.
 *
 * One worker per opened file: wasm32 linear memory never shrinks, so the
 * client terminates this worker and starts a fresh one for the next file.
 * The decoded model stays here so export requests reuse it instead of
 * shipping it back into a second wasm instance on the main thread.
 */

import init, {
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
  ExportDiagnostics,
  FileMetadata,
  IfcModel,
  SceneNode,
  Schedule,
  Summary,
} from '../wasm/types';
import type { ExportKind, FromWorker, ToWorker } from './protocol';

let model: IfcModel | null = null;
let glb: Uint8Array | null = null;

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

async function open(bytes: Uint8Array): Promise<void> {
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
    { type: 'ready', model, diagnostics: result.diagnostics, scene, types, glb: glbCopy, schedule },
    [glbCopy.buffer as ArrayBuffer],
  );
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
      open(msg.bytes).catch((err: unknown) => send({ type: 'error', message: errorText(err) }));
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
