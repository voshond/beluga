//! The call on the sharer's own screen (BLG-717). While you share your screen and you're in
//! another app, a see-through window covers that screen: a soft frame that says it's on show, the
//! others' sketches, pointers and clicks where they made them, and what they write in the chat,
//! bottom right. Clicks and keys go straight through it to the app under it.
//!
//! The window decides what it shows (it hands over the whole state, or none to hide it); this side
//! only owns the window: which screen it covers, that it floats over everything, that it never
//! takes the mouse, and that it asks macOS to leave it out of screen captures.

use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "call-overlay";

/// What the overlay shows now, and the size of the picture being shared (to find its screen).
#[derive(Debug, Default)]
pub struct CallOverlayState(pub Mutex<Option<serde_json::Value>>);

/// The screen whose size (in pixels) is closest to the shared picture's; else the main one.
fn screen_for<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors
        .into_iter()
        .min_by(|a, b| {
            let d = |m: &tauri::Monitor| {
                let s = m.size();
                (f64::from(s.width) - width).abs() + (f64::from(s.height) - height).abs()
            };
            d(a).total_cmp(&d(b))
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn place<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let (Some(window), Some(m)) = (
        app.get_webview_window(LABEL),
        screen_for(app, width, height),
    ) else {
        return;
    };
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    let _ = window.set_position(LogicalPosition::new(pos.x, pos.y));
    let _ = window.set_size(LogicalSize::new(size.width, size.height));
}

fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(false);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Beluga")
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
        .focusable(false)
        .visible(false);
    let window = builder.build()?;
    // The mouse and keyboard go through to whatever is under it.
    let _ = window.set_ignore_cursor_events(true);
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::popup::float_over_everything(&w);
            leave_out_of_captures(&w);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.remove_menu();
    Ok(true)
}

/// `NSWindowSharingNone`: macOS leaves the window out of screenshots and screen captures, so
/// the others don't get their own ink back in the picture.
#[cfg(target_os = "macos")]
pub(crate) fn leave_out_of_captures<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    let ns = ptr.cast::<AnyObject>();
    if ns.is_null() {
        return;
    }
    // SAFETY: `ns` is this window's live NSWindow, and this runs on the main thread.
    unsafe {
        let _: () = msg_send![ns, setSharingType: 0usize];
    }
}

/// Show the overlay with this state over the screen being shared (`width`×`height` pixels), or
/// hide it (`None`).
#[tauri::command]
pub fn set_call_overlay(app: AppHandle, state: Option<serde_json::Value>, width: f64, height: f64) {
    if let Some(s) = app.try_state::<CallOverlayState>() {
        *s.0.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state.clone();
    }
    let Some(state) = state else {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = app.emit_to(LABEL, "call-overlay", serde_json::Value::Null);
            let _ = w.hide();
        }
        return;
    };
    let Ok(made) = ensure(&app) else {
        return;
    };
    let _ = app.emit_to(LABEL, "call-overlay", &state);
    if let Some(w) = app.get_webview_window(LABEL) {
        if made || !w.is_visible().unwrap_or(false) {
            place(&app, width, height);
            let _ = w.show();
        }
    }
}

/// What the overlay shows now (asked once it has loaded).
#[tauri::command]
pub fn call_overlay_state(app: AppHandle) -> Option<serde_json::Value> {
    app.try_state::<CallOverlayState>().and_then(|s| {
        s.0.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    })
}
