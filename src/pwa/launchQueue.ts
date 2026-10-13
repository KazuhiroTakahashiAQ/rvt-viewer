import { openFile } from '../app/document';

interface LaunchParams {
  files: FileSystemFileHandle[];
}

/** Files opened from the OS with the installed PWA (manifest `file_handlers`). */
export function setupLaunchQueue(): void {
  const lq = (window as unknown as { launchQueue?: { setConsumer: (cb: (p: LaunchParams) => void) => void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    const handle = params.files[0];
    if (!handle) return;
    const file = await handle.getFile();
    await openFile(file, handle);
  });
}
