use crate::models::{
    compute_sha256_hex, file_modified_ms, normalize_path_key, resolve_clean_path,
    ExternalChangeEvent,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EXTERNAL_CHANGE_EVENT_NAME: &str = "lemma://external-file-change";
const DEBOUNCE_DURATION: Duration = Duration::from_millis(120);
const SELF_WRITE_SUPPRESS_WINDOW: Duration = Duration::from_secs(5);
const MAX_RECENT_SELF_HASHES: usize = 8;

#[derive(Debug, Default)]
struct PathHashRecord {
    last_known_sha256: Option<String>,
    recent_self_writes: VecDeque<(String, Instant)>,
    in_flight_writes: usize,
}

impl PathHashRecord {
    fn prune_expired(&mut self) {
        while let Some((_, ts)) = self.recent_self_writes.front() {
            if ts.elapsed() > SELF_WRITE_SUPPRESS_WINDOW {
                self.recent_self_writes.pop_front();
            } else {
                break;
            }
        }
        while self.recent_self_writes.len() > MAX_RECENT_SELF_HASHES {
            self.recent_self_writes.pop_front();
        }
    }

    fn push_self_hash(&mut self, sha256: &str) {
        self.prune_expired();
        self.recent_self_writes
            .push_back((sha256.to_string(), Instant::now()));
        self.last_known_sha256 = Some(sha256.to_string());
    }
}

enum WatchSignal {
    FsEvent(Event),
    Shutdown,
}

struct ActiveWatch {
    _watcher: RecommendedWatcher,
    shutdown_tx: Sender<WatchSignal>,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(WatchSignal::Shutdown);
    }
}

#[derive(Default)]
struct WatcherInner {
    records: HashMap<String, PathHashRecord>,
    active_watch: Option<ActiveWatch>,
}

#[derive(Clone, Default)]
pub struct WatcherState {
    inner: Arc<Mutex<WatcherInner>>,
}

/// RAII guard held across `write_markdown_file` disk I/O so any OS file-truncate/write
/// notification occurring mid-write or immediately post-write is 100% suppressed.
pub struct SelfWriteGuard {
    state: WatcherState,
    norm_key: String,
    sha256: String,
}

impl SelfWriteGuard {
    /// Refresh timestamp after disk flush completes so the post-write debounce window is anchored to completion.
    pub fn commit(&self) {
        if let Ok(mut guard) = self.state.inner.lock() {
            let record = guard.records.entry(self.norm_key.clone()).or_default();
            record.push_self_hash(&self.sha256);
        }
    }
}

impl Drop for SelfWriteGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.inner.lock() {
            if let Some(record) = guard.records.get_mut(&self.norm_key) {
                record.in_flight_writes = record.in_flight_writes.saturating_sub(1);
            }
        }
    }
}

impl WatcherState {
    pub fn record_known_hash(&self, path: &str, sha256: &str) {
        let norm_key = normalize_path_key(path);
        if let Ok(mut guard) = self.inner.lock() {
            let record = guard.records.entry(norm_key).or_default();
            record.last_known_sha256 = Some(sha256.to_string());
        }
    }

    pub fn begin_self_write(&self, path: &str, sha256: &str) -> SelfWriteGuard {
        let norm_key = normalize_path_key(path);
        if let Ok(mut guard) = self.inner.lock() {
            let record = guard.records.entry(norm_key.clone()).or_default();
            record.in_flight_writes += 1;
            record.push_self_hash(sha256);
        }
        SelfWriteGuard {
            state: self.clone(),
            norm_key,
            sha256: sha256.to_string(),
        }
    }

