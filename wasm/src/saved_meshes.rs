//! Bodies from the meshes Revit saved for display, for more boxes than
//! `rvt::ifc::saved_meshes::attach` replaces.
//!
//! `attach` replaces a body that is its element record's bounding box with
//! the element's saved graphics as rvt-rs decodes them. [`attach`] here does
//! the same with rvt-rs's decoder, and besides:
//!
//! - Family instances turned off the model's axes, which rvt-rs draws as the
//!   rectangle at their angle that the record box bounds
//!   (`partition_family_instance_turned_box`, RE-87), are replaced too.
//! - Where rvt-rs's decoder rejects part of an element's graphics, the
//!   element is decoded again by [`crate::brep::Decoder`]: the curved faces
//!   it rejects (cones, cut cylinders, ruled surfaces to a point, ellipse
//!   and spline profiles: pipe and duct fittings, furniture, railings), and
//!   `GPolyMesh`es over faceted topologies other than `FacetedTopology0`
//!   (RPC planting, people and cars draw their placeholder that way).
//! - Two fail-closed checks of rvt-rs's traversal are relaxed (see
//!   [`relax`]).
//! - A body with a transparent face (a window's glass) is drawn in the
//!   materials Revit saved for its faces ([`MaterialRun`]); the others keep
//!   the element's colour.

use crate::brep::{self, Decoder, P3};
use rvt::RevitFile;
use rvt::ifc::IfcModel;
use rvt::ifc::entities::{BrepTriangle, IfcEntity, PropertyValue, SolidShape};
use rvt::ifc::export_content::{INSTANCE_TURNED_BODY_SOURCE, RECORD_BBOX_BODY_SOURCE};
use rvt::ifc::saved_meshes::{SAVED_MESH_BODY_SOURCE, SavedMeshReport};
use rvt::native_document::{self, Options, Record};
use rvt::native_graphics_traversal::{GraphicsTransform, select_graphics_with_resolver_at_detail};
use rvt::native_parameters::ObjectGraph;
use rvt::native_saved_materials::Resolver;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// rvt-rs's detail level for saved meshes: Revit's fine representation.
const DETAIL_LEVEL: i64 = 3;

/// Saved-graphics and material channels of `native_document`.
const GRAPHICS_CHANNEL: u64 = 103;
const MATERIAL_CHANNEL: u64 = 102;

/// A run of an element's triangles in one material, in the order of its
/// `TriangulatedFaceSet`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaterialRun {
    pub triangles: usize,
    /// sRGB 0..1; `None` where Revit's material is not known (the element's
    /// own colour then).
    pub color: Option<[f32; 3]>,
    pub opacity: f32,
}

pub struct Attached {
    pub report: SavedMeshReport,
    /// Entity index → its runs, for the bodies with a transparent face.
    pub materials: BTreeMap<usize, Vec<MaterialRun>>,
    /// Why faces and objects were left out, with counts.
    pub failures: BTreeMap<String, usize>,
}

