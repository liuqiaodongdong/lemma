use crate::models::{
    compute_sha256_hex, file_modified_ms, now_unix_ms, resolve_clean_path, FileSnapshot,
    FileTreeNode, SavedAssetResult,
};
use crate::watcher::WatcherState;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State};

#[derive(Default)]
struct BootDocSlot {
    snapshot: Option<FileSnapshot>,
    preloading: bool,
    ready: bool,
    consumed: bool,
}

#[derive(Clone, Default)]
pub struct BootDocumentState(Arc<(Mutex<BootDocSlot>, Condvar)>);

impl BootDocumentState {
    pub fn begin_preload(&self) {
        let (lock, _) = &*self.0;
        if let Ok(mut slot) = lock.lock() {
            if !slot.ready {
                slot.preloading = true;
            }
        }
    }

    pub fn finish_preload(&self, snapshot: Option<FileSnapshot>) {
        let (lock, cvar) = &*self.0;
        if let Ok(mut slot) = lock.lock() {
            if !slot.consumed {
                slot.snapshot = snapshot;
            }
            slot.preloading = false;
            slot.ready = true;
            cvar.notify_all();
        }
    }
}

struct PreloadReadyGuard {
    boot_state: BootDocumentState,
    completed: bool,
}

impl Drop for PreloadReadyGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.boot_state.finish_preload(None);
        }
    }
}

fn resolve_cli_initial_path() -> Option<String> {
    let chosen = std::env::args()
        .skip(1)
        .filter(|arg| !arg.trim().is_empty() && !arg.starts_with('-'))
        .find(|arg| {
            let p = Path::new(arg);
            p.exists() && p.is_file() && is_markdown_path(p)
        });

    chosen.as_deref().map(|arg| {
        let p = Path::new(arg);
        if p.is_absolute() {
            arg.strip_prefix(r"\\?\").unwrap_or(arg).to_string()
        } else {
            resolve_clean_path(arg).to_string_lossy().into_owned()
        }
    })
}

pub fn preload_cli_document(
    app_handle: AppHandle,
    watcher_state: WatcherState,
    boot_state: BootDocumentState,
) {
    let mut guard = PreloadReadyGuard {
        boot_state: boot_state.clone(),
        completed: false,
    };

    let Some(path) = resolve_cli_initial_path() else {
        guard.completed = true;
        boot_state.finish_preload(None);
        return;
    };

    let disk_path = resolve_clean_path(&path);
    let Ok(content) = std::fs::read_to_string(&disk_path) else {
        guard.completed = true;
        boot_state.finish_preload(None);
        return;
    };

    let sha256 = compute_sha256_hex(&content);
    let modified_ms = file_modified_ms(&disk_path);
    watcher_state.record_known_hash(&path, &sha256);

    let snapshot = FileSnapshot {
        path: path.clone(),
        content,
        sha256,
        modified_ms,
    };

    guard.completed = true;
    boot_state.finish_preload(Some(snapshot));

    let _ = watcher_state.watch(app_handle, path);
}

#[tauri::command]
pub async fn consume_boot_document(
    app_handle: AppHandle,
    watcher_state: State<'_, WatcherState>,
    boot_state: State<'_, BootDocumentState>,
) -> Result<Option<FileSnapshot>, String> {
    let need_fallback_preload;
    {
        let (lock, _) = &*boot_state.0;
        let mut slot = lock
            .lock()
            .map_err(|_| "BootDocumentState mutex poisoned".to_string())?;
        if slot.consumed {
            return Ok(None);
        }
        if slot.ready {
            slot.consumed = true;
            return Ok(slot.snapshot.take());
        }
        if slot.preloading {
            need_fallback_preload = false;
        } else {
            slot.preloading = true;
            need_fallback_preload = true;
        }
    }

    let boot_clone = boot_state.inner().clone();
    let watcher_clone = watcher_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if need_fallback_preload {
            preload_cli_document(app_handle, watcher_clone, boot_clone.clone());
        }

        let (lock, cvar) = &*boot_clone.0;
        let guard = lock
            .lock()
            .map_err(|_| "BootDocumentState mutex poisoned".to_string())?;
        let (mut slot, _) = cvar
            .wait_timeout_while(guard, Duration::from_secs(5), |s| !s.ready)
            .map_err(|_| "BootDocumentState condvar poisoned".to_string())?;
        if slot.consumed {
            return Ok(None);
        }
        slot.consumed = true;
        Ok(slot.snapshot.take())
    })
    .await
    .map_err(|e| format!("Boot document task join error: {e}"))?
}

#[tauri::command]
pub fn get_cli_initial_path() -> Result<Option<String>, String> {
    Ok(resolve_cli_initial_path())
}

#[tauri::command]
pub async fn read_markdown_file(
    state: State<'_, WatcherState>,
    path: String,
) -> Result<FileSnapshot, String> {
    let watcher_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let disk_path = resolve_clean_path(&path);
        let content = std::fs::read_to_string(&disk_path)
            .map_err(|e| format!("Failed to read Markdown file '{}': {e}", path))?;
        let sha256 = compute_sha256_hex(&content);
        let modified_ms = file_modified_ms(&disk_path);

        watcher_state.record_known_hash(&path, &sha256);

        Ok(FileSnapshot {
            path,
            content,
            sha256,
            modified_ms,
        })
    })
    .await
    .map_err(|e| format!("Read task join error: {e}"))?
}

