//! Tessellation of the saved B-rep faces rvt-rs's decoder rejects.
//!
//! rvt-rs (`native_saved_mesh`) tessellates planes, and cylinders, surfaces
//! of revolution and ruled surfaces under a rectangular trim, and drops a
//! whole `Geometry` when one of its faces is outside that: a cone, a cylinder
//! cut by another body or with a hole, a left-handed cylinder frame, a ruled
//! surface to a point (a duct transition), an ellipse or Hermite spline
//! profile. Pipe and duct fittings, furniture and railings stayed boxes.
//!
//! [`Decoder`] triangulates each face in its surface's parameter plane inside
//! its trim loops, then splits triangle edges until each stays within
//! [`CHORD`] of the surface. An edge between two faces is sampled once, on
//! its curved side, so both faces take the same points and meet without
//! cracks. A face whose surface it cannot evaluate is left out; the other
//! faces of its body are kept.

use rvt::native_parameters::{GraphObject, ObjectGraph};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

pub type P3 = [f64; 3];
type P2 = [f64; 2];

/// Largest distance, feet, between a triangle edge and the surface it
/// spans, and as a share of the edge's length: about 23° of arc a segment,
/// below the viewer's 25° crease angle so that a curved face draws no edges.
const CHORD: f64 = 0.02;
const CHORD_SHARE: f64 = 0.05;
/// Edges shorter than this, feet, are not split.
const MIN_EDGE: f64 = 5e-3;
/// One saved edge sample interval is split into at most 2^MAX_DEPTH.
const MAX_DEPTH: u32 = 7;
/// Vertices of one face, at most.
const MAX_FACE_VERTICES: usize = 50_000;
/// Saved trim points closer than this in the parameter plane are one.
const UV_CLOSE: f64 = 1e-7;
/// Saved trim points this close are one where the closer test leaves a loop
/// open: edges meeting within Revit's modelling tolerance.
const UV_GAP: f64 = 1e-4;
/// Trim points closer than this in space, feet, are one point (at a pole).
const POLE: f64 = 1e-6;
const TAU: f64 = std::f64::consts::TAU;

/// One face's (or one polygon mesh's) triangles, in the graph's frame, and
/// what selects its material.
pub struct Part {
    pub vertices: Vec<P3>,
    pub triangles: Vec<[u32; 3]>,
    pub face_tag: i64,
    pub render_style_id: i64,
    pub material_id: Option<i64>,
}

/// Decodes the surface-bearing objects of one saved graphics graph, keeping
/// what it decoded: a family's graph serves all its instances.
pub struct Decoder<'a> {
    graph: &'a ObjectGraph,
    pointers: Pointers<'a>,
    surfaces: HashMap<usize, Option<Rc<(Surface, bool)>>>,
    edges: HashMap<usize, Option<Rc<EdgeSamples>>>,
    objects: HashMap<usize, Rc<Vec<Part>>>,
    /// Why faces or objects were left out, with counts.
    pub failures: BTreeMap<String, usize>,
}

impl<'a> Decoder<'a> {
    pub fn new(graph: &'a ObjectGraph) -> Self {
        Self {
            graph,
            pointers: Pointers::new(graph),
            surfaces: HashMap::new(),
            edges: HashMap::new(),
            objects: HashMap::new(),
            failures: BTreeMap::new(),
        }
    }

    fn fail(&mut self, reason: String) {
        *self.failures.entry(reason).or_default() += 1;
    }

    /// The parts of object `index`: a `Geometry`'s faces or a `GPolyMesh`.
    pub fn object(&mut self, index: usize) -> Rc<Vec<Part>> {
        if let Some(parts) = self.objects.get(&index) {
            return parts.clone();
        }
        let parts = match self.graph.objects[index].class_name.as_str() {
            "Geometry" => self.geometry(index),
            "GPolyMesh" => match self.poly_mesh(index) {
                Ok(part) => vec![part],
                Err(e) => {
                    self.fail(e);
                    Vec::new()
                }
            },
            _ => Vec::new(),
        };
        let parts = Rc::new(parts);
        self.objects.insert(index, parts.clone());
        parts
    }

    /// A body's faces, each from rvt-rs where this decoder cannot read it.
    fn geometry(&mut self, index: usize) -> Vec<Part> {
        let graph = self.graph;
        let Some(pointers) = graph.objects[index].fields["m_pFaces"].as_array() else {
            self.fail("geometry without faces".into());
            return Vec::new();
        };
        let mut parts = Vec::new();
        for pointer in pointers {
            let face = match self.pointers.resolve(index, pointer) {
                Ok(Some(face)) => face,
                Ok(None) => continue,
                Err(e) => {
                    self.fail(e);
                    continue;
                }
            };
            match self.face(face) {
                Ok(Some(part)) => parts.push(part),
                Ok(None) => {}
                Err(e) => {
                    self.fail(e);
                    if let Ok(Some(mesh)) = rvt::native_saved_mesh::face(graph, face) {
                        parts.push(Part {
                            vertices: mesh.vertices,
                            triangles: mesh.triangles,
                            face_tag: mesh.face_tag,
                            render_style_id: mesh.render_style_id,
                            material_id: None,
                        });
                    }
                }
            }
        }
        parts
    }

