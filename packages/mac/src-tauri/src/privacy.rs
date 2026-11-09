//! The macOS permissions the welcome offers (onboarding's permission steps): Screen Recording,
//! Accessibility, Full Disk Access and Automation. Every one is optional. For each, whether
//! Beluga has it (where macOS lets an app tell), and a way to it: Beluga put in the pane's list
//! where macOS allows that, then System Settings opened at that pane.
//!
//! The daemon and the commands Claude runs are Beluga's children, so macOS asks about them, and
//! remembers the answer, as Beluga.

use serde::Serialize;

/// One permission: "granted", "off" (not allowed, or never asked), or "unknown" (macOS won't say).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyAccess {
    pub screen: &'static str,
    pub accessibility: &'static str,
    pub disk: &'static str,
    pub automation: &'static str,
}

impl PrivacyAccess {
    const UNKNOWN: PrivacyAccess = PrivacyAccess {
        screen: "unknown",
        accessibility: "unknown",
        disk: "unknown",
        automation: "unknown",
    };
}

/// The System Settings pane for a permission (only these: the window can't open anything else).
fn pane_url(pane: &str) -> Result<&'static str, String> {
    match pane {
        "screen" => Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
        "accessibility" => Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
        "disk" => Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
        "automation" => Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"),
        other => Err(format!("Not a permission Beluga asks for: {other}")),
    }
}

fn open_pane(pane: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(pane_url(pane)?)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open System Settings: {e}"))
}

/// Full Disk Access: reading the privacy database itself only works with it.
fn disk_state() -> &'static str {
    let Some(home) = dirs::home_dir() else {
        return "unknown";
    };
    let db = home
        .join("Library")
        .join("Application Support")
        .join("com.apple.TCC")
        .join("TCC.db");
    match std::fs::File::open(db) {
        Ok(_) => "granted",
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "off",
        Err(_) => "unknown",
    }
}

/// What macOS says about each permission now.
#[tauri::command]
pub async fn privacy_access() -> PrivacyAccess {
    tauri::async_runtime::spawn_blocking(|| PrivacyAccess {
        screen: mac::screen(),
        accessibility: mac::accessibility(),
        disk: disk_state(),
        automation: mac::automation(false),
    })
    .await
    .unwrap_or(PrivacyAccess::UNKNOWN)
}

/// Ask for one permission: Beluga goes into the pane's list (Screen Recording and Accessibility
/// show macOS's own prompt the first time), then System Settings opens at it. Automation asks
/// with macOS's prompt (for Finder); its pane only opens when that was declined before.
#[tauri::command]
pub async fn privacy_request(pane: String) -> Result<(), String> {
    pane_url(&pane)?;
    tauri::async_runtime::spawn_blocking(move || {
        match pane.as_str() {
            "screen" => mac::request_screen(),
            "accessibility" => mac::request_accessibility(),
            "automation" if mac::automation(true) == "granted" => return Ok(()),
            _ => {}
        }
        open_pane(&pane)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    #[repr(C)]
    struct Opaque {
        _p: [u8; 0],
    }

    /// AEDataModel.h packs its structs to 2 bytes.
    #[repr(C, packed(2))]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> u8;
        fn CGRequestScreenCaptureAccess() -> u8;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(target: *const AEDesc, class: u32, id: u32, ask: u8) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: Opaque;
        static kCFTypeDictionaryValueCallBacks: Opaque;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const Opaque,
            value_callbacks: *const Opaque,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    const fn four(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }
    const TYPE_BUNDLE_ID: u32 = four(b"bund");
    const WILDCARD: u32 = four(b"****");
    const NOT_PERMITTED: i32 = -1743;
    const WOULD_ASK: i32 = -1744;

    pub fn screen() -> &'static str {
        // SAFETY: no arguments; only reads what macOS decided.
        if unsafe { CGPreflightScreenCaptureAccess() } != 0 {
            "granted"
        } else {
            "off"
        }
    }

    pub fn request_screen() {
        // SAFETY: no arguments; shows macOS's prompt the first time and lists Beluga in the pane.
        unsafe { CGRequestScreenCaptureAccess() };
    }

    pub fn accessibility() -> &'static str {
        // SAFETY: no arguments.
        if unsafe { AXIsProcessTrusted() } != 0 {
            "granted"
        } else {
            "off"
        }
    }

    pub fn request_accessibility() {
        // SAFETY: a one-entry CFDictionary of CF constants, released after the call.
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            if options.is_null() {
                return;
            }
            AXIsProcessTrustedWithOptions(options);
            CFRelease(options);
        }
    }

    /// Whether Beluga may send Apple events to Finder (the one app that's always running).
    /// `ask`: show macOS's prompt if it hasn't been answered (this waits for the answer).
    pub fn automation(ask: bool) -> &'static str {
        let id = b"com.apple.finder";
        let mut target = AEDesc {
            descriptor_type: 0,
            data_handle: std::ptr::null_mut(),
        };
        // SAFETY: AECreateDesc copies the bytes; the descriptor is disposed of before returning.
        unsafe {
            if AECreateDesc(TYPE_BUNDLE_ID, id.as_ptr().cast(), id.len() as isize, &mut target) != 0 {
                return "unknown";
            }
            let status = AEDeterminePermissionToAutomateTarget(&target, WILDCARD, WILDCARD, u8::from(ask));
            AEDisposeDesc(&mut target);
            match status {
                0 => "granted",
                NOT_PERMITTED | WOULD_ASK => "off",
                _ => "unknown",
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    pub fn screen() -> &'static str {
        "unknown"
    }
    pub fn request_screen() {}
    pub fn accessibility() -> &'static str {
        "unknown"
    }
    pub fn request_accessibility() {}
    pub fn automation(_ask: bool) -> &'static str {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_the_privacy_panes_it_knows() {
        assert_eq!(
            pane_url("screen").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            pane_url("accessibility").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(
            pane_url("disk").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
        assert_eq!(
            pane_url("automation").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        );
        assert!(pane_url("../evil").is_err());
        assert!(pane_url("notifications").is_err());
    }

    #[test]
    fn says_something_for_every_permission() {
        let now = PrivacyAccess {
            screen: mac::screen(),
            accessibility: mac::accessibility(),
            disk: disk_state(),
            automation: mac::automation(false),
        };
        for state in [now.screen, now.accessibility, now.disk, now.automation] {
            assert!(["granted", "off", "unknown"].contains(&state), "{state}");
        }
        let json = serde_json::to_value(PrivacyAccess::UNKNOWN).unwrap();
        assert_eq!(json["automation"], "unknown");
    }
}
