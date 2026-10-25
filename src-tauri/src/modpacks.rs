//! Modrinth (.mrpack) and CurseForge modpacks — install, update, import and export.
use crate::content::{self, cf_post, folder_for, kind_from_class, mr_post, opt, s};
use crate::instances::{self, Instance, PackInfo};
use crate::net::{self, Dl};
use crate::tasks::Task;
use crate::util::*;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedFile {
    name: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackResult {
    instance: Instance,
    blocked: Vec<BlockedFile>,
}

struct Origin {
    source: String,
    project_id: String,
    version_id: String,
    version: String,
    title: String,
    icon: Option<String>,
}

/// Files a pack put into the game dir, so an update can remove exactly those.
fn pack_files_path(id: &str) -> PathBuf {
    instances::dir(id).join("pack-files.json")
}

/// Which project each pack file came from, so a mod the player switched off stays off after an
/// update renames its file (sodium-0.5.jar -> sodium-0.6.jar).
fn pack_projects_path(id: &str) -> PathBuf {
    instances::dir(id).join("pack-projects.json")
}

type Projects = HashMap<String, String>;

/// "mods/sodium-fabric-0.9.2+mc26.2.jar" -> "mods/sodium-fabric": the name without its version.
/// Only a fallback for packs installed before projects were recorded.
fn name_stem(rel: &str) -> String {
    let rel = rel.strip_suffix(".disabled").unwrap_or(rel);
    let b = rel.as_bytes();
    let cut = (1..b.len()).find(|&i| matches!(b[i - 1], b'-' | b'_' | b'+') && b[i].is_ascii_digit()).map(|i| i - 1);
    rel[..cut.unwrap_or(rel.len())].to_ascii_lowercase()
}

#[tauri::command]
pub async fn install_modpack(app: AppHandle, source: String, project_id: String, version_id: Option<String>) -> CmdResult<PackResult> {
    let task = Task::new(&app, "Installing modpack");
    let r = from_platform(&task, &source, &project_id, version_id).await;
    finish(&task, r)
}

#[tauri::command]
pub async fn import_modpack_file(app: AppHandle, path: String) -> CmdResult<PackResult> {
    let task = Task::new(&app, "Importing");
    let p = PathBuf::from(&path);
    let r = if zip_has(&p, "orbit-instance.json") {
        import_backup(&task, &p).await.map(|instance| PackResult { instance, blocked: vec![] })
    } else {
        let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Imported pack".into());
        let origin = Origin { source: String::new(), project_id: String::new(), version_id: String::new(), version: String::new(), title: name, icon: None };
        install_archive(&task, &p, origin).await
    };
    finish(&task, r)
}

fn finish(task: &Task, r: Result<PackResult>) -> CmdResult<PackResult> {
    match &r {
        Ok(p) => task.done(&format!("{} is ready", p.instance.name)),
        Err(e) => task.fail(&format!("{e:#}")),
    }
    r.map_err(err)
}

async fn download_pack(task: &Task, source: &str, pid: &str, vid: Option<String>) -> Result<(PathBuf, Origin)> {
    let info = content::project_info(source, pid).await?;
    task.step(&format!("Resolving {}", info.title));
    let ver = match vid {
        Some(v) => content::single_version(source, pid, &v).await?,
        None => {
            let list = content::list_versions(source, pid, None, None).await?;
            list.iter().find(|v| v.kind == "release").or(list.first()).cloned().ok_or_else(|| anyhow!("This modpack has no downloadable versions"))?
        }
    };
    let url = ver.url.clone().ok_or_else(|| anyhow!("BLOCKED:{}", info.url))?;
    let pack_path = paths().cache.join("packs").join(sanitize_file_name(&ver.file_name));
    task.step(&format!("Downloading {} {}", info.title, ver.number));
    net::download(&Dl { url, path: pack_path.clone(), sha1: ver.sha1.clone(), size: None }).await?;
    Ok((pack_path, Origin { source: source.into(), project_id: pid.into(), version_id: ver.id.clone(), version: ver.number.clone(), title: info.title, icon: info.icon }))
}

async fn from_platform(task: &Task, source: &str, pid: &str, vid: Option<String>) -> Result<PackResult> {
    let (pack_path, origin) = download_pack(task, source, pid, vid).await?;
    install_archive(task, &pack_path, origin).await
}

fn zip_has(path: &Path, name: &str) -> bool {
    std::fs::File::open(path).ok().and_then(|f| zip::ZipArchive::new(f).ok()).map(|mut z| z.by_name(name).is_ok()).unwrap_or(false)
}

fn zip_json(path: &Path, name: &str) -> Result<Option<Value>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let Ok(mut e) = z.by_name(name) else { return Ok(None) };
    let mut s = String::new();
    e.read_to_string(&mut s)?;
    Ok(Some(serde_json::from_str(&s)?))
}

