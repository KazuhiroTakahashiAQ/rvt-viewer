//! Saved display meshes for more boxes than `rvt::ifc::saved_meshes::attach`
//! replaces.
//!
//! `attach` replaces a body that is its element record's bounding box with
//! the mesh Revit saved for the element. It leaves two kinds of box:
//!
//! - Family instances turned off the model's axes, which rvt-rs draws as the
//!   rectangle at their angle that the record box bounds
//!   (`partition_family_instance_turned_box`, RE-87): no less approximate
//!   than the record box, and they have saved meshes the same way.
//! - Elements whose saved graphics are a `GPolyMesh` over a faceted topology
//!   other than `FacetedTopology0`, which rvt-rs's decoder rejects
//!   ("unsupported faceted topology"). RPC planting, people and cars draw
//!   their placeholder mesh this way, from the family type's shared symbol:
//!   `FacetedTopology8`, the same points and triangles plus a normal and an
//!   edge visibility flag per facet.

use rvt::RevitFile;
use rvt::ifc::IfcModel;
use rvt::ifc::entities::{BrepTriangle, IfcEntity, PropertyValue, SolidShape};
use rvt::ifc::export_content::{INSTANCE_TURNED_BODY_SOURCE, RECORD_BBOX_BODY_SOURCE};
use rvt::ifc::saved_meshes::{SAVED_MESH_BODY_SOURCE, SavedMeshReport};
use rvt::native_document::{self, Options, Record};
use rvt::native_graphics_traversal::{GraphicsTransform, select_graphics_with_resolver_at_detail};
use rvt::native_parameters::ObjectGraph;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// `attach`'s detail level: Revit's fine representation.
const DETAIL_LEVEL: i64 = 3;

/// Saved-graphics channel of `native_document`.
const GRAPHICS_CHANNEL: u64 = 103;

/// [`rvt::ifc::saved_meshes::attach`], also for turned family instances, then
/// the faceted meshes it rejects for the boxes left.
pub fn attach(rf: &mut RevitFile, model: &mut IfcModel) -> anyhow::Result<SavedMeshReport> {
    // `attach` takes a box by its BodySource: relabel turned boxes as record
    // boxes for it, and back where it left them.
    let turned: Vec<usize> = (0..model.entities.len())
        .filter(|&i| {
            set_body_source(model, i, INSTANCE_TURNED_BODY_SOURCE, RECORD_BBOX_BODY_SOURCE)
        })
        .collect();
    let attached = rvt::ifc::saved_meshes::attach(rf, model);
    for &i in &turned {
        set_body_source(model, i, RECORD_BBOX_BODY_SOURCE, INSTANCE_TURNED_BODY_SOURCE);
    }
    let mut report = attached?;
    let left = boxed_bodies(model);
    if !left.is_empty() {
        let (replaced, triangles) = attach_faceted(rf, model, &left)?;
        report.replaced += replaced;
        report.triangles += triangles;
    }
    Ok(report)
}

/// Set entity `index`'s BodySource to `to` where it is `from`.
fn set_body_source(model: &mut IfcModel, index: usize, from: &str, to: &str) -> bool {
    let IfcEntity::BuildingElement {
        property_set: Some(set),
        ..
    } = &mut model.entities[index]
    else {
        return false;
    };
    let Some(property) = set
        .properties
        .iter_mut()
        .find(|p| p.name == "BodySource" && matches!(&p.value, PropertyValue::Text(t) if t == from))
    else {
        return false;
    };
    property.value = PropertyValue::Text(to.into());
    true
}

