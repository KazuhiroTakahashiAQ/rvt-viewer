/*
 * "Recent files" backed by File System Access handles in IndexedDB. Only
 * browsers that hand out file handles (Chromium) can reopen a file later,
 * so entries are stored only when a handle exists.
 */

import { get, set } from 'idb-keyval';

const KEY = 'rvt-viewer:recent-files';
const MAX = 12;

export interface RecentFile {
  name: string;
  size: number;
  openedAt: number;
  handle: FileSystemFileHandle;
}

export async function listRecentFiles(): Promise<RecentFile[]> {
  try {
    return ((await get<RecentFile[]>(KEY)) ?? []).filter((r) => r && r.handle);
  } catch {
    return [];
  }
}

export async function rememberFile(handle: FileSystemFileHandle, file: File): Promise<void> {
  try {
    const list = await listRecentFiles();
    const kept: RecentFile[] = [];
    for (const r of list) {
      if (r.name === file.name && (await r.handle.isSameEntry(handle).catch(() => false))) continue;
      kept.push(r);
    }
    await set(KEY, [{ name: file.name, size: file.size, openedAt: Date.now(), handle }, ...kept].slice(0, MAX));
  } catch {
    // Storage may be unavailable (private mode); recents are a convenience.
  }
}

export async function forgetFile(entry: RecentFile): Promise<void> {
  try {
    const list = await listRecentFiles();
    const kept: RecentFile[] = [];
    for (const r of list) {
      if (r.name === entry.name && (await r.handle.isSameEntry(entry.handle).catch(() => false))) continue;
      kept.push(r);
    }
    await set(KEY, kept);
  } catch {
    // ignore
  }
}

export async function fileFromHandle(handle: FileSystemFileHandle): Promise<File | null> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
  };
  try {
    let perm = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (perm !== 'granted') perm = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (perm !== 'granted') return null;
    return await handle.getFile();
  } catch {
    return null;
  }
}
