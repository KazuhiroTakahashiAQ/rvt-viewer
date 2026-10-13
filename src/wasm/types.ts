/*
 * TypeScript shapes of the values the rvt-rs WebAssembly bindings
 * (vendor/rvt-rs/rvt-wasm) hand back through serde-wasm-bindgen.
 *
 * Conventions of that bridge:
 * - Rust `BTreeMap`s arrive as JS `Map`s (keys stay numbers when the Rust key is numeric).
 * - `Option::None` arrives as `undefined`; `skip_serializing_if` fields are absent.
 * - Lengths are feet, the model frame is Z-up (Revit: X = east, Y = north).
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type PropertyValue =
  | { kind: 'Text' | 'Label' | 'Identifier'; value: string }
  | { kind: 'Integer' | 'Real' | 'CountValue' | 'TimeSeconds' | 'MassPounds'; value: number }
  | { kind: 'LengthFeet' | 'PositiveLengthFeet'; value: number }
  | { kind: 'AngleRadians'; value: number }
  | { kind: 'AreaSquareFeet'; value: number }
  | { kind: 'VolumeCubicFeet'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Logical'; value?: boolean }
  | { kind: 'List'; value: PropertyValue[] }
  | { kind: 'Enumerated'; value: string[] };

export interface Property {
  name: string;
  value: PropertyValue;
}

export interface PropertySet {
  name: string;
  properties: Property[];
}

export interface Extrusion {
  width_feet: number;
  depth_feet: number;
  height_feet: number;
  profile_override?: unknown;
}

export interface BuildingElementEntity {
  kind: 'BuildingElement';
  ifc_type: string;
  name: string;
  /** Revit ElementId as a decimal string (not a GUID despite the name). */
  type_guid?: string;
  predefined_type?: string;
  storey_index?: number;
  material_index?: number;
  property_set?: PropertySet;
  location_feet?: Vec3;
  rotation_radians?: number;
  extrusion?: Extrusion;
  host_element_index?: number;
  material_layer_set_index?: number;
  material_profile_set_index?: number;
  solid_shape?: unknown;
  representation_map_index?: number;
}

export interface ProjectEntity {
  kind: 'Project';
  name?: string;
  description?: string;
  long_name?: string;
}

export interface AggregateEntity {
  kind: 'Aggregate';
  whole: number;
  parts: number[];
}

export interface ElementPropertySetEntity {
  kind: 'ElementPropertySet';
  element: number;
  set: PropertySet;
}

export interface SpaceContainmentEntity {
  kind: 'SpaceContainment';
  space: number;
  elements: number[];
}

export interface SystemEntity {
  kind: 'System';
  id: number;
  name?: string;
  members: number[];
}

export interface OtherEntity {
  kind: 'PortConnection' | 'Port' | 'VoidOpening' | 'WallProfileOpening' | 'BuildingElementType' | 'TypeObject';
  [key: string]: unknown;
}

export type IfcEntity =
  | ProjectEntity
  | BuildingElementEntity
  | AggregateEntity
  | ElementPropertySetEntity
  | SpaceContainmentEntity
  | SystemEntity
  | OtherEntity;

export interface BuildingStorey {
  name: string;
  elevation_feet: number;
}

export interface MaterialInfo {
  name: string;
  /** 0x00BBGGRR */
  color_packed?: number;
  transparency?: number;
}

export interface MaterialLayerSet {
  name: string;
  layers: { material_index?: number; thickness_feet: number; name?: string }[];
  description?: string;
}

export interface UnitAssignment {
  forge_identifier: string;
  ifc_mapping?: string;
}

export interface GlobalIds {
  document?: string;
  elements: Map<number, string>;
  storeys: Map<number, string>;
  types: Map<number, string>;
  element_types: Map<number, string>;
  revit_version?: number;
}

export interface IfcModel {
  project_name?: string;
  description?: string;
  entities: IfcEntity[];
  classifications: unknown[];
  units: UnitAssignment[];
  building_storeys: BuildingStorey[];
  materials: MaterialInfo[];
  material_layer_sets: MaterialLayerSet[];
  material_profile_sets: unknown[];
  representation_maps: unknown[];
  global_ids?: GlobalIds;
  element_layers?: Map<number, unknown>;
  material_layer_usages?: Map<number, unknown>;
  element_type_materials?: Map<number, string[]>;
  element_type_ids?: Map<number, number>;
  material_constituent_sets?: unknown[];
  opening_cuts?: Map<number, unknown>;
}

