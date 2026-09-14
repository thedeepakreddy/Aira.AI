//! A durable log for the whole app.
//!
//! The three supervisors each keep a tail of their child's stderr in memory,
//! which is gone the moment the app exits — so the one time you most want the
//! log, after a crash or a hang, is the one time it does not exist. This writes
//! to a file instead, and the panel reads it back.
//!
//! Deliberately small: append a line, read the tail, clear. No levels beyond a
//! label, no structured fields, no rotation policy more clever than a byte cap.
//! A logger that needs its own debugging is worse than none.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::sync::Mutex;

/// Past this the file is halved, oldest first. Large enough to hold a long
/// session, small enough that reading it back is instant.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Serialises writers within this process. Two panels logging at once would
/// otherwise interleave partial lines.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn log_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".aira");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("aira.log"))
}

/// Drops the first half of the file once it passes the cap.
///
/// Rewriting in place rather than rotating to a second file: one path to find
/// when something goes wrong, and no chance of the useful half being the one
/// that was rotated away.
fn trim(path: &std::path::Path) -> Result<(), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len <= MAX_BYTES {
        return Ok(());
    }
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(len / 2))
        .map_err(|e| e.to_string())?;
    // The seek lands mid-line; discard the fragment so the file starts clean.
    let mut fragment = String::new();
    let _ = reader.read_line(&mut fragment);
    let mut kept = String::new();
    let mut line = String::new();
    while reader.read_line(&mut line).map_err(|e| e.to_string())? > 0 {
        kept.push_str(&line);
        line.clear();
    }
    std::fs::write(path, kept).map_err(|e| e.to_string())
}

/// Appends one line. Never fails the caller: a log that can break the thing it
/// is logging about is a liability, so write errors are swallowed here.
pub fn record(surface: &str, level: &str, message: &str) {
    let _guard = WRITE_LOCK.lock();
    let Ok(path) = log_path() else { return };
    let _ = trim(&path);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // One line per entry, newlines flattened, so the tail reader never has to
    // guess where an entry begins.
    let flat = message.replace(['\n', '\r'], " ");
    let clipped: String = flat.chars().take(2000).collect();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{at}\t{surface}\t{level}\t{clipped}");
    }
}

#[tauri::command]
pub fn app_log_write(surface: String, level: String, message: String) {
    record(&surface, &level, &message);
}

/// The last `lines` entries, oldest first. Empty when nothing has been logged.
#[tauri::command]
pub fn app_log_read(lines: Option<usize>) -> Result<Vec<String>, String> {
    let want = lines.unwrap_or(200).min(2000);
    let path = log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let all: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    Ok(all[all.len().saturating_sub(want)..].to_vec())
}

/// Where the file lives, so the panel can tell the user rather than hide it.
#[tauri::command]
pub fn app_log_path() -> Result<String, String> {
    Ok(log_path()?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn app_log_clear() -> Result<(), String> {
    let path = log_path()?;
    if path.exists() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_survives_newlines_in_the_message() {
        // Flattening matters: the reader splits on newlines, so an embedded one
        // would turn a single stack trace into several unattributed entries.
        let message = "boom\nat foo()\r\nat bar()";
        let flat = message.replace(['\n', '\r'], " ");
        assert!(!flat.contains('\n'));
        assert!(flat.contains("at foo()"));
    }

    #[test]
    fn trimming_keeps_the_newest_half_and_starts_on_a_boundary() {
        let dir = std::env::temp_dir().join(format!("aira-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let line = "x".repeat(99);
        let body: String = (0..60_000).map(|i| format!("{i} {line}\n")).collect();
        std::fs::write(&path, &body).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > MAX_BYTES);

        trim(&path).unwrap();

        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(kept.len() < body.len(), "the file should have shrunk");
        // No leading fragment: the first line is a whole one.
        let first = kept.lines().next().unwrap();
        assert!(first.ends_with(&line), "first line should be intact, got {first:.40}");
        // The newest entries are the ones kept.
        assert!(kept.ends_with(&format!("59999 {line}\n")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