/// Extract entries under any of `prefixes` into `dest`; returns the relative paths written.
fn extract_overrides(path: &Path, prefixes: &[String], dest: &Path) -> Result<Vec<String>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let mut written = vec![];
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        let name = e.name().replace('\\', "/");
        let Some(rel) = prefixes.iter().find_map(|p| name.strip_prefix(p.as_str())) else { continue };
        if rel.is_empty() {
            continue;
        }
        let Some(target) = safe_join(dest, rel) else { continue };
        let rel = rel.trim_end_matches('/');
        if e.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if is_world(rel) {
            // Bundled worlds are copied once; a player's progress is never overwritten or tracked.
            if !target.exists() {
                if let Some(p) = target.parent() {
                    std::fs::create_dir_all(p)?;
                }
                std::io::copy(&mut e, &mut std::fs::File::create(&target)?)?;
            }
        } else {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::io::copy(&mut e, &mut std::fs::File::create(&target)?)?;
            written.push(rel.to_string());
        }
    }
    Ok(written)
}

/// (minecraft version, loader, loader version) a pack asks for.
fn pack_target(mr: &Option<Value>, cf: &Option<Value>) -> Result<(String, &'static str, Option<String>)> {
    if let Some(index) = mr {
        let d = &index["dependencies"];
        let mc = d["minecraft"].as_str().ok_or_else(|| anyhow!("Pack doesn't say which Minecraft version it needs"))?.to_string();
        let (l, v) = if let Some(v) = d["fabric-loader"].as_str() {
            ("fabric", Some(v.to_string()))
        } else if let Some(v) = d["quilt-loader"].as_str() {
            ("quilt", Some(v.to_string()))
        } else if let Some(v) = d["neoforge"].as_str() {
            ("neoforge", Some(v.to_string()))
        } else if let Some(v) = d["forge"].as_str() {
            ("forge", Some(format!("{mc}-{v}")))
        } else {
            ("vanilla", None)
        };
        return Ok((mc, l, v));
    }
    if let Some(m) = cf {
        let mc = m["minecraft"]["version"].as_str().ok_or_else(|| anyhow!("Pack has no Minecraft version"))?.to_string();
        let loaders = m["minecraft"]["modLoaders"].as_array().cloned().unwrap_or_default();
        let id = loaders.iter().find(|l| l["primary"].as_bool() == Some(true)).or(loaders.first()).map(|l| s(&l["id"])).unwrap_or_default();
        let (l, v) = match id.split_once('-') {
            Some(("forge", v)) => ("forge", Some(format!("{mc}-{v}"))),
            Some(("neoforge", v)) => ("neoforge", Some(v.to_string())),
            Some(("fabric", v)) => ("fabric", Some(v.to_string())),
            Some(("quilt", v)) => ("quilt", Some(v.to_string())),
            _ => ("vanilla", None),
        };
        return Ok((mc, l, v));
    }
    bail!("That file isn't a Modrinth or CurseForge modpack")
}

async fn read_pack(path: &Path) -> Result<(Option<Value>, Option<Value>)> {
    let p1 = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(Option<Value>, Option<Value>)> {
        Ok((zip_json(&p1, "modrinth.index.json")?, zip_json(&p1, "manifest.json")?))
    })
    .await?
}

async fn install_archive(task: &Task, path: &Path, origin: Origin) -> Result<PackResult> {
    let (mr, cf) = read_pack(path).await?;
    let (mc, loader, lv) = pack_target(&mr, &cf)?;
    let pack_name = mr.as_ref().and_then(|i| opt(&i["name"])).or_else(|| cf.as_ref().and_then(|m| opt(&m["name"]))).unwrap_or(origin.title.clone());
    let title = if origin.source.is_empty() { pack_name } else { origin.title.clone() };
    let mut inst = instances::create(&instances::unique_name(&title), &mc, loader, lv, origin.icon.clone())?;
    if !origin.source.is_empty() {
        inst.pack = Some(PackInfo { source: origin.source.clone(), project_id: origin.project_id.clone(), version_id: origin.version_id.clone(), version: origin.version.clone() });
        instances::save(&inst)?;
    }
    match populate(task, path, &inst, mr, cf).await {
        Ok((blocked, files, projects)) => {
            write_json(&pack_files_path(&inst.id), &files)?;
            write_json(&pack_projects_path(&inst.id), &projects)?;
            Ok(PackResult { instance: inst, blocked })
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(instances::dir(&inst.id));
            Err(e)
        }
    }
}

