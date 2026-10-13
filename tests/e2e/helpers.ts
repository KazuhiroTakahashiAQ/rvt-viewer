import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Opens a local Revit file in the app by serving it from a same-origin URL
 * (via request interception) and dropping it onto the window.
 */
export async function openSample(page: Page, path: string): Promise<void> {
  const name = basename(path);
  const url = `/rvt-viewer/__e2e__/${encodeURIComponent(name)}`;
  await page.route(`**${url}`, (route) =>
    route.fulfill({ status: 200, body: readFileSync(path), contentType: 'application/octet-stream' }),
  );
  await page.evaluate(
    async ({ url, name }) => {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], name, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.app')!;
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { url, name },
  );
}
