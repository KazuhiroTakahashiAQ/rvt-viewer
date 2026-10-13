/*
 * Builds the Properties palette content for selected elements, grouped like
 * Revit (識別情報 / 拘束 / 寸法 / マテリアルと仕上げ / 関係 / その他 …).
 * Lengths are converted from feet to the display unit.
 */

import type { IfcModel, PropertySet, PropertyValue } from '../wasm/types';
import { type ElementRecord, type ModelIndex, findProperty } from './modelIndex';
import {
  type LengthUnit,
  formatAngle,
  formatArea,
  formatLength,
  formatNumber,
  formatVolume,
} from './units';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface PropLink {
  entity: number;
  label: string;
}

export interface PropRow {
  key: string;
  label: string;
  value: string;
  links?: PropLink[];
}

export interface PropGroup {
  id: string;
  title: string;
  rows: PropRow[];
  /** Collapsed by default (decoder details). */
  collapsed?: boolean;
}

export interface FormatContext {
  unit: LengthUnit;
  locale: string;
  t: Translate;
}

/** Decoder bookkeeping in rvt-rs' main property set, shown under 読込情報. */
const INTERNAL_PROPS = new Set([
  'BodySource',
  'ProfileResolved',
  'LevelBindResolved',
  'BoundingBoxHeight',
  'LevelElementId',
  'LevelBindSource',
  'ThicknessResolved',
  'Thickness',
  'ThicknessSource',
  'JoinStartWallElementId',
  'JoinStartRunsThrough',
  'JoinEndWallElementId',
  'JoinEndRunsThrough',
  'JoinTrimStart',
  'JoinTrimEnd',
  'SourceStream',
  'RevitClass',
  'FamilyName',
  'FamilyNameSource',
  'TypeName',
  'StoreyBindSource',
  'ProfileSource',
  'ProfileVertexCount',
  'ProfileVoidCount',
  'ElementId',
  'RoomNumber',
  'RoomName',
]);

/** Well-known Revit parameter names (as stored in English files) → i18n keys. */
const KNOWN_PARAMS: Record<string, string> = {
  'Type Mark': 'param.typeMark',
  Mark: 'param.mark',
  Comments: 'param.comments',
  'Fire Rating': 'param.fireRating',
  Description: 'param.description',
  Manufacturer: 'param.manufacturer',
  Model: 'param.model',
  'Assembly Code': 'param.assemblyCode',
  'Type Comments': 'param.typeComments',
  Cost: 'param.cost',
  URL: 'param.url',
  Function: 'param.function',
  Reference: 'param.reference',
  IsExternal: 'param.isExternal',
  LoadBearing: 'param.loadBearing',
};

export function formatPropertyValue(value: PropertyValue | undefined, ctx: FormatContext): string {
  if (!value) return '';
  switch (value.kind) {
    case 'Text':
    case 'Label':
    case 'Identifier':
      return value.value;
    case 'Integer':
    case 'CountValue':
      return String(value.value);
    case 'Real':
      return formatNumber(value.value, ctx.locale, 3);
    case 'LengthFeet':
    case 'PositiveLengthFeet':
      return formatLength(value.value, ctx.unit, ctx.locale);
    case 'AngleRadians':
      return `${formatAngle(value.value, ctx.locale)}°`;
    case 'AreaSquareFeet':
      return `${formatArea(value.value, ctx.locale)} m²`;
    case 'VolumeCubicFeet':
      return `${formatVolume(value.value, ctx.locale)} m³`;
    case 'TimeSeconds':
      return formatNumber(value.value, ctx.locale, 1);
    case 'MassPounds':
      return `${formatNumber(value.value * 0.45359237, ctx.locale, 2)} kg`;
    case 'Boolean':
      return ctx.t(value.value ? 'value.yes' : 'value.no');
    case 'Logical':
      return value.value === undefined ? ctx.t('value.unknown') : ctx.t(value.value ? 'value.yes' : 'value.no');
    case 'List':
      return value.value.map((v) => formatPropertyValue(v, ctx)).join(', ');
    case 'Enumerated':
      return value.value.join(', ');
  }
}

export function paramLabel(name: string, t: Translate): string {
  const key = KNOWN_PARAMS[name];
  return key ? t(key) : name;
}

export function polygonArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(points: [number, number][]): number {
  let p = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}

