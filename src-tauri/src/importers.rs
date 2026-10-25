//! Import instances from other launchers — or from any folder that looks like Minecraft.
//!
//! Recognised: Prism / PolyMC / MultiMC, CurseForge app, Modrinth App (old and new),
//! ATLauncher, GDLauncher (Carbon and legacy) and the official Minecraft Launcher.
use crate::instances::{self, Instance};
use crate::loaders;
use crate::tasks::Task;
use crate::util::*;
use crate::versions;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExternalInstance {
    pub launcher: String,
    /// The instance's own folder (used for icons/notes).
    pub path: String,
    /// The folder that holds mods/, saves/, config/ …
    pub game_dir: String,
    pub name: String,
    /// Empty when it couldn't be worked out; the UI asks.
    pub mc_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub mods: usize,
    pub worlds: usize,
    /// The official launcher shares one .minecraft between profiles, so only user content is copied.
    pub shared: bool,
    pub icon: Option<String>,
    pub notes: Option<String>,
    /// True when the version/loader were guessed from the mods rather than read from metadata.
    pub guessed: bool,
}

fn count(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|r| r.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).count()).unwrap_or(0)
}

fn finish(mut e: ExternalInstance) -> ExternalInstance {
    let g = PathBuf::from(&e.game_dir);
    e.mods = count(&g.join("mods"));
    e.worlds = count(&g.join("saves"));
    if e.loader.is_empty() {
        e.loader = "vanilla".into();
    }
    e
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn first_child<'a>(dir: &Path, names: &[&'a str]) -> Option<PathBuf> {
    names.iter().map(|n| dir.join(n)).find(|p| p.exists())
}

// ---------------------------------------------------------------- per-launcher parsers

fn prism(dir: &Path, launcher: &str) -> Option<ExternalInstance> {
    let cfg = std::fs::read_to_string(dir.join("instance.cfg")).ok()?;
    let pack: Value = read_json(&dir.join("mmc-pack.json")).ok()?;
    let field = |k: &str| cfg.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(|v| v.trim().to_string());
    let mut e = ExternalInstance { launcher: launcher.into(), path: dir.to_string_lossy().into(), name: field("name").unwrap_or_else(|| "Imported".into()), ..Default::default() };
    for c in pack["components"].as_array()? {
        let v = s(&c["version"]);
        match c["uid"].as_str().unwrap_or_default() {
            "net.minecraft" => e.mc_version = v,
            "net.fabricmc.fabric-loader" => (e.loader, e.loader_version) = ("fabric".into(), Some(v)),
            "org.quiltmc.quilt-loader" => (e.loader, e.loader_version) = ("quilt".into(), Some(v)),
            "net.neoforged" => (e.loader, e.loader_version) = ("neoforge".into(), Some(v)),
            "net.minecraftforge" => (e.loader, e.loader_version) = ("forge".into(), Some(v)),
            _ => {}
        }
    }
    if e.loader == "forge" {
        e.loader_version = e.loader_version.map(|v| format!("{}-{v}", e.mc_version));
    }
    e.game_dir = first_child(dir, &[".minecraft", "minecraft"]).unwrap_or_else(|| dir.join(".minecraft")).to_string_lossy().into();
    e.notes = field("notes").map(|n| n.replace("\\n", "\n")).filter(|n| !n.is_empty());
    Some(finish(e))
}

/// "fabric-0.15.7-1.20.1", "forge-47.2.0", "neoforge-21.1.65", "quilt-0.26.0-1.20.1"
fn loader_from_dashed(id: &str, mc: &str) -> (String, Option<String>) {
    let mut parts = id.splitn(2, '-');
    let kind = parts.next().unwrap_or_default().to_lowercase();
    let rest = parts.next().unwrap_or_default();
    let ver = rest.strip_suffix(&format!("-{mc}")).unwrap_or(rest).to_string();
    match kind.as_str() {
        "forge" => ("forge".into(), Some(if ver.starts_with(&format!("{mc}-")) { ver } else { format!("{mc}-{ver}") })),
        "fabric" | "quilt" | "neoforge" => (kind, Some(ver).filter(|v| !v.is_empty())),
        _ => ("vanilla".into(), None),
    }
}

