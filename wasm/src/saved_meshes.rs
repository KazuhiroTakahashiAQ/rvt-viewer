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
//!
//! [`Refiner`] does it a batch of elements at a time, in the order the
//! viewer asks for them (what is on screen first), and hands each body over
//! ready to draw ([`Body`]).

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
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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

/// A body drawn from its saved mesh, as the page draws it: in glTF's frame
/// (metres, Y up) like [`rvt::ifc::gltf::model_to_glb`]'s, wound outward
/// (by its signed volume, as the page orients the GLB's bodies), with its
/// crease edges.
pub struct Body {
    pub entity: usize,
    /// `x, y, z` per vertex.
    pub positions: Vec<f32>,
    /// Three vertex indices per triangle.
    pub triangles: Vec<u32>,
    /// Segment end points, `x, y, z` each: the edges between faces meeting
    /// at more than [`CREASE_DEGREES`] and the open ones, as three.js's
    /// `EdgesGeometry` finds them.
    pub edges: Vec<f32>,
    /// The body's triangles in runs of one material, in order, where one is
    /// transparent; `None` to draw it in the element's colour.
    pub runs: Option<Vec<MaterialRun>>,
}

/// What [`Refiner::batch`] did.
#[derive(Default)]
pub struct Batch {
    /// New bodies, and earlier ones again whose runs changed.
    pub bodies: Vec<Body>,
    /// The candidates the batch took, drawn or not.
    pub done: Vec<usize>,
}

/// The crease angle of the viewer's edges.
pub const CREASE_DEGREES: f64 = 25.0;

/// Elements decoded per pass where all are wanted ([`attach`]). Each pass
/// holds its elements' graphs and the symbols they draw, as JSON values
/// many times the size of the file's bytes (Snowdon Towers: 3,555
/// elements and 3,525 symbols took about 2.9 GB at once), and drops them
/// before the next.
pub const CHUNK: usize = 500;

/// Record classes the material lookup reads besides the drawn elements' own
/// records: materials, their appearances, object styles, and the wall and
/// floor types that give their instances one material.
const MATERIAL_CLASSES: [&str; 5] = [
    "MaterialElem",
    "AppearanceAssetElem",
    "GStyleElem",
    "BasicWallType",
    "FloorAttributes",
];

/// Replaces box bodies with the meshes Revit saved for display, a batch of
/// elements at a time, in the order the caller wants them.
///
/// The material lookup reads the materials once ([`MATERIAL_CLASSES`]),
/// and each element's own record and its symbols' with its graphics: the
/// paint of a face is on its element (or symbol), the rest is shared. Where
/// an instance's face resolves to no material of its own, it takes the one
/// another instance of the same symbol resolves it to ([`Looks`]); an
/// earlier body whose runs change that way is sent again.
pub struct Refiner {
    /// Candidates not taken yet: entity index → ElementId.
    pending: BTreeMap<usize, u64>,
    resolver: Resolver,
    /// ElementIds whose material-channel record the resolver has read.
    ingested: HashSet<u64>,
    looks: Looks,
    drawn: HashMap<usize, Drawn>,
    /// Face keys no instance has resolved yet → the bodies drawn without.
    waiting: HashMap<FaceKey, Vec<usize>>,
    pub report: SavedMeshReport,
    /// Why faces and objects were left out, with counts.
    pub failures: BTreeMap<String, usize>,
}

/// A replaced body's ElementId, face-key groups and the runs last sent.
struct Drawn {
    id: u64,
    keys: Vec<(FaceKey, usize)>,
    runs: Option<Vec<MaterialRun>>,
}

impl Refiner {
    /// The candidates of `model`: bodies that are a box rvt-rs's `attach`
    /// would replace, or a turned one ([`boxed_bodies`]).
    pub fn new(rf: &mut RevitFile, model: &IfcModel) -> anyhow::Result<Self> {
        let pending: BTreeMap<usize, u64> = boxed_bodies(model)
            .into_iter()
            .map(|(id, index)| (index, id))
            .collect();
        let mut resolver = Resolver::default_viewport_profile();
        if !pending.is_empty() {
            let mut options = graph_options([MATERIAL_CHANNEL]);
            options.selected_classes = MATERIAL_CLASSES.iter().map(|c| c.to_string()).collect();
            native_document::extract_graphs(rf, &options, |record| resolver.ingest(&record))?;
        }
        Ok(Self {
            report: SavedMeshReport {
                candidates: pending.len(),
                ..Default::default()
            },
            pending,
            resolver,
            ingested: HashSet::new(),
            looks: Looks::default(),
            drawn: HashMap::new(),
            waiting: HashMap::new(),
            failures: BTreeMap::new(),
        })
    }

