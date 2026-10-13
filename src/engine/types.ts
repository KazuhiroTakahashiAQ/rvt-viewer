import type { CategoryKey } from '../model/categories';
import type { Projection } from './CameraRig';
import type { VisualStyle } from './modelMaterials';

export type ModelViewKind = '3d' | 'plan' | 'elevation';
export type ElevationDirection = 'north' | 'east' | 'south' | 'west';
export type NavMode = 'select' | 'pan' | 'orbit' | 'zoomRegion';

export interface SectionBoxState {
  enabled: boolean;
  /** World (three.js, metres) min/max; null = fit to the model when enabled. */
  min: [number, number, number] | null;
  max: [number, number, number] | null;
}

export interface PlanRange {
  /** Cut plane height above the level (mm). */
  cutMm: number;
  /** Bottom of the view range relative to the level (mm, usually ≤ 0). */
  bottomMm: number;
}

/** Everything the engine needs to know about the active model view. */
export interface ModelViewConfig {
  id: string;
  kind: ModelViewKind;
  visualStyle: VisualStyle;
  projection: Projection;
  /** Plan views: level elevation in metres (three.js Y). */
  levelElevation?: number;
  planRange?: PlanRange;
  direction?: ElevationDirection;
  sectionBox?: SectionBoxState;
}

export interface CategoryOverride {
  /** `#rrggbb` surface colour. */
  color?: string;
  /** 0..100, Revit-style transparency percentage. */
  transparency?: number;
  halftone?: boolean;
}

export type TempMode = 'none' | 'hide' | 'isolate';

/** Storey index of an element; UNASSIGNED_LEVEL for elements without a level. */
export const UNASSIGNED_LEVEL = -1;

export interface DisplayConfig {
  hiddenCategories: ReadonlySet<CategoryKey>;
  /** Storey indices whose elements are hidden (UNASSIGNED_LEVEL included). */
  hiddenLevels: ReadonlySet<number>;
  hiddenElements: ReadonlySet<number>;
  overrides: Partial<Record<CategoryKey, CategoryOverride>>;
  tempMode: TempMode;
  tempElements: ReadonlySet<number>;
  reveal: boolean;
}

export interface ThemeConfig {
  background: string;
  dark: boolean;
}
