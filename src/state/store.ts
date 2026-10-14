/*
 * Application state: the open document, its views (tabs) and their
 * per-view display settings, the selection, and UI preferences.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Projection } from '../engine/CameraRig';
import type { VisualStyle } from '../engine/modelMaterials';
import { type CategoryOverride, type NavMode, type PlanRange, type SectionBoxState, type TempMode, UNASSIGNED_LEVEL } from '../engine/types';
import { type CategoryKey, hiddenByDefault } from '../model/categories';
import type { ModelIndex } from '../model/modelIndex';
import type { LengthUnit } from '../model/units';
import { type ViewDef, initialViewId, listViews } from '../model/views';
import type { ExportDiagnostics, FileMetadata, IfcModel, Schedule, Summary } from '../wasm/types';
import type { LoadStep, SavedMeshReport } from '../worker/protocol';

export interface LoadedDocument {
  fileName: string;
  fileSize: number;
  summary: Summary | null;
  metadata: FileMetadata | null;
  model: IfcModel;
  diagnostics: ExportDiagnostics;
  schedule: Schedule;
  index: ModelIndex;
  /** Present until the viewer has consumed it. */
  glb: Uint8Array | null;
  hasGeometry: boolean;
  /** Second pass drawing boxed bodies from Revit's saved display meshes. */
  savedMeshes: { status: SavedMeshStatus; report: SavedMeshReport | null };
  /** GLB with the saved meshes, present until the viewer has swapped it in. */
  refinedGlb: Uint8Array | null;
}

export type SavedMeshStatus = 'pending' | 'done' | 'failed' | 'off';

export type LoadErrorCode = 'notRevit' | 'unsupportedVersion' | 'outOfMemory' | 'unknown';

export interface LoadingState {
  fileName: string;
  fileSize: number;
  step: LoadStep;
  startedAt: number;
  summary: Summary | null;
}

export interface ViewSettings {
  visualStyle: VisualStyle;
  projection: Projection;
  sectionBox: SectionBoxState;
  planRange: PlanRange;
  hiddenCategories: CategoryKey[];
  /** Storey indices hidden in this view (UNASSIGNED_LEVEL for elements without a level). */
  hiddenLevels: number[];
  hiddenElements: number[];
  overrides: Partial<Record<CategoryKey, CategoryOverride>>;
  tempMode: TempMode;
  tempElements: number[];
  reveal: boolean;
}

export type DialogId =
  | 'visibilityGraphics'
  | 'selectionFilter'
  | 'projectInfo'
  | 'fileInfo'
  | 'diagnostics'
  | 'units'
  | 'options'
  | 'about';

export type RibbonTab = 'view' | 'manage' | 'modify';
export type ThemePref = 'light' | 'dark' | 'system';
export type BackgroundPref = 'white' | 'black' | 'gray';

export interface Prefs {
  theme: ThemePref;
  background: BackgroundPref;
  lengthUnit: LengthUnit;
  showProperties: boolean;
  showBrowser: boolean;
  showStatusBar: boolean;
  showNavBar: boolean;
  showViewCube: boolean;
  ribbonMinimized: boolean;
  dockWidth: number;
  /** Fraction of the dock height given to the Properties palette. */
  dockSplit: number;
  /** Replace boxed bodies with Revit's saved display meshes after opening. */
  savedMeshes: boolean;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'update';
  message: string;
}

interface State {
  doc: LoadedDocument | null;
  loading: LoadingState | null;
  loadError: { code: LoadErrorCode; detail: string; fileName: string } | null;
  views: ViewDef[];
  openViews: string[];
  activeViewId: string | null;
  viewSettings: Record<string, ViewSettings>;
  selection: number[];
  hover: number | null;
  navMode: NavMode;
  ribbonTab: RibbonTab;
  dialog: DialogId | null;
  appMenuOpen: boolean;
  /** Category shown in the Properties palette when the selection mixes categories. */
  propertiesFilter: CategoryKey | null;
  toasts: Toast[];
  prefs: Prefs;
}