/// Replace the box bodies of `model` with the meshes Revit saved for display.
pub fn attach(rf: &mut RevitFile, model: &mut IfcModel) -> anyhow::Result<Attached> {
    let boxed = boxed_bodies(model);
    let mut attached = Attached {
        report: SavedMeshReport {
            candidates: boxed.len(),
            ..Default::default()
        },
        materials: BTreeMap::new(),
        failures: BTreeMap::new(),
    };
    if boxed.is_empty() {
        return Ok(attached);
    }
    let mut records = graphics_records(rf, boxed.keys().copied().collect())?;
    for graph in records.values_mut().filter_map(|r| r.graph.as_mut()) {
        relax(graph);
    }
    let materials = material_resolver(rf)?;
    let resolver = |id: u64| records.get(&id).and_then(|r| r.graph.as_ref());
    let mut decoders: HashMap<u64, Decoder> = HashMap::new();
    let mut meshes = Vec::new();
    for (&id, &index) in &boxed {
        let Some(graph) = resolver(id) else {
            continue;
        };
        let mut mesh = ElementMesh::default();
        let upstream = rvt::native_saved_mesh::graphics_with_resolver_at_detail(graph, &resolver, DETAIL_LEVEL);
        if upstream.diagnostics.is_empty() {
            for p in &upstream.primitives {
                let key = (p.source_owner_id, p.face_tag, p.render_style_id, p.material_id);
                mesh.add(&p.vertices, &p.triangles, key);
            }
        } else {
            let selection = select_graphics_with_resolver_at_detail(graph, &resolver, DETAIL_LEVEL);
            for selected in &selection.selected {
                let owner = selected.source_owner_id.unwrap_or(id);
                let Some(source) = resolver(owner) else {
                    continue;
                };
                let decoder = decoders.entry(owner).or_insert_with(|| Decoder::new(source));
                for part in decoder.object(selected.object_index).iter() {
                    let key = (selected.source_owner_id, part.face_tag, part.render_style_id, part.material_id);
                    let vertices: Vec<P3> = part.vertices.iter().map(|&p| place(selected.world_transform, p)).collect();
                    if mirrors(selected.world_transform) {
                        let flipped: Vec<[u32; 3]> = part.triangles.iter().map(|&[a, b, c]| [a, c, b]).collect();
                        mesh.add(&vertices, &flipped, key);
                    } else {
                        mesh.add(&vertices, &part.triangles, key);
                    }
                }
            }
            // What rvt-rs did decode, where this decoder found nothing more.
            if mesh.triangle_count() == 0 {
                for p in &upstream.primitives {
                    let key = (p.source_owner_id, p.face_tag, p.render_style_id, p.material_id);
                    mesh.add(&p.vertices, &p.triangles, key);
                }
            }
        }
        if mesh.triangle_count() > 0 {
            meshes.push((index, id, mesh));
        }
    }
    let looks = Looks::new(&materials, &meshes);
    for (index, id, mesh) in meshes {
        attached.report.replaced += 1;
        attached.report.triangles += mesh.triangle_count();
        if let Some(runs) = set_mesh(model, index, mesh, |key| looks.of(id, key)) {
            attached.materials.insert(index, runs);
        }
    }
    for decoder in decoders.values() {
        for (reason, n) in &decoder.failures {
            *attached.failures.entry(reason.clone()).or_default() += n;
        }
    }
    Ok(attached)
}

/// Relax two fail-closed checks of rvt-rs's graphics traversal, which drop
/// a whole element:
///
/// - an instance with target restrictions (`m_forbiddenTarget`): the root
///   instances of furniture carry them and Revit draws that furniture in 3D;
/// - a `GBiFlipControl`, the flip arrows of a railing: drawn as a point,
///   which the traversal leaves out as it does curves.
fn relax(graph: &mut ObjectGraph) {
    for object in &mut graph.objects {
        match object.class_name.as_str() {
            "GInstance" => {
                if let Some(targets) = object.fields.pointer_mut("/m_forbiddenTarget/m_targets") {
                    *targets = 0.into();
                }
            }
            "GBiFlipControl" => object.class_name = "GPoint".into(),
            _ => {}
        }
    }
}

/// Elements drawn as a box rvt-rs's `attach` would take, or a turned one,
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
                let symbol = brep::identifier(&object.fields["m_symbolId"])
                    .and_then(|id| u64::try_from(id).ok())
                    .filter(|id| *id > 0);
                if let Some(symbol) = symbol.filter(|id| attempted.insert(*id)) {
                    wanted.insert(symbol);
                }
            }
        }
    }
    Ok(records)
}

/// The document's saved materials, as `native_saved_scene` reads them.
fn material_resolver(rf: &mut RevitFile) -> anyhow::Result<Resolver> {
    let mut resolver = Resolver::default_viewport_profile();
    let mut options = Options {
        max_graph_values: 1_000_000,
        max_graph_objects: 1_000_000,
        ..Default::default()
    };
    options.channels = BTreeSet::from([MATERIAL_CHANNEL]);
    native_document::extract(rf, &options, |record| resolver.ingest(&record))?;
    Ok(resolver)
}

/// What selects a face's material besides its element: the shared symbol
/// it is drawn from, its tag, render style and material.
type FaceKey = (Option<u64>, i64, i64, Option<i64>);

/// A face's colour and opacity, quantised: `None` colour where unknown.
type Look = (Option<[u8; 3]>, u8);

/// The looks of the faces of the replaced bodies. Where an instance's face
/// resolves to no material of its own, it takes the one another instance of
/// the same symbol resolves the same face to (the material lookup goes by
/// the instance, and finds the type's materials for some instances only).
struct Looks {
    own: HashMap<(u64, FaceKey), Look>,
    shared: HashMap<FaceKey, Look>,
}

