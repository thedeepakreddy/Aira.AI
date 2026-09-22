//! Starting the gateway, so that opening Aira is the whole of opening Aira.
//!
//! Every other runtime here is started because the user asked for it — they
//! open the Code screen, and OpenCode starts. The gateway is different: nothing
//! works without it. Chat, the model list, memory, the agents' own model
//! access all go through it, so an app whose gateway is not running is an app
//! showing "Could not reach Aira" on every screen at once.
//!
//! It had been started by hand, in a terminal, and so it died with the terminal
//! — or with a reboot, or a crash — and the first thing the user did each day
//! was go and start a server. That is not a step a product gets to have.
//!
//! Three decisions shape this file.
//!
//! **A gateway that is already running is adopted, not replaced.** Running
//! `npm run dev` in the repo is how this thing is developed, and an app that
//! killed that to start its own copy — or worse, fought it for the port — would
//! make the app unusable to the person building it. If something answers on the
//! port, Aira uses it and leaves it alone, including at exit.
//!
//! **What Aira starts, Aira stops.** The reverse of the same rule. A gateway
//! this app spawned is a child of this app and must not outlive it, or the next
//! launch finds the port taken by a process nobody is supervising.
//!
//! **A crash is not the end.** The gateway is a Node process reaching five
//! vendors over the network; it can die. If the one we started exits while the
//! app is open, it gets restarted — with a widening delay, because a gateway
//! that cannot start is better reported than retried forty times a second.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// The port the web build is compiled to talk to.
///
/// Fixed rather than discovered: the frontend's gateway URL is baked in at
/// build time by Vite, so a gateway on a port of its own choosing is a gateway
/// the app cannot find.
const PORT: u16 = 8787;

/// How long to let a cold gateway start before calling it a failure. It loads
/// five provider SDKs and probes Ollama, which is not instant on a cold cache.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct GatewayState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// True only when this app started it. Someone else's is not ours to stop.
    owned: bool,
    ready: bool,
    /// What the user would need to know, in their words rather than a code.
    note: String,
}

#[derive(Serialize, Clone)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    /// Whether Aira started it, as opposed to finding it already up.
    pub managed: bool,
    pub note: String,
}

/// Whether something is answering as the gateway on the port.
///
/// `/health` rather than a bare TCP connect: a socket that accepts proves only
/// that something is listening, and "something" during development is as often
/// a stale process holding the port as it is a working gateway.
fn healthy() -> bool {
    let Ok(client) = crate::runtime::http_client(3) else {
        return false;
    };
    tauri::async_runtime::block_on(async move {
        match client.get(format!("http://127.0.0.1:{PORT}/health")).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    })
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// A directory is a gateway if it has the file we would run.
fn runnable(dir: PathBuf) -> Option<PathBuf> {
    dir.join("src").join("index.ts").exists().then_some(dir)
}

/// Where the gateway is, in order of how deliberately it was put there.
///
/// The path file is what makes this work on the machine Aira is built on:
/// `npm run install-gateway -- --link` writes the repo's own path into it, so
/// the installed app runs the working copy and an edit to the gateway is live
/// on the next launch. A copy under ~/.aira/gateway is the shape a shipped
/// build would use, and is checked second so the link always wins.
fn directory() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AIRA_GATEWAY_DIR") {
        if let Some(dir) = runnable(PathBuf::from(explicit)) {
            return Some(dir);
        }
    }
    let home = home()?;
    if let Ok(linked) = std::fs::read_to_string(home.join(".aira").join("gateway-path")) {
        if let Some(dir) = runnable(PathBuf::from(linked.trim())) {
            return Some(dir);
        }
    }
    runnable(home.join(".aira").join("gateway"))
}

fn log_path() -> Option<PathBuf> {
    let dir = home()?.join(".aira");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("gateway.log"))
}

