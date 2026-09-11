//! A real browser inside the Aira window.
//!
//! This is a native child webview — the same engine Safari uses — composited by
//! the OS into the app's own window. It is not a stream of frames: scrolling has
//! inertia, video plays, text selects, and there is no round trip between a
//! click and the pixel that answers it.
//!
//! Two things follow from how it works, and both shape the code here:
//!
//!   * A child webview is drawn *over* its parent in the rectangle it occupies.
//!     So the panel measures the area under its toolbar and the webview is told
//!     to sit exactly there — and must be closed the moment the user leaves the
//!     screen, or it would hang over chat like a sticker.
//!   * It has no CDP. The browsing agent drives its own Chrome and cannot drive
//!     this one; this is the browser for the person, not for the agent.

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// The label the page webview is registered under. One page view at a time —
/// tabs are switched by navigating it, not by stacking webviews nobody can see.
const LABEL: &str = "aira-page";

fn parse(url: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(url).map_err(|e| format!("that is not a valid address: {e}"))
}

/// Opens the page view, or moves an existing one into place.
#[tauri::command]
pub fn webview_open(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = parse(&url)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "no main window to attach the page to".to_string())?;

    if let Some(existing) = app.get_webview(LABEL) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        return existing.navigate(parsed).map_err(|e| e.to_string());
    }

    window
        .add_child(
            tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(parsed))
                // A plain desktop Safari user agent.
                //
                // WKWebView's default marks itself as an embedded webview, and
                // Google reads that as automation: google.com answers with the
                // "unusual traffic" CAPTCHA at /sorry/ instead of a search box.
                // This is the same engine Safari uses, so presenting as Safari
                // is a description of what it is, not a disguise.
                .user_agent(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
                )
                .disable_drag_drop_handler(),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map(|_| ())
        .map_err(|e| format!("could not open the page view: {e}"))
}

/// Moves and resizes the page view — called whenever the panel's layout changes.
#[tauri::command]
pub fn webview_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else {
        return Ok(());
    };
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = parse(&url)?;
    let Some(view) = app.get_webview(LABEL) else {
        return Err("the page view is not open".to_string());
    };
    view.navigate(parsed).map_err(|e| e.to_string())
}

/// Where the page view currently is, for the address bar and the tab title.
#[tauri::command]
pub fn webview_url(app: tauri::AppHandle) -> Option<String> {
    app.get_webview(LABEL)
        .and_then(|v| v.url().ok())
        .map(|u| u.to_string())
}

/// Back, forward and reload, run in the page rather than through a history API
/// the webview does not expose.
#[tauri::command]
pub fn webview_history(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("unknown action: {action}")),
    };
    view.eval(script).map_err(|e| e.to_string())
}

/// Closes the page view.
///
/// Not optional housekeeping: the webview is drawn over its parent, so one left
/// open covers whatever screen the user moves to next.
#[tauri::command]
pub fn webview_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
