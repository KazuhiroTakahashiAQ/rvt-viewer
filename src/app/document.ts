/*
 * Opening documents (picker, drag & drop, OS file handler, recent files),
 * running the parse worker, and exports.
 */

import i18n from '../i18n';
import { buildModelIndex } from '../model/modelIndex';
import { forgetFile, fileFromHandle, rememberFile, type RecentFile } from '../pwa/recentFiles';
import { type LoadErrorCode, useStore } from '../state/store';
import type { FileMetadata, Summary } from '../wasm/types';
import { RvtWorkerClient } from '../worker/client';
import type { ExportKind, RefinePatch } from '../worker/protocol';
import { baseName, downloadData, toJson } from './download';
import { getViewer } from './viewerBridge';

export const ACCEPTED_EXTENSIONS = ['.rvt', '.rfa', '.rte', '.rft'];

const client = new RvtWorkerClient();
let openSeq = 0;

/** The saved-mesh pass of the open document, while it draws. */
interface Refining {
  seq: number;
  total: number;
  done: number;
  /** Candidates not taken yet. */
  pending: Set<number>;
  /** What the last order put first, not to send the same again. */
  lastOrder: string;
  /** Asks for the next patch now, while waiting to ask for one off screen. */
  askNow: (() => void) | null;
}

/**
 * The elements off screen are drawn once the user has left the view alone
 * this long, ms: moving around draws only what comes into view.
 */
const OFFSCREEN_IDLE_MS = 1500;

let refining: Refining | null = null;

export function isRevitFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
  const store = useStore.getState();
  const seq = ++openSeq;
  refining = null;
  store.startLoading(file.name, file.size);
  if (handle) void rememberFile(handle, file);

  let summary: Summary | null = null;
  let metadata: FileMetadata | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const savedMeshes = store.prefs.savedMeshes;
    const ready = await client.open(bytes, {
      savedMeshes,
      onRefineProgress: (stage, done, total) => {
        if (seq === openSeq) useStore.getState().setWork({ stage, done, total });
      },
      onRefineCandidates: (candidates) => {
        if (seq === openSeq) refineCandidates(seq, candidates);
      },
      onRefinePatch: (patch) => {
        if (seq === openSeq) refinePatch(seq, patch);
      },
      onRefineFailed: (error) => {
        if (seq === openSeq) refineFailed(error);
      },
      onProgress: (step) => {
        if (seq === openSeq) useStore.getState().setLoadStep(step);
      },
      onSummary: (s, m) => {
        summary = s;
        metadata = m;
        if (seq === openSeq) useStore.getState().setLoadSummary(s);
      },
    });
    if (seq !== openSeq) return;
    const loading = useStore.getState().loading;
    const index = buildModelIndex(ready.model);
    const hasGeometry = ready.diagnostics.exported.building_elements_with_geometry > 0;
    useStore.getState().documentLoaded({
      fileName: file.name,
      fileSize: file.size,
      summary: loading?.summary ?? summary,
      metadata,
      model: ready.model,
      diagnostics: ready.diagnostics,
      schedule: ready.schedule,
      index,
      glb: ready.glb,
      hasGeometry,
      savedMeshes: { status: savedMeshes ? 'pending' : 'off', report: null },
    });
    // Without geometry no view draws a first model to wait for.
    if (!hasGeometry) requestSavedMeshes();
  } catch (err) {
    if (seq !== openSeq) return;
    client.close();
    const detail = err instanceof Error ? err.message : String(err);
    useStore.getState().loadFailed(classifyError(detail, summary), detail);
  }
}

/** Changes with every document opened or closed, to tell late work apart. */
export function documentSeq(): number {
  return openSeq;
}

/**
 * Start the saved-mesh pass, once the first geometry is drawn: one heavy
 * step at a time. A second call does nothing.
 */
export function requestSavedMeshes(): void {
  const store = useStore.getState();
  if (store.doc?.savedMeshes.status !== 'pending' || store.work || refining) return;
  store.setWork({ stage: 'materials', done: 0, total: 1 });
  client.refineBegin();
}

/**
 * What is on screen changed: the saved-mesh pass takes the candidates in
 * view first from now on.
 */
export function savedMeshViewChanged(): void {
  if (refining && refining.seq === openSeq) sendRefineOrder(refining);
}

function sendRefineOrder(r: Refining): void {
  if (r.pending.size === 0) return;
  const viewer = getViewer();
  const index = useStore.getState().doc?.index;
  // Without a view to rank them, as they come.
  const { order, visible } =
    viewer && index
      ? viewer.refineOrder(r.pending, (e) => {
          const record = index.byIndex.get(e);
          return record ? `${record.familyName}\u0000${record.typeName}` : '';
        })
      : { order: Uint32Array.from(r.pending), visible: 0 };
  // The worker starts small batches again on a new order: only when it differs.
  const head = `${visible}:${order.subarray(0, Math.min(visible, 64)).join(',')}`;
  if (head === r.lastOrder) return;
  r.lastOrder = head;
  client.refineOrder(order, visible);
  // Something new on screen: no need to wait for the user to stop.
  if (visible > 0) r.askNow?.();
}

function refineCandidates(seq: number, candidates: Uint32Array): void {
  const store = useStore.getState();
  if (candidates.length === 0) {
    store.setWork(null);
    store.savedMeshesDone('done', { candidates: 0, replaced: 0, triangles: 0 });
    return;
  }
  refining = { seq, total: candidates.length, done: 0, pending: new Set(candidates), lastOrder: '', askNow: null };
  store.setWork({ stage: 'meshes', done: 0, total: candidates.length });
  sendRefineOrder(refining);
}

