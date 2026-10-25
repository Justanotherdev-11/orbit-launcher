//! Modrinth + CurseForge browsing/installing, and the instance content lists.
use crate::instances::{self, Instance};
use crate::net::{self, client, Dl};
use crate::settings;
use crate::tasks::Task;
use crate::util::*;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

pub const MR: &str = "https://api.modrinth.com/v2";
const CF: &str = "https://api.curseforge.com/v1";

pub fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
pub fn opt(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(String::from)
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}
fn num(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).unwrap_or(0)
}
fn check_pid(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("Invalid project id");
    }
    Ok(())
}

pub async fn mr_get(path: &str) -> Result<Value> {
    net::get_json(&format!("{MR}{path}")).await
}
pub async fn mr_post(path: &str, body: &Value) -> Result<Value> {
    net::post_json(&format!("{MR}{path}"), body).await
}

fn cf_key() -> Result<String> {
    let k = settings::load().curseforge_key.trim().to_string();
    if k.is_empty() {
        bail!("CF_KEY_MISSING");
    }
    Ok(k)
}
async fn cf_check(resp: reqwest::Response) -> Result<Value> {
    match resp.status().as_u16() {
        401 | 403 => bail!("CurseForge rejected your API key — press Test next to it in Settings → Integrations to see why"),
        code if code >= 400 => bail!("CurseForge responded with {}", resp.status()),
        _ => Ok(resp.json().await?),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    ok: bool,
    message: String,
}

/// Diagnose a CurseForge API key: format problems first, then a real request.
#[tauri::command]
pub async fn test_curseforge_key(key: String) -> KeyCheck {
    let fail = |m: String| KeyCheck { ok: false, message: m };
    let k = key.trim();
    if k.is_empty() {
        return fail("No key entered yet.".into());
    }
    if k.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\u{200b}' | '\u{feff}')) {
        return fail("The key has spaces or hidden characters in it. Copy it again with the copy button next to the key on console.curseforge.com.".into());
    }
    if !k.starts_with("$2a$10$") {
        return fail("That isn't a CurseForge API key — they start with $2a$10$. Copy it from console.curseforge.com → API keys.".into());
    }
    if k.len() < 60 {
        return fail(format!(
            "Only {} of the key's 60 characters are here — the end got cut off. On console.curseforge.com use the copy button next to the key instead of selecting the text.",
            k.len()
        ));
    }
    let resp = client()
        .get(format!("{CF}/games/432"))
        .header("x-api-key", k)
        .header("Accept", "application/json")
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => KeyCheck { ok: true, message: "Key works — CurseForge is connected.".into() },
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => fail(
            "CurseForge refused this key. If you just created or regenerated it, give it a few minutes; otherwise press Regenerate on console.curseforge.com and paste the new one.".into(),
        ),
        Ok(r) => fail(format!("CurseForge answered {} — it may be having problems. Try again shortly.", r.status())),
        Err(_) => fail("Couldn't reach CurseForge — check your internet connection.".into()),
    }
}

#[cfg(test)]
mod toml_tests {
    use super::toml_value;

    #[test]
    fn reads_multiline_descriptions() {
        let toml = "modId=\"jei\"\nversion=\"1.0\"\ndescription='''\nJust Enough Items\nshows recipes.\n'''\nlogoFile=\"logo.png\"\n";
        assert_eq!(toml_value(toml, "description").as_deref(), Some("Just Enough Items\nshows recipes."));
        assert_eq!(toml_value(toml, "modId").as_deref(), Some("jei"));
        assert_eq!(toml_value("description='''One line'''", "description").as_deref(), Some("One line"));
    }
}

#[cfg(test)]
mod key_tests {
    use super::test_curseforge_key;

    #[tokio::test]
    async fn explains_bad_keys() {
        let check = |k: &str| test_curseforge_key(k.to_string());
        assert!(check("").await.message.contains("No key"));
        assert!(check("$2a$10$abc def").await.message.contains("hidden characters"));
        assert!(check("123456").await.message.contains("isn't a CurseForge API key"));
        let partial = check("$2a$10$QTdCthG2QboX1NFfake").await;
        assert!(!partial.ok && partial.message.contains("cut off"), "{}", partial.message);
        let fake = check(&format!("$2a$10${}", "x".repeat(53))).await;
        assert!(!fake.ok && fake.message.contains("refused"), "{}", fake.message);
    }
}

pub async fn cf_get(path: &str) -> Result<Value> {
    let resp = client().get(format!("{CF}{path}")).header("x-api-key", cf_key()?).header("Accept", "application/json").send().await.context("Could not reach CurseForge")?;
    cf_check(resp).await
}
pub async fn cf_post(path: &str, body: &Value) -> Result<Value> {
    let resp = client().post(format!("{CF}{path}")).header("x-api-key", cf_key()?).json(body).send().await.context("Could not reach CurseForge")?;
    cf_check(resp).await
}

pub fn mr_loaders(loader: &str) -> Vec<&'static str> {
    match loader {
        "fabric" => vec!["fabric"],
        "quilt" => vec!["quilt", "fabric"],
        "forge" => vec!["forge"],
        "neoforge" => vec!["neoforge"],
        _ => vec![],
    }
}
fn cf_loader(loader: &str) -> Option<u32> {
    match loader {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}
fn cf_class(kind: &str) -> u32 {
    match kind {
        "modpack" => 4471,
        "resourcepack" => 12,
        "shader" => 6552,
        "datapack" => 6945,
        _ => 6,
    }
}
pub fn kind_from_class(c: u64) -> &'static str {
    match c {
        4471 => "modpack",
        12 => "resourcepack",
        6552 => "shader",
        6945 => "datapack",
        _ => "mod",
    }
}
pub fn folder_for(kind: &str) -> &'static str {
    match kind {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        _ => "mods",
    }
}

