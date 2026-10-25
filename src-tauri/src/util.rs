use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

pub type CmdResult<T> = Result<T, String>;

/// Flatten any error (including anyhow context chains) into a string for the UI.
pub fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

pub struct Paths {
    pub root: PathBuf,
    pub instances: PathBuf,
    pub versions: PathBuf,
    pub libraries: PathBuf,
    pub assets: PathBuf,
    pub java: PathBuf,
    pub cache: PathBuf,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

pub const PORTABLE_DIR: &str = "OrbitData";

pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Per-user folder on this PC. Accounts always live here, so they never travel with a shared folder.
pub fn user_dir() -> PathBuf {
    let d = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("OrbitLauncher");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Portable mode: an `OrbitData` folder next to the exe holds everything, so the whole folder can be copied or shared.
pub fn portable_dir() -> Option<PathBuf> {
    exe_dir().map(|d| d.join(PORTABLE_DIR)).filter(|d| d.is_dir())
}

pub fn paths() -> &'static Paths {
    PATHS.get_or_init(|| {
        let root = std::env::var_os("ORBIT_DATA_DIR").map(PathBuf::from).or_else(portable_dir).unwrap_or_else(user_dir);
        let p = Paths {
            instances: root.join("instances"),
            versions: root.join("versions"),
            libraries: root.join("libraries"),
            assets: root.join("assets"),
            java: root.join("java"),
            cache: root.join("cache"),
            root,
        };
        for d in [&p.root, &p.instances, &p.versions, &p.libraries, &p.assets, &p.java, &p.cache] {
            let _ = std::fs::create_dir_all(d);
        }
        p
    })
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let data = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&data).with_context(|| format!("parsing {}", path.display()))
}

pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn sha1_file(path: &Path) -> std::io::Result<String> {
    let data = std::fs::read(path)?;
    Ok(sha1_smol::Sha1::from(&data).digest().to_string())
}

/// `group:artifact:version[:classifier][@ext]` -> relative maven path.
pub fn maven_path(name: &str) -> String {
    let (coords, ext) = match name.split_once('@') {
        Some((c, e)) => (c, e),
        None => (name, "jar"),
    };
    let p: Vec<&str> = coords.split(':').collect();
    if p.len() < 3 {
        return name.to_string();
    }
    let classifier = p.get(3).map(|c| format!("-{c}")).unwrap_or_default();
    format!("{}/{}/{}/{}-{}{}.{}", p[0].replace('.', "/"), p[1], p[2], p[1], p[2], classifier, ext)
}

/// Join a relative path onto `base`, refusing anything that could escape it.
pub fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out == base {
        None
    } else {
        Some(out)
    }
}

pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => total += dir_size(&e.path()),
                Ok(_) => total += e.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    total
}

pub fn copy_dir(src: &Path, dst: &Path, on_file: &mut dyn FnMut()) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let target = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target, on_file)?;
        } else {
            std::fs::copy(e.path(), &target)?;
            on_file();
        }
    }
    Ok(())
}

pub fn count_files(path: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                n += count_files(&e.path());
            } else {
                n += 1;
            }
        }
    }
    n
}

/// Compare dotted version strings numerically ("47.2.10" > "47.2.9").
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse().unwrap_or(0)).collect()
    };
    parse(a).cmp(&parse(b))
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Decode a line from a child process. Java on Windows often writes in the system code page
/// (e.g. "é" as the single byte 0xE9) rather than UTF-8, so fall back to Latin-1 instead of failing.
pub fn decode_line(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Call `f` for each line of `r` until it returns false or the pipe closes. Never stops on bad
/// encoding, so a pipe is always drained (a stalled pipe would block the child process forever).
pub async fn for_each_line<R: tokio::io::AsyncRead + Unpin>(r: R, mut f: impl FnMut(String) -> bool) {
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                if !f(decode_line(&buf)) {
                    break;
                }
            }
        }
    }
}

/// Split a command line into arguments, honouring double quotes so paths with spaces stay whole.
/// Backslashes are literal (Windows paths), and the quote characters themselves are removed.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let (mut quoted, mut has) = (false, false);
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_args() {
        assert_eq!(split_args(r#"-Xss2M -javaagent:"C:\My Mods\a.jar"  -Dx=1"#), vec!["-Xss2M", r"-javaagent:C:\My Mods\a.jar", "-Dx=1"]);
        assert_eq!(split_args(r#""C:\Program Files\X\prof.exe" --flag"#), vec![r"C:\Program Files\X\prof.exe", "--flag"]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn decodes_code_page_output() {
        assert_eq!(decode_line("plain".as_bytes()), "plain");
        assert_eq!(decode_line(b"C:\\Users\\Jos\xE9"), "C:\\Users\\José");
        assert_eq!(decode_line("C:\\Users\\José".as_bytes()), "C:\\Users\\José");
    }
}