    pub fn unwatch(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            // Dropping `ActiveWatch` stops `RecommendedWatcher` and signals worker shutdown.
            guard.active_watch = None;
        }
    }

    pub fn watch(&self, app_handle: AppHandle, raw_path: String) -> Result<(), String> {
        let target_path = resolve_clean_path(&raw_path);
        let file_name = target_path
            .file_name()
            .map(|n| n.to_os_string())
            .ok_or_else(|| format!("Invalid file path to watch: {raw_path}"))?;
        let parent_dir = target_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("Cannot determine parent directory for: {raw_path}"))?;

        if !parent_dir.exists() {
            return Err(format!(
                "Parent directory does not exist: {}",
                parent_dir.display()
            ));
        }

        let norm_key = normalize_path_key(&raw_path);

        // Seed `last_known_sha256` if this file hasn't been read/written yet in the session.
        let need_seed = self
            .inner
            .lock()
            .map(|g| {
                g.records
                    .get(&norm_key)
                    .and_then(|r| r.last_known_sha256.as_ref())
                    .is_none()
            })
            .unwrap_or(false);

        if need_seed && target_path.is_file() {
            if let Ok(initial_content) = std::fs::read_to_string(&target_path) {
                let initial_sha = compute_sha256_hex(&initial_content);
                self.record_known_hash(&raw_path, &initial_sha);
            }
        }

        let (tx, rx) = mpsc::channel::<WatchSignal>();
        let watcher_tx = tx.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                let _ = watcher_tx.send(WatchSignal::FsEvent(event));
            }
        })
        .map_err(|e| format!("Failed to initialize file watcher: {e}"))?;

        // Watch parent directory non-recursively so atomic temp-file + rename writes
        // by AI agents (Claude Code, Antigravity, Python os.replace, editors) are caught reliably.
        watcher
            .watch(&parent_dir, RecursiveMode::NonRecursive)
            .map_err(|e| {
                format!(
                    "Failed to watch parent directory '{}': {e}",
                    parent_dir.display()
                )
            })?;

        let state_clone = self.clone();
        let watched_path_for_event = raw_path.clone();
        let parent_for_worker = parent_dir.clone();

        thread::Builder::new()
            .name("lemma-file-watcher".to_string())
            .spawn(move || {
                run_debounce_worker(
                    rx,
                    state_clone,
                    app_handle,
                    target_path,
                    parent_for_worker,
                    file_name,
                    norm_key,
                    watched_path_for_event,
                );
            })
            .map_err(|e| format!("Failed to spawn file watcher thread: {e}"))?;

        if let Ok(mut guard) = self.inner.lock() {
            guard.active_watch = Some(ActiveWatch {
                _watcher: watcher,
                shutdown_tx: tx,
            });
        }

        Ok(())
    }

    fn has_in_flight_write(&self, norm_key: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.records.get(norm_key).map(|r| r.in_flight_writes > 0))
            .unwrap_or(false)
    }

    /// Check whether `sha256` represents a genuine external change.
    /// Updates `last_known_sha256` and returns `true` only if an external change event should be emitted.
    pub fn evaluate_observed_hash(&self, norm_key: &str, sha256: &str) -> bool {
        let Ok(mut guard) = self.inner.lock() else {
            return false;
        };
        let record = guard.records.entry(norm_key.to_string()).or_default();
        record.prune_expired();

        if record.last_known_sha256.as_deref() == Some(sha256) {
            return false;
        }

        let matches_self_write = record
            .recent_self_writes
            .iter()
            .any(|(self_sha, ts)| self_sha == sha256 && ts.elapsed() <= SELF_WRITE_SUPPRESS_WINDOW);

        if matches_self_write {
            record.last_known_sha256 = Some(sha256.to_string());
            return false;
        }

        record.last_known_sha256 = Some(sha256.to_string());
        record.recent_self_writes.clear();
        true
    }
}