    /// The candidates not taken yet, by entity index.
    pub fn pending(&self) -> impl Iterator<Item = usize> + '_ {
        self.pending.keys().copied()
    }

    pub fn is_done(&self) -> bool {
        self.pending.is_empty()
    }

    /// Draw the candidates among `entities` from their saved meshes, in
    /// `model` and as [`Body`]s; the others are left out.
    pub fn batch(
        &mut self,
        rf: &mut RevitFile,
        model: &mut IfcModel,
        entities: &[usize],
    ) -> anyhow::Result<Batch> {
        let wanted: Vec<(u64, usize)> = entities
            .iter()
            .filter_map(|&entity| self.pending.remove(&entity).map(|id| (id, entity)))
            .collect();
        let mut batch = Batch {
            bodies: Vec::new(),
            done: wanted.iter().map(|&(_, entity)| entity).collect(),
        };
        if wanted.is_empty() {
            return Ok(batch);
        }
        let (resolver, ingested) = (&mut self.resolver, &mut self.ingested);
        let mut records = graphics_records(
            rf,
            wanted.iter().map(|&(id, _)| id).collect(),
            &mut |record| {
                if ingested.insert(record.identity.element_id) {
                    resolver.ingest(&record)?;
                }
                Ok(())
            },
        )?;
        for graph in records.values_mut().filter_map(|r| r.graph.as_mut()) {
            relax(graph);
        }
        let resolver = |id: u64| records.get(&id).and_then(|r| r.graph.as_ref());
        let mut decoders: HashMap<u64, Decoder> = HashMap::new();
        let mut fresh = Vec::new();
        for &(id, index) in &wanted {
            let Some(graph) = resolver(id) else {
                continue;
            };
            let mesh = element_mesh(id, graph, &resolver, &mut decoders);
            if mesh.triangle_count() == 0 {
                continue;
            }
            self.report.replaced += 1;
            self.report.triangles += mesh.triangle_count();
            if let Some(keys) = set_mesh(model, index, mesh) {
                fresh.push((index, id, keys));
            }
        }
        for decoder in decoders.values() {
            for (reason, n) in &decoder.failures {
                *self.failures.entry(reason.clone()).or_default() += n;
            }
        }
        drop(decoders);
        drop(records);

        // Looks: this batch's own first, so that its bodies see each other's.
        let mut shared_now = Vec::new();
        for (_, id, keys) in &fresh {
            for &(key, _) in keys {
                if self.looks.learn(&self.resolver, *id, key) {
                    shared_now.push(key);
                }
            }
        }
        for (index, id, keys) in fresh {
            for &(key, _) in &keys {
                if self.looks.lacks(id, key) {
                    self.waiting.entry(key).or_default().push(index);
                }
            }
            let runs = material_runs(&keys, |key| self.looks.of(id, key));
            batch.bodies.extend(body(model, index, runs.clone()));
            self.drawn.insert(index, Drawn { id, keys, runs });
        }
        // Earlier bodies whose faces another instance has now resolved.
        let mut again = BTreeSet::new();
        for key in shared_now {
            again.extend(self.waiting.remove(&key).unwrap_or_default());
        }
        for index in again {
            let Some(drawn) = self.drawn.get_mut(&index) else {
                continue;
            };
            let runs = material_runs(&drawn.keys, |key| self.looks.of(drawn.id, key));
            if runs != drawn.runs {
                drawn.runs = runs.clone();
                batch.bodies.extend(body(model, index, runs));
            }
        }
        Ok(batch)
    }

    /// The runs of the replaced bodies with a transparent face, by entity.
    pub fn materials(&self) -> BTreeMap<usize, Vec<MaterialRun>> {
        self.drawn
            .iter()
            .filter_map(|(&index, drawn)| drawn.runs.clone().map(|runs| (index, runs)))
            .collect()
    }
}

pub struct Attached {
    pub report: SavedMeshReport,
    /// Entity index → its runs, for the bodies with a transparent face.
    pub materials: BTreeMap<usize, Vec<MaterialRun>>,
    /// Why faces and objects were left out, with counts.
    pub failures: BTreeMap<String, usize>,
}