async fn populate(task: &Task, path: &Path, inst: &Instance, mr: Option<Value>, cf: Option<Value>) -> Result<(Vec<BlockedFile>, Vec<String>, Projects)> {
    let game = instances::game_dir(&inst.id);
    let mut blocked = vec![];
    let mut files: Vec<String> = vec![];
    let mut projects = Projects::new();
    let prefixes: Vec<String>;
    if let Some(index) = mr {
        let mut dls = vec![];
        for f in index["files"].as_array().into_iter().flatten() {
            if f["env"]["client"].as_str() == Some("unsupported") {
                continue;
            }
            let rel = f["path"].as_str().unwrap_or_default();
            let (Some(target), Some(url)) = (safe_join(&game, rel), f["downloads"][0].as_str()) else { continue };
            // cdn.modrinth.com/data/{project}/versions/{version}/{file}
            if let Some(pid) = url.split("/data/").nth(1).and_then(|r| r.split('/').next()) {
                projects.insert(rel.to_string(), format!("modrinth:{pid}"));
            }
            files.push(rel.to_string());
            dls.push(Dl { url: url.into(), path: target, sha1: opt(&f["hashes"]["sha1"]), size: f["fileSize"].as_u64() });
        }
        net::download_many(dls, 8, |d, t| task.progress("Downloading mods", d, t)).await?;
        prefixes = vec!["overrides/".into(), "client-overrides/".into()];
    } else {
        let m = cf.unwrap();
        let entries: Vec<&Value> = m["files"].as_array().into_iter().flatten().filter(|f| f["required"].as_bool() != Some(false)).collect();
        let file_ids: Vec<u64> = entries.iter().filter_map(|f| f["fileID"].as_u64()).collect();
        let mod_ids: Vec<u64> = entries.iter().filter_map(|f| f["projectID"].as_u64()).collect();
        if !file_ids.is_empty() {
            task.step("Resolving mod list");
            let cf_files = cf_post("/mods/files", &json!({ "fileIds": file_ids })).await?;
            let mods = cf_post("/mods", &json!({ "modIds": mod_ids, "filterPcOnly": true })).await?;
            let info: HashMap<u64, (u64, String, String)> = mods["data"]
                .as_array()
                .map(|a| a.iter().filter_map(|m| Some((m["id"].as_u64()?, (m["classId"].as_u64().unwrap_or(6), s(&m["name"]), s(&m["links"]["websiteUrl"]))))).collect())
                .unwrap_or_default();
            let mut dls = vec![];
            for f in cf_files["data"].as_array().into_iter().flatten() {
                let mod_id = f["modId"].as_u64().unwrap_or(0);
                let (class, name, site) = info.get(&mod_id).cloned().unwrap_or((6, s(&f["displayName"]), String::new()));
                let file_name = sanitize_file_name(&s(&f["fileName"]));
                let folder = folder_for(kind_from_class(class));
                match opt(&f["downloadUrl"]) {
                    Some(url) => {
                        files.push(format!("{folder}/{file_name}"));
                        projects.insert(format!("{folder}/{file_name}"), format!("curseforge:{mod_id}"));
                        dls.push(Dl { url, path: game.join(folder).join(file_name), sha1: None, size: f["fileLength"].as_u64() })
                    }
                    None => blocked.push(BlockedFile { name, url: if site.is_empty() { String::new() } else { format!("{site}/files/{}", s(&f["id"])) } }),
                }
            }
            net::download_many(dls, 8, |d, t| task.progress("Downloading mods", d, t)).await?;
        }
        prefixes = vec![format!("{}/", m["overrides"].as_str().unwrap_or("overrides"))];
    }
    task.step("Applying pack files");
    let (p, g) = (path.to_path_buf(), game.clone());
    files.extend(tokio::task::spawn_blocking(move || extract_overrides(&p, &prefixes, &g)).await??);
    Ok((blocked, files, projects))
}

// ---------------------------------------------------------------- updates

