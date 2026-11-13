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
    if a.len() < 2 {
        eprintln!("ng-compare native.json webkit.json [webkit-2.json ...]");
        std::process::exit(2);
    }
    let load = |p: &String| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}"))).expect("json") };
    let all: Vec<Value> = a.iter().map(load).collect();
    let n = &all[0];
    let webs = &all[1..];
    // A column per result: the native side, then each WebKit grid by name.
    let label = |v: &Value| -> String {
        if v["side"] == "native-gtk4" { "NATIVE GTK4".into() } else { format!("WEBKIT {}", v["env"]["grid"].as_str().unwrap_or("app")) }
    };
    let row = |name: &str, f: &dyn Fn(&Value) -> String| {
        let mut line = format!("  {name:<44}");
        for v in &all {
            line += &format!("{:>16}", f(v));
        }
        println!("{line}");
    };

    println!("Native GTK4 grid against WebKitGTK grids (app = the app's own components; pool = reused");
    println!("DOM tiles; canvas = one canvas, thumbnails decoded in a worker)");
    println!("=========================================================================================");
    let c = &n["config"];
    println!("{} tiles, tile {} px, window {}x{}, thumbnail wait {}-{} ms, {} fetches at once, script x{}",
        s(&c["n"]), s(&c["tile"]), s(&c["window"][0]), s(&c["window"][1]), s(&c["latency_ms"][0]), s(&c["latency_ms"][1]), s(&c["parallel_fetches"]), s(&c["script_scale"]));
    println!("pictures: {} different 512 px JPEGs{}; cut to tile size when a grid asks with ?w= (see the row below)",
        s(&c["unique_thumbnails"]), if c["photos"].is_null() { " (synthetic)".to_string() } else { format!(" from {}", s(&c["photos"])) });
    let m = &n["env"]["machine"];
    println!("machine: {} ({} threads), session {} / {}", s(&m["cpu"]), s(&m["cores"]), s(&m["session"]), s(&m["desktop"]));
    println!("native:  GTK {}, renderer {}, backend {}, scale {}, view {}x{}, {} columns, tile drawn {}x{}",
        s(&n["env"]["gtk"]), s(&n["env"]["renderer"]), s(&n["env"]["backend"]), s(&n["env"]["scale"]), s(&n["env"]["view"][0]), s(&n["env"]["view"][1]), s(&n["env"]["columns"]), s(&n["env"]["tile_drawn"][0]), s(&n["env"]["tile_drawn"][1]));
    for w in webs {
        let decode = if w["env"]["decode_in"].is_null() { String::new() } else { format!(", decoded in the {}", s(&w["env"]["decode_in"])) };
        println!("{}: WebKitGTK {} (webkit2gtk-4.1, GTK {}), compositing {}, scale {}, view {}x{}, {} columns, tile drawn {}x{}{decode}",
            label(w).to_lowercase(), s(&w["env"]["webkit"]), s(&w["env"]["gtk"]), s(&w["env"]["hardware_acceleration"]), s(&w["env"]["scale"]), s(&w["env"]["view"][0]), s(&w["env"]["view"][1]), s(&w["env"]["columns"]), s(&w["env"]["tile_drawn"][0]), s(&w["env"]["tile_drawn"][1]));
    }
    println!();
    row("ALL SCROLLING (down, up, both flings)", &|v| label(v));
    let t = |k: &'static str| move |v: &Value| s(&v["total"][k]);
    row("frames drawn", &t("frames"));
    row("frames per second", &t("fps"));
    row("frame time p50 (ms)", &t("p50"));
    row("frame time p95 (ms)", &t("p95"));
    row("frame time p99 (ms)", &t("p99"));
    row("frame time worst (ms)", &t("max"));
    row("frames over 33 ms", &t("over33"));
    row("frames over 50 ms", &t("over50"));
    row("main thread busy (% of one core)", &t("main_busy_pct"));
    row("seconds main thread >= 90% busy", &|v| format!("{} of {}", s(&v["total"]["seconds_main_pinned"]), s(&v["total"]["seconds_sampled"])));
    row("all threads, all processes (% of one core)", &t("cpu_all_pct"));
    row("visible tiles blank, average (%)", &t("blank_tile_pct"));
    row("checks (10/s) that saw a blank tile", &|v| format!("{} of {}", s(&v["total"]["probes_blank"]), s(&v["total"]["probes"])));
    row("tiles built, most at once", &|v| s(&v["env"]["cells_built_max"]));
    row("peak memory, all processes (MB)", &|v| s(&v["peak_rss_mb"]));
    row("peak threads, all processes", &|v| s(&v["peak_threads"]));
    row("thumbnails fetched / abandoned", &|v| format!("{} / {}", s(&v["thumbnails_served"]), s(&v["thumbnails_abandoned"])));
    row("of them cut to tile size (?w=)", &|v| if v["side"] == "native-gtk4" { "scaled itself".into() } else { s(&v["env"]["thumbs_sized"]) });
    println!();
    println!("  main thread = the one that runs the UI: the GTK main loop natively; in WebKit the web");
    println!("  process's main thread (JavaScript, style, layout), which is the one the app's profiles showed pinned.");
    println!("  pool and canvas ask for no thumbnail while the list moves faster than 4 screens a second");
    println!("  (as Google Photos' web grid and Glide during a fling do), so their flings show more blank tiles by design.");
    println!();
    println!("Per phase");
    println!("  {:<11}{:>14} {:>6} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>7} {:>7}", "phase", "side", "frames", "p50", "p95", "p99", ">33", ">50", "main%", "cpu%", "blank%");
    let empty = vec![];
    let phases: Vec<&Vec<Value>> = all.iter().map(|v| v["phases"].as_array().unwrap_or(&empty)).collect();
    let most = phases.iter().map(|p| p.len()).max().unwrap_or(0);
    for i in 0..most {
        for (v, ps) in all.iter().zip(&phases) {
            if let Some(p) = ps.get(i) {
                let side = if v["side"] == "native-gtk4" { "native".to_string() } else { v["env"]["grid"].as_str().unwrap_or("app").to_string() };
                println!("  {:<11}{:>14} {:>6} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>7} {:>7}", s(&p["name"]), side, s(&p["frames"]), s(&p["p50"]), s(&p["p95"]), s(&p["p99"]), s(&p["over33"]), s(&p["over50"]), s(&p["main_busy_pct"]), s(&p["cpu_all_pct"]), s(&p["blank_tile_pct"]));
            }
        }
    }
    println!();
    for v in &all {
        let procs: Vec<String> = v["processes"].as_array().unwrap_or(&empty).iter().map(|p| format!("{} peak {} MB, {} threads", s(&p["label"]), s(&p["rss_peak_mb"]), s(&p["threads"]))).collect();
        println!("{} processes: {}", label(v).to_lowercase(), procs.join("; "));
    }
    if all.iter().any(|v| v["env"]["hit_end"].as_bool() == Some(true)) {
        println!("NOTE: a side reached the end of the list during the script; use a larger --n.");
    }
    println!();
    println!("How to read it: frame times are the gaps between frames each toolkit was able to start");
    println!("(GTK frame clock ticks; requestAnimationFrame in the page). A frame over 33 ms is a visible");
    println!("stutter at 60 Hz. WebKit composites on another thread, so its requestAnimationFrame rate can");
    println!("stay high while the picture lags: read it together with the main thread and blank tile lines.");
}
