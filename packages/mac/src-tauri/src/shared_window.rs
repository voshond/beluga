//! Where the window you share sits on your screen (BLG-743). Sharing one window (not a whole
//! screen), WebKit gives the picture but not its place, so the overlay couldn't put the others'
//! pointers and ink on it. macOS's window list has every window's place and size: the shared one is
//! the window whose size, in pixels, is the picture's (the title settles a tie). Needs no
//! permission beyond Screen Recording, which sharing already has.

/// A window's place and size, in points on the whole desktop (top-left origin, as Tauri's).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// How far (pixels) a window's size may be from the picture's and still be it.
const NEAR_PX: f64 = 3.0;

/// A window on screen, as macOS lists it (front to back).
#[derive(Debug, Clone)]
pub struct Listed {
    pub rect: Rect,
    pub name: Option<String>,
}

/// The shared window among `windows` (front to back): its size times its screen's scale is the
/// picture's. Several that size in one place (maximized windows) are one place; in different
/// places, the one titled `label` settles it, else nothing (better no pointers than misplaced ones).
pub fn pick(
    windows: &[Listed],
    width: f64,
    height: f64,
    label: Option<&str>,
    scale_at: impl Fn(&Rect) -> f64,
) -> Option<Rect> {
    let fits: Vec<&Listed> = windows
        .iter()
        .filter(|w| {
            let s = scale_at(&w.rect);
            (w.rect.width * s - width).abs() <= NEAR_PX
                && (w.rect.height * s - height).abs() <= NEAR_PX
        })
        .collect();
    let first = fits.first()?;
    if fits.iter().all(|w| w.rect == first.rect) {
        return Some(first.rect);
    }
    label
        .filter(|l| !l.is_empty())
        .and_then(|l| fits.iter().find(|w| w.name.as_deref() == Some(l)))
        .map(|w| w.rect)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{Listed, Rect};
    use std::ffi::{c_char, c_void, CStr};

    type CFTypeRef = *const c_void;

    #[repr(C)]
    #[derive(Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    const NUMBER_SINT64: isize = 4;
    const NUMBER_DOUBLE: isize = 13;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
        static kCGWindowBounds: CFTypeRef;
        static kCGWindowLayer: CFTypeRef;
        static kCGWindowOwnerPID: CFTypeRef;
        static kCGWindowName: CFTypeRef;
        static kCGWindowAlpha: CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFNumberGetValue(number: CFTypeRef, kind: isize, out: *mut c_void) -> bool;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> bool;
        fn CFRelease(cf: CFTypeRef);
    }

    /// A number in a window's entry.
    ///
    /// SAFETY: `dict` is a live CFDictionary from the window list.
    unsafe fn int(dict: CFTypeRef, key: CFTypeRef) -> Option<i64> {
        let v = CFDictionaryGetValue(dict, key);
        let mut out: i64 = 0;
        (!v.is_null() && CFNumberGetValue(v, NUMBER_SINT64, (&raw mut out).cast())).then_some(out)
    }

    /// SAFETY: as `int`.
    unsafe fn float(dict: CFTypeRef, key: CFTypeRef) -> Option<f64> {
        let v = CFDictionaryGetValue(dict, key);
        let mut out: f64 = 0.0;
        (!v.is_null() && CFNumberGetValue(v, NUMBER_DOUBLE, (&raw mut out).cast())).then_some(out)
    }

    /// SAFETY: as `int`.
    unsafe fn text(dict: CFTypeRef, key: CFTypeRef) -> Option<String> {
        let v = CFDictionaryGetValue(dict, key);
        if v.is_null() {
            return None;
        }
        let mut buf = [0 as c_char; 512];
        CFStringGetCString(v, buf.as_mut_ptr(), buf.len() as isize, UTF8)
            .then(|| CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }

    /// The other apps' ordinary windows on screen now, front to back (Beluga's own left out).
    pub fn windows() -> Vec<Listed> {
        let me = i64::from(std::process::id());
        // SAFETY: CoreGraphics returns an owned CFArray of CFDictionaries (released below); every
        // key is one of CoreGraphics' own constants, and each value is checked before it's read.
        unsafe {
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
            if list.is_null() {
                return Vec::new();
            }
            let mut out = Vec::new();
            for i in 0..CFArrayGetCount(list) {
                let w = CFArrayGetValueAtIndex(list, i);
                if w.is_null()
                    || int(w, kCGWindowLayer) != Some(0)
                    || int(w, kCGWindowOwnerPID) == Some(me)
                    || float(w, kCGWindowAlpha) == Some(0.0)
                {
                    continue;
                }
                let bounds = CFDictionaryGetValue(w, kCGWindowBounds);
                let mut r = CGRect::default();
                if bounds.is_null() || !CGRectMakeWithDictionaryRepresentation(bounds, &raw mut r) {
                    continue;
                }
                out.push(Listed {
                    rect: Rect {
                        x: r.origin.x,
                        y: r.origin.y,
                        width: r.size.width,
                        height: r.size.height,
                    },
                    name: text(w, kCGWindowName),
                });
            }
            CFRelease(list);
            out
        }
    }
}

/// The other apps' windows on screen, front to back (none outside macOS).
pub fn windows() -> Vec<Listed> {
    #[cfg(target_os = "macos")]
    return mac::windows();
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(x: f64, w: f64, h: f64, name: &str) -> Listed {
        Listed {
            rect: Rect {
                x,
                y: 40.0,
                width: w,
                height: h,
            },
            name: Some(name.to_owned()),
        }
    }

    #[test]
    fn finds_the_window_whose_pixels_are_the_pictures() {
        let list = [
            win(0.0, 800.0, 600.0, "Notes"),
            win(100.0, 1200.0, 800.0, "Safari"),
        ];
        let found = pick(&list, 2400.0, 1600.0, None, |_| 2.0);
        assert_eq!(found.map(|r| r.x), Some(100.0));
    }

    #[test]
    fn same_size_windows_in_one_place_are_one_place() {
        let list = [
            win(0.0, 1200.0, 800.0, "Terminal"),
            win(0.0, 1200.0, 800.0, "Safari"),
        ];
        assert_eq!(
            pick(&list, 2400.0, 1600.0, None, |_| 2.0).map(|r| r.x),
            Some(0.0)
        );
    }

    #[test]
    fn in_different_places_a_title_settles_it_else_nothing() {
        let list = [
            win(0.0, 1200.0, 800.0, "Terminal"),
            win(100.0, 1200.0, 800.0, "Safari"),
        ];
        assert_eq!(
            pick(&list, 2400.0, 1600.0, Some("Safari"), |_| 2.0).map(|r| r.x),
            Some(100.0)
        );
        assert_eq!(pick(&list, 2400.0, 1600.0, None, |_| 2.0), None);
        assert_eq!(pick(&list, 2400.0, 1600.0, Some("Mail"), |_| 2.0), None);
    }

    #[test]
    fn nothing_when_no_window_is_that_size() {
        let list = [win(0.0, 800.0, 600.0, "Notes")];
        assert_eq!(pick(&list, 2400.0, 1600.0, None, |_| 2.0), None);
    }
}
