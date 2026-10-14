/*
 * Main-thread lookup tables derived once from the decoded IfcModel:
 * element records (category, family, type, level, ids), relationships and
 * the storeys. Everything the UI shows about an element comes from here.
 */

import type {
  BuildingElementEntity,
  IfcModel,
  Property,
  PropertySet,
  PropertyValue,
} from '../wasm/types';
import { type CategoryKey, categoryOf, categoryRank } from './categories';
import { splitElementName } from './naming';

export interface ElementRecord {
  index: number;
  entity: BuildingElementEntity;
  ifcType: string;
  category: CategoryKey;
  name: string;
  familyName: string;
  typeName: string;
  elementId: string;
  storeyIndex: number | null;
  globalId: string | null;
  /** Rooms only. */
  roomNumber: string | null;
  roomName: string | null;
  /** How the body was obtained. */
  body: BodyKind;
}

/**
 * `approx`: the record's bounding box standing in for an undecoded shape;
 * `savedMesh`: the mesh Revit saved for display; `decoded`: everything else
 * (decoded profiles, and boxes rvt-rs proved to be the exact shape).
 */
export type BodyKind = 'decoded' | 'approx' | 'savedMesh';

const BBOX_BODY = 'partition_element_record_bbox';
const SAVED_MESH_BODY = 'saved_graphics_mesh';

export function bodyKind(set: PropertySet | undefined): BodyKind {
  const source = textOf(findProperty(set, 'BodySource'));
  if (source === SAVED_MESH_BODY) return 'savedMesh';
  const exact = findProperty(set, 'ProfileResolved');
  if (source === BBOX_BODY && !(exact?.kind === 'Boolean' && exact.value)) return 'approx';
  return 'decoded';
}

export interface StoreyRecord {
  index: number;
  name: string;
  elevationFeet: number;
}

export interface ModelIndex {
  elements: ElementRecord[];
  byIndex: Map<number, ElementRecord>;
  byElementId: Map<string, number>;
  storeys: StoreyRecord[];
  /** Host entity index → hosted (doors/windows) entity indices. */
  hosted: Map<number, number[]>;
  /** Aggregate whole → parts, and part → whole. */
  parts: Map<number, number[]>;
  wholeOf: Map<number, number>;
  /** Space entity index → contained element indices. */
  spaceContents: Map<number, number[]>;
  /** Extra property sets (Pset_*), keyed by element entity index. */
  extraPsets: Map<number, PropertySet[]>;
  /** Categories present, in display order, with element counts. */
  categories: { key: CategoryKey; count: number }[];
  /** Map of the `ifc_type`s present. */
  categoryOfType: Map<string, CategoryKey>;
}

export function findProperty(set: PropertySet | undefined, name: string): PropertyValue | undefined {
  return set?.properties.find((p: Property) => p.name === name)?.value;
}

export function textOf(value: PropertyValue | undefined): string | null {
  if (!value) return null;
  switch (value.kind) {
    case 'Text':
    case 'Label':
    case 'Identifier':
      return value.value;
    case 'Integer':
    case 'Real':
    case 'CountValue':
      return String(value.value);
    default:
      return null;
  }
}

export function buildModelIndex(model: IfcModel): ModelIndex {
  const elements: ElementRecord[] = [];
  const byIndex = new Map<number, ElementRecord>();
  const byElementId = new Map<string, number>();
  const hosted = new Map<number, number[]>();
  const parts = new Map<number, number[]>();
  const wholeOf = new Map<number, number>();
  const spaceContents = new Map<number, number[]>();
  const extraPsets = new Map<number, PropertySet[]>();
  const categoryCounts = new Map<CategoryKey, number>();
  const categoryOfType = new Map<string, CategoryKey>();
  const globalIds = model.global_ids?.elements;

  model.entities.forEach((entity, index) => {
    switch (entity.kind) {
      case 'BuildingElement': {
        const pset = entity.property_set;
        const parsed = splitElementName(entity.name);
        const category = categoryOf(entity.ifc_type);
        const elementId = entity.type_guid ?? parsed.elementId ?? '';
        const record: ElementRecord = {
          index,
          entity,
          ifcType: entity.ifc_type,
          category,
          name: entity.name,
          familyName: textOf(findProperty(pset, 'FamilyName')) ?? parsed.family ?? '',
          typeName: textOf(findProperty(pset, 'TypeName')) ?? parsed.type ?? '',
          elementId,
          storeyIndex: entity.storey_index ?? null,
          globalId: (globalIds instanceof Map ? globalIds.get(index) : undefined) ?? null,
          roomNumber: textOf(findProperty(pset, 'RoomNumber')),
          roomName: textOf(findProperty(pset, 'RoomName')),
          body: bodyKind(pset),
        };
        elements.push(record);
        byIndex.set(index, record);
        if (elementId && !byElementId.has(elementId)) byElementId.set(elementId, index);
        if (entity.host_element_index !== undefined) push(hosted, entity.host_element_index, index);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        categoryOfType.set(entity.ifc_type, category);
        break;
      }
      case 'Aggregate':
        parts.set(entity.whole, [...entity.parts]);
        for (const p of entity.parts) wholeOf.set(p, entity.whole);
        break;
      case 'ElementPropertySet':
        push(extraPsets, entity.element, entity.set);
        break;
      case 'SpaceContainment':
        spaceContents.set(entity.space, [...entity.elements]);
        break;
      default:
        break;
    }
  });

  const storeys: StoreyRecord[] = model.building_storeys.map((s, index) => ({
    index,
    name: s.name,
    elevationFeet: s.elevation_feet,
  }));

  const categories = [...categoryCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => categoryRank(a.key) - categoryRank(b.key));

  return {
    elements,
    byIndex,
    byElementId,
    storeys,
    hosted,
    parts,
    wholeOf,
    spaceContents,
    extraPsets,
    categories,
    categoryOfType,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
