import { describe, expect, it } from 'vitest';
import { buildBrowserTree, flattenTree } from '../../src/model/browserTree';
import { categoryOf, hiddenByDefault, pickPriority } from '../../src/model/categories';
import { bodyKind, buildModelIndex } from '../../src/model/modelIndex';
import { splitElementName } from '../../src/model/naming';
import {
  buildElementProperties,
  formatPropertyValue,
  materialNames,
  mergeProperties,
  polygonArea,
  polygonPerimeter,
  roomMeasures,
} from '../../src/model/properties';
import { formatArea, formatLength } from '../../src/model/units';
import { listViews } from '../../src/model/views';
import type { Property, PropertySet } from '../../src/wasm/types';
import { sampleModel, t } from './fixtures';

describe('splitElementName', () => {
  it('splits Family:Type:ElementId', () => {
    expect(splitElementName('Basic Wall:Generic 200:100')).toEqual({ family: 'Basic Wall', type: 'Generic 200', elementId: '100' });
  });
  it('keeps colons inside the type name and drops the piece counter', () => {
    expect(splitElementName('Fam:Type:A:42:3')).toEqual({ family: 'Fam', type: 'Type:A', elementId: '42' });
  });
  it('handles the RevitClass-ElementId fallback', () => {
    expect(splitElementName('Room-20822')).toEqual({ family: null, type: null, elementId: '20822' });
  });
  it('returns nulls for free-form names', () => {
    expect(splitElementName('Something')).toEqual({ family: null, type: null, elementId: null });
  });
});

describe('units', () => {
  it('converts feet to millimetres and metres', () => {
    expect(formatLength(1, 'mm', 'ja')).toBe('305');
    expect(formatLength(10, 'm', 'ja')).toBe('3.048');
    expect(formatLength(100, 'mm', 'ja')).toBe('30,480');
  });
  it('converts square feet to square metres', () => {
    expect(formatArea(100, 'ja')).toBe('9.29');
  });
});

describe('categories', () => {
  it('maps IFC types to Revit categories', () => {
    expect(categoryOf('IFCWALL')).toBe('walls');
    expect(categoryOf('ifcwallstandardcase')).toBe('walls');
    expect(categoryOf('IFCSPACE')).toBe('rooms');
    expect(categoryOf('IFCUNKNOWNTHING')).toBe('genericModels');
  });
  it('rooms lose picking ties and are hidden outside plans', () => {
    expect(pickPriority('rooms')).toBeGreaterThan(pickPriority('walls'));
    expect(hiddenByDefault('rooms', '3d')).toBe(true);
    expect(hiddenByDefault('rooms', 'plan')).toBe(false);
    expect(hiddenByDefault('walls', '3d')).toBe(false);
  });
});

describe('buildModelIndex', () => {
  const model = sampleModel();
  const index = buildModelIndex(model);

  it('indexes building elements with family/type/ids', () => {
    expect(index.elements).toHaveLength(4);
    const wall = index.byIndex.get(1)!;
    expect(wall.familyName).toBe('Basic Wall');
    expect(wall.typeName).toBe('Generic 200');
    expect(wall.elementId).toBe('100');
    expect(wall.globalId).toBe('2vrSC4nbr48vzSSOTHS45q');
    expect(index.byElementId.get('101')).toBe(2);
  });
  it('falls back to the name for family/type', () => {
    const door = index.byIndex.get(3)!;
    expect(door.familyName).toBe('Single-Flush');
    expect(door.typeName).toBe('0915 x 2134mm');
    expect(door.body).toBe('approx');
  });
  it('tells approximate boxes from exact boxes and saved meshes', () => {
    const set = (properties: Property[]): PropertySet => ({ name: 'RvtElementRecordGeometry', properties });
    const text = (name: string, value: string): Property => ({ name, value: { kind: 'Text', value } });
    expect(bodyKind(set([text('BodySource', 'partition_element_record_bbox')]))).toBe('approx');
    expect(
      bodyKind(set([text('BodySource', 'partition_element_record_bbox'), { name: 'ProfileResolved', value: { kind: 'Boolean', value: true } }])),
    ).toBe('decoded');
    expect(bodyKind(set([text('BodySource', 'saved_graphics_mesh')]))).toBe('savedMesh');
    expect(bodyKind(set([text('BodySource', 'partition_element_record_join_trimmed')]))).toBe('decoded');
    expect(bodyKind(undefined)).toBe('decoded');
  });
  it('records hosts, extra property sets and rooms', () => {
    expect(index.hosted.get(1)).toEqual([3]);
    expect(index.extraPsets.get(4)?.[0]?.name).toBe('Pset_SpaceCommon');
    const room = index.byIndex.get(4)!;
    expect(room.roomNumber).toBe('101');
    expect(room.roomName).toBe('Office');
  });
  it('counts categories in display order', () => {
    expect(index.categories.map((c) => c.key)).toEqual(['walls', 'doors', 'rooms']);
  });
});

