//! WebAssembly bindings of rvt-rs for rvt-viewer.
//!
//! The viewer opens one document per worker ([`open_document`]) and keeps
//! it here: the file's bytes and the decoded model stay in wasm memory, and
//! every later call works on them. Only what the page needs crosses into
//! JavaScript: the model without its bodies, which the GLB carries
//! ([`page_model`]). A model with millions of saved-mesh triangles would
//! otherwise be a JavaScript object of gigabytes, copied in and out of wasm
//! on every call.
//!
//! The functions are those of `rvt-rs/rvt-wasm` the viewer used, plus the
//! saved display meshes rvt-wasm does not bind ([`saved_meshes`]).
//!
//! No network APIs: CI checks the compiled module's imports.

use rvt::RevitFile;
use rvt::ifc::{
    ExportQualityMode, IfcModel, RvtDocExporter,
    entities::{IfcEntity, SolidShape},
    gltf::model_to_glb,
    saved_meshes::SavedMeshReport,
    scene_graph::{SceneNode, Schedule, build_scene_graph, build_schedule, distinct_ifc_types},
    sheet::{SheetOptions, render_plan_svg},
    step_writer::write_step,
};
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod brep;
pub mod saved_meshes;

fn err_str<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// Route Rust panics to `console.error` instead of a bare
/// `RuntimeError: unreachable`.
fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            console_error(&format!("rvt-rs wasm panic: {info}"));
        }));
    });
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(err_str)
}

fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(err_str)
}

/// `{ key: value, … }` as a JavaScript object.
fn object(entries: &[(&str, &JsValue)]) -> Result<JsValue, JsValue> {
    let out = js_sys::Object::new();
    for (key, value) in entries {
        js_sys::Reflect::set(&out, &JsValue::from_str(key), value)?;
    }
    Ok(out.into())
}

/// The open document: the file's bytes (the saved-mesh pass reads them
/// again) and its model.
struct Document {
    bytes: Vec<u8>,
    model: IfcModel,
}

thread_local! {
    static DOCUMENT: RefCell<Option<Document>> = const { RefCell::new(None) };
}

fn with_document<T>(f: impl FnOnce(&mut Document) -> Result<T, JsValue>) -> Result<T, JsValue> {
    DOCUMENT.with(|cell| match cell.borrow_mut().as_mut() {
        Some(document) => f(document),
        None => Err(JsValue::from_str("no open document")),
    })
}

/// `model` for the page: each body only as present (an empty face set) and
/// no representation maps, so that it stays small. Restores `model` after.
fn page_model(model: &mut IfcModel) -> Result<JsValue, JsValue> {
    let mut bodies = Vec::new();
    for (index, entity) in model.entities.iter_mut().enumerate() {
        if let IfcEntity::BuildingElement { solid_shape, .. } = entity {
            if let Some(shape) = solid_shape.take() {
                bodies.push((index, shape));
                *solid_shape = Some(SolidShape::TriangulatedFaceSet {
                    vertices_feet: Vec::new(),
                    triangles: Vec::new(),
                });
            }
        }
    }
    let maps = std::mem::take(&mut model.representation_maps);
    let page = to_js(&*model);
    model.representation_maps = maps;
    for (index, shape) in bodies {
        if let IfcEntity::BuildingElement { solid_shape, .. } = &mut model.entities[index] {
            *solid_shape = Some(shape);
        }
    }
    page
}

/// Open a Revit file as the document, closing any other, and return
/// `{ model, diagnostics }` with the page's [`page_model`]. `mode` is one
/// of `scaffold`, `typed-no-geometry`, `geometry` or `strict`.
#[wasm_bindgen(js_name = openDocument)]
pub fn open_document(bytes: Vec<u8>, mode: &str) -> Result<JsValue, JsValue> {
    install_panic_hook();
    close_document();
    let quality_mode = ExportQualityMode::parse(mode).map_err(err_str)?;
    let mut rf = RevitFile::open_bytes(bytes.clone()).map_err(err_str)?;
    let result = RvtDocExporter
        .export_with_diagnostics_mode_and_limits(
            &mut rf,
            quality_mode,
            rvt::walker::WalkerLimits::default(),
        )
        .map_err(err_str)?;
    drop(rf);
    let mut model = result.model;
    let out = object(&[
        ("model", &page_model(&mut model)?),
        ("diagnostics", &to_js(&result.diagnostics)?),
    ])?;
    DOCUMENT.with(|cell| *cell.borrow_mut() = Some(Document { bytes, model }));
    Ok(out)
}

/// Close the document and free its memory for the next one (wasm memory
/// itself never shrinks).
#[wasm_bindgen(js_name = closeDocument)]
pub fn close_document() {
    DOCUMENT.with(|cell| cell.borrow_mut().take());
}

/// `{ scene, types }`: the scene graph and its distinct IFC types.
#[wasm_bindgen(js_name = documentScene)]
pub fn document_scene() -> Result<JsValue, JsValue> {
    install_panic_hook();
    with_document(|document| {
        let scene: SceneNode = build_scene_graph(&document.model);
        let types = distinct_ifc_types(&scene);
        object(&[("scene", &to_js(&scene)?), ("types", &to_js(&types)?)])
    })
}