    /// A `GPolyMesh` over any faceted topology: points and polygon facets
    /// (`FacetedTopology8` adds a normal and an edge flag per facet).
    fn poly_mesh(&self, index: usize) -> Result<Part, String> {
        let object = &self.graph.objects[index];
        let topology = self
            .pointers
            .resolve(index, &object.fields["m_pFacetedTopology"])?
            .ok_or("polymesh without topology")?;
        let topology = &self.graph.objects[topology];
        if !topology.class_name.starts_with("FacetedTopology") {
            return Err(format!("unsupported polymesh topology {}", topology.class_name));
        }
        let vertices = topology.fields["m_pointsArr"]
            .as_array()
            .ok_or("polymesh points")?
            .iter()
            .map(point3)
            .collect::<Result<Vec<_>, _>>()?;
        let mut triangles = Vec::new();
        for facet in topology.fields["m_facetsArr"].as_array().ok_or("polymesh facets")? {
            let corners = facet
                .as_array()
                .ok_or("polymesh facet")?
                .iter()
                .map(|v| v.as_u64().filter(|&v| (v as usize) < vertices.len()).map(|v| v as u32))
                .collect::<Option<Vec<_>>>()
                .ok_or("polymesh facet index")?;
            for k in 1..corners.len().saturating_sub(1) {
                triangles.push([corners[0], corners[k], corners[k + 1]]);
            }
        }
        Ok(Part {
            vertices,
            triangles,
            face_tag: object.fields["m_GInfo"]["m_tag"].as_i64().unwrap_or(-1),
            render_style_id: identifier(&object.fields["m_interiorGStyleID"]).unwrap_or(-1),
            material_id: identifier(&object.fields["m_materialID"]).filter(|&id| id >= 0),
        })
    }

    /// Face `index` tessellated, `None` for a face with no trim (an
    /// auxiliary surface).
    fn face(&mut self, index: usize) -> Result<Option<Part>, String> {
        let graph = self.graph;
        let face = &graph.objects[index];
        if face.class_name != "Face" {
            return Err(format!("face is a {}", face.class_name));
        }
        let Some(first) = self.pointers.resolve(index, &face.fields["m_pFirstLoop"])? else {
            return Ok(None);
        };
        if face.fields["m_faceRegions"].as_array().is_none_or(|r| !r.is_empty()) {
            return Err("face regions".into());
        }
        let surface = self.surface(index).ok_or("face surface unsupported")?;
        let (surface, orient) = (&surface.0, surface.1);
        let period = surface.period();

        let mut loops = Vec::new();
        let mut seen = BTreeSet::new();
        let mut li = first;
        loop {
            if !seen.insert(li) {
                return Err("loop list cycle".into());
            }
            loops.push(self.ring(index, li, period)?);
            match self.pointers.resolve(li, &graph.objects[li].fields["m_nextLoop"])? {
                Some(next) => li = next,
                None => break,
            }
        }
        // Loops of a periodic surface may be a turn apart: bring them to the
        // first one's turn.
        if let Some(period) = period.filter(|_| loops.len() > 1) {
            let mean = |ring: &[(P2, P3)]| ring.iter().map(|p| p.0[0]).sum::<f64>() / ring.len() as f64;
            let reference = mean(&loops[0]);
            for ring in &mut loops[1..] {
                let shift = ((reference - mean(ring)) / period).round() * period;
                for p in ring.iter_mut() {
                    p.0[0] += shift;
                }
            }
        }
        let uv_rings: Vec<Vec<P2>> = loops.iter().map(|r| r.iter().map(|p| p.0).collect()).collect();
        let depths: Vec<usize> = (0..loops.len())
            .map(|i| {
                (0..loops.len())
                    .filter(|&j| j != i && inside(uv_rings[i][0], &uv_rings[j]))
                    .count()
            })
            .collect();

        let mut vertices = Vec::new();
        let mut triangles = Vec::new();
        for outer in (0..loops.len()).filter(|&i| depths[i] % 2 == 0) {
            let mut uv: Vec<P2> = Vec::new();
            let mut xyz: Vec<P3> = Vec::new();
            let mut holes = Vec::new();
            let mut boundary = BTreeSet::new();
            let mut add_ring = |ring: &[(P2, P3)], uv: &mut Vec<P2>, xyz: &mut Vec<P3>| {
                let start = uv.len();
                for (p, q) in ring {
                    uv.push(*p);
                    xyz.push(*q);
                }
                for k in start..uv.len() {
                    let next = if k + 1 == uv.len() { start } else { k + 1 };
                    boundary.insert(edge_key(k as u32, next as u32));
                }
            };
            add_ring(&loops[outer], &mut uv, &mut xyz);
            for hole in (0..loops.len()).filter(|&j| {
                depths[j] == depths[outer] + 1 && inside(uv_rings[j][0], &uv_rings[outer])
            }) {
                holes.push(uv.len() as u32);
                add_ring(&loops[hole], &mut uv, &mut xyz);
            }
            let mut indices = Vec::<u32>::new();
            earcut::Earcut::new().earcut(uv.iter().copied(), &holes, &mut indices);
            let mut local: Vec<[u32; 3]> = indices
                .chunks_exact(3)
                .map(|t| [t[0], t[1], t[2]])
                .filter(|t| t.iter().all(|&v| (v as usize) < uv.len()))
                .filter(|t| cross2(uv[t[0] as usize], uv[t[1] as usize], uv[t[2] as usize]).abs() > 1e-14)
                .collect();
            if local.is_empty() {
                return Err("triangulation failed".into());
            }
            retain_boundary_points(&uv, &mut local)?;
            if !surface.planar() {
                refine(surface, &mut uv, &mut xyz, &mut local, &boundary);
            }
            let base = vertices.len() as u32;
            for t in local {
                let [a, b, c] = t.map(|v| xyz[v as usize]);
                let geometric = cross(sub(b, a), sub(c, a));
                if norm(geometric) <= 1e-18 {
                    continue;
                }
                let centre = [
                    (uv[t[0] as usize][0] + uv[t[1] as usize][0] + uv[t[2] as usize][0]) / 3.0,
                    (uv[t[0] as usize][1] + uv[t[1] as usize][1] + uv[t[2] as usize][1]) / 3.0,
                ];
                let normal = surface.normal(centre);
                let facing = dot(geometric, normal) * if orient { 1.0 } else { -1.0 };
                let t = if facing < 0.0 { [t[0], t[2], t[1]] } else { t };
                triangles.push(t.map(|v| base + v));
            }
            vertices.extend(xyz);
        }
        if triangles.is_empty() {
            return Err("no bounded triangles".into());
        }
        Ok(Some(Part {
            vertices,
            triangles,
            face_tag: face.fields["m_GInfo"]["m_tag"].as_i64().unwrap_or(-1),
            render_style_id: identifier(&face.fields["m_renderStyleId"]).unwrap_or(-1),
            material_id: None,
        }))
    }

