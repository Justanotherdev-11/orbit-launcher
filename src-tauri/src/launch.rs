use crate::instances::{self, Instance};
use crate::tasks::Task;
use crate::util::*;
use crate::versions::{self, LibFile};
use crate::{auth, java, loaders, settings};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncRead;
use tokio::sync::mpsc;

/// instance id -> pid (0 while still preparing).
#[derive(Default)]
pub struct Running(pub Mutex<HashMap<String, u32>>);

/// Instances the user stopped on purpose, so their exit isn't reported as a crash.
static KILLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogLine {
    id: String,
    line: String,
    level: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: String,
    code: Option<i32>,
    crashed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    id: String,
    starting: bool,
}

/// True while an instance is starting or running (its files may be locked by Windows).
pub fn is_running(app: &AppHandle, id: &str) -> bool {
    app.state::<Running>().0.lock().unwrap().contains_key(id)
}

#[tauri::command]
pub fn get_running(app: AppHandle) -> Vec<RunInfo> {
    app.state::<Running>().0.lock().unwrap().iter().map(|(id, pid)| RunInfo { id: id.clone(), starting: *pid == 0 }).collect()
}

/// Where to drop the player once the game is up.
#[derive(Default)]
pub struct JoinTarget {
    pub server: Option<String>,
    pub world: Option<String>,
}

#[tauri::command]
pub async fn launch_instance(app: AppHandle, instance_id: String, server: Option<String>, world: Option<String>) -> CmdResult<()> {
    instances::valid_id(&instance_id).map_err(err)?;
    {
        let state = app.state::<Running>();
        let mut running = state.0.lock().unwrap();
        if running.contains_key(&instance_id) {
            return Err("This instance is already running".into());
        }
        running.insert(instance_id.clone(), 0);
    }
    let _ = app.emit("game-state", ());
    let result = launch(&app, &instance_id, JoinTarget { server, world }).await;
    if result.is_err() {
        app.state::<Running>().0.lock().unwrap().remove(&instance_id);
        let _ = app.emit("game-state", ());
    }
    result.map_err(err)
}

#[tauri::command]
pub fn kill_instance(app: AppHandle, instance_id: String) -> CmdResult<()> {
    let pid = app.state::<Running>().0.lock().unwrap().get(&instance_id).copied();
    match pid {
        Some(pid) if pid != 0 => {
            KILLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(instance_id.clone());
            // Ask nicely first (like clicking the window's X) so the world saves and mods
            // don't report a crash; force it only if the game is still there 15s later.
            let windows = close_windows(pid);
            let note = if windows > 0 { "── Asking Minecraft to close… ──" } else { "── No game window yet, stopping the process ──" };
            let _ = app.emit("game-log", vec![LogLine { id: instance_id.clone(), line: note.into(), level: "SYS".into() }]);
            if windows == 0 {
                taskkill(pid, true).map_err(err)?;
                return Ok(());
            }
            std::thread::spawn(move || {
                // Big modpacks can take most of a minute to save their worlds; only force it after that.
                std::thread::sleep(Duration::from_secs(60));
                let still_running = app.state::<Running>().0.lock().unwrap().get(&instance_id) == Some(&pid);
                if still_running {
                    let _ = taskkill(pid, true);
                }
            });
            Ok(())
        }
        Some(_) => Err("The game is still preparing".into()),
        None => Err("Not running".into()),
    }
}

/// Post WM_CLOSE to every visible top-level window owned by `pid`; returns how many it reached.
#[cfg(windows)]
fn close_windows(pid: u32) -> usize {
    type Hwnd = isize;
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
    }
    const WM_CLOSE: u32 = 0x0010;
    extern "system" fn each(hwnd: Hwnd, lparam: isize) -> i32 {
        // SAFETY: lparam is the &mut (pid, count) passed to EnumWindows below, alive for the call.
        let data = unsafe { &mut *(lparam as *mut (u32, usize)) };
        let mut owner = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
        if owner == data.0 && unsafe { IsWindowVisible(hwnd) } != 0 && unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } != 0 {
            data.1 += 1;
        }
        1
    }
    let mut data = (pid, 0usize);
    unsafe { EnumWindows(each, &mut data as *mut (u32, usize) as isize) };
    data.1
}

