//! Supervises the OpenClaw task agent.
//!
//! Same bargain as the OpenCode supervisor: Aira owns the process, picks the
//! port, mints the credential, and kills the child when the app exits. What
//! differs is the shape of the thing being supervised.
//!
//! OpenClaw is a multi-channel assistant — it bridges Discord, Slack, Telegram,
//! iMessage — and its gateway speaks WebSocket rather than SSE. Aira runs it
//! headless, with the panel as the only front end and every messaging channel
//! left unconfigured.
//!
//! Three choices worth stating:
//!
//!   * It runs under its own state directory, so Aira never reads or writes the
//!     user's own `~/.openclaw` if they have one.
//!   * Its config is a file, not an environment blob, so the gateway token goes
//!     in as `${AIRA_TOKEN}` and is substituted from the child's environment.
//!     The token therefore never reaches disk, which is the same property the
//!     OpenCode supervisor holds.
//!   * The gateway is bound to loopback with token auth. It can run shell
//!     commands, so an open port is local code execution for anything on the
//!     machine.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct OpenClawState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
    token: String,
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    /// Sent to the webview so it can authenticate; it never leaves this machine.
    pub token: Option<String>,
    /// Absolute path to the binary, or None when OpenClaw is not installed.
    pub binary: Option<String>,
}

