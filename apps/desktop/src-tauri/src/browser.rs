//! Supervises Aira's browsing agent.
//!
//! Third subprocess, same bargain as the other two: Aira picks the port, mints
//! the token, binds to loopback, drains stderr, and kills the child on exit.
//!
//! What differs is what is being supervised. This one drives a real Chrome and
//! reads whatever a page happens to say, which makes it the most dangerous
//! surface in the product and the one where the defaults matter most:
//!
//!   * Its own Chrome profile, never the user's. browser-use can reuse the
//!     signed-in profile, which would put an agent that follows instructions
//!     found on web pages inside the user's mail and bank sessions.
//!   * A step cap, because a browsing loop that will not stop is a bill as well
//!     as a hang.
//!   * The model is reached through Aira's gateway, so a browse is metered and
//!     attributable like every other surface.

use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct BrowserState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
    token: String,
    /// Recent stderr, for saying why a start failed.
    log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    /// Sent to the webview so it can authenticate; it never leaves this machine.
    pub token: Option<String>,
    /// Path to the service's Python, or None when it has not been installed.
    pub python: Option<String>,
}

/// The interpreter from Aira's own virtualenv.
///
/// Deliberately not the system Python: browser-use pulls a large dependency
/// tree, and installing that into a user's Python is a change to their machine
/// that Aira has no business making.
fn find_python() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.aira/browser/venv/bin/python");
    std::path::Path::new(&path).exists().then_some(path)
}

/// The service script, which ships inside the app bundle.
fn find_script() -> Option<String> {
    // Packaged: alongside the binary in Resources. Development: the repo.
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("../Resources/browser/server.py"))),
        Some(std::path::PathBuf::from("services/browser/server.py")),
        std::env::var("HOME")
            .ok()
            .map(|h| std::path::PathBuf::from(h).join(".aira/browser/server.py")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.to_string_lossy().to_string())
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("could not read the reserved port: {e}"))
}

/// Keeps the tail of the child's stderr, and keeps reading it — an undrained
/// pipe fills at about 64KB and blocks the child mid-startup.
fn drain(stderr: Option<std::process::ChildStderr>, log: Arc<Mutex<VecDeque<String>>>) {
    let Some(stderr) = stderr else { return };
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut guard = log.lock().unwrap();
            if guard.len() >= 60 {
                guard.pop_front();
            }
            guard.push_back(line);
        }
    });
}

impl BrowserState {
    fn reap(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(running) = guard.as_mut() {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
    }

    /// Called when the app exits, so a headless Chrome is never orphaned.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.inner.lock().unwrap().take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

#[tauri::command]
pub fn browser_status(state: State<'_, BrowserState>) -> Status {
    state.reap();
    let guard = state.inner.lock().unwrap();
    match guard.as_ref() {
        Some(running) => Status {
            running: true,
            port: Some(running.port),
            token: Some(running.token.clone()),
            python: find_python(),
        },
        None => Status {
            running: false,
            port: None,
            token: None,
            python: find_python(),
        },
    }
}

#[tauri::command]
pub fn browser_start(
    state: State<'_, BrowserState>,
    gateway_url: String,
    token: String,
    model: String,
) -> Result<Status, String> {
    state.reap();
    {
        let guard = state.inner.lock().unwrap();
        if guard.is_some() {
            drop(guard);
            return Ok(browser_status(state));
        }
    }

    let python = find_python().ok_or_else(|| {
        "The browsing agent is not installed. Aira keeps it in its own virtualenv at \
         ~/.aira/browser/venv."
            .to_string()
    })?;
    let script = find_script().ok_or_else(|| "Could not find the browsing service.".to_string())?;

    let port = free_port()?;
    let service_token = uuid::Uuid::new_v4().to_string();

    let mut command = Command::new(&python);
    command
        .arg(&script)
        .env("AIRA_BROWSER_PORT", port.to_string())
        .env("AIRA_BROWSER_TOKEN", &service_token)
        .env("AIRA_GATEWAY_URL", &gateway_url)
        .env("AIRA_BROWSER_MODEL", &model)
        // The session token, for the gateway. Passed in the environment so it
        // is never written to disk.
        .env("AIRA_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    if let Ok(home) = std::env::var("HOME") {
        command.current_dir(home);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("could not start the browsing agent: {e}"))?;

    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let mut child = child;
    drain(child.stderr.take(), Arc::clone(&log));

    *state.inner.lock().unwrap() = Some(Running {
        child,
        port,
        token: service_token.clone(),
        log,
    });

    Ok(Status {
        running: true,
        port: Some(port),
        token: Some(service_token),
        python: Some(python),
    })
}

#[tauri::command]
pub fn browser_stop(state: State<'_, BrowserState>) -> Result<(), String> {
    if let Some(mut running) = state.inner.lock().unwrap().take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_log(state: State<'_, BrowserState>) -> Vec<String> {
    let guard = state.inner.lock().unwrap();
    guard
        .as_ref()
        .map(|r| r.log.lock().unwrap().iter().cloned().collect())
        .unwrap_or_default()
}

/// Runs a browsing task, streaming progress back as Tauri events.
///
/// Same reason as the task agent: the webview cannot read this stream itself,
/// so the shell reads it and re-emits each step on a channel keyed by run id.
#[tauri::command]
pub async fn browser_run(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    task: String,
    max_steps: u32,
    run: String,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/run"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "task": task, "maxSteps": max_steps }))
        .send()
        .await
        .map_err(|e| format!("could not reach the browsing agent: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("the stream broke: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        // Only whole frames: a chunk boundary can fall anywhere in one.
        while let Some(cut) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..cut + 2).collect();
            let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data: ")) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let _ = app.emit(&format!("browser://event/{run}"), parsed);
        }
    }
    Ok(())
}