#[cfg(not(windows))]
fn close_windows(_pid: u32) -> usize {
    0
}

fn taskkill(pid: u32, force: bool) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).status()
}

async fn launch(app: &AppHandle, id: &str, join: JoinTarget) -> Result<()> {
    let mut inst = instances::load(id)?;
    let task = Task::new(app, format!("Launching {}", inst.name));
    match prepare_and_spawn(app, &mut inst, &task, join).await {
        Ok(()) => {
            task.done("Game started");
            Ok(())
        }
        Err(e) => {
            task.fail(&format!("{e:#}"));
            Err(e)
        }
    }
}

fn extract_natives(libs: &[LibFile], dir: &Path) -> Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    for l in libs.iter().filter(|l| l.native) {
        let Ok(f) = std::fs::File::open(&l.dl.path) else { continue };
        let Ok(mut z) = zip::ZipArchive::new(f) else { continue };
        for i in 0..z.len() {
            let mut e = z.by_index(i)?;
            let name = e.name().to_string();
            if e.is_dir() || name.starts_with("META-INF") || !name.to_lowercase().ends_with(".dll") {
                continue;
            }
            let Some(file_name) = Path::new(&name).file_name() else { continue };
            let mut out = std::fs::File::create(dir.join(file_name))?;
            std::io::copy(&mut e, &mut out)?;
        }
    }
    Ok(())
}

