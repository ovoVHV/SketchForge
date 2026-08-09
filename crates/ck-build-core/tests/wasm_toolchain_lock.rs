use serde_json::Value;

const TOOLCHAIN_LOCK: &str = include_str!("../wasm-build.lock.json");
const CARGO_LOCK: &str = include_str!("../Cargo.lock");

#[test]
fn wasm_toolchain_and_bindgen_versions_are_fully_pinned() {
    let lock: Value = serde_json::from_str(TOOLCHAIN_LOCK).unwrap();
    let toolchain = lock["rustToolchain"].as_str().unwrap();
    let target = lock["target"].as_str().unwrap();
    let bindgen = lock["wasmBindgen"]["version"].as_str().unwrap();

    assert_eq!(toolchain, "1.93.0-x86_64-pc-windows-msvc");
    assert_eq!(target, "wasm32-unknown-unknown");
    assert_eq!(bindgen, "0.2.126");
    assert!(CARGO_LOCK.contains(&format!("name = \"wasm-bindgen\"\nversion = \"{bindgen}\"")));

    let artifacts = lock["wasmBindgen"]["hostArtifacts"].as_object().unwrap();
    assert!(!artifacts.is_empty());
    for artifact in artifacts.values() {
        let url = artifact["url"].as_str().unwrap();
        let sha256 = artifact["sha256"].as_str().unwrap();
        assert!(url.starts_with("https://github.com/wasm-bindgen/wasm-bindgen/releases/"));
        assert_eq!(sha256.len(), 64);
        assert!(sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
