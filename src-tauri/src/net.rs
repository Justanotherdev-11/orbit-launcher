use crate::util::sha1_file;
use anyhow::{bail, Context, Result};
use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
/// User cap on simultaneous downloads (Settings → Downloads).
static MAX_PARALLEL: AtomicUsize = AtomicUsize::new(12);

pub fn set_max_parallel(n: u32) {
    MAX_PARALLEL.store((n as usize).clamp(1, 64), Ordering::Relaxed);
}

pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("OrbitLauncher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            // Idle timeout, not a total one: a 100 MB file on a slow line must still finish.
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("http client")
    })
}

fn host(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

pub async fn get_json<T: DeserializeOwned>(url: &str) -> Result<T> {
    let resp = client().get(url).send().await.with_context(|| format!("Could not reach {}", host(url)))?;
    if !resp.status().is_success() {
        bail!("{} responded with {}", host(url), resp.status());
    }
    resp.json::<T>().await.with_context(|| format!("Unexpected response from {}", host(url)))
}

pub async fn post_json(url: &str, body: &Value) -> Result<Value> {
    let resp = client().post(url).json(body).send().await.with_context(|| format!("Could not reach {}", host(url)))?;
    if !resp.status().is_success() {
        bail!("{} responded with {}", host(url), resp.status());
    }
    Ok(resp.json().await?)
}

#[derive(Clone, Debug)]
pub struct Dl {
    pub url: String,
    pub path: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

/// Cheap validity check: size when known, otherwise hash when known, otherwise existence.
pub fn is_valid(d: &Dl) -> bool {
    let Ok(meta) = std::fs::metadata(&d.path) else { return false };
    if let Some(size) = d.size {
        return meta.len() == size;
    }
    if let Some(hash) = &d.sha1 {
        return sha1_file(&d.path).map(|h| h.eq_ignore_ascii_case(hash)).unwrap_or(false);
    }
    true
}

pub async fn ensure_file(d: &Dl) -> Result<()> {
    let check = d.clone();
    if tokio::task::spawn_blocking(move || is_valid(&check)).await? {
        return Ok(());
    }
    download(d).await
}

pub async fn download(d: &Dl) -> Result<()> {
    if d.url.is_empty() {
        bail!("No download available for {}", d.path.display());
    }
    let mut last = None;
    for attempt in 0..3u64 {
        match download_once(d).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
            }
        }
    }
    Err(last.unwrap())
}

async fn download_once(d: &Dl) -> Result<()> {
    let resp = client().get(&d.url).send().await.with_context(|| format!("Could not reach {}", host(&d.url)))?;
    if !resp.status().is_success() {
        bail!("{} responded with {} for {}", host(&d.url), resp.status(), d.url);
    }
    if let Some(parent) = d.path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // A unique temp name per attempt, so two launches fetching the same file can't clobber each other.
    let mut tmp = d.path.clone().into_os_string();
    tmp.push(format!(".{}.part", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    let tmp = PathBuf::from(tmp);
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut hasher = sha1_smol::Sha1::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    if let Some(expected) = &d.sha1 {
        let got = hasher.digest().to_string();
        if !got.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&tmp).await;
            bail!("Checksum mismatch for {}", d.url);
        }
    }
    if let Err(e) = tokio::fs::rename(&tmp, &d.path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        // Another download of the same file may have finished first; that's fine if it's valid.
        if !is_valid(d) {
            return Err(e.into());
        }
    }
    Ok(())
}

/// Download everything that is missing or invalid, `concurrency` at a time.
pub async fn download_many<F>(mut items: Vec<Dl>, concurrency: usize, progress: F) -> Result<()>
where
    F: Fn(usize, usize) + Sync,
{
    let mut seen = HashSet::new();
    items.retain(|d| seen.insert(d.path.clone()));
    let pending: Vec<Dl> = tokio::task::spawn_blocking(move || items.into_iter().filter(|d| !is_valid(d)).collect()).await?;
    let total = pending.len();
    if total == 0 {
        return Ok(());
    }
    progress(0, total);
    let done = AtomicUsize::new(0);
    let (done, progress) = (&done, &progress);
    let futs: Vec<_> = pending
        .into_iter()
        .map(|d| async move {
            let r = download(&d).await;
            progress(done.fetch_add(1, Ordering::SeqCst) + 1, total);
            r
        })
        .collect();
    // Asset batches ask for more than libraries; scale the user's cap accordingly.
    let limit = (MAX_PARALLEL.load(Ordering::Relaxed) * concurrency / 12).max(1);
    let results: Vec<Result<()>> = futures::stream::iter(futs).buffer_unordered(limit).collect().await;
    let failed: Vec<anyhow::Error> = results.into_iter().filter_map(|r| r.err()).collect();
    if let Some(first) = failed.into_iter().next() {
        return Err(first.context("Some files failed to download"));
    }
    Ok(())
}
