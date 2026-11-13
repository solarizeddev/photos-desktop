//! What both sides of the comparison share, so that neither can differ from the other by
//! accident: the options, the scroll script, the thumbnails and the server that hands them
//! out, the /proc readings, and the arithmetic that turns frame times into a summary.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- options

#[derive(Clone, Debug)]
pub struct Args {
    pub n: usize,
    pub tile: u32,
    pub width: i32,
    pub height: i32,
    pub lat_min: u64,
    pub lat_max: u64,
    pub parallel: usize,
    pub unique: usize,
    pub cache_dir: PathBuf,
    pub photos: Option<PathBuf>,
    pub out: PathBuf,
    pub scale: f64,
    pub speed: f64,
    pub fling: f64,
    pub lru: usize,
    pub dist: PathBuf,
    pub sections: bool,
    pub gen_only: bool,
    /// What the web side measured, handed to the native side so both lay out the same:
    /// the width its tiles share, and its scroll area's size.
    pub grid_width: Option<i32>,
    pub view: (Option<i32>, Option<i32>),
    /// Which grid the WebKit side runs (see web/main.tsx): "app", "pool" or "canvas".
    /// The native side ignores it.
    pub web_grid: String,
}

impl Args {
    pub fn parse() -> Args {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let cache = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| format!("{home}/.cache"));
        let mut a = Args {
            n: 20000,
            tile: 150,
            width: 1600,
            height: 1000,
            lat_min: 5,
            lat_max: 40,
            parallel: 6,
            unique: 512,
            cache_dir: PathBuf::from(cache).join("pfp-native-grid"),
            photos: None,
            out: PathBuf::from("result.json"),
            scale: 1.0,
            speed: 1500.0,
            fling: 15000.0,
            lru: 2000,
            dist: PathBuf::from("web/dist"),
            sections: true,
            gen_only: false,
            grid_width: None,
            view: (None, None),
            web_grid: "app".into(),
        };
        let v: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < v.len() {
            let k = v[i].as_str();
            let mut val = || {
                i += 1;
                v.get(i).cloned().unwrap_or_else(|| {
                    eprintln!("{k} needs a value");
                    std::process::exit(2)
                })
            };
            fn num<T: std::str::FromStr>(s: String) -> T {
                s.parse().unwrap_or_else(|_| {
                    eprintln!("not a number: {s}");
                    std::process::exit(2)
                })
            }
            match k {
                "--n" => a.n = num(val()),
                "--tile" => a.tile = num(val()),
                "--width" => a.width = num(val()),
                "--height" => a.height = num(val()),
                "--lat-min" => a.lat_min = num(val()),
                "--lat-max" => a.lat_max = num(val()),
                "--parallel" => a.parallel = num(val()),
                "--unique" => a.unique = num(val()),
                "--cache-dir" => a.cache_dir = PathBuf::from(val()),
                "--photos" => a.photos = Some(PathBuf::from(val())),
                "--out" => a.out = PathBuf::from(val()),
                "--scale" => a.scale = num(val()),
                "--speed" => a.speed = num(val()),
                "--fling" => a.fling = num(val()),
                "--lru" => a.lru = num(val()),
                "--dist" => a.dist = PathBuf::from(val()),
                "--no-sections" => a.sections = false,
                "--gen-only" => a.gen_only = true,
                "--grid-width" => a.grid_width = Some(num(val())),
                "--view-width" => a.view.0 = Some(num(val())),
                "--view-height" => a.view.1 = Some(num(val())),
                "--web-grid" => a.web_grid = val(),
                _ => {
                    eprintln!("unknown option {k}");
                    std::process::exit(2)
                }
            }
            i += 1;
        }
        if a.lat_max < a.lat_min {
            a.lat_max = a.lat_min;
        }
        a.parallel = a.parallel.max(1);
        a
    }

    pub fn config_json(&self) -> Value {
        json!({ "n": self.n, "tile": self.tile, "window": [self.width, self.height],
            "latency_ms": [self.lat_min, self.lat_max], "parallel_fetches": self.parallel,
            "unique_thumbnails": self.unique, "photos": self.photos.as_ref().map(|p| p.display().to_string()),
            "script_scale": self.scale, "speed_px_s": self.speed, "fling_px_s": self.fling,
            "sections": self.sections })
    }
}

