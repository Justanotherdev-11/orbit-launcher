use crate::launch::Running;
use crate::tasks::Task;
use crate::util::*;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PackInfo {
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub group: String,
    pub mc_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub created: i64,
    pub last_played: Option<i64>,
    pub playtime: u64,
    pub memory_mb: Option<u32>,
    pub jvm_args: Option<String>,
    pub java_path: Option<String>,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub accent: String,
    pub icon: Option<String>,
    pub pack: Option<PackInfo>,
    /// Prism-style custom commands and environment variables (KEY=VALUE per line).
    pub pre_launch: Option<String>,
    pub wrapper: Option<String>,
    pub post_exit: Option<String>,
    pub env_vars: Option<String>,
}

const ACCENTS: [&str; 6] = ["cyan", "violet", "emerald", "sunset", "rose", "gold"];

pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("Invalid instance id");
    }
    Ok(())
}

pub fn dir(id: &str) -> PathBuf {
    paths().instances.join(id)
}

pub fn game_dir(id: &str) -> PathBuf {
    dir(id).join(".minecraft")
}

pub fn load(id: &str) -> Result<Instance> {
    valid_id(id)?;
    read_json(&dir(id).join("instance.json"))
}

pub fn save(i: &Instance) -> Result<()> {
    valid_id(&i.id)?;
    write_json(&dir(&i.id).join("instance.json"), i)
}

fn new_id(name: &str) -> String {
    let slug = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = if slug.is_empty() { "instance".into() } else { slug.chars().take(32).collect() };
    format!("{slug}-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
}

pub fn all() -> Vec<Instance> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&paths().instances) {
        for e in rd.flatten() {
            if let Ok(i) = read_json::<Instance>(&e.path().join("instance.json")) {
                out.push(i);
            }
        }
    }
    out.sort_by(|a, b| b.last_played.unwrap_or(b.created).cmp(&a.last_played.unwrap_or(a.created)));
    out
}

pub fn unique_name(base: &str) -> String {
    let names: Vec<String> = all().into_iter().map(|i| i.name).collect();
    if !names.iter().any(|n| n == base) {
        return base.to_string();
    }
    (2..).map(|n| format!("{base} ({n})")).find(|c| !names.contains(c)).unwrap()
}

pub fn create(name: &str, mc: &str, loader: &str, lv: Option<String>, icon: Option<String>) -> Result<Instance> {
    let name = if name.trim().is_empty() { "New Instance" } else { name.trim() };
    let inst = Instance {
        id: new_id(name),
        name: name.to_string(),
        mc_version: mc.to_string(),
        loader: if loader.is_empty() { "vanilla".into() } else { loader.to_string() },
        loader_version: lv.filter(|v| !v.is_empty()),
        created: now(),
        accent: ACCENTS[uuid::Uuid::new_v4().as_bytes()[0] as usize % ACCENTS.len()].into(),
        icon,
        ..Default::default()
    };
    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "screenshots"] {
        std::fs::create_dir_all(game_dir(&inst.id).join(sub))?;
    }
    save(&inst)?;
    Ok(inst)
}

fn ensure_not_running(app: &AppHandle, id: &str) -> Result<()> {
    if app.state::<Running>().0.lock().unwrap().contains_key(id) {
        bail!("Stop the game first");
    }
    Ok(())
}

#[tauri::command]
pub fn list_instances() -> Vec<Instance> {
    all()
}

#[tauri::command]
pub fn get_instance(id: String) -> CmdResult<Instance> {
    load(&id).map_err(err)
}

#[tauri::command]
pub fn create_instance(
    name: String,
    mc_version: String,
    loader: String,
    loader_version: Option<String>,
    group: Option<String>,
    accent: Option<String>,
) -> CmdResult<Instance> {
    let mut i = create(&name, &mc_version, &loader, loader_version, None).map_err(err)?;
    if let Some(g) = group {
        i.group = g.trim().to_string();
    }
    if let Some(a) = accent.filter(|a| !a.is_empty()) {
        i.accent = a;
    }
    save(&i).map_err(err)?;
    Ok(i)
}

