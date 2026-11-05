//! The floating call card (BLG-706): while Beluga isn't the app you're in, the call you're in (or
//! one ringing for you) floats over everything, small, at the top of the screen: who's talking,
//! mute and leave, or join and decline. While you share, it says so and stops it, and you can hide
//! it for that share (the frame around your screen stays). Back in Beluga it goes away; the call
//! lives in its chat.
//!
//! The window decides what the card shows (it hands over the whole state, or none to hide it);
//! this side only owns the floating window, and passes its buttons back to the window.

use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "call-float";
const WIDTH: f64 = 392.0;
const HEIGHT: f64 = 64.0;
const MENU_BAR: f64 = 30.0;
const MARGIN: f64 = 10.0;

/// What the card shows now (kept for when it loads).
#[derive(Debug, Default)]
pub struct CallFloatState(pub Mutex<Option<serde_json::Value>>);

fn place<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = window.set_size(LogicalSize::new(WIDTH, HEIGHT));
    // Top middle of the screen Beluga is on (else the main one), just under the menu bar.
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        let _ = window.set_position(LogicalPosition::new(
            pos.x + (size.width - WIDTH) / 2.0,
            pos.y + MENU_BAR + MARGIN,
        ));
    }
}

fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(false);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("call.html".into()))
        .title("Beluga call")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        // Never the key window: you keep typing in the app you're in while you talk.
        .focusable(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::popup::float_over_everything(&w);
            // Sharing your whole screen, the card stays yours: the others don't see it.
            crate::call_overlay::leave_out_of_captures(&w);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.remove_menu();
    Ok(true)
}

/// Show the card with this state, or hide it (`None`).
#[tauri::command]
pub fn set_call_float(app: AppHandle, state: Option<serde_json::Value>) {
    if let Some(s) = app.try_state::<CallFloatState>() {
        *s.0.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state.clone();
    }
    let Some(state) = state else {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = app.emit_to(LABEL, "call-float", serde_json::Value::Null);
            let _ = w.hide();
        }
        return;
    };
    let Ok(made) = ensure(&app) else {
        return;
    };
    let _ = app.emit_to(LABEL, "call-float", &state);
    if let Some(w) = app.get_webview_window(LABEL) {
        if made || !w.is_visible().unwrap_or(false) {
            place(&app);
            let _ = w.show();
        }
    }
}

/// What the card shows now (asked once it has loaded).
#[tauri::command]
pub fn call_float_state(app: AppHandle) -> Option<serde_json::Value> {
    app.try_state::<CallFloatState>().and_then(|s| {
        s.0.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    })
}

/// A button on the card: the window does it (Open and Join also bring Beluga forward).
#[tauri::command]
pub fn call_float_action(
    app: AppHandle,
    action: String,
    conversation: String,
) -> Result<(), String> {
    if !matches!(
        action.as_str(),
        "mute" | "unmute" | "leave" | "join" | "decline" | "open" | "stop-sharing" | "hide"
    ) {
        return Err(format!("Unknown action {action}"));
    }
    if action == "open" || action == "join" {
        crate::focus_main(&app);
    }
    app.emit_to(
        "main",
        "call-float-action",
        serde_json::json!({ "action": action, "conversation": conversation }),
    )
    .map_err(|e| e.to_string())
}