// ---------------------------------------------------------------- the scroll script

#[derive(Clone, Debug)]
pub enum Kind {
    Idle,
    /// Constant speed, px/s; negative is up.
    Linear(f64),
    /// A flick: starts at `v0` px/s and decays with time constant `tau` seconds.
    Fling(f64, f64),
}

#[derive(Clone, Debug)]
pub struct Phase {
    pub name: &'static str,
    pub kind: Kind,
    pub ms: f64,
}

impl Phase {
    /// How far the list has moved `t` ms into the phase. A function of time alone, so both
    /// sides are at the same place at the same moment whatever their frame rates.
    pub fn offset(&self, t: f64) -> f64 {
        let s = t.clamp(0.0, self.ms) / 1000.0;
        match self.kind {
            Kind::Idle => 0.0,
            Kind::Linear(v) => v * s,
            Kind::Fling(v0, tau) => v0 * tau * (1.0 - (-s / tau).exp()),
        }
    }
    pub fn is_scroll(&self) -> bool {
        !matches!(self.kind, Kind::Idle)
    }
    fn json(&self) -> Value {
        match self.kind {
            Kind::Idle => json!({"name": self.name, "kind": "idle", "ms": self.ms}),
            Kind::Linear(v) => json!({"name": self.name, "kind": "linear", "v": v, "ms": self.ms}),
            Kind::Fling(v0, tau) => json!({"name": self.name, "kind": "fling", "v": v0, "tau": tau, "ms": self.ms}),
        }
    }
}

pub fn script(a: &Args) -> Vec<Phase> {
    let k = a.scale;
    let p = |name, kind, ms: f64| Phase { name, kind, ms: ms * k };
    vec![
        p("warmup", Kind::Idle, 3000.0),
        // Steadily down through photos never seen, then a flick further into more of them.
        p("down", Kind::Linear(a.speed), 30000.0),
        p("fling-down", Kind::Fling(a.fling, 0.8), 4000.0),
        p("settle-1", Kind::Idle, 2000.0),
        // Back up over what was just shown, then a flick up over it.
        p("up", Kind::Linear(-a.speed), 15000.0),
        p("fling-up", Kind::Fling(-a.fling, 0.8), 4000.0),
        p("settle-2", Kind::Idle, 2000.0),
    ]
}

pub fn script_json(phases: &[Phase]) -> Value {
    Value::Array(phases.iter().map(|p| p.json()).collect())
}

/// Month-like sections of 150 to 849 photos, the same on both sides.
pub fn sections(n: usize) -> Vec<usize> {
    let mut out = vec![];
    let (mut i, mut m) = (0, 0);
    while i < n {
        let c = (n - i).min(150 + (m * 977) % 700);
        out.push(c);
        i += c;
        m += 1;
    }
    out
}

// ---------------------------------------------------------------- thumbnails

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    fn col(&mut self) -> [f32; 3] {
        [self.f() * 255.0, self.f() * 255.0, self.f() * 255.0]
    }
}

fn h2(x: i32, y: i32, s: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x9E3779B1) ^ (y as u32).wrapping_mul(0x85EBCA77) ^ s.wrapping_mul(0xC2B2AE3D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A2D39);
    h ^= h >> 15;
    (h & 0xFFFFFF) as f32 / 0xFFFFFF as f32
}

fn vnoise(x: f32, y: f32, s: u32) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (fx, fy) = (x - xi, y - yi);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (xi, yi) = (xi as i32, yi as i32);
    let a = h2(xi, yi, s);
    let b = h2(xi + 1, yi, s);
    let c = h2(xi, yi + 1, s);
    let d = h2(xi + 1, yi + 1, s);
    a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