function refinePatch(seq: number, patch: RefinePatch): void {
  const r = refining;
  if (!r || r.seq !== seq) return;
  for (const entity of patch.done) r.pending.delete(entity);
  r.done += patch.done.length;
  const viewer = getViewer();
  const drawn = viewer ? viewer.applyPatch(patch) : Promise.resolve();
  void drawn
    .catch((err: unknown) => {
      if (seq === openSeq) useStore.getState().pushToast('error', i18n.t('error.geometry', { detail: err instanceof Error ? err.message : String(err) }));
    })
    .then(() => {
      if (seq !== openSeq || refining !== r) return;
      const store = useStore.getState();
      store.markSavedMeshes(patch.entities);
      if (!patch.finished) {
        store.setWork({ stage: 'meshes', done: r.done, total: r.total });
        if (patch.next === 'rest') askWhenIdle(r);
        else client.refineAck();
        return;
      }
      refining = null;
      store.setWork(null);
      store.savedMeshesDone('done', patch.report);
      void viewer?.finishPatches();
    });
}

/** Ask for the next patch, of elements off screen, once the user leaves the view alone. */
function askWhenIdle(r: Refining): void {
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    r.askNow = null;
    if (refining === r) client.refineAck();
  };
  r.askNow = ask;
  const viewer = getViewer();
  void (viewer ? viewer.whenIdleFor(OFFSCREEN_IDLE_MS) : Promise.resolve()).then(ask);
}

function refineFailed(error: string): void {
  refining = null;
  const store = useStore.getState();
  store.setWork(null);
  if (!store.doc) return;
  store.savedMeshesDone('failed', null);
  store.pushToast('error', i18n.t('savedMeshes.failed', { detail: error }));
}

function classifyError(detail: string, summary: Summary | null): LoadErrorCode {
  if (/memory|unreachable|RangeError|allocation/i.test(detail)) return 'outOfMemory';
  if (!summary) return 'notRevit';
  if (summary.version < 2016 || summary.version > 2026) return 'unsupportedVersion';
  return 'unknown';
}

export function closeDocument(): void {
  openSeq++;
  refining = null;
  client.close();
  useStore.getState().closeDocument();
}

// --- pickers ---------------------------------------------------------------

type OpenFilePicker = (options: {
  multiple?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
}) => Promise<FileSystemFileHandle[]>;

let fallbackInput: HTMLInputElement | null = null;

export async function pickAndOpen(): Promise<void> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker({
        multiple: false,
        types: [{ description: i18n.t('file.pickerDescription'), accept: { 'application/octet-stream': ACCEPTED_EXTENSIONS } }],
      });
      if (!handle) return;
      const file = await handle.getFile();
      await openFile(file, handle);
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') throw err;
    }
    return;
  }
  if (!fallbackInput) {
    fallbackInput = document.createElement('input');
    fallbackInput.type = 'file';
    fallbackInput.accept = ACCEPTED_EXTENSIONS.join(',');
    fallbackInput.style.display = 'none';
    fallbackInput.addEventListener('change', () => {
      const f = fallbackInput?.files?.[0];
      if (f) void openFile(f);
      if (fallbackInput) fallbackInput.value = '';
    });
    document.body.appendChild(fallbackInput);
  }
  fallbackInput.click();
}

export async function openRecent(entry: RecentFile): Promise<void> {
  const file = await fileFromHandle(entry.handle);
  if (!file) {
    await forgetFile(entry);
    useStore.getState().pushToast('error', i18n.t('recent.unavailable', { name: entry.name }));
    return;
  }
  await openFile(file, entry.handle);
}

/** Drag & drop: prefer a handle (so the file lands in recents). */
export async function openDataTransfer(dt: DataTransfer): Promise<boolean> {
  const item = [...dt.items].find((i) => i.kind === 'file');
  const file = item?.getAsFile() ?? dt.files[0];
  if (!file) return false;
  if (!isRevitFileName(file.name)) {
    useStore.getState().pushToast('error', i18n.t('file.notRevitExtension', { name: file.name }));
    return false;
  }
  let handle: FileSystemFileHandle | undefined;
  const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
    ?.getAsFileSystemHandle;
  if (getHandle) {
    try {
      const h = await getHandle.call(item);
      if (h && h.kind === 'file') handle = h as FileSystemFileHandle;
    } catch {
      handle = undefined;
    }
  }
  await openFile(file, handle);
  return true;
}

// --- exports -----------------------------------------------------------------

const EXPORTS: Record<ExportKind | 'diagnostics', { ext: string; mime: string }> = {
  ifc: { ext: '.ifc', mime: 'application/x-step' },
  glb: { ext: '.glb', mime: 'model/gltf-binary' },
  'plan-svg': { ext: '-plan.svg', mime: 'image/svg+xml' },
  'csv-elements': { ext: '-elements.csv', mime: 'text/csv;charset=utf-8' },
  'csv-rooms': { ext: '-rooms.csv', mime: 'text/csv;charset=utf-8' },
  diagnostics: { ext: '-diagnostics.json', mime: 'application/json' },
};

export async function exportDocument(kind: ExportKind | 'diagnostics'): Promise<void> {
  const store = useStore.getState();
  const doc = store.doc;
  if (!doc) return;
  const spec = EXPORTS[kind];
  const name = baseName(doc.fileName) + spec.ext;
  // The worker draws every body left first (the bar shows it), for a complete model.
  if (kind !== 'diagnostics' && refining) store.pushToast('info', i18n.t('export.waitForMeshes'));
  try {
    const data = kind === 'diagnostics' ? toJson(doc.diagnostics) : await client.export(kind);
    downloadData(data, name, spec.mime);
    store.pushToast('info', i18n.t('export.done', { name }));
  } catch (err) {
    store.pushToast('error', i18n.t('export.failed', { detail: err instanceof Error ? err.message : String(err) }));
  }
}