    /// Face `face`'s surface and whether its normal is the surface's.
    fn surface(&mut self, face: usize) -> Option<Rc<(Surface, bool)>> {
        if let Some(surface) = self.surfaces.get(&face) {
            return surface.clone();
        }
        let surface = match self.read_surface(face) {
            Ok(surface) => Some(Rc::new(surface)),
            Err(e) => {
                self.fail(e);
                None
            }
        };
        self.surfaces.insert(face, surface.clone());
        surface
    }

    fn read_surface(&self, face: usize) -> Result<(Surface, bool), String> {
        let graph = self.graph;
        let fields = &graph.objects[face].fields;
        let index = self
            .pointers
            .resolve(face, &fields["m_pSurf"])?
            .ok_or("face without surface")?;
        let object = &graph.objects[index];
        let s = &object.fields;
        let reversed = fields["m_faceFlags_v9"].as_u64().ok_or("face flags")? & 2 != 0;
        let orient = s["m_orientFlag"].as_bool().ok_or("surface orientation")? ^ reversed;
        let surface = match object.class_name.as_str() {
            "Plane" => Surface::Plane {
                origin: point3(&s["m_origin"])?,
                x: point3(&s["m_xVec"])?,
                y: point3(&s["m_yVec"])?,
            },
            "CylSurf" => Surface::Cylinder {
                center: point3(&s["m_center"])?,
                radius: number(&s["m_radius"])?,
                x: point3(&s["m_xVec"])?,
                y: point3(&s["m_yVec"])?,
                z: point3(&s["m_zVec"])?,
            },
            // The apex, and v along the generator from it.
            "ConeSurf" => Surface::Cone {
                apex: point3(&s["m_center"])?,
                half_angle: number(&s["m_halfAngle"])?,
                x: point3(&s["m_xVec"])?,
                y: point3(&s["m_yVec"])?,
                z: point3(&s["m_zVec"])?,
            },
            "SurfRev" => Surface::Revolution {
                center: point3(&s["m_center"])?,
                x: point3(&s["m_xVec"])?,
                y: point3(&s["m_yVec"])?,
                z: point3(&s["m_zVec"])?,
                profile: self.curve(index, &s["m_pProfileCurve"])?.ok_or("revolution without profile")?,
            },
            // A profile pointer may be null, the generators then meeting at
            // its point.
            "RuledSurf" => {
                let profile = |n: u8| -> Result<Profile, String> {
                    match self.curve(index, &s[format!("m_pProfileCurve{n}")])? {
                        Some(curve) => Ok(Profile::Curve(curve)),
                        None => Ok(Profile::Point(point3(&s[format!("m_Point{n}")])?)),
                    }
                };
                Surface::Ruled {
                    first: profile(1)?,
                    second: profile(2)?,
                }
            }
            other => return Err(format!("unsupported surface {other}")),
        };
        Ok((surface, orient))
    }