fn fbm(x: f32, y: f32, s: u32, oct: u32) -> f32 {
    let (mut v, mut amp, mut f, mut tot) = (0.0, 0.5, 1.0, 0.0);
    for o in 0..oct {
        v += amp * vnoise(x * f, y * f, s.wrapping_add(o * 131));
        tot += amp;
        amp *= 0.5;
        f *= 2.03;
    }
    v / tot
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Not a photograph, but it costs a decoder what one costs: a sky with clouds over textured
/// ground, a few soft-edged objects, and sensor-like grain, at a thumbnail's 512 px.
fn synth(seed: u32) -> image::RgbImage {
    let (w, h) = [(512u32, 384u32), (384, 512), (512, 341), (512, 512)][(seed % 4) as usize];
    let mut r = Rng(0x9E3779B97F4A7C15 ^ ((seed as u64 + 1) * 0xD1B54A32D192ED03));
    for _ in 0..4 {
        r.f();
    }
    let (sky0, sky1) = (r.col(), mix(r.col(), [235.0, 235.0, 245.0], 0.5));
    let (g0, g1, g2) = (mix(r.col(), [40.0, 60.0, 30.0], 0.4), r.col(), mix(r.col(), [20.0, 20.0, 20.0], 0.5));
    let horizon = 0.25 + 0.5 * r.f();
    let detail = 0.35 + 0.65 * r.f();
    let grain = 5.0 + 9.0 * r.f();
    let blobs: Vec<([f32; 3], f32, f32, f32)> = (0..(2 + (r.f() * 5.0) as usize)).map(|_| (r.col(), r.f(), r.f(), 0.04 + 0.16 * r.f())).collect();
    let m = w.max(h) as f32;
    image::RgbImage::from_fn(w, h, |x, y| {
        let (u, v) = (x as f32 / m, y as f32 / m);
        let hz = horizon * (h as f32 / m) + 0.12 * (fbm(u * 3.0, 0.5, seed, 4) - 0.5);
        let mut c = if v < hz {
            let cl = fbm(u * 4.0, v * 9.0, seed + 7, 5);
            mix(mix(sky0, sky1, v / hz.max(0.01)), [250.0, 250.0, 250.0], ((cl - 0.5) * 3.0).max(0.0))
        } else {
            let a = fbm(u * 7.0, v * 7.0, seed + 11, 5);
            let b = fbm(u * 60.0, v * 60.0, seed + 13, 3);
            let base = mix(mix(g0, g1, a * 1.3 - 0.15), g2, (b - 0.5) * 2.0 * detail + 0.3 * (v - hz));
            let l = 0.75 + 0.5 * fbm(u * 150.0, v * 150.0, seed + 17, 2) * detail;
            [base[0] * l, base[1] * l, base[2] * l]
        };
        for (col, bx, by, rad) in &blobs {
            let d = ((u - bx).powi(2) + (v - by * (h as f32 / m)).powi(2)).sqrt();
            let e = rad * (0.85 + 0.3 * vnoise(u * 20.0, v * 20.0, seed + 23));
            c = mix(c, *col, (e - d) / 0.006);
        }
        let n = (h2(x as i32, y as i32, seed + 29) - 0.5) * 2.0 * grain;
        image::Rgb([(c[0] + n).clamp(0.0, 255.0) as u8, (c[1] + n).clamp(0.0, 255.0) as u8, (c[2] + n * 0.8).clamp(0.0, 255.0) as u8])
    })
}

fn encode(img: &image::RgbImage) -> Vec<u8> {
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80).encode_image(img).expect("jpeg encode");
    buf
}

fn find_jpegs(dir: &Path, out: &mut Vec<PathBuf>, cap: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= cap {
            return;
        }
        if p.is_dir() {
            find_jpegs(&p, out, cap);
        } else if matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("jpg" | "jpeg")) {
            out.push(p);
        }
    }
}

fn in_parallel(count: usize, job: impl Fn(usize) + Sync) {
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= count {
                    break;
                }
                job(i);
            });
        }
    });
}

