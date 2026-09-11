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

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct OpenCodeState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
    password: String,
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    /// Sent to the webview so it can authenticate; it never leaves this machine.
    pub password: Option<String>,
    /// Absolute path to the binary, or None when OpenCode is not installed.
    pub binary: Option<String>,
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

#[tauri::command]
pub fn opencode_status(state: State<'_, OpenCodeState>) -> Status {
    let mut guard = state.inner.lock().unwrap();

    // A child that has exited must not be reported as running.
    if let Some(running) = guard.as_mut() {
        if matches!(running.child.try_wait(), Ok(Some(_))) {
            *guard = None;
        }
    }

    match guard.as_ref() {
        Some(running) => Status {
            running: true,
            port: Some(running.port),
            password: Some(running.password.clone()),
            binary: find_binary(),
        },
        None => Status {
            running: false,
            port: None,
            password: None,
            binary: find_binary(),
        },
    }
}

#[tauri::command]
pub fn opencode_start(
    state: State<'_, OpenCodeState>,
    directory: Option<String>,
) -> Result<Status, String> {
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    if let Some(dir) = directory.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("could not start OpenCode: {e}"))?;

    *state.inner.lock().unwrap() = Some(Running {
        child,
        port,
        password: password.clone(),
    });

    Ok(Status {
        running: true,
        port: Some(port),
        password: Some(password),
        binary: Some(binary),
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
