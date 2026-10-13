import type { BuildingElementEntity, IfcModel } from '../../src/wasm/types';

const el = (over: Partial<BuildingElementEntity>): BuildingElementEntity => ({
  kind: 'BuildingElement',
  ifc_type: 'IFCWALL',
  name: 'Basic Wall:Generic 200:100',
  ...over,
});

/** A tiny model in the shape rvt-rs returns. */
export function sampleModel(): IfcModel {
  return {
    project_name: 'Sample',
    entities: [
      { kind: 'Project', name: 'Sample' },
      el({
        name: 'Basic Wall:Generic 200:100',
        type_guid: '100',
        storey_index: 0,
        location_feet: [0, 0, 0],
        extrusion: { width_feet: 10, depth_feet: 0.5, height_feet: 9 },
        material_layer_set_index: 0,
        property_set: {
          name: 'RvtElementRecordGeometry',
          properties: [
            { name: 'FamilyName', value: { kind: 'Text', value: 'Basic Wall' } },
            { name: 'TypeName', value: { kind: 'Text', value: 'Generic 200' } },
            { name: 'Fire Rating', value: { kind: 'Text', value: '1HR' } },
            { name: 'BodySource', value: { kind: 'Text', value: 'partition_element_record_join_trimmed' } },
            { name: 'JoinEndWallElementId', value: { kind: 'Integer', value: 101 } },
          ],
        },
      }),
      el({ name: 'Basic Wall:Generic 200:101', type_guid: '101', storey_index: 1 }),
      el({
        ifc_type: 'IFCDOOR',
        name: 'Single-Flush:0915 x 2134mm:200',
        type_guid: '200',
        storey_index: 0,
        host_element_index: 1,
        property_set: {
          name: 'RvtElementRecordGeometry',
          properties: [{ name: 'BodySource', value: { kind: 'Text', value: 'partition_element_record_bbox' } }],
        },
      }),
      el({
        ifc_type: 'IFCSPACE',
        name: 'Room-300',
        type_guid: '300',
        storey_index: 0,
        location_feet: [0, 0, 0],
        extrusion: {
          width_feet: 10,
          depth_feet: 10,
          height_feet: 8,
          profile_override: { ArbitraryClosed: { points: [[0, 0], [10, 0], [10, 5], [0, 5]] } },
        },
        property_set: {
          name: 'RvtElementRecordGeometry',
          properties: [
            { name: 'RoomNumber', value: { kind: 'Text', value: '101' } },
            { name: 'RoomName', value: { kind: 'Text', value: 'Office' } },
          ],
        },
      }),
      { kind: 'ElementPropertySet', element: 4, set: { name: 'Pset_SpaceCommon', properties: [{ name: 'Reference', value: { kind: 'Identifier', value: 'Office 101' } }] } },
    ],
    classifications: [],
    units: [],
    building_storeys: [
      { name: 'Level 1', elevation_feet: 0 },
      { name: 'Level 2', elevation_feet: 10 },
    ],
    materials: [{ name: 'Concrete' }, { name: 'Gypsum' }],
    material_layer_sets: [
      {
        name: 'Generic 200',
        layers: [
          { material_index: 1, thickness_feet: 0.05 },
          { material_index: 0, thickness_feet: 0.45 },
        ],
      },
    ],
    material_profile_sets: [],
    representation_maps: [],
    global_ids: {
      elements: new Map([[1, '2vrSC4nbr48vzSSOTHS45q']]),
      storeys: new Map(),
      types: new Map(),
      element_types: new Map(),
    },
  };
}

/** Identity translator: returns the key plus interpolation values. */
export const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}(${Object.values(opts).join(',')})` : key;
