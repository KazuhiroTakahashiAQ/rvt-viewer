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
 * page's `refine-begin`, sent once it has drawn the first geometry. It then
 * draws the boxed elements a batch at a time in the order the page asks
 * for (what is on screen first), one patch ahead of the page: the next is
 * sent when the page has drawn the last. The elements off screen are drawn
 * only when the page asks for them, without working ahead.
 */

import init, {
  documentGlb,
  documentIfcStep,
  documentPlanSvg,
  documentRefineBatch,
  documentRefineBegin,
  documentScene,
  documentSchedule,
  documentScheduleCsv,
  fileMetadata,
  openDocument,
  quickSummary,
} from '../wasm/pkg/rvt.js';
import type {
  ExportDiagnostics,
  FileMetadata,
  IfcModel,
  SceneNode,
  Schedule,
  Summary,
} from '../wasm/types';
import { type ExportKind, type FromWorker, type RefinePatch, type ToWorker, patchBuffers } from './protocol';

let opened = false;
/** Whether the saved-mesh pass is wanted and has not started yet. */
let refineWanted = false;
let entityCount = 0;

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

  entityCount = result.model.entities.length;
  send({ type: 'ready', model: result.model, diagnostics: result.diagnostics, scene, types, glb, schedule }, [
    glb.buffer as ArrayBuffer,
  ]);
  refineWanted = savedMeshes;
}

// --- saved-mesh pass ---------------------------------------------------------

/*
 * Batch sizes: each batch walks the file's partitions once or twice, a
 * cost whatever its size, so batches start small, for the first bodies on
 * screen to show soon, and double up to MAX_BATCH; a new order from the
 * page starts them small again. A batch slower than SLOW_BATCH_MS halves
 * the next, for a new order to take effect soon.
 */
const FIRST_BATCH = 24;
const MIN_BATCH = 8;
const MAX_BATCH = 500;
const SLOW_BATCH_MS = 3000;

interface Refining {
  /** By entity index: 1 once taken. */
  taken: Uint8Array;
  candidates: Uint32Array;
  order: Uint32Array;
  /** The first `visible` of `order` are on screen. */
  visible: number;
  cursor: number;
  /** Elements in the next batch. */
  size: number;
  /** The next patch, made while the page draws the last. */
  ahead: RefinePatch | null;
  awaitingAck: boolean;
  /** Send without waiting for the page: an export wants every body. */
  draining: boolean;
  finished: boolean;
  scheduled: boolean;
}

let refining: Refining | null = null;

/**
 * Second pass: draw the bodies rvt-rs could only box (doors, windows,
 * furniture, …) from the meshes Revit saved for display. Reads the
 * materials first, then waits for the page's order.
 */
function refineBegin(): void {
  if (!opened || !refineWanted) return;
  refineWanted = false;
  try {
    send({ type: 'refine-progress', stage: 'materials', done: 0, total: 1 });
    const candidates = documentRefineBegin();
    send({ type: 'refine-candidates', candidates: candidates.slice() });
    if (candidates.length === 0) return;
    refining = {
      taken: new Uint8Array(entityCount),
      candidates,
      order: candidates,
      visible: 0,
      cursor: 0,
      size: FIRST_BATCH,
      ahead: null,
      awaitingAck: false,
      draining: false,
      finished: false,
      scheduled: false,
    };
  } catch (err) {
    send({ type: 'refine-failed', error: errorText(err) });
  }
}

/** Move the cursor past the candidates taken. */
function skipTaken(r: Refining): void {
  while (r.cursor < r.order.length && r.taken[r.order[r.cursor]!]) r.cursor++;
}

/** What the next batch draws ([`RefinePatch.next`]). */
function nextTier(r: Refining): RefinePatch['next'] {
  skipTaken(r);
  if (r.cursor < r.visible) return 'screen';
  if (r.cursor < r.order.length) return 'rest';
  return r.candidates.some((entity) => !r.taken[entity]) ? 'rest' : 'none';
}

/** The next batch: the first candidates of the order not taken, from one tier. */
function nextBatch(r: Refining): number[] {
  skipTaken(r);
  let at = r.cursor;
  // On-screen candidates and the others go in batches of their own.
  const end = at < r.visible ? r.visible : r.order.length;
  const size = r.draining ? MAX_BATCH : r.size;
  const batch: number[] = [];
  for (; at < end && batch.length < size; at++) {
    const entity = r.order[at]!;
    if (!r.taken[entity]) batch.push(entity);
  }
  if (batch.length === 0) {
    // Candidates the order left out.
    for (const entity of r.candidates) {
      if (batch.length >= size) break;
      if (!r.taken[entity]) batch.push(entity);
    }
  }
  return batch;
}

function makePatch(r: Refining): RefinePatch {
  const batch = nextBatch(r);
  for (const entity of batch) r.taken[entity] = 1;
  const started = performance.now();
  const patch = documentRefineBatch(Uint32Array.from(batch)) as RefinePatch;
  // Nothing left to ask for: stop even if rvt-rs disagrees.
  if (batch.length === 0) patch.finished = true;
  const slow = performance.now() - started > SLOW_BATCH_MS;
  r.size = slow ? Math.max(MIN_BATCH, Math.round(r.size / 2)) : Math.min(MAX_BATCH, r.size * 2);
  patch.next = patch.finished ? 'none' : nextTier(r);
  return patch;
}

/** Make and send patches while the page keeps up; one at a time. */
function refineStep(): void {
  const r = refining;
  if (!r) return;
  r.scheduled = false;
  try {
    if (!r.ahead && !r.finished) r.ahead = makePatch(r);
    if (r.ahead && (!r.awaitingAck || r.draining)) {
      const patch = r.ahead;
      r.ahead = null;
      r.awaitingAck = true;
      r.finished = patch.finished;
      send({ type: 'refine-patch', patch }, patchBuffers(patch));
    }
  } catch (err) {
    refining = null;
    send({ type: 'refine-failed', error: errorText(err) });
    return;
  }
  if (r.finished && !r.ahead) {
    refining = null;
    return;
  }
  // The next one ahead, after the messages waiting (a new order, an ack),
  // where it is on screen: the others wait for the page.
  if (!r.ahead && (r.draining || nextTier(r) === 'screen')) scheduleRefine(r);
}

function scheduleRefine(r: Refining): void {
  if (r.scheduled) return;
  r.scheduled = true;
  setTimeout(refineStep, 0);
}

/** Draw every body left now, sending each patch as it is made. */
function refineDrain(): void {
  const r = refining;
  if (!r) return;
  r.draining = true;
  while (refining === r) refineStep();
}

function runExport(kind: ExportKind): Uint8Array | string {
  if (!opened) throw new Error('no model');
  // The model's bodies are complete once the saved-mesh pass is.
  refineDrain();
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
    case 'refine-begin':
      refineBegin();
      return;
    case 'refine-order':
      if (refining) {
        refining.order = msg.order;
        refining.visible = msg.visible;
        refining.cursor = 0;
        refining.size = FIRST_BATCH;
        // A patch made ahead for the old order is still sent first.
        if (!refining.ahead && (!refining.awaitingAck || nextTier(refining) === 'screen')) scheduleRefine(refining);
      }
      return;
    case 'refine-ack':
      if (refining) {
        refining.awaitingAck = false;
        scheduleRefine(refining);
      }
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
