//! Shared supervision boundaries for the three local runtimes (Windows).
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The PATH with common Node install locations appended.
///
/// On Windows, apps launched from the Start menu or Explorer inherit the full
/// user PATH — unlike macOS, where a Finder-launched app gets only a minimal
/// set. Still, some Node managers install to directories that are not on the
/// default system PATH, so this adds the usual suspects.
fn windows_path() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let base = std::env::var("PATH").unwrap_or_default();
            let mut parts: Vec<String> = base.split(';').map(str::to_string).collect();

            // Common Node install locations on Windows that may not be on PATH.
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_global = format!("{appdata}\\npm");
                if !parts.contains(&npm_global) {
                    parts.push(npm_global);
                }
            }
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                for extra in [
                    format!("{localappdata}\\Programs\\nodejs"),
                    format!("{localappdata}\\Volta\\bin"),
                ] {
                    if !parts.contains(&extra) {
                        parts.push(extra);
                    }
                }
            }
            if let Ok(userprofile) = std::env::var("USERPROFILE") {
                for extra in [
                    // nvm-windows
                    format!("{userprofile}\\AppData\\Roaming\\nvm"),
                    // scoop
                    format!("{userprofile}\\scoop\\shims"),
                ] {
                    if !parts.contains(&extra) {
                        parts.push(extra);
                    }
                }
            }
            // Program Files defaults
            for extra in [
                r"C:\Program Files\nodejs",
                r"C:\Program Files (x86)\nodejs",
            ] {
                if !parts.iter().any(|p| p == extra) {
                    parts.push(extra.to_string());
                }
            }
            parts.join(";")
        })
        .clone()
}

pub fn prepare(command: &mut Command) {
    // Ensure Node and other tools are findable even if the app was launched
    // from a context with a minimal PATH.
    command.env("PATH", windows_path());

    // On Windows, use CREATE_NO_WINDOW to prevent a console window from
    // flashing when spawning child processes.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn terminate(child: &mut Child) {
    // On Windows, use taskkill with /T (tree) and /F (force) to kill the
    // entire process tree. This covers Chrome and shell/tool descendants
    // as well as the Node/Python parent.
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid])
            .output();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    // Fallback / non-Windows: the standard kill.
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn validate_gateway(value: &str) -> Result<(), String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid gateway URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTPS gateway, or HTTP on localhost for development".into());
    }
    Ok(())
}

pub fn http_client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_requires_tls_except_loopback() {
        assert!(validate_gateway("https://aira.example").is_ok());
        assert!(validate_gateway("http://localhost:8787").is_ok());
        assert!(validate_gateway("http://example.com").is_err());
        assert!(validate_gateway("https://user:secret@example.com").is_err());
        assert!(validate_gateway("file:///tmp/gateway").is_err());
    }

    #[test]
    fn windows_path_includes_program_files_nodejs() {
        let path = windows_path();
        assert!(
            path.split(';').any(|entry| entry.contains("nodejs")),
            "PATH should include a nodejs directory, got: {path}",
        );
    }
}

/// A port nothing else holds.
///
/// The listener is dropped immediately, so this is advisory — between here and
/// the child binding it, something else could take it. In practice nothing
/// does, and the alternative is passing a listener across a process boundary.
pub fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("could not read the reserved port: {e}"))
}

/// Finds a binary on PATH using `where.exe` on Windows.
///
/// On Windows, `where.exe` is the equivalent of Unix `which` / `command -v`.
pub fn which(name: &str) -> Option<String> {
    let out = std::process::Command::new("where.exe")
        .arg(name)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // `where.exe` may return multiple lines; take the first match.
    let path = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    (!path.is_empty()).then_some(path)
}

/// Returns the Aira data directory on Windows.
///
/// Uses `%APPDATA%\Aira` (typically `C:\Users\<user>\AppData\Roaming\Aira`).
/// Falls back to `%USERPROFILE%\.aira` if APPDATA is not set.
pub fn aira_dir() -> Result<std::path::PathBuf, String> {
    let dir = if let Ok(appdata) = std::env::var("APPDATA") {
        std::path::PathBuf::from(appdata).join("Aira")
    } else if let Ok(userprofile) = std::env::var("USERPROFILE") {
        std::path::PathBuf::from(userprofile).join(".aira")
    } else {
        return Err("no APPDATA or USERPROFILE directory".to_string());
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Returns the user's home directory on Windows.
pub fn home_dir() -> Result<String, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOMEDRIVE").and_then(|d| {
            std::env::var("HOMEPATH").map(|p| format!("{d}{p}"))
        }))
        .map_err(|_| "no USERPROFILE directory".to_string())
}