fn spawn(dir: &PathBuf) -> Result<Child, String> {
    let node = crate::runtime::which("node")
        .ok_or_else(|| "Node is not installed, and the Aira gateway runs on it.".to_string())?;

    let mut command = Command::new(node);
    command
        // No build step: Node strips the types itself, which is why the gateway
        // can be started from source like this at all.
        .arg("--env-file-if-exists=.env")
        .arg("src/index.ts")
        .current_dir(dir)
        .stdin(Stdio::null());

    // Its output goes to a file rather than nowhere. When the gateway will not
    // start, the reason is in what it printed, and a GUI app has no terminal to
    // print it to.
    match log_path().and_then(|path| {
        std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
    }) {
        Some(file) => {
            let dup = file.try_clone().map_err(|e| e.to_string())?;
            command.stdout(Stdio::from(file)).stderr(Stdio::from(dup));
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    crate::runtime::prepare(&mut command);
    command
        .spawn()
        .map_err(|e| format!("could not start the Aira gateway: {e}"))
}

/// Waits for the gateway to answer, or gives up.
fn await_ready() -> bool {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if healthy() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn publish(app: &tauri::AppHandle, status: &GatewayStatus) {
    // The screens listen for this so the first paint can wait for a starting
    // gateway rather than reporting it unreachable.
    let _ = app.emit("aira://gateway", status.clone());
}

fn snapshot(state: &GatewayState) -> GatewayStatus {
    let inner = state.inner.lock().unwrap();
    GatewayStatus {
        running: inner.ready,
        port: PORT,
        managed: inner.owned,
        note: inner.note.clone(),
    }
}

/// Brings a gateway up, then keeps one up for as long as the app is open.
///
/// Runs on its own thread: the window must paint while this is happening, and
/// a cold gateway takes seconds.
pub fn supervise(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            let state = app.state::<GatewayState>();

            // Someone else's gateway — the developer's `npm run dev`, or one
            // left from a previous launch — is used as it is.
            if healthy() {
                {
                    let mut inner = state.inner.lock().unwrap();
                    let adopted = inner.child.is_none();
                    inner.ready = true;
                    if adopted {
                        inner.owned = false;
                        inner.note = "Connected.".into();
                    }
                }
                backoff = Duration::from_secs(1);
                publish(&app, &snapshot(&state));
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }

            // Reap a child that has exited, so the next pass starts a new one
            // rather than waiting on a corpse.
            {
                let mut inner = state.inner.lock().unwrap();
                if let Some(child) = inner.child.as_mut() {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        inner.child = None;
                    }
                }
                if inner.child.is_some() {
                    // Started, not answering yet. Give it time before deciding.
                    drop(inner);
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
                inner.ready = false;
            }
            publish(&app, &snapshot(&state));

            let Some(dir) = directory() else {
                {
                    let mut inner = state.inner.lock().unwrap();
                    inner.note = "Aira cannot find its gateway. Run `npm run install-gateway` in services/gateway.".into();
                }
                publish(&app, &snapshot(&state));
                /*
                 * Waiting rather than giving up. The note above names a command
                 * the user can run right now, and running it while the app is
                 * open should be enough — an app that had already stopped
                 * looking would need to be quit and reopened to notice, which
                 * is the same "go and fix the server first" this file exists to
                 * remove.
                 */
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            };

            match spawn(&dir) {
                Ok(child) => {
                    {
                        let mut inner = state.inner.lock().unwrap();
                        inner.child = Some(child);
                        inner.owned = true;
                        inner.note = "Starting…".into();
                    }
                    publish(&app, &snapshot(&state));

                    if await_ready() {
                        let mut inner = state.inner.lock().unwrap();
                        inner.ready = true;
                        inner.note = "Connected.".into();
                        drop(inner);
                        backoff = Duration::from_secs(1);
                        publish(&app, &snapshot(&state));
                    } else {
                        let mut inner = state.inner.lock().unwrap();
                        if let Some(mut child) = inner.child.take() {
                            crate::runtime::terminate(&mut child);
                        }
                        inner.ready = false;
                        inner.note = "The gateway did not start. See ~/.aira/gateway.log.".into();
                        drop(inner);
                        publish(&app, &snapshot(&state));
                        std::thread::sleep(backoff);
                        // Widening, capped: a gateway that cannot start is
                        // worth reporting, not worth retrying in a tight loop.
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                    }
                }
                Err(error) => {
                    {
                        let mut inner = state.inner.lock().unwrap();
                        inner.ready = false;
                        inner.note = error;
                    }
                    publish(&app, &snapshot(&state));
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        }
    });
}

#[tauri::command]
pub fn gateway_status(state: State<'_, GatewayState>) -> GatewayStatus {
    snapshot(&state)
}

/// Stops the gateway Aira started, so the next pass starts a fresh one.
#[tauri::command]
pub fn gateway_restart(state: State<'_, GatewayState>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(mut child) = inner.child.take() {
        crate::runtime::terminate(&mut child);
    }
    inner.ready = false;
    inner.note = "Restarting…".into();
    Ok(())
}

impl GatewayState {
    /// Stops the gateway on the way out — but only the one we started.
    ///
    /// A developer's `npm run dev` outliving the app is correct; killing it
    /// because Aira happened to use it would make quitting the app a
    /// destructive act on someone else's terminal.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mut child) = inner.child.take() {
            crate::runtime::terminate(&mut child);
        }
        inner.ready = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_the_one_the_frontend_is_built_for() {
        // VITE_GATEWAY_URL is baked in at build time. If these disagree the app
        // starts a gateway it then cannot talk to.
        let env = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../apps/web/.env"),
        );
        if let Ok(text) = env {
            if let Some(line) = text.lines().find(|l| l.starts_with("VITE_GATEWAY_URL=")) {
                assert!(
                    line.contains(&PORT.to_string()),
                    "the supervisor's port and VITE_GATEWAY_URL disagree: {line}",
                );
            }
        }
    }

    #[test]
    fn a_directory_without_the_entry_point_is_not_a_gateway() {
        assert!(runnable(PathBuf::from("/nonexistent/gateway")).is_none());
    }

    #[test]
    fn the_real_gateway_is_recognised() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../services/gateway");
        if repo.exists() {
            assert!(runnable(repo).is_some(), "the repo's own gateway must be recognised");
        }
    }
}