#[allow(clippy::too_many_arguments)]
fn run_debounce_worker(
    rx: mpsc::Receiver<WatchSignal>,
    state: WatcherState,
    app_handle: AppHandle,
    target_path: PathBuf,
    parent_dir: PathBuf,
    target_file_name: std::ffi::OsString,
    norm_key: String,
    watched_path_for_event: String,
) {
    let mut deadline: Option<Instant> = None;

    loop {
        match deadline {
            None => match rx.recv() {
                Ok(WatchSignal::Shutdown) | Err(_) => break,
                Ok(WatchSignal::FsEvent(ev)) => {
                    if is_relevant_event(&ev, &target_file_name, &parent_dir) {
                        deadline = Some(Instant::now() + DEBOUNCE_DURATION);
                    }
                }
            },
            Some(due) => {
                let now = Instant::now();
                if now >= due {
                    if state.has_in_flight_write(&norm_key) {
                        deadline = Some(Instant::now() + Duration::from_millis(50));
                        continue;
                    }
                    deadline = None;
                    if let Some((content, modified_ms)) = read_utf8_with_retry(&target_path) {
                        let sha256 = compute_sha256_hex(&content);
                        if state.evaluate_observed_hash(&norm_key, &sha256) {
                            let payload = ExternalChangeEvent {
                                path: watched_path_for_event.clone(),
                                content,
                                sha256,
                                modified_ms,
                            };
                            let _ = Emitter::emit(&app_handle, EXTERNAL_CHANGE_EVENT_NAME, payload);
                        }
                    }
                    continue;
                }

                let remaining = due.saturating_duration_since(now);
                match rx.recv_timeout(remaining) {
                    Ok(WatchSignal::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                    Ok(WatchSignal::FsEvent(ev)) => {
                        if is_relevant_event(&ev, &target_file_name, &parent_dir) {
                            deadline = Some(Instant::now() + DEBOUNCE_DURATION);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // Next loop iteration sees `Instant::now() >= due` and processes the debounced file read.
                    }
                }
            }
        }
    }
}

fn is_relevant_event(event: &Event, target_file_name: &OsStr, parent_dir: &Path) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    if event.paths.is_empty() {
        return true;
    }
    for path in &event.paths {
        if path == parent_dir {
            return true;
        }
        if let Some(name) = path.file_name() {
            if os_str_eq_filename(name, target_file_name) {
                return true;
            }
        }
    }
    false
}

fn os_str_eq_filename(a: &OsStr, b: &OsStr) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Read UTF-8 content from disk, retrying after 40ms if temporarily locked on Windows
/// during atomic rename or external editor flush.
fn read_utf8_with_retry(path: &Path) -> Option<(String, u64)> {
    match std::fs::read_to_string(path) {
        Ok(content) => Some((content, file_modified_ms(path))),
        Err(_) => {
            thread::sleep(Duration::from_millis(40));
            let content = std::fs::read_to_string(path).ok()?;
            Some((content, file_modified_ms(path)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_self_write_and_detects_external_changes() {
        let state = WatcherState::default();
        let path = r"C:\Temp\lemma_test.md";
        let norm = normalize_path_key(path);

        let sha_v1 = compute_sha256_hex("# Version 1");
        state.record_known_hash(path, &sha_v1);
        assert!(!state.evaluate_observed_hash(&norm, &sha_v1));

        // Self-write to Version 2 must be suppressed
        let sha_v2 = compute_sha256_hex("# Version 2 (auto-saved on blur)");
        {
            let guard = state.begin_self_write(path, &sha_v2);
            assert!(state.has_in_flight_write(&norm));
            guard.commit();
        }
        assert!(!state.has_in_flight_write(&norm));
        assert!(!state.evaluate_observed_hash(&norm, &sha_v2));

        // External AI agent edit to Version 3 MUST fire
        let sha_v3 = compute_sha256_hex("# Version 3 (edited by Claude Code)");
        assert!(state.evaluate_observed_hash(&norm, &sha_v3));
        // Duplicate notification for same Version 3 must be ignored
        assert!(!state.evaluate_observed_hash(&norm, &sha_v3));

        // External revert back to Version 2 (e.g. git checkout) MUST also fire
        assert!(state.evaluate_observed_hash(&norm, &sha_v2));
    }
}