fn curseforge(dir: &Path) -> Option<ExternalInstance> {
    let j: Value = read_json(&dir.join("minecraftinstance.json")).ok()?;
    let mc = s(&j["gameVersion"]);
    let (loader, lv) = loader_from_dashed(&s(&j["baseModLoader"]["name"]), &mc);
    let icon = j["profileImagePath"].as_str().filter(|p| Path::new(p).exists()).map(String::from);
    Some(finish(ExternalInstance {
        launcher: "CurseForge".into(),
        path: dir.to_string_lossy().into(),
        game_dir: dir.to_string_lossy().into(),
        name: j["name"].as_str().map(String::from).unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into()),
        mc_version: mc,
        loader,
        loader_version: lv,
        icon,
        ..Default::default()
    }))
}

fn atlauncher(dir: &Path) -> Option<ExternalInstance> {
    let j: Value = read_json(&dir.join("instance.json")).ok()?;
    let l = j.get("launcher")?;
    let mc = j["id"].as_str().or(j["minecraftVersion"].as_str()).unwrap_or_default().to_string();
    let kind = s(&l["loaderVersion"]["type"]).to_lowercase();
    let ver = s(&l["loaderVersion"]["version"]);
    let (loader, lv) = match kind.as_str() {
        "forge" => ("forge".to_string(), Some(if ver.starts_with(&format!("{mc}-")) { ver } else { format!("{mc}-{ver}") })),
        "fabric" | "quilt" | "neoforge" => (kind, Some(ver).filter(|v| !v.is_empty())),
        _ => ("vanilla".to_string(), None),
    };
    Some(finish(ExternalInstance {
        launcher: "ATLauncher".into(),
        path: dir.to_string_lossy().into(),
        game_dir: dir.to_string_lossy().into(),
        name: l["name"].as_str().map(String::from).unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into()),
        mc_version: mc,
        loader,
        loader_version: lv,
        ..Default::default()
    }))
}

fn gdlauncher(dir: &Path) -> Option<ExternalInstance> {
    let folder_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    // GDLauncher Carbon: instance.json + instance/ game folder.
    if let Ok(j) = read_json::<Value>(&dir.join("instance.json")) {
        let ver = &j["game_configuration"]["version"];
        if ver.is_object() {
            let mc = s(&ver["release"]);
            let ml = &ver["modloaders"][0];
            let kind = s(&ml["type_"]).to_lowercase();
            let lv = s(&ml["version"]);
            let (loader, lv) = match kind.as_str() {
                "" => ("vanilla".into(), None),
                "forge" => ("forge".into(), Some(if lv.starts_with(&format!("{mc}-")) { lv } else { format!("{mc}-{lv}") })),
                k => (k.to_string(), Some(lv).filter(|v| !v.is_empty())),
            };
            return Some(finish(ExternalInstance {
                launcher: "GDLauncher".into(),
                path: dir.to_string_lossy().into(),
                game_dir: dir.join("instance").to_string_lossy().into(),
                name: j["name"].as_str().map(String::from).unwrap_or(folder_name),
                mc_version: mc,
                loader,
                loader_version: lv,
                ..Default::default()
            }));
        }
    }
    // Legacy GDLauncher: config.json in the game folder itself.
    let j: Value = read_json(&dir.join("config.json")).ok()?;
    let l = j.get("loader")?;
    let mc = s(&l["mcVersion"]);
    let kind = s(&l["loaderType"]).to_lowercase();
    let lv = s(&l["loaderVersion"]);
    let (loader, lv) = match kind.as_str() {
        "forge" => ("forge".into(), Some(if lv.starts_with(&format!("{mc}-")) { lv } else { format!("{mc}-{lv}") })),
        "fabric" | "quilt" | "neoforge" => (kind, Some(lv).filter(|v| !v.is_empty())),
        _ => ("vanilla".into(), None),
    };
    Some(finish(ExternalInstance {
        launcher: "GDLauncher".into(),
        path: dir.to_string_lossy().into(),
        game_dir: dir.to_string_lossy().into(),
        name: folder_name,
        mc_version: mc,
        loader,
        loader_version: lv,
        ..Default::default()
    }))
}

