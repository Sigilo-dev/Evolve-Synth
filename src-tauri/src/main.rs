use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::{create_dir_all, OpenOptions}, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

// The engine is a background sidecar. Suppress Windows' console window while
// retaining its stdin/stdout pipes for the JSONL protocol.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EngineStatus { state: String, message: String, #[serde(default)] details: Option<serde_json::Value> }

#[derive(Deserialize)]
#[serde(tag = "type")]
enum EngineMessage {
    #[serde(rename = "status")]
    Status { state: String, message: String, #[serde(default)] details: Option<serde_json::Value> },
    #[serde(rename = "response")]
    Response { id: String, ok: bool, result: Option<EngineStatus>, error: Option<String> },
}

struct EngineRuntime { node_path: PathBuf, entrypoint: PathBuf, working_dir: PathBuf, source: &'static str }
struct EngineManager { child: Mutex<Option<Child>>, stdin: Mutex<Option<ChildStdin>>, pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<EngineStatus, String>>>>>, shortcut_toggle_in_flight: AtomicBool }

fn write_engine_log(data_dir: &Path, message: &str) {
    let directory = data_dir.join("Diagnostics");
    if create_dir_all(&directory).is_ok() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(directory.join("engine.log")) { let _ = writeln!(file, "{message}"); }
    }
}

fn diagnostic_data_dir(app: &AppHandle) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("EvolveSynth"))
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(|| PathBuf::from("EvolveSynth"))
}

fn inspect_runtime_candidate(data_dir: &Path, source: &'static str, engine_dir: PathBuf) -> Result<EngineRuntime, String> {
    let node_path = engine_dir.join("node.exe");
    let entrypoint = engine_dir.join("dist").join("index.js");
    let node_exists = node_path.exists();
    let entrypoint_exists = entrypoint.exists();
    write_engine_log(data_dir, &format!("ENGINE_RUNTIME_CANDIDATE source={source} path={} node={} entrypoint={} NodeExists={node_exists} EntryPointExists={entrypoint_exists}", engine_dir.display(), node_path.display(), entrypoint.display()));
    if node_exists && entrypoint_exists { Ok(EngineRuntime { node_path, entrypoint, working_dir: engine_dir, source }) }
    else if !node_exists { Err(format!("AUTOMATION_ENGINE_NODE_NOT_FOUND: {}", node_path.display())) }
    else { Err(format!("AUTOMATION_ENGINE_ENTRYPOINT_NOT_FOUND: {}", entrypoint.display())) }
}

fn resolve_engine_runtime(app: &AppHandle, data_dir: &Path) -> Result<EngineRuntime, String> {
    let current_exe = std::env::current_exe().map_err(|e| format!("AUTOMATION_ENGINE_RESOLUTION_FAILED: {e}"))?;
    let exe_directory = current_exe.parent().ok_or("AUTOMATION_ENGINE_RESOLUTION_FAILED: executable parent is unavailable")?.to_path_buf();
    let portable = exe_directory.join("resources").join("engine");
    write_engine_log(data_dir, &format!("ENGINE_RESOLUTION CurrentExe={} ExeDirectory={} ExpectedEngineDirectory={} ExpectedNode={} ExpectedEntryPoint={}", current_exe.display(), exe_directory.display(), portable.display(), portable.join("node.exe").display(), portable.join("dist").join("index.js").display()));
    let portable_error = match inspect_runtime_candidate(data_dir, "RELEASE_PORTABLE", portable) {
        Ok(runtime) => { write_engine_log(data_dir, &format!("ENGINE_RUNTIME_FOUND source={} path={}", runtime.source, runtime.working_dir.display())); return Ok(runtime); }
        Err(error) => error,
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Ok(runtime) = inspect_runtime_candidate(data_dir, "TAURI_RESOURCE_DIR", resource_dir.join("engine")) {
            write_engine_log(data_dir, &format!("ENGINE_RUNTIME_FOUND source={} path={}", runtime.source, runtime.working_dir.display()));
            return Ok(runtime);
        }
    }
    if cfg!(debug_assertions) {
        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().ok_or("AUTOMATION_ENGINE_RESOLUTION_FAILED: project directory unavailable")?.to_path_buf();
        let entrypoint = project_dir.join("engine").join("dist").join("index.js");
        write_engine_log(data_dir, &format!("ENGINE_RUNTIME_CANDIDATE source=DEVELOPMENT path={} entrypoint={} EntryPointExists={}", project_dir.display(), entrypoint.display(), entrypoint.exists()));
        if entrypoint.exists() {
            write_engine_log(data_dir, &format!("ENGINE_RUNTIME_FOUND source=DEVELOPMENT path={}", project_dir.display()));
            return Ok(EngineRuntime { node_path: PathBuf::from("node"), entrypoint, working_dir: project_dir, source: "DEVELOPMENT" });
        }
    }
    write_engine_log(data_dir, &format!("ENGINE_RUNTIME_NOT_FOUND reason={portable_error}"));
    Err(portable_error)
}