export type ConfidenceLevel = 'scaffold' | 'geometry' | 'diagnostic_partial' | 'typed_no_geometry' | 'proxy_only';

export interface ExportDiagnostics {
  schema_version: number;
  mode: string;
  input: {
    revit_version?: number;
    build?: string;
    original_path?: string;
    project_name?: string;
    stream_count: number;
    has_basic_file_info: boolean;
    has_part_atom: boolean;
    has_formats_latest: boolean;
    has_global_latest: boolean;
  };
  decoded: {
    production_walker_elements: number;
    diagnostic_proxy_candidates: number;
    parameter_value_count: number;
    mean_element_confidence?: number;
    [key: string]: unknown;
  };
  exported: {
    total_entities: number;
    building_elements: number;
    building_elements_with_geometry: number;
    material_count: number;
    storey_count: number;
    bounding_box_bodies: number;
    by_ifc_type: Map<string, number>;
    [key: string]: unknown;
  };
  skipped: { reason: string; count: number; classes: Map<string, number>; sample_names: string[] }[];
  unsupported_features: string[];
  warnings: string[];
  confidence: {
    level: ConfidenceLevel;
    score: number;
    has_project_metadata: boolean;
    has_typed_elements: boolean;
    has_geometry: boolean;
    has_diagnostic_proxies: boolean;
    warning_count: number;
    unexported_element_records: number;
  };
  [key: string]: unknown;
}

export interface SceneNode {
  name: string;
  ifc_type: string;
  entity_index?: number;
  storey_index?: number;
  children: SceneNode[];
}

export interface InfoRow {
  label: string;
  value: string;
}

export interface RelatedElement {
  entity_index: number;
  name: string;
  ifc_type: string;
}

export interface ElementInfoPanel {
  name: string;
  ifc_type: string;
  type_guid?: string;
  predefined_type?: string;
  storey_name?: string;
  storey_elevation_feet?: number;
  storey?: { index: number; name: string; elevation_feet: number; elevation_label: string };
  location_feet?: Vec3;
  rotation_radians?: number;
  placement_rows: InfoRow[];
  extent_rows: InfoRow[];
  material_name?: string;
  material?: { index: number; name: string; element_count: number };
  layers?: {
    name: string;
    order?: string;
    rows: { label: string; value: string; material?: { index: number; name: string; element_count: number } }[];
    total: string;
  };
  properties: [string, string][];
  property_group?: { name: string; properties: { name: string; value: string; kind: string; numeric?: number }[] };
  further_property_groups: { name: string; properties: { name: string; value: string; kind: string; numeric?: number }[] }[];
  host?: RelatedElement;
  hosted: RelatedElement[];
  joins: { end: 'Start' | 'End'; runs_through: boolean; wall: RelatedElement }[];
  missing: string[];
}

export interface Schedule {
  rows: { entity_index: number; ifc_type: string; name: string; storey: string; material: string; guid: string }[];
  groups: { ifc_type: string; count: number; entity_indices: number[]; storeys: string[] }[];
}

export interface Summary {
  file_size: number;
  streams: string[];
  version: number;
  build?: string;
  original_path?: string;
  guid?: string;
  locale?: string;
  partition_stream?: string;
  partatom?: {
    title?: string;
    entry_title?: string;
    id?: string;
    updated?: string;
    taxonomies: { term: string; label: string }[];
    categories: { term: string; scheme?: string }[];
    omniclass?: string;
    raw_xml: string;
  };
  class_name_count: number;
  class_name_sample: string[];
}

export interface FileMetadata {
  revit_version: number;
  build?: string;
  title?: string;
  last_saved?: string;
  worksharing?: string;
  workshared?: boolean;
  username?: string;
  central_model_path?: string;
  last_save_path?: string;
  document_guid?: string;
  document_increments?: number;
  locale?: string;
  single_user_cloud_model?: boolean;
  properties: { key: string; value: string }[];
}