function profilePoints(rec: ElementRecord): [number, number][] | null {
  const po = rec.entity.extrusion?.profile_override as { ArbitraryClosed?: { points: [number, number][] } } | undefined;
  return po?.ArbitraryClosed?.points ?? null;
}

/** Room area/perimeter/volume in square feet / feet / cubic feet. */
export function roomMeasures(rec: ElementRecord): { area: number; perimeter: number; volume: number } | null {
  const ex = rec.entity.extrusion;
  if (!ex) return null;
  const pts = profilePoints(rec);
  const area = pts ? polygonArea(pts) : ex.width_feet * ex.depth_feet;
  const perimeter = pts ? polygonPerimeter(pts) : 2 * (ex.width_feet + ex.depth_feet);
  return { area, perimeter, volume: area * ex.height_feet };
}

/** Material names of an element: its own material, else its layers'. */
export function materialNames(model: IfcModel, rec: ElementRecord): string[] {
  const e = rec.entity;
  if (e.material_index !== undefined) {
    const name = model.materials[e.material_index]?.name;
    return name ? [name] : [];
  }
  const set = e.material_layer_set_index !== undefined ? model.material_layer_sets[e.material_layer_set_index] : undefined;
  const names = new Set<string>();
  for (const layer of set?.layers ?? []) {
    const name = layer.material_index !== undefined ? model.materials[layer.material_index]?.name : layer.name;
    if (name) names.add(name);
  }
  return [...names];
}

export function categoryLabel(rec: ElementRecord, t: Translate): string {
  return t(`category.${rec.category}`);
}

/** Short element label for links and tooltips: `カテゴリ : ファミリ : タイプ`. */
export function elementLabel(rec: ElementRecord, t: Translate): string {
  if (rec.category === 'rooms') {
    const room = [rec.roomNumber, rec.roomName].filter(Boolean).join(' ');
    return `${categoryLabel(rec, t)} : ${room || rec.elementId}`;
  }
  const parts = [categoryLabel(rec, t), rec.familyName, rec.typeName].filter(Boolean);
  return parts.join(' : ');
}

function link(index: ModelIndex, entity: number, t: Translate): PropLink | null {
  const rec = index.byIndex.get(entity);
  return rec ? { entity, label: `${elementLabel(rec, t)} [${rec.elementId}]` } : null;
}

