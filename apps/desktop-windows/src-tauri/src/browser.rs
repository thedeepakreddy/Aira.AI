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
    if let Ok(path) = std::env::var("AIRA_BROWSER_PYTHON") {
        if std::path::Path::new(&path).is_file() {
            return Some(path);
        }
    }
    // On Windows, the virtualenv puts python.exe in Scripts/ not bin/.
    let aira_dir = crate::runtime::aira_dir().ok()?;
    let path = aira_dir.join("browser").join("venv").join("Scripts").join("python.exe");
    if path.exists() {
        return Some(path.to_string_lossy().to_string());
    }
    // Also check the Unix-style path in case the venv was created with WSL.
    let path_unix = aira_dir.join("browser").join("venv").join("bin").join("python");
    path_unix.exists().then(|| path_unix.to_string_lossy().to_string())
}

/// The service script, which ships inside the app bundle.
fn find_script() -> Option<String> {
    // Packaged: alongside the binary in Resources. Development: the repo.
    let mut candidates = vec![std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|d| d.join("browser/server.py"))
    })];
    if cfg!(debug_assertions) {
        candidates.push(Some(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../services/browser/server.py"),
        ));
    }
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
        for line in std::io::BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
        {
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
            crate::runtime::terminate(&mut running.child);
        }
    }

    pub fn connection(&self) -> Option<(u16, String)> {
        self.reap();
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| (r.port, r.token.clone()))
    }

    fn authenticate(&self, port: u16, token: &str) -> Result<(), String> {
        match self.connection() {
            Some((owned_port, owned_token)) if owned_port == port && owned_token == token => Ok(()),
            _ => Err("The browser session has ended. Reconnect the browser.".into()),
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
    crate::runtime::validate_gateway(&gateway_url)?;
    state.reap();
    let mut guard = state.inner.lock().unwrap();
    if guard.is_some() {
        drop(guard);
        return Ok(browser_status(state));
    }

    let python = find_python().ok_or_else(|| {
        "The browsing agent is not installed. Aira keeps it in its own virtualenv \
         under the Aira data directory."
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

    if let Some(parent) = std::path::Path::new(&script).parent() {
        command.current_dir(parent);
    }
    crate::runtime::prepare(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("could not start the browsing agent: {e}"))?;

    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let mut child = child;
    drain(child.stderr.take(), Arc::clone(&log));

    *guard = Some(Running {
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
        crate::runtime::terminate(&mut running.child);
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

/// One call into the browsing service, for everything that is not a stream.
///
/// Tabs, mode, and anything added later go through here rather than each
/// getting a command of its own. The webview cannot call the service directly —
/// it sends no CORS headers, like every other loopback service Aira supervises
/// — so the shell forwards, and the shape of the call stays the service's
/// business rather than being re-declared on both sides.
#[tauri::command]
pub async fn browser_api(
    state: State<'_, BrowserState>,
    port: u16,
    token: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    state.authenticate(port, &token)?;
    let allowed = match method.as_str() {
        "GET" => matches!(path.as_str(), "/health" | "/tabs" | "/screen"),
        "POST" => matches!(
            path.as_str(),
            "/tabs/open"
                | "/tabs/close"
                | "/tabs/select"
                | "/navigate"
                | "/history"
                | "/focus"
                | "/input"
                | "/mode"
                | "/cancel"
                | "/configure"
        ),
        _ => false,
    };
    if !allowed {
        return Err("Unsupported browser operation".into());
    }
    let url = format!("http://127.0.0.1:{port}{path}");
    let client = crate::runtime::http_client(125)?;
    let request = match method.as_str() {
        "POST" => client
            .post(&url)
            .json(&body.unwrap_or(serde_json::json!({}))),
        _ => client.get(&url),
    };
    let response = request
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("could not reach the browsing agent: {e}"))?;
    let status = response.status();
    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("the browsing agent sent something unreadable: {e}"))?;
    if !status.is_success() {
        let message = parsed
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("the browsing agent refused that");
        return Err(message.to_string());
    }
    Ok(parsed)
}

/// Runs a browsing task, streaming progress back as Tauri events.
///
/// Same reason as the task agent: the webview cannot read this stream itself,
/// so the shell reads it and re-emits each step on a channel keyed by run id.
#[tauri::command]
pub async fn browser_run(
    app: tauri::AppHandle,
    state: State<'_, BrowserState>,
    port: u16,
    token: String,
    task: String,
    max_steps: u32,
    run: String,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    state.authenticate(port, &token)?;
    let response = crate::runtime::http_client(910)?
        .post(format!("http://127.0.0.1:{port}/run"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "task": task, "maxSteps": max_steps, "run": run }))
        .send()
        .await
        .map_err(|e| format!("could not reach the browsing agent: {e}"))?;
    if !response.status().is_success() {
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        return Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("The browsing agent refused the run")
            .to_string());
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("the stream broke: {e}"))?;
        buffer.extend_from_slice(&bytes);
        if buffer.len() > 2_000_000 {
            return Err("Browser event exceeded the size limit".into());
        }
        // Only whole frames: a chunk boundary can fall anywhere in one.
        while let Some(cut) = buffer.windows(2).position(|w| w == b"\n\n") {
            let raw: Vec<u8> = buffer.drain(..cut + 2).collect();
            let frame = String::from_utf8(raw).map_err(|_| "Invalid UTF-8 browser event")?;
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