/// Save user-editable fields; bookkeeping (playtime, created, pack) is preserved from disk.
#[tauri::command]
pub fn update_instance(instance: Instance) -> CmdResult<Instance> {
    let mut cur = load(&instance.id).map_err(err)?;
    let version_changed = cur.mc_version != instance.mc_version || cur.loader != instance.loader;
    cur.name = if instance.name.trim().is_empty() { cur.name } else { instance.name.trim().to_string() };
    cur.group = instance.group.trim().to_string();
    cur.mc_version = instance.mc_version;
    cur.loader = instance.loader;
    cur.loader_version = instance.loader_version.filter(|v| !v.is_empty());
    if version_changed && instance.pack.is_none() {
        cur.pack = None;
    }
    cur.memory_mb = instance.memory_mb;
    cur.jvm_args = instance.jvm_args.filter(|v| !v.trim().is_empty());
    cur.java_path = instance.java_path.filter(|v| !v.trim().is_empty());
    cur.window_width = instance.window_width;
    cur.window_height = instance.window_height;
    cur.accent = instance.accent;
    let blank = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    cur.pre_launch = blank(instance.pre_launch);
    cur.wrapper = blank(instance.wrapper);
    cur.post_exit = blank(instance.post_exit);
    cur.env_vars = blank(instance.env_vars);
    save(&cur).map_err(err)?;
    Ok(cur)
}

/// Copy an image into the instance folder and use it as the icon (`None` resets to the generated art).
#[tauri::command]
pub fn set_instance_icon(id: String, path: Option<String>) -> CmdResult<Instance> {
    let mut inst = load(&id).map_err(err)?;
    for old in ["icon.png", "icon.jpg", "icon.jpeg", "icon.gif", "icon.webp"] {
        let _ = std::fs::remove_file(dir(&id).join(old));
    }
    inst.icon = match path {
        Some(p) => {
            let src = PathBuf::from(&p);
            let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
                return Err("Pick a PNG, JPG, GIF or WebP image".into());
            }
            let dest = dir(&id).join(format!("icon.{ext}"));
            std::fs::copy(&src, &dest).map_err(err)?;
            Some(dest.to_string_lossy().into())
        }
        None => None,
    };
    save(&inst).map_err(err)?;
    Ok(inst)
}

#[tauri::command]
pub fn delete_instance(app: AppHandle, id: String) -> CmdResult<()> {
    valid_id(&id).map_err(err)?;
    ensure_not_running(&app, &id).map_err(err)?;
    std::fs::remove_dir_all(dir(&id)).map_err(err)
}

#[tauri::command]
pub async fn duplicate_instance(app: AppHandle, id: String) -> CmdResult<Instance> {
    let src = load(&id).map_err(err)?;
    let task = std::sync::Arc::new(Task::new(&app, format!("Copying {}", src.name)));
    let mut copy = src.clone();
    copy.id = new_id(&src.name);
    copy.name = unique_name(&format!("{} copy", src.name));
    copy.created = now();
    copy.last_played = None;
    copy.playtime = 0;
    let (from, to) = (dir(&src.id), dir(&copy.id));
    let total = count_files(&from).max(1);
    let t2 = task.clone();
    let r = tokio::task::spawn_blocking(move || {
        let mut n = 0;
        copy_dir(&from, &to, &mut || {
            n += 1;
            t2.progress("Copying files", n, total);
        })
    })
    .await
    .map_err(err)?;
    if let Err(e) = r {
        let _ = std::fs::remove_dir_all(dir(&copy.id));
        task.fail(&e.to_string());
        return Err(err(e));
    }
    let (old_dir, new_dir) = (dir(&src.id).to_string_lossy().to_string(), dir(&copy.id).to_string_lossy().to_string());
    copy.icon = copy.icon.map(|i| i.replace(&old_dir, &new_dir));
    save(&copy).map_err(err)?;
    task.done("Copied");
    Ok(copy)
}

#[tauri::command]
pub fn open_instance_folder(id: String, sub: Option<String>) -> CmdResult<()> {
    valid_id(&id).map_err(err)?;
    let mut p = game_dir(&id);
    if let Some(s) = sub.filter(|s| !s.is_empty()) {
        p = safe_join(&p, &s).ok_or("Bad path")?;
    }
    std::fs::create_dir_all(&p).map_err(err)?;
    open::that(&p).map_err(err)
}

#[tauri::command]
pub fn get_notes(id: String) -> CmdResult<String> {
    valid_id(&id).map_err(err)?;
    Ok(std::fs::read_to_string(dir(&id).join("notes.md")).unwrap_or_default())
}

#[tauri::command]
pub fn save_notes(id: String, notes: String) -> CmdResult<()> {
    valid_id(&id).map_err(err)?;
    std::fs::write(dir(&id).join("notes.md"), notes).map_err(err)
}