/// The pool of 512 px JPEGs both sides are served from, made on the first run and kept.
/// Tile `i` shows picture `i % pool`, each under its own address, so nothing is shared
/// between tiles in either engine: every tile is fetched and decoded on its own.
pub fn ensure_thumbs(a: &Args) -> Arc<Vec<Vec<u8>>> {
    let dir = match &a.photos {
        Some(p) => {
            let mut h = 0u64;
            for b in p.display().to_string().bytes() {
                h = h.wrapping_mul(1099511628211) ^ b as u64;
            }
            a.cache_dir.join(format!("photos-{h:016x}-{}", a.unique))
        }
        None => a.cache_dir.join(format!("synth-v1-{}", a.unique)),
    };
    let done = dir.join("done");
    if !done.exists() {
        std::fs::create_dir_all(&dir).expect("create the thumbnail cache folder");
        let t = Instant::now();
        let mut made = 0;
        if let Some(p) = &a.photos {
            let mut files = vec![];
            find_jpegs(p, &mut files, a.unique);
            eprintln!("[thumbs] making 512 px thumbnails from {} JPEGs under {} ...", files.len(), p.display());
            let ok = AtomicUsize::new(0);
            in_parallel(files.len(), |i| {
                let Ok(bytes) = std::fs::read(&files[i]) else { return };
                let Ok(img) = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg) else { return };
                let k = ok.fetch_add(1, Ordering::Relaxed);
                std::fs::write(dir.join(format!("{k:05}.jpg")), encode(&img.thumbnail(512, 512).to_rgb8())).expect("write thumbnail");
            });
            made = ok.load(Ordering::Relaxed);
            if made == 0 {
                eprintln!("[thumbs] no readable JPEG there; using synthetic pictures instead");
            }
        }
        if made == 0 {
            eprintln!("[thumbs] generating {} synthetic 512 px thumbnails into {} ...", a.unique, dir.display());
            in_parallel(a.unique, |i| {
                std::fs::write(dir.join(format!("{i:05}.jpg")), encode(&synth(i as u32))).expect("write thumbnail");
            });
        }
        std::fs::write(&done, "ok").expect("write marker");
        eprintln!("[thumbs] done in {:.1} s", t.elapsed().as_secs_f64());
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).expect("read cache").flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jpg")).collect();
    files.sort();
    let pool: Vec<Vec<u8>> = files.iter().filter_map(|p| std::fs::read(p).ok()).collect();
    assert!(!pool.is_empty(), "no thumbnails in {}", dir.display());
    let total: usize = pool.iter().map(|b| b.len()).sum();
    let (mn, mx) = (pool.iter().map(|b| b.len()).min().unwrap(), pool.iter().map(|b| b.len()).max().unwrap());
    eprintln!("[thumbs] {} pictures, {} KB on average ({}-{} KB), from {}", pool.len(), total / pool.len() / 1024, mn / 1024, mx / 1024, dir.display());
    Arc::new(pool)
}

// ---------------------------------------------------------------- the server

/// Extra routes: (method, path with query, body) to (content type, body).
pub type Hook = Arc<dyn Fn(&str, &str, &[u8]) -> Option<(&'static str, Vec<u8>)> + Send + Sync>;

pub static THUMBS_SERVED: AtomicU64 = AtomicU64::new(0);
pub static THUMBS_ABANDONED: AtomicU64 = AtomicU64::new(0);
/// Thumbnails asked for cut to a tile's size (`?w=`), of those served.
pub static THUMBS_SIZED: AtomicU64 = AtomicU64::new(0);

/// The wait a thumbnail costs, the same for a given tile on both sides.
pub fn latency_ms(idx: usize, lat: (u64, u64)) -> u64 {
    lat.0 + (h2(idx as i32, 77, 5) * (lat.1 - lat.0 + 1) as f32) as u64 % (lat.1 - lat.0 + 1)
}

fn respond(s: &mut TcpStream, code: &str, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: keep-alive\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body);
    s.write_all(&out)
}