impl EngineManager {
    fn new() -> Self { Self { child: Mutex::new(None), stdin: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())), shortcut_toggle_in_flight: AtomicBool::new(false) } }
    fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut child = self.child.lock().unwrap();
            if let Some(process) = child.as_mut() {
                if process.try_wait().ok().flatten().is_none() { return Ok(()); }
                write_engine_log(&diagnostic_data_dir(app), "ENGINE_RESTARTING: previous engine process had exited");
                child.take();
                self.stdin.lock().unwrap().take();
            }
        }
        let data_dir = diagnostic_data_dir(app);
        create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let runtime = resolve_engine_runtime(app, &data_dir)?;
        let mut command = Command::new(&runtime.node_path);
        command.arg(&runtime.entrypoint).current_dir(&runtime.working_dir).env("EVOLVE_SYNTH_DATA_DIR", &data_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|e| {
            write_engine_log(&data_dir, &format!("ENGINE_START_FAILED source={} node={} entrypoint={} error={e}", runtime.source, runtime.node_path.display(), runtime.entrypoint.display()));
            format!("AUTOMATION_ENGINE_START_FAILED: {e}")
        })?;
        write_engine_log(&data_dir, &format!("ENGINE_STARTED source={} node={} entrypoint={} working_dir={}", runtime.source, runtime.node_path.display(), runtime.entrypoint.display(), runtime.working_dir.display()));
        let stdin = child.stdin.take().ok_or("AUTOMATION_ENGINE_START_FAILED: engine stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("AUTOMATION_ENGINE_START_FAILED: engine stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("AUTOMATION_ENGINE_START_FAILED: engine stderr unavailable")?;
        let stderr_log_dir = data_dir.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                write_engine_log(&stderr_log_dir, &format!("ENGINE_STDERR: {line}"));
            }
        });
        let handle = app.clone(); let pending = self.pending.clone(); let log_dir = data_dir.clone();
        std::thread::spawn(move || {
            let mut protocol_error = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match serde_json::from_str::<EngineMessage>(&line) {
                    Ok(EngineMessage::Status { state, message, details }) => { let _ = handle.emit("engine-status", EngineStatus { state, message, details }); }
                    Ok(EngineMessage::Response { id, ok, result, error }) => if let Some(tx) = pending.lock().unwrap().remove(&id) { let _ = tx.send(if ok { result.ok_or("AUTOMATION_ENGINE_PROTOCOL_ERROR: empty engine response".into()) } else { Err(error.unwrap_or("AUTOMATION_ENGINE_PROTOCOL_ERROR: engine error".into())) }); },
                    Err(_) => { protocol_error = true; write_engine_log(&log_dir, "ENGINE_PROTOCOL_ERROR: invalid JSONL message from engine"); }
                }
            }
            if !protocol_error { write_engine_log(&log_dir, "ENGINE_EXITED: engine stdout closed"); }
        });
        *self.stdin.lock().unwrap() = Some(stdin); *self.child.lock().unwrap() = Some(child); Ok(())
    }
    fn request(&self, app: &AppHandle, action: &str, url: Option<String>, payload: Option<serde_json::Value>) -> Result<EngineStatus, String> {
        self.ensure_started(app)?;
        let id = format!("{}-{}", action, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros());
        let (tx, rx) = mpsc::channel(); self.pending.lock().unwrap().insert(id.clone(), tx);
        let command = serde_json::json!({ "id": id, "action": action, "url": url, "payload": payload });
        let write_result = {
            let mut input = self.stdin.lock().unwrap();
            let stdin = input.as_mut().ok_or("AUTOMATION_ENGINE_EXITED: engine is unavailable")?;
            writeln!(stdin, "{command}").and_then(|_| stdin.flush())
        };
        if let Err(error) = write_result {
            self.pending.lock().unwrap().remove(&id);
            self.stdin.lock().unwrap().take();
            if let Some(mut child) = self.child.lock().unwrap().take() { let _ = child.kill(); let _ = child.wait(); }
            return Err(format!("AUTOMATION_ENGINE_EXITED: {error}"));
        }
        rx.recv_timeout(Duration::from_secs(30)).map_err(|_| String::from("AUTOMATION_ENGINE_PROTOCOL_ERROR: engine did not respond within 30 seconds"))?
    }
    fn shutdown(&self) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() { let _ = writeln!(stdin, "{}", r#"{"id":"shutdown","action":"shutdown"}"#); let _ = stdin.flush(); }
        self.stdin.lock().unwrap().take(); if let Some(mut child) = self.child.lock().unwrap().take() { let _ = child.wait(); }
    }
}

