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
import type { ExportKind, RefinedPayload, SavedMeshReport } from '../worker/protocol';
import { baseName, downloadData, toJson } from './download';

export const ACCEPTED_EXTENSIONS = ['.rvt', '.rfa', '.rte', '.rft'];

const client = new RvtWorkerClient();
let openSeq = 0;

export function isRevitFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
  const store = useStore.getState();
  const seq = ++openSeq;
  store.startLoading(file.name, file.size);
  if (handle) void rememberFile(handle, file);

  let summary: Summary | null = null;
  let metadata: FileMetadata | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const savedMeshes = store.prefs.savedMeshes;
    const ready = await client.open(bytes, {
      savedMeshes,
      onRefined: (refined, report, error) => {
        if (seq === openSeq) savedMeshesDone(refined, report, error);
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
      refinedBody: null,
    });
  } catch (err) {
    if (seq !== openSeq) return;
    client.close();
    const detail = err instanceof Error ? err.message : String(err);
    useStore.getState().loadFailed(classifyError(detail, summary), detail);
  }
}

function savedMeshesDone(refined: RefinedPayload | null, report: SavedMeshReport | null, error?: string): void {
  const store = useStore.getState();
  if (!store.doc) return;
  if (error !== undefined) {
    store.savedMeshesDone('failed', null);
    store.pushToast('error', i18n.t('savedMeshes.failed', { detail: error }));
    return;
  }
  store.savedMeshesDone(
    'done',
    report,
    refined
      ? { model: refined.model, index: buildModelIndex(refined.model), glb: refined.glb, materials: refined.materials }
      : undefined,
  );
}

function classifyError(detail: string, summary: Summary | null): LoadErrorCode {
  if (/memory|unreachable|RangeError|allocation/i.test(detail)) return 'outOfMemory';
  if (!summary) return 'notRevit';
  if (summary.version < 2016 || summary.version > 2026) return 'unsupportedVersion';
  return 'unknown';
}

export function closeDocument(): void {
  openSeq++;
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
  try {
    const data = kind === 'diagnostics' ? toJson(doc.diagnostics) : await client.export(kind);
    downloadData(data, name, spec.mime);
    store.pushToast('info', i18n.t('export.done', { name }));
  } catch (err) {
    store.pushToast('error', i18n.t('export.failed', { detail: err instanceof Error ? err.message : String(err) }));
  }
}