    fn curve(&self, source: usize, pointer: &Value) -> Result<Option<Curve>, String> {
        match self.pointers.resolve(source, pointer)? {
            Some(index) => Curve::read(&self.graph.objects[index]).map(Some),
            None => Ok(None),
        }
    }

    /// Loop `li` of face `face` in its parameter plane, each point with its
    /// position.
    fn ring(&mut self, face: usize, li: usize, period: Option<f64>) -> Result<Vec<(P2, P3)>, String> {
        let graph = self.graph;
        let object = &graph.objects[li];
        if !["EdgeLoop", "EdgeLoopWithChainEnvelopes"].contains(&object.class_name.as_str()) {
            return Err(format!("unsupported loop {}", object.class_name));
        }
        if object.fields["m_open"] != false {
            return Err("open loop".into());
        }
        let mut current = self.pointers.resolve(li, &object.fields["m_next"])?.ok_or("empty loop")?;
        let mut seen = BTreeSet::new();
        let mut segments: Vec<Vec<(P2, P3)>> = Vec::new();
        while current != li {
            if !seen.insert(current) {
                return Err("edge chain cycle".into());
            }
            let edge = &graph.objects[current];
            if edge.class_name != "Edge" {
                return Err(format!("loop member is a {}", edge.class_name));
            }
            let faces = edge.fields["m_pFace"].as_array().ok_or("edge faces")?;
            let sides: Vec<usize> = (0..faces.len().min(2))
                .filter(|&k| self.pointers.resolve(current, &faces[k]).ok().flatten() == Some(face))
                .collect();
            let [side] = sides[..] else {
                return Err("seam edge".into());
            };
            let samples = self.edge(current).ok_or("edge unreadable")?;
            let uv = samples.uv[side].as_ref().ok_or("edge without trim on this face")?;
            segments.push(uv.iter().copied().zip(samples.xyz.iter().copied()).collect());
            current = self
                .pointers
                .resolve(current, &edge.fields["m_next"][side])?
                .ok_or("null next edge")?;
        }
        if segments.is_empty() {
            return Err("empty loop".into());
        }
        let shifts = match period {
            Some(p) => vec![0.0, p, -p],
            None => vec![0.0],
        };
        // Adjacent edges may end apart by Revit's modelling tolerance. At a
        // pole (a cone's apex, a dome's top, a ruled surface narrowing to a
        // point) they meet in space at different u: the loop runs along it.
        let same = |a: &(P2, P3), b: &(P2, P3), tolerance: f64| {
            (a.0[0] - b.0[0]).hypot(a.0[1] - b.0[1]) < tolerance || norm(sub(a.1, b.1)) < POLE
        };
        for (tolerance, reverse) in [(UV_CLOSE, false), (UV_CLOSE, true), (UV_GAP, false), (UV_GAP, true)] {
            let close = |a: P2, b: P2| (a[0] - b[0]).hypot(a[1] - b[1]) < tolerance;
            let mut out = segments[0].clone();
            if reverse {
                out.reverse();
            }
            let mut joined = true;
            for segment in &segments[1..] {
                let last = *out.last().unwrap();
                let (first, end) = (segment[0], *segment.last().unwrap());
                let shifted = |p: (P2, P3), shift: f64| ([p.0[0] + shift, p.0[1]], p.1);
                let Some((shift, forward, skip)) = shifts
                    .iter()
                    .find_map(|&shift| {
                        if close(shifted(first, shift).0, last.0) {
                            Some((shift, true, 1))
                        } else if close(shifted(end, shift).0, last.0) {
                            Some((shift, false, 1))
                        } else {
                            None
                        }
                    })
                    .or_else(|| {
                        if norm(sub(first.1, last.1)) < POLE {
                            Some((0.0, true, 0))
                        } else if norm(sub(end.1, last.1)) < POLE {
                            Some((0.0, false, 0))
                        } else {
                            None
                        }
                    })
                else {
                    joined = false;
                    break;
                };
                if forward {
                    out.extend(segment.iter().skip(skip).map(|&p| shifted(p, shift)));
                } else {
                    out.extend(segment.iter().rev().skip(skip).map(|&p| shifted(p, shift)));
                }
            }
            if joined && same(&out[0], out.last().unwrap(), tolerance) {
                if close(out[0].0, out.last().unwrap().0) {
                    out.pop();
                }
                out.dedup_by(|a, b| close(a.0, b.0));
                if out.len() >= 3 && area(&out.iter().map(|p| p.0).collect::<Vec<_>>()).abs() > 1e-14 {
                    return Ok(out);
                }
                return Err("degenerate loop".into());
            }
        }
        Err("disconnected loop".into())
    }

