/*
 * Builds bounds trees for picking off the page's thread ([`buildBoundsTree`]):
 * one job at a time, in the order they come.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BoundsTreeJob, BoundsTreeResult } from './boundsTree';

const send = (msg: BoundsTreeResult, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);
};

self.addEventListener('message', (ev: MessageEvent<BoundsTreeJob>) => {
  const { id, indirect, lent } = ev.data;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(ev.data.position, 3));
  geometry.setIndex(new BufferAttribute(ev.data.index, 1));
  // Lent arrays go back whatever happens: the page draws them. Without
  // `indirect` the tree sorts the index in place.
  const back = () => {
    const position = geometry.getAttribute('position').array as Float32Array;
    const index = geometry.index!.array as Uint32Array | Uint16Array;
    return lent
      ? { arrays: { position, index }, buffers: [position.buffer as ArrayBuffer, index.buffer as ArrayBuffer] }
      : { arrays: { position: null, index: null }, buffers: [] };
  };
  try {
    const tree = MeshBVH.serialize(new MeshBVH(geometry, { indirect }), { cloneBuffers: false });
    // The index travels on its own, if at all.
    tree.index = null;
    const { arrays, buffers } = back();
    const own = [...tree.roots, ...(tree.indirectBuffer ? [tree.indirectBuffer.buffer as ArrayBuffer] : [])];
    send({ type: 'tree', id, tree, ...arrays }, [...own, ...buffers]);
  } catch (err) {
    const { arrays, buffers } = back();
    send({ type: 'error', id, error: err instanceof Error ? err.message : String(err), ...arrays }, buffers);
  }
});

// From now on the page lends its arrays rather than copying them.
send({ type: 'alive' });
