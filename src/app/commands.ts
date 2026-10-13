/*
 * UI actions shared by the ribbon, menus, navigation bar and palettes.
 */

import { activeSettings, activeView, useStore } from '../state/store';
import { DEFAULT_3D_VIEW_ID } from '../model/views';
import { getViewer } from './viewerBridge';

const store = () => useStore.getState();

export function openDefault3D(): void {
  store().openView(DEFAULT_3D_VIEW_ID);
}

export function zoomExtents(): void {
  getViewer()?.zoomExtents();
}

export function zoomSelection(): void {
  const sel = store().selection;
  if (sel.length) getViewer()?.zoomToEntities(sel);
}

export function zoomOut(): void {
  getViewer()?.zoomOut();
}

export function zoomPrevious(): void {
  getViewer()?.zoomPrevious();
}

export function startZoomRegion(): void {
  getViewer()?.setNavMode('zoomRegion');
}

export function toggleSectionBox(): void {
  const s = store();
  const view = activeView(s);
  const vs = activeSettings(s);
  if (!view || view.kind !== '3d' || !vs) return;
  s.updateViewSettings(view.id, { sectionBox: { ...vs.sectionBox, enabled: !vs.sectionBox.enabled } });
}

/** Revit "選択ボックス": section box around the selection, in the 3D view. */
export function selectionBox(): void {
  const s = store();
  const viewer = getViewer();
  if (!viewer || s.selection.length === 0) return;
  const box = viewer.sectionBoxAround(s.selection);
  if (!box) return;
  const target = activeView(s)?.kind === '3d' ? s.activeViewId! : DEFAULT_3D_VIEW_ID;
  s.updateViewSettings(target, { sectionBox: box });
  s.openView(target);
  requestAnimationFrame(() => getViewer()?.zoomToEntities(store().selection));
}

/** Select every element of the same family and type as the selection. */
export function selectAllInstances(scope: 'view' | 'project'): void {
  const s = store();
  const doc = s.doc;
  if (!doc || s.selection.length === 0) return;
  const keys = new Set<string>();
  for (const e of s.selection) {
    const r = doc.index.byIndex.get(e);
    if (r) keys.add(`${r.category}\u0000${r.familyName}\u0000${r.typeName}`);
  }
  let candidates = doc.index.elements.filter((r) => keys.has(`${r.category}\u0000${r.familyName}\u0000${r.typeName}`)).map((r) => r.index);
  if (scope === 'view') {
    const visible = new Set(getViewer()?.visibleEntities() ?? []);
    candidates = candidates.filter((e) => visible.has(e));
  }
  s.select(candidates, 'replace');
}

export function selectElements(entities: number[], scope: 'view' | 'project'): void {
  let list = entities;
  if (scope === 'view') {
    const visible = new Set(getViewer()?.visibleEntities() ?? []);
    list = entities.filter((e) => visible.has(e));
  }
  store().select(list, 'replace');
}

/** Turns a temporary hide/isolate into permanent view visibility. */
export function applyTempToView(): void {
  const s = store();
  const id = s.activeViewId;
  const vs = activeSettings(s);
  if (!id || !vs || vs.tempMode === 'none' || !s.doc) return;
  let hide: number[];
  if (vs.tempMode === 'hide') {
    hide = vs.tempElements;
  } else {
    const keep = new Set(vs.tempElements);
    hide = s.doc.index.elements.map((r) => r.index).filter((e) => !keep.has(e));
  }
  s.updateViewSettings(id, {
    hiddenElements: [...new Set([...vs.hiddenElements, ...hide])],
    tempMode: 'none',
    tempElements: [],
  });
}

export function showPalette(which: 'properties' | 'browser'): void {
  store().setPrefs(which === 'properties' ? { showProperties: true } : { showBrowser: true });
}