interface Actions {
  startLoading(fileName: string, fileSize: number): void;
  setLoadStep(step: LoadStep): void;
  setLoadSummary(summary: Summary | null): void;
  documentLoaded(doc: LoadedDocument): void;
  loadFailed(code: LoadErrorCode, detail: string): void;
  dismissLoadError(): void;
  closeDocument(): void;
  consumeGlb(): void;
  /** The saved-mesh pass finished: `refined` carries the new model when bodies changed. */
  savedMeshesDone(
    status: Exclude<SavedMeshStatus, 'pending' | 'off'>,
    report: SavedMeshReport | null,
    refined?: { model: IfcModel; index: ModelIndex; glb: Uint8Array },
  ): void;
  consumeRefinedGlb(): void;

  openView(id: string): void;
  activateView(id: string): void;
  closeView(id: string): void;
  closeInactiveViews(): void;
  updateViewSettings(id: string, patch: Partial<ViewSettings>): void;

  select(entities: number[], mode?: 'replace' | 'add' | 'remove'): void;
  clearSelection(): void;
  setHover(entity: number | null): void;
  setNavMode(mode: NavMode): void;
  setPropertiesFilter(cat: CategoryKey | null): void;

  hideInView(target: 'elements' | 'category'): void;
  tempHideIsolate(mode: 'hide' | 'isolate', target: 'elements' | 'category'): void;
  resetTemp(): void;
  toggleReveal(): void;
  /** Hide/show the elements of the given levels in the active view; `only` hides every other level. */
  setLevelsVisible(levels: number[], visible: boolean, only?: boolean): void;
  unhideInView(target: 'elements' | 'category'): void;

  setRibbonTab(tab: RibbonTab): void;
  openDialog(id: DialogId | null): void;
  setAppMenuOpen(open: boolean): void;
  setPrefs(patch: Partial<Prefs>): void;
  pushToast(kind: Toast['kind'], message: string): number;
  dismissToast(id: number): void;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  background: 'white',
  lengthUnit: 'mm',
  showProperties: true,
  showBrowser: true,
  showStatusBar: true,
  showNavBar: true,
  showViewCube: true,
  ribbonMinimized: false,
  dockWidth: 300,
  dockSplit: 0.5,
  savedMeshes: true,
};

export function defaultViewSettings(view: ViewDef): ViewSettings {
  const viewKind = view.kind === 'plan' ? 'plan' : view.kind === 'elevation' ? 'elevation' : '3d';
  const hidden: CategoryKey[] = (['rooms'] as CategoryKey[]).filter((c) => hiddenByDefault(c, viewKind));
  return {
    visualStyle: view.kind === '3d' ? 'shaded' : 'hiddenLine',
    projection: 'ortho',
    sectionBox: { enabled: false, min: null, max: null },
    planRange: { cutMm: 1200, bottomMm: 0 },
    hiddenCategories: hidden,
    hiddenLevels: [],
    hiddenElements: [],
    overrides: {},
    tempMode: 'none',
    tempElements: [],
    reveal: false,
  };
}

let toastSeq = 1;

const initialDocState = {
  doc: null,
  loading: null,
  views: [] as ViewDef[],
  openViews: [] as string[],
  activeViewId: null,
  viewSettings: {} as Record<string, ViewSettings>,
  selection: [] as number[],
  hover: null,
  navMode: 'select' as NavMode,
  propertiesFilter: null,
};