fn connection(mut s: TcpStream, pool: Arc<Vec<Vec<u8>>>, lat: (u64, u64), dist: Option<PathBuf>, hook: Hook) -> std::io::Result<()> {
    s.set_nodelay(true)?;
    let mut rd = BufReader::new(s.try_clone()?);
    loop {
        let mut line = String::new();
        if rd.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut it = line.split_whitespace();
        let (method, target) = (it.next().unwrap_or("").to_string(), it.next().unwrap_or("/").to_string());
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            if rd.read_line(&mut h)? == 0 {
                return Ok(());
            }
            let h = h.trim();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; len];
        rd.read_exact(&mut body)?;
        let path = target.split('?').next().unwrap_or("/");
        if let Some(uid) = path.strip_prefix("/t/tok/u") {
            let idx: usize = uid.parse().unwrap_or(0);
            std::thread::sleep(Duration::from_millis(latency_ms(idx, lat)));
            let sized = query_width(&target).map(|w| sized_pool(&pool, w));
            let from = sized.as_ref().unwrap_or(&pool);
            if respond(&mut s, "200 OK", "image/jpeg", &from[idx % from.len()]).is_err() {
                THUMBS_ABANDONED.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            THUMBS_SERVED.fetch_add(1, Ordering::Relaxed);
            if sized.is_some() {
                THUMBS_SIZED.fetch_add(1, Ordering::Relaxed);
            }
        } else if let Some((ctype, out)) = hook(&method, &target, &body) {
            respond(&mut s, "200 OK", ctype, &out)?;
        } else if let Some(dist) = &dist {
            let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
            let ctype = match rel.rsplit('.').next() {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("json") => "application/json",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };
            match (!rel.contains(".."), std::fs::read(dist.join(rel))) {
                (true, Ok(b)) => respond(&mut s, "200 OK", ctype, &b)?,
                _ => respond(&mut s, "404 Not Found", "text/plain", b"not found")?,
            }
        } else {
            respond(&mut s, "404 Not Found", "text/plain", b"not found")?;
        }
    }
}

/// `?w=N` on a thumbnail's address, as the app's grid asks for tile-sized thumbnails.
fn query_width(target: &str) -> Option<u32> {
    let q = target.split_once('?')?.1;
    let w: u32 = q.split('&').find_map(|kv| kv.strip_prefix("w="))?.parse().ok()?;
    (32..512).contains(&w).then_some(w)
}

/// The widths the app's sidecar cuts thumbnails to (sidecar/proton/thumbSizes.ts).
pub const THUMB_WIDTHS: [u32; 5] = [128, 192, 256, 320, 384];

type Sized = Arc<std::sync::OnceLock<Arc<Vec<Vec<u8>>>>>;

/// The pool shrunk so its shorter side is `w`, as the app's sidecar shrinks a thumbnail for
/// `?w=` (sharp, fit "outside", JPEG). Made once per width; the lock is held only to find
/// the width's slot, so asks for other widths, and for the full pool, never wait on a resize.
pub fn sized_pool(pool: &Arc<Vec<Vec<u8>>>, w: u32) -> Arc<Vec<Vec<u8>>> {
    static MADE: Mutex<Option<HashMap<u32, Sized>>> = Mutex::new(None);
    let slot: Sized = MADE.lock().unwrap().get_or_insert_with(HashMap::new).entry(w).or_default().clone();
    slot.get_or_init(|| {
        let t = Instant::now();
        let out: Vec<Mutex<Vec<u8>>> = (0..pool.len()).map(|_| Mutex::new(vec![])).collect();
        in_parallel(pool.len(), |i| {
            let img = image::load_from_memory_with_format(&pool[i], image::ImageFormat::Jpeg).expect("decode thumbnail");
            let (iw, ih) = (img.width() as f32, img.height() as f32);
            let k = (w as f32 / iw.min(ih)).min(1.0);
            let small = img.resize_exact(((iw * k).round() as u32).max(1), ((ih * k).round() as u32).max(1), image::imageops::FilterType::Triangle);
            *out[i].lock().unwrap() = encode(&small.to_rgb8());
        });
        let p: Vec<Vec<u8>> = out.into_iter().map(|m| m.into_inner().unwrap()).collect();
        let avg = p.iter().map(|b| b.len()).sum::<usize>() / p.len().max(1);
        eprintln!("[thumbs] made {} pictures at {w} px, {} KB on average, in {:.1} s", p.len(), avg / 1024, t.elapsed().as_secs_f64());
        Arc::new(p)
    })
    .clone()
}

/// Makes every width the app may ask for, before anything is measured, so no resize lands in
/// a measured phase or in one side's CPU count.
pub fn warm_sized(pool: &Arc<Vec<Vec<u8>>>) {
    for w in THUMB_WIDTHS {
        sized_pool(pool, w);
    }
}