    /// Edge `index` sampled for both its faces.
    fn edge(&mut self, index: usize) -> Option<Rc<EdgeSamples>> {
        if let Some(samples) = self.edges.get(&index) {
            return samples.clone();
        }
        let samples = match self.read_edge(index) {
            Ok(samples) => Some(Rc::new(samples)),
            Err(e) => {
                self.fail(e);
                None
            }
        };
        self.edges.insert(index, samples.clone());
        samples
    }

    /// The saved samples of edge `index`, refined on the side whose surface
    /// curves (else either side that can be evaluated): positions from that
    /// surface, the other side's parameters interpolated between its own
    /// samples.
    fn read_edge(&mut self, index: usize) -> Result<EdgeSamples, String> {
        let graph = self.graph;
        let edge = &graph.objects[index];
        let faces = edge.fields["m_pFace"].as_array().ok_or("edge faces")?;
        let face = |k: usize| faces.get(k).and_then(|p| self.pointers.resolve(index, p).ok().flatten());
        let faces = [face(0), face(1)];
        let ends = edge.fields["m_firstAndLastEdgePnts"].as_array().ok_or("edge ends")?;
        let interior = edge.fields["m_interiorEdgePnts"].as_array().ok_or("edge samples")?;
        if ends.len() != 2 {
            return Err("edge ends".into());
        }
        let points: Vec<&Value> = std::iter::once(&ends[0]).chain(interior).chain(std::iter::once(&ends[1])).collect();
        let samples: [Option<Vec<P2>>; 2] = std::array::from_fn(|side| {
            points.iter().map(|p| point2(&p["uv"][side]).ok()).collect()
        });
        let surfaces = [0, 1].map(|side| match (faces[side], &samples[side]) {
            (Some(face), Some(_)) => Some(face),
            _ => None,
        });
        let surfaces = [surfaces[0].and_then(|f| self.surface(f)), surfaces[1].and_then(|f| self.surface(f))];
        let master = (0..2)
            .filter(|&side| surfaces[side].is_some())
            .min_by_key(|&side| (surfaces[side].as_ref().unwrap().0.planar(), side))
            .ok_or("edge without an evaluable side")?;
        let surface = &surfaces[master].as_ref().unwrap().0;
        let own = samples[master].as_ref().unwrap();
        // (sample interval, fraction along it)
        let mut params = vec![(0usize, 0.0)];
        for i in 0..own.len() - 1 {
            let (a, b) = (own[i], own[i + 1]);
            let mut fractions = Vec::new();
            subdivide(surface, a, b, 0.0, 1.0, surface.eval(a), surface.eval(b), 0, &mut fractions);
            params.extend(fractions.into_iter().map(|t| (i, t)));
            params.push((i, 1.0));
        }
        let at = |side: &[P2], (i, t): (usize, f64)| -> P2 {
            if t == 0.0 {
                side[i]
            } else if t == 1.0 {
                side[i + 1]
            } else {
                lerp2(side[i], side[i + 1], t)
            }
        };
        let uv = std::array::from_fn(|side| {
            samples[side]
                .as_ref()
                .filter(|s| s.len() == own.len())
                .map(|s| params.iter().map(|&p| at(s, p)).collect())
        });
        let xyz = params.iter().map(|&p| surface.eval(at(own, p))).collect();
        Ok(EdgeSamples { uv, xyz })
    }
}

struct EdgeSamples {
    /// Per side, the edge in that face's parameter plane.
    uv: [Option<Vec<P2>>; 2],
    /// The edge's points, shared by both sides.
    xyz: Vec<P3>,
}

/// Whether `p`, on the surface between `a` and `b`, is close enough to their
/// chord.
fn within_chord(p: P3, a: P3, b: P3) -> bool {
    let deviation = norm(sub(p, mid3(a, b)));
    let length = norm(sub(b, a));
    length < MIN_EDGE || (deviation <= CHORD && deviation <= CHORD_SHARE * length)
}

/// Split `a`–`b` (fractions `t0`..`t1`) until its chords stay within
/// [`CHORD`] of `surface`, pushing the fractions it adds in order.
#[allow(clippy::too_many_arguments)]
fn subdivide(surface: &Surface, a: P2, b: P2, t0: f64, t1: f64, p0: P3, p1: P3, depth: u32, out: &mut Vec<f64>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let t = (t0 + t1) / 2.0;
    let p = surface.eval(lerp2(a, b, t));
    if within_chord(p, p0, p1) {
        return;
    }
    subdivide(surface, a, b, t0, t, p0, p, depth + 1, out);
    out.push(t);
    subdivide(surface, a, b, t, t1, p, p1, depth + 1, out);
}

