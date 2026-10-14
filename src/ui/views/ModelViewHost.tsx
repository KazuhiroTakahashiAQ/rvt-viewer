import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyTempToView,
  selectAllInstances,
  selectionBox,
  showPalette,
  zoomExtents,
  zoomPrevious,
  zoomSelection,
} from '../../app/commands';
import { setViewer } from '../../app/viewerBridge';
import { Viewer } from '../../engine/Viewer';
import { type DisplayConfig, type ModelViewConfig, UNASSIGNED_LEVEL } from '../../engine/types';
import { FEET_TO_METRES } from '../../model/units';
import { elementLabel } from '../../model/properties';
import { type ViewSettings, useStore } from '../../state/store';
import type { ViewDef } from '../../model/views';
import { ContextMenu, type MenuItem } from '../common/Menu';
import { useEffectiveTheme } from '../useTheme';

const BACKGROUNDS = { white: '#ffffff', black: '#1b1d21', gray: '#c8cbd0' } as const;

function toViewConfig(view: ViewDef, settings: ViewSettings, levelFeet: number | undefined): ModelViewConfig {
  return {
    id: view.id,
    kind: view.kind === 'schedule' ? '3d' : view.kind,
    visualStyle: settings.visualStyle,
    projection: view.kind === '3d' ? settings.projection : 'ortho',
    levelElevation: levelFeet !== undefined ? levelFeet * FEET_TO_METRES : undefined,
    planRange: settings.planRange,
    direction: view.direction,
    sectionBox: settings.sectionBox,
  };
}

function toDisplay(settings: ViewSettings): DisplayConfig {
  return {
    hiddenCategories: new Set(settings.hiddenCategories),
    hiddenLevels: new Set(settings.hiddenLevels),
    hiddenElements: new Set(settings.hiddenElements),
    overrides: settings.overrides,
    tempMode: settings.tempMode,
    tempElements: new Set(settings.tempElements),
    reveal: settings.reveal,
  };
}

