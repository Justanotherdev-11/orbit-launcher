# Orbit Launcher

A Minecraft: Java Edition launcher with everything Prism Launcher does, and a cleaner look. It's built with Tauri (Rust + WebView2), so the whole launcher is a single ~6 MB exe.

## Using it

Double-click **Orbit Launcher.exe**. There's nothing to install, and you don't need Java: Orbit downloads the exact runtime Mojang uses for each Minecraft version.

**Giving it to a friend:** zip this folder and send it. It works on any Windows 10/11 PC. If their PC lacks the WebView2 runtime (rare), Orbit tells them where to get it. Your Microsoft sign-in never travels with the folder; accounts are always stored per-PC.

- **Portable mode** (Settings → Sharing) keeps your instances in an `OrbitData` folder next to the exe, so they go wherever the folder goes.
- **Pass your keys along** (Settings → Sharing) writes `orbit-defaults.json` next to the exe. Whoever you send it to then gets working CurseForge browsing and Microsoft sign-in.

## Features

- **Unlimited instances.** Any version (back to the old alphas) with Fabric, Quilt, Forge or NeoForge. Group, duplicate, give them icons, and export them as a backup `.zip` or a shareable Modrinth `.mrpack`.
- **Modrinth + CurseForge built in.** Mods, modpacks, resource packs and shaders, filtered to the instance's version and loader. Dependencies install automatically and updates are one click. Modpacks update cleanly, and you can roll them back too.
- **Import from any launcher.** Prism, PolyMC, MultiMC, CurseForge, Modrinth App, ATLauncher, GDLauncher and the official Minecraft Launcher are found automatically. You can also point it at any folder: Orbit recognises the launcher, or works out the version and loader from the mods inside.
- **Prism-style instance pages:**
  - live log (search, colours, upload, kill)
  - Version
  - Modpack
  - Mods, Resource packs, Shader packs (bulk enable/disable/delete)
  - Worlds (Play straight into one, back up, copy seed)
  - Servers (live status, player count, ping, coloured MOTD, one-click Join)
  - Screenshots
  - Notes
  - Other logs
  - per-instance Java, memory, window size, custom commands and env vars
- **Home:** your last-played instance, plus what's popular on Modrinth this week, month, year or all time.
- **Mod update notifications.** When Orbit opens it checks every instance's mods, resource packs and shaders against Modrinth. If anything is outdated you get a notification with **Update all** and **Review**. Modpack instances are skipped by default, since packs update through their Modpack tab.
- **Something to do while it loads.** A mining mini-game runs on the launch screen: click the glowing ore for points, combos and a best score. A rotating "Did you know" Minecraft fact shows underneath.
- **Graceful Stop.** Stop asks Minecraft to close normally (saving your world). It only forces it if the game hangs.
- **Ctrl+K command palette.** Launch or open anything. Ctrl+N creates an instance, Ctrl+1–4 switches pages.
- **Customize everything** (Settings → Customize):
  - **Look:** theme (Dark, OLED, Dim, Light), any accent colour, corner style, fonts, UI scale, density
  - **Background:** dots, grid, ore or your own image, with dim and blur
  - **Instance art:** stone, deepslate, netherrack, end stone, sandstone or prismarine, with as much ore as you like
  - **Layout:** sidebar side and labels, title-bar clock and search, start page
  - **Motion:** every animation individually, speed, or turn them all off
  - **Sound:** chiptune UI sounds and volume
  - **Pages:** Home sections, Library view, card size and sort, Discover defaults
  - **Notifications and logs:** pop-up placement and timing, console text size and wrapping
  - **Behaviour:** delete confirmations, parallel downloads
  - **Profiles:** copy your whole look to a friend as text

## Setup notes

- **CurseForge** needs a free API key from [console.curseforge.com](https://console.curseforge.com/). Paste it in Settings → Integrations, or right on the Discover page. Modrinth needs no key.
- **Microsoft sign-in.** Every third-party launcher signs in through its own Azure app, and Mojang has to approve it. Register one at portal.azure.com (personal accounts, "Allow public client flows" on), request access at [aka.ms/mce-reviewappid](https://aka.ms/mce-reviewappid), and paste the client ID into Settings → Integrations. Offline accounts are available once a Microsoft account that owns Minecraft: Java Edition has signed in, the same rule other approved launchers use.

## Building from source

You need Rust (MSVC toolchain, from [rustup.rs](https://rustup.rs)) and the Visual Studio C++ Build Tools. There's no Node.js and no build step for the UI.

```powershell
.\build.ps1          # optimized build -> "Orbit Launcher.exe" in this folder
.\build.ps1 -Debug   # dev build with DevTools on localhost:9333
```

Build files go to `%LOCALAPPDATA%\OrbitLauncherBuild` so cloud-synced folders stay small.

## Layout

```
ui/                  HTML/CSS/JS front end (fonts bundled, OFL licensed)
  js/views/          home, library, instance, discover, settings
  js/fx.js           launch sequence, page wipe, tilt, text decode
  js/customize.js    every Settings → Customize option
src-tauri/src/
  versions.rs        Mojang manifest, version JSON merging, libraries, assets
  java.rs            Mojang Java runtimes
  loaders.rs         Fabric / Quilt / Forge / NeoForge
  launch.rs          arguments, process, log streaming, graceful stop
  content.rs         Modrinth & CurseForge, mod metadata, updates
  modpacks.rs        install, update, import, export (.mrpack / backup)
  importers.rs       other launchers and arbitrary folders
  manage.rs          worlds, servers (+ live ping), screenshots, logs
  auth.rs            Microsoft + offline accounts
```
