mod applog;
mod fleet;
mod voice;
mod browser;
mod openclaw;
mod opencode;
mod runtime;

use browser::BrowserState;
use openclaw::OpenClawState;
use opencode::OpenCodeState;
use tauri::{Manager, RunEvent};

/// Aira desktop shell (Windows).
///
/// The shell embeds no provider API keys. It holds ephemeral runtime/session
/// credentials and supervises local processes. It hosts the same
/// single-page app the web build serves, which talks to the Aira gateway over
/// HTTPS — provider API keys live in the gateway alone, because a packaged
/// installer can be extracted and read.
///
/// What it does own is the OpenCode agent server: a local subprocess that only
/// makes sense on the desktop, where the user's files are.
pub fn run() {
    tauri::Builder::default()
        // Only for the folder picker: the agent needs to be pointed at a
        // project, and a native picker is the one way to choose a directory
        // the sandbox will then actually let it read.
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenCodeState::default())
        .manage(voice::VoiceState::default())
        .manage(OpenClawState::default())
        .manage(BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            opencode::opencode_status,
            opencode::opencode_start,
            opencode::opencode_stop,
            openclaw::openclaw_status,
            openclaw::openclaw_start,
            openclaw::openclaw_stop,
            openclaw::openclaw_agents,
            openclaw::openclaw_schedules,
            openclaw::openclaw_schedule_add,
            openclaw::openclaw_schedule_remove,
            openclaw::openclaw_run,
            openclaw::openclaw_stream,
            openclaw::openclaw_cancel,
            openclaw::openclaw_log,
            opencode::opencode_log,
            browser::browser_status,
            browser::browser_start,
            browser::browser_stop,
            browser::browser_log,
            browser::browser_run,
            browser::browser_api,
            applog::app_log_write,
            applog::app_log_read,
            applog::app_log_path,
            applog::app_log_clear,
            fleet::fleet_list,
            fleet::fleet_add,
            fleet::fleet_remove,
            voice::voice_status,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_fetch_model,
            voice::voice_transcribe,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Aira")
        .run(|app, event| {
            // The agent server executes shell commands, so it must not outlive
            // the app that supervises it.
            if let RunEvent::Exit = event {
                app.state::<OpenCodeState>().shutdown();
                app.state::<OpenClawState>().shutdown();
                app.state::<BrowserState>().shutdown();
                app.state::<voice::VoiceState>().shutdown();
            }
        });
}