/// Starts the server on a free local port and returns the port. One thread per connection,
/// and a thumbnail's wait is slept on that thread: a client gets as many thumbnails at once
/// as it holds connections, which is how the webview's six per host behave against the app's
/// own thumbnail server.
pub fn serve(pool: Arc<Vec<Vec<u8>>>, lat: (u64, u64), dist: Option<PathBuf>, hook: Hook) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let (pool, dist, hook) = (pool.clone(), dist.clone(), hook.clone());
            std::thread::spawn(move || {
                let _ = connection(s, pool, lat, dist, hook);
            });
        }
    });
    port
}

/// One GET on a kept-alive connection, for the native side's fetch workers.
pub fn http_get(s: &mut BufReader<TcpStream>, path: &str) -> std::io::Result<Vec<u8>> {
    s.get_mut().write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())?;
    let mut len = 0usize;
    let mut first = true;
    loop {
        let mut h = String::new();
        if s.read_line(&mut h)? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        let h = h.trim();
        if first {
            first = false;
            if !h.contains(" 200 ") {
                return Err(std::io::Error::other(h.to_string()));
            }
        }
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; len];
    s.read_exact(&mut body)?;
    Ok(body)
}

// ---------------------------------------------------------------- /proc

fn stat_fields(path: &str) -> Option<(String, Vec<u64>)> {
    let s = std::fs::read_to_string(path).ok()?;
    let (open, close) = (s.find('(')?, s.rfind(')')?);
    let comm = s[open + 1..close].to_string();
    // After the name: state, ppid, ... ; utime and stime are the 12th and 13th of these.
    let rest: Vec<u64> = s[close + 1..].split_whitespace().skip(1).map(|t| t.parse::<i64>().unwrap_or(0).max(0) as u64).collect();
    Some((comm, rest))
}

fn ticks(path: &str) -> u64 {
    stat_fields(path).map(|(_, f)| f.get(10).copied().unwrap_or(0) + f.get(11).copied().unwrap_or(0)).unwrap_or(0)
}

fn rss_kb(pid: i32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/statm")).ok().and_then(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok()).unwrap_or(0) * 4
}

fn hwm_kb(pid: i32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status")).ok().and_then(|s| s.lines().find(|l| l.starts_with("VmHWM"))?.split_whitespace().nth(1)?.parse().ok()).unwrap_or(0)
}

fn threads(pid: i32) -> usize {
    std::fs::read_dir(format!("/proc/{pid}/task")).map(|d| d.count()).unwrap_or(0)
}

/// The webview's own processes: everything named WebKit* that descends from this one.
fn webkit_children() -> Vec<(String, i32)> {
    let me = std::process::id() as i32;
    let mut procs: HashMap<i32, (String, i32)> = HashMap::new();
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        if let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) {
            if let Some((comm, f)) = stat_fields(&format!("/proc/{pid}/stat")) {
                procs.insert(pid, (comm, f.first().copied().unwrap_or(0) as i32));
            }
        }
    }
    let mut out = vec![];
    for (&pid, (comm, _)) in &procs {
        if !comm.starts_with("WebKit") {
            continue;
        }
        let (mut p, mut hops) = (pid, 0);
        while let Some((_, pp)) = procs.get(&p) {
            if *pp == me {
                let label = if comm.starts_with("WebKitWeb") { "web" } else if comm.starts_with("WebKitNet") { "network" } else { "webkit-other" };
                out.push((label.to_string(), pid));
                break;
            }
            p = *pp;
            hops += 1;
            if hops > 8 {
                break;
            }
        }
    }
    out.sort_by_key(|t| t.1);
    out
}

/// (main thread ticks, whole process ticks) by pid.
type Snap = HashMap<i32, (u64, u64)>;

struct Inner {
    targets: Vec<(String, i32)>,
    marks: Vec<(String, f64, Snap)>,
    secs: Vec<(f64, Snap)>,
    peak_rss_kb: u64,
    peak_threads: usize,
    stop: bool,
}