/// Replace all the box bodies of `model` with the meshes Revit saved for
/// display, `chunk` elements a pass, instances of one family type together
/// (they draw the same symbols).
pub fn attach(rf: &mut RevitFile, model: &mut IfcModel, chunk: usize) -> anyhow::Result<Attached> {
    let mut refiner = Refiner::new(rf, model)?;
    let mut order: Vec<usize> = refiner.pending().collect();
    order.sort_by_cached_key(|&index| (family_and_type(model, index), refiner.pending[&index]));
    for pass in order.chunks(chunk.max(1)) {
        refiner.batch(rf, model, pass)?;
    }
    Ok(Attached {
        report: refiner.report.clone(),
        materials: refiner.materials(),
        failures: refiner.failures,
    })
}

fn graph_options<const N: usize>(channels: [u64; N]) -> Options {
    Options {
        max_graph_values: 1_000_000,
        max_graph_objects: 1_000_000,
        channels: BTreeSet::from(channels),
        ..Default::default()
    }
}

/// Element `id`'s saved graphics as triangles in document feet, by face key:
/// rvt-rs's decoder where it reports no problem, else [`Decoder`].
fn element_mesh<'g>(
    id: u64,
    graph: &'g ObjectGraph,
    resolver: &dyn Fn(u64) -> Option<&'g ObjectGraph>,
    decoders: &mut HashMap<u64, Decoder<'g>>,
) -> ElementMesh {
    let mut mesh = ElementMesh::default();
    let upstream =
        rvt::native_saved_mesh::graphics_with_resolver_at_detail(graph, resolver, DETAIL_LEVEL);
    let add_upstream = |mesh: &mut ElementMesh| {
        for p in &upstream.primitives {
            let key = (
                p.source_owner_id,
                p.face_tag,
                p.render_style_id,
                p.material_id,
            );
            mesh.add(&p.vertices, &p.triangles, key);
        }
    };
    if upstream.diagnostics.is_empty() {
        add_upstream(&mut mesh);
        return mesh;
    }
    let selection = select_graphics_with_resolver_at_detail(graph, resolver, DETAIL_LEVEL);
    for selected in &selection.selected {
        let owner = selected.source_owner_id.unwrap_or(id);
        let Some(source) = resolver(owner) else {
            continue;
        };
        let decoder = decoders
            .entry(owner)
            .or_insert_with(|| Decoder::new(source));
        for part in decoder.object(selected.object_index).iter() {
            let key = (
                selected.source_owner_id,
                part.face_tag,
                part.render_style_id,
                part.material_id,
            );
            let vertices: Vec<P3> = part
                .vertices
                .iter()
                .map(|&p| place(selected.world_transform, p))
                .collect();
            if mirrors(selected.world_transform) {
                let flipped: Vec<[u32; 3]> =
                    part.triangles.iter().map(|&[a, b, c]| [a, c, b]).collect();
                mesh.add(&vertices, &flipped, key);
            } else {
                mesh.add(&vertices, &part.triangles, key);
            }
        }
    }
    // What rvt-rs did decode, where this decoder found nothing more.
    if mesh.triangle_count() == 0 {
        add_upstream(&mut mesh);
    }
    mesh
}

