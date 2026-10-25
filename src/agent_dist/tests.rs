use super::*;
use serde_json::json;

#[test]
fn prune_keeps_current_previous_and_foreign_entries() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(temp.path().to_path_buf());
    let versions = root(&paths).join("versions");
    for name in ["0.1.0", "0.2.0", "0.3.0", ".staging-abc", "notes"] {
        fs::create_dir_all(versions.join(name)).unwrap();
    }
    prune(&paths, "0.3.0", Some("0.2.0"));
    let mut left: Vec<String> = fs::read_dir(&versions)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, [".staging-abc", "0.2.0", "0.3.0", "notes"]);
}

#[test]
fn select_release_picks_highest_stable_agent_tag() {
    let asset = asset_name().unwrap();
    let release = |tag: &str, draft: bool, prerelease: bool| {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "assets": [
                {"name": asset, "browser_download_url": format!("https://example.test/{tag}/{asset}")},
                {"name": "SHA256SUMS", "browser_download_url": format!("https://example.test/{tag}/SHA256SUMS")},
            ],
        })
    };
    let releases = [
        release("v9.0.0", false, false),
        release("rx-agent-v1.9.0", false, false),
        release("rx-agent-v1.10.0", false, false),
        release("rx-agent-v2.0.0", true, false),
        release("rx-agent-v3.0.0", false, true),
        release("rx-agent-v4.0.0-beta", false, false),
    ];
    let selected = select_release(&releases).unwrap();
    assert_eq!(selected.version, "1.10.0");
    assert_eq!(selected.checksum_url, "https://example.test/rx-agent-v1.10.0/SHA256SUMS");
}

#[test]
fn managed_binary_rejects_non_stable_versions() {
    let paths = Paths::in_dir(PathBuf::from("/tmp/rx"));
    assert!(binary(&paths, "../x").is_err());
    assert!(binary(&paths, "0.1.0-beta").is_err());
    assert!(binary(&paths, "0.1.0").unwrap().ends_with(if cfg!(windows) {
        "versions/0.1.0/rx-agent.exe"
    } else {
        "versions/0.1.0/rx-agent"
    }));
}
