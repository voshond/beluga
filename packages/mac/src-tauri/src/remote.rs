//! Run Beluga here, or connect to a Beluga server: which one, the server's address and this
//! device's name, kept in the app's config dir (client.json). Server mode starts no daemon; the
//! window opens connect.html, which reaches the server or says why it can't.

use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};

pub const PAGE: &str = "connect.html";
const FILE: &str = "client.json";
const NAME_MAX: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Server,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ServerUrl {
    pub origin: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    mode: Option<Mode>,
    server_url: Option<String>,
    device_name: String,
    default_device_name: String,
}

pub struct ClientState {
    dir: PathBuf,
}

/// Where Tauri keeps this app's config (its `app_config_dir`), known before the app is built.
pub fn config_dir(identifier: &str) -> PathBuf {
    dirs::config_dir().unwrap_or_default().join(identifier)
}

pub fn load(dir: &Path) -> ClientConfig {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, config: &ClientConfig) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("Beluga couldn't save its settings: {e}");
    std::fs::create_dir_all(dir).map_err(fail)?;
    let body = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, body).map_err(fail)?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(fail)
}

impl ClientState {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn config(&self) -> ClientConfig {
        load(&self.dir)
    }

    pub fn mode(&self) -> Option<Mode> {
        self.config().mode
    }

    /// The mode to start in. An app that ran before this setting existed keeps running Beluga here;
    /// a fresh install asks. Either is written down at once, so the answer never changes by itself.
    pub fn starting_mode(&self) -> Option<Mode> {
        if self.dir.join(FILE).exists() {
            return self.mode();
        }
        let config = ClientConfig {
            mode: self.dir.exists().then_some(Mode::Local),
            ..ClientConfig::default()
        };
        let _ = save(&self.dir, &config);
        config.mode
    }

    fn update(&self, change: impl FnOnce(&mut ClientConfig)) -> Result<(), String> {
        let mut config = self.config();
        change(&mut config);
        save(&self.dir, &config)
    }
}

fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return ip.is_loopback();
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<Ipv6Addr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// An https address, or plain http only on this computer (an SSH tunnel): the rule the web port
/// itself follows (src/daemon/web-access.ts). Without a scheme, https is meant.
pub fn check_url(raw: &str) -> Result<ServerUrl, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter your Beluga server's address.".into());
    }
    let full = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let not_url = || "That isn't a web address. Try https://your-server.your-tailnet.ts.net".to_string();
    let url = Url::parse(&full).map_err(|_| not_url())?;
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or_else(not_url)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address: you sign in on the server's page.".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        "http" => return Err("Use an https:// address. Plain http:// is only for 127.0.0.1 or localhost, through an SSH tunnel.".into()),
        _ => return Err("Only https:// addresses work (or http://127.0.0.1 through an SSH tunnel).".into()),
    }
    Ok(ServerUrl {
        origin: url.origin().ascii_serialization(),
        url: url.to_string(),
    })
}

pub fn check_device_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Give this device a name, so agents can tell it apart.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("Keep the device name under {NAME_MAX} characters."));
    }
    if name.chars().any(char::is_control) {
        return Err("The device name can't hold line breaks or tabs.".into());
    }
    Ok(name.to_string())
}

/// This computer's name, without the `.local` a Mac adds.
pub fn hostname() -> String {
    #[cfg(unix)]
    let name = {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer's own length is passed, and the call writes at most that much.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        ok.then(|| String::from_utf8_lossy(&buf[..end]).into_owned())
    };
    #[cfg(not(unix))]
    let name = std::env::var("COMPUTERNAME").ok();
    let name = name.unwrap_or_default();
    let name = name.trim().trim_end_matches(".local");
    if name.is_empty() {
        "This computer".into()
    } else {
        name.into()
    }
}

