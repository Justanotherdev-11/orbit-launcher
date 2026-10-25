use crate::util::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub memory_mb: u32,
    pub java_path: String,
    pub jvm_args: String,
    pub curseforge_key: String,
    pub ms_client_id: String,
    pub hide_on_launch: bool,
    pub show_snapshots: bool,
    pub accent: String,
    pub reduce_motion: bool,
    pub game_width: u32,
    pub game_height: u32,
    pub fullscreen: bool,
    pub parallel_downloads: u32,
    /// Free-form UI preferences owned by the front end (theme, layout, motion, …).
    pub ui: serde_json::Value,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            memory_mb: 4096,
            java_path: String::new(),
            jvm_args: String::new(),
            curseforge_key: String::new(),
            ms_client_id: String::new(),
            hide_on_launch: false,
            show_snapshots: false,
            accent: "emerald".into(),
            reduce_motion: false,
            game_width: 0,
            game_height: 0,
            fullscreen: false,
            parallel_downloads: 12,
            ui: serde_json::json!({}),
        }
    }
}

fn path() -> PathBuf {
    paths().root.join("settings.json")
}

/// Optional keys shipped next to the exe so a shared copy works out of the box.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SharedDefaults {
    curseforge_key: String,
    ms_client_id: String,
}

const DEFAULTS_FILE: &str = "orbit-defaults.json";

fn shared_defaults() -> SharedDefaults {
    exe_dir().and_then(|d| read_json(&d.join(DEFAULTS_FILE)).ok()).unwrap_or_default()
}

pub fn load() -> Settings {
    let mut s: Settings = read_json(&path()).unwrap_or_default();
    let d = shared_defaults();
    if s.curseforge_key.trim().is_empty() {
        s.curseforge_key = d.curseforge_key;
    }
    if s.ms_client_id.trim().is_empty() {
        s.ms_client_id = d.ms_client_id;
    }
    s
}

#[tauri::command]
pub fn get_settings() -> Settings {
    load()
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> CmdResult<()> {
    crate::net::set_max_parallel(settings.parallel_downloads);
    write_json(&path(), &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    exe_dir: String,
    data_dir: String,
    portable: bool,
    defaults_file: bool,
    in_onedrive: bool,
}

#[tauri::command]
pub fn share_info() -> ShareInfo {
    let exe = exe_dir().unwrap_or_default();
    ShareInfo {
        portable: portable_dir().is_some() && std::env::var_os("ORBIT_DATA_DIR").is_none(),
        defaults_file: exe.join(DEFAULTS_FILE).exists(),
        in_onedrive: exe.to_string_lossy().to_lowercase().contains("onedrive"),
        exe_dir: exe.to_string_lossy().into(),
        data_dir: paths().root.to_string_lossy().into(),
    }
}

/// Write orbit-defaults.json next to the exe so friends get working CurseForge / Microsoft sign-in.
#[tauri::command]
pub fn write_shared_defaults(curseforge: bool, client_id: bool) -> CmdResult<String> {
    let s = load();
    let d = SharedDefaults {
        curseforge_key: if curseforge { s.curseforge_key } else { String::new() },
        ms_client_id: if client_id { s.ms_client_id } else { String::new() },
    };
    let file = exe_dir().ok_or("Can't find the launcher's folder")?.join(DEFAULTS_FILE);
    if d.curseforge_key.is_empty() && d.ms_client_id.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(String::new());
    }
    write_json(&file, &d).map_err(err)?;
    Ok(file.to_string_lossy().into())
}

/// Switch to portable mode: copy instances + settings into OrbitData next to the exe, then restart.
/// Java, game files and downloads aren't copied — they re-download on demand.
#[tauri::command]
pub async fn enable_portable(app: tauri::AppHandle) -> CmdResult<()> {
    let dest = exe_dir().ok_or("Can't find the launcher's folder")?.join(PORTABLE_DIR);
    let src = paths().root.clone();
    let task = std::sync::Arc::new(crate::tasks::Task::new(&app, "Making Orbit portable"));
    let t2 = task.clone();
    let r = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::create_dir_all(&dest)?;
        let total = count_files(&src.join("instances")).max(1);
        let mut n = 0;
        copy_dir(&src.join("instances"), &dest.join("instances"), &mut || {
            n += 1;
            t2.progress("Copying instances", n, total);
        })?;
        if src.join("settings.json").exists() {
            std::fs::copy(src.join("settings.json"), dest.join("settings.json"))?;
        }
        Ok(())
    })
    .await
    .map_err(err)?;
    match r {
        Ok(()) => {
            task.done("Restarting…");
            app.restart();
        }
        Err(e) => {
            task.fail(&e.to_string());
            Err(format!("Couldn't create the portable folder: {e}"))
        }
    }
}

/// Copy a picture into the data folder for use as the launcher background; returns its new path.
#[tauri::command]
pub fn set_background_image(path: String) -> CmdResult<String> {
    let src = PathBuf::from(&path);
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Err("Pick a PNG, JPG, WebP or GIF image".into());
    }
    for old in ["png", "jpg", "jpeg", "webp", "gif"] {
        let _ = std::fs::remove_file(paths().root.join(format!("background.{old}")));
    }
    let dest = paths().root.join(format!("background.{ext}"));
    std::fs::copy(&src, &dest).map_err(err)?;
    Ok(dest.to_string_lossy().into())
}

/// Total physical memory in MB, for the RAM slider.
#[tauri::command]
pub fn system_memory() -> u64 {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            length: u32,
            memory_load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page_file: u64,
            avail_page_file: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended_virtual: u64,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
        }
        let mut s = MemoryStatusEx {
            length: std::mem::size_of::<MemoryStatusEx>() as u32,
            memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page_file: 0,
            avail_page_file: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        if unsafe { GlobalMemoryStatusEx(&mut s) } != 0 {
            return s.total_phys / 1024 / 1024;
        }
    }
    16384
}
