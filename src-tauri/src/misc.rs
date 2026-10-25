use crate::util::*;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn open_url(url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    open::that(&url).map_err(err)
}

#[tauri::command]
pub fn open_data_folder() -> CmdResult<()> {
    open::that(&paths().root).map_err(err)
}

#[tauri::command]
pub fn open_launcher_folder() -> CmdResult<()> {
    open::that(exe_dir().ok_or("Can't find the launcher's folder")?).map_err(err)
}

#[tauri::command]
pub fn data_folder() -> String {
    paths().root.to_string_lossy().into()
}

#[tauri::command]
pub async fn pick_file(app: AppHandle, title: String, extensions: Vec<String>) -> Option<String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let mut d = app.dialog().file().set_title(title);
    if !exts.is_empty() {
        d = d.add_filter("Supported files", &exts);
    }
    d.blocking_pick_file().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: String) -> Option<String> {
    app.dialog().file().set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into())
}

#[tauri::command]
pub async fn pick_save(app: AppHandle, title: String, default_name: String, extension: String) -> Option<String> {
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(sanitize_file_name(&default_name))
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into())
}
