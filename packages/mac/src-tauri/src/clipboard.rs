//! The clipboard's picture as its own bytes (BLG-109). WebKitGTK hands a paste only the clipboard's
//! image/png, so a JPEG, WebP or GIF pastes as an empty "image.png"; here the page reads the type it
//! wants straight from GTK. Elsewhere the web view hands over the real file, so nothing is offered.

use tauri::ipc::Response;
use tauri::AppHandle;

const IMAGE_TYPES: &[&str] = &["image/gif", "image/png", "image/webp", "image/jpeg"];

/// The picture types the clipboard offers that a paste keeps as they are.
#[tauri::command]
pub async fn clipboard_image_types(app: AppHandle) -> Vec<String> {
    offered(app).await.into_iter().filter(|t| IMAGE_TYPES.contains(&t.as_str())).collect()
}

/// The clipboard's picture of type `mime`, as bytes.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle, mime: String) -> Result<Response, String> {
    if !IMAGE_TYPES.contains(&mime.as_str()) {
        return Err(format!("{mime} isn't a picture type Beluga pastes"));
    }
    let bytes = contents(app, mime).await?;
    Ok(Response::new(bytes))
}

/// What GTK's clipboard has for `target`, read on the main thread (where GTK lives).
#[cfg(target_os = "linux")]
async fn request<T: Send + 'static>(app: &AppHandle, target: &str, read: fn(&gtk::SelectionData) -> T) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let target = target.to_owned();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_contents(&gtk::gdk::Atom::intern(&target), move |_, data| {
            let _ = tx.send(read(data));
        });
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
async fn offered(app: AppHandle) -> Vec<String> {
    let atoms = request(&app, "TARGETS", |data| data.targets().unwrap_or_default().iter().map(|a| a.name().to_string()).collect());
    atoms.await.unwrap_or_default()
}

#[cfg(target_os = "linux")]
async fn contents(app: AppHandle, mime: String) -> Result<Vec<u8>, String> {
    let bytes = request(&app, &mime, |data| data.data()).await?;
    if bytes.is_empty() {
        return Err("The clipboard has no such picture now".into());
    }
    Ok(bytes)
}

#[cfg(not(target_os = "linux"))]
async fn offered(_app: AppHandle) -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
async fn contents(_app: AppHandle, _mime: String) -> Result<Vec<u8>, String> {
    Err("The web view reads the clipboard's pictures here".into())
}
