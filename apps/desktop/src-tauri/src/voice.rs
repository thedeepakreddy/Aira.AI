//! Speech recognition that stays on this machine.
//!
//! The voice screen has used the browser's own recogniser, which on most
//! engines means audio is sent to the vendor's service. That is a poor fit for
//! an app whose whole argument is that your work is yours, and it is the one
//! surface where the data involved is your voice.
//!
//! This runs whisper.cpp locally instead. Three things follow from that choice
//! and shape everything here.
//!
//! **The model is a separate download.** The binaries are small and the weights
//! are not, so a install can have whisper and no model. That is a normal state,
//! not an error — it is reported, and fetching is something the user asks for
//! rather than something that happens to their connection unannounced.
//!
//! **The server stays warm.** Transcribing by spawning a process per utterance
//! reloads the weights every time, which on a conversational turn is most of
//! the latency. A long-lived server holds the model in memory and answers in
//! a fraction of that.
//!
//! **It degrades to the browser.** No whisper, no model, or a server that will
//! not start, and the voice screen goes back to the platform recogniser. Worse
//! privacy, but working — a voice screen that refuses to listen is not a
//! privacy feature.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

/// Weights small enough to download without ceremony and good enough for
/// dictation. English-only: the multilingual model of the same size is
/// noticeably worse at English, and the voice screen is English today.
const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

#[derive(Default)]
pub struct VoiceState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    /// Whether whisper.cpp is installed at all.
    pub installed: bool,
    /// Absolute path to the weights, or None when they have not been fetched.
    pub model: Option<String>,
    pub running: bool,
    pub port: Option<u16>,
    /// What the user would have to do next, in their words rather than a code.
    pub note: String,
}

fn binary() -> Option<String> {
    // Homebrew's is the usual one; PATH covers everything else. A GUI app's
    // PATH is thin, which is why the explicit location comes first.
    for candidate in ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    crate::runtime::which("whisper-server")
}

fn model_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".aira").join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn model_path() -> Option<std::path::PathBuf> {
    let path = model_dir().ok()?.join(MODEL_FILE);
    path.exists().then_some(path)
}

#[tauri::command]
pub fn voice_status(state: State<'_, VoiceState>) -> VoiceStatus {
    let installed = binary().is_some();
    let model = model_path();
    let guard = state.inner.lock().unwrap();
    let running = guard.as_ref();
    VoiceStatus {
        installed,
        model: model.as_ref().map(|p| p.to_string_lossy().to_string()),
        running: running.is_some(),
        port: running.map(|r| r.port),
        note: match (installed, model.is_some()) {
            (false, _) => "Install whisper.cpp to transcribe on this device. Without it, speech goes to your browser's recogniser.".into(),
            (true, false) => "Download the speech model once (about 140 MB) to keep your voice on this machine.".into(),
            (true, true) => "Speech is transcribed on this device.".into(),
        },
    }
}

/// Fetches the weights, once, because the user asked.
///
/// Deliberately not automatic: it is a large download, and an app that starts
/// one on its own behalf the first time someone opens a screen is an app that
/// spends their connection without asking.
#[tauri::command]
pub async fn voice_fetch_model() -> Result<String, String> {
    let dir = model_dir()?;
    let target = dir.join(MODEL_FILE);
    if target.exists() {
        return Ok(target.to_string_lossy().to_string());
    }

    let response = crate::runtime::http_client(600)?
        .get(MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("could not reach the model host: {e}"))?
        .error_for_status()
        .map_err(|e| format!("the model host refused: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("the download failed partway: {e}"))?;

    // Written beside the target and renamed, so an interrupted download never
    // leaves a half file that looks like a model and fails at load.
    let partial = dir.join(format!("{MODEL_FILE}.partial"));
    std::fs::write(&partial, &bytes).map_err(|e| format!("could not write the model: {e}"))?;
    std::fs::rename(&partial, &target).map_err(|e| format!("could not finish the model: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn voice_start(state: State<'_, VoiceState>) -> Result<VoiceStatus, String> {
    {
        let guard = state.inner.lock().unwrap();
        if guard.is_some() {
            drop(guard);
            return Ok(voice_status(state));
        }
    }

    let binary = binary().ok_or_else(|| {
        "whisper.cpp is not installed. Install it with `brew install whisper-cpp`.".to_string()
    })?;
    let model = model_path()
        .ok_or_else(|| "The speech model has not been downloaded yet.".to_string())?;
    let port = crate::runtime::free_port()?;

    let mut command = Command::new(&binary);
    command
        .arg("--model")
        .arg(&model)
        .arg("--port")
        .arg(port.to_string())
        // Loopback only. This accepts audio and would happily accept it from
        // anything else on the network.
        .arg("--host")
        .arg("127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::runtime::prepare(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("could not start the speech service: {e}"))?;
    *state.inner.lock().unwrap() = Some(Running { child, port });
    Ok(voice_status(state))
}

#[tauri::command]
pub fn voice_stop(state: State<'_, VoiceState>) -> Result<(), String> {
    if let Some(mut running) = state.inner.lock().unwrap().take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

/// Transcribes one utterance.
///
/// Audio arrives as base64 because it crosses the webview bridge, which carries
/// JSON. The recording is a few seconds of speech, so the encoding overhead is
/// not worth a second transport to avoid.
#[tauri::command]
pub async fn voice_transcribe(port: u16, audio: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio.as_bytes())
        .map_err(|_| "the recording could not be read".to_string())?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");

    let response = crate::runtime::http_client(120)?
        .post(format!("http://127.0.0.1:{port}/inference"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("could not reach the speech service: {e}"))?
        .error_for_status()
        .map_err(|e| format!("the speech service refused: {e}"))?;

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("the speech service sent something unreadable: {e}"))?;
    Ok(body
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

impl VoiceState {
    /// Stops the service when the app exits, like every other runtime here.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.inner.lock().unwrap().take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_is_english_only_and_named_for_it() {
        // The multilingual model of this size is noticeably worse at English,
        // and the voice screen is English today.
        assert!(MODEL_FILE.contains(".en."));
        assert!(MODEL_URL.ends_with(MODEL_FILE), "the URL and the file must agree");
    }

    #[test]
    fn the_model_url_is_https() {
        // Weights are executable input to a local process; fetching them over
        // plaintext would let anything on the path choose what runs.
        assert!(MODEL_URL.starts_with("https://"));
    }

    #[test]
    fn the_model_lives_under_aira_not_the_repo() {
        let dir = model_dir().expect("home");
        assert!(dir.ends_with("whisper"));
        assert!(dir.to_string_lossy().contains(".aira"));
    }
}