/// Old Modrinth App (theseus) kept a profile.json in each profile folder.
fn modrinth_profile_json(dir: &Path) -> Option<ExternalInstance> {
    let j: Value = read_json(&dir.join("profile.json")).ok()?;
    let m = j.get("metadata")?;
    let loader = s(&m["loader"]).to_lowercase();
    let mc = s(&m["game_version"]);
    let lv = m["loader_version"]["id"].as_str().map(String::from);
    Some(finish(ExternalInstance {
        launcher: "Modrinth App".into(),
        path: dir.to_string_lossy().into(),
        game_dir: dir.to_string_lossy().into(),
        name: m["name"].as_str().map(String::from).unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into()),
        loader_version: if loader == "forge" { lv.map(|v| if v.starts_with(&format!("{mc}-")) { v } else { format!("{mc}-{v}") }) } else { lv },
        mc_version: mc,
        loader,
        icon: m["icon"].as_str().filter(|p| Path::new(p).exists()).map(String::from),
        ..Default::default()
    }))
}

/// New Modrinth App keeps profiles in an SQLite database.
fn modrinth_db(root: &Path) -> Vec<ExternalInstance> {
    let db = root.join("app.db");
    let Ok(conn) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else { return vec![] };
    let Ok(mut stmt) = conn.prepare("SELECT * FROM profiles") else { return vec![] };
    let cols: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let col = |row: &rusqlite::Row, name: &str| -> String {
        cols.iter().position(|c| c == name).and_then(|i| row.get::<_, Option<String>>(i).ok().flatten()).unwrap_or_default()
    };
    let rows = stmt.query_map([], |row| {
        Ok((col(row, "path"), col(row, "name"), col(row, "game_version"), col(row, "mod_loader"), col(row, "mod_loader_version"), col(row, "icon_path")))
    });
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .filter_map(|(path, name, mc, loader, lv, icon)| {
            let dir = root.join("profiles").join(&path);
            if !dir.exists() {
                return None;
            }
            let loader = loader.to_lowercase();
            let lv = Some(lv).filter(|v| !v.is_empty());
            Some(finish(ExternalInstance {
                launcher: "Modrinth App".into(),
                path: dir.to_string_lossy().into(),
                game_dir: dir.to_string_lossy().into(),
                name: if name.is_empty() { path } else { name },
                loader_version: if loader == "forge" { lv.map(|v| if v.starts_with(&format!("{mc}-")) { v } else { format!("{mc}-{v}") }) } else { lv },
                mc_version: mc,
                loader,
                icon: Some(icon).filter(|p| !p.is_empty() && Path::new(p).exists()),
                ..Default::default()
            }))
        })
        .collect()
}

/// lastVersionId from launcher_profiles.json -> (mc, loader, loader version)
fn official_version(id: &str, known: &Known) -> (String, String, Option<String>) {
    if id == "latest-release" {
        return (known.release.clone(), "vanilla".into(), None);
    }
    if id == "latest-snapshot" {
        return (known.snapshot.clone(), "vanilla".into(), None);
    }
    // Real Minecraft ids like "1.21-pre1" or "1.20.5-rc2" contain dashes too.
    if known.ids.contains(id) {
        return (id.into(), "vanilla".into(), None);
    }
    for (prefix, loader) in [("fabric-loader-", "fabric"), ("quilt-loader-", "quilt")] {
        if let Some(rest) = id.strip_prefix(prefix) {
            if let Some((lv, mc)) = rest.split_once('-') {
                return (mc.into(), loader.into(), Some(lv.into()));
            }
        }
    }
    if let Some(v) = id.strip_prefix("neoforge-") {
        return (loaders::neoforge_mc(v).unwrap_or_default(), "neoforge".into(), Some(v.into()));
    }
    // "1.20.1-forge-47.2.0" and legacy "1.12.2-forge1.12.2-14.23.5.2859"
    // ... and "1.7.10-Forge10.13.4.1614-1.7.10" (capitalised, as old installers wrote it).
    if let Some(i) = id.to_ascii_lowercase().find("-forge") {
        let (mc, v) = (&id[..i], &id[i + "-forge".len()..]);
        let v = v.trim_start_matches('-');
        return (mc.into(), "forge".into(), Some(if v.starts_with(&format!("{mc}-")) { v.to_string() } else { format!("{mc}-{v}") }));
    }
    // "1.20.1-OptiFine_HD_U_I6" and plain vanilla ids.
    (id.split('-').next().unwrap_or(id).into(), "vanilla".into(), None)
}