#[wasm_bindgen(js_name = documentSchedule)]
pub fn document_schedule() -> Result<JsValue, JsValue> {
    install_panic_hook();
    with_document(|document| {
        let schedule: Schedule = build_schedule(&document.model);
        to_js(&schedule)
    })
}

/// glTF 2.0 binary, one node per element (`extras.entityIndex`).
#[wasm_bindgen(js_name = documentGlb)]
pub fn document_glb() -> Result<Vec<u8>, JsValue> {
    install_panic_hook();
    with_document(|document| Ok(model_to_glb(&document.model)))
}

/// IFC4 STEP text.
#[wasm_bindgen(js_name = documentIfcStep)]
pub fn document_ifc_step() -> Result<String, JsValue> {
    install_panic_hook();
    with_document(|document| Ok(write_step(&document.model)))
}

/// Whole-model plan as SVG; `options` null for the defaults.
#[wasm_bindgen(js_name = documentPlanSvg)]
pub fn document_plan_svg(options: JsValue) -> Result<String, JsValue> {
    install_panic_hook();
    let options: SheetOptions = if options.is_null() || options.is_undefined() {
        SheetOptions::default()
    } else {
        from_js(options)?
    };
    with_document(|document| Ok(render_plan_svg(&document.model, &options)))
}

/// Element (`"elements"`) or room (`"rooms"`) schedule as CSV.
#[wasm_bindgen(js_name = documentScheduleCsv)]
pub fn document_schedule_csv(kind: &str, metric: bool, excel: bool) -> Result<String, JsValue> {
    install_panic_hook();
    use rvt::ifc::schedule_csv::{CsvOptions, LengthUnit, elements_csv, rooms_csv};
    let options = CsvOptions {
        unit: if metric { LengthUnit::Metres } else { LengthUnit::Feet },
        excel_bom: excel,
    };
    with_document(|document| match kind {
        "elements" => Ok(elements_csv(&document.model, &options)),
        "rooms" => Ok(rooms_csv(&document.model, &options)),
        other => Err(JsValue::from_str(&format!(
            "unknown schedule kind {other:?}; expected \"elements\" or \"rooms\""
        ))),
    })
}

#[derive(Serialize)]
struct EntityMaterials {
    entity: usize,
    runs: Vec<saved_meshes::MaterialRun>,
}

/// Replace the document's box bodies with the meshes Revit saved for
/// display ([`saved_meshes::attach`]), calling `progress(stage, done,
/// total)` as it goes. Returns `{ model, report: { candidates, replaced,
/// triangles }, materials }`: `model` the new [`page_model`], null when
/// nothing was replaced (entity indices are unchanged); `materials` lists
/// `{ entity, runs: [{ triangles, color, opacity }] }` for the bodies with
/// a transparent face, their triangles in runs of one material in the order
/// of their face set.
#[wasm_bindgen(js_name = documentAttachSavedMeshes)]
pub fn document_attach_saved_meshes(progress: &js_sys::Function) -> Result<JsValue, JsValue> {
    install_panic_hook();
    with_document(|document| {
        let mut rf = RevitFile::open_bytes(document.bytes.clone()).map_err(err_str)?;
        let mut report_progress = |stage: &'static str, done: usize, total: usize| {
            let _ = progress.call3(
                &JsValue::NULL,
                &JsValue::from_str(stage),
                &JsValue::from(done as u32),
                &JsValue::from(total as u32),
            );
        };
        let attached = saved_meshes::attach(
            &mut rf,
            &mut document.model,
            saved_meshes::CHUNK,
            &mut report_progress,
        )
        .map_err(err_str)?;
        drop(rf);
        let report: SavedMeshReport = attached.report;
        let model = if report.replaced > 0 {
            page_model(&mut document.model)?
        } else {
            JsValue::NULL
        };
        let materials: Vec<EntityMaterials> = attached
            .materials
            .into_iter()
            .map(|(entity, runs)| EntityMaterials { entity, runs })
            .collect();
        object(&[
            ("model", &model),
            ("report", &to_js(&report)?),
            ("materials", &to_js(&materials)?),
        ])
    })
}

/// Cheap metadata (BasicFileInfo, PartAtom, stream inventory).
#[wasm_bindgen(js_name = quickSummary)]
pub fn quick_summary(bytes: &[u8]) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let mut rf = RevitFile::open_bytes(bytes.to_vec()).map_err(err_str)?;
    let summary = rf.summarize_lossy().map_err(err_str)?.value;
    to_js(&summary)
}

/// Document identity: release, worksharing, last saved, GUID, ….
#[wasm_bindgen(js_name = fileMetadata)]
pub fn file_metadata(bytes: &[u8]) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let metadata =
        rvt::metadata::read_metadata_from(std::io::Cursor::new(bytes)).map_err(err_str)?;
    to_js(&metadata)
}