// ---------------------------------------------------------------- search

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub source: String,
    pub id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub author: String,
    pub icon: Option<String>,
    pub downloads: u64,
    pub follows: u64,
    pub categories: Vec<String>,
    pub kind: String,
    pub updated: String,
    pub banner: Option<String>,
    pub url: String,
}

#[derive(Serialize)]
pub struct SearchPage {
    hits: Vec<Hit>,
    total: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub source: String,
    pub kind: String,
    #[serde(default)]
    pub query: String,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub offset: u32,
    /// Only projects first released in the last N days (Modrinth), for "popular this week/month".
    #[serde(default)]
    pub since_days: Option<u32>,
}

fn mr_hit(h: &Value) -> Hit {
    let kind = s(&h["project_type"]);
    Hit {
        source: "modrinth".into(),
        id: s(&h["project_id"]),
        slug: s(&h["slug"]),
        title: s(&h["title"]),
        description: s(&h["description"]),
        author: s(&h["author"]),
        icon: opt(&h["icon_url"]),
        downloads: num(&h["downloads"]),
        follows: num(&h["follows"]),
        categories: strs(&h["display_categories"]),
        updated: s(&h["date_modified"]),
        banner: opt(&h["featured_gallery"]).or_else(|| h["gallery"].get(0).and_then(opt)),
        url: format!("https://modrinth.com/{}/{}", kind, s(&h["slug"])),
        kind,
    }
}

fn cf_hit(m: &Value) -> Hit {
    Hit {
        source: "curseforge".into(),
        id: s(&m["id"]),
        slug: s(&m["slug"]),
        title: s(&m["name"]),
        description: s(&m["summary"]),
        author: s(&m["authors"][0]["name"]),
        icon: opt(&m["logo"]["thumbnailUrl"]),
        downloads: num(&m["downloadCount"]),
        follows: num(&m["thumbsUpCount"]),
        categories: m["categories"].as_array().map(|a| a.iter().map(|c| s(&c["name"])).collect()).unwrap_or_default(),
        kind: kind_from_class(num(&m["classId"])).into(),
        updated: s(&m["dateModified"]),
        banner: m["screenshots"].get(0).and_then(|x| opt(&x["url"])),
        url: s(&m["links"]["websiteUrl"]),
    }
}

#[tauri::command]
pub async fn search_content(query: SearchQuery) -> CmdResult<SearchPage> {
    search(query).await.map_err(err)
}

async fn search(q: SearchQuery) -> Result<SearchPage> {
    let limit = 24;
    let gv = q.game_version.as_deref().filter(|v| !v.is_empty());
    let loader = q.loader.as_deref().filter(|l| !l.is_empty() && *l != "vanilla");
    let loader_applies = matches!(q.kind.as_str(), "mod" | "modpack");
    if q.source == "curseforge" {
        let sort = match q.sort.as_str() {
            "downloads" => 6,
            "updated" | "newest" => 3,
            _ => 2,
        };
        let mut url = format!("/mods/search?gameId=432&classId={}&sortField={sort}&sortOrder=desc&pageSize={limit}&index={}", cf_class(&q.kind), q.offset.min(9975));
        if !q.query.trim().is_empty() {
            url += &format!("&searchFilter={}", urlencoding::encode(q.query.trim()));
        }
        if let Some(v) = gv {
            url += &format!("&gameVersion={}", urlencoding::encode(v));
        }
        if let (true, Some(l)) = (loader_applies, loader.and_then(cf_loader)) {
            url += &format!("&modLoaderType={l}");
        }
        let r = cf_get(&url).await?;
        let hits = r["data"].as_array().map(|a| a.iter().map(cf_hit).collect()).unwrap_or_default();
        return Ok(SearchPage { hits, total: num(&r["pagination"]["totalCount"]).min(10000) });
    }
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{}", q.kind)]];
    if let Some(v) = gv {
        facets.push(vec![format!("versions:{v}")]);
    }
    if let Some(days) = q.since_days.filter(|d| *d > 0) {
        facets.push(vec![format!("created_timestamp>={}", now() - days as i64 * 86400)]);
    }
    if let (true, Some(l)) = (loader_applies, loader) {
        let ls = mr_loaders(l);
        if !ls.is_empty() {
            facets.push(ls.iter().map(|l| format!("categories:{l}")).collect());
        }
    }
    let index = match q.sort.as_str() {
        "downloads" | "follows" | "newest" | "updated" => q.sort.as_str(),
        _ => "relevance",
    };
    let mut url = format!("/search?limit={limit}&offset={}&index={index}&facets={}", q.offset, urlencoding::encode(&serde_json::to_string(&facets)?));
    if !q.query.trim().is_empty() {
        url += &format!("&query={}", urlencoding::encode(q.query.trim()));
    }
    let r = mr_get(&url).await?;
    let hits = r["hits"].as_array().map(|a| a.iter().map(mr_hit).collect()).unwrap_or_default();
    Ok(SearchPage { hits, total: num(&r["total_hits"]) })
}

// ---------------------------------------------------------------- project details

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    label: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    body: String,
    format: String,
    gallery: Vec<String>,
    links: Vec<Link>,
}

#[tauri::command]
pub async fn get_project(source: String, id: String) -> CmdResult<ProjectDetail> {
    project_detail(&source, &id).await.map_err(err)
}

