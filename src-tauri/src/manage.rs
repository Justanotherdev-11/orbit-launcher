//! Per-instance pages: worlds, servers, screenshots, logs.
use crate::instances;
use crate::nbt::{self, Tag};
use crate::net::client;
use crate::util::*;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

fn mtime(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sub_path(id: &str, folder: &str, name: &str) -> Result<PathBuf> {
    instances::valid_id(id)?;
    if name.is_empty() || name.contains(['/', '\\']) || name == ".." || name == "." {
        bail!("Bad name");
    }
    Ok(instances::game_dir(id).join(folder).join(name))
}

// ---------------------------------------------------------------- worlds

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    folder: String,
    name: String,
    last_played: i64,
    mode: String,
    hardcore: bool,
    version: String,
    seed: Option<String>,
    icon: Option<String>,
    size: u64,
}

#[tauri::command]
pub async fn list_worlds(instance_id: String) -> CmdResult<Vec<World>> {
    instances::valid_id(&instance_id).map_err(err)?;
    tokio::task::spawn_blocking(move || {
        let dir = instances::game_dir(&instance_id).join("saves");
        let mut out = vec![];
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let folder = e.file_name().to_string_lossy().to_string();
            let level = std::fs::read(p.join("level.dat")).ok().and_then(|d| nbt::parse(&d).ok());
            let data = level.as_ref().and_then(|l| l.get("Data"));
            let g = |k: &str| data.and_then(|d| d.get(k));
            let mode = match g("GameType").and_then(|t| t.int()) {
                Some(1) => "Creative",
                Some(2) => "Adventure",
                Some(3) => "Spectator",
                _ => "Survival",
            };
            let seed = g("WorldGenSettings").and_then(|w| w.get("seed")).or_else(|| g("RandomSeed")).and_then(|s| s.int()).map(|s| s.to_string());
            let icon = p.join("icon.png");
            out.push(World {
                name: g("LevelName").and_then(|n| n.str()).map(String::from).unwrap_or_else(|| folder.clone()),
                last_played: g("LastPlayed").and_then(|t| t.int()).map(|ms| ms / 1000).unwrap_or_else(|| mtime(&p)),
                mode: mode.into(),
                hardcore: g("hardcore").and_then(|h| h.int()) == Some(1),
                version: g("Version").and_then(|v| v.get("Name")).and_then(|n| n.str()).unwrap_or("").to_string(),
                seed,
                icon: icon.exists().then(|| icon.to_string_lossy().to_string()),
                size: dir_size(&p),
                folder,
            });
        }
        out.sort_by(|a, b| b.last_played.cmp(&a.last_played));
        out
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn delete_world(instance_id: String, folder: String) -> CmdResult<()> {
    let p = sub_path(&instance_id, "saves", &folder).map_err(err)?;
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(p)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn backup_world(instance_id: String, folder: String) -> CmdResult<String> {
    let p = sub_path(&instance_id, "saves", &folder).map_err(err)?;
    let backups = instances::game_dir(&instance_id).join("backups");
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let target = backups.join(format!("{folder}_{stamp}.zip"));
    let t2 = target.clone();
    tokio::task::spawn_blocking(move || zip_dir(&p, &t2)).await.map_err(err)?.map_err(err)?;
    Ok(target.to_string_lossy().into())
}

fn zip_dir(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let mut z = zip::ZipWriter::new(std::fs::File::create(dest)?);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let root = src.parent().unwrap_or(src);
    fn walk(dir: &Path, root: &Path, z: &mut zip::ZipWriter<std::fs::File>, opts: zip::write::SimpleFileOptions) -> Result<()> {
        for e in std::fs::read_dir(dir)?.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                walk(&p, root, z, opts)?;
            } else if rel != "session.lock" && !rel.ends_with("/session.lock") {
                z.start_file(rel, opts)?;
                std::io::copy(&mut std::fs::File::open(&p)?, z)?;
            }
        }
        Ok(())
    }
    walk(src, root, &mut z, opts)?;
    z.finish()?;
    Ok(())
}

// ---------------------------------------------------------------- servers

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    name: String,
    ip: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    accept_textures: Option<i8>,
    #[serde(default)]
    hidden: Option<i8>,
}

fn servers_path(id: &str) -> Result<PathBuf> {
    instances::valid_id(id)?;
    Ok(instances::game_dir(id).join("servers.dat"))
}