/// Split the interior edges of `triangles` whose midpoint leaves `surface`
/// by more than [`within_chord`] allows, longest first so that slivers lose
/// their long edges; boundary edges stay as their faces share them. Leaves
/// the triangulation as it was where that would take more than
/// [`MAX_FACE_VERTICES`].
fn refine(surface: &Surface, uv: &mut Vec<P2>, xyz: &mut Vec<P3>, triangles: &mut Vec<[u32; 3]>, boundary: &BTreeSet<(u32, u32)>) {
    let original = (uv.len(), xyz.len(), triangles.clone());
    let mut incident: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (i, t) in triangles.iter().enumerate() {
        for k in 0..3 {
            incident.entry(edge_key(t[k], t[(k + 1) % 3])).or_default().push(i);
        }
    }
    let length = |xyz: &[P3], (a, b): (u32, u32)| norm(sub(xyz[b as usize], xyz[a as usize])).to_bits();
    let mut queue: std::collections::BinaryHeap<(u64, (u32, u32))> = incident
        .keys()
        .filter(|key| !boundary.contains(key))
        .map(|&key| (length(xyz, key), key))
        .collect();
    while let Some((_, key)) = queue.pop() {
        if uv.len() >= MAX_FACE_VERTICES {
            uv.truncate(original.0);
            xyz.truncate(original.1);
            *triangles = original.2;
            return;
        }
        if incident.get(&key).is_none_or(|t| t.len() != 2) {
            continue;
        }
        let (a, b) = (key.0 as usize, key.1 as usize);
        let middle = lerp2(uv[a], uv[b], 0.5);
        let point = surface.eval(middle);
        // Against the surface at both ends: a boundary point is where the
        // neighbouring face put it, which this surface may miss slightly.
        if within_chord(point, surface.eval(uv[a]), surface.eval(uv[b])) {
            continue;
        }
        let m = uv.len() as u32;
        uv.push(middle);
        xyz.push(point);
        for ti in incident.remove(&key).unwrap() {
            let t = triangles[ti];
            let k = (0..3).find(|&k| edge_key(t[k], t[(k + 1) % 3]) == key).unwrap();
            let (x, y, z) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
            let new = triangles.len();
            triangles[ti] = [x, m, z];
            triangles.push([m, y, z]);
            if let Some(list) = incident.get_mut(&edge_key(y, z)) {
                for entry in list.iter_mut().filter(|e| **e == ti) {
                    *entry = new;
                }
            }
            incident.entry(edge_key(x, m)).or_default().push(ti);
            incident.entry(edge_key(m, y)).or_default().push(new);
            incident.entry(edge_key(m, z)).or_default().extend([ti, new]);
            for edge in [edge_key(x, m), edge_key(m, y), edge_key(m, z)] {
                if !boundary.contains(&edge) {
                    queue.push((length(xyz, edge), edge));
                }
            }
        }
    }
}

/// Put back the boundary points earcut dropped as collinear, splitting the
/// triangle edge that passes through each (as rvt-rs does), so the
/// neighbouring face meets every one. Before refinement every vertex is a
/// boundary point, so an edge through a dropped one is a boundary chord.
fn retain_boundary_points(points: &[P2], triangles: &mut Vec<[u32; 3]>) -> Result<(), String> {
    let used: BTreeSet<u32> = triangles.iter().flatten().copied().collect();
    for pi in (0..points.len() as u32).filter(|p| !used.contains(p)) {
        let p = points[pi as usize];
        let mut split = None;
        'search: for (ti, t) in triangles.iter().enumerate() {
            for k in 0..3 {
                let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                let (pa, pb) = (points[a as usize], points[b as usize]);
                let ab = [pb[0] - pa[0], pb[1] - pa[1]];
                let ap = [p[0] - pa[0], p[1] - pa[1]];
                let length2 = ab[0] * ab[0] + ab[1] * ab[1];
                let along = ap[0] * ab[0] + ap[1] * ab[1];
                if length2 > 1e-24 && cross2(pa, pb, p).abs() <= 1e-8 && along > 1e-12 && along < length2 - 1e-12 {
                    split = Some((ti, [a, pi, c], [pi, b, c]));
                    break 'search;
                }
            }
        }
        let Some((ti, first, second)) = split else {
            return Err("boundary point dropped by triangulation".into());
        };
        triangles[ti] = first;
        triangles.push(second);
    }
    Ok(())
}

#[derive(Clone)]
enum Curve {
    Line { origin: P3, direction: P3, range: P2 },
    Arc { center: P3, x: P3, y: P3, radius: f64, range: P2 },
    Ellipse { center: P3, x: P3, y: P3, radii: P2, range: P2 },
    /// (parameter, point, tangent) nodes of a cubic Hermite spline.
    Hermite { nodes: Vec<(f64, P3, P3)> },
}

