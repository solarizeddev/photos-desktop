//! ng-compare native.json webkit.json: the two results side by side.

use serde_json::Value;

fn s(v: &Value) -> String {
    match v {
        Value::Null => "-".into(),
        Value::String(x) => x.clone(),
        Value::Number(n) if n.is_f64() => format!("{:.1}", n.as_f64().unwrap()),
        other => other.to_string(),
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let load = |p: &String| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}"))).expect("json") };
    let (n, w) = (load(&a[0]), load(&a[1]));
    let row = |label: &str, x: String, y: String| println!("  {label:<44}{x:>16}{y:>18}");
    let both = |label: &str, f: &dyn Fn(&Value) -> String| row(label, f(&n), f(&w));

    println!("Native GTK4 grid against the app's grid in WebKitGTK");
    println!("====================================================");
    let c = &n["config"];
    println!("{} tiles, tile {} px, window {}x{}, thumbnail wait {}-{} ms, {} fetches at once, script x{}",
        s(&c["n"]), s(&c["tile"]), s(&c["window"][0]), s(&c["window"][1]), s(&c["latency_ms"][0]), s(&c["latency_ms"][1]), s(&c["parallel_fetches"]), s(&c["script_scale"]));
    println!("pictures: {} different 512 px JPEGs{}", s(&c["unique_thumbnails"]), if c["photos"].is_null() { " (synthetic)".to_string() } else { format!(" from {}", s(&c["photos"])) });
    let m = &n["env"]["machine"];
    println!("machine: {} ({} threads), session {} / {}", s(&m["cpu"]), s(&m["cores"]), s(&m["session"]), s(&m["desktop"]));
    println!("native:  GTK {}, renderer {}, backend {}, scale {}, view {}x{}, {} columns, tile drawn {}x{}",
        s(&n["env"]["gtk"]), s(&n["env"]["renderer"]), s(&n["env"]["backend"]), s(&n["env"]["scale"]), s(&n["env"]["view"][0]), s(&n["env"]["view"][1]), s(&n["env"]["columns"]), s(&n["env"]["tile_drawn"][0]), s(&n["env"]["tile_drawn"][1]));
    println!("webkit:  WebKitGTK {} (webkit2gtk-4.1, GTK {}), backend {}, compositing {}, scale {}, view {}x{}, {} columns, tile drawn {}x{}",
        s(&w["env"]["webkit"]), s(&w["env"]["gtk"]), s(&w["env"]["backend"]), s(&w["env"]["hardware_acceleration"]), s(&w["env"]["scale"]), s(&w["env"]["view"][0]), s(&w["env"]["view"][1]), s(&w["env"]["columns"]), s(&w["env"]["tile_drawn"][0]), s(&w["env"]["tile_drawn"][1]));
    println!();
    println!("  {:<44}{:>16}{:>18}", "ALL SCROLLING (down, up, both flings)", "NATIVE GTK4", "WEBKITGTK");
    let t = |k: &'static str| move |v: &Value| s(&v["total"][k]);
    both("frames drawn", &t("frames"));
    both("frames per second", &t("fps"));
    both("frame time p50 (ms)", &t("p50"));
    both("frame time p95 (ms)", &t("p95"));
    both("frame time p99 (ms)", &t("p99"));
    both("frame time worst (ms)", &t("max"));
    both("frames over 33 ms", &t("over33"));
    both("frames over 50 ms", &t("over50"));
    both("main thread busy (% of one core)", &t("main_busy_pct"));
    both("seconds main thread >= 90% busy", &|v| format!("{} of {}", s(&v["total"]["seconds_main_pinned"]), s(&v["total"]["seconds_sampled"])));
    both("all threads, all processes (% of one core)", &t("cpu_all_pct"));
    both("visible tiles blank, average (%)", &t("blank_tile_pct"));
    both("checks (10/s) that saw a blank tile", &|v| format!("{} of {}", s(&v["total"]["probes_blank"]), s(&v["total"]["probes"])));
    both("peak memory, all processes (MB)", &|v| s(&v["peak_rss_mb"]));
    both("peak threads, all processes", &|v| s(&v["peak_threads"]));
    both("thumbnails fetched / abandoned", &|v| format!("{} / {}", s(&v["thumbnails_served"]), s(&v["thumbnails_abandoned"])));
    println!();
    println!("  main thread = the one that runs the UI: the GTK main loop natively; in WebKit the web");
    println!("  process's main thread (JavaScript, style, layout), which is the one the app's profiles showed pinned.");
    println!();
    println!("Per phase (native | webkit)");
    println!("  {:<11}{:>7} {:>6} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>7} {:>7}", "phase", "side", "frames", "p50", "p95", "p99", ">33", ">50", "main%", "cpu%", "blank%");
    let empty = vec![];
    let (np, wp) = (n["phases"].as_array().unwrap_or(&empty), w["phases"].as_array().unwrap_or(&empty));
    for i in 0..np.len().max(wp.len()) {
        for (side, p) in [("native", np.get(i)), ("webkit", wp.get(i))] {
            if let Some(p) = p {
                println!("  {:<11}{:>7} {:>6} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>7} {:>7}", s(&p["name"]), side, s(&p["frames"]), s(&p["p50"]), s(&p["p95"]), s(&p["p99"]), s(&p["over33"]), s(&p["over50"]), s(&p["main_busy_pct"]), s(&p["cpu_all_pct"]), s(&p["blank_tile_pct"]));
            }
        }
    }
    println!();
    for (side, v) in [("native", &n), ("webkit", &w)] {
        let procs: Vec<String> = v["processes"].as_array().unwrap_or(&empty).iter().map(|p| format!("{} peak {} MB, {} threads", s(&p["label"]), s(&p["rss_peak_mb"]), s(&p["threads"]))).collect();
        println!("{side} processes: {}", procs.join("; "));
    }
    if let Some(x) = n["env"]["hit_end"].as_bool().filter(|x| *x).or(w["env"]["hit_end"].as_bool().filter(|x| *x)) {
        println!("NOTE: a side reached the end of the list during the script ({x}); use a larger --n.");
    }
    println!();
    println!("How to read it: frame times are the gaps between frames each toolkit was able to start");
    println!("(GTK frame clock ticks; requestAnimationFrame in the page). A frame over 33 ms is a visible");
    println!("stutter at 60 Hz. WebKit composites on another thread, so its requestAnimationFrame rate can");
    println!("stay high while the picture lags: read it together with the main thread and blank tile lines.");
}
