//! Supervises the OpenCode agent server.
//!
//! OpenCode ships a headless HTTP server, so Aira drives it over its API rather
//! than scraping a terminal UI. Aira owns the process: it picks the port, mints
//! the credential, and kills the child when the app exits.
//!
//! Two things about that server make supervision security-relevant rather than
//! bookkeeping:
//!
//!   * It is unauthenticated unless `OPENCODE_SERVER_PASSWORD` is set, and it
//!     says so on startup.
//!   * `POST /session/{id}/shell` executes arbitrary shell commands and sits
//!     outside its own tool-permission system.
//!
//! Together those mean an unsecured instance is local code execution for
//! anything that can reach the port. So a fresh random password is generated per
//! launch, the server is bound to loopback, and no extra CORS origin is passed.

use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct OpenCodeState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    /// Recent stderr, for saying why a start failed.
    log: Arc<Mutex<VecDeque<String>>>,
    port: u16,
    password: String,
    /// Where the server was started. The agent's tools inherit this, so the
    /// panel needs it to tell which stored session belongs to this process.
    directory: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    /// Sent to the webview so it can authenticate; it never leaves this machine.
    pub password: Option<String>,
    /// Absolute path to the binary, or None when OpenCode is not installed.
    pub binary: Option<String>,
    /// Working directory of the running server, if any.
    pub directory: Option<String>,
}

/// Looks for the opencode binary on PATH and in the usual install locations.
/// Returning the path rather than a bool lets the UI say *what* is missing.
fn find_binary() -> Option<String> {
    if let Ok(out) = Command::new("sh").arg("-lc").arg("command -v opencode").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    for candidate in [
        "/opt/homebrew/bin/opencode",
        "/usr/local/bin/opencode",
        "/usr/bin/opencode",
    ] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Asks the OS for a free port by binding to 0 and reading back the assignment,
/// rather than guessing a fixed port that may already be taken.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("could not read the reserved port: {e}"))
}

impl OpenCodeState {
    /// Drops the handle if the child has exited.
    ///
    /// Both commands need this. Without it in `start`, an agent that crashed or
    /// was killed from outside leaves a dead handle behind, `start` sees it as
    /// already running, and the panel is handed a port nothing is listening on
    /// — which surfaces as an unexplained connection failure that no amount of
    /// pressing the button can clear.
    fn reap(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(running) = guard.as_mut() {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
    }
}

/// Keeps the tail of a child's stderr, and — more importantly — keeps reading it.
///
/// A piped stream nobody drains is not just a lost diagnostic. The pipe holds
/// about 64KB; once it fills, the child blocks on its next write and stops
/// making progress. These agents log every plugin they load at startup, so one
/// would hang part-way through booting: the process is alive, nothing is
/// listening, and the panel reports an agent that never answered.
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

#[tauri::command]
pub fn opencode_status(state: State<'_, OpenCodeState>) -> Status {
    state.reap();
    let guard = state.inner.lock().unwrap();

    match guard.as_ref() {
        Some(running) => Status {
            running: true,
            port: Some(running.port),
            password: Some(running.password.clone()),
            binary: find_binary(),
            directory: running.directory.clone(),
        },
        None => Status {
            running: false,
            port: None,
            password: None,
            binary: find_binary(),
            directory: None,
        },
    }
}

/// Builds the config OpenCode runs under.
///
/// Passed through `OPENCODE_CONFIG_CONTENT` rather than a file, for two
/// reasons: writing `opencode.json` into the user's repository would litter
/// their project, and the gateway token would then sit on disk. In the
/// environment it lives only as long as the process.
///
/// Two things this config is responsible for:
///
///  * Pointing the agent at Aira's gateway, so agent spend is metered and
///    capped like every other surface instead of billing somewhere invisible.
///  * Setting `edit` and `bash` to "ask". OpenCode allows everything by
///    default, so without this the approval prompts in Aira's UI would never
///    fire and the agent would edit files unannounced.
fn build_config(gateway_url: &str, token: &str, model: &str) -> String {
    let qualified = format!("aira/{model}");
    serde_json::json!({
        "provider": {
            "aira": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Aira Gateway",
                "options": {
                    "baseURL": format!("{}/openai/v1", gateway_url.trim_end_matches('/')),
                    "apiKey": token,
                },
                "models": { model: { "name": "Aira Agent" } },
            }
        },
        "model": qualified,
        "permission": {
            "read": "allow",
            "list": "allow",
            "glob": "allow",
            "grep": "allow",
            "lsp": "allow",
            "edit": "ask",
            "bash": "ask",
            "task": "ask",
            "webfetch": "deny",
            "websearch": "deny",
            "external_directory": "deny",
        },
    })
    .to_string()
}

#[tauri::command]
pub fn opencode_start(
    state: State<'_, OpenCodeState>,
    directory: Option<String>,
    gateway_url: String,
    token: String,
    model: String,
) -> Result<Status, String> {
    state.reap();
    {
        let guard = state.inner.lock().unwrap();
        if guard.is_some() {
            drop(guard);
            return Ok(opencode_status(state));
        }
    }

    let binary = find_binary().ok_or_else(|| {
        "OpenCode is not installed. Install it with `npm install -g opencode-ai`.".to_string()
    })?;

    let port = free_port()?;
    let password = uuid::Uuid::new_v4().to_string();

    let mut command = Command::new(&binary);
    command
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        // Loopback only. The server executes shell commands, so it must never
        // be reachable off this machine.
        .arg("--hostname")
        .arg("127.0.0.1")
        .env("OPENCODE_SERVER_PASSWORD", &password)
        // Config by environment: nothing is written into the user's project,
        // and the gateway token never reaches disk.
        .env(
            "OPENCODE_CONFIG_CONTENT",
            build_config(&gateway_url, &token, &model),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // A GUI app launched from Finder inherits "/" as its working directory, and
    // the agent would then treat the filesystem root as the project. Fall back
    // to the user's home instead, which is at least somewhere they own.
    let workdir = directory
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .filter(|d| d != "/");
    if let Some(dir) = &workdir {
        command.current_dir(dir);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("could not start OpenCode: {e}"))?;

    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let mut child = child;
    drain(child.stderr.take(), Arc::clone(&log));

    *state.inner.lock().unwrap() = Some(Running {
        child,
        log,
        port,
        password: password.clone(),
        directory: workdir.clone(),
    });

    Ok(Status {
        running: true,
        port: Some(port),
        password: Some(password),
        binary: Some(binary),
        directory: workdir,
    })
}

#[tauri::command]
pub fn opencode_stop(state: State<'_, OpenCodeState>) -> Result<(), String> {
    if let Some(mut running) = state.inner.lock().unwrap().take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

impl OpenCodeState {
    /// Called when the app exits. Without this the agent server outlives Aira
    /// and keeps a shell-executing port open with nothing watching it.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.inner.lock().unwrap().take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

/// The tail of the agent's own stderr, so a failed start can say what it said
/// rather than only that it said nothing.
#[tauri::command]
pub fn opencode_log(state: State<'_, OpenCodeState>) -> Vec<String> {
    let guard = state.inner.lock().unwrap();
    guard
        .as_ref()
        .map(|r| r.log.lock().unwrap().iter().cloned().collect())
        .unwrap_or_default()
}
