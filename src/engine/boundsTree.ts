/*
 * Bounds trees (three-mesh-bvh) for picking. A large mesh's takes tens of
 * milliseconds to build in one call, which would stop the page: those are
 * built in a worker, one at a time; a small mesh's here, at once.
 *
 * A job either lends the geometry's own position and index arrays to the
 * worker, which sends them back with the tree (nothing may read them
 * meanwhile: the geometry must not be drawn yet), or sends copies, for a
 * geometry drawn already. A tree built from copies is indirect, so that the
 * index drawn stays as it is.
 */

import type * as THREE from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';

export interface BoundsTreeJob {
  id: number;
  position: Float32Array;
  index: Uint32Array | Uint16Array;
  indirect: boolean;
  /** The geometry's own arrays, to send back. */
  lent: boolean;
}

/** From the worker; lent arrays come back with the tree or the error. */
export type BoundsTreeResult =
  | { type: 'alive' }
  | {
      type: 'tree';
      id: number;
      tree: SerializedBVH;
      position: Float32Array | null;
      index: Uint32Array | Uint16Array | null;
    }
  | { type: 'error'; id: number; error: string; position: Float32Array | null; index: Uint32Array | Uint16Array | null };

/** Triangles from which a tree is built in the worker: about 2.5 ms to build here. */
const WORKER_TRIANGLES = 10_000;

interface Pending {
  geometry: THREE.BufferGeometry;
  indirect: boolean;
  resolve: (tree: MeshBVH) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
/** The worker runs: arrays lent to it come back. */
let alive = false;
/** No worker (or it would not start): build here. */
let broken = typeof Worker === 'undefined';
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * `geometry`'s bounds tree (indexed, x, y, z positions): the tree, built at
 * once, or a promise of it from the worker. With `lend`, the geometry's
 * arrays go to the worker and back (they are empty meanwhile); else copies.
 */
export function buildBoundsTree(
  geometry: THREE.BufferGeometry,
  options: { indirect: boolean; lend: boolean },
): MeshBVH | Promise<MeshBVH> {
  const index = geometry.index;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const to = index && index.count / 3 >= WORKER_TRIANGLES ? getWorker() : null;
  if (!to || !index) return new MeshBVH(geometry, { indirect: options.indirect });
  const positions = position.array as Float32Array;
  const indices = index.array as Uint32Array | Uint16Array;
  // Before the worker has answered once, it may never run: lend nothing yet.
  const lent = options.lend && alive && ownsBuffer(positions) && ownsBuffer(indices);
  const indirect = options.indirect || !lent;
  const id = nextId++;
  const job: BoundsTreeJob = {
    id,
    position: lent ? positions : positions.slice(),
    index: lent ? indices : indices.slice(),
    indirect,
    lent,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { geometry, indirect, resolve, reject });
    to.postMessage(job, [job.position.buffer as ArrayBuffer, job.index.buffer as ArrayBuffer]);
  });
}

function getWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./boundsTree.worker.ts', import.meta.url), { type: 'module', name: 'bounds-tree' });
  } catch {
    broken = true;
    return null;
  }
  worker.addEventListener('message', (ev: MessageEvent<BoundsTreeResult>) => receive(ev.data));
  worker.addEventListener('error', () => {
    // Build what waits here (nothing is lent before the worker runs).
    broken = true;
    worker = null;
    for (const [id, job] of pending) {
      pending.delete(id);
      try {
        job.resolve(new MeshBVH(job.geometry, { indirect: job.indirect }));
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
  return worker;
}

function receive(msg: BoundsTreeResult): void {
  if (msg.type === 'alive') {
    alive = true;
    return;
  }
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  const { geometry } = job;
  if (msg.position) (geometry.getAttribute('position') as THREE.BufferAttribute).array = msg.position;
  if (msg.index && geometry.index) geometry.index.array = msg.index;
  if (msg.type === 'tree') {
    job.resolve(MeshBVH.deserialize(msg.tree, geometry, { setIndex: false }));
    return;
  }
  // Here, then (indirect where the geometry may be drawn).
  try {
    job.resolve(new MeshBVH(geometry, { indirect: job.indirect }));
  } catch {
    job.reject(new Error(msg.error));
  }
}

/** Whether `array` is all of its buffer, so that lending the buffer lends nothing else. */
function ownsBuffer(array: Float32Array | Uint32Array | Uint16Array): boolean {
  return array.byteOffset === 0 && array.byteLength === array.buffer.byteLength && array.buffer instanceof ArrayBuffer;
}