#[tauri::command] fn open_platform(app: AppHandle, engine: State<EngineManager>, url: String, browser_preference: Option<String>) -> Result<EngineStatus, String> { let preference = if browser_preference.as_deref() == Some("Edge, then Chrome") { "edge-first" } else { "chrome-first" }; let status = engine.request(&app, "openPlatform", Some(url), Some(serde_json::json!({ "browserPreference": preference })))?; if let Some(controller) = app.get_webview_window("controller") { let _ = controller.show(); let _ = controller.set_focus(); } Ok(status) }
#[tauri::command] fn find_compatible_activity(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "findCompatibleActivity", None, None) }
#[tauri::command] fn analyze_current_screen(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "analyzeCurrentScreen", None, None) }
#[tauri::command] fn answer_current_screen(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "answerCurrentScreen", None, None) }
#[tauri::command] fn run_activity(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "runActivity", None, None) }
#[tauri::command] fn get_run_status(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "getRunStatus", None, None) }
#[tauri::command] fn toggle_observation(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "toggleObservation", None, None) }
#[tauri::command] fn stop_activity(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "stopActivity", None, None) }
#[tauri::command] fn export_run(app: AppHandle, engine: State<EngineManager>, run_id: i64) -> Result<EngineStatus, String> { engine.request(&app, "exportRun", None, Some(serde_json::json!({ "runId": run_id }))) }
#[tauri::command] fn list_runs(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "listRuns", None, None) }
#[tauri::command] fn get_run(app: AppHandle, engine: State<EngineManager>, run_id: i64) -> Result<EngineStatus, String> { engine.request(&app, "getRun", None, Some(serde_json::json!({ "runId": run_id }))) }
#[tauri::command] fn clear_history(app: AppHandle, engine: State<EngineManager>) -> Result<EngineStatus, String> { engine.request(&app, "clearRuns", None, None) }
#[tauri::command] fn show_controller(app: AppHandle) -> Result<(), String> { let controller = app.get_webview_window("controller").ok_or("Controller window is unavailable")?; controller.show().map_err(|e| e.to_string())?; controller.set_focus().map_err(|e| e.to_string()) }
#[tauri::command] fn close_app(app: AppHandle, engine: State<EngineManager>) { engine.shutdown(); app.exit(0); }

fn main() {
    let observe_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO);
    let handler_shortcut = observe_shortcut.clone();
    tauri::Builder::default()
        .manage(EngineManager::new())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(move |app, shortcut, event| {
            if shortcut == &handler_shortcut && event.state() == ShortcutState::Pressed {
                let data_dir = diagnostic_data_dir(app);
                let engine = app.state::<EngineManager>();
                if engine.shortcut_toggle_in_flight.swap(true, Ordering::AcqRel) {
                    write_engine_log(&data_dir, "SHORTCUT_IGNORED accelerator=Ctrl+Shift+O reason=REQUEST_IN_FLIGHT");
                    return;
                }
                write_engine_log(&data_dir, "SHORTCUT_PRESSED accelerator=Ctrl+Shift+O");
                if let Some(controller) = app.get_webview_window("controller") { let _ = controller.show(); }
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    let data_dir = diagnostic_data_dir(&app_handle);
                    let engine = app_handle.state::<EngineManager>();
                    match engine.request(&app_handle, "toggleObservation", None, None) {
                        Ok(status) => {
                            write_engine_log(&data_dir, &format!("SHORTCUT_TOGGLE_OK accelerator=Ctrl+Shift+O state={}", status.state));
                            let _ = app_handle.emit("engine-status", status);
                        }
                        Err(error) => {
                            write_engine_log(&data_dir, &format!("SHORTCUT_TOGGLE_FAILED accelerator=Ctrl+Shift+O error={error}"));
                            let _ = app_handle.emit("engine-status", EngineStatus { state: "ERROR".into(), message: format!("SHORTCUT_RECORDING_FAILED: {error}"), details: None });
                        }
                    }
                    engine.shortcut_toggle_in_flight.store(false, Ordering::Release);
                });
            }
        }).build())
        .setup(move |app| {
            app.global_shortcut().register(observe_shortcut)?;
            write_engine_log(&diagnostic_data_dir(&app.handle()), "SHORTCUT_REGISTERED accelerator=Ctrl+Shift+O");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_platform, find_compatible_activity, analyze_current_screen, answer_current_screen, run_activity, get_run_status, toggle_observation, stop_activity, export_run, list_runs, get_run, clear_history, show_controller, close_app])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" || window.label() == "controller" {
                    window.app_handle().state::<EngineManager>().shutdown();
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Evolve Synth");
}
