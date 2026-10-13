/*
 * IFC entity types (as rvt-rs exports them) → Revit-style model categories.
 * Display names live in the i18n catalog under `category.<key>`.
 */

export type CategoryKey =
  | 'walls'
  | 'curtainWalls'
  | 'curtainPanels'
  | 'curtainMullions'
  | 'floors'
  | 'roofs'
  | 'ceilings'
  | 'doors'
  | 'windows'
  | 'columns'
  | 'structuralFraming'
  | 'structuralFoundations'
  | 'stairs'
  | 'ramps'
  | 'railings'
  | 'furniture'
  | 'rooms'
  | 'plumbingFixtures'
  | 'electricalEquipment'
  | 'lightingFixtures'
  | 'pipes'
  | 'pipeFittings'
  | 'ducts'
  | 'ductFittings'
  | 'airTerminals'
  | 'fireAlarmDevices'
  | 'mechanicalEquipment'
  | 'specialtyEquipment'
  | 'shadingDevices'
  | 'rebar'
  | 'genericModels';

const BY_IFC_TYPE: Record<string, CategoryKey> = {
  IFCWALL: 'walls',
  IFCWALLSTANDARDCASE: 'walls',
  IFCCURTAINWALL: 'curtainWalls',
  IFCPLATE: 'curtainPanels',
  IFCMEMBER: 'curtainMullions',
  IFCSLAB: 'floors',
  IFCROOF: 'roofs',
  IFCCOVERING: 'ceilings',
  IFCCEILING: 'ceilings',
  IFCDOOR: 'doors',
  IFCWINDOW: 'windows',
  IFCCOLUMN: 'columns',
  IFCBEAM: 'structuralFraming',
  IFCFOOTING: 'structuralFoundations',
  IFCSTAIR: 'stairs',
  IFCSTAIRFLIGHT: 'stairs',
  IFCRAMP: 'ramps',
  IFCRAMPFLIGHT: 'ramps',
  IFCRAILING: 'railings',
  IFCFURNITURE: 'furniture',
  IFCFURNISHINGELEMENT: 'furniture',
  IFCSPACE: 'rooms',
  IFCSANITARYTERMINAL: 'plumbingFixtures',
  IFCELECTRICAPPLIANCE: 'electricalEquipment',
  IFCLIGHTFIXTURE: 'lightingFixtures',
  IFCPIPESEGMENT: 'pipes',
  IFCPIPEFITTING: 'pipeFittings',
  IFCDUCTSEGMENT: 'ducts',
  IFCDUCTFITTING: 'ductFittings',
  IFCAIRTERMINAL: 'airTerminals',
  IFCALARM: 'fireAlarmDevices',
  IFCFLOWTERMINAL: 'mechanicalEquipment',
  IFCFLOWSEGMENT: 'pipes',
  IFCFLOWFITTING: 'pipeFittings',
  IFCFLOWCONTROLLER: 'mechanicalEquipment',
  IFCDISTRIBUTIONCONTROLELEMENT: 'mechanicalEquipment',
  IFCTRANSPORTELEMENT: 'specialtyEquipment',
  IFCSHADINGDEVICE: 'shadingDevices',
  IFCREINFORCINGBAR: 'rebar',
  IFCBUILDINGELEMENTPROXY: 'genericModels',
};

/** Order of categories in lists (Visibility/Graphics, filters, browser). */
export const CATEGORY_ORDER: CategoryKey[] = [
  'walls',
  'curtainWalls',
  'curtainPanels',
  'curtainMullions',
  'floors',
  'roofs',
  'ceilings',
  'doors',
  'windows',
  'columns',
  'structuralFraming',
  'structuralFoundations',
  'stairs',
  'ramps',
  'railings',
  'furniture',
  'rooms',
  'plumbingFixtures',
  'electricalEquipment',
  'lightingFixtures',
  'mechanicalEquipment',
  'airTerminals',
  'ducts',
  'ductFittings',
  'pipes',
  'pipeFittings',
  'fireAlarmDevices',
  'specialtyEquipment',
  'shadingDevices',
  'rebar',
  'genericModels',
];

export function categoryOf(ifcType: string): CategoryKey {
  return BY_IFC_TYPE[ifcType.toUpperCase()] ?? 'genericModels';
}

export function categoryRank(key: CategoryKey): number {
  const i = CATEGORY_ORDER.indexOf(key);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/**
 * Pick priority: lower wins when several elements are under the cursor.
 * Rooms are volumes you look *through*, so they only win when nothing else
 * is hit (as in Revit, where rooms are picked by their interior/boundary).
 */
export function pickPriority(key: CategoryKey): number {
  return key === 'rooms' ? 1 : 0;
}

/** Categories Revit hides by default in a given view kind. */
export function hiddenByDefault(key: CategoryKey, viewKind: 'plan' | '3d' | 'elevation'): boolean {
  if (key === 'rooms') return viewKind !== 'plan';
  return false;
}
