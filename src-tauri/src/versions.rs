//! Mojang version manifest, version JSON resolution, libraries and assets.
use crate::net::{self, Dl};
use crate::tasks::Task;
use crate::util::*;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub sha1: String,
    pub release_time: String,
}

#[derive(Deserialize)]
struct Manifest {
    versions: Vec<ManifestVersion>,
}

static MANIFEST_CACHE: Mutex<Option<(Instant, Vec<ManifestVersion>)>> = Mutex::new(None);

pub async fn manifest() -> Result<Vec<ManifestVersion>> {
    let cached = MANIFEST_CACHE.lock().unwrap().clone();
    if let Some((t, v)) = cached {
        if t.elapsed() < Duration::from_secs(600) {
            return Ok(v);
        }
    }
    let disk = paths().cache.join("version_manifest_v2.json");
    let versions = match net::get_json::<Manifest>(MANIFEST_URL).await {
        Ok(m) => {
            let _ = write_json(&disk, &m.versions);
            m.versions
        }
        Err(e) => read_json::<Vec<ManifestVersion>>(&disk).map_err(|_| e)?,
    };
    *MANIFEST_CACHE.lock().unwrap() = Some((Instant::now(), versions.clone()));
    Ok(versions)
}

#[tauri::command]
pub async fn get_mc_versions() -> CmdResult<Vec<ManifestVersion>> {
    manifest().await.map_err(err)
}

