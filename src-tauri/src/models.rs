use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileTreeNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChangeEvent {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAssetResult {
    pub relative_path: String,
    pub absolute_path: String,
}

/// Compute lowercase 64-character hex SHA-256 digest of UTF-8 content.
pub fn compute_sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// Read file modification timestamp in Unix epoch milliseconds.
pub fn file_modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or_else(now_unix_ms)
}

/// Current Unix epoch timestamp in milliseconds.
pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve a potentially relative path against `current_dir()` without adding Windows `\\?\` verbatim prefixes.
pub fn resolve_clean_path(raw_path: &str) -> PathBuf {
    let stripped = raw_path
        .strip_prefix(r"\\?\")
        .or_else(|| raw_path.strip_prefix("//?/"))
        .unwrap_or(raw_path);
    let candidate = Path::new(stripped);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(candidate)
    };
    lexically_normalize(&joined)
}

/// Lexically normalize `.` and `..` segments while preserving drive/root prefixes cleanly.
pub fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                } else if !path.is_absolute() {
                    out.push(comp.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Produce a canonical lookup key for per-file hash tracking in `WatcherState`.
pub fn normalize_path_key(raw_path: &str) -> String {
    let resolved = resolve_clean_path(raw_path);
    let text = resolved.to_string_lossy();
    #[cfg(windows)]
    {
        text.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_camel_case_matches_typescript_contract() {
        let snap = FileSnapshot {
            path: "C:\\notes\\paper.md".to_string(),
            content: "# Lemma".to_string(),
            sha256: compute_sha256_hex("# Lemma"),
            modified_ms: 1731590000123,
        };
        let snap_val = serde_json::to_value(&snap).unwrap();
        assert_eq!(snap_val["path"], "C:\\notes\\paper.md");
        assert_eq!(snap_val["content"], "# Lemma");
        assert_eq!(snap_val["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(snap_val["modifiedMs"], 1731590000123u64);

        let tree = FileTreeNode {
            name: "docs".to_string(),
            path: "C:\\notes\\docs".to_string(),
            is_dir: true,
            children: Some(vec![FileTreeNode {
                name: "intro.md".to_string(),
                path: "C:\\notes\\docs\\intro.md".to_string(),
                is_dir: false,
                children: None,
            }]),
        };
        let tree_val = serde_json::to_value(&tree).unwrap();
        assert_eq!(tree_val["isDir"], true);
        assert_eq!(tree_val["children"][0]["isDir"], false);
        assert!(tree_val["children"][0].get("children").is_none());

        let ext_ev = ExternalChangeEvent {
            path: "C:\\notes\\paper.md".to_string(),
            content: "updated".to_string(),
            sha256: compute_sha256_hex("updated"),
            modified_ms: 1731590000999,
        };
        let ext_val = serde_json::to_value(&ext_ev).unwrap();
        assert_eq!(ext_val["modifiedMs"], 1731590000999u64);

        let asset = SavedAssetResult {
            relative_path: "assets/paste-1.png".to_string(),
            absolute_path: "C:\\notes\\assets\\paste-1.png".to_string(),
        };
        let asset_val = serde_json::to_value(&asset).unwrap();
        assert_eq!(asset_val["relativePath"], "assets/paste-1.png");
        assert_eq!(asset_val["absolutePath"], "C:\\notes\\assets\\paste-1.png");
    }
}