/** Hosts the single WebGL Viewer and keeps it in sync with the store. */
export function ModelViewHost({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const tooltipTimer = useRef<number | null>(null);

  const doc = useStore((s) => s.doc);
  const views = useStore((s) => s.views);
  const activeViewId = useStore((s) => s.activeViewId);
  const viewSettings = useStore((s) => s.viewSettings);
  const selection = useStore((s) => s.selection);
  const prefs = useStore((s) => s.prefs);
  const theme = useEffectiveTheme();

  const view = views.find((v) => v.id === activeViewId);
  const modelView = view && view.kind !== 'schedule' ? view : undefined;
  const settings = modelView ? viewSettings[modelView.id] : undefined;

  // Create the viewer once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewer = new Viewer(
      host,
      {
        top: t('viewCube.top'),
        bottom: t('viewCube.bottom'),
        front: t('viewCube.front'),
        back: t('viewCube.back'),
        left: t('viewCube.left'),
        right: t('viewCube.right'),
        north: t('viewCube.north'),
        east: t('viewCube.east'),
        south: t('viewCube.south'),
        west: t('viewCube.west'),
      },
      {
        onSelect: ({ entity, mode }) => {
          const s = useStore.getState();
          if (entity === null) {
            if (mode === 'replace') s.clearSelection();
            return;
          }
          s.select([entity], mode);
        },
        onBoxSelect: ({ entities, mode }) => {
          const s = useStore.getState();
          if (entities.length === 0 && mode === 'replace') s.clearSelection();
          else s.select(entities, mode);
        },
        onHover: (entity, x, y) => {
          const s = useStore.getState();
          s.setHover(entity);
          if (tooltipTimer.current) window.clearTimeout(tooltipTimer.current);
          setTooltip(null);
          if (entity === null || !s.doc) return;
          const rec = s.doc.index.byIndex.get(entity);
          if (!rec) return;
          const text = elementLabel(rec, t);
          tooltipTimer.current = window.setTimeout(() => setTooltip({ x, y, text }), 650);
        },
        onContextMenu: (x, y, entity) => {
          const s = useStore.getState();
          if (entity !== null && !s.selection.includes(entity)) s.select([entity]);
          setTooltip(null);
          setMenu({ x, y, items: buildViewMenu() });
        },
        onViewCubeMenu: (x, y) => setMenu({ x, y, items: buildViewCubeMenu() }),
        onSectionBoxChange: (viewId, box) => useStore.getState().updateViewSettings(viewId, { sectionBox: box }),
        onNavModeChange: (mode) => useStore.getState().setNavMode(mode),
      },
    );
    viewerRef.current = viewer;
    setViewer(viewer);
    return () => {
      setViewer(null);
      viewer.dispose();
      viewerRef.current = null;
    };
    // The viewer lives as long as this host; ViewCube labels are fixed at creation.
  }, []);

  // Load geometry when a document arrives.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !doc) return;
    if (!doc.glb) return;
    const glb = doc.glb;
    const index = doc.index;
    setReady(false);
    useStore.getState().consumeGlb();
    void viewer
      .loadModel(glb, doc.model.entities.length, {
        categoryOf: (e) => index.byIndex.get(e)?.category,
        levelOf: (e) => index.byIndex.get(e)?.storeyIndex ?? UNASSIGNED_LEVEL,
      })
      .then(() => setReady(true))
      .catch((err: unknown) => {
        useStore.getState().pushToast('error', t('error.geometry', { detail: err instanceof Error ? err.message : String(err) }));
      });
  }, [doc, t]);

  // Saved display meshes arrive after the boxed model: swap the bodies in place.
  const refinedGlb = doc?.refinedGlb ?? null;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready || !refinedGlb) return;
    useStore.getState().consumeRefinedGlb();
    void viewer.replaceGeometry(refinedGlb).catch((err: unknown) => {
      useStore.getState().pushToast('error', t('error.geometry', { detail: err instanceof Error ? err.message : String(err) }));
    });
  }, [ready, refinedGlb, t]);

  // Active view → camera, clipping, style.
  const levelFeet = modelView?.storeyIndex !== undefined ? doc?.index.storeys[modelView.storeyIndex]?.elevationFeet : undefined;
  const config = useMemo(
    () => (modelView && settings ? toViewConfig(modelView, settings, levelFeet) : null),
    [modelView, settings?.visualStyle, settings?.projection, settings?.planRange, settings?.sectionBox, levelFeet],
  );
  useEffect(() => {
    if (ready && config) viewerRef.current?.setView(config);
  }, [ready, config]);

  const display = useMemo(
    () => (settings ? toDisplay(settings) : null),
    [settings?.hiddenCategories, settings?.hiddenLevels, settings?.hiddenElements, settings?.overrides, settings?.tempMode, settings?.tempElements, settings?.reveal],
  );
  useEffect(() => {
    if (ready && display && config) viewerRef.current?.applyDisplay(display);
  }, [ready, display, config]);

  useEffect(() => {
    if (ready) viewerRef.current?.setSelection(selection);
  }, [ready, selection]);

  useEffect(() => {
    viewerRef.current?.setTheme({ background: BACKGROUNDS[prefs.background], dark: theme === 'dark' || prefs.background === 'black' });
  }, [prefs.background, theme]);

  useEffect(() => {
    viewerRef.current?.setViewCubeVisible(prefs.showViewCube);
  }, [prefs.showViewCube]);

  function buildViewMenu(): MenuItem[] {
    const s = useStore.getState();
    const has = s.selection.length > 0;
    const vs = s.activeViewId ? s.viewSettings[s.activeViewId] : undefined;
    const is3d = s.views.find((v) => v.id === s.activeViewId)?.kind === '3d';
    const items: MenuItem[] = [
      { id: 'cancel', label: t('command.cancel'), disabled: !has, onSelect: () => s.clearSelection() },
      { id: 's1', separator: true },
      {
        id: 'hide',
        label: t('command.hideInView'),
        disabled: !has,
        submenu: [
          { id: 'el', label: t('command.hideElementsInView'), onSelect: () => s.hideInView('elements') },
          { id: 'cat', label: t('command.hideCategoryInView'), onSelect: () => s.hideInView('category') },
        ],
      },
      {
        id: 'temp',
        label: t('command.tempHideIsolate'),
        submenu: [
          { id: 'isoCat', label: t('command.isolateCategory'), disabled: !has, onSelect: () => s.tempHideIsolate('isolate', 'category') },
          { id: 'hideCat', label: t('command.hideCategory'), disabled: !has, onSelect: () => s.tempHideIsolate('hide', 'category') },
          { id: 'isoEl', label: t('command.isolateElements'), disabled: !has, onSelect: () => s.tempHideIsolate('isolate', 'elements') },
          { id: 'hideEl', label: t('command.hideElements'), disabled: !has, onSelect: () => s.tempHideIsolate('hide', 'elements') },
          { id: 'sep', separator: true },
          { id: 'reset', label: t('command.resetTemp'), disabled: vs?.tempMode === 'none', onSelect: () => s.resetTemp() },
          { id: 'apply', label: t('command.applyTempToView'), disabled: vs?.tempMode === 'none', onSelect: applyTempToView },
        ],
      },
      {
        id: 'selectAll',
        label: t('command.selectAllInstances'),
        disabled: !has,
        submenu: [
          { id: 'view', label: t('command.visibleInView'), onSelect: () => selectAllInstances('view') },
          { id: 'project', label: t('command.inEntireProject'), onSelect: () => selectAllInstances('project') },
        ],
      },
      { id: 's2', separator: true },
      { id: 'zoomSel', label: t('command.zoomSelection'), disabled: !has, onSelect: zoomSelection },
      { id: 'zoomAll', label: t('command.zoomExtents'), onSelect: zoomExtents },
      { id: 'zoomPrev', label: t('command.zoomPrevious'), onSelect: zoomPrevious },
    ];
    if (is3d) items.push({ id: 'selBox', label: t('command.selectionBox'), disabled: !has, onSelect: selectionBox });
    items.push({ id: 's3', separator: true }, { id: 'props', label: t('ui.properties'), onSelect: () => showPalette('properties') });
    return items;
  }

  function buildViewCubeMenu(): MenuItem[] {
    const s = useStore.getState();
    const id = s.activeViewId;
    const vs = id ? s.viewSettings[id] : undefined;
    const viewer = viewerRef.current;
    return [
      { id: 'home', label: t('viewCube.goHome'), onSelect: () => viewer?.goHome() },
      { id: 'setHome', label: t('viewCube.setHome'), onSelect: () => viewer?.setCurrentAsHome() },
      { id: 's', separator: true },
      {
        id: 'ortho',
        label: t('projection.ortho'),
        checked: vs?.projection === 'ortho',
        onSelect: () => id && s.updateViewSettings(id, { projection: 'ortho' }),
      },
      {
        id: 'persp',
        label: t('projection.perspective'),
        checked: vs?.projection === 'perspective',
        onSelect: () => id && s.updateViewSettings(id, { projection: 'perspective' }),
      },
      { id: 's2', separator: true },
      { id: 'fit', label: t('command.zoomExtents'), onSelect: zoomExtents },
    ];
  }

  const tempActive = settings && settings.tempMode !== 'none';
  return (
    <div
      className={`model-view${visible ? '' : ' hidden'}${tempActive ? ' temp-active' : ''}${settings?.reveal ? ' reveal-active' : ''}`}
      ref={hostRef}
    >
      {tempActive ? <div className="view-frame-label temp">{t('viewFrame.temp')}</div> : null}
      {settings?.reveal ? <div className="view-frame-label reveal">{t('viewFrame.reveal')}</div> : null}
      {tooltip ? (
        <div className="hover-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 18, position: 'fixed' }}>
          {tooltip.text}
        </div>
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

