//! Shared supervision boundaries for the three local runtimes.
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The PATH a login shell would have.
///
/// An app launched from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` and
/// nothing else — not the PATH from the user's shell profile. Every runtime
/// Aira supervises is a Node script whose shebang is `#!/usr/bin/env node`, so
/// with that minimal PATH the spawn dies instantly with
/// `env: node: No such file or directory` and no other explanation. It reads as
/// a broken agent rather than a missing directory, and it only happens in the
/// packaged app: from a terminal it always works.
///
/// Asked once and cached, because it costs a shell startup.
fn login_path() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let from_shell = Command::new("sh")
                .arg("-lc")
                .arg("printf %s \"$PATH\"")
                .output()
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .filter(|path| !path.is_empty());

            let mut parts: Vec<String> = from_shell
                .map(|path| path.split(':').map(str::to_string).collect())
                .unwrap_or_default();

            // The usual homes for a user-installed Node, appended in case the
            // login shell is non-interactive or its profile sets no PATH.
            if let Ok(home) = std::env::var("HOME") {
                for extra in [
                    format!("{home}/.local/bin"),
                    format!("{home}/.npm-global/bin"),
                    format!("{home}/.volta/bin"),
                    format!("{home}/.nvm/versions/node/current/bin"),
                ] {
                    if !parts.contains(&extra) {
                        parts.push(extra);
                    }
                }
            }
            for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
                if !parts.iter().any(|p| p == extra) {
                    parts.push(extra.to_string());
                }
            }
            parts.join(":")
        })
        .clone()
}

pub fn prepare(command: &mut Command) {
    // Without this the child cannot find `node`, and every supervised runtime
    // fails to start in the packaged app while working fine from a terminal.
    command.env("PATH", login_path());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub fn terminate(child: &mut Child) {
    // A process group covers Chrome and shell/tool descendants as well as the
    // Python/Node parent. SIGTERM gives the browser a chance to flush its profile.
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("/bin/kill")
            .args(["-TERM", "--", &group])
            .status();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        // Also terminate descendants that did not exit when their parent did.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &group])
            .stderr(std::process::Stdio::null())
            .status();
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
    fn which_searches_the_path_children_actually_get() {
        // The bug this replaced: npm's global prefix is appended by
        // `login_path` but not exported by the login shell, so a runtime that
        // was installed and runnable was reported as missing.
        let path = login_path();
        if let Ok(home) = std::env::var("HOME") {
            let npm_global = format!("{home}/.npm-global/bin");
            if std::path::Path::new(&npm_global).is_dir() {
                assert!(path.contains(&npm_global), "login_path must include npm's global bin");
            }
        }
        // Whatever it finds must be a real executable file, not a name on a list.
        if let Some(found) = which("node") {
            assert!(is_executable(std::path::Path::new(&found)), "{found} is not executable");
        }
    }

    #[test]
    fn a_directory_is_not_a_binary() {
        assert!(!is_executable(std::path::Path::new("/tmp")));
        assert!(!is_executable(std::path::Path::new("/nonexistent/node")));
    }

    #[test]
    fn gateway_requires_tls_except_loopback() {
        assert!(validate_gateway("https://aira.example").is_ok());
        assert!(validate_gateway("http://localhost:8787").is_ok());
        assert!(validate_gateway("http://example.com").is_err());
        assert!(validate_gateway("https://user:secret@example.com").is_err());
        assert!(validate_gateway("file:///tmp/gateway").is_err());
    }


    /// The packaged app inherits `/usr/bin:/bin:/usr/sbin:/sbin` from Finder.
    /// Every supervised runtime is a Node script, so a PATH without the
    /// directory holding `node` kills the spawn before it prints anything.
    #[test]
    fn prepared_children_can_find_node() {
        let mut command = Command::new("true");
        prepare(&mut command);
        let path = login_path();
        let node = which_node().expect("this machine has no node on any searched path");
        let dir = node.parent().expect("node has a parent directory");
        assert!(
            path.split(':').any(|entry| std::path::Path::new(entry) == dir),
            "PATH given to children ({path}) does not contain {dir:?}, where node lives",
        );
    }

    /// Finds node the way a child's shebang would, across the searched PATH.
    fn which_node() -> Option<std::path::PathBuf> {
        login_path().split(':').find_map(|dir| {
            let candidate = std::path::Path::new(dir).join("node");
            candidate.exists().then_some(candidate)
        })
    }

    #[test]
    fn login_path_always_includes_the_standard_directories() {
        let path = login_path();
        for required in ["/usr/bin", "/bin"] {
            assert!(path.split(':').any(|entry| entry == required), "{required} missing from {path}");
        }
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

/// Finds a binary on the same PATH a spawned child is given.
///
/// A Finder-launched app inherits a minimal PATH — which is how every runtime
/// here managed to be "not installed" while working fine from a terminal.
/// `login_path` solves that for children by asking a login shell and then
/// appending the usual user-install directories.
///
/// This must search that same list, and used to ask `sh -lc command -v`
/// instead. The two disagreed exactly where it hurt: npm's default global
/// prefix is one of the directories `login_path` appends and the login shell
/// does not export, so OpenClaw installed correctly, `prepare` would have let
/// a child execute it, and the app still reported the fleet as not installed.
/// Detection and execution have to consult one list or the answer is a lie.
pub fn which(name: &str) -> Option<String> {
    for dir in login_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = std::path::Path::new(dir).join(name);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// A regular file with an execute bit. A directory named `node` is not node.
fn is_executable(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return meta.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    true
}