// ---------------------------------------------------------------- version json

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionJson {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherits_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minecraft_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Arguments>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<HashMap<String, Artifact>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java_version: Option<JavaVersion>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logging: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<Value>,
    #[serde(default)]
    pub jvm: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Library {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<LibDownloads>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<Rule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clientreq: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LibDownloads {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classifiers: Option<HashMap<String, Artifact>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Artifact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Rule {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<OsRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OsRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetIndexRef {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersion {
    #[serde(default)]
    pub component: String,
    #[serde(default)]
    pub major_version: u32,
}

pub fn version_dir(id: &str) -> PathBuf {
    paths().versions.join(id)
}

pub fn version_json_path(id: &str) -> PathBuf {
    version_dir(id).join(format!("{id}.json"))
}

pub async fn ensure_vanilla_json(id: &str) -> Result<()> {
    let path = version_json_path(id);
    match manifest().await {
        Ok(list) => {
            let Some(entry) = list.iter().find(|v| v.id == id) else {
                if path.exists() {
                    return Ok(());
                }
                bail!("Unknown Minecraft version {id}");
            };
            let sha1 = Some(entry.sha1.clone()).filter(|s| !s.is_empty());
            net::ensure_file(&Dl { url: entry.url.clone(), path, sha1, size: None }).await
        }
        Err(e) if !path.exists() => Err(e),
        Err(_) => Ok(()),
    }
}

pub fn read_version(id: &str) -> Result<VersionJson> {
    read_json(&version_json_path(id))
}

/// Load a version and fold in everything it inherits from.
pub fn resolve(id: &str) -> Result<VersionJson> {
    let v = read_version(id)?;
    match v.inherits_from.clone() {
        Some(parent) if parent != v.id => Ok(merge(resolve(&parent)?, v)),
        _ => Ok(v),
    }
}

fn lib_key(name: &str) -> String {
    let coords = name.split('@').next().unwrap_or(name);
    let p: Vec<&str> = coords.split(':').collect();
    match p.len() {
        0..=2 => coords.to_string(),
        3 => format!("{}:{}", p[0], p[1]),
        _ => format!("{}:{}:{}", p[0], p[1], p[3]),
    }
}

fn merge(parent: VersionJson, child: VersionJson) -> VersionJson {
    let mut out = parent.clone();
    out.jar = Some(child.jar.clone().unwrap_or_else(|| parent.jar.clone().unwrap_or(parent.id.clone())));
    out.id = child.id;
    out.inherits_from = None;
    if child.main_class.is_some() {
        out.main_class = child.main_class;
    }
    if child.minecraft_arguments.is_some() {
        out.minecraft_arguments = child.minecraft_arguments;
    }
    if let Some(ca) = child.arguments {
        let mut a = out.arguments.take().unwrap_or_default();
        a.game.extend(ca.game);
        a.jvm.extend(ca.jvm);
        out.arguments = Some(a);
    }
    let child_keys: HashSet<String> = child.libraries.iter().map(|l| lib_key(&l.name)).collect();
    let mut libs = child.libraries;
    libs.extend(parent.libraries.into_iter().filter(|l| !child_keys.contains(&lib_key(&l.name))));
    out.libraries = libs;
    if child.asset_index.is_some() {
        out.asset_index = child.asset_index;
    }
    if child.assets.is_some() {
        out.assets = child.assets;
    }
    if child.java_version.is_some() {
        out.java_version = child.java_version;
    }
    if child.kind.is_some() {
        out.kind = child.kind;
    }
    if child.logging.is_some() {
        out.logging = child.logging;
    }
    if let Some(d) = child.downloads {
        out.downloads.get_or_insert_with(HashMap::new).extend(d);
    }
    out
}

// ---------------------------------------------------------------- rules

fn current_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x86_64"
    }
}

fn rule_applies(r: &Rule) -> bool {
    if let Some(os) = &r.os {
        if let Some(name) = &os.name {
            if name != "windows" {
                return false;
            }
        }
        if let Some(arch) = &os.arch {
            let a = arch.as_str();
            let ok = match current_arch() {
                "x86_64" => matches!(a, "x86_64" | "x64" | "amd64"),
                "arm64" => matches!(a, "arm64" | "aarch64"),
                _ => a == "x86",
            };
            if !ok {
                return false;
            }
        }
    }
    if let Some(f) = &r.features {
        // We never enable demo mode / quick play / custom resolution via features.
        if f.values().any(|v| *v) {
            return false;
        }
    }
    true
}

pub fn rules_allow(rules: Option<&Vec<Rule>>) -> bool {
    let Some(rules) = rules else { return true };
    let mut allowed = false;
    for r in rules {
        if rule_applies(r) {
            allowed = r.action == "allow";
        }
    }
    allowed
}

fn native_matches(classifier: &str) -> bool {
    if !classifier.contains("windows") {
        return false;
    }
    let arm = classifier.ends_with("arm64");
    let x86 = classifier.ends_with("-x86");
    match current_arch() {
        "arm64" => arm,
        "x86" => x86,
        _ => !arm && !x86,
    }
}

pub fn collect_args(values: &[Value]) -> Vec<String> {
    let mut out = vec![];
    for v in values {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Object(o) => {
                if let Some(r) = o.get("rules") {
                    match serde_json::from_value::<Vec<Rule>>(r.clone()) {
                        Ok(rules) if rules_allow(Some(&rules)) => {}
                        _ => continue,
                    }
                }
                match o.get("value") {
                    Some(Value::String(s)) => out.push(s.clone()),
                    Some(Value::Array(a)) => out.extend(a.iter().filter_map(|x| x.as_str().map(String::from))),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------- libraries

pub struct LibFile {
    pub dl: Dl,
    pub classpath: bool,
    pub native: bool,
}

fn fix_base(base: &str) -> String {
    let b = base
        .replace("http://files.minecraftforge.net/maven/", "https://maven.minecraftforge.net/")
        .replace("https://files.minecraftforge.net/maven/", "https://maven.minecraftforge.net/");
    let b = if let Some(rest) = b.strip_prefix("http://") { format!("https://{rest}") } else { b };
    if b.ends_with('/') {
        b
    } else {
        format!("{b}/")
    }
}

pub fn libraries(v: &VersionJson) -> Vec<LibFile> {
    let libs_dir = &paths().libraries;
    let mut out = vec![];
    for lib in &v.libraries {
        if !rules_allow(lib.rules.as_ref()) || lib.clientreq == Some(false) {
            continue;
        }
        let classifier = lib.name.split('@').next().unwrap_or("").split(':').nth(3).unwrap_or("");
        if classifier.starts_with("natives-") && !native_matches(classifier) {
            continue;
        }
        let base = fix_base(lib.url.as_deref().unwrap_or("https://libraries.minecraft.net/"));
        let artifact = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());

        if let Some(natives) = &lib.natives {
            if let Some(cls) = natives.get("windows") {
                let cls = cls.replace("${arch}", if cfg!(target_pointer_width = "64") { "64" } else { "32" });
                let art = lib.downloads.as_ref().and_then(|d| d.classifiers.as_ref()).and_then(|c| c.get(&cls));
                let path = art.and_then(|a| a.path.clone()).unwrap_or_else(|| maven_path(&format!("{}:{}", lib.name, cls)));
                let url = art.map(|a| a.url.clone()).unwrap_or_else(|| format!("{base}{path}"));
                out.push(LibFile {
                    dl: Dl { url, path: libs_dir.join(&path), sha1: art.and_then(|a| a.sha1.clone()), size: art.and_then(|a| a.size) },
                    classpath: false,
                    native: true,
                });
            }
            if let Some(a) = artifact {
                let path = a.path.clone().unwrap_or_else(|| maven_path(&lib.name));
                out.push(LibFile {
                    dl: Dl { url: a.url.clone(), path: libs_dir.join(path), sha1: a.sha1.clone(), size: a.size },
                    classpath: true,
                    native: false,
                });
            }
            continue;
        }

        let path = artifact.and_then(|a| a.path.clone()).unwrap_or_else(|| maven_path(&lib.name));
        let url = match artifact {
            Some(a) => a.url.clone(),
            None => format!("{base}{path}"),
        };
        out.push(LibFile {
            dl: Dl {
                url,
                path: libs_dir.join(&path),
                sha1: artifact.and_then(|a| a.sha1.clone()).or_else(|| lib.sha1.clone()),
                size: artifact.and_then(|a| a.size).or(lib.size),
            },
            classpath: true,
            native: classifier.starts_with("natives-"),
        });
    }
    out
}

// ---------------------------------------------------------------- install

#[derive(Deserialize)]
struct AssetIndexFile {
    objects: HashMap<String, AssetObject>,
    #[serde(default, rename = "virtual")]
    is_virtual: bool,
    #[serde(default)]
    map_to_resources: bool,
}

#[derive(Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

pub struct Prepared {
    pub libs: Vec<LibFile>,
    pub client_jar: PathBuf,
    pub asset_index: String,
    pub game_assets: PathBuf,
    pub logging_arg: Option<String>,
}

/// Make sure the client jar, libraries, assets and logging config for `v` are on disk.
pub async fn install_files(v: &VersionJson, game_dir: &Path, task: &Task) -> Result<Prepared> {
    let jar_id = v.jar.clone().unwrap_or_else(|| v.id.clone());
    let base_jar = version_dir(&jar_id).join(format!("{jar_id}.jar"));
    let client = v
        .downloads
        .as_ref()
        .and_then(|d| d.get("client"))
        .ok_or_else(|| anyhow!("Version {} has no client download", v.id))?;
    task.step("Downloading Minecraft");
    net::ensure_file(&Dl { url: client.url.clone(), path: base_jar.clone(), sha1: client.sha1.clone(), size: client.size }).await?;

    // Loader versions expect a jar named after themselves (Forge's ignoreList relies on it).
    let client_jar = if jar_id != v.id {
        let p = version_dir(&v.id).join(format!("{}.jar", v.id));
        let src_len = std::fs::metadata(&base_jar).map(|m| m.len()).unwrap_or(0);
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(u64::MAX) != src_len {
            std::fs::create_dir_all(version_dir(&v.id))?;
            std::fs::copy(&base_jar, &p)?;
        }
        p
    } else {
        base_jar
    };

    let libs = libraries(v);
    let mut dls = vec![];
    let mut missing = vec![];
    for l in &libs {
        if l.dl.url.is_empty() {
            if !l.dl.path.exists() {
                missing.push(l.dl.path.display().to_string());
            }
        } else {
            dls.push(l.dl.clone());
        }
    }
    net::download_many(dls, 12, |d, t| task.progress("Libraries", d, t)).await?;
    if !missing.is_empty() {
        bail!("Missing generated libraries (try reinstalling the loader):\n{}", missing.join("\n"));
    }

    let (asset_index, game_assets) = install_assets(v, game_dir, task).await?;
    let logging_arg = logging_config(v).await.unwrap_or(None);
    Ok(Prepared { libs, client_jar, asset_index, game_assets, logging_arg })
}

async fn install_assets(v: &VersionJson, game_dir: &Path, task: &Task) -> Result<(String, PathBuf)> {
    let idx = v.asset_index.as_ref().ok_or_else(|| anyhow!("Version has no asset index"))?;
    let assets = paths().assets.clone();
    let index_path = assets.join("indexes").join(format!("{}.json", idx.id));
    net::ensure_file(&Dl { url: idx.url.clone(), path: index_path.clone(), sha1: idx.sha1.clone(), size: idx.size }).await?;
    let index: AssetIndexFile = read_json(&index_path)?;
    let objects = assets.join("objects");
    let dls: Vec<Dl> = index
        .objects
        .values()
        .filter(|o| o.hash.len() > 2)
        .map(|o| Dl {
            url: format!("https://resources.download.minecraft.net/{}/{}", &o.hash[..2], o.hash),
            path: objects.join(&o.hash[..2]).join(&o.hash),
            sha1: Some(o.hash.clone()),
            size: Some(o.size),
        })
        .collect();
    net::download_many(dls, 32, |d, t| task.progress("Assets", d, t)).await?;

    if !(index.is_virtual || index.map_to_resources) {
        return Ok((idx.id.clone(), assets));
    }
    // Pre-1.7 versions read loose files rather than the hashed object store.
    let target = if index.map_to_resources { game_dir.join("resources") } else { assets.join("virtual").join(&idx.id) };
    let pairs: Vec<(String, String)> = index.objects.iter().map(|(k, o)| (k.clone(), o.hash.clone())).collect();
    let t2 = target.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        for (name, hash) in pairs {
            let Some(dst) = safe_join(&t2, &name) else { continue };
            if dst.exists() || hash.len() < 2 {
                continue;
            }
            if let Some(p) = dst.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(objects.join(&hash[..2]).join(&hash), &dst)?;
        }
        Ok(())
    })
    .await??;
    Ok((idx.id.clone(), target))
}

async fn logging_config(v: &VersionJson) -> Result<Option<String>> {
    let Some(client) = v.logging.as_ref().and_then(|l| l.get("client")) else { return Ok(None) };
    let (Some(arg), Some(id), Some(url)) = (client["argument"].as_str(), client["file"]["id"].as_str(), client["file"]["url"].as_str()) else {
        return Ok(None);
    };
    let path = paths().assets.join("log_configs").join(sanitize_file_name(id));
    net::ensure_file(&Dl {
        url: url.into(),
        path: path.clone(),
        sha1: client["file"]["sha1"].as_str().map(String::from),
        size: client["file"]["size"].as_u64(),
    })
    .await?;
    Ok(Some(arg.replace("${path}", &path.to_string_lossy())))
}
