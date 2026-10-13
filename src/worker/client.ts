import type { FileMetadata, Summary } from '../wasm/types';
import type { ExportKind, FromWorker, LoadStep, ReadyPayload, ToWorker } from './protocol';

export interface OpenCallbacks {
  onProgress: (step: LoadStep) => void;
  onSummary: (summary: Summary | null, metadata: FileMetadata | null) => void;
}

/**
 * Owns the parse worker of the currently open document. `open()` always
 * starts a fresh worker so the previous file's wasm memory is released.
 */
export class RvtWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, (msg: FromWorker) => void>();
  private cancelOpen: ((err: Error) => void) | null = null;

  open(bytes: Uint8Array, callbacks: OpenCallbacks): Promise<ReadyPayload> {
    this.close();
    const worker = new Worker(new URL('./rvt.worker.ts', import.meta.url), { type: 'module', name: 'rvt-parser' });
    this.worker = worker;

    return new Promise<ReadyPayload>((resolve, reject) => {
      let settled = false;
      this.cancelOpen = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      worker.addEventListener('message', (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        switch (msg.type) {
          case 'progress':
            callbacks.onProgress(msg.step);
            break;
          case 'summary':
            callbacks.onSummary(msg.summary, msg.metadata);
            break;
          case 'ready': {
            settled = true;
            const { type: _type, ...payload } = msg;
            resolve(payload);
            break;
          }
          case 'error':
            if (!settled) {
              settled = true;
              reject(new Error(msg.message));
            }
            break;
          case 'export': {
            const handler = this.pending.get(msg.requestId);
            if (handler) {
              this.pending.delete(msg.requestId);
              handler(msg);
            }
            break;
          }
        }
      });
      worker.addEventListener('error', (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error(ev.message || 'worker error'));
        }
      });
      this.post({ type: 'open', bytes }, [bytes.buffer as ArrayBuffer]);
    });
  }

  export(kind: ExportKind): Promise<Uint8Array | string> {
    return this.request({ type: 'export', requestId: 0, kind }).then((msg) => {
      if (msg.type !== 'export' || msg.data === null) {
        throw new Error(msg.type === 'export' && msg.error ? msg.error : 'export failed');
      }
      return msg.data;
    });
  }

  close(): void {
    this.cancelOpen?.(new Error('cancelled'));
    this.cancelOpen = null;
    this.worker?.terminate();
    this.worker = null;
    for (const handler of this.pending.values()) handler({ type: 'error', message: 'closed' });
    this.pending.clear();
  }

  private request(msg: Extract<ToWorker, { requestId: number }>): Promise<FromWorker> {
    if (!this.worker) return Promise.reject(new Error('no document'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.post({ ...msg, requestId });
    });
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }
}