async fn project_detail(source: &str, id: &str) -> Result<ProjectDetail> {
    check_pid(id)?;
    let mut links = vec![];
    let mut push = |label: &str, v: &Value| {
        if let Some(u) = opt(v) {
            links.push(Link { label: label.into(), url: u });
        }
    };
    if source == "curseforge" {
        let (mp, dp) = (format!("/mods/{id}"), format!("/mods/{id}/description"));
        let (m, d) = tokio::try_join!(cf_get(&mp), cf_get(&dp))?;
        let m = &m["data"];
        push("CurseForge", &m["links"]["websiteUrl"]);
        push("Source", &m["links"]["sourceUrl"]);
        push("Issues", &m["links"]["issuesUrl"]);
        push("Wiki", &m["links"]["wikiUrl"]);
        let gallery = m["screenshots"].as_array().map(|a| a.iter().filter_map(|x| opt(&x["url"])).collect()).unwrap_or_default();
        return Ok(ProjectDetail { body: s(&d["data"]), format: "html".into(), gallery, links });
    }
    let p = mr_get(&format!("/project/{id}")).await?;
    push("Modrinth", &json!(format!("https://modrinth.com/{}/{}", s(&p["project_type"]), s(&p["slug"]))));
    push("Source", &p["source_url"]);
    push("Issues", &p["issues_url"]);
    push("Wiki", &p["wiki_url"]);
    push("Discord", &p["discord_url"]);
    let mut gallery: Vec<(bool, i64, String)> = p["gallery"]
        .as_array()
        .map(|a| a.iter().filter_map(|g| Some((!g["featured"].as_bool().unwrap_or(false), g["ordering"].as_i64().unwrap_or(0), opt(&g["url"])?))).collect())
        .unwrap_or_default();
    gallery.sort();
    Ok(ProjectDetail { body: s(&p["body"]), format: "markdown".into(), gallery: gallery.into_iter().map(|g| g.2).collect(), links })
}

// ---------------------------------------------------------------- versions

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub required: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub date: String,
    pub kind: String,
    pub downloads: u64,
    pub file_name: String,
    pub url: Option<String>,
    pub sha1: Option<String>,
    pub size: u64,
    pub deps: Vec<Dep>,
}