/// Whether anything answers at the server's address (a TCP connection, five seconds at most).
pub async fn reachable(origin: &str) -> Result<(), String> {
    let url = Url::parse(origin).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    tauri::async_runtime::spawn_blocking(move || {
        let addrs = (host.as_str(), port).to_socket_addrs().map_err(|_| {
            format!("{host} can't be found. Check the address, and that this computer is on the server's network (Tailscale, VPN).")
        })?;
        for addr in addrs {
            if TcpStream::connect_timeout(&addr, Duration::from_secs(5)).is_ok() {
                return Ok(());
            }
        }
        Err(format!(
            "Nothing answers at {host}:{port}. Is the server on, and is `beluga web` running there?"
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Beluga's window is gone.".to_string())
}

fn open(app: &AppHandle, url: &str) -> Result<(), String> {
    let url = Url::parse(url).map_err(|e| e.to_string())?;
    main_window(app)?.navigate(url).map_err(|e| e.to_string())
}

/// Running Beluga here: what asks the daemon refuses in server mode, so it is never started there.
pub fn require_local(app: &AppHandle) -> Result<(), String> {
    match app.state::<ClientState>().mode() {
        Some(Mode::Server) => Err("This app connects to a Beluga server and runs none here.".into()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn client_config(state: tauri::State<'_, ClientState>) -> ClientView {
    let config = state.config();
    let default_device_name = hostname();
    ClientView {
        mode: config.mode,
        server_url: config.server_url,
        device_name: config.device_name.unwrap_or_else(|| default_device_name.clone()),
        default_device_name,
    }
}

/// Connect to this server from now on, once it answers, and open it (a join link opens as given).
#[tauri::command]
pub async fn client_use_server(
    app: AppHandle,
    url: String,
    device_name: String,
) -> Result<(), String> {
    let server = check_url(&url)?;
    let name = check_device_name(&device_name)?;
    reachable(&server.origin).await?;
    app.state::<ClientState>().update(|config| {
        config.mode = Some(Mode::Server);
        config.server_url = Some(server.origin.clone());
        config.device_name = Some(name);
    })?;
    open(&app, &server.url)
}

/// Open the saved server, or say why it can't be reached.
#[tauri::command]
pub async fn client_open(app: AppHandle) -> Result<(), String> {
    let saved = app.state::<ClientState>().config().server_url;
    let server = check_url(saved.as_deref().unwrap_or_default())?;
    reachable(&server.origin).await?;
    open(&app, &server.origin)
}

/// Run Beluga here from now on: the app's own screens, and its daemon.
#[tauri::command]
pub async fn client_use_local(app: AppHandle) -> Result<(), String> {
    app.state::<ClientState>()
        .update(|config| config.mode = Some(Mode::Local))?;
    let window = main_window(&app)?;
    let mut home = window.url().map_err(|e| e.to_string())?;
    home.set_path("/");
    home.set_query(None);
    window.navigate(home).map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::daemon::ensure(&handle, &[]).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("beluga-remote-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn https_and_tunnels_pass_and_plain_http_elsewhere_does_not() {
        let ok = check_url(" i9arch.tail1234.ts.net ").unwrap();
        assert_eq!(ok.origin, "https://i9arch.tail1234.ts.net");
        let join = check_url("https://box.example.com/join/abc").unwrap();
        assert_eq!(join.origin, "https://box.example.com");
        assert_eq!(join.url, "https://box.example.com/join/abc");
        assert_eq!(check_url("http://127.0.0.1:7420").unwrap().origin, "http://127.0.0.1:7420");
        assert!(check_url("http://localhost:7420").is_ok());
        assert!(check_url("http://[::1]:7420").is_ok());
        assert!(check_url("http://i9arch:7420").unwrap_err().contains("https://"));
        assert!(check_url("http://192.168.2.125").unwrap_err().contains("https://"));
        assert!(check_url("ftp://box.example.com").unwrap_err().contains("Only https"));
        assert!(check_url("https://me:pw@box.example.com").unwrap_err().contains("sign in"));
        assert!(check_url("").unwrap_err().contains("Enter"));
        assert!(check_url("https://").is_err());
    }

    #[test]
    fn device_names_are_short_single_lines() {
        assert_eq!(check_device_name("  arch ").unwrap(), "arch");
        assert!(check_device_name(" ").is_err());
        assert!(check_device_name("a\tb").is_err());
        assert!(check_device_name(&"x".repeat(65)).is_err());
        assert!(!hostname().is_empty());
    }

    #[test]
    fn a_fresh_install_asks_and_an_older_one_runs_here() {
        let fresh = temp("fresh");
        let state = ClientState::new(fresh.clone());
        assert_eq!(state.starting_mode(), None);
        assert_eq!(state.starting_mode(), None);

        let older = temp("older");
        std::fs::create_dir_all(&older).unwrap();
        assert_eq!(ClientState::new(older.clone()).starting_mode(), Some(Mode::Local));

        state
            .update(|c| {
                c.mode = Some(Mode::Server);
                c.server_url = Some("https://box.example.com".into());
            })
            .unwrap();
        let again = ClientState::new(fresh.clone());
        assert_eq!(again.starting_mode(), Some(Mode::Server));
        assert_eq!(again.config().server_url.as_deref(), Some("https://box.example.com"));
        let _ = std::fs::remove_dir_all(fresh);
        let _ = std::fs::remove_dir_all(older);
    }
}