/// Version ids from Mojang's manifest, used to read the official launcher's profiles.
#[derive(Default)]
struct Known {
    release: String,
    snapshot: String,
    ids: std::collections::HashSet<String>,
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

fn official(root: &Path, latest: &Known) -> Vec<ExternalInstance> {
    let Ok(j) = read_json::<Value>(&root.join("launcher_profiles.json")) else { return vec![] };
    let mut out = vec![];
    for (_, p) in j["profiles"].as_object().into_iter().flatten() {
        let id = s(&p["lastVersionId"]);
        if id.is_empty() {
            continue;
        }
        let (mc, loader, lv) = official_version(&id, latest);
        let game_dir = p["gameDir"].as_str().map(PathBuf::from).unwrap_or_else(|| root.to_path_buf());
        let name = match (s(&p["name"]).as_str(), s(&p["type"]).as_str()) {
            ("", "latest-release") => "Latest release".to_string(),
            ("", "latest-snapshot") => "Latest snapshot".to_string(),
            ("", _) => id.clone(),
            (n, _) => n.to_string(),
        };
        out.push(finish(ExternalInstance {
            launcher: "Minecraft Launcher".into(),
            path: game_dir.to_string_lossy().into(),
            shared: same_dir(&game_dir, root),
            game_dir: game_dir.to_string_lossy().into(),
            name,
            mc_version: mc,
            loader,
            loader_version: lv,
            ..Default::default()
        }));
    }
    out
}

// ---------------------------------------------------------------- guessing from mods

fn version_in(text: &str) -> Option<String> {
    // First "1.x[.y]" or year-style "2x.y[.z]" in a dependency string like "~1.20.1" or "[1.20.1,1.21)".
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != '.') {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == '.') {
                i += 1;
            }
            let cand: String = bytes[start..i].iter().collect::<String>().trim_end_matches('.').to_string();
            let parts: Vec<&str> = cand.split('.').collect();
            let ok = parts.len() >= 2 && (parts[0] == "1" || parts[0].parse::<u32>().map(|n| (25..60).contains(&n)).unwrap_or(false));
            if ok {
                return Some(cand);
            }
        }
        i += 1;
    }
    None
}

/// Work out loader + Minecraft version by peeking inside mod jars.
fn guess_from_mods(game_dir: &Path) -> (String, String) {
    let mut votes: std::collections::HashMap<&'static str, usize> = Default::default();
    let mut versions: std::collections::HashMap<String, usize> = Default::default();
    let jars = std::fs::read_dir(game_dir.join("mods")).into_iter().flatten().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".jar")).take(60);
    for e in jars {
        let Ok(f) = std::fs::File::open(e.path()) else { continue };
        let Ok(mut z) = zip::ZipArchive::new(f) else { continue };
        let mut read = |name: &str| -> Option<String> {
            let mut s = String::new();
            z.by_name(name).ok()?.read_to_string(&mut s).ok()?;
            Some(s)
        };
        let (loader, mc) = if let Some(t) = read("quilt.mod.json") {
            ("quilt", serde_json::from_str::<Value>(&t).ok().and_then(|j| j["quilt_loader"]["depends"].as_array().and_then(|d| d.iter().find(|x| x["id"] == "minecraft").map(|x| x["versions"].to_string()))))
        } else if let Some(t) = read("fabric.mod.json") {
            ("fabric", serde_json::from_str::<Value>(&t.replace(['\n', '\r', '\t'], " ")).ok().map(|j| j["depends"]["minecraft"].to_string()))
        } else if let Some(t) = read("META-INF/neoforge.mods.toml") {
            ("neoforge", t.split("modId=\"minecraft\"").nth(1).or_else(|| t.split("modId = \"minecraft\"").nth(1)).map(|s| s.chars().take(200).collect()))
        } else if let Some(t) = read("META-INF/mods.toml") {
            ("forge", t.split("modId=\"minecraft\"").nth(1).or_else(|| t.split("modId = \"minecraft\"").nth(1)).map(|s| s.chars().take(200).collect()))
        } else {
            continue;
        };
        *votes.entry(loader).or_default() += 1;
        if let Some(v) = mc.as_deref().and_then(version_in) {
            *versions.entry(v).or_default() += 1;
        }
    }
    let loader = votes.into_iter().max_by_key(|(_, n)| *n).map(|(l, _)| l).unwrap_or("vanilla");
    let mc = versions.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| version_cmp(&a.0, &b.0))).map(|(v, _)| v).unwrap_or_default();
    (loader.into(), mc)
}