/// Reads this side's processes while it runs: CPU at every phase boundary, and once a second
/// for the "seconds the main thread was pinned" figure and the memory peak.
pub struct Recorder {
    t0: Instant,
    /// Which process's main thread is "the" main thread: `self` natively, `web` in the webview.
    main: &'static str,
    discover: bool,
    inner: Mutex<Inner>,
}

#[derive(Default, Clone, Debug)]
pub struct PhaseData {
    pub dts: Vec<f64>,
    pub probes: u64,
    pub probes_blank: u64,
    pub blank_sum: u64,
    pub vis_sum: u64,
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)]
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

impl Recorder {
    pub fn new(webview: bool) -> Arc<Recorder> {
        let r = Arc::new(Recorder {
            t0: Instant::now(),
            main: if webview { "web" } else { "self" },
            discover: webview,
            inner: Mutex::new(Inner { targets: vec![(if webview { "host".into() } else { "self".into() }, std::process::id() as i32)], marks: vec![], secs: vec![], peak_rss_kb: 0, peak_threads: 0, stop: false }),
        });
        let r2 = r.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1000));
            let mut g = r2.inner.lock().unwrap();
            if g.stop {
                break;
            }
            let snap = r2.snap(&mut g);
            let t = r2.t0.elapsed().as_secs_f64();
            g.secs.push((t, snap));
            let rss: u64 = g.targets.iter().map(|t| rss_kb(t.1)).sum();
            g.peak_rss_kb = g.peak_rss_kb.max(rss);
            let th: usize = g.targets.iter().map(|t| threads(t.1)).sum();
            g.peak_threads = g.peak_threads.max(th);
        });
        r
    }

    fn snap(&self, g: &mut Inner) -> Snap {
        if self.discover {
            for t in webkit_children() {
                if !g.targets.iter().any(|x| x.1 == t.1) {
                    g.targets.push(t);
                }
            }
        }
        g.targets.iter().map(|(_, pid)| (*pid, (ticks(&format!("/proc/{pid}/task/{pid}/stat")), ticks(&format!("/proc/{pid}/stat"))))).collect()
    }

    /// The start of a phase, or `end`.
    pub fn mark(&self, name: &str) {
        let mut g = self.inner.lock().unwrap();
        let snap = self.snap(&mut g);
        let t = self.t0.elapsed().as_secs_f64();
        g.marks.push((name.to_string(), t, snap));
    }

    pub fn finish(&self, side: &str, phases: &[Phase], data: &[PhaseData], env: Value, cfg: Value) -> Value {
        let mut g = self.inner.lock().unwrap();
        g.stop = true;
        let tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
        let main_pid = g.targets.iter().find(|t| t.0 == self.main).map(|t| t.1);
        let cpu = |a: &Snap, b: &Snap, wall: f64| -> (f64, f64) {
            let d = |pid: &i32, f: fn(&(u64, u64)) -> u64| b.get(pid).map(f).unwrap_or(0).saturating_sub(a.get(pid).map(f).unwrap_or(0)) as f64 / tck;
            let main = main_pid.map(|p| d(&p, |s| s.0)).unwrap_or(0.0);
            let all: f64 = b.keys().map(|p| d(p, |s| s.1)).sum();
            (100.0 * main / wall.max(1e-6), 100.0 * all / wall.max(1e-6))
        };
        let frames = |dts: &[f64], d: &PhaseData| -> Value {
            let mut s = dts.to_vec();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let total: f64 = s.iter().sum();
            json!({ "frames": s.len(), "fps": r1(s.len() as f64 / (total / 1000.0).max(1e-6)),
                "p50": r1(pct(&s, 0.50)), "p95": r1(pct(&s, 0.95)), "p99": r1(pct(&s, 0.99)), "max": r1(s.last().copied().unwrap_or(0.0)),
                "over33": s.iter().filter(|&&x| x > 33.4).count(), "over50": s.iter().filter(|&&x| x > 50.0).count(),
                "probes": d.probes, "probes_blank": d.probes_blank,
                "blank_tile_pct": r1(100.0 * d.blank_sum as f64 / d.vis_sum.max(1) as f64) })
        };
        let mut rows = vec![];
        let mut all = PhaseData::default();
        let (mut main_s, mut cpu_s, mut wall_s) = (0.0, 0.0, 0.0);
        let mut windows = vec![];
        for (i, p) in phases.iter().enumerate() {
            let Some(k) = g.marks.iter().position(|m| m.0 == p.name) else { continue };
            let Some(next) = g.marks.get(k + 1) else { continue };
            let wall = next.1 - g.marks[k].1;
            let (m, a) = cpu(&g.marks[k].2, &next.2, wall);
            let d = data.get(i).cloned().unwrap_or_default();
            let mut row = frames(&d.dts, &d);
            row["name"] = json!(p.name);
            row["wall_s"] = json!(r1(wall));
            row["main_busy_pct"] = json!(r1(m));
            row["cpu_all_pct"] = json!(r1(a));
            rows.push(row);
            if p.is_scroll() {
                all.dts.extend_from_slice(&d.dts);
                all.probes += d.probes;
                all.probes_blank += d.probes_blank;
                all.blank_sum += d.blank_sum;
                all.vis_sum += d.vis_sum;
                main_s += m * wall;
                cpu_s += a * wall;
                wall_s += wall;
                windows.push((g.marks[k].1, next.1));
            }
        }
        let mut total = frames(&all.dts, &all);
        total["name"] = json!("ALL SCROLLING");
        total["wall_s"] = json!(r1(wall_s));
        total["main_busy_pct"] = json!(r1(main_s / wall_s.max(1e-6)));
        total["cpu_all_pct"] = json!(r1(cpu_s / wall_s.max(1e-6)));
        // Whole seconds of scrolling in which the main thread had 90% or more of a core.
        let (mut secs, mut pinned) = (0, 0);
        for w in g.secs.windows(2) {
            let mid = (w[0].0 + w[1].0) / 2.0;
            if windows.iter().any(|(a, b)| mid >= *a && mid < *b) {
                secs += 1;
                if cpu(&w[0].1, &w[1].1, w[1].0 - w[0].0).0 >= 90.0 {
                    pinned += 1;
                }
            }
        }
        total["seconds_sampled"] = json!(secs);
        total["seconds_main_pinned"] = json!(pinned);
        let procs: Vec<Value> = g.targets.iter().map(|(l, pid)| json!({"label": l, "pid": pid, "rss_peak_mb": hwm_kb(*pid) / 1024, "threads": threads(*pid)})).collect();
        let hwm_sum: u64 = g.targets.iter().map(|t| hwm_kb(t.1)).sum();
        json!({ "side": side, "env": env, "config": cfg, "total": total, "phases": rows,
            "peak_rss_mb": g.peak_rss_kb / 1024, "peak_rss_sum_of_process_peaks_mb": hwm_sum / 1024, "peak_threads": g.peak_threads, "processes": procs,
            "main_thread_of": self.main,
            "thumbnails_served": THUMBS_SERVED.load(Ordering::Relaxed), "thumbnails_abandoned": THUMBS_ABANDONED.load(Ordering::Relaxed) })
    }
}

/// What the machine is, as far as it matters for reading the numbers.
pub fn machine_env() -> Value {
    let cpu = std::fs::read_to_string("/proc/cpuinfo").ok().and_then(|s| s.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())).unwrap_or_default();
    let var = |k: &str| std::env::var(k).ok();
    json!({ "cpu": cpu, "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "session": var("XDG_SESSION_TYPE"), "desktop": var("XDG_CURRENT_DESKTOP"), "wayland_display": var("WAYLAND_DISPLAY"), "display": var("DISPLAY"),
        "GDK_BACKEND": var("GDK_BACKEND"), "GSK_RENDERER": var("GSK_RENDERER"), "LIBGL_ALWAYS_SOFTWARE": var("LIBGL_ALWAYS_SOFTWARE"),
        "WEBKIT_DISABLE_DMABUF_RENDERER": var("WEBKIT_DISABLE_DMABUF_RENDERER"), "WEBKIT_DISABLE_COMPOSITING_MODE": var("WEBKIT_DISABLE_COMPOSITING_MODE") })
}
