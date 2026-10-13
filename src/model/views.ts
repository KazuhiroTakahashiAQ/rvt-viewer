/*
 * The views a document offers, as in Revit's Project Browser:
 * floor plans per level, the default 3D view, the four building elevations
 * and the schedules.
 */

import type { ElevationDirection } from '../engine/types';
import type { ModelIndex } from './modelIndex';

export type ViewKind = '3d' | 'plan' | 'elevation' | 'schedule';
export type ScheduleKind = 'elements' | 'rooms';

export interface ViewDef {
  id: string;
  kind: ViewKind;
  storeyIndex?: number;
  direction?: ElevationDirection;
  schedule?: ScheduleKind;
}

export const DEFAULT_3D_VIEW_ID = '3d';
export const ELEVATION_DIRECTIONS: ElevationDirection[] = ['east', 'north', 'south', 'west'];

export function planViewId(storeyIndex: number): string {
  return `plan:${storeyIndex}`;
}

export function listViews(index: ModelIndex): ViewDef[] {
  const views: ViewDef[] = [];
  const storeys = [...index.storeys].sort((a, b) => a.elevationFeet - b.elevationFeet);
  for (const s of storeys) views.push({ id: planViewId(s.index), kind: 'plan', storeyIndex: s.index });
  views.push({ id: DEFAULT_3D_VIEW_ID, kind: '3d' });
  for (const d of ELEVATION_DIRECTIONS) views.push({ id: `elev:${d}`, kind: 'elevation', direction: d });
  views.push({ id: 'schedule:elements', kind: 'schedule', schedule: 'elements' });
  if (index.categories.some((c) => c.key === 'rooms')) {
    views.push({ id: 'schedule:rooms', kind: 'schedule', schedule: 'rooms' });
  }
  return views;
}

/** The view opened first: the 3D view when there is geometry. */
export function initialViewId(views: ViewDef[]): string {
  return views.find((v) => v.kind === '3d')?.id ?? views[0]?.id ?? DEFAULT_3D_VIEW_ID;
}
