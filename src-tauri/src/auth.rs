//! Microsoft (device code) and offline accounts.
use crate::net::client;
use crate::settings;
use crate::util::*;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

/// Device codes whose sign-in window was closed; each sign-in is cancelled on its own.
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn is_cancelled(code: &str) -> bool {
    CANCELLED.lock().unwrap().as_ref().is_some_and(|c| c.contains(code))
}
const SCOPE: &str = "XboxLive.signin offline_access";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub uuid: String,
    pub name: String,
    pub kind: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Store {
    accounts: Vec<Account>,
    active: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    uuid: String,
    name: String,
    kind: String,
    active: bool,
}

fn store_path() -> PathBuf {
    user_dir().join("accounts.json")
}
fn load_store() -> Store {
    read_json(&store_path()).unwrap_or_default()
}
fn save_store(s: &Store) -> Result<()> {
    write_json(&store_path(), s)
}

fn views(s: &Store) -> Vec<AccountView> {
    let active = s.active.clone().or_else(|| s.accounts.first().map(|a| a.uuid.clone()));
    s.accounts
        .iter()
        .map(|a| AccountView { uuid: a.uuid.clone(), name: a.name.clone(), kind: a.kind.clone(), active: Some(&a.uuid) == active.as_ref() })
        .collect()
}

fn upsert(s: &mut Store, a: Account) {
    s.accounts.retain(|x| x.uuid != a.uuid);
    s.active = Some(a.uuid.clone());
    s.accounts.push(a);
}

#[tauri::command]
pub fn list_accounts() -> Vec<AccountView> {
    views(&load_store())
}

#[tauri::command]
pub fn set_active_account(uuid: String) -> CmdResult<Vec<AccountView>> {
    let mut s = load_store();
    if s.accounts.iter().any(|a| a.uuid == uuid) {
        s.active = Some(uuid);
    }
    save_store(&s).map_err(err)?;
    Ok(views(&s))
}

#[tauri::command]
pub fn remove_account(uuid: String) -> CmdResult<Vec<AccountView>> {
    let mut s = load_store();
    s.accounts.retain(|a| a.uuid != uuid);
    if s.active.as_deref() == Some(uuid.as_str()) {
        s.active = None;
    }
    save_store(&s).map_err(err)?;
    Ok(views(&s))
}

fn offline_uuid(name: &str) -> String {
    let mut b = md5::compute(format!("OfflinePlayer:{name}")).0;
    b[6] = (b[6] & 0x0f) | 0x30;
    b[8] = (b[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(b).simple().to_string()
}

#[tauri::command]
pub fn add_offline_account(name: String) -> CmdResult<Vec<AccountView>> {
    let name = name.trim().to_string();
    if name.len() < 3 || name.len() > 16 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Offline names must be 3–16 letters, numbers or underscores".into());
    }
    let mut s = load_store();
    upsert(&mut s, Account { uuid: offline_uuid(&name), name, kind: "offline".into(), ..Default::default() });
    save_store(&s).map_err(err)?;
    Ok(views(&s))
}

fn client_id() -> Result<String> {
    let id = settings::load().ms_client_id.trim().to_string();
    if id.is_empty() {
        bail!("MSA_CLIENT_ID_MISSING");
    }
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    user_code: String,
    device_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[tauri::command]
pub async fn msa_start() -> CmdResult<DeviceCode> {
    start().await.map_err(err)
}

async fn start() -> Result<DeviceCode> {
    let cid = client_id()?;
    let r: Value = client()
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .form(&[("client_id", cid.as_str()), ("scope", SCOPE)])
        .send()
        .await
        .context("Could not reach Microsoft")?
        .json()
        .await?;
    if let Some(e) = r["error_description"].as_str() {
        bail!("Microsoft: {}", e.lines().next().unwrap_or(e));
    }
    Ok(DeviceCode {
        user_code: r["user_code"].as_str().unwrap_or_default().into(),
        device_code: r["device_code"].as_str().unwrap_or_default().into(),
        verification_uri: r["verification_uri"].as_str().unwrap_or("https://www.microsoft.com/link").into(),
        interval: r["interval"].as_u64().unwrap_or(5),
        expires_in: r["expires_in"].as_u64().unwrap_or(900),
    })
}

#[tauri::command]
pub fn msa_cancel(device_code: String) {
    CANCELLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(device_code);
}

#[tauri::command]
pub async fn msa_finish(device_code: String, interval: u64) -> CmdResult<Vec<AccountView>> {
    finish(device_code, interval).await.map_err(err)
}

async fn finish(device_code: String, mut interval: u64) -> Result<Vec<AccountView>> {
    let cid = client_id()?;
    let token = loop {
        tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
        if is_cancelled(&device_code) {
            CANCELLED.lock().unwrap().as_mut().map(|c| c.remove(&device_code));
            bail!("Sign-in cancelled");
        }
        let r: Value = client()
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", cid.as_str()),
                ("device_code", device_code.as_str()),
            ])
            .send()
            .await?
            .json()
            .await?;
        match r["error"].as_str() {
            None => break r,
            Some("authorization_pending") => continue,
            Some("slow_down") => interval += 5,
            Some("expired_token") => bail!("The code expired — try again"),
            Some("authorization_declined") => bail!("Sign-in was declined"),
            Some(_) => bail!("{}", r["error_description"].as_str().unwrap_or("Sign-in failed")),
        }
    };
    let account = from_ms_token(&token).await?;
    let mut s = load_store();
    upsert(&mut s, account);
    save_store(&s)?;
    Ok(views(&s))
}