fn substitute(s: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        match rest[start..].find('}') {
            Some(end) => {
                let key = &rest[start + 2..start + end];
                match vars.get(key) {
                    Some(v) => out.push_str(v),
                    None => out.push_str(&rest[start..start + end + 1]),
                }
                rest = &rest[start + end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Prism-compatible variables for custom commands.
fn command_env(inst: &Instance, java: &Path) -> Vec<(String, String)> {
    vec![
        ("INST_NAME".into(), inst.name.clone()),
        ("INST_ID".into(), inst.id.clone()),
        ("INST_DIR".into(), instances::dir(&inst.id).to_string_lossy().into()),
        ("INST_MC_DIR".into(), instances::game_dir(&inst.id).to_string_lossy().into()),
        ("INST_JAVA".into(), java.to_string_lossy().into()),
    ]
}

fn user_env(inst: &Instance) -> Vec<(String, String)> {
    inst.env_vars
        .as_deref()
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().split_once('=').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .filter(|(k, _)| !k.is_empty() && !k.starts_with('#'))
        .collect()
}

fn shell(cmdline: &str, cwd: &Path, env: &[(String, String)]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/C");
    // Pass the command line verbatim: Rust's argument quoting would turn " into \" which cmd.exe doesn't understand.
    #[cfg(windows)]
    cmd.raw_arg(cmdline);
    #[cfg(not(windows))]
    cmd.arg(cmdline);
    cmd.current_dir(cwd).envs(env.iter().cloned()).stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

async fn prepare_and_spawn(app: &AppHandle, inst: &mut Instance, task: &Task, join: JoinTarget) -> Result<()> {
    let settings = settings::load();
    task.step("Checking account");
    let account = auth::account_for_launch().await?;
    let game_dir = instances::game_dir(&inst.id);
    std::fs::create_dir_all(&game_dir)?;

    task.step("Fetching version info");
    versions::ensure_vanilla_json(&inst.mc_version).await?;
    let vanilla = versions::resolve(&inst.mc_version)?;

    let custom_java = inst.java_path.clone().filter(|p| !p.trim().is_empty()).or_else(|| Some(settings.java_path.clone()).filter(|p| !p.trim().is_empty()));
    let java = match custom_java {
        Some(p) => PathBuf::from(p.trim()),
        None => java::ensure(&java::component_for(&vanilla), task).await?,
    };
    if !java.exists() {
        bail!("Java not found at {}", java.display());
    }
    versions::install_files(&vanilla, &game_dir, task).await?;

    if inst.loader != "vanilla" && inst.loader_version.is_none() {
        task.step("Picking loader version");
        inst.loader_version = Some(loaders::latest(&inst.loader, &inst.mc_version).await?);
        // Save just this field onto the current file, so other edits made meanwhile survive.
        let mut fresh = instances::load(&inst.id)?;
        fresh.loader_version = inst.loader_version.clone();
        instances::save(&fresh)?;
    }
    let version_id = loaders::ensure(inst, &java, task).await?;
    let v = versions::resolve(&version_id)?;
    let prepared = versions::install_files(&v, &game_dir, task).await?;

    task.step("Unpacking natives");
    let natives = instances::dir(&inst.id).join("natives");
    {
        let natives = natives.clone();
        let libs: Vec<LibFile> = prepared.libs.iter().filter(|l| l.native).map(|l| LibFile { dl: l.dl.clone(), classpath: false, native: true }).collect();
        tokio::task::spawn_blocking(move || extract_natives(&libs, &natives)).await??;
    }

    let mut seen = HashSet::new();
    let mut cp: Vec<String> = vec![];
    for l in &prepared.libs {
        if l.classpath && seen.insert(l.dl.path.clone()) {
            cp.push(l.dl.path.to_string_lossy().into());
        }
    }
    cp.push(prepared.client_jar.to_string_lossy().into());
    let classpath = cp.join(";");

    let s = |p: &Path| p.to_string_lossy().to_string();
    let token = if account.access_token.is_empty() { "0".to_string() } else { account.access_token.clone() };
    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("auth_player_name", account.name.clone());
    vars.insert("version_name", v.id.clone());
    vars.insert("game_directory", s(&game_dir));
    vars.insert("assets_root", s(&paths().assets));
    vars.insert("game_assets", s(&prepared.game_assets));
    vars.insert("assets_index_name", prepared.asset_index.clone());
    vars.insert("auth_uuid", account.uuid.replace('-', ""));
    vars.insert("auth_access_token", token.clone());
    vars.insert("auth_session", format!("token:{}:{}", token, account.uuid));
    vars.insert("auth_xuid", "0".into());
    vars.insert("clientid", settings.ms_client_id.clone());
    vars.insert("user_type", if account.kind == "msa" { "msa".into() } else { "legacy".into() });
    vars.insert("version_type", "Orbit".into());
    vars.insert("user_properties", "{}".into());
    vars.insert("natives_directory", s(&natives));
    vars.insert("launcher_name", "OrbitLauncher".into());
    vars.insert("launcher_version", env!("CARGO_PKG_VERSION").into());
    vars.insert("classpath", classpath.clone());
    vars.insert("classpath_separator", ";".into());
    vars.insert("library_directory", s(&paths().libraries));

    let mem = inst.memory_mb.unwrap_or(settings.memory_mb).max(512);
    let mut jvm: Vec<String> = vec![
        format!("-Xmx{mem}M"),
        format!("-Xms{}M", mem.min(1024)),
        "-XX:+UnlockExperimentalVMOptions".into(),
        "-XX:+UseG1GC".into(),
        "-XX:G1NewSizePercent=20".into(),
        "-XX:G1ReservePercent=20".into(),
        "-XX:MaxGCPauseMillis=50".into(),
        "-XX:G1HeapRegionSize=32M".into(),
        "-Dlog4j2.formatMsgNoLookups=true".into(),
    ];
    jvm.extend(split_args(&settings.jvm_args));
    if let Some(extra) = &inst.jvm_args {
        jvm.extend(split_args(extra));
    }
    if let Some(l) = &prepared.logging_arg {
        jvm.push(l.clone());
    }
    match v.arguments.as_ref().filter(|a| !a.jvm.is_empty()) {
        Some(a) => jvm.extend(versions::collect_args(&a.jvm).iter().map(|x| substitute(x, &vars))),
        None => {
            jvm.push(format!("-Djava.library.path={}", s(&natives)));
            jvm.push("-cp".into());
            jvm.push(classpath);
        }
    }
    let main_class = v.main_class.clone().context("Version has no main class")?;

    let mut game: Vec<String> = match (&v.arguments, &v.minecraft_arguments) {
        (Some(a), _) if !a.game.is_empty() => versions::collect_args(&a.game),
        (_, Some(m)) => m.split_whitespace().map(String::from).collect(),
        _ => vec![],
    };
    game = game.iter().map(|x| substitute(x, &vars)).collect();

    let (w, h) = (inst.window_width.unwrap_or(settings.game_width), inst.window_height.unwrap_or(settings.game_height));
    if settings.fullscreen {
        game.push("--fullscreen".into());
    } else if w > 0 && h > 0 {
        game.extend(["--width".into(), w.to_string(), "--height".into(), h.to_string()]);
    }
    if let Some(addr) = join.server.filter(|s| !s.trim().is_empty()) {
        let addr = addr.trim().to_string();
        if v.arguments.is_some() && supports_quick_play(&inst.mc_version).await {
            game.extend(["--quickPlayMultiplayer".into(), addr]);
        } else {
            let (host, port) = addr.rsplit_once(':').filter(|(_, p)| p.parse::<u16>().is_ok()).map(|(h, p)| (h.to_string(), p.to_string())).unwrap_or((addr.clone(), "25565".into()));
            game.extend(["--server".into(), host, "--port".into(), port]);
        }
    } else if let Some(world) = join.world.filter(|w| !w.trim().is_empty()) {
        if !supports_quick_play(&inst.mc_version).await {
            bail!("Jumping straight into a world needs Minecraft 1.20 or newer");
        }
        game.extend(["--quickPlaySingleplayer".into(), world]);
    }

    let cmd_env = command_env(inst, &java);
    if let Some(pre) = inst.pre_launch.clone().filter(|c| !c.trim().is_empty()) {
        task.step("Running pre-launch command");
        let status = shell(&pre, &game_dir, &cmd_env).status().await?;
        if !status.success() {
            bail!("Pre-launch command failed (exit code {})", status.code().unwrap_or(-1));
        }
    }

    task.step("Starting Minecraft");
    let wrapper: Vec<String> = split_args(inst.wrapper.as_deref().unwrap_or_default());
    let mut cmd = match wrapper.split_first() {
        Some((prog, rest)) => {
            let mut c = tokio::process::Command::new(prog);
            c.args(rest).arg(&java);
            c
        }
        None => tokio::process::Command::new(&java),
    };
    cmd.args(&jvm)
        .arg(&main_class)
        .args(&game)
        .current_dir(&game_dir)
        .envs(cmd_env.iter().cloned())
        .envs(user_env(inst))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().with_context(|| format!("Could not start {}", java.display()))?;
    let pid = child.id().unwrap_or(0);
    app.state::<Running>().0.lock().unwrap().insert(inst.id.clone(), pid);
    // The game is running now: never fail from here on, or it would be left untracked.
    // Reload before saving so edits made during a long install aren't overwritten.
    if let Ok(mut fresh) = instances::load(&inst.id) {
        fresh.last_played = Some(now());
        let _ = instances::save(&fresh);
    }
    let _ = app.emit("game-state", ());

    if settings.hide_on_launch {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }

    let (tx, rx) = mpsc::unbounded_channel::<LogLine>();
    spawn_reader(child.stdout.take().unwrap(), inst.id.clone(), tx.clone(), false);
    spawn_reader(child.stderr.take().unwrap(), inst.id.clone(), tx, true);
    spawn_batcher(app.clone(), rx);

    let app2 = app.clone();
    let id = inst.id.clone();
    let hide = settings.hide_on_launch;
    let post_exit = inst.post_exit.clone().filter(|c| !c.trim().is_empty());
    let post_dir = game_dir.clone();
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        let status = child.wait().await;
        let code = status.ok().and_then(|s| s.code());
        app2.state::<Running>().0.lock().unwrap().remove(&id);
        if let Ok(mut i) = instances::load(&id) {
            i.playtime += start.elapsed().as_secs();
            i.last_played = Some(now());
            let _ = instances::save(&i);
        }
        // Give the log batcher a moment to flush the crash report.
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(post) = post_exit {
            let _ = shell(&post, &post_dir, &cmd_env).status().await;
        }
        let killed = KILLED.lock().unwrap().as_mut().map(|k| k.remove(&id)).unwrap_or(false);
        let _ = app2.emit("game-exit", ExitEvent { id, code, crashed: !killed && matches!(code, Some(c) if c != 0) });
        let _ = app2.emit("game-state", ());
        if hide {
            if let Some(w) = app2.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });
    Ok(())
}

/// Quick Play (--quickPlayMultiplayer) arrived in 23w14a / 1.20.
async fn supports_quick_play(mc: &str) -> bool {
    let Ok(list) = versions::manifest().await else { return false };
    let pos = |id: &str| list.iter().position(|v| v.id == id);
    match (pos(mc), pos("23w14a")) {
        (Some(a), Some(b)) => a <= b,
        _ => false,
    }
}

fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(r: R, id: String, tx: mpsc::UnboundedSender<LogLine>, is_err: bool) {
    tauri::async_runtime::spawn(async move {
        let mut parser = LogParser::default();
        for_each_line(r, |line| match parser.feed(&line) {
            Some((level, text)) => {
                let level = if is_err && level == "INFO" { "WARN".to_string() } else { level };
                tx.send(LogLine { id: id.clone(), line: text, level }).is_ok()
            }
            None => true,
        })
        .await;
    });
}

fn spawn_batcher(app: AppHandle, mut rx: mpsc::UnboundedReceiver<LogLine>) {
    tauri::async_runtime::spawn(async move {
        let mut buf: Vec<LogLine> = vec![];
        loop {
            match tokio::time::timeout(Duration::from_millis(80), rx.recv()).await {
                Ok(Some(l)) => {
                    buf.push(l);
                    if buf.len() < 500 {
                        continue;
                    }
                }
                Ok(None) => {
                    if !buf.is_empty() {
                        let _ = app.emit("game-log", std::mem::take(&mut buf));
                    }
                    break;
                }
                Err(_) => {}
            }
            if !buf.is_empty() {
                let _ = app.emit("game-log", std::mem::take(&mut buf));
            }
        }
    });
}

/// Turns log4j XML events (from Mojang's patched logging config) back into readable lines.
#[derive(Default)]
struct LogParser {
    buf: Option<String>,
}

impl LogParser {
    fn feed(&mut self, line: &str) -> Option<(String, String)> {
        if let Some(buf) = &mut self.buf {
            buf.push_str(line);
            buf.push('\n');
            if line.contains("</log4j:Event>") {
                let b = self.buf.take().unwrap();
                return Some(parse_event(&b));
            }
            return None;
        }
        if line.trim_start().starts_with("<log4j:Event") {
            if line.contains("</log4j:Event>") {
                return Some(parse_event(line));
            }
            self.buf = Some(format!("{line}\n"));
            return None;
        }
        Some((guess_level(line), line.to_string()))
    }
}

fn attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}=\"");
    let start = s.find(&key)? + key.len();
    let end = s[start..].find('"')?;
    Some(&s[start..start + end])
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let start = s.find(a)? + a.len();
    let end = s[start..].find(b)?;
    Some(&s[start..start + end])
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn parse_event(b: &str) -> (String, String) {
    let level = attr(b, "level").unwrap_or("INFO").to_string();
    let thread = unescape(attr(b, "thread").unwrap_or("main"));
    let time = attr(b, "timestamp")
        .and_then(|t| t.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|d| d.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
        .unwrap_or_default();
    let msg = between(b, "<log4j:Message><![CDATA[", "]]></log4j:Message>").unwrap_or("").to_string();
    let mut text = format!("[{time}] [{thread}/{level}]: {msg}");
    if let Some(t) = between(b, "<log4j:Throwable><![CDATA[", "]]></log4j:Throwable>") {
        text.push('\n');
        text.push_str(t.trim_end());
    }
    (level, text)
}

fn guess_level(line: &str) -> String {
    if line.contains("/ERROR]") || line.contains("/FATAL]") || line.contains("Exception") || line.starts_with("\tat ") {
        "ERROR".into()
    } else if line.contains("/WARN]") {
        "WARN".into()
    } else {
        "INFO".into()
    }
}