impl Looks {
    fn new(resolver: &Resolver, meshes: &[(usize, u64, ElementMesh)]) -> Self {
        let mut own = HashMap::new();
        let mut shared = HashMap::new();
        for (_, id, mesh) in meshes {
            for &key in mesh.by_key.keys() {
                let look = *own.entry((*id, key)).or_insert_with(|| resolve(resolver, *id, key));
                if key.0.is_some() && look.0.is_some() {
                    shared.entry(key).or_insert(look);
                }
            }
        }
        Self { own, shared }
    }

    fn of(&self, owner: u64, key: FaceKey) -> Look {
        let own = self.own.get(&(owner, key)).copied().unwrap_or((None, 255));
        match own.0 {
            Some(_) => own,
            None => self.shared.get(&key).copied().unwrap_or(own),
        }
    }
}

fn resolve(resolver: &Resolver, owner: u64, (source, face_tag, style, material): FaceKey) -> Look {
    let Some(m) = resolver.resolve(owner, source, face_tag, style, material) else {
        return (None, 255);
    };
    // The viewport default stands for no material of its own.
    let color = m.material_id.map(|_| m.base_color).map(|c| [c[0], c[1], c[2]].map(unit_byte));
    let opacity = unit_byte(m.saved_opacity.unwrap_or(1.0));
    (color, opacity)
}

fn unit_byte(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// An element's triangles in document feet, by what selects their material.
#[derive(Default)]
struct ElementMesh {
    vertices: Vec<P3>,
    by_key: BTreeMap<FaceKey, Vec<[u32; 3]>>,
}

impl ElementMesh {
    fn add(&mut self, vertices: &[P3], triangles: &[[u32; 3]], key: FaceKey) {
        let base = self.vertices.len() as u32;
        let count = vertices.len();
        if !vertices.iter().flatten().all(|v| v.is_finite()) {
            return;
        }
        self.vertices.extend_from_slice(vertices);
        self.by_key.entry(key).or_default().extend(
            triangles
                .iter()
                .filter(|t| t.iter().all(|&v| (v as usize) < count))
                .map(|t| t.map(|v| base + v)),
        );
    }

    fn triangle_count(&self) -> usize {
        self.by_key.values().map(Vec::len).sum()
    }
}

fn place(m: GraphicsTransform, p: P3) -> P3 {
    std::array::from_fn(|i| m[i][3] + (0..3).map(|j| m[i][j] * p[j]).sum::<f64>())
}

fn mirrors(m: GraphicsTransform) -> bool {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    det < 0.0
}

/// Draw entity `index` from `mesh`, in its placement's frame as rvt-rs's
/// `attach` does, its triangles in runs of one look. Returns the runs where
/// one is transparent: those bodies are drawn in their faces' colours, the
/// others keep the element's.
fn set_mesh(
    model: &mut IfcModel,
    index: usize,
    mesh: ElementMesh,
    look: impl Fn(FaceKey) -> Look,
) -> Option<Vec<MaterialRun>> {
    let IfcEntity::BuildingElement {
        location_feet: Some(origin),
        rotation_radians,
        solid_shape,
        property_set: Some(set),
        ..
    } = &mut model.entities[index]
    else {
        return None;
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
    let mut by_look: BTreeMap<Look, Vec<&[u32; 3]>> = BTreeMap::new();
    for (&key, list) in &mesh.by_key {
        by_look.entry(look(key)).or_default().extend(list);
    }
    let mut triangles = Vec::new();
    let mut runs = Vec::new();
    for (look, list) in &by_look {
        if list.is_empty() {
            continue;
        }
        triangles.extend(list.iter().map(|t| BrepTriangle(t[0], t[1], t[2])));
        runs.push(MaterialRun {
            triangles: list.len(),
            color: look.0.map(|c| c.map(|v| f32::from(v) / 255.0)),
            opacity: f32::from(look.1) / 255.0,
        });
    }
    *solid_shape = Some(SolidShape::TriangulatedFaceSet {
        vertices_feet: vertices,
        triangles,
    });
    for property in &mut set.properties {
        if property.name == "BodySource" {
            property.value = PropertyValue::Text(SAVED_MESH_BODY_SOURCE.into());
        }
    }
    runs.iter().any(|r| r.opacity < 1.0).then_some(runs)
}
