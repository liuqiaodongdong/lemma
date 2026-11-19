pub mod commands;
pub mod models;
pub mod watcher;

use commands::{
    consume_boot_document, get_cli_initial_path, list_directory_tree, preload_cli_document,
    read_markdown_file, save_clipboard_image, unwatch_file, watch_file, write_markdown_file,
    BootDocumentState,
};
use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_state = WatcherState::default();
    let boot_state = BootDocumentState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(watcher_state.clone())
        .manage(boot_state.clone())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            boot_state.begin_preload();
            let boot_fallback = boot_state.clone();
            if std::thread::Builder::new()
                .name("lemma-boot-preload".to_string())
                .spawn(move || {
                    preload_cli_document(app_handle, watcher_state, boot_state);
                })
                .is_err()
            {
                boot_fallback.finish_preload(None);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            consume_boot_document,
            get_cli_initial_path,
            read_markdown_file,
            write_markdown_file,
            list_directory_tree,
            save_clipboard_image,
            watch_file,
            unwatch_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lemma Tauri application");
}
