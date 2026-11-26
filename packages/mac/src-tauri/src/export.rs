//! Save as…: a table (or any text the window made) or a picture (a graph) written to a file you pick.
//!
//! The Save panel is shown here, not in the web view, and the file goes only where you chose in
//! it: the window hands over a suggested name and the contents, never a path. In the app as a
//! client (remote.rs) this runs on the computer you sit at, so the file lands there.

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Far past any table Beluga shows; anything bigger isn't an export.
const MAX_BYTES: usize = 64 * 1024 * 1024;
/// Longest suggested name.
const MAX_NAME: usize = 120;

/// A suggested file name with no folders in it ("../x.csv" → "x.csv").
fn clean_name(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let base: String = base.chars().filter(|c| !c.is_control() && *c != ':').take(MAX_NAME).collect();
    let base = base.trim_start_matches('.');
    if base.is_empty() { fallback.to_owned() } else { base.to_owned() }
}

/// Shows the Save panel (starting in Downloads, with the suggested name) and writes `contents`
/// where you chose. The path it went to, or None when you cancelled.
fn save_as(app: &tauri::AppHandle, name: &str, contents: &[u8]) -> Result<Option<String>, String> {
    if contents.len() > MAX_BYTES {
        return Err("It's too big to save".into());
    }
    let mut dialog = app.dialog().file().set_title(format!("Save {name}")).set_file_name(name);
    if let Ok(dir) = app.path().download_dir() {
        dialog = dialog.set_directory(dir);
    }
    if let Some(ext) = name.rsplit_once('.').map(|(_, e)| e.to_owned()).filter(|e| !e.is_empty()) {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn save_export(app: tauri::AppHandle, name: String, contents: String) -> Result<Option<String>, String> {
    save_as(&app, &clean_name(&name, "export.txt"), contents.as_bytes())
}

/// A PNG the window drew (a graph's picture), saved where you pick.
#[tauri::command]
pub async fn save_image(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<Option<String>, String> {
    if !data.starts_with(b"\x89PNG") {
        return Err("That isn't a PNG".into());
    }
    save_as(&app, &clean_name(&name, "picture.png"), &data)
}

#[cfg(test)]
mod tests {
    use super::clean_name;

    #[test]
    fn keeps_only_the_file_name() {
        assert_eq!(clean_name("../../etc/passwd", "export.txt"), "passwd");
        assert_eq!(clean_name("customers.csv", "export.txt"), "customers.csv");
        assert_eq!(clean_name("..hidden.json", "export.txt"), "hidden.json");
        assert_eq!(clean_name("  ", "export.txt"), "export.txt");
        assert_eq!(clean_name("", "picture.png"), "picture.png");
    }
}
