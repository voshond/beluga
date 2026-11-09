fn main() {
    widgets_shim();
    tauri_build::build()
}

/// The desktop widgets' reload (src/widgets.rs): WidgetCenter is Swift only, so a tiny Swift file
/// (packages/mac/widgets/WidgetShim.swift) becomes a static library linked here. Without swiftc
/// (not a Mac, no Xcode tools) Beluga builds without it and widgets redraw on their own schedule.
fn widgets_shim() {
    println!("cargo:rustc-check-cfg=cfg(widgets_shim)");
    let shim = std::path::Path::new("../widgets/WidgetShim.swift");
    println!("cargo:rerun-if-changed={}", shim.display());
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        _ => "x86_64",
    };
    let lib = out.join("libbeluga_widget_shim.a");
    let built = std::process::Command::new("xcrun")
        .args(["swiftc", "-target", &format!("{arch}-apple-macos12.0"), "-O", "-parse-as-library", "-module-name", "BelugaWidgetShim", "-emit-library", "-static"])
        .arg(shim)
        .arg("-o")
        .arg(&lib)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !built {
        println!("cargo:warning=Desktop widgets: couldn't build the Swift shim; widgets redraw on their own schedule");
        return;
    }
    // The Swift runtime: the system's, and the toolchain's compatibility libraries for older macOS.
    let toolchain = std::process::Command::new("xcrun").args(["-f", "swiftc"]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|p| std::path::PathBuf::from(p.trim()));
    if let Some(swiftc) = toolchain {
        if let Some(usr) = swiftc.parent().and_then(|b| b.parent()) {
            println!("cargo:rustc-link-search=native={}", usr.join("lib/swift/macosx").display());
        }
    }
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=beluga_widget_shim");
    println!("cargo:rustc-link-arg=-weak_framework");
    println!("cargo:rustc-link-arg=WidgetKit");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-cfg=widgets_shim");
}