impl Curve {
    fn read(object: &GraphObject) -> Result<Self, String> {
        let f = &object.fields;
        Ok(match object.class_name.as_str() {
            "GLine" => Self::Line {
                origin: point3(&f["m_origin"])?,
                direction: point3(&f["m_dirVec"])?,
                range: point2(&f["m_endParams"])?,
            },
            "GArc" => Self::Arc {
                center: point3(&f["m_center"])?,
                x: point3(&f["m_xVec"])?,
                y: point3(&f["m_yVec"])?,
                radius: number(&f["m_radius"])?,
                range: point2(&f["m_endParams"])?,
            },
            "GEllipse" => Self::Ellipse {
                center: point3(&f["m_center"])?,
                x: point3(&f["m_xVec"])?,
                y: point3(&f["m_yVec"])?,
                radii: [number(&f["m_xLen"])?, number(&f["m_yLen"])?],
                range: point2(&f["m_endParams"])?,
            },
            "GHermiteSpline" => {
                let nodes = f["m_NodeArray"]
                    .as_array()
                    .ok_or("spline nodes")?
                    .iter()
                    .map(|n| Ok((number(&n["m_iParametr"])?, point3(&n["m_iPoint"])?, point3(&n["m_iTangent"])?)))
                    .collect::<Result<Vec<_>, String>>()?;
                if nodes.len() < 2 || nodes.windows(2).any(|w| w[1].0 <= w[0].0) {
                    return Err("spline nodes not increasing".into());
                }
                Self::Hermite { nodes }
            }
            other => return Err(format!("unsupported profile curve {other}")),
        })
    }

    fn range(&self) -> P2 {
        match self {
            Self::Line { range, .. } | Self::Arc { range, .. } | Self::Ellipse { range, .. } => *range,
            Self::Hermite { nodes } => [nodes[0].0, nodes[nodes.len() - 1].0],
        }
    }

    fn eval(&self, t: f64) -> P3 {
        match self {
            Self::Line { origin, direction, .. } => add(*origin, scale(*direction, t)),
            Self::Arc { center, x, y, radius, .. } => {
                add(*center, scale(add(scale(*x, t.cos()), scale(*y, t.sin())), *radius))
            }
            Self::Ellipse { center, x, y, radii, .. } => {
                add(*center, add(scale(*x, radii[0] * t.cos()), scale(*y, radii[1] * t.sin())))
            }
            Self::Hermite { nodes } => {
                let i = nodes.partition_point(|n| n.0 <= t).clamp(1, nodes.len() - 1) - 1;
                let ((t0, p0, m0), (t1, p1, m1)) = (nodes[i], nodes[i + 1]);
                let h = t1 - t0;
                let s = (t - t0) / h;
                let (s2, s3) = (s * s, s * s * s);
                let h00 = 2.0 * s3 - 3.0 * s2 + 1.0;
                let h10 = s3 - 2.0 * s2 + s;
                let h01 = -2.0 * s3 + 3.0 * s2;
                let h11 = s3 - s2;
                add(add(scale(p0, h00), scale(m0, h10 * h)), add(scale(p1, h01), scale(m1, h11 * h)))
            }
        }
    }
}

/// A ruled surface's side: a curve, or the point its generators meet at.
enum Profile {
    Point(P3),
    Curve(Curve),
}

impl Profile {
    /// At `u` in 0..1 along the curve's range.
    fn at(&self, u: f64) -> P3 {
        match self {
            Self::Point(p) => *p,
            Self::Curve(c) => {
                let r = c.range();
                c.eval(r[0] + u * (r[1] - r[0]))
            }
        }
    }
}

enum Surface {
    Plane { origin: P3, x: P3, y: P3 },
    Cylinder { center: P3, radius: f64, x: P3, y: P3, z: P3 },
    Cone { apex: P3, half_angle: f64, x: P3, y: P3, z: P3 },
    Revolution { center: P3, x: P3, y: P3, z: P3, profile: Curve },
    Ruled { first: Profile, second: Profile },
}

impl Surface {
    fn eval(&self, [u, v]: P2) -> P3 {
        match self {
            Self::Plane { origin, x, y } => add(*origin, add(scale(*x, u), scale(*y, v))),
            Self::Cylinder { center, radius, x, y, z } => add(
                add(*center, scale(add(scale(*x, u.cos()), scale(*y, u.sin())), *radius)),
                scale(*z, v),
            ),
            Self::Cone { apex, half_angle, x, y, z } => {
                let radial = add(scale(*x, u.cos()), scale(*y, u.sin()));
                add(*apex, scale(add(scale(*z, half_angle.cos()), scale(radial, half_angle.sin())), v))
            }
            Self::Revolution { center, x, y, z, profile } => {
                let q = profile.eval(v);
                let (s, c) = u.sin_cos();
                let local = [q[0] * c - q[1] * s, q[0] * s + q[1] * c, q[2]];
                add(*center, add(add(scale(*x, local[0]), scale(*y, local[1])), scale(*z, local[2])))
            }
            Self::Ruled { first, second } => add(scale(first.at(u), 1.0 - v), scale(second.at(u), v)),
        }
    }