#[tauri::command]
pub fn list_servers(instance_id: String) -> CmdResult<Vec<Server>> {
    let p = servers_path(&instance_id).map_err(err)?;
    let Ok(data) = std::fs::read(&p) else { return Ok(vec![]) };
    let root = nbt::parse(&data).map_err(err)?;
    let mut out = vec![];
    if let Some(Tag::List(_, list)) = root.get("servers") {
        for s in list {
            out.push(Server {
                name: s.get("name").and_then(|t| t.str()).unwrap_or("Minecraft Server").to_string(),
                ip: s.get("ip").and_then(|t| t.str()).unwrap_or("").to_string(),
                icon: s.get("icon").and_then(|t| t.str()).map(|b| format!("data:image/png;base64,{b}")),
                accept_textures: s.get("acceptTextures").and_then(|t| t.int()).map(|v| v as i8),
                hidden: s.get("hidden").and_then(|t| t.int()).map(|v| v as i8),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn save_servers(instance_id: String, servers: Vec<Server>) -> CmdResult<()> {
    let p = servers_path(&instance_id).map_err(err)?;
    let list: Vec<Tag> = servers
        .into_iter()
        .map(|s| {
            let mut c = vec![("name".to_string(), Tag::String(s.name)), ("ip".to_string(), Tag::String(s.ip.trim().to_string()))];
            if let Some(b) = s.icon.and_then(|i| i.strip_prefix("data:image/png;base64,").map(String::from)) {
                c.push(("icon".into(), Tag::String(b)));
            }
            if let Some(a) = s.accept_textures {
                c.push(("acceptTextures".into(), Tag::Byte(a)));
            }
            if let Some(h) = s.hidden {
                c.push(("hidden".into(), Tag::Byte(h)));
            }
            Tag::Compound(c)
        })
        .collect();
    let root = Tag::Compound(vec![("servers".into(), Tag::List(10, list))]);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
    // Write then swap, so a crash mid-save can't leave the server list empty.
    let tmp = p.with_extension("dat.orbit-tmp");
    std::fs::write(&tmp, nbt::write(&root)).map_err(err)?;
    std::fs::rename(&tmp, &p).map_err(err)
}

// ---------------------------------------------------------------- screenshots

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    name: String,
    path: String,
    modified: i64,
    size: u64,
}

#[tauri::command]
pub fn list_screenshots(instance_id: String) -> CmdResult<Vec<Shot>> {
    instances::valid_id(&instance_id).map_err(err)?;
    let dir = instances::game_dir(&instance_id).join("screenshots");
    let mut out: Vec<Shot> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().map(|x| x.eq_ignore_ascii_case("png") || x.eq_ignore_ascii_case("jpg")).unwrap_or(false))
        .map(|e| Shot {
            name: e.file_name().to_string_lossy().into(),
            path: e.path().to_string_lossy().into(),
            modified: mtime(&e.path()),
            size: e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn delete_screenshot(instance_id: String, name: String) -> CmdResult<()> {
    std::fs::remove_file(sub_path(&instance_id, "screenshots", &name).map_err(err)?).map_err(err)
}

#[tauri::command]
pub fn open_screenshot(instance_id: String, name: String) -> CmdResult<()> {
    open::that(sub_path(&instance_id, "screenshots", &name).map_err(err)?).map_err(err)
}

// ---------------------------------------------------------------- logs

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    name: String,
    folder: String,
    modified: i64,
    size: u64,
}

#[tauri::command]
pub fn list_logs(instance_id: String) -> CmdResult<Vec<LogFile>> {
    instances::valid_id(&instance_id).map_err(err)?;
    let game = instances::game_dir(&instance_id);
    let mut out = vec![];
    for folder in ["logs", "crash-reports"] {
        for e in std::fs::read_dir(game.join(folder)).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !(name.ends_with(".log") || name.ends_with(".log.gz") || name.ends_with(".txt")) {
                continue;
            }
            out.push(LogFile { modified: mtime(&e.path()), size: e.metadata().map(|m| m.len()).unwrap_or(0), name, folder: folder.into() });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub async fn read_log(instance_id: String, folder: String, name: String) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || read_log_blocking(instance_id, folder, name)).await.map_err(err)?
}

fn read_log_blocking(instance_id: String, folder: String, name: String) -> CmdResult<String> {
    if folder != "logs" && folder != "crash-reports" {
        return Err("Bad folder".into());
    }
    let p = sub_path(&instance_id, &folder, &name).map_err(err)?;
    let data = std::fs::read(&p).map_err(err)?;
    let mut text = if name.ends_with(".gz") {
        let mut s = vec![];
        flate2::read::GzDecoder::new(&data[..]).read_to_end(&mut s).map_err(err)?;
        String::from_utf8_lossy(&s).into_owned()
    } else {
        String::from_utf8_lossy(&data).into_owned()
    };
    const MAX: usize = 4 * 1024 * 1024;
    if text.len() > MAX {
        let cut = text.len() - MAX;
        let cut = (cut..text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(cut);
        text = format!("[… trimmed, showing the last 4 MB …]\n{}", &text[cut..]);
    }
    Ok(text)
}

#[tauri::command]
pub fn delete_log(instance_id: String, folder: String, name: String) -> CmdResult<()> {
    if folder != "logs" && folder != "crash-reports" {
        return Err("Bad folder".into());
    }
    std::fs::remove_file(sub_path(&instance_id, &folder, &name).map_err(err)?).map_err(err)
}

// ---------------------------------------------------------------- server status (Server List Ping)

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    online: u64,
    max: u64,
    version: String,
    motd: String,
    favicon: Option<String>,
    latency: u64,
    players: Vec<String>,
}

#[tauri::command]
pub async fn ping_server(address: String) -> CmdResult<ServerStatus> {
    match tokio::time::timeout(std::time::Duration::from_secs(6), ping(address.trim())).await {
        Ok(r) => r.map_err(err),
        Err(_) => Err("Timed out".into()),
    }
}

fn write_varint(buf: &mut Vec<u8>, v: i32) {
    let mut u = v as u32;
    loop {
        let mut b = (u & 0x7f) as u8;
        u >>= 7;
        if u != 0 {
            b |= 0x80;
        }
        buf.push(b);
        if u == 0 {
            break;
        }
    }
}

async fn read_varint<R: tokio::io::AsyncRead + Unpin>(r: &mut R) -> Result<i32> {
    use tokio::io::AsyncReadExt;
    let mut n = 0u32;
    for i in 0..5 {
        let b = r.read_u8().await?;
        n |= ((b & 0x7f) as u32) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(n as i32);
        }
    }
    bail!("Bad response")
}

fn packet(id: i32, payload: &[u8]) -> Vec<u8> {
    let mut inner = vec![];
    write_varint(&mut inner, id);
    inner.extend_from_slice(payload);
    let mut out = vec![];
    write_varint(&mut out, inner.len() as i32);
    out.extend(inner);
    out
}

async fn ping(address: &str) -> Result<ServerStatus> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if address.is_empty() {
        bail!("No address");
    }
    let (host, port, explicit) = match address.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h.trim_matches(['[', ']']).to_string(), p.parse::<u16>().unwrap(), true),
        _ => (address.to_string(), 25565, false),
    };
    let (connect_host, connect_port) = if explicit {
        (host.clone(), port)
    } else {
        let h = host.clone();
        tokio::task::spawn_blocking(move || srv_lookup(&h)).await?.unwrap_or((host.clone(), port))
    };
    let mut stream = tokio::net::TcpStream::connect((connect_host.as_str(), connect_port)).await?;
    stream.set_nodelay(true)?;

    let mut hs = vec![];
    write_varint(&mut hs, -1);
    write_varint(&mut hs, host.len() as i32);
    hs.extend_from_slice(host.as_bytes());
    hs.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut hs, 1);
    stream.write_all(&packet(0, &hs)).await?;
    stream.write_all(&packet(0, &[])).await?;

    let _len = read_varint(&mut stream).await?;
    if read_varint(&mut stream).await? != 0 {
        bail!("Unexpected response");
    }
    let n = read_varint(&mut stream).await?.clamp(0, 1 << 21) as usize;
    let mut buf = vec![0u8; n];
    stream.read_exact(&mut buf).await?;
    let json: serde_json::Value = serde_json::from_slice(&buf)?;

    let started = std::time::Instant::now();
    stream.write_all(&packet(1, &(chrono::Utc::now().timestamp_millis()).to_be_bytes())).await?;
    let latency = match tokio::time::timeout(std::time::Duration::from_secs(3), async {
        read_varint(&mut stream).await?;
        read_varint(&mut stream).await?;
        stream.read_i64().await?;
        anyhow::Ok(())
    })
    .await
    {
        Ok(Ok(())) => started.elapsed().as_millis() as u64,
        _ => 0,
    };

    Ok(ServerStatus {
        online: json["players"]["online"].as_u64().unwrap_or(0),
        max: json["players"]["max"].as_u64().unwrap_or(0),
        version: json["version"]["name"].as_str().unwrap_or("").to_string(),
        motd: to_legacy(&json["description"], ""),
        favicon: json["favicon"].as_str().filter(|f| f.starts_with("data:image/png;base64,")).map(String::from),
        latency,
        players: json["players"]["sample"].as_array().into_iter().flatten().filter_map(|p| p["name"].as_str().map(String::from)).take(12).collect(),
    })
}

