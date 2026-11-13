//! The baseline: the app's own grid (web/main.tsx imports VirtualSections and PhotoGrid from
//! app/src) in a WebKitGTK webview, the engine and GTK major the app itself runs on
//! (webkit2gtk-4.1 on GTK 3, through the same crate versions wry uses), with wry's settings:
//! everything that matters for drawing is left at WebKitGTK's defaults.
//!
//! The page runs the scroll script and counts its frames; this process serves it, reads the
//! webview's processes from /proc, and writes the result.

use gtk::prelude::*;
use ng_common::{Args, PhaseData, Recorder};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use webkit2gtk::{SettingsExt, WebViewExt};

fn main() {
    let args = Args::parse();
    let pool = ng_common::ensure_thumbs(&args);
    if args.gen_only {
        return;
    }
    if !args.dist.join("index.html").exists() {
        eprintln!("no web build at {} (run.sh builds it)", args.dist.display());
        std::process::exit(1);
    }
    gtk::init().expect("GTK 3");
    let phases = ng_common::script(&args);
    let rec = Recorder::new(true);
    let config = json!({ "n": args.n, "cell": args.tile, "sections": args.sections, "phases": ng_common::script_json(&phases) }).to_string();
    let host_env: Arc<Mutex<Value>> = Arc::new(Mutex::new(json!({})));

    let (a, r, ph, he) = (args.clone(), rec.clone(), phases.clone(), host_env.clone());
    let hook: ng_common::Hook = Arc::new(move |method, target, body| {
        if target == "/config.json" {
            return Some(("application/json", config.clone().into_bytes()));
        }
        if let Some(name) = target.strip_prefix("/mark?p=") {
            r.mark(name);
            return Some(("text/plain", vec![]));
        }
        if method == "POST" && target == "/log" {
            eprintln!("[page] {}", String::from_utf8_lossy(body));
            return Some(("text/plain", vec![]));
        }
        if method == "POST" && target == "/report" {
            let page: Value = serde_json::from_slice(body).unwrap_or(json!({}));
            let data: Vec<PhaseData> = page["phases"].as_array().map(|v| v.iter().map(|p| PhaseData {
                dts: p["dts"].as_array().map(|d| d.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default(),
                probes: p["probes"].as_u64().unwrap_or(0),
                probes_blank: p["probesBlank"].as_u64().unwrap_or(0),
                blank_sum: p["blankSum"].as_u64().unwrap_or(0),
                vis_sum: p["visSum"].as_u64().unwrap_or(0),
            }).collect()).unwrap_or_default();
            let mut env = page["env"].clone();
            env["machine"] = ng_common::machine_env();
            for (k, v) in he.lock().unwrap().as_object().cloned().unwrap_or_default() {
                env[k] = v;
            }
            env["frame_time_source"] = json!("gaps between requestAnimationFrame callbacks (performance.now())");
            let out = r.finish("webkitgtk", &ph, &data, env, a.config_json());
            std::fs::write(&a.out, serde_json::to_string_pretty(&out).unwrap()).expect("write the result");
            eprintln!("[webkit] wrote {}", a.out.display());
            gtk::glib::idle_add_once(gtk::main_quit);
            return Some(("text/plain", vec![]));
        }
        None
    });
    let port = ng_common::serve(pool, (args.lat_min, args.lat_max), Some(args.dist.clone()), hook);

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("native-grid: WebKitGTK baseline");
    window.set_default_size(args.width, args.height);
    let view = webkit2gtk::WebView::new();
    let settings = WebViewExt::settings(&view).expect("settings");
    // As wry sets them; nothing else is touched.
    settings.set_enable_webgl(true);
    settings.set_enable_webaudio(true);
    settings.set_enable_page_cache(true);
    *host_env.lock().unwrap() = json!({
        "webkit": format!("{}.{}.{}", unsafe { webkit2gtk::ffi::webkit_get_major_version() }, unsafe { webkit2gtk::ffi::webkit_get_minor_version() }, unsafe { webkit2gtk::ffi::webkit_get_micro_version() }),
        "gtk": format!("{}.{}.{}", gtk::major_version(), gtk::minor_version(), gtk::micro_version()),
        "backend": gtk::gdk::Display::default().map(|d| d.type_().name().to_string()),
        "hardware_acceleration": format!("{:?}", settings.hardware_acceleration_policy()),
    });
    window.add(&view);
    window.connect_delete_event(|_, _| {
        gtk::main_quit();
        gtk::glib::Propagation::Proceed
    });
    window.show_all();
    view.load_uri(&format!("http://127.0.0.1:{port}/"));

    // Never hang the user's one command: give up well after the script should have ended.
    let limit = phases.iter().map(|p| p.ms).sum::<f64>() / 1000.0 + 90.0;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs_f64(limit));
        eprintln!("[webkit] the page did not report within {limit:.0} s; giving up");
        std::process::exit(3);
    });
    gtk::main();
}