#[tauri::command]
pub async fn update_modpack(app: AppHandle, instance_id: String, version_id: String) -> CmdResult<PackResult> {
    let inst = instances::load(&instance_id).map_err(err)?;
    if crate::launch::is_running(&app, &inst.id) {
        return Err("Close the game before updating its modpack".into());
    }
    let task = Task::new(&app, format!("Updating {}", inst.name));
    let r = update(&task, inst, version_id).await;
    finish(&task, r)
}

async fn update(task: &Task, mut inst: Instance, vid: String) -> Result<PackResult> {
    let pack = inst.pack.clone().ok_or_else(|| anyhow!("This instance wasn't installed from a modpack"))?;
    let (path, origin) = download_pack(task, &pack.source, &pack.project_id, Some(vid)).await?;
    let (mr, cf) = read_pack(&path).await?;
    let (mc, loader, lv) = pack_target(&mr, &cf)?;

    let game = instances::game_dir(&inst.id);
    let old_files: Option<Vec<String>> = read_json(&pack_files_path(&inst.id)).ok();
    let old_projects: Projects = read_json(&pack_projects_path(&inst.id)).unwrap_or_default();
    // Snapshot first, so a failed update can remove exactly what it added.
    let g = game.clone();
    let before = tokio::task::spawn_blocking(move || list_files(&g)).await?;

    // Install the new version on top of the old one. Nothing is removed until it has fully succeeded,
    // so a dropped connection leaves the instance exactly as it was.
    let mut target = inst.clone();
    target.mc_version = mc;
    target.loader = loader.into();
    target.loader_version = lv;
    let (blocked, files, projects) = match populate(task, &path, &target, mr, cf).await {
        Ok(r) => r,
        Err(e) => {
            let g = game.clone();
            let _ = tokio::task::spawn_blocking(move || {
                for rel in list_files(&g).difference(&before) {
                    if let Some(p) = safe_join(&g, rel) {
                        let _ = std::fs::remove_file(p);
                    }
                }
            })
            .await;
            return Err(e);
        }
    };

    task.step("Removing old pack files");
    let keep: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
    let old: Vec<String> = match old_files {
        Some(old) => old,
        // Packs installed before file tracking: the mods folder belongs to the pack.
        None => before.iter().filter(|r| r.starts_with("mods/")).map(|r| r.strip_suffix(".disabled").unwrap_or(r).to_string()).collect(),
    };
    // What the player had switched off, by project (or by name for older installs).
    let switched_off: Vec<(Option<&String>, String)> =
        old.iter().filter(|r| before.contains(&format!("{r}.disabled"))).map(|r| (old_projects.get(r.as_str()), name_stem(r))).collect();
    for rel in old.iter().filter(|r| !keep.contains(r.as_str()) && !is_world(r)) {
        if let Some(p) = safe_join(&game, rel) {
            let _ = std::fs::remove_file(&p);
            let _ = std::fs::remove_file(format!("{}.disabled", p.display()));
        }
    }
    // A mod the player had switched off stays off, even when the update renamed its file.
    for rel in &files {
        let was_off = switched_off.iter().any(|(proj, stem)| match (proj, projects.get(rel)) {
            (Some(a), Some(b)) => *a == b,
            _ => *stem == name_stem(rel),
        });
        if let Some(p) = safe_join(&game, rel) {
            let off = PathBuf::from(format!("{}.disabled", p.display()));
            if (was_off || off.exists()) && p.exists() {
                let _ = std::fs::rename(&p, &off);
            }
        }
    }
    let mut meta = content::load_meta(&inst.id);
    meta.retain(|k, _| game.join(k).exists() || game.join(format!("{k}.disabled")).exists());
    content::save_meta(&inst.id, &meta)?;

    // Re-read so settings changed while the update downloaded aren't lost.
    if let Ok(fresh) = instances::load(&inst.id) {
        inst = fresh;
    }
    inst.mc_version = target.mc_version;
    inst.loader = target.loader;
    inst.loader_version = target.loader_version;
    inst.pack = Some(PackInfo { source: origin.source, project_id: origin.project_id, version_id: origin.version_id, version: origin.version });
    instances::save(&inst)?;
    write_json(&pack_files_path(&inst.id), &files)?;
    write_json(&pack_projects_path(&inst.id), &projects)?;
    Ok(PackResult { instance: inst, blocked })
}