describe('properties', () => {
  const model = sampleModel();
  const index = buildModelIndex(model);
  const ctx = { unit: 'mm' as const, locale: 'ja', t };

  it('computes polygon measures', () => {
    const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(polygonArea(square)).toBe(4);
    expect(polygonPerimeter(square)).toBe(8);
    expect(roomMeasures(index.byIndex.get(4)!)).toEqual({ area: 50, perimeter: 30, volume: 400 });
  });

  it('formats property values with units', () => {
    expect(formatPropertyValue({ kind: 'LengthFeet', value: 1 }, ctx)).toBe('305');
    expect(formatPropertyValue({ kind: 'Boolean', value: true }, ctx)).toBe('value.yes');
    expect(formatPropertyValue({ kind: 'AreaSquareFeet', value: 100 }, ctx)).toBe('9.29 m²');
  });

  it('groups wall properties like Revit', () => {
    const groups = buildElementProperties(index, model, 1, ctx);
    const ids = groups.map((g) => g.id);
    expect(ids).toEqual(['identity', 'constraints', 'dimensions', 'materials', 'relations', 'other', 'decode']);
    const dims = groups.find((g) => g.id === 'dimensions')!;
    expect(dims.rows.find((r) => r.key === 'length')?.value).toBe('3,048');
    const rel = groups.find((g) => g.id === 'relations')!;
    expect(rel.rows.find((r) => r.key === 'hosted')?.links?.[0]?.entity).toBe(3);
    expect(rel.rows.find((r) => r.key === 'joinEnd')?.links?.[0]?.entity).toBe(2);
    const other = groups.find((g) => g.id === 'other')!;
    expect(other.rows.map((r) => r.label)).toEqual(['param.fireRating']);
    expect(groups.find((g) => g.id === 'decode')?.collapsed).toBe(true);
  });

  it('lists layer materials when the element has no own material', () => {
    expect(materialNames(model, index.byIndex.get(1)!)).toEqual(['Gypsum', 'Concrete']);
  });

  it('merges common values and blanks differing ones', () => {
    const a = buildElementProperties(index, model, 1, ctx);
    const b = buildElementProperties(index, model, 2, ctx);
    const merged = mergeProperties([a, b]);
    const identity = merged.find((g) => g.id === 'identity')!;
    expect(identity.rows.find((r) => r.key === 'family')?.value).toBe('Basic Wall');
    expect(identity.rows.find((r) => r.key === 'elementId')?.value).toBe('');
  });
});

describe('views and browser tree', () => {
  const index = buildModelIndex(sampleModel());
  const views = listViews(index);

  it('offers plans per level, the 3D view, elevations and schedules', () => {
    expect(views.map((v) => v.id)).toEqual([
      'plan:0',
      'plan:1',
      '3d',
      'elev:east',
      'elev:north',
      'elev:south',
      'elev:west',
      'schedule:elements',
      'schedule:rooms',
    ]);
  });

  it('builds the family tree by category → family → type', () => {
    const tree = buildBrowserTree(views, index, t);
    const families = tree.find((n) => n.id === 'g:families')!;
    const walls = families.children!.find((n) => n.id === 'c:walls')!;
    expect(walls.elements).toEqual([1, 2]);
    expect(walls.children![0]!.label).toBe('Basic Wall');
  });

  it('filters rows and opens ancestors of matches', () => {
    const tree = buildBrowserTree(views, index, t);
    const rows = flattenTree(tree, new Set(), 'Basic');
    expect(rows.map((r) => r.node.label)).toEqual(['browser.families', 'category.walls', 'Basic Wall']);
    const collapsed = flattenTree(tree, new Set(), '');
    expect(collapsed.map((r) => r.node.id)).toEqual(['g:views', 'g:schedules', 'g:families']);
  });
});