/// The family and type names of entity `index`, to order the candidates by.
fn family_and_type(model: &IfcModel, index: usize) -> (String, String) {
    let IfcEntity::BuildingElement {
        property_set: Some(set),
        ..
    } = &model.entities[index]
    else {
        return Default::default();
    };
    let text = |name: &str| {
        set.properties
            .iter()
            .find_map(|p| match &p.value {
                PropertyValue::Text(t) if p.name == name => Some(t.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    (text("FamilyName"), text("TypeName"))
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
        by_id
            .entry(id)
            .or_default()
            .push(if boxed { index } else { usize::MAX });
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
/// instances draw (`native_saved_scene::extract_at_detail`'s closure);
/// their material-channel records go to `material`.
fn graphics_records(
    rf: &mut RevitFile,
    ids: BTreeSet<u64>,
    material: &mut dyn FnMut(Record) -> anyhow::Result<()>,
) -> anyhow::Result<BTreeMap<u64, Record>> {
    let mut options = graph_options([MATERIAL_CHANNEL, GRAPHICS_CHANNEL]);
    let mut records = BTreeMap::<u64, Record>::new();
    let mut attempted = ids.clone();
    let mut wanted = ids;
    // Symbols nest (a family in a family); the same depth budget as rvt-rs.
    for _ in 0..=128 {
        if wanted.is_empty() {
            break;
        }
        options.selected_ids = std::mem::take(&mut wanted);
        native_document::extract_graphs(rf, &options, |record| {
            if record.channel == MATERIAL_CHANNEL {
                return material(record);
            }
            records.entry(record.identity.element_id).or_insert(record);
            Ok(())
        })?;
        for record in records.values() {
            let Some(graph) = &record.graph else {
                continue;
            };
            for object in graph
                .objects
                .iter()
                .filter(|o| o.class_name == "InstanceInfo")
            {
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

/// What selects a face's material besides its element: the shared symbol
/// it is drawn from, its tag, render style and material.
type FaceKey = (Option<u64>, i64, i64, Option<i64>);

/// A face's colour and opacity, quantised: `None` colour where unknown.
type Look = (Option<[u8; 3]>, u8);

/// The looks of the faces of the replaced bodies. Where an instance's face
/// resolves to no material of its own, it takes the one another instance of
/// the same symbol resolves the same face to (the material lookup goes by
/// the instance, and finds the type's materials for some instances only).
#[derive(Default)]
struct Looks {
    own: HashMap<(u64, FaceKey), Look>,
    shared: HashMap<FaceKey, Look>,
}

impl Looks {
    /// Resolve `owner`'s face `key`; true when that gives the face's look
    /// to the other instances of its symbol for the first time.
    fn learn(&mut self, resolver: &Resolver, owner: u64, key: FaceKey) -> bool {
        let look = *self
            .own
            .entry((owner, key))
            .or_insert_with(|| resolve(resolver, owner, key));
        if key.0.is_none() || look.0.is_none() || self.shared.contains_key(&key) {
            return false;
        }
        self.shared.insert(key, look);
        true
    }

    /// Whether `owner`'s face `key` waits for another instance's look.
    fn lacks(&self, owner: u64, key: FaceKey) -> bool {
        key.0.is_some() && self.of(owner, key).0.is_none()
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
    let color = m
        .material_id
        .map(|_| m.base_color)
        .map(|c| [c[0], c[1], c[2]].map(unit_byte));
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
/// `attach` does, its triangles grouped by face key. Returns the groups'
/// keys and sizes, in order.
fn set_mesh(
    model: &mut IfcModel,
    index: usize,
    mesh: ElementMesh,
) -> Option<Vec<(FaceKey, usize)>> {
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
    let mut triangles = Vec::with_capacity(mesh.triangle_count());
    let mut keys = Vec::new();
    for (key, list) in mesh.by_key {
        if list.is_empty() {
            continue;
        }
        keys.push((key, list.len()));
        triangles.extend(list.iter().map(|t| BrepTriangle(t[0], t[1], t[2])));
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
    Some(keys)
}

/// Entity `index`'s face set (as [`set_mesh`] writes it) as the page draws
/// it, or `None` where it has none.
fn body(model: &IfcModel, index: usize, runs: Option<Vec<MaterialRun>>) -> Option<Body> {
    let IfcEntity::BuildingElement {
        location_feet,
        rotation_radians,
        solid_shape:
            Some(SolidShape::TriangulatedFaceSet {
                vertices_feet,
                triangles,
            }),
        ..
    } = &model.entities[index]
    else {
        return None;
    };
    let origin = location_feet.unwrap_or([0.0; 3]);
    let (sin, cos) = rotation_radians
        .filter(|r| r.is_finite())
        .unwrap_or(0.0)
        .sin_cos();
    // The element's placement, then glTF's frame (`Z_UP_FEET_TO_Y_UP_METRES`).
    let place = |p: [f64; 3]| -> [f32; 3] {
        let x = origin[0] + cos * p[0] - sin * p[1];
        let y = origin[1] + sin * p[0] + cos * p[1];
        let z = origin[2] + p[2];
        [(x * FOOT) as f32, (z * FOOT) as f32, (-y * FOOT) as f32]
    };
    let triangles: Vec<[u32; 3]> = triangles.iter().map(|t| [t.0, t.1, t.2]).collect();
    let flip = signed_volume(vertices_feet, &triangles) < 0.0;
    let mut out = Body {
        entity: index,
        positions: vertices_feet.iter().flat_map(|&p| place(p)).collect(),
        triangles: triangles
            .iter()
            .flat_map(|&[a, b, c]| if flip { [a, c, b] } else { [a, b, c] })
            .collect(),
        edges: Vec::new(),
        runs,
    };
    for [a, b] in crease_edges(vertices_feet, &triangles) {
        out.edges.extend(place(a));
        out.edges.extend(place(b));
    }
    Some(out)
}

const FOOT: f64 = 0.3048;

/// The signed volume of a triangle mesh, positive where its triangles wind
/// counter-clockwise seen from outside; open or flat meshes, about zero,
/// count as outward (the page's `signedVolume`).
fn signed_volume(vertices: &[P3], triangles: &[[u32; 3]]) -> f64 {
    let volume: f64 = triangles
        .iter()
        .filter_map(|t| {
            let [a, b, c] = t.map(|v| vertices.get(v as usize));
            let (a, b, c) = (a?, b?, c?);
            let cross = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            Some(a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2])
        })
        .sum::<f64>()
        / 6.0;
    if volume.abs() < 1e-12 { 1.0 } else { volume }
}

/// The edges three.js's `EdgesGeometry` draws for these triangles at
/// [`CREASE_DEGREES`]: where two faces meet at more than that angle, and
/// those of one face only. Vertices are matched by position to 1e-4 feet
/// after rounding to `f32`, as the page matched the GLB's.
fn crease_edges(vertices: &[P3], triangles: &[[u32; 3]]) -> Vec<[P3; 2]> {
    type Key = [i64; 3];
    /// A face's edge not matched yet: its vertices and the face's normal.
    type Open = Option<(u32, u32, P3)>;
    let threshold = CREASE_DEGREES.to_radians().cos();
    let key = |p: P3| -> Key { p.map(|v| (f64::from(v as f32) * 1e4).round() as i64) };
    let mut open: HashMap<(Key, Key), Open> = HashMap::new();
    // Insertion order, for a stable output.
    let mut order: Vec<(Key, Key)> = Vec::new();
    let mut out = Vec::new();
    for t in triangles {
        let Some(p) = t
            .iter()
            .map(|&v| vertices.get(v as usize).copied())
            .collect::<Option<Vec<P3>>>()
        else {
            continue;
        };
        let keys = [key(p[0]), key(p[1]), key(p[2])];
        if keys[0] == keys[1] || keys[1] == keys[2] || keys[2] == keys[0] {
            continue;
        }
        let normal = unit_normal(p[0], p[1], p[2]);
        for j in 0..3 {
            let k = (j + 1) % 3;
            let edge = (keys[j], keys[k]);
            let reverse = (keys[k], keys[j]);
            if let Some(slot) = open.get_mut(&reverse).filter(|slot| slot.is_some()) {
                let (_, _, other) = slot.take().expect("filtered on some");
                if dot(normal, other) <= threshold {
                    out.push([p[j], p[k]]);
                }
            } else if let std::collections::hash_map::Entry::Vacant(slot) = open.entry(edge) {
                slot.insert(Some((t[j], t[k], normal)));
                order.push(edge);
            }
        }
    }
    for edge in order {
        if let Some(Some((a, b, _))) = open.get(&edge) {
            out.push([vertices[*a as usize], vertices[*b as usize]]);
        }
    }
    out
}

/// `(c - b) × (a - b)`, normalised: three.js's `Triangle.getNormal`.
fn unit_normal(a: P3, b: P3, c: P3) -> P3 {
    let u = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    let v = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let length = dot(n, n).sqrt();
    if length > 0.0 {
        n.map(|v| v / length)
    } else {
        [0.0; 3]
    }
}

fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// A body's runs of one look, from its face-key groups: where one is
/// transparent, so that those bodies are drawn in their faces' colours and
/// the others keep the element's.
fn material_runs(
    keys: &[(FaceKey, usize)],
    look: impl Fn(FaceKey) -> Look,
) -> Option<Vec<MaterialRun>> {
    let mut runs: Vec<(Look, usize)> = Vec::new();
    for &(key, count) in keys {
        let look = look(key);
        match runs.last_mut() {
            Some((last, n)) if *last == look => *n += count,
            _ => runs.push((look, count)),
        }
    }
    if !runs.iter().any(|(look, _)| look.1 < 255) {
        return None;
    }
    Some(
        runs.into_iter()
            .map(|(look, triangles)| MaterialRun {
                triangles,
                color: look.0.map(|c| c.map(|v| f32::from(v) / 255.0)),
                opacity: f32::from(look.1) / 255.0,
            })
            .collect(),
    )
}
