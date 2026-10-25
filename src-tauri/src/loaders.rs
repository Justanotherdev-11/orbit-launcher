//! Fabric, Quilt, Forge and NeoForge.
use crate::instances::Instance;
use crate::net::{self, Dl};
use crate::tasks::Task;
use crate::util::*;
use crate::versions::version_json_path;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone)]
pub struct LoaderVersion {
    pub id: String,
    pub stable: bool,
}

#[tauri::command]
pub async fn get_loader_versions(loader: String, mc: String) -> CmdResult<Vec<LoaderVersion>> {
    list(&loader, &mc).await.map_err(err)
}

pub async fn list(loader: &str, mc: &str) -> Result<Vec<LoaderVersion>> {
    match loader {
        "fabric" => {
            let v: Vec<Value> = net::get_json(&format!("https://meta.fabricmc.net/v2/versions/loader/{mc}")).await?;
            Ok(v.iter()
                .filter_map(|e| {
                    Some(LoaderVersion {
                        id: e["loader"]["version"].as_str()?.to_string(),
                        stable: e["loader"]["stable"].as_bool().unwrap_or(true),
                    })
                })
                .collect())
        }
        "quilt" => {
            let v: Vec<Value> = net::get_json(&format!("https://meta.quiltmc.org/v3/versions/loader/{mc}")).await?;
            Ok(v.iter()
                .filter_map(|e| {
                    let id = e["loader"]["version"].as_str()?.to_string();
                    Some(LoaderVersion { stable: !id.contains("beta") && !id.contains("pre"), id })
                })
                .collect())
        }
        "forge" => {
            let meta: HashMap<String, Vec<String>> =
                net::get_json("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json").await?;
            let promos: Value = net::get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json")
                .await
                .unwrap_or(Value::Null);
            let rec = promos["promos"][format!("{mc}-recommended")].as_str().map(|s| format!("{mc}-{s}"));
            let mut list = meta.get(mc).cloned().unwrap_or_default();
            list.sort_by(|a, b| version_cmp(b, a));
            Ok(list.into_iter().map(|id| LoaderVersion { stable: rec.as_deref() == Some(id.as_str()), id }).collect())
        }
        "neoforge" => {
            let v: Value =
                net::get_json("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge").await?;
            let mut list: Vec<String> = v["versions"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            list.retain(|id| neoforge_mc(id).as_deref() == Some(mc));
            list.sort_by(|a, b| version_cmp(b, a));
            Ok(list
                .into_iter()
                .map(|id| LoaderVersion { stable: !id.contains("beta") && !id.contains("alpha"), id })
                .collect())
        }
        _ => Ok(vec![]),
    }
}

/// NeoForge encodes the Minecraft version in its own: 21.1.x -> 1.21.1, 26.1.0.x -> 26.1.
pub fn neoforge_mc(v: &str) -> Option<String> {
    let core = v.split('-').next()?;
    let parts: Vec<u32> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    if parts.len() < 2 {
        return None;
    }
    if parts[0] < 25 {
        Some(if parts[1] == 0 { format!("1.{}", parts[0]) } else { format!("1.{}.{}", parts[0], parts[1]) })
    } else if parts.len() >= 4 && parts[2] != 0 {
        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    } else {
        Some(format!("{}.{}", parts[0], parts[1]))
    }
}

pub async fn latest(loader: &str, mc: &str) -> Result<String> {
    let l = list(loader, mc).await?;
    l.iter()
        .find(|v| v.stable)
        .or(l.first())
        .map(|v| v.id.clone())
        .ok_or_else(|| anyhow!("{loader} doesn't support Minecraft {mc} yet"))
}

/// Install the instance's loader (if any) and return the version id to launch.
pub async fn ensure(inst: &Instance, java: &Path, task: &Task) -> Result<String> {
    let mc = inst.mc_version.as_str();
    let lv = inst.loader_version.clone().unwrap_or_default();
    match inst.loader.as_str() {
        "vanilla" | "" => Ok(mc.to_string()),
        "fabric" => {
            let url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc}/{lv}/profile/json");
            profile_json(&format!("fabric-loader-{lv}-{mc}"), &url, task, "Fabric").await
        }
        "quilt" => {
            let url = format!("https://meta.quiltmc.org/v3/versions/loader/{mc}/{lv}/profile/json");
            profile_json(&format!("quilt-loader-{lv}-{mc}"), &url, task, "Quilt").await
        }
        "forge" | "neoforge" => install_forge_like(&inst.loader, mc, &lv, java, task).await,
        other => bail!("Unknown mod loader '{other}'"),
    }
}

async fn profile_json(id: &str, url: &str, task: &Task, label: &str) -> Result<String> {
    if version_json_path(id).exists() {
        return Ok(id.to_string());
    }
    task.step(&format!("Installing {label}"));
    let v: Value = net::get_json(url).await?;
    let real_id = v["id"].as_str().unwrap_or(id).to_string();
    write_json(&version_json_path(&real_id), &v)?;
    Ok(real_id)
}

fn read_zip_text(path: &Path, name: &str) -> Result<String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let mut e = z.by_name(name)?;
    let mut s = String::new();
    e.read_to_string(&mut s)?;
    Ok(s)
}