fn generic(dir: &Path) -> Option<ExternalInstance> {
    let game = first_child(dir, &[".minecraft", "minecraft"]).unwrap_or_else(|| dir.to_path_buf());
    let looks_like_mc = ["mods", "saves", "options.txt", "resourcepacks", "config"].iter().any(|n| game.join(n).exists());
    if !looks_like_mc {
        return None;
    }
    let (loader, mc) = guess_from_mods(&game);
    Some(finish(ExternalInstance {
        launcher: "Folder".into(),
        path: dir.to_string_lossy().into(),
        game_dir: game.to_string_lossy().into(),
        // A bare ".minecraft" is named after the folder it sits in.
        name: [Some(dir), dir.parent()]
            .into_iter()
            .flatten()
            .filter_map(|d| d.file_name().map(|n| n.to_string_lossy().to_string()))
            .find(|n| n != ".minecraft" && n != "minecraft")
            .unwrap_or_else(|| "Imported".into()),
        mc_version: mc,
        loader,
        guessed: true,
        ..Default::default()
    }))
}

/// Identify a single instance folder from any launcher.
fn detect_one(dir: &Path) -> Option<ExternalInstance> {
    if dir.join("instance.cfg").exists() {
        return prism(dir, "Prism / MultiMC");
    }
    if dir.join("minecraftinstance.json").exists() {
        return curseforge(dir);
    }
    if dir.join("instance.json").exists() {
        if let Some(e) = atlauncher(dir).or_else(|| gdlauncher(dir)) {
            return Some(e);
        }
    }
    if dir.join("profile.json").exists() {
        if let Some(e) = modrinth_profile_json(dir) {
            return Some(e);
        }
    }
    if dir.join("config.json").exists() {
        if let Some(e) = gdlauncher(dir) {
            return Some(e);
        }
    }
    generic(dir)
}

fn scan_children(dir: &Path) -> Vec<ExternalInstance> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().filter(|e| e.path().is_dir()).filter_map(|e| detect_one(&e.path())).filter(|e| e.launcher != "Folder" || e.mods + e.worlds > 0).collect()
}

/// Scan a folder the user picked: a launcher's root, its instances folder, or a single instance.
fn scan_folder(dir: &Path, latest: &Known) -> Vec<ExternalInstance> {
    if dir.join("launcher_profiles.json").exists() {
        return official(dir, latest);
    }
    if dir.join("app.db").exists() {
        let found = modrinth_db(dir);
        if !found.is_empty() {
            return found;
        }
    }
    for sub in ["instances", "Instances", "profiles", "data/instances"] {
        let p = dir.join(sub);
        if p.is_dir() {
            let found = scan_children(&p);
            if !found.is_empty() {
                return found;
            }
        }
    }
    if let Some(one) = detect_one(dir) {
        return vec![one];
    }
    scan_children(dir)
}

fn prism_instances_dir(root: &Path, cfg_name: &str) -> PathBuf {
    let cfg = std::fs::read_to_string(root.join(cfg_name)).unwrap_or_default();
    cfg.lines()
        .find_map(|l| l.strip_prefix("InstanceDir="))
        .map(|d| {
            let p = PathBuf::from(d.trim());
            if p.is_absolute() {
                p
            } else {
                root.join(p)
            }
        })
        .unwrap_or_else(|| root.join("instances"))
}

async fn latest_ids() -> Known {
    let list = versions::manifest().await.unwrap_or_default();
    let first = |kind: &str| list.iter().find(|v| v.kind == kind).map(|v| v.id.clone()).unwrap_or_default();
    Known { release: first("release"), snapshot: first("snapshot"), ids: list.iter().map(|v| v.id.clone()).collect() }
}

