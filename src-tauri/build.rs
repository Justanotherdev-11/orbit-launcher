fn main() {
    // The UI is embedded at compile time; rebuild whenever any of it changes.
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