async fn install_forge_like(loader: &str, mc: &str, lv: &str, java: &Path, task: &Task) -> Result<String> {
    let pretty = if loader == "forge" { "Forge" } else { "NeoForge" };
    let marker = paths().cache.join("loaders").join(format!("{loader}-{}.txt", sanitize_file_name(lv)));
    if let Ok(id) = std::fs::read_to_string(&marker) {
        let id = id.trim().to_string();
        if version_json_path(&id).exists() {
            return Ok(id);
        }
    }
    let url = if loader == "forge" {
        // Old builds carry a branch suffix (1.7.10-10.13.4.1614-1.7.10); packs and imports give the short id.
        let full = forge_full_id(mc, lv).await;
        format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{full}/forge-{full}-installer.jar")
    } else if mc == "1.20.1" || lv.starts_with("47.") || lv.starts_with("1.20.1-") {
        // NeoForge for 1.20.1 was still published under the old "forge" artifact.
        let v = if lv.starts_with("1.20.1-") { lv.to_string() } else { format!("1.20.1-{lv}") };
        format!("https://maven.neoforged.net/releases/net/neoforged/forge/{v}/forge-{v}-installer.jar")
    } else {
        format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{lv}/neoforge-{lv}-installer.jar")
    };
    let installer = paths().cache.join("installers").join(format!("{loader}-{}-installer.jar", sanitize_file_name(lv)));
    task.step(&format!("Downloading {pretty} installer"));
    net::ensure_file(&Dl { url, path: installer.clone(), sha1: None, size: None }).await?;

    let inst2 = installer.clone();
    let profile: Value = tokio::task::spawn_blocking(move || -> Result<Value> {
        Ok(serde_json::from_str(&read_zip_text(&inst2, "install_profile.json")?)?)
    })
    .await??;

    let id = if let Some(info) = profile.get("versionInfo") {
        // Legacy (≤1.12) installer: the version json and universal jar ship inside the installer.
        let mut info = info.clone();
        let id = info["id"].as_str().ok_or_else(|| anyhow!("Installer has no version id"))?.to_string();
        if info.get("inheritsFrom").is_none() {
            info["inheritsFrom"] = Value::String(mc.into());
        }
        if info.get("jar").is_none() {
            info["jar"] = Value::String(mc.into());
        }
        write_json(&version_json_path(&id), &info)?;
        if let (Some(file_path), Some(lib)) = (profile["install"]["filePath"].as_str(), profile["install"]["path"].as_str()) {
            let dest = paths().libraries.join(maven_path(lib));
            let (inst3, fp) = (installer.clone(), file_path.to_string());
            tokio::task::spawn_blocking(move || -> Result<()> {
                let mut z = zip::ZipArchive::new(std::fs::File::open(&inst3)?)?;
                let mut e = z.by_name(&fp)?;
                std::fs::create_dir_all(dest.parent().unwrap())?;
                std::io::copy(&mut e, &mut std::fs::File::create(&dest)?)?;
                Ok(())
            })
            .await??;
        }
        id
    } else {
        let id = profile["version"].as_str().ok_or_else(|| anyhow!("Installer has no version id"))?.to_string();
        let lp = paths().root.join("launcher_profiles.json");
        if !lp.exists() {
            std::fs::write(&lp, r#"{"profiles":{}}"#)?;
        }
        task.step(&format!("Running {pretty} installer (this can take a minute)"));
        let mut ok = false;
        let tail: Arc<Mutex<Vec<String>>> = Arc::default();
        for flag in ["--installClient", "--install-client"] {
            let mut cmd = tokio::process::Command::new(java);
            cmd.arg("-jar")
                .arg(&installer)
                .arg(flag)
                .arg(&paths().root)
                .current_dir(&paths().cache)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let mut child = cmd.spawn()?;
            let stderr = child.stderr.take().unwrap();
            let t2 = tail.clone();
            let err_task = tokio::spawn(async move {
                for_each_line(stderr, |l| {
                    push_tail(&t2, l);
                    true
                })
                .await;
            });
            // Lenient reading: a non-UTF-8 byte (e.g. an accented username) must not stop us
            // draining the pipe, or the installer would block forever.
            for_each_line(child.stdout.take().unwrap(), |line| {
                let short: String = line.chars().take(110).collect();
                task.step(&short);
                push_tail(&tail, line);
                true
            })
            .await;
            let status = child.wait().await?;
            let _ = err_task.await;
            if status.success() && version_json_path(&id).exists() {
                ok = true;
                break;
            }
        }
        if !ok {
            let t = tail.lock().unwrap().join("\n");
            bail!("{pretty} installer failed:\n{t}");
        }
        id
    };
    std::fs::create_dir_all(marker.parent().unwrap())?;
    std::fs::write(&marker, &id)?;
    Ok(id)
}

/// Map a short Forge id ("1.7.10-10.13.4.1614") to the full maven id, which may have a branch suffix.
async fn forge_full_id(mc: &str, lv: &str) -> String {
    let meta: Result<HashMap<String, Vec<String>>> = net::get_json("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json").await;
    let Ok(meta) = meta else { return lv.to_string() };
    let list = meta.get(mc).cloned().unwrap_or_default();
    if list.iter().any(|v| v == lv) {
        return lv.to_string();
    }
    list.into_iter().find(|v| v.starts_with(&format!("{lv}-"))).unwrap_or_else(|| lv.to_string())
}

fn push_tail(tail: &Arc<Mutex<Vec<String>>>, line: String) {
    let mut t = tail.lock().unwrap();
    t.push(line);
    if t.len() > 15 {
        t.remove(0);
    }
}
