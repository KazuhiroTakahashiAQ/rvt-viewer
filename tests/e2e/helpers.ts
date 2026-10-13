import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';
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

/** Share of dark pixels (all channels < 110) in a PNG screenshot, sampled every 4th pixel. */
export function darkRatio(png: Buffer): number {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const chunk = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9]!;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let prev = new Uint8Array(stride);
  let dark = 0;
  let total = 0;
  for (let y = 0, i = 0; y < height; y++) {
    const filter = raw[i++]!;
    const line = new Uint8Array(raw.subarray(i, i + stride));
    i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      if (filter === 1) line[x] = (line[x]! + a) & 255;
      else if (filter === 2) line[x] = (line[x]! + b) & 255;
      else if (filter === 3) line[x] = (line[x]! + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    if (y % 4 === 0) {
      for (let x = 0; x < stride; x += bpp * 4) {
        total++;
        if (line[x]! < 110 && line[x + 1]! < 110 && line[x + 2]! < 110) dark++;
      }
    }
    prev = line;
  }
  return total ? dark / total : 0;
}
