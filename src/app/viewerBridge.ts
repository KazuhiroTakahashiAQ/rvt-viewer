import type { Viewer } from '../engine/Viewer';

/** The live model viewer, for commands issued from the ribbon and menus. */
let current: Viewer | null = null;

export function setViewer(viewer: Viewer | null): void {
  current = viewer;
}

export function getViewer(): Viewer | null {
  return current;
}