    /// ∂S/∂u × ∂S/∂v at `uv`, unnormalised.
    fn normal(&self, [u, v]: P2) -> P3 {
        if let Self::Plane { x, y, .. } = self {
            return cross(*x, *y);
        }
        let h = 1e-6;
        let du = sub(self.eval([u + h, v]), self.eval([u - h, v]));
        let dv = sub(self.eval([u, v + h]), self.eval([u, v - h]));
        cross(du, dv)
    }

    fn planar(&self) -> bool {
        matches!(self, Self::Plane { .. })
    }

    /// The period of u, where it turns: 2π about an axis, 1 along the closed
    /// profiles of a ruled surface.
    fn period(&self) -> Option<f64> {
        match self {
            Self::Cylinder { .. } | Self::Cone { .. } | Self::Revolution { .. } => Some(TAU),
            Self::Ruled { first, second } => {
                let closed = |p: &Profile| norm(sub(p.at(0.0), p.at(1.0))) < 1e-9;
                (closed(first) && closed(second)).then_some(1.0)
            }
            Self::Plane { .. } => None,
        }
    }
}

/// rvt-rs's pointer resolution (`native_saved_mesh`), indexed once.
struct Pointers<'a> {
    graph: &'a ObjectGraph,
    edges: HashMap<(usize, usize), Vec<usize>>,
    tokens: HashMap<u32, Vec<usize>>,
}

impl<'a> Pointers<'a> {
    fn new(graph: &'a ObjectGraph) -> Self {
        let mut edges: HashMap<_, Vec<_>> = HashMap::new();
        let mut tokens: HashMap<_, Vec<_>> = HashMap::new();
        for (i, e) in graph.edges.iter().enumerate() {
            edges.entry((e.source_object_index, e.pointer_offset)).or_default().push(i);
        }
        for (i, o) in graph.objects.iter().enumerate() {
            tokens.entry(o.token).or_default().push(i);
        }
        Self { graph, edges, tokens }
    }

    fn resolve(&self, source: usize, pointer: &Value) -> Result<Option<usize>, String> {
        let token = pointer["pointer_token"].as_u64().ok_or("missing pointer token")?;
        if token == 0 {
            return Ok(None);
        }
        let offset = pointer["offset"].as_u64().ok_or("missing pointer offset")? as usize;
        match self.edges.get(&(source, offset)).map(Vec::as_slice).unwrap_or(&[]) {
            [edge] => {
                let e = &self.graph.edges[*edge];
                let target = self.graph.objects.get(e.target_object_index).ok_or("pointer target out of bounds")?;
                if u64::from(e.pointer_token) != token
                    || target.class_tag != e.target_class_tag
                    || pointer["class_tag"].as_u64().is_some_and(|tag| tag != u64::from(target.class_tag))
                {
                    return Err("pointer metadata mismatch".into());
                }
                Ok(Some(e.target_object_index))
            }
            [] if token != u64::from(u32::MAX) => {
                match u32::try_from(token).ok().and_then(|t| self.tokens.get(&t)).map(Vec::as_slice) {
                    Some([object]) => Ok(Some(*object)),
                    _ => Err("unresolved pointer token".into()),
                }
            }
            [] => Err("unresolved anonymous pointer".into()),
            _ => Err("ambiguous pointer".into()),
        }
    }
}

/// A saved ElementId: a number, or one under `m_id` / `m_id64`.
pub fn identifier(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    ["m_id", "m_id64"].iter().find_map(|key| value.get(key)).and_then(identifier)
}

fn number(value: &Value) -> Result<f64, String> {
    value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| "number".into())
}

fn point2(value: &Value) -> Result<P2, String> {
    match value.as_array().map(Vec::as_slice) {
        Some([a, b]) => Ok([number(a)?, number(b)?]),
        _ => Err("point2".into()),
    }
}

fn point3(value: &Value) -> Result<P3, String> {
    match value.as_array().map(Vec::as_slice) {
        Some([a, b, c]) => Ok([number(a)?, number(b)?, number(c)?]),
        _ => Err("point3".into()),
    }
}

fn edge_key(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}

fn cross2(a: P2, b: P2, c: P2) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn area(ring: &[P2]) -> f64 {
    (0..ring.len())
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        / 2.0
}

fn inside(p: P2, ring: &[P2]) -> bool {
    let mut hit = false;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            hit = !hit;
        }
    }
    hit
}

fn lerp2(a: P2, b: P2, t: f64) -> P2 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn mid3(a: P3, b: P3) -> P3 {
    scale(add(a, b), 0.5)
}

fn add(a: P3, b: P3) -> P3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: P3, s: f64) -> P3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm(a: P3) -> f64 {
    dot(a, a).sqrt()
}