#[tauri::command]
pub async fn write_markdown_file(
    state: State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<FileSnapshot, String> {
    let watcher_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let disk_path = resolve_clean_path(&path);
        if let Some(parent) = disk_path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create parent directory '{}': {e}",
                        parent.display()
                    )
                })?;
            }
        }

        let sha256 = compute_sha256_hex(&content);

        // Record self-write hash & mark write in-flight BEFORE touching disk so `notify` events
        // triggered by Lemma's own window-blur auto-save are 100% suppressed.
        let write_guard = watcher_state.begin_self_write(&path, &sha256);

        std::fs::write(&disk_path, content.as_bytes())
            .map_err(|e| format!("Failed to write Markdown file '{}': {e}", path))?;

        write_guard.commit();

        let modified_ms = file_modified_ms(&disk_path);

        Ok(FileSnapshot {
            path,
            content,
            sha256,
            modified_ms,
        })
    })
    .await
    .map_err(|e| format!("Write task join error: {e}"))?
}

#[tauri::command]
pub async fn list_directory_tree(_root_path: String) -> Result<Vec<FileTreeNode>, String> {
    // Workspace file tree is intentionally disabled to keep Lemma strictly single-document & instant.
    Ok(Vec::new())
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "md" || lower == "markdown"
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn save_clipboard_image(
    md_file_path: String,
    base64_data: String,
    ext: Option<String>,
) -> Result<SavedAssetResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_md = resolve_clean_path(&md_file_path);
        let parent_dir = resolved_md
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| {
                format!(
                    "Cannot resolve parent directory for Markdown file: {}",
                    md_file_path
                )
            })?;

        let (raw_payload, header_ext) = strip_data_url_header(&base64_data);
        let cleaned_b64: String = raw_payload
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect();

        let decoded_bytes = BASE64_STANDARD
            .decode(cleaned_b64.as_bytes())
            .map_err(|e| format!("Invalid base64 image payload: {e}"))?;

        let sanitized_ext = sanitize_image_ext(ext.as_deref().or(header_ext.as_deref()));

        let assets_dir = parent_dir.join("assets");
        std::fs::create_dir_all(&assets_dir).map_err(|e| {
            format!(
                "Failed to create assets directory '{}': {e}",
                assets_dir.display()
            )
        })?;

        let ts_ms = now_unix_ms();
        let mut filename = format!("paste-{ts_ms}.{sanitized_ext}");
        let mut target_path = assets_dir.join(&filename);
        let mut suffix = 1u32;
        while target_path.exists() {
            filename = format!("paste-{ts_ms}-{suffix}.{sanitized_ext}");
            target_path = assets_dir.join(&filename);
            suffix += 1;
        }

        std::fs::write(&target_path, &decoded_bytes).map_err(|e| {
            format!(
                "Failed to write clipboard image '{}': {e}",
                target_path.display()
            )
        })?;

        Ok(SavedAssetResult {
            relative_path: format!("assets/{filename}"),
            absolute_path: target_path.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| format!("Clipboard image task join error: {e}"))?
}

fn strip_data_url_header(input: &str) -> (&str, Option<String>) {
    let trimmed = input.trim();
    if let Some(rest) = trimmed.strip_prefix("data:") {
        if let Some((meta, payload)) = rest.split_once(',') {
            let mime_ext = meta
                .split(';')
                .next()
                .and_then(|mime| mime.strip_prefix("image/"))
                .map(|sub| match sub.to_ascii_lowercase().as_str() {
                    "jpeg" => "jpg".to_string(),
                    "svg+xml" => "svg".to_string(),
                    other => other.to_string(),
                });
            return (payload, mime_ext);
        }
    }
    (trimmed, None)
}

fn sanitize_image_ext(raw_ext: Option<&str>) -> String {
    let candidate = raw_ext.unwrap_or("png").trim().trim_start_matches('.');
    let cleaned: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if cleaned.is_empty() {
        "png".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn watch_file(
    app_handle: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let watcher_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || watcher_state.watch(app_handle, path))
        .await
        .map_err(|e| format!("Watch task join error: {e}"))?
}

#[tauri::command]
pub async fn unwatch_file(state: State<'_, WatcherState>) -> Result<(), String> {
    let watcher_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        watcher_state.unwatch();
        Ok(())
    })
    .await
    .map_err(|e| format!("Unwatch task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_data_url_and_sanitizes_ext() {
        let (b64, ext) = strip_data_url_header("data:image/png;base64,aGVsbG8=");
        assert_eq!(b64, "aGVsbG8=");
        assert_eq!(ext.as_deref(), Some("png"));
        assert_eq!(sanitize_image_ext(Some(".WEBP")), "webp");
        assert_eq!(sanitize_image_ext(Some("../evil")), "evil");
        assert_eq!(sanitize_image_ext(Some("...")), "png");
        assert_eq!(sanitize_image_ext(None), "png");
    }

    #[test]
    fn boot_document_state_synchronizes_and_consumes_once() {
        let boot = BootDocumentState::default();
        boot.begin_preload();

        let producer = boot.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            producer.finish_preload(Some(FileSnapshot {
                path: r"C:\notes\boot.md".to_string(),
                content: "# Boot".to_string(),
                sha256: compute_sha256_hex("# Boot"),
                modified_ms: 42,
            }));
        });

        let (lock, cvar) = &*boot.0;
        let guard = lock.lock().unwrap();
        let (mut slot, _) = cvar
            .wait_timeout_while(guard, Duration::from_secs(1), |s| !s.ready)
            .unwrap();
        assert!(slot.ready);
        assert!(!slot.consumed);
        slot.consumed = true;
        let snap = slot.snapshot.take();
        drop(slot);

        handle.join().unwrap();
        assert_eq!(snap.unwrap().path, r"C:\notes\boot.md");

        let second = lock.lock().unwrap();
        assert!(second.consumed);
        assert!(second.snapshot.is_none());
    }
}