/// Everything we can find from launchers installed in their default locations.
#[tauri::command]
pub async fn list_external_instances() -> Vec<ExternalInstance> {
    let known = latest_ids().await;
    tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        let (Some(appdata), Some(home)) = (dirs::data_dir(), dirs::home_dir()) else { return out };
        for (app, cfg, label) in [("PrismLauncher", "prismlauncher.cfg", "Prism Launcher"), ("PolyMC", "polymc.cfg", "PolyMC"), ("MultiMC", "multimc.cfg", "MultiMC")] {
            let root = appdata.join(app);
            if root.exists() {
                let dir = prism_instances_dir(&root, cfg);
                out.extend(std::fs::read_dir(&dir).into_iter().flatten().flatten().filter_map(|e| prism(&e.path(), label)));
            }
        }
        for cf in [home.join("curseforge/minecraft/Instances"), home.join("Documents/Curseforge/Minecraft/Instances")] {
            out.extend(std::fs::read_dir(&cf).into_iter().flatten().flatten().filter_map(|e| curseforge(&e.path())));
        }
        for root in [appdata.join("ModrinthApp"), appdata.join("com.modrinth.theseus")] {
            let from_db = modrinth_db(&root);
            if from_db.is_empty() {
                out.extend(std::fs::read_dir(root.join("profiles")).into_iter().flatten().flatten().filter_map(|e| modrinth_profile_json(&e.path()).or_else(|| generic(&e.path()).map(|g| ExternalInstance { launcher: "Modrinth App".into(), ..g }))));
            } else {
                out.extend(from_db);
            }
        }
        out.extend(std::fs::read_dir(appdata.join("ATLauncher/instances")).into_iter().flatten().flatten().filter_map(|e| atlauncher(&e.path())));
        for dir in [appdata.join("gdlauncher_carbon/data/instances"), appdata.join("gdlauncher_next/instances")] {
            out.extend(std::fs::read_dir(&dir).into_iter().flatten().flatten().filter_map(|e| gdlauncher(&e.path())));
        }
        out.extend(official(&appdata.join(".minecraft"), &known));
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn scan_import_folder(path: String) -> CmdResult<Vec<ExternalInstance>> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("That folder doesn't exist".into());
    }
    let known = latest_ids().await;
    tokio::task::spawn_blocking(move || scan_folder(&dir, &known)).await.map_err(err)
}

// ---------------------------------------------------------------- copying

/// What to bring over from a shared .minecraft (the official launcher) — just the player's stuff.
const SHARED_ITEMS: &[&str] = &[
    "mods", "resourcepacks", "shaderpacks", "saves", "config", "defaultconfigs", "kubejs", "screenshots", "schematics", "journeymap", "xaero",
    "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat",
];
/// Never worth copying from a private game folder.
const SKIP_ITEMS: &[&str] = &[
    "logs", "crash-reports", "natives", "libraries", "assets", "versions", "runtime", "webcache", "webcache2", "bin", ".fabric", ".cache", ".mixin.out",
    "minecraftinstance.json", "instance.json", "profile.json", "treatment_tags.json",
];

/// Launcher files hold sign-in tokens (launcher_accounts.json, launcher_msa_credentials.bin, …): never copied.
fn skip_item(name: &str) -> bool {
    SKIP_ITEMS.contains(&name) || name.starts_with("launcher_") || name.ends_with(".orbit-tmp")
}

