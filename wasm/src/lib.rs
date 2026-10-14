//! WebAssembly bindings of rvt-rs for rvt-viewer.
//!
//! The functions the viewer calls are the ones of `vendor/rvt-rs/rvt-wasm`
//! (same names, same JS values in and out), copied here so one module can
//! also expose [`attach_saved_meshes`]: rvt-rs can draw doors, windows and
//! other loadable families from the meshes Revit saved for display
//! (`rvt-gltf --saved-meshes`), but rvt-wasm does not bind it. [`saved_meshes`]
//! extends it to the boxes it leaves.
//!
//! No network APIs: CI checks the compiled module's imports.

use rvt::RevitFile;
use rvt::ifc::{
    ExportQualityMode, IfcModel, RvtDocExporter,
    gltf::model_to_glb,
    saved_meshes::SavedMeshReport,
    scene_graph::{SceneNode, Schedule, build_scene_graph, build_schedule, distinct_ifc_types},
    sheet::{SheetOptions, render_plan_svg},
    step_writer::write_step,
};
use serde::Serialize;
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

/// Open a Revit file and return `{ model, diagnostics }`. `mode` is one of
/// `scaffold`, `typed-no-geometry`, `geometry` or `strict`.
#[wasm_bindgen(js_name = openRvtBytesWithDiagnosticsMode)]
pub fn open_rvt_bytes_with_diagnostics_mode(bytes: &[u8], mode: &str) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let quality_mode = ExportQualityMode::parse(mode).map_err(err_str)?;
    let mut rf = RevitFile::open_bytes(bytes.to_vec()).map_err(err_str)?;
    let result = RvtDocExporter
        .export_with_diagnostics_mode_and_limits(
            &mut rf,
            quality_mode,
            rvt::walker::WalkerLimits::default(),
        )
        .map_err(err_str)?;
    to_js(&result)
}

#[derive(Serialize)]
struct SavedMeshes {
    /// `None` when no body was replaced.
    model: Option<IfcModel>,
    report: SavedMeshReport,
    /// The replaced bodies with a transparent face, in runs of one material.
    materials: Vec<EntityMaterials>,
}

#[derive(Serialize)]
struct EntityMaterials {
    entity: usize,
    runs: Vec<saved_meshes::MaterialRun>,
}

/// Replace the box bodies of `model` (from `openRvtBytesWithDiagnosticsMode`
/// on the same `bytes`) with the meshes Revit saved for display, where the
/// file holds them ([`saved_meshes::attach`]). Returns
/// `{ model, report: { candidates, replaced, triangles }, materials }`,
/// `model` null when nothing was replaced; entity indices are unchanged.
/// `materials` lists `{ entity, runs: [{ triangles, color, opacity }] }`: the
/// body's triangles in runs of one material, in the order of its face set.
#[wasm_bindgen(js_name = attachSavedMeshes)]
pub fn attach_saved_meshes(bytes: &[u8], model: JsValue) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let mut model: IfcModel = from_js(model)?;
    let mut rf = RevitFile::open_bytes(bytes.to_vec()).map_err(err_str)?;
    let attached = saved_meshes::attach(&mut rf, &mut model).map_err(err_str)?;
    let report = attached.report;
    let model = (report.replaced > 0).then_some(model);
    let materials = attached
        .materials
        .into_iter()
        .map(|(entity, runs)| EntityMaterials { entity, runs })
        .collect();
    to_js(&SavedMeshes {
        model,
        report,
        materials,
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

/// Element (`"elements"`) or room (`"rooms"`) schedule as CSV.
#[wasm_bindgen(js_name = scheduleCsv)]
pub fn schedule_csv(model: JsValue, kind: &str, metric: bool, excel: bool) -> Result<String, JsValue> {
    install_panic_hook();
    use rvt::ifc::schedule_csv::{CsvOptions, LengthUnit, elements_csv, rooms_csv};
    let model: IfcModel = from_js(model)?;
    let options = CsvOptions {
        unit: if metric { LengthUnit::Metres } else { LengthUnit::Feet },
        excel_bom: excel,
    };
    match kind {
        "elements" => Ok(elements_csv(&model, &options)),
        "rooms" => Ok(rooms_csv(&model, &options)),
        other => Err(JsValue::from_str(&format!(
            "unknown schedule kind {other:?}; expected \"elements\" or \"rooms\""
        ))),
    }
}

#[wasm_bindgen(js_name = buildSceneGraph)]
pub fn scene_graph(model: JsValue) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let model: IfcModel = from_js(model)?;
    let scene: SceneNode = build_scene_graph(&model);
    to_js(&scene)
}

#[wasm_bindgen(js_name = distinctIfcTypes)]
pub fn ifc_types(scene: JsValue) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let scene: SceneNode = from_js(scene)?;
    to_js(&distinct_ifc_types(&scene))
}

#[wasm_bindgen(js_name = buildSchedule)]
pub fn schedule(model: JsValue) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let model: IfcModel = from_js(model)?;
    let schedule: Schedule = build_schedule(&model);
    to_js(&schedule)
}

/// glTF 2.0 binary, one node per element (`extras.entityIndex`).
#[wasm_bindgen(js_name = modelToGlb)]
pub fn glb(model: JsValue) -> Result<Vec<u8>, JsValue> {
    install_panic_hook();
    let model: IfcModel = from_js(model)?;
    Ok(model_to_glb(&model))
}

/// IFC4 STEP text.
#[wasm_bindgen(js_name = modelToIfcStep)]
pub fn ifc_step(model: JsValue) -> Result<String, JsValue> {
    install_panic_hook();
    let model: IfcModel = from_js(model)?;
    Ok(write_step(&model))
}

/// Whole-model plan as SVG; `options` null for the defaults.
#[wasm_bindgen(js_name = renderPlanSvg)]
pub fn plan_svg(model: JsValue, options: JsValue) -> Result<String, JsValue> {
    install_panic_hook();
    let model: IfcModel = from_js(model)?;
    let options: SheetOptions = if options.is_null() || options.is_undefined() {
        SheetOptions::default()
    } else {
        from_js(options)?
    };
    Ok(render_plan_svg(&model, &options))
}