/// Elements still drawn as a box `attach` would take (or a turned one),
/// by ElementId, under the same conditions: not a stair or curtain wall drawn
/// by its parts, placed, and the only entity carrying its ElementId.
fn boxed_bodies(model: &IfcModel) -> BTreeMap<u64, usize> {
    let wholes: BTreeSet<usize> = model
        .entities
        .iter()
        .filter_map(|entity| match entity {
            IfcEntity::Aggregate { whole, .. } => Some(*whole),
            _ => None,
        })
        .collect();
    let mut by_id: BTreeMap<u64, Vec<usize>> = BTreeMap::new();
    for (index, entity) in model.entities.iter().enumerate() {
        let IfcEntity::BuildingElement {
            type_guid: Some(tag),
            property_set: Some(set),
            location_feet: Some(_),
            ..
        } = entity
        else {
            continue;
        };
        let Ok(id) = tag.parse::<u64>() else {
            continue;
        };
        // Every entity carrying the ElementId counts, to leave ambiguous ones.
        let boxed = !wholes.contains(&index)
            && set.properties.iter().any(|p| {
                p.name == "BodySource"
                    && matches!(&p.value, PropertyValue::Text(t)
                        if t == RECORD_BBOX_BODY_SOURCE || t == INSTANCE_TURNED_BODY_SOURCE)
            })
            && !set.properties.iter().any(|p| {
                p.name == "ProfileResolved" && matches!(p.value, PropertyValue::Boolean(true))
            });
        by_id.entry(id).or_default().push(if boxed { index } else { usize::MAX });
    }
    by_id
        .into_iter()
        .filter_map(|(id, indices)| match indices.as_slice() {
            [index] if *index != usize::MAX => Some((id, *index)),
            _ => None,
        })
        .collect()
}

/// Replace the bodies of `boxed` (ElementId → entity) whose saved graphics
/// hold faceted meshes rvt-rs does not decode. Returns `(replaced, triangles)`.
fn attach_faceted(
    rf: &mut RevitFile,
    model: &mut IfcModel,
    boxed: &BTreeMap<u64, usize>,
) -> anyhow::Result<(usize, usize)> {
    let records = graphics_records(rf, boxed.keys().copied().collect())?;
    let resolver = |id: u64| records.get(&id).and_then(|r| r.graph.as_ref());
    let (mut replaced, mut triangles) = (0, 0);
    for (id, &index) in boxed {
        let Some(graph) = resolver(*id) else {
            continue;
        };
        let selection = select_graphics_with_resolver_at_detail(graph, &resolver, DETAIL_LEVEL);
        let mut mesh = Mesh::default();
        for selected in &selection.selected {
            let source = match selected.source_owner_id {
                None => graph,
                Some(owner) => match resolver(owner) {
                    Some(source) => source,
                    None => continue,
                },
            };
            mesh.add_faceted(source, selected.object_index, selected.world_transform);
        }
        if mesh.triangles.is_empty() {
            continue;
        }
        replaced += 1;
        triangles += mesh.triangles.len();
        set_mesh(model, index, mesh);
    }
    Ok((replaced, triangles))
}

/// The saved-graphics records of `ids`, with the shared symbols their
/// instances draw (`native_saved_scene::extract_at_detail`'s closure).
fn graphics_records(
    rf: &mut RevitFile,
    ids: BTreeSet<u64>,
) -> anyhow::Result<BTreeMap<u64, Record>> {
    let mut options = Options {
        max_graph_values: 1_000_000,
        max_graph_objects: 1_000_000,
        ..Default::default()
    };
    options.channels = BTreeSet::from([GRAPHICS_CHANNEL]);
    let mut records = BTreeMap::<u64, Record>::new();
    let mut attempted = ids.clone();
    let mut wanted = ids;
    // Symbols nest (a family in a family); the same depth budget as rvt-rs.
    for _ in 0..=128 {
        if wanted.is_empty() {
            break;
        }
        options.selected_ids = std::mem::take(&mut wanted);
        native_document::extract(rf, &options, |record| {
            records.entry(record.identity.element_id).or_insert(record);
            Ok(())
        })?;
        for record in records.values() {
            let Some(graph) = &record.graph else {
                continue;
            };
            for object in graph.objects.iter().filter(|o| o.class_name == "InstanceInfo") {
                let symbol = identifier(&object.fields["m_symbolId"]).filter(|id| *id > 0);
                if let Some(symbol) = symbol.filter(|id| attempted.insert(*id)) {
                    wanted.insert(symbol);
                }
            }
        }
    }
    Ok(records)
}

/// A saved ElementId: a number, or one under `m_id` / `m_id64`.
fn identifier(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_i64() {
        return u64::try_from(n).ok();
    }
    ["m_id", "m_id64"]
        .iter()
        .find_map(|key| value.get(key))
        .and_then(identifier)
}