export const useStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      ...initialDocState,
      loadError: null,
      ribbonTab: 'view',
      dialog: null,
      appMenuOpen: false,
      toasts: [],
      prefs: DEFAULT_PREFS,

      startLoading: (fileName, fileSize) =>
        set({
          ...initialDocState,
          loadError: null,
          dialog: null,
          appMenuOpen: false,
          loading: { fileName, fileSize, step: 'init', startedAt: performance.now(), summary: null },
        }),
      setLoadStep: (step) => set((s) => (s.loading ? { loading: { ...s.loading, step } } : {})),
      setLoadSummary: (summary) => set((s) => (s.loading ? { loading: { ...s.loading, summary } } : {})),
      documentLoaded: (doc) => {
        const views = listViews(doc.index);
        const first = doc.hasGeometry ? initialViewId(views) : (views.find((v) => v.kind === 'schedule')?.id ?? initialViewId(views));
        const viewSettings: Record<string, ViewSettings> = {};
        for (const v of views) viewSettings[v.id] = defaultViewSettings(v);
        set({
          doc,
          loading: null,
          loadError: null,
          views,
          viewSettings,
          openViews: [first],
          activeViewId: first,
          selection: [],
          ribbonTab: 'view',
        });
      },
      loadFailed: (code, detail) =>
        set((s) => ({
          ...initialDocState,
          loadError: { code, detail, fileName: s.loading?.fileName ?? '' },
        })),
      dismissLoadError: () => set({ loadError: null }),
      closeDocument: () => set({ ...initialDocState, loadError: null, dialog: null, ribbonTab: 'view' }),
      consumeGlb: () => set((s) => (s.doc ? { doc: { ...s.doc, glb: null } } : {})),
      savedMeshesDone: (status, report, refined) =>
        set((s) => {
          if (!s.doc) return {};
          const doc = { ...s.doc, savedMeshes: { status, report } };
          if (refined) Object.assign(doc, { model: refined.model, index: refined.index, refinedGlb: refined.glb });
          return { doc };
        }),
      consumeRefinedGlb: () => set((s) => (s.doc ? { doc: { ...s.doc, refinedGlb: null } } : {})),

      openView: (id) =>
        set((s) => {
          if (!s.views.some((v) => v.id === id)) return {};
          const openViews = s.openViews.includes(id) ? s.openViews : [...s.openViews, id];
          return { openViews, activeViewId: id, hover: null };
        }),
      activateView: (id) => set({ activeViewId: id, hover: null }),
      closeView: (id) =>
        set((s) => {
          const i = s.openViews.indexOf(id);
          if (i < 0) return {};
          const openViews = s.openViews.filter((v) => v !== id);
          const activeViewId =
            s.activeViewId === id ? (openViews[Math.min(i, openViews.length - 1)] ?? null) : s.activeViewId;
          return { openViews, activeViewId };
        }),
      closeInactiveViews: () =>
        set((s) => ({ openViews: s.activeViewId ? [s.activeViewId] : [] })),
      updateViewSettings: (id, patch) =>
        set((s) => {
          const cur = s.viewSettings[id];
          if (!cur) return {};
          return { viewSettings: { ...s.viewSettings, [id]: { ...cur, ...patch } } };
        }),

      select: (entities, mode = 'replace') =>
        set((s) => {
          let next: number[];
          if (mode === 'replace') next = [...new Set(entities)];
          else if (mode === 'add') next = [...new Set([...s.selection, ...entities])];
          else {
            const drop = new Set(entities);
            next = s.selection.filter((e) => !drop.has(e));
          }
          return { selection: next, propertiesFilter: null, ribbonTab: next.length > 0 ? 'modify' : s.ribbonTab === 'modify' ? 'view' : s.ribbonTab };
        }),
      clearSelection: () =>
        set((s) => ({ selection: [], propertiesFilter: null, ribbonTab: s.ribbonTab === 'modify' ? 'view' : s.ribbonTab })),
      setHover: (entity) => set((s) => (s.hover === entity ? {} : { hover: entity })),
      setNavMode: (navMode) => set({ navMode }),
      setPropertiesFilter: (propertiesFilter) => set({ propertiesFilter }),

      hideInView: (target) => {
        const s = get();
        const id = s.activeViewId;
        const vs = id ? s.viewSettings[id] : undefined;
        if (!id || !vs || !s.doc || s.selection.length === 0) return;
        if (target === 'elements') {
          get().updateViewSettings(id, { hiddenElements: [...new Set([...vs.hiddenElements, ...s.selection])] });
        } else {
          const cats = selectionCategories(s.doc.index, s.selection);
          get().updateViewSettings(id, { hiddenCategories: [...new Set([...vs.hiddenCategories, ...cats])] });
        }
        get().clearSelection();
      },
      unhideInView: (target) => {
        const s = get();
        const id = s.activeViewId;
        const vs = id ? s.viewSettings[id] : undefined;
        if (!id || !vs || !s.doc || s.selection.length === 0) return;
        if (target === 'elements') {
          const drop = new Set(s.selection);
          get().updateViewSettings(id, { hiddenElements: vs.hiddenElements.filter((e) => !drop.has(e)) });
        } else {
          const drop = new Set(selectionCategories(s.doc.index, s.selection));
          get().updateViewSettings(id, { hiddenCategories: vs.hiddenCategories.filter((c) => !drop.has(c)) });
        }
      },
      tempHideIsolate: (mode, target) => {
        const s = get();
        const id = s.activeViewId;
        if (!id || !s.doc || s.selection.length === 0) return;
        let elements = s.selection;
        if (target === 'category') {
          const cats = new Set(selectionCategories(s.doc.index, s.selection));
          elements = s.doc.index.elements.filter((e) => cats.has(e.category)).map((e) => e.index);
        }
        get().updateViewSettings(id, { tempMode: mode, tempElements: elements });
        get().clearSelection();
      },
      resetTemp: () => {
        const id = get().activeViewId;
        if (id) get().updateViewSettings(id, { tempMode: 'none', tempElements: [] });
      },
      toggleReveal: () => {
        const s = get();
        const id = s.activeViewId;
        const vs = id ? s.viewSettings[id] : undefined;
        if (id && vs) get().updateViewSettings(id, { reveal: !vs.reveal });
      },

      setLevelsVisible: (levels, visible, only = false) => {
        const s = get();
        const id = s.activeViewId;
        const vs = activeSettings(s);
        if (!id || !vs || !s.doc) return;
        let hidden: number[];
        if (only) {
          const keep = new Set(levels);
          hidden = levelKeys(s.doc.index).filter((l) => !keep.has(l));
        } else if (visible) {
          const drop = new Set(levels);
          hidden = vs.hiddenLevels.filter((l) => !drop.has(l));
        } else {
          hidden = [...new Set([...vs.hiddenLevels, ...levels])];
        }
        get().updateViewSettings(id, { hiddenLevels: hidden });
      },

      setRibbonTab: (ribbonTab) => set({ ribbonTab }),
      openDialog: (dialog) => set({ dialog, appMenuOpen: false }),
      setAppMenuOpen: (appMenuOpen) => set({ appMenuOpen }),
      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
      pushToast: (kind, message) => {
        const id = toastSeq++;
        set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
        return id;
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: 'rvt-viewer:prefs',
      version: 1,
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => ({
        ...current,
        prefs: { ...DEFAULT_PREFS, ...((persisted as { prefs?: Partial<Prefs> } | undefined)?.prefs ?? {}) },
      }),
    },
  ),
);

/** Level keys present in the model: storey indices, plus UNASSIGNED_LEVEL when some element has none. */
export function levelKeys(index: ModelIndex): number[] {
  const keys: number[] = index.storeys.map((s) => s.index);
  if (index.elements.some((e) => e.storeyIndex === null)) keys.push(UNASSIGNED_LEVEL);
  return keys;
}

export function selectionCategories(index: ModelIndex, selection: number[]): CategoryKey[] {
  const cats = new Set<CategoryKey>();
  for (const e of selection) {
    const rec = index.byIndex.get(e);
    if (rec) cats.add(rec.category);
  }
  return [...cats];
}

export const activeView = (s: State): ViewDef | null => s.views.find((v) => v.id === s.activeViewId) ?? null;
export const activeSettings = (s: State): ViewSettings | null =>
  s.activeViewId ? (s.viewSettings[s.activeViewId] ?? null) : null;
