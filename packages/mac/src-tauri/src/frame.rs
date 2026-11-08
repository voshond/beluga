use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, Webview, WebviewWindow};

const MAIN: &str = "main";

#[tauri::command]
pub fn own_title_bar(window: WebviewWindow) {
    if !cfg!(target_os = "linux") || window.label() != MAIN {
        return;
    }
    let _ = window.set_decorations(false);
    let _ = window.remove_menu();
}

#[tauri::command]
pub fn window_control(window: WebviewWindow, action: String) -> Result<(), String> {
    let done = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        "maximize" => window.maximize(),
        "close" => window.close(),
        other => return Err(format!("No window action {other}")),
    };
    done.map_err(|e| e.to_string())
}

pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !cfg!(target_os = "linux") || payload.event() != PageLoadEvent::Started || webview.label() != MAIN {
        return;
    }
    let window = webview.window();
    if window.is_decorated().unwrap_or(true) {
        return;
    }
    let _ = window.set_decorations(true);
    if let Some(menu) = webview.app_handle().menu() {
        let _ = window.set_menu(menu);
    }
}
