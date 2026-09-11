mod opencode;

use opencode::OpenCodeState;
use tauri::{Manager, RunEvent};

/// Aira desktop shell.
///
/// The shell holds no product logic and no credentials. It hosts the same
/// single-page app the web build serves, which talks to the Aira gateway over
/// HTTPS — provider API keys live in the gateway alone, because a packaged
/// .app can be unzipped and read.
///
/// What it does own is the OpenCode agent server: a local subprocess that only
/// makes sense on the desktop, where the user's files are.
pub fn run() {
    tauri::Builder::default()
        .manage(OpenCodeState::default())
        .invoke_handler(tauri::generate_handler![
            opencode::opencode_status,
            opencode::opencode_start,
            opencode::opencode_stop,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Aira")
        .run(|app, event| {
            // The agent server executes shell commands, so it must not outlive
            // the app that supervises it.
            if let RunEvent::Exit = event {
                app.state::<OpenCodeState>().shutdown();
            }
        });
}
