#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod content;
mod importers;
mod instances;
mod java;
mod launch;
mod loaders;
mod manage;
mod misc;
mod modpacks;
mod nbt;
mod net;
mod settings;
mod tasks;
mod util;
mod versions;

fn main() {
    // Dev builds expose WebView DevTools on localhost:9333 for UI debugging (release builds never do),
    // and keep their own WebView profile so they can run next to an installed copy of Orbit.
    #[cfg(debug_assertions)]
    {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9333");
        if let Some(local) = dirs::data_local_dir() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", local.join("OrbitLauncherDev").join("WebView2"));
        }
    }
    #[cfg(windows)]
    if tauri::webview_version().is_err() {
        missing_webview2();
        return;
    }
    util::paths();
    net::set_max_parallel(settings::load().parallel_downloads);
    let builder = tauri::Builder::default();
    // Opening Orbit a second time focuses the running window instead of starting a copy that
    // would write the same files. (Dev builds skip this so they can run beside a real install.)
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Local images (icons, screenshots, world thumbnails) are served from the data folder,
            // wherever it lives (including a portable ORBIT_DATA_DIR).
            use tauri::Manager;
            let _ = app.asset_protocol_scope().allow_directory(&util::paths().root, true);
            Ok(())
        })
        .manage(launch::Running::default())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::system_memory,
            settings::share_info,
            settings::set_background_image,
            settings::write_shared_defaults,
            settings::enable_portable,
            versions::get_mc_versions,
            loaders::get_loader_versions,
            java::list_java,
            auth::list_accounts,
            auth::set_active_account,
            auth::remove_account,
            auth::add_offline_account,
            auth::msa_start,
            auth::msa_finish,
            auth::msa_cancel,
            instances::list_instances,
            instances::get_instance,
            instances::create_instance,
            instances::update_instance,
            instances::delete_instance,
            instances::duplicate_instance,
            instances::open_instance_folder,
            instances::get_notes,
            instances::save_notes,
            instances::set_instance_icon,
            launch::launch_instance,
            launch::kill_instance,
            launch::get_running,
            content::search_content,
            content::test_curseforge_key,
            content::get_project,
            content::get_project_versions,
            content::install_content,
            content::add_local_files,
            content::list_content,
            content::toggle_content,
            content::set_content_enabled,
            content::delete_content,
            content::identify_content,
            content::check_updates,
            content::apply_update,
            content::apply_updates,
            modpacks::install_modpack,
            modpacks::import_modpack_file,
            modpacks::update_modpack,
            modpacks::export_instance,
            manage::ping_server,
            misc::pick_save,
            misc::pick_folder,
            manage::list_worlds,
            manage::delete_world,
            manage::backup_world,
            manage::list_servers,
            manage::save_servers,
            manage::list_screenshots,
            manage::delete_screenshot,
            manage::open_screenshot,
            manage::list_logs,
            manage::read_log,
            manage::delete_log,
            manage::upload_log,
            importers::list_external_instances,
            importers::scan_import_folder,
            importers::import_external_instance,
            misc::open_url,
            misc::open_data_folder,
            misc::data_folder,
            misc::open_launcher_folder,
            misc::pick_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbit Launcher");
}

/// Orbit's window is drawn by Microsoft Edge WebView2, which a few older Windows 10 PCs lack.
#[cfg(windows)]
fn missing_webview2() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let text = wide("Orbit Launcher needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\nPress OK to open Microsoft's download page, install the \"Evergreen Bootstrapper\", then start Orbit again.");
    let caption = wide("Orbit Launcher");
    const MB_OKCANCEL: u32 = 0x1;
    const MB_ICONINFORMATION: u32 = 0x40;
    if unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OKCANCEL | MB_ICONINFORMATION) } == 1 {
        let _ = open::that("https://developer.microsoft.com/microsoft-edge/webview2/#download");
    }
}