/// Worlds are the player's, never the pack's: they are not tracked, replaced or removed.
fn is_world(rel: &str) -> bool {
    rel == "saves" || rel.starts_with("saves/")
}

/// Every file under `game` (relative, forward slashes), skipping worlds.
fn list_files(game: &Path) -> std::collections::HashSet<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut std::collections::HashSet<String>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if is_world(&rel) {
                continue;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path(), &rel, out),
                Ok(_) => {
                    out.insert(rel);
                }
                Err(_) => {}
            }
        }
    }
    let mut out = std::collections::HashSet::new();
    walk(game, "", &mut out);
    out
}

/// A pack file was replaced by a newer version (single-mod update): track the new name instead,
/// so the next pack update still knows the file belongs to the pack.
pub fn retrack(id: &str, old_rel: &str, new_rel: &str) {
    let path = pack_files_path(id);
    let Ok(mut files) = read_json::<Vec<String>>(&path) else { return };
    if !files.iter().any(|f| f == old_rel) {
        return;
    }
    files.retain(|f| f != old_rel && f != new_rel);
    files.push(new_rel.to_string());
    let _ = write_json(&path, &files);
    let pp = pack_projects_path(id);
    if let Ok(mut projects) = read_json::<Projects>(&pp) {
        if let Some(proj) = projects.remove(old_rel) {
            projects.insert(new_rel.to_string(), proj);
            let _ = write_json(&pp, &projects);
        }
    }
}

// ---------------------------------------------------------------- export / backup

type ZipW = zip::ZipWriter<std::fs::File>;

fn zip_opts() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true)
}

fn add_path(z: &mut ZipW, src: &Path, name: &str, skip: &dyn Fn(&str) -> bool) -> Result<()> {
    if skip(name) {
        return Ok(());
    }
    if src.is_dir() {
        for e in std::fs::read_dir(src)?.flatten() {
            let child = format!("{name}/{}", e.file_name().to_string_lossy());
            add_path(z, &e.path(), &child, skip)?;
        }
    } else if src.is_file() {
        z.start_file(name, zip_opts())?;
        std::io::copy(&mut std::fs::File::open(src)?, z)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_instance(app: AppHandle, instance_id: String, format: String, path: String) -> CmdResult<String> {
    let inst = instances::load(&instance_id).map_err(err)?;
    let task = Task::new(&app, format!("Exporting {}", inst.name));
    let dest = PathBuf::from(&path);
    let r = if format == "mrpack" { export_mrpack(&task, &inst, &dest).await } else { export_backup(&inst, &dest).await };
    match &r {
        Ok(()) => task.done(&format!("Saved {}", dest.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())),
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            task.fail(&format!("{e:#}"))
        }
    }
    r.map(|_| path).map_err(err)
}

async fn export_backup(inst: &Instance, dest: &Path) -> Result<()> {
    let (inst, dest) = (inst.clone(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let dir = instances::dir(&inst.id);
        let mut z = zip::ZipWriter::new(std::fs::File::create(&dest)?);
        z.start_file("orbit-instance.json", zip_opts())?;
        z.write_all(&serde_json::to_vec_pretty(&inst)?)?;
        let skip = |n: &str| n == "natives" || n == "instance.json" || n == ".minecraft/logs" || n.ends_with("session.lock");
        for e in std::fs::read_dir(&dir)?.flatten() {
            add_path(&mut z, &e.path(), &e.file_name().to_string_lossy(), &skip)?;
        }
        z.finish()?;
        Ok(())
    })
    .await?
}

async fn import_backup(task: &Task, path: &Path) -> Result<Instance> {
    let backup: Instance = serde_json::from_value(zip_json(path, "orbit-instance.json")?.ok_or_else(|| anyhow!("Not an Orbit backup"))?)?;
    let mut inst = instances::create(&instances::unique_name(&backup.name), &backup.mc_version, &backup.loader, backup.loader_version.clone(), None)?;
    task.step("Restoring files");
    let (p, dir, old_dir) = (path.to_path_buf(), instances::dir(&inst.id), instances::dir(&backup.id));
    let r = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut z = zip::ZipArchive::new(std::fs::File::open(&p)?)?;
        for i in 0..z.len() {
            let mut e = z.by_index(i)?;
            let name = e.name().replace('\\', "/");
            if name == "orbit-instance.json" || e.is_dir() {
                continue;
            }
            let Some(target) = safe_join(&dir, &name) else { continue };
            std::fs::create_dir_all(target.parent().unwrap())?;
            std::io::copy(&mut e, &mut std::fs::File::create(&target)?)?;
        }
        Ok(())
    })
    .await?;
    if let Err(e) = r {
        let _ = std::fs::remove_dir_all(instances::dir(&inst.id));
        return Err(e);
    }
    let icon = backup.icon.map(|i| i.replace(&old_dir.to_string_lossy().to_string(), &instances::dir(&inst.id).to_string_lossy()));
    let keep = Instance { id: inst.id.clone(), name: inst.name.clone(), created: inst.created, icon, last_played: None, ..backup };
    inst = keep;
    instances::save(&inst)?;
    Ok(inst)
}