export function buildElementProperties(
  index: ModelIndex,
  model: IfcModel,
  entity: number,
  ctx: FormatContext,
): PropGroup[] {
  const rec = index.byIndex.get(entity);
  if (!rec) return [];
  const { t, unit, locale } = ctx;
  const e = rec.entity;
  const pset = e.property_set;
  const len = (feet: number | undefined) => (feet === undefined ? '' : formatLength(feet, unit, locale));
  const groups: PropGroup[] = [];

  // 識別情報
  const identity: PropRow[] = [{ key: 'category', label: t('prop.category'), value: categoryLabel(rec, t) }];
  if (rec.category === 'rooms') {
    identity.push({ key: 'roomNumber', label: t('prop.roomNumber'), value: rec.roomNumber ?? '' });
    identity.push({ key: 'roomName', label: t('prop.roomName'), value: rec.roomName ?? '' });
  } else {
    identity.push({ key: 'family', label: t('prop.family'), value: rec.familyName });
    identity.push({ key: 'type', label: t('prop.type'), value: rec.typeName });
  }
  identity.push({ key: 'elementId', label: t('prop.elementId'), value: rec.elementId });
  if (rec.globalId) identity.push({ key: 'globalId', label: t('prop.globalId'), value: rec.globalId });
  identity.push({
    key: 'ifcClass',
    label: t('prop.ifcClass'),
    value: e.predefined_type && e.predefined_type !== 'NOTDEFINED' ? `${e.ifc_type}.${e.predefined_type}` : e.ifc_type,
  });
  const revitClass = findProperty(pset, 'RevitClass');
  if (revitClass) identity.push({ key: 'revitClass', label: t('prop.revitClass'), value: formatPropertyValue(revitClass, ctx) });
  groups.push({ id: 'identity', title: t('propGroup.identity'), rows: identity });

  // 拘束
  const constraints: PropRow[] = [];
  const storey = rec.storeyIndex !== null ? index.storeys[rec.storeyIndex] : undefined;
  constraints.push({ key: 'level', label: t('prop.level'), value: storey?.name ?? t('value.unassigned') });
  if (storey) {
    constraints.push({ key: 'levelElevation', label: t('prop.levelElevation'), value: len(storey.elevationFeet) });
    if (e.location_feet) {
      constraints.push({ key: 'baseOffset', label: t('prop.baseOffset'), value: len(e.location_feet[2] - storey.elevationFeet) });
    }
  }
  if (e.host_element_index !== undefined) {
    const l = link(index, e.host_element_index, t);
    constraints.push({ key: 'host', label: t('prop.host'), value: l?.label ?? '', links: l ? [l] : undefined });
  }
  groups.push({ id: 'constraints', title: t('propGroup.constraints'), rows: constraints });

  // 寸法
  const dims: PropRow[] = [];
  const ex = e.extrusion;
  if (ex) {
    if (rec.category === 'walls' || rec.category === 'curtainWalls') {
      dims.push({ key: 'length', label: t('prop.length'), value: len(ex.width_feet) });
      dims.push({ key: 'thickness', label: t('prop.thickness'), value: len(ex.depth_feet) });
      dims.push({ key: 'height', label: t('prop.unconnectedHeight'), value: len(ex.height_feet) });
    } else if (rec.category === 'rooms') {
      const m = roomMeasures(rec);
      if (m) {
        dims.push({ key: 'area', label: t('prop.area'), value: `${formatArea(m.area, locale)} m²` });
        dims.push({ key: 'perimeter', label: t('prop.perimeter'), value: len(m.perimeter) });
        dims.push({ key: 'height', label: t('prop.unboundedHeight'), value: len(ex.height_feet) });
        dims.push({ key: 'volume', label: t('prop.volume'), value: `${formatVolume(m.volume, locale)} m³` });
      }
    } else if (rec.category === 'floors' || rec.category === 'roofs' || rec.category === 'ceilings') {
      dims.push({ key: 'width', label: t('prop.width'), value: len(ex.width_feet) });
      dims.push({ key: 'depth', label: t('prop.depth'), value: len(ex.depth_feet) });
      dims.push({ key: 'thickness', label: t('prop.thickness'), value: len(ex.height_feet) });
      dims.push({ key: 'area', label: t('prop.area'), value: `${formatArea(ex.width_feet * ex.depth_feet, locale)} m²` });
    } else {
      dims.push({ key: 'width', label: t('prop.width'), value: len(ex.width_feet) });
      dims.push({ key: 'depth', label: t('prop.depth'), value: len(ex.depth_feet) });
      dims.push({ key: 'height', label: t('prop.height'), value: len(ex.height_feet) });
    }
  }
  if (e.location_feet) {
    const [x, y, z] = e.location_feet;
    dims.push({ key: 'x', label: t('prop.locationX'), value: len(x) });
    dims.push({ key: 'y', label: t('prop.locationY'), value: len(y) });
    dims.push({ key: 'z', label: t('prop.locationZ'), value: len(z) });
  }
  if (e.rotation_radians !== undefined) {
    dims.push({ key: 'rotation', label: t('prop.rotation'), value: `${formatAngle(e.rotation_radians, locale)}°` });
  }
  if (dims.length) groups.push({ id: 'dimensions', title: t('propGroup.dimensions'), rows: dims });

  // マテリアルと仕上げ
  const mats: PropRow[] = [];
  if (e.material_index !== undefined) {
    mats.push({ key: 'material', label: t('prop.material'), value: model.materials[e.material_index]?.name ?? '' });
  }
  const layerSet = e.material_layer_set_index !== undefined ? model.material_layer_sets[e.material_layer_set_index] : undefined;
  if (layerSet) {
    let total = 0;
    layerSet.layers.forEach((layer, i) => {
      total += layer.thickness_feet;
      const matName = layer.material_index !== undefined ? model.materials[layer.material_index]?.name : undefined;
      mats.push({
        key: `layer${i}`,
        label: t('prop.layer', { n: i + 1 }),
        value: `${matName ?? layer.name ?? '—'} (${len(layer.thickness_feet)})`,
      });
    });
    mats.push({ key: 'layerTotal', label: t('prop.layerTotal'), value: len(total) });
  }
  if (mats.length) groups.push({ id: 'materials', title: t('propGroup.materials'), rows: mats });

  // 関係
  const rel: PropRow[] = [];
  const hosted = (index.hosted.get(entity) ?? []).map((h) => link(index, h, t)).filter((l): l is PropLink => !!l);
  if (hosted.length) rel.push({ key: 'hosted', label: t('prop.hosted'), value: String(hosted.length), links: hosted });
  for (const end of ['Start', 'End'] as const) {
    const id = findProperty(pset, `Join${end}WallElementId`);
    if (id && (id.kind === 'Integer' || id.kind === 'Text')) {
      const target = index.byElementId.get(String(id.value));
      const l = target !== undefined ? link(index, target, t) : null;
      rel.push({
        key: `join${end}`,
        label: t(end === 'Start' ? 'prop.joinStart' : 'prop.joinEnd'),
        value: l?.label ?? String(id.value),
        links: l ? [l] : undefined,
      });
    }
  }
  const whole = index.wholeOf.get(entity);
  if (whole !== undefined) {
    const l = link(index, whole, t);
    if (l) rel.push({ key: 'whole', label: t('prop.partOf'), value: l.label, links: [l] });
  }
  const parts = (index.parts.get(entity) ?? []).map((p) => link(index, p, t)).filter((l): l is PropLink => !!l);
  if (parts.length) rel.push({ key: 'parts', label: t('prop.parts'), value: String(parts.length), links: parts });
  const contents = (index.spaceContents.get(entity) ?? []).map((p) => link(index, p, t)).filter((l): l is PropLink => !!l);
  if (contents.length) rel.push({ key: 'contents', label: t('prop.roomContents'), value: String(contents.length), links: contents });
  if (rel.length) groups.push({ id: 'relations', title: t('propGroup.relations'), rows: rel });

  // その他 (user/type parameters carried in the main set)
  const other: PropRow[] = [];
  for (const p of pset?.properties ?? []) {
    if (INTERNAL_PROPS.has(p.name)) continue;
    other.push({ key: `p:${p.name}`, label: paramLabel(p.name, t), value: formatPropertyValue(p.value, ctx) });
  }
  if (other.length) groups.push({ id: 'other', title: t('propGroup.other'), rows: other });

  // 追加プロパティセット (Pset_*)
  for (const set of index.extraPsets.get(entity) ?? []) {
    groups.push(psetGroup(set, ctx));
  }

  // 読込情報 (rvt-rs decoder details)
  const decode: PropRow[] = [];
  decode.push({
    key: 'bodySource',
    label: t('prop.geometrySource'),
    value: rec.bboxOnly ? t('value.bboxBody') : e.extrusion || e.solid_shape || e.representation_map_index !== undefined ? t('value.decodedBody') : t('value.noBody'),
  });
  for (const p of pset?.properties ?? []) {
    if (!INTERNAL_PROPS.has(p.name) || ['FamilyName', 'TypeName', 'RoomNumber', 'RoomName', 'ElementId', 'RevitClass'].includes(p.name)) continue;
    decode.push({ key: `d:${p.name}`, label: p.name, value: formatPropertyValue(p.value, ctx) });
  }
  groups.push({ id: 'decode', title: t('propGroup.decode'), rows: decode, collapsed: true });

  return groups;
}

function psetGroup(set: PropertySet, ctx: FormatContext): PropGroup {
  return {
    id: `pset:${set.name}`,
    title: set.name,
    rows: set.properties.map((p) => ({ key: p.name, label: paramLabel(p.name, ctx.t), value: formatPropertyValue(p.value, ctx) })),
  };
}

/**
 * Properties common to several elements: rows present in every element;
 * values that differ are blank (as in Revit).
 */
export function mergeProperties(all: PropGroup[][]): PropGroup[] {
  if (all.length === 0) return [];
  if (all.length === 1) return all[0]!;
  const [first, ...rest] = all;
  const out: PropGroup[] = [];
  for (const g of first!) {
    const others = rest.map((groups) => groups.find((x) => x.id === g.id));
    if (others.some((o) => !o)) continue;
    const rows: PropRow[] = [];
    for (const r of g.rows) {
      const matches = others.map((o) => o!.rows.find((x) => x.key === r.key));
      if (matches.some((m) => !m)) continue;
      const same = matches.every((m) => m!.value === r.value);
      rows.push({ key: r.key, label: r.label, value: same ? r.value : '', links: same ? r.links : undefined });
    }
    if (rows.length) out.push({ ...g, rows });
  }
  return out;
}