/// Flatten a JSON text component to §-coded text (hex colours as §#rrggbb) for the UI to colour.
fn to_legacy(v: &serde_json::Value, inherited: &str) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => format!("{inherited}{s}"),
        Value::Array(a) => a.iter().map(|x| to_legacy(x, inherited)).collect(),
        Value::Object(o) => {
            let mut codes = inherited.to_string();
            if let Some(c) = o.get("color").and_then(|c| c.as_str()) {
                let code = match c {
                    "black" => "0", "dark_blue" => "1", "dark_green" => "2", "dark_aqua" => "3", "dark_red" => "4", "dark_purple" => "5",
                    "gold" => "6", "gray" => "7", "dark_gray" => "8", "blue" => "9", "green" => "a", "aqua" => "b",
                    "red" => "c", "light_purple" => "d", "yellow" => "e", "white" => "f",
                    hex if hex.starts_with('#') && hex.len() == 7 => hex,
                    _ => "",
                };
                if !code.is_empty() {
                    codes = format!("§{code}");
                }
            }
            for (k, c) in [("bold", "l"), ("italic", "o"), ("underlined", "n"), ("strikethrough", "m"), ("obfuscated", "k")] {
                if o.get(k).and_then(|b| b.as_bool()) == Some(true) {
                    codes.push_str(&format!("§{c}"));
                }
            }
            let mut out = format!("§r{codes}{}", o.get("text").and_then(|t| t.as_str()).unwrap_or(""));
            if let Some(extra) = o.get("extra") {
                out.push_str(&to_legacy(extra, &codes));
            }
            out
        }
        _ => String::new(),
    }
}

