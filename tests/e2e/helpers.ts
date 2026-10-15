import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/** Files above this go through the file input: a drop carries the bytes through the page. */
const DROP_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Opens a local Revit file in the app: dropped onto the window (served from
 * a same-origin URL via request interception), or for a large file chosen
 * through the "Open" button's file input, which Playwright hands the path.
 */
export async function openSample(page: Page, path: string): Promise<void> {
  if (statSync(path).size > DROP_LIMIT_BYTES) {
    // The input is the fallback where the File System Access picker is missing.
    await page.evaluate(() => {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '開く', exact: true }).first().click();
    await (await chooser).setFiles(path);
    return;
  }
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

/** A PNG screenshot's pixels: `bpp` bytes each (RGB or RGBA), row by row. */
function decodePng(png: Buffer): { width: number; height: number; bpp: number; pixels: Uint8Array } {
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
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
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
    pixels.set(line, y * stride);
    prev = line;
  }
  return { width, height, bpp, pixels };
}

/** Share of dark pixels (all channels < 110) in a PNG screenshot, sampled every 4th pixel. */
export function darkRatio(png: Buffer): number {
  const { width, height, bpp, pixels } = decodePng(png);
  let dark = 0;
  let total = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * bpp;
      total++;
      if (pixels[i]! < 110 && pixels[i + 1]! < 110 && pixels[i + 2]! < 110) dark++;
    }
  }
  return total ? dark / total : 0;
}

/** Share of pixels whose colour differs by more than `threshold` in some channel, two screenshots of one size. */
export function pixelDifference(a: Buffer, b: Buffer, threshold = 24): number {
  const pa = decodePng(a);
  const pb = decodePng(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  let differ = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs(pa.pixels[i * pa.bpp + k]! - pb.pixels[i * pb.bpp + k]!) > threshold) {
        differ++;
        break;
      }
    }
  }
  return differ / (pa.width * pa.height);
}