async fn from_ms_token(t: &Value) -> Result<Account> {
    let ms_access = t["access_token"].as_str().ok_or_else(|| anyhow!("Microsoft did not return a token"))?;
    let (token, expires, uuid, name) = minecraft_login(ms_access).await?;
    Ok(Account {
        uuid,
        name,
        kind: "msa".into(),
        access_token: token,
        refresh_token: t["refresh_token"].as_str().map(String::from),
        expires_at: now() + expires as i64,
    })
}

async fn minecraft_login(ms_access: &str) -> Result<(String, u64, String, String)> {
    let xbl: Value = client()
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={ms_access}") },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await?
        .error_for_status()
        .context("Xbox Live sign-in failed")?
        .json()
        .await?;
    let xbl_token = xbl["Token"].as_str().ok_or_else(|| anyhow!("Xbox Live returned no token"))?;
    let uhs = xbl["DisplayClaims"]["xui"][0]["uhs"].as_str().ok_or_else(|| anyhow!("Xbox Live returned no user hash"))?;

    let resp = client()
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await?;
    if resp.status() == 401 {
        let v: Value = resp.json().await.unwrap_or_default();
        bail!(match v["XErr"].as_u64() {
            Some(2148916233) => "This Microsoft account has no Xbox profile yet. Sign in once at xbox.com, then try again.",
            Some(2148916235) => "Xbox Live isn't available in your country.",
            Some(2148916236) | Some(2148916237) => "This account needs adult verification on xbox.com first.",
            Some(2148916238) => "This is a child account — an adult needs to add it to a Microsoft family first.",
            _ => "Xbox Live refused the sign-in.",
        });
    }
    let xsts: Value = resp.error_for_status()?.json().await?;
    let xsts_token = xsts["Token"].as_str().ok_or_else(|| anyhow!("XSTS returned no token"))?;

    let mc = client()
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts_token}") }))
        .send()
        .await?;
    if mc.status() == 401 || mc.status() == 403 {
        bail!("Minecraft refused this app's Azure client ID. New client IDs have to be approved by Mojang before they can sign in — see Settings → Integrations.");
    }
    let mc: Value = mc.error_for_status()?.json().await?;
    let token = mc["access_token"].as_str().ok_or_else(|| anyhow!("Minecraft returned no token"))?;
    let expires = mc["expires_in"].as_u64().unwrap_or(86400);

    let prof = client().get("https://api.minecraftservices.com/minecraft/profile").bearer_auth(token).send().await?;
    if prof.status() == 404 {
        bail!("This Microsoft account doesn't own Minecraft: Java Edition.");
    }
    let prof: Value = prof.error_for_status()?.json().await?;
    Ok((
        token.to_string(),
        expires,
        prof["id"].as_str().unwrap_or_default().to_string(),
        prof["name"].as_str().unwrap_or_default().to_string(),
    ))
}

/// The active account, refreshing Microsoft tokens if they are about to expire.
pub async fn account_for_launch() -> Result<Account> {
    let s = load_store();
    let active = s.active.clone().or_else(|| s.accounts.first().map(|a| a.uuid.clone())).ok_or_else(|| anyhow!("NO_ACCOUNT"))?;
    let idx = s.accounts.iter().position(|a| a.uuid == active).ok_or_else(|| anyhow!("NO_ACCOUNT"))?;
    let acc = s.accounts[idx].clone();
    if acc.kind != "msa" || acc.expires_at > now() + 300 {
        return Ok(acc);
    }
    let refresh = acc.refresh_token.clone().ok_or_else(|| anyhow!("Your session expired — please sign in again"))?;
    let cid = client_id()?;
    let t: Value = client()
        .post(TOKEN_URL)
        .form(&[("grant_type", "refresh_token"), ("client_id", cid.as_str()), ("refresh_token", refresh.as_str()), ("scope", SCOPE)])
        .send()
        .await?
        .json()
        .await?;
    if t.get("error").is_some() {
        bail!("Your Microsoft session expired — please sign in again");
    }
    let mut fresh = from_ms_token(&t).await?;
    if fresh.refresh_token.is_none() {
        fresh.refresh_token = Some(refresh);
    }
    // Re-read before writing: accounts may have been added or removed while we were refreshing.
    let mut latest = load_store();
    if let Some(slot) = latest.accounts.iter_mut().find(|a| a.uuid == fresh.uuid) {
        *slot = fresh.clone();
        save_store(&latest)?;
    }
    Ok(fresh)
}