/// Triangles in document feet.
#[derive(Default)]
struct Mesh {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
}

impl Mesh {
    /// Add `graph`'s object `index` placed by `transform`, where it is a
    /// `GPolyMesh` over a faceted topology rvt-rs does not decode.
    fn add_faceted(&mut self, graph: &ObjectGraph, index: usize, transform: GraphicsTransform) {
        let object = &graph.objects[index];
        if object.class_name != "GPolyMesh" {
            return;
        }
        let Ok(Some(topology)) =
            rvt::native_saved_mesh::pointer(graph, index, &object.fields["m_pFacetedTopology"])
        else {
            return;
        };
        let topology = &graph.objects[topology];
        // FacetedTopology0 is rvt-rs's: an element it left had none decodable.
        if !topology.class_name.starts_with("FacetedTopology")
            || topology.class_name == "FacetedTopology0"
        {
            return;
        }
        let Some(points) = topology.fields["m_pointsArr"]
            .as_array()
            .and_then(|points| points.iter().map(point).collect::<Option<Vec<_>>>())
        else {
            return;
        };
        let Some(facets) = topology.fields["m_facetsArr"].as_array() else {
            return;
        };
        let m = transform;
        let place = |p: [f64; 3]| -> [f64; 3] {
            std::array::from_fn(|i| m[i][3] + (0..3).map(|j| m[i][j] * p[j]).sum::<f64>())
        };
        let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if !(det.is_finite() && det.abs() > 1e-12) {
            return;
        }
        let base = self.vertices.len() as u32;
        let placed: Vec<[f64; 3]> = points.into_iter().map(place).collect();
        if !placed.iter().flatten().all(|v| v.is_finite()) {
            return;
        }
        let count = placed.len();
        let mut triangles = Vec::new();
        for facet in facets {
            let Some(corners) = facet.as_array().and_then(|a| {
                a.iter()
                    .map(|v| v.as_u64().map(|v| v as usize))
                    .collect::<Option<Vec<_>>>()
            }) else {
                return;
            };
            if corners.len() < 3 || corners.iter().any(|&v| v >= count) {
                return;
            }
            // A polygon as a fan; a mirroring transform flips the winding.
            for k in 1..corners.len() - 1 {
                let (a, b, c) = (corners[0], corners[k], corners[k + 1]);
                let (b, c) = if det < 0.0 { (c, b) } else { (b, c) };
                triangles.push([base + a as u32, base + b as u32, base + c as u32]);
            }
        }
        self.vertices.extend(placed);
        self.triangles.extend(triangles);
    }
}

fn point(value: &Value) -> Option<[f64; 3]> {
    let a = value.as_array()?;
    if a.len() != 3 {
        return None;
    }
    Some([a[0].as_f64()?, a[1].as_f64()?, a[2].as_f64()?])
}

/// Draw entity `index` from `mesh`, in its placement's frame as `attach` does.
fn set_mesh(model: &mut IfcModel, index: usize, mesh: Mesh) {
    let IfcEntity::BuildingElement {
        location_feet: Some(origin),
        rotation_radians,
        solid_shape,
        property_set: Some(set),
        ..
    } = &mut model.entities[index]
    else {
        return;
    };
    let (sin, cos) = (-rotation_radians.unwrap_or(0.0)).sin_cos();
    let vertices = mesh
        .vertices
        .iter()
        .map(|p| {
            let (dx, dy) = (p[0] - origin[0], p[1] - origin[1]);
            [dx * cos - dy * sin, dx * sin + dy * cos, p[2] - origin[2]]
        })
        .collect();
    let triangles = mesh.triangles.iter().map(|t| BrepTriangle(t[0], t[1], t[2])).collect();
    *solid_shape = Some(SolidShape::TriangulatedFaceSet {
        vertices_feet: vertices,
        triangles,
    });
    for property in &mut set.properties {
        if property.name == "BodySource" {
            property.value = PropertyValue::Text(SAVED_MESH_BODY_SOURCE.into());
        }
    }
}
