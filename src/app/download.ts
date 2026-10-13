export function downloadData(data: Uint8Array | string, fileName: string, mime: string): void {
  const part: BlobPart = typeof data === 'string' ? data : (data.slice().buffer as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `name.rvt` → `name` */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || 'model';
}

/** JSON.stringify that turns ES Maps (from serde-wasm-bindgen) into objects. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
}