/// `_minecraft._tcp` SRV lookup through the system resolver.
#[cfg(windows)]
fn srv_lookup(host: &str) -> Option<(String, u16)> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    #[repr(C)]
    struct SrvData {
        target: *const u16,
        priority: u16,
        weight: u16,
        port: u16,
        pad: u16,
    }
    #[repr(C)]
    struct DnsRecord {
        next: *mut DnsRecord,
        name: *const u16,
        wtype: u16,
        data_length: u16,
        flags: u32,
        ttl: u32,
        reserved: u32,
        data: SrvData,
    }
    #[link(name = "dnsapi")]
    extern "system" {
        fn DnsQuery_W(name: *const u16, wtype: u16, options: u32, extra: *mut c_void, results: *mut *mut DnsRecord, reserved: *mut c_void) -> i32;
        fn DnsFree(data: *mut c_void, free_type: i32);
    }
    const DNS_TYPE_SRV: u16 = 33;
    let name: Vec<u16> = format!("_minecraft._tcp.{host}").encode_utf16().chain(Some(0)).collect();
    let mut res: *mut DnsRecord = null_mut();
    if unsafe { DnsQuery_W(name.as_ptr(), DNS_TYPE_SRV, 0, null_mut(), &mut res, null_mut()) } != 0 || res.is_null() {
        return None;
    }
    let mut out = None;
    let mut cur = res;
    while !cur.is_null() {
        let r = unsafe { &*cur };
        if r.wtype == DNS_TYPE_SRV && !r.data.target.is_null() {
            let mut len = 0;
            while unsafe { *r.data.target.add(len) } != 0 {
                len += 1;
            }
            let target = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(r.data.target, len) });
            out = Some((target.trim_end_matches('.').to_string(), r.data.port));
            break;
        }
        cur = r.next;
    }
    unsafe { DnsFree(res as *mut c_void, 1) };
    out
}

#[cfg(not(windows))]
fn srv_lookup(_host: &str) -> Option<(String, u16)> {
    None
}

/// Share a log on mclo.gs (the same paste service Prism uses); returns the URL.
#[tauri::command]
pub async fn upload_log(content: String) -> CmdResult<String> {
    upload(content).await.map_err(err)
}

async fn upload(content: String) -> Result<String> {
    let r: serde_json::Value = client().post("https://api.mclo.gs/1/log").form(&[("content", content.as_str())]).send().await?.json().await?;
    if r["success"].as_bool() != Some(true) {
        return Err(anyhow!("{}", r["error"].as_str().unwrap_or("Upload failed")));
    }
    r["url"].as_str().map(String::from).ok_or_else(|| anyhow!("Upload failed"))
}