/// Looks for the openclaw binary on PATH and in the usual install locations.
///
/// `~/.npm-global/bin` is in that list because npm's default prefix on macOS is
/// root-owned, so `npm install -g` fails there and the documented fix is a
/// user-owned prefix — which a Finder-launched app will not have on its PATH.
fn find_binary() -> Option<String> {
    if let Ok(out) = Command::new("sh").arg("-lc").arg("command -v openclaw").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    let mut candidates: Vec<String> = vec![
        "/opt/homebrew/bin/openclaw".into(),
        "/usr/local/bin/openclaw".into(),
        "/usr/bin/openclaw".into(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.insert(0, format!("{home}/.npm-global/bin/openclaw"));
    }
    candidates
        .into_iter()
        .find(|c| std::path::Path::new(c).exists())
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

/// Where Aira keeps OpenClaw's state and config, away from the user's own.
fn state_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".aira").join("openclaw");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

impl OpenClawState {
    /// Drops the handle if the child has exited, so a crashed agent can be
    /// restarted instead of leaving `start` convinced it is still running.
    fn reap(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(running) = guard.as_mut() {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
    }
}

#[tauri::command]
pub fn openclaw_status(state: State<'_, OpenClawState>) -> Status {
    state.reap();
    let guard = state.inner.lock().unwrap();

    match guard.as_ref() {
        Some(running) => Status {
            running: true,
            port: Some(running.port),
            token: Some(running.token.clone()),
            binary: find_binary(),
        },
        None => Status {
            running: false,
            port: None,
            token: None,
            binary: find_binary(),
        },
    }
}

/// Builds the config OpenClaw runs under.
///
/// The API key is written as `${AIRA_TOKEN}` rather than the token itself.
/// OpenClaw substitutes `${VAR}` from its environment at load, so the file on
/// disk holds a placeholder and the credential lives only as long as the
/// process — the same property the OpenCode supervisor gets from passing config
/// through the environment entirely.
///
/// The model routes through `/openai/task/v1`, not `/openai/v1`: the gateway
/// reads the surface from the path, and the coding mount would route this to
/// the coding model and meter its spend as coding.
fn build_config(gateway_url: &str, model: &str, port: u16, token: &str) -> serde_json::Value {
    let qualified = format!("aira/{model}");
    serde_json::json!({
        "gateway": {
            "mode": "local",
            // Loopback only. The agent runs shell commands, so the port must
            // not be reachable from off this machine.
            "bind": "loopback",
            "port": port,
            "auth": { "token": token },
            // Off by default. Aira drives the agent over this rather than the
            // WebSocket control protocol: it is the same SSE shape the rest of
            // the app already speaks, where the WS handshake is a challenge
            // exchange with its own protocol versioning and device tokens.
            "http": { "endpoints": { "chatCompletions": { "enabled": true } } },
        },
        // OpenClaw advertises the gateway over mDNS on start — "bonjour:
        // advertised gateway ... state=announcing" in its own log. Aira's
        // instance is loopback-only and private to this app, so broadcasting
        // its presence to the local network buys nothing and tells every device
        // on the café Wi-Fi that this machine is running an agent.
        "plugins": { "entries": { "bonjour": { "enabled": false } } },
        "agents": { "defaults": { "model": { "primary": qualified } } },
        "models": {
            "providers": {
                "aira": {
                    "baseUrl": format!("{}/openai/task/v1", gateway_url.trim_end_matches('/')),
                    "apiKey": "${AIRA_TOKEN}",
                    "api": "openai-completions",
                    "timeoutSeconds": 300,
                    "models": [{
                        "id": model,
                        "name": "Aira Task",
                        "input": ["text"],
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                        "contextWindow": 200000,
                        "maxTokens": 8192,
                    }],
                }
            }
        },
    })
}

#[tauri::command]
pub fn openclaw_start(
    state: State<'_, OpenClawState>,
    gateway_url: String,
    token: String,
    model: String,
) -> Result<Status, String> {
    state.reap();
    {
        let guard = state.inner.lock().unwrap();
        if guard.is_some() {
            drop(guard);
            return Ok(openclaw_status(state));
        }
    }

    let binary = find_binary().ok_or_else(|| {
        "OpenClaw is not installed. Install it with `npm install -g openclaw`.".to_string()
    })?;

    let dir = state_dir()?;
    let port = free_port()?;
    let gateway_token = uuid::Uuid::new_v4().to_string();
    let config_path = dir.join("openclaw.json");
    let config = build_config(&gateway_url, &model, port, &gateway_token);
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("could not write {}: {e}", config_path.display()))?;

    let mut command = Command::new(&binary);
    command
        .arg("gateway")
        .arg("--port")
        .arg(port.to_string())
        .arg("--bind")
        .arg("loopback")
        .arg("--auth")
        .arg("token")
        .env("OPENCLAW_STATE_DIR", dir.join("state"))
        .env("OPENCLAW_CONFIG_PATH", &config_path)
        .env("OPENCLAW_GATEWAY_TOKEN", &gateway_token)
        // Substituted into the config's `${AIRA_TOKEN}` at load, so the session
        // token is never written to disk.
        .env("AIRA_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // A GUI app launched from Finder inherits "/" as its working directory.
    if let Ok(home) = std::env::var("HOME") {
        command.current_dir(home);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("could not start OpenClaw: {e}"))?;

    *state.inner.lock().unwrap() = Some(Running {
        child,
        port,
        token: gateway_token.clone(),
    });

    Ok(Status {
        running: true,
        port: Some(port),
        token: Some(gateway_token),
        binary: Some(binary),
    })
}

#[tauri::command]
pub fn openclaw_stop(state: State<'_, OpenClawState>) -> Result<(), String> {
    if let Some(mut running) = state.inner.lock().unwrap().take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

impl OpenClawState {
    /// Called when the app exits, so the agent does not outlive the app that
    /// supervises it and leave a shell-executing port open.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.inner.lock().unwrap().take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

// ── HTTP bridge ──────────────────────────────────────────────────────────────
//
// The webview cannot call OpenClaw directly. Its gateway sends no CORS headers
// at all and answers 405 to a preflight, so from `tauri://localhost` every
// response is discarded by the browser and every request that carries an
// Authorization header never leaves. The server is reachable and healthy the
// whole time, which makes it look like a hung agent rather than a blocked one.
//
// So the calls are made here, where the same-origin policy does not apply, and
// only the result crosses back into the webview.

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))
}

#[derive(Serialize)]
pub struct AgentEntry {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn openclaw_agents(port: u16, token: String) -> Result<Vec<AgentEntry>, String> {
    let body: serde_json::Value = client()?
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("could not reach the agent: {e}"))?
        .error_for_status()
        .map_err(|e| format!("the agent refused the request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("the agent sent something unreadable: {e}"))?;

    Ok(body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                // The bare "openclaw" entry is the same worker as the qualified
                // default; both would put two cards on the canvas for one agent.
                .filter(|id| id.contains('/'))
                .map(|id| AgentEntry {
                    id: id.to_string(),
                    name: id.split('/').skip(1).collect::<Vec<_>>().join("/"),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn openclaw_run(
    port: u16,
    token: String,
    agent: String,
    message: String,
) -> Result<String, String> {
    let body: serde_json::Value = client()?
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "model": agent,
            "messages": [{ "role": "user", "content": message }],
            "stream": false,
        }))
        .send()
        .await
        .map_err(|e| format!("could not reach the agent: {e}"))?
        .json()
        .await
        .map_err(|e| format!("the agent sent something unreadable: {e}"))?;

    // A failed run comes back as a 200 with an error object: by the time an
    // upstream provider gives up, the response has already started.
    if let Some(error) = body.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        return Err(error.to_string());
    }
    Ok(body
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string())
}