async fn export_mrpack(task: &Task, inst: &Instance, dest: &Path) -> Result<()> {
    let game = instances::game_dir(&inst.id);
    task.step("Hashing files");
    let g2 = game.clone();
    let local: Vec<(String, String, u64)> = tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        for folder in ["mods", "resourcepacks", "shaderpacks"] {
            for e in std::fs::read_dir(g2.join(folder)).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !e.path().is_file() || name.ends_with(".disabled") {
                    continue;
                }
                if let Ok(h) = sha1_file(&e.path()) {
                    out.push((format!("{folder}/{name}"), h, e.metadata().map(|m| m.len()).unwrap_or(0)));
                }
            }
        }
        out
    })
    .await?;

    task.step("Matching files on Modrinth");
    let hashes: Vec<&String> = local.iter().map(|(_, h, _)| h).collect();
    let found = if hashes.is_empty() { json!({}) } else { mr_post("/version_files", &json!({ "hashes": hashes, "algorithm": "sha1" })).await.unwrap_or(json!({})) };
    let mut index_files = vec![];
    let mut overrides = vec![];
    for (rel, hash, size) in &local {
        let file = found.get(hash).and_then(|v| v["files"].as_array()).and_then(|fs| fs.iter().find(|f| f["hashes"]["sha1"].as_str() == Some(hash.as_str())));
        match file {
            Some(f) => index_files.push(json!({
                "path": rel,
                "hashes": { "sha1": hash, "sha512": f["hashes"]["sha512"] },
                "env": { "client": "required", "server": if rel.starts_with("mods/") { "required" } else { "unsupported" } },
                "downloads": [f["url"]],
                "fileSize": size,
            })),
            None => overrides.push(rel.clone()),
        }
    }
    let mut deps = json!({ "minecraft": inst.mc_version });
    if let Some(lv) = &inst.loader_version {
        match inst.loader.as_str() {
            "fabric" => deps["fabric-loader"] = json!(lv),
            "quilt" => deps["quilt-loader"] = json!(lv),
            "neoforge" => deps["neoforge"] = json!(lv),
            "forge" => deps["forge"] = json!(lv.strip_prefix(&format!("{}-", inst.mc_version)).unwrap_or(lv)),
            _ => {}
        }
    }
    let index = json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": inst.pack.as_ref().map(|p| p.version.clone()).filter(|v| !v.is_empty()).unwrap_or_else(|| "1.0.0".into()),
        "name": inst.name,
        "summary": format!("Exported from Orbit Launcher"),
        "files": index_files,
        "dependencies": deps,
    });

    task.step("Writing pack");
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut z = zip::ZipWriter::new(std::fs::File::create(&dest)?);
        z.start_file("modrinth.index.json", zip_opts())?;
        z.write_all(&serde_json::to_vec_pretty(&index)?)?;
        let none = |_: &str| false;
        for rel in overrides {
            add_path(&mut z, &game.join(&rel), &format!("overrides/{rel}"), &none)?;
        }
        for extra in ["config", "defaultconfigs", "kubejs", "options.txt"] {
            add_path(&mut z, &game.join(extra), &format!("overrides/{extra}"), &none)?;
        }
        z.finish()?;
        Ok(())
    })
    .await?
}

#[cfg(test)]
mod stem_tests {
    use super::name_stem;

    #[test]
    fn strips_versions_from_names() {
        assert_eq!(name_stem("mods/reeses-sodium-options-fabric-2.2.3+mc26.2.jar"), "mods/reeses-sodium-options-fabric");
        assert_eq!(name_stem("mods/sodium-fabric-0.9.2+mc26.2.jar.disabled"), "mods/sodium-fabric");
        assert_eq!(name_stem("mods/Xaeros_Minimap_24.0.jar"), "mods/xaeros_minimap");
    }
}