fn copy_filtered(src: &Path, dst: &Path, shared: bool, progress: &mut dyn FnMut()) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let keep = if shared { SHARED_ITEMS.contains(&name.as_str()) } else { !skip_item(&name) };
        if !keep {
            continue;
        }
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dst.join(&name), progress)?;
        } else {
            std::fs::copy(e.path(), dst.join(&name))?;
            progress();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_external_instance(app: AppHandle, instance: ExternalInstance) -> CmdResult<Instance> {
    let task = Arc::new(Task::new(&app, format!("Importing {}", instance.name)));
    match import(task.clone(), instance).await {
        Ok(i) => {
            task.done(&format!("Imported {}", i.name));
            Ok(i)
        }
        Err(e) => {
            task.fail(&format!("{e:#}"));
            Err(err(e))
        }
    }
}

async fn import(task: Arc<Task>, ext: ExternalInstance) -> Result<Instance> {
    if ext.mc_version.trim().is_empty() {
        bail!("Pick a Minecraft version for this instance first");
    }
    let src = PathBuf::from(&ext.game_dir);
    if !src.is_dir() {
        bail!("Can't find {}", src.display());
    }
    let loader = if ext.loader.is_empty() { "vanilla" } else { ext.loader.as_str() };
    let mut inst = instances::create(&instances::unique_name(&ext.name), ext.mc_version.trim(), loader, ext.loader_version.clone(), None)?;
    let dst = instances::game_dir(&inst.id);
    let total = count_files(&src).max(1);
    let (t2, shared, s2, d2) = (task.clone(), ext.shared, src.clone(), dst.clone());
    let r = tokio::task::spawn_blocking(move || {
        let mut n = 0;
        copy_filtered(&s2, &d2, shared, &mut || {
            n += 1;
            t2.progress("Copying files", n, total);
        })
    })
    .await?;
    if let Err(e) = r {
        let _ = std::fs::remove_dir_all(instances::dir(&inst.id));
        return Err(anyhow!(e).context("Copying failed"));
    }
    if let Some(notes) = ext.notes.as_deref().filter(|n| !n.trim().is_empty()) {
        let _ = std::fs::write(instances::dir(&inst.id).join("notes.md"), notes);
    }
    if let Some(icon) = ext.icon.as_deref().map(Path::new).filter(|p| p.is_file()) {
        let ext_name = icon.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "png".into());
        if matches!(ext_name.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
            let dest = instances::dir(&inst.id).join(format!("icon.{ext_name}"));
            if std::fs::copy(icon, &dest).is_ok() {
                inst.icon = Some(dest.to_string_lossy().into());
            }
        }
    }
    inst.group = if ext.launcher == "Folder" { "Imported".into() } else { ext.launcher.clone() };
    instances::save(&inst)?;
    Ok(inst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_official_version_ids() {
        let k = Known { release: "26.3".into(), snapshot: "26.4-snapshot-5".into(), ids: ["1.21-pre1".to_string()].into_iter().collect() };
        assert_eq!(official_version("fabric-loader-0.15.7-1.20.1", &k), ("1.20.1".into(), "fabric".into(), Some("0.15.7".into())));
        assert_eq!(official_version("1.20.1-forge-47.2.0", &k), ("1.20.1".into(), "forge".into(), Some("1.20.1-47.2.0".into())));
        assert_eq!(official_version("neoforge-21.1.65", &k), ("1.21.1".into(), "neoforge".into(), Some("21.1.65".into())));
        assert_eq!(official_version("1.12.2-forge1.12.2-14.23.5.2859", &k), ("1.12.2".into(), "forge".into(), Some("1.12.2-14.23.5.2859".into())));
        assert_eq!(official_version("1.7.10-Forge10.13.4.1614-1.7.10", &k), ("1.7.10".into(), "forge".into(), Some("1.7.10-10.13.4.1614-1.7.10".into())));
        assert_eq!(official_version("1.20.1-OptiFine_HD_U_I6", &k), ("1.20.1".into(), "vanilla".into(), None));
        assert_eq!(official_version("1.21-pre1", &k), ("1.21-pre1".into(), "vanilla".into(), None));
        assert_eq!(official_version("latest-release", &k), ("26.3".into(), "vanilla".into(), None));
        assert!(skip_item("launcher_accounts.json") && skip_item("launcher_msa_credentials.bin") && skip_item("runtime") && !skip_item("mods"));
    }

    #[test]
    fn parses_dashed_loader_ids() {
        assert_eq!(loader_from_dashed("fabric-0.15.7-1.20.1", "1.20.1"), ("fabric".into(), Some("0.15.7".into())));
        assert_eq!(loader_from_dashed("forge-47.2.0", "1.20.1"), ("forge".into(), Some("1.20.1-47.2.0".into())));
        assert_eq!(loader_from_dashed("neoforge-21.1.65", "1.21.1"), ("neoforge".into(), Some("21.1.65".into())));
    }

    #[test]
    fn finds_versions_in_dependency_strings() {
        assert_eq!(version_in("\"~1.20.1\"").as_deref(), Some("1.20.1"));
        assert_eq!(version_in("versionRange=\"[1.20.1,1.21)\"").as_deref(), Some("1.20.1"));
        assert_eq!(version_in("\">=26.3\"").as_deref(), Some("26.3"));
        assert_eq!(version_in("\"*\""), None);
    }
}
