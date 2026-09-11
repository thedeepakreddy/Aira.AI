//! Shared supervision boundaries for the three local runtimes.
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub fn prepare(command: &mut Command) {
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
    fn gateway_requires_tls_except_loopback() {
        assert!(validate_gateway("https://aira.example").is_ok());
        assert!(validate_gateway("http://localhost:8787").is_ok());
        assert!(validate_gateway("http://example.com").is_err());
        assert!(validate_gateway("https://user:secret@example.com").is_err());
        assert!(validate_gateway("file:///tmp/gateway").is_err());
    }
}