pub fn mr_version(v: &Value) -> Option<VersionEntry> {
    let files = v["files"].as_array()?;
    let f = files.iter().find(|f| f["primary"].as_bool() == Some(true)).or(files.first())?;
    Some(VersionEntry {
        id: s(&v["id"]),
        project_id: s(&v["project_id"]),
        name: s(&v["name"]),
        number: s(&v["version_number"]),
        game_versions: strs(&v["game_versions"]),
        loaders: strs(&v["loaders"]),
        date: s(&v["date_published"]),
        kind: s(&v["version_type"]),
        downloads: num(&v["downloads"]),
        file_name: s(&f["filename"]),
        url: opt(&f["url"]),
        sha1: opt(&f["hashes"]["sha1"]),
        size: num(&f["size"]),
        deps: v["dependencies"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|d| Dep { project_id: opt(&d["project_id"]), version_id: opt(&d["version_id"]), required: d["dependency_type"].as_str() == Some("required") })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn cf_file(f: &Value) -> Option<VersionEntry> {
    let gvs = strs(&f["gameVersions"]);
    let loaders = ["Forge", "Fabric", "Quilt", "NeoForge"];
    Some(VersionEntry {
        id: f["id"].as_u64()?.to_string(),
        project_id: s(&f["modId"]),
        name: s(&f["displayName"]),
        number: s(&f["displayName"]),
        game_versions: gvs.iter().filter(|g| g.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)).cloned().collect(),
        loaders: gvs.iter().filter(|g| loaders.contains(&g.as_str())).map(|g| g.to_lowercase()).collect(),
        date: s(&f["fileDate"]),
        kind: match f["releaseType"].as_u64() {
            Some(2) => "beta",
            Some(3) => "alpha",
            _ => "release",
        }
        .into(),
        downloads: num(&f["downloadCount"]),
        file_name: s(&f["fileName"]),
        url: opt(&f["downloadUrl"]),
        sha1: f["hashes"].as_array().and_then(|h| h.iter().find(|x| x["algo"].as_u64() == Some(1))).and_then(|x| opt(&x["value"])),
        size: num(&f["fileLength"]),
        deps: f["dependencies"]
            .as_array()
            .map(|a| a.iter().filter(|d| d["relationType"].as_u64() == Some(3)).map(|d| Dep { project_id: Some(s(&d["modId"])), version_id: None, required: true }).collect())
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn get_project_versions(source: String, project_id: String, game_version: Option<String>, loader: Option<String>) -> CmdResult<Vec<VersionEntry>> {
    list_versions(&source, &project_id, game_version.as_deref(), loader.as_deref()).await.map_err(err)
}

pub async fn list_versions(source: &str, pid: &str, gv: Option<&str>, loader: Option<&str>) -> Result<Vec<VersionEntry>> {
    check_pid(pid)?;
    let gv = gv.filter(|v| !v.is_empty());
    let loader = loader.filter(|l| !l.is_empty() && *l != "vanilla");
    if source == "curseforge" {
        let mut base = format!("/mods/{pid}/files?pageSize=50");
        if let Some(v) = gv {
            base += &format!("&gameVersion={}", urlencoding::encode(v));
        }
        // Quilt runs Fabric mods, so a Quilt instance accepts Fabric builds too (same as Modrinth).
        let loader_types: Vec<Option<u32>> = match loader {
            Some("quilt") => vec![Some(5), Some(4)],
            Some(l) => vec![cf_loader(l)],
            None => vec![None],
        };
        let mut list: Vec<VersionEntry> = vec![];
        for lt in loader_types {
            let url = match lt {
                Some(l) => format!("{base}&modLoaderType={l}"),
                None => base.clone(),
            };
            let r = cf_get(&url).await?;
            for f in r["data"].as_array().into_iter().flatten().filter_map(cf_file) {
                if !list.iter().any(|x| x.id == f.id) {
                    list.push(f);
                }
            }
        }
        list.sort_by(|a, b| b.date.cmp(&a.date));
        return Ok(list);
    }
    let mut params = vec![];
    if let Some(v) = gv {
        params.push(format!("game_versions={}", urlencoding::encode(&json!([v]).to_string())));
    }
    if let Some(l) = loader {
        let ls = mr_loaders(l);
        if !ls.is_empty() {
            params.push(format!("loaders={}", urlencoding::encode(&json!(ls).to_string())));
        }
    }
    let q = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
    let r = mr_get(&format!("/project/{pid}/version{q}")).await?;
    Ok(r.as_array().map(|a| a.iter().filter_map(mr_version).collect()).unwrap_or_default())
}

pub async fn single_version(source: &str, pid: &str, vid: &str) -> Result<VersionEntry> {
    check_pid(vid)?;
    if source == "curseforge" {
        check_pid(pid)?;
        let r = cf_get(&format!("/mods/{pid}/files/{vid}")).await?;
        cf_file(&r["data"]).ok_or_else(|| anyhow!("CurseForge returned an unreadable file"))
    } else {
        mr_version(&mr_get(&format!("/version/{vid}")).await?).ok_or_else(|| anyhow!("Modrinth returned an unreadable version"))
    }
}

pub struct ProjectInfo {
    pub slug: String,
    pub title: String,
    pub icon: Option<String>,
    pub kind: String,
    pub url: String,
}

pub async fn project_info(source: &str, id: &str) -> Result<ProjectInfo> {
    check_pid(id)?;
    if source == "curseforge" {
        let m = cf_get(&format!("/mods/{id}")).await?;
        let m = &m["data"];
        return Ok(ProjectInfo { slug: s(&m["slug"]), title: s(&m["name"]), icon: opt(&m["logo"]["thumbnailUrl"]), kind: kind_from_class(num(&m["classId"])).into(), url: s(&m["links"]["websiteUrl"]) });
    }
    let p = mr_get(&format!("/project/{id}")).await?;
    let kind = s(&p["project_type"]);
    Ok(ProjectInfo { slug: s(&p["slug"]), title: s(&p["title"]), icon: opt(&p["icon_url"]), url: format!("https://modrinth.com/{}/{}", kind, s(&p["slug"])), kind })
}

fn prefer_release(list: &[VersionEntry]) -> Option<VersionEntry> {
    list.iter().find(|v| v.kind == "release").or(list.first()).cloned()
}

// ---------------------------------------------------------------- content metadata

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentMeta {
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    pub title: String,
    pub icon: Option<String>,
    pub version: String,
}

fn meta_path(id: &str) -> PathBuf {
    instances::dir(id).join("content.json")
}
pub fn load_meta(id: &str) -> HashMap<String, ContentMeta> {
    read_json(&meta_path(id)).unwrap_or_default()
}
pub fn save_meta(id: &str, m: &HashMap<String, ContentMeta>) -> Result<()> {
    write_json(&meta_path(id), m)
}

fn strip_disabled(name: &str) -> &str {
    name.strip_suffix(".disabled").unwrap_or(name)
}

// ---------------------------------------------------------------- install

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    installed: Vec<String>,
    skipped: Vec<String>,
}

#[tauri::command]
pub async fn install_content(app: AppHandle, instance_id: String, source: String, project_id: String, version_id: Option<String>, kind: String) -> CmdResult<InstallResult> {
    let inst = instances::load(&instance_id).map_err(err)?;
    if crate::launch::is_running(&app, &instance_id) {
        return Err(format!("Close {} first — Windows locks mod files while the game is running", inst.name));
    }
    let task = Task::new(&app, format!("Installing to {}", inst.name));
    match install(&task, &inst, &source, &project_id, version_id, &kind).await {
        Ok(r) => {
            task.done(&format!("Installed {}", r.installed.join(", ")));
            Ok(r)
        }
        Err(e) => {
            task.fail(&format!("{e:#}"));
            Err(err(e))
        }
    }
}

async fn install(task: &Task, inst: &Instance, source: &str, root_pid: &str, root_vid: Option<String>, root_kind: &str) -> Result<InstallResult> {
    let game = instances::game_dir(&inst.id);
    let mut meta = load_meta(&inst.id);
    let mut queue: VecDeque<(String, Option<String>)> = VecDeque::from([(root_pid.to_string(), root_vid)]);
    let mut seen = HashSet::new();
    let mut installed = vec![];
    let mut skipped = vec![];
    let mut first = true;
    // Mod ids of the jars already present (from any source — a pack, another site, a manual copy),
    // so a dependency like Fabric API isn't downloaded a second time under another file name.
    let mods_dir = game.join("mods");
    let local_ids: HashSet<String> = tokio::task::spawn_blocking(move || {
        std::fs::read_dir(&mods_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| parse_local(&e.path(), &e.path().to_string_lossy()).mod_id)
            .map(|id| norm_id(&id))
            .collect()
    })
    .await
    .unwrap_or_default();
    while let Some((pid, vid)) = queue.pop_front() {
        let is_root = std::mem::replace(&mut first, false);
        if !seen.insert(pid.clone()) {
            continue;
        }
        if !is_root && meta.values().any(|m| m.source == source && m.project_id == pid) {
            continue;
        }
        let info = project_info(source, &pid).await?;
        if !is_root && !info.slug.is_empty() && local_ids.contains(&norm_id(&info.slug)) {
            continue;
        }
        let kind = if is_root { root_kind.to_string() } else { info.kind.clone() };
        task.step(&format!("Resolving {}", info.title));
        let ver = match vid {
            Some(v) => Some(single_version(source, &pid, &v).await?),
            None => {
                let loader = if kind == "mod" { Some(inst.loader.as_str()) } else { None };
                prefer_release(&list_versions(source, &pid, Some(&inst.mc_version), loader).await?)
            }
        };
        let Some(ver) = ver else {
            if is_root {
                bail!("No version of {} supports Minecraft {} ({})", info.title, inst.mc_version, inst.loader);
            }
            skipped.push(format!("{} (no compatible version)", info.title));
            continue;
        };
        let Some(url) = ver.url.clone() else {
            if is_root {
                bail!("BLOCKED:{}", info.url);
            }
            skipped.push(format!("{} (download blocked by author)", info.title));
            continue;
        };
        let folder = folder_for(&kind);
        let file_name = sanitize_file_name(&ver.file_name);
        let key = format!("{folder}/{file_name}");
        // Older copies of this project (from a previous install or update).
        let old: Vec<String> = meta.iter().filter(|(_, m)| m.source == source && m.project_id == pid).map(|(k, _)| k.clone()).collect();
        let was_disabled = std::iter::once(&key).chain(old.iter()).any(|k| game.join(format!("{k}.disabled")).exists());
        task.step(&format!("Downloading {}", info.title));
        // Download first: if it fails, the copy the player already has is untouched.
        net::download(&Dl { url, path: game.join(folder).join(&file_name), sha1: ver.sha1.clone(), size: None }).await?;
        for k in &old {
            if *k != key {
                remove_if_exists(&game.join(k))?;
                remove_if_exists(&game.join(format!("{k}.disabled")))?;
                crate::modpacks::retrack(&inst.id, k, &key);
            }
            meta.remove(k);
        }
        settle_disabled(&game, &key, was_disabled)?;
        meta.insert(key, ContentMeta { source: source.into(), project_id: pid.clone(), version_id: ver.id.clone(), title: info.title.clone(), icon: info.icon.clone(), version: ver.number.clone() });
        save_meta(&inst.id, &meta)?;
        installed.push(info.title);
        if kind == "mod" {
            for d in ver.deps.iter().filter(|d| d.required) {
                match (&d.project_id, &d.version_id) {
                    (Some(p), v) => queue.push_back((p.clone(), v.clone())),
                    (None, Some(v)) if source == "modrinth" => {
                        if let Some(e) = mr_get(&format!("/version/{v}")).await.ok().and_then(|x| mr_version(&x)) {
                            queue.push_back((e.project_id, Some(e.id)));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(InstallResult { installed, skipped })
}

/// Copy files dropped onto the window into an instance folder.
#[tauri::command]
pub async fn add_local_files(instance_id: String, kind: String, paths: Vec<String>) -> CmdResult<usize> {
    // Off the main thread: dropping a big world folder must not freeze the window.
    tokio::task::spawn_blocking(move || add_local_blocking(instance_id, kind, paths)).await.map_err(err)?
}

fn add_local_blocking(instance_id: String, kind: String, paths: Vec<String>) -> CmdResult<usize> {
    instances::valid_id(&instance_id).map_err(err)?;
    let folder = match kind.as_str() {
        "world" => "saves",
        k => folder_for(k),
    };
    let dest = instances::game_dir(&instance_id).join(folder);
    std::fs::create_dir_all(&dest).map_err(err)?;
    let mut n = 0;
    for p in paths {
        let src = PathBuf::from(&p);
        let Some(name) = src.file_name() else { continue };
        if src.is_dir() {
            copy_dir(&src, &dest.join(name), &mut || {}).map_err(err)?;
        } else {
            std::fs::copy(&src, dest.join(name)).map_err(err)?;
        }
        n += 1;
    }
    Ok(n)
}

/// "Fabric_API" and "fabric-api" are the same mod.
fn norm_id(id: &str) -> String {
    id.to_lowercase().replace('_', "-")
}

fn remove_if_exists(p: &Path) -> Result<()> {
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow!(e).context(format!("Couldn't remove {} — is the game still running?", p.display()))),
    }
}

/// After writing `key`, make sure exactly one copy exists, disabled if the old one was.
fn settle_disabled(game: &Path, key: &str, disabled: bool) -> Result<()> {
    let on = game.join(key);
    let off = game.join(format!("{key}.disabled"));
    remove_if_exists(&off)?;
    if disabled {
        std::fs::rename(&on, &off)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- listing

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalMeta {
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub authors: Vec<String>,
    pub icon: Option<String>,
    pub mod_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentItem {
    file: String,
    file_name: String,
    enabled: bool,
    size: u64,
    modified: i64,
    local: LocalMeta,
    meta: Option<ContentMeta>,
}

static LOCAL_CACHE: Mutex<Option<HashMap<String, LocalMeta>>> = Mutex::new(None);

fn icon_cache_path(key: &str, ext: &str) -> PathBuf {
    let h = sha1_smol::Sha1::from(key).digest().to_string();
    paths().cache.join("icons").join(format!("{}.{ext}", &h[..16]))
}

fn flatten_text(v: &Value) -> String {
    let raw = match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(flatten_text).collect(),
        Value::Object(o) => {
            let mut t = o.get("text").map(flatten_text).unwrap_or_default();
            if let Some(extra) = o.get("extra") {
                t.push_str(&flatten_text(extra));
            }
            t
        }
        _ => String::new(),
    };
    // Strip § formatting codes.
    let mut out = String::new();
    let mut skip = false;
    for c in raw.chars() {
        if skip {
            skip = false;
        } else if c == '§' {
            skip = true;
        } else {
            out.push(c);
        }
    }
    out
}

fn toml_value(section: &str, key: &str) -> Option<String> {
    let mut offset = 0;
    for line in section.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let l = line.trim();
        let Some(rest) = l.strip_prefix(key) else { continue };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim();
        // Multi-line string: the value runs from just after the opening quotes to the closing
        // ones, which are often several lines further down.
        for q in ["'''", "\"\"\""] {
            if rest.starts_with(q) {
                let open = line_start + line.find(q)? + q.len();
                let body = &section[open..];
                let end = body.find(q)?;
                return Some(body[..end].trim().to_string());
            }
        }
        let q = rest.chars().next()?;
        if q == '"' || q == '\'' {
            let inner = &rest[1..];
            return inner.find(q).map(|e| inner[..e].to_string());
        }
    }
    None
}

fn read_entry(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut e = z.by_name(name).ok()?;
    let mut buf = vec![];
    e.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn parse_local(path: &Path, cache_key: &str) -> LocalMeta {
    let mut m = LocalMeta::default();
    let Ok(f) = std::fs::File::open(path) else { return m };
    let Ok(mut z) = zip::ZipArchive::new(f) else { return m };
    let mut icon_entry: Option<String> = None;

    if let Some(b) = read_entry(&mut z, "fabric.mod.json") {
        let text = String::from_utf8_lossy(&b).replace(['\n', '\r', '\t'], " ");
        if let Ok(j) = serde_json::from_str::<Value>(&text) {
            m.mod_id = opt(&j["id"]);
            m.name = opt(&j["name"]).or_else(|| m.mod_id.clone());
            m.version = opt(&j["version"]);
            m.description = opt(&j["description"]);
            m.authors = j["authors"].as_array().map(|a| a.iter().filter_map(|x| opt(x).or_else(|| opt(&x["name"]))).collect()).unwrap_or_default();
            icon_entry = match &j["icon"] {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o.iter().max_by_key(|(k, _)| k.parse::<u32>().unwrap_or(0)).and_then(|(_, v)| opt(v)),
                _ => None,
            };
        }
    } else if let Some(b) = read_entry(&mut z, "quilt.mod.json") {
        if let Ok(j) = serde_json::from_slice::<Value>(&b) {
            let q = &j["quilt_loader"];
            m.mod_id = opt(&q["id"]);
            m.name = opt(&q["metadata"]["name"]).or_else(|| m.mod_id.clone());
            m.version = opt(&q["version"]);
            m.description = opt(&q["metadata"]["description"]);
            m.authors = q["metadata"]["contributors"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            icon_entry = opt(&q["metadata"]["icon"]);
        }
    } else if let Some(b) = read_entry(&mut z, "META-INF/neoforge.mods.toml").or_else(|| read_entry(&mut z, "META-INF/mods.toml")) {
        let text = String::from_utf8_lossy(&b).to_string();
        let section = text.split("[[mods]]").nth(1).unwrap_or(&text);
        let section = section.split("\n[").next().unwrap_or(section);
        m.mod_id = toml_value(section, "modId");
        m.name = toml_value(section, "displayName").or_else(|| m.mod_id.clone());
        m.version = toml_value(section, "version");
        m.description = toml_value(section, "description");
        m.authors = toml_value(section, "authors").or_else(|| toml_value(&text, "authors")).map(|a| vec![a]).unwrap_or_default();
        icon_entry = toml_value(section, "logoFile").or_else(|| toml_value(&text, "logoFile"));
        if m.version.as_deref().map(|v| v.contains("${")).unwrap_or(false) {
            m.version = read_entry(&mut z, "META-INF/MANIFEST.MF").and_then(|b| {
                String::from_utf8_lossy(&b).lines().find_map(|l| l.strip_prefix("Implementation-Version:").map(|v| v.trim().to_string()))
            });
        }
    } else if let Some(b) = read_entry(&mut z, "mcmod.info") {
        let text = String::from_utf8_lossy(&b).replace(['\n', '\r', '\t'], " ");
        if let Ok(j) = serde_json::from_str::<Value>(&text) {
            let e = if j.is_array() { &j[0] } else { &j["modList"][0] };
            m.mod_id = opt(&e["modid"]);
            m.name = opt(&e["name"]);
            m.version = opt(&e["version"]);
            m.description = opt(&e["description"]);
            m.authors = strs(&e["authorList"]);
            icon_entry = opt(&e["logoFile"]);
        }
    } else if let Some(b) = read_entry(&mut z, "pack.mcmeta") {
        if let Ok(j) = serde_json::from_slice::<Value>(&b) {
            let d = flatten_text(&j["pack"]["description"]);
            if !d.trim().is_empty() {
                m.description = Some(d);
            }
        }
        icon_entry = Some("pack.png".into());
    }

    if let Some(entry) = icon_entry {
        let entry = entry.trim_start_matches('/').to_string();
        let out = icon_cache_path(cache_key, "png");
        if out.exists() {
            m.icon = Some(out.to_string_lossy().into());
        } else if let Some(bytes) = read_entry(&mut z, &entry) {
            let _ = std::fs::create_dir_all(out.parent().unwrap());
            if std::fs::write(&out, bytes).is_ok() {
                m.icon = Some(out.to_string_lossy().into());
            }
        }
    }
    m
}

#[tauri::command]
pub async fn list_content(instance_id: String, kind: String) -> CmdResult<Vec<ContentItem>> {
    instances::valid_id(&instance_id).map_err(err)?;
    tokio::task::spawn_blocking(move || list_blocking(&instance_id, &kind)).await.map_err(err)?.map_err(err)
}

fn list_blocking(id: &str, kind: &str) -> Result<Vec<ContentItem>> {
    let folder = folder_for(kind);
    let dir = instances::game_dir(id).join(folder);
    std::fs::create_dir_all(&dir)?;
    let meta = load_meta(id);
    let mut out = vec![];
    for e in std::fs::read_dir(&dir)?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let base = strip_disabled(&name).to_string();
        let lower = base.to_lowercase();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir && !(lower.ends_with(".jar") || lower.ends_with(".zip") || lower.ends_with(".litemod")) {
            continue;
        }
        let md = e.metadata()?;
        let modified = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
        let cache_key = format!("{}|{}|{}", e.path().display(), md.len(), modified);
        let local = if is_dir {
            LocalMeta::default()
        } else {
            let cached = LOCAL_CACHE.lock().unwrap().as_ref().and_then(|c| c.get(&cache_key).cloned());
            match cached {
                Some(c) => c,
                None => {
                    let parsed = parse_local(&e.path(), &cache_key);
                    LOCAL_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(cache_key, parsed.clone());
                    parsed
                }
            }
        };
        out.push(ContentItem {
            file: format!("{folder}/{name}"),
            file_name: base.clone(),
            enabled: !name.ends_with(".disabled"),
            size: if is_dir { dir_size(&e.path()) } else { md.len() },
            modified,
            local,
            meta: meta.get(&format!("{folder}/{base}")).cloned(),
        });
    }
    out.sort_by_key(|a| {
        a.meta.as_ref().map(|m| m.title.clone()).or_else(|| a.local.name.clone()).unwrap_or_else(|| a.file_name.clone()).to_lowercase()
    });
    Ok(out)
}

fn content_path(id: &str, file: &str) -> Result<PathBuf> {
    instances::valid_id(id)?;
    let top = file.split('/').next().unwrap_or("");
    if !matches!(top, "mods" | "resourcepacks" | "shaderpacks") {
        bail!("Bad path");
    }
    safe_join(&instances::game_dir(id), file).ok_or_else(|| anyhow!("Bad path"))
}

#[tauri::command]
pub fn toggle_content(instance_id: String, file: String) -> CmdResult<String> {
    let p = content_path(&instance_id, &file).map_err(err)?;
    let new = match file.strip_suffix(".disabled") {
        Some(f) => f.to_string(),
        None => format!("{file}.disabled"),
    };
    let np = content_path(&instance_id, &new).map_err(err)?;
    if np.exists() {
        return Err("There are two copies of this file (one enabled, one disabled) — delete one first".into());
    }
    std::fs::rename(&p, &np).map_err(err)?;
    Ok(new)
}

#[tauri::command]
pub fn set_content_enabled(instance_id: String, files: Vec<String>, enabled: bool) -> CmdResult<()> {
    for file in files {
        let is_disabled = file.ends_with(".disabled");
        if is_disabled == !enabled {
            continue;
        }
        let new = if enabled { file.trim_end_matches(".disabled").to_string() } else { format!("{file}.disabled") };
        let (from, to) = (content_path(&instance_id, &file).map_err(err)?, content_path(&instance_id, &new).map_err(err)?);
        if to.exists() {
            continue; // the other copy already exists; never overwrite it
        }
        std::fs::rename(from, to).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_content(instance_id: String, files: Vec<String>) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || delete_blocking(instance_id, files)).await.map_err(err)?
}

fn delete_blocking(instance_id: String, files: Vec<String>) -> CmdResult<()> {
    let mut meta = load_meta(&instance_id);
    for file in files {
        let p = content_path(&instance_id, &file).map_err(err)?;
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(err)?;
        } else {
            std::fs::remove_file(&p).map_err(err)?;
        }
        meta.remove(strip_disabled(&file));
    }
    save_meta(&instance_id, &meta).map_err(err)
}

// ---------------------------------------------------------------- identify + updates (Modrinth hash lookups)

fn hash_folder(id: &str, folder: &str) -> Vec<(String, String)> {
    let dir = instances::game_dir(id).join(folder);
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if let Ok(h) = sha1_file(&e.path()) {
                out.push((format!("{folder}/{name}"), h));
            }
        }
    }
    out
}

/// Look up unknown files on Modrinth by hash so they get proper titles, icons and update checks.
#[tauri::command]
pub async fn identify_content(instance_id: String) -> CmdResult<usize> {
    identify(&instance_id).await.map_err(err)
}

async fn identify(id: &str) -> Result<usize> {
    instances::valid_id(id)?;
    let meta = load_meta(id);
    let id2 = id.to_string();
    let files: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
        ["mods", "resourcepacks", "shaderpacks"].iter().flat_map(|f| hash_folder(&id2, f)).collect::<Vec<_>>()
    })
    .await?
    .into_iter()
    .filter(|(f, _)| !meta.contains_key(strip_disabled(f)))
    .collect();
    if files.is_empty() {
        return Ok(0);
    }
    let hashes: Vec<&String> = files.iter().map(|(_, h)| h).collect();
    let found = mr_post("/version_files", &json!({ "hashes": hashes, "algorithm": "sha1" })).await?;
    let pids: Vec<String> = found.as_object().map(|o| o.values().map(|v| s(&v["project_id"])).collect::<HashSet<_>>().into_iter().collect()).unwrap_or_default();
    if pids.is_empty() {
        return Ok(0);
    }
    let projects = mr_get(&format!("/projects?ids={}", urlencoding::encode(&json!(pids).to_string()))).await?;
    let by_id: HashMap<String, &Value> = projects.as_array().map(|a| a.iter().map(|p| (s(&p["id"]), p)).collect()).unwrap_or_default();
    let mut meta = load_meta(id);
    let mut n = 0;
    for (file, hash) in files {
        let Some(v) = found.get(&hash) else { continue };
        let Some(p) = by_id.get(&s(&v["project_id"])) else { continue };
        meta.insert(
            strip_disabled(&file).to_string(),
            ContentMeta { source: "modrinth".into(), project_id: s(&p["id"]), version_id: s(&v["id"]), title: s(&p["title"]), icon: opt(&p["icon_url"]), version: s(&v["version_number"]) },
        );
        n += 1;
    }
    save_meta(id, &meta)?;
    Ok(n)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    file: String,
    title: String,
    icon: Option<String>,
    current: String,
    latest: String,
    version_id: String,
    project_id: String,
}

#[tauri::command]
pub async fn check_updates(instance_id: String) -> CmdResult<Vec<UpdateInfo>> {
    updates(&instance_id).await.map_err(err)
}

async fn updates(id: &str) -> Result<Vec<UpdateInfo>> {
    let inst = instances::load(id)?;
    let meta = load_meta(id);
    let mut out = vec![];
    for folder in ["mods", "resourcepacks", "shaderpacks"] {
        let id2 = id.to_string();
        let files = tokio::task::spawn_blocking(move || hash_folder(&id2, folder)).await?;
        if files.is_empty() {
            continue;
        }
        let hashes: Vec<&String> = files.iter().map(|(_, h)| h).collect();
        let mut body = json!({ "hashes": hashes, "algorithm": "sha1", "game_versions": [inst.mc_version] });
        if folder == "mods" {
            body["loaders"] = json!(mr_loaders(&inst.loader));
        }
        let Ok(resp) = mr_post("/version_files/update", &body).await else { continue };
        for (file, hash) in &files {
            let Some(v) = resp.get(hash).and_then(mr_version) else { continue };
            if v.sha1.as_deref() == Some(hash.as_str()) {
                continue;
            }
            let m = meta.get(strip_disabled(file));
            out.push(UpdateInfo {
                file: file.clone(),
                title: m.map(|m| m.title.clone()).unwrap_or_else(|| strip_disabled(file).rsplit('/').next().unwrap_or(file).to_string()),
                icon: m.and_then(|m| m.icon.clone()),
                current: m.map(|m| m.version.clone()).unwrap_or_default(),
                latest: v.number.clone(),
                version_id: v.id.clone(),
                project_id: v.project_id.clone(),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn apply_update(app: AppHandle, instance_id: String, file: String, version_id: String) -> CmdResult<()> {
    if crate::launch::is_running(&app, &instance_id) {
        return Err("Close the game first — Windows locks mod files while it's running".into());
    }
    apply(&instance_id, &file, &version_id).await.map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    file: String,
    version_id: String,
    #[serde(default)]
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    updated: usize,
    failed: Vec<String>,
}

/// Apply several updates to one instance, with progress in the task tray.
#[tauri::command]
pub async fn apply_updates(app: AppHandle, instance_id: String, updates: Vec<PendingUpdate>) -> CmdResult<BatchResult> {
    let inst = instances::load(&instance_id).map_err(err)?;
    if crate::launch::is_running(&app, &instance_id) {
        return Err(format!("Close {} first — its mods are in use", inst.name));
    }
    let task = Task::new(&app, format!("Updating {}", inst.name));
    let total = updates.len();
    let mut result = BatchResult { updated: 0, failed: vec![] };
    for (i, u) in updates.iter().enumerate() {
        let label = if u.title.is_empty() { u.file.rsplit('/').next().unwrap_or(&u.file).to_string() } else { u.title.clone() };
        task.progress(&label, i, total);
        match apply(&instance_id, &u.file, &u.version_id).await {
            Ok(()) => result.updated += 1,
            Err(e) => result.failed.push(format!("{label}: {e:#}")),
        }
    }
    if result.failed.is_empty() {
        task.done(&format!("Updated {} file{}", result.updated, if result.updated == 1 { "" } else { "s" }));
    } else {
        task.fail(&format!("{} updated, {} failed:\n{}", result.updated, result.failed.len(), result.failed.join("\n")));
    }
    Ok(result)
}

async fn apply(id: &str, file: &str, vid: &str) -> Result<()> {
    let old = content_path(id, file)?;
    let v = single_version("modrinth", "", vid).await?;
    let url = v.url.clone().ok_or_else(|| anyhow!("No download"))?;
    let folder = file.split('/').next().unwrap_or("mods");
    let disabled = file.ends_with(".disabled");
    let new_name = sanitize_file_name(&v.file_name);
    let dest_name = if disabled { format!("{new_name}.disabled") } else { new_name.clone() };
    let dest = instances::game_dir(id).join(folder).join(&dest_name);
    net::download(&Dl { url, path: dest.clone(), sha1: v.sha1.clone(), size: None }).await?;
    if dest != old {
        // Report a failed removal instead of silently leaving two versions of the mod.
        remove_if_exists(&old)?;
        crate::modpacks::retrack(id, strip_disabled(file), &format!("{folder}/{new_name}"));
    }
    let mut meta = load_meta(id);
    let prev = meta.remove(strip_disabled(file)).unwrap_or_default();
    let title = if prev.title.is_empty() { project_info("modrinth", &v.project_id).await.map(|p| p.title).unwrap_or_default() } else { prev.title.clone() };
    meta.insert(format!("{folder}/{new_name}"), ContentMeta { source: "modrinth".into(), project_id: v.project_id, version_id: v.id, title, icon: prev.icon, version: v.number });
    save_meta(id, &meta)
}
