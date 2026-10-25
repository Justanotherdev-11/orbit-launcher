//! Automatic Java runtimes from Mojang's own runtime manifest.
use crate::net::{self, Dl};
use crate::tasks::Task;
use crate::util::*;
use crate::versions::VersionJson;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

const RUNTIMES: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

fn platform() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "windows-arm64"
    } else if cfg!(target_arch = "x86") {
        "windows-x86"
    } else {
        "windows-x64"
    }
}

pub fn component_for(v: &VersionJson) -> String {
    v.java_version
        .as_ref()
        .map(|j| j.component.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "jre-legacy".into())
}

pub async fn ensure(component: &str, task: &Task) -> Result<PathBuf> {
    let dir = paths().java.join(sanitize_file_name(component));
    let exe = dir.join("bin").join("java.exe");
    let marker = dir.join(".orbit-complete");
    if exe.exists() && marker.exists() {
        return Ok(exe);
    }
    task.step(&format!("Fetching Java runtime ({component})"));
    let all: Value = net::get_json(RUNTIMES).await?;
    let entry = all[platform()][component]
        .get(0)
        .ok_or_else(|| anyhow!("Mojang has no '{component}' Java runtime for this PC. Set a Java path in Settings."))?;
    let manifest_url = entry["manifest"]["url"].as_str().ok_or_else(|| anyhow!("Malformed Java manifest"))?;
    let manifest: Value = net::get_json(manifest_url).await?;
    let mut dls = vec![];
    if let Some(files) = manifest["files"].as_object() {
        for (rel, f) in files {
            let Some(path) = safe_join(&dir, rel) else { continue };
            match f["type"].as_str() {
                Some("directory") => std::fs::create_dir_all(&path)?,
                Some("file") => {
                    let raw = &f["downloads"]["raw"];
                    if let Some(url) = raw["url"].as_str() {
                        dls.push(Dl { url: url.into(), path, sha1: raw["sha1"].as_str().map(String::from), size: raw["size"].as_u64() });
                    }
                }
                _ => {}
            }
        }
    }
    net::download_many(dls, 16, |d, t| task.progress("Java runtime", d, t)).await?;
    std::fs::write(&marker, entry["version"]["name"].as_str().unwrap_or(component))?;
    Ok(exe)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledJava {
    component: String,
    version: String,
    path: String,
}

#[tauri::command]
pub fn list_java() -> Vec<InstalledJava> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&paths().java) {
        for e in rd.flatten() {
            let dir = e.path();
            let Ok(version) = std::fs::read_to_string(dir.join(".orbit-complete")) else { continue };
            out.push(InstalledJava {
                component: e.file_name().to_string_lossy().into(),
                version,
                path: dir.join("bin").join("java.exe").to_string_lossy().into(),
            });
        }
    }
    out
}
