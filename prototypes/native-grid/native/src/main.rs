//! The native side: a GTK4 GridView of the same tiles, fed the same thumbnails from the same
//! server, driven through the same scroll script.
//!
//! Thumbnails are fetched and decoded on worker threads, scaled there to the size a tile is
//! drawn at, and handed to the main thread as finished textures; the main thread only ever
//! sets a picture. Textures are kept in a bounded LRU.

use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use ng_common::{Args, Phase, PhaseData, Recorder};
use serde_json::json;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::net::TcpStream;
use std::num::NonZeroUsize;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};

struct Item {
    idx: u32,
    month: u32,
}

#[derive(Default)]
struct Queue {
    /// Tiles GTK has built (the screen and some rows either side) that have no picture yet;
    /// the one nearest the middle of the screen is taken first.
    wanted: HashSet<u32>,
    center: u32,
    /// The look-ahead, nearest first; replaced whenever the view moves.
    ahead: Vec<u32>,
    inflight: HashSet<u32>,
}

struct Loader {
    q: Mutex<Queue>,
    cv: Condvar,
    /// The size a tile is drawn at, in device pixels.
    tile_px: (AtomicU32, AtomicU32),
}

impl Loader {
    fn request(&self, idx: u32) {
        let mut q = self.q.lock().unwrap();
        if q.wanted.insert(idx) {
            self.cv.notify_one();
        }
    }
    fn cancel(&self, idx: u32) {
        self.q.lock().unwrap().wanted.remove(&idx);
    }
    fn look_ahead(&self, center: u32, list: Vec<u32>) {
        let mut q = self.q.lock().unwrap();
        q.center = center;
        q.ahead = list;
        q.ahead.reverse();
        self.cv.notify_all();
    }
    fn next(&self) -> u32 {
        let mut q = self.q.lock().unwrap();
        loop {
            let c = q.center;
            while let Some(i) = q.wanted.iter().copied().min_by_key(|i| i.abs_diff(c)) {
                q.wanted.remove(&i);
                if q.inflight.insert(i) {
                    return i;
                }
            }
            while let Some(i) = q.ahead.pop() {
                if q.inflight.insert(i) {
                    return i;
                }
            }
            q = self.cv.wait(q).unwrap();
        }
    }
}

fn worker(loader: Arc<Loader>, port: u16, tx: mpsc::Sender<(u32, gdk::Texture)>) {
    let connect = || {
        let s = TcpStream::connect(("127.0.0.1", port)).expect("connect to the thumbnail server");
        s.set_nodelay(true).ok();
        BufReader::new(s)
    };
    let mut conn = connect();
    loop {
        let idx = loader.next();
        let bytes = match ng_common::http_get(&mut conn, &format!("/t/tok/u{idx}")) {
            Ok(b) => b,
            Err(_) => {
                conn = connect();
                loader.q.lock().unwrap().inflight.remove(&idx);
                continue;
            }
        };
        if let Ok(img) = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg) {
            let img = img.to_rgb8();
            let (tw, th) = (loader.tile_px.0.load(Ordering::Relaxed) as f32, loader.tile_px.1.load(Ordering::Relaxed) as f32);
            // Cover: the smaller of the two reductions, so the tile is filled and nothing is enlarged.
            let k = (tw / img.width() as f32).max(th / img.height() as f32).min(1.0);
            let (w, h) = (((img.width() as f32 * k).round() as u32).max(1), ((img.height() as f32 * k).round() as u32).max(1));
            let small = if k < 1.0 { image::imageops::thumbnail(&img, w, h) } else { img };
            let tex = gdk::MemoryTexture::new(w as i32, h as i32, gdk::MemoryFormat::R8g8b8, &glib::Bytes::from_owned(small.into_raw()), (w * 3) as usize);
            let _ = tx.send((idx, tex.upcast()));
        }
        loader.q.lock().unwrap().inflight.remove(&idx);
    }
}

struct State {
    args: Args,
    phases: Vec<Phase>,
    rec: Arc<Recorder>,
    loader: Arc<Loader>,
    rx: mpsc::Receiver<(u32, gdk::Texture)>,
    cache: lru::LruCache<u32, gdk::Texture>,
    bound: HashMap<u32, gtk::Picture>,
    data: Vec<PhaseData>,
    phase: usize,
    phase_start: i64,
    base: f64,
    last_tick: i64,
    last_probe: i64,
    started: bool,
    finished: bool,
    hit_end: bool,
    columns: usize,
    tile_drawn: (i32, i32),
    textures_made: u64,
}

const CSS: &str = "
window, scrolledwindow, gridview { background: #111111; }
gridview { padding: 0; }
gridview > child { padding: 3px; margin: 0; background: none; border-radius: 0; border: none; outline: none; min-height: 0; min-width: 0; }
gridview > child:hover, gridview > child:selected { background: none; }
.tile { background: #1f1f23; border-radius: 10px; }
";

fn main() {
    let args = Args::parse();
    let pool = ng_common::ensure_thumbs(&args);
    if args.gen_only {
        return;
    }
    let port = ng_common::serve(pool, (args.lat_min, args.lat_max), None, Arc::new(|_, _, _| None));
    let rec = Recorder::new(false);
    // Never hang the user's one command: a window that is covered or minimised gets no frames,
    // and the script is counted in frames' time.
    let limit = ng_common::script(&args).iter().map(|p| p.ms).sum::<f64>() / 1000.0 + 90.0;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs_f64(limit));
        eprintln!("[native] the script did not finish within {limit:.0} s (was the window hidden?); giving up");
        std::process::exit(3);
    });
    let app = gtk::Application::builder().application_id("eu.photosforproton.proto.NativeGrid").flags(gio::ApplicationFlags::NON_UNIQUE).build();
    app.connect_activate(move |app| build(app, args.clone(), port, rec.clone()));
    app.run_with_args::<&str>(&[]);
}

fn build(app: &gtk::Application, args: Args, port: u16, rec: Arc<Recorder>) {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(CSS);
    gtk::style_context_add_provider_for_display(&gdk::Display::default().expect("a display"), &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    if let Some(s) = gtk::Settings::default() {
        s.set_gtk_application_prefer_dark_theme(true);
    }

    let store = gio::ListStore::new::<glib::BoxedAnyObject>();
    let mut items = Vec::with_capacity(args.n);
    let mut idx = 0u32;
    for (m, c) in ng_common::sections(args.n).into_iter().enumerate() {
        for _ in 0..c {
            items.push(glib::BoxedAnyObject::new(Item { idx, month: m as u32 }));
            idx += 1;
        }
    }
    store.extend_from_slice(&items);
    let sorted = gtk::SortListModel::new(Some(store), None::<gtk::Sorter>);
    if args.sections {
        sorted.set_section_sorter(Some(&gtk::CustomSorter::new(|a, b| {
            let m = |o: &glib::Object| o.downcast_ref::<glib::BoxedAnyObject>().unwrap().borrow::<Item>().month;
            m(a).cmp(&m(b)).into()
        })));
    }

    let (tx, rx) = mpsc::channel();
    let (tw, th) = (args.tile, (args.tile as f32 / 0.85).round() as u32);
    let loader = Arc::new(Loader { q: Mutex::new(Queue::default()), cv: Condvar::new(), tile_px: (AtomicU32::new(tw), AtomicU32::new(th)) });
    for _ in 0..args.parallel {
        let (l, t) = (loader.clone(), tx.clone());
        std::thread::spawn(move || worker(l, port, t));
    }

    let phases = ng_common::script(&args);
    let state = Rc::new(RefCell::new(State {
        data: vec![PhaseData::default(); phases.len()],
        phases,
        rec,
        loader: loader.clone(),
        rx,
        cache: lru::LruCache::new(NonZeroUsize::new(args.lru.max(1)).unwrap()),
        bound: HashMap::new(),
        phase: 0,
        phase_start: 0,
        base: 0.0,
        last_tick: 0,
        last_probe: 0,
        started: false,
        finished: false,
        hit_end: false,
        columns: 0,
        tile_drawn: (0, 0),
        textures_made: 0,
        args: args.clone(),
    }));

    let boxes: Rc<RefCell<Vec<gtk::Box>>> = Rc::new(RefCell::new(vec![]));
    let height = Rc::new(std::cell::Cell::new(th as i32));
    let (boxes1, height1) = (boxes.clone(), height.clone());
    let factory = gtk::SignalListItemFactory::new();
    factory.connect_setup(move |_, obj| {
        let li = obj.downcast_ref::<gtk::ListItem>().unwrap();
        // The tile's size is the empty box's; the picture lies over it and cannot change it.
        let size = gtk::Box::new(gtk::Orientation::Vertical, 0);
        size.set_size_request(tw as i32, height1.get());
        boxes1.borrow_mut().push(size.clone());
        let pic = gtk::Picture::new();
        pic.set_content_fit(gtk::ContentFit::Cover);
        pic.set_can_shrink(true);
        let tile = gtk::Overlay::new();
        tile.set_child(Some(&size));
        tile.add_overlay(&pic);
        tile.add_css_class("tile");
        tile.set_overflow(gtk::Overflow::Hidden);
        li.set_child(Some(&tile));
        li.set_selectable(false);
        li.set_activatable(false);
    });
    let pic_of = |li: &gtk::ListItem| li.child().and_downcast::<gtk::Overlay>().unwrap().last_child().and_downcast::<gtk::Picture>().unwrap();
    let idx_of = |li: &gtk::ListItem| li.item().and_downcast::<glib::BoxedAnyObject>().unwrap().borrow::<Item>().idx;
    let st = state.clone();
    factory.connect_bind(move |_, obj| {
        let li = obj.downcast_ref::<gtk::ListItem>().unwrap();
        let (pic, idx) = (pic_of(li), idx_of(li));
        let mut s = st.borrow_mut();
        match s.cache.get(&idx) {
            Some(tex) => pic.set_paintable(Some(tex)),
            None => s.loader.request(idx),
        }
        s.bound.insert(idx, pic);
    });
    let st = state.clone();
    factory.connect_unbind(move |_, obj| {
        let li = obj.downcast_ref::<gtk::ListItem>().unwrap();
        let (pic, idx) = (pic_of(li), idx_of(li));
        pic.set_paintable(gdk::Paintable::NONE);
        let mut s = st.borrow_mut();
        s.bound.remove(&idx);
        s.loader.cancel(idx);
    });

    let grid = gtk::GridView::new(Some(gtk::NoSelection::new(Some(sorted))), Some(factory));
    // GridView keeps built a number of tiles that grows with max-columns (hundreds of rows'
    // worth if it is left high), so the column count is worked out here, as the app's grid
    // works its own out, and pinned: as many whole tiles as fit, the remainder shared out.
    let (boxes2, height2, loader2) = (boxes.clone(), height.clone(), loader.clone());
    let grid_width = args.grid_width;
    let fit = move |g: &gtk::GridView| {
        // The same width for the tiles to share as the app's grid has: what the web side
        // measured when it ran first, else the app's 20 px either side. The app's tiles are
        // 6 px apart; here each tile carries 3 px of that on every side, hence the 6.
        if let Some(sw) = g.parent().map(|p| p.width()).filter(|w| *w > 0) {
            let spare = (sw - (grid_width.unwrap_or(sw - 40) + 6)).max(0);
            if g.margin_start() != spare / 2 {
                g.set_margin_start(spare / 2);
                g.set_margin_end(spare - spare / 2);
            }
        }
        let cols = ((g.width() / (tw as i32 + 6)).max(1)) as u32;
        // A tile is 0.85 as wide as tall, as in the app, at the width it ends up with.
        let w = g.width() as f64 / cols as f64 - 6.0;
        let h = (w / 0.85).round() as i32;
        if g.width() > 0 && h != height2.get() {
            height2.set(h);
            for b in boxes2.borrow().iter() {
                b.set_size_request(tw as i32, h);
            }
            let scale = g.native().and_then(|n| n.surface()).map(|x| x.scale()).unwrap_or(1.0);
            loader2.tile_px.0.store((w * scale).ceil() as u32, Ordering::Relaxed);
            loader2.tile_px.1.store((h as f64 * scale).ceil() as u32, Ordering::Relaxed);
        }
        if g.width() > 0 && g.max_columns() != cols {
            if cols > g.max_columns() {
                g.set_max_columns(cols);
                g.set_min_columns(cols);
            } else {
                g.set_min_columns(cols);
                g.set_max_columns(cols);
            }
        }
    };
    grid.set_min_columns(1);
    grid.set_max_columns(((args.grid_width.unwrap_or(args.width - 40) + 6) / (tw as i32 + 6)).max(1) as u32);
    grid.set_min_columns(grid.max_columns());
    // GTK's GridView starts each section on a new row but, unlike ListView, has no section
    // headers (GTK 4.14, which this was written against), so the months here have a break
    // and no title line.

    let scrolled = gtk::ScrolledWindow::new();
    scrolled.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scrolled.set_child(Some(&grid));
    if let (Some(w), Some(h)) = args.view {
        scrolled.set_size_request(w, h);
    }
    let window = gtk::ApplicationWindow::builder().application(app).title("native-grid: GTK4").default_width(args.width).default_height(args.height).child(&scrolled).build();

    let st = state.clone();
    let (sc, win, app2) = (scrolled.clone(), window.clone(), app.clone());
    grid.add_tick_callback(move |g, _| {
        fit(g);
        tick(&st, &sc, &win, &app2);
        glib::ControlFlow::Continue
    });
    window.present();
}

fn tick(st: &Rc<RefCell<State>>, sc: &gtk::ScrolledWindow, win: &gtk::ApplicationWindow, app: &gtk::Application) {
    let now = glib::monotonic_time();
    let mut guard = st.borrow_mut();
    let s = &mut *guard;
    if s.finished {
        return;
    }
    // Finished textures from the workers: keep them, and show those whose tile is waiting.
    while let Ok((idx, tex)) = s.rx.try_recv() {
        s.textures_made += 1;
        if let Some(pic) = s.bound.get(&idx) {
            pic.set_paintable(Some(&tex));
        }
        s.cache.put(idx, tex);
    }
    if !s.started {
        if sc.height() < 50 {
            return;
        }
        s.started = true;
        s.phase_start = now;
        s.last_tick = now;
        s.rec.mark(s.phases[0].name);
        return;
    }
    let p = s.phase;
    s.data[p].dts.push((now - s.last_tick) as f64 / 1000.0);
    s.last_tick = now;

    let mut t = (now - s.phase_start) as f64 / 1000.0;
    if t >= s.phases[p].ms {
        s.base += s.phases[p].offset(s.phases[p].ms);
        s.phase += 1;
        s.phase_start = now;
        t = 0.0;
        if s.phase == s.phases.len() {
            s.finished = true;
            s.rec.mark("end");
            drop(guard);
            finish(st, sc, win);
            app.quit();
            return;
        }
        s.rec.mark(s.phases[s.phase].name);
    }
    let p = s.phase;
    // Ten times a second: which tiles are on screen, and which of them have no picture yet.
    if now - s.last_probe >= 100_000 {
        s.last_probe = now;
        let (vw, vh) = (sc.width() as f32, sc.height() as f32);
        let (mut vis, mut blank, mut first, mut last) = (0u64, 0u64, u32::MAX, 0u32);
        let mut xs = HashSet::new();
        for (idx, pic) in &s.bound {
            // A tile GTK has scrolled out keeps its last place but is no longer mapped.
            if !pic.is_mapped() {
                continue;
            }
            let Some(b) = pic.compute_bounds(sc) else { continue };
            if b.width() <= 0.0 || b.y() + b.height() <= 0.0 || b.y() >= vh || b.x() + b.width() <= 0.0 || b.x() >= vw {
                continue;
            }
            vis += 1;
            xs.insert(b.x() as i32);
            s.tile_drawn = (b.width().round() as i32, b.height().round() as i32);
            first = first.min(*idx);
            last = last.max(*idx);
            if pic.paintable().is_none() {
                blank += 1;
            }
        }
        s.columns = s.columns.max(xs.len());
        if std::env::var_os("NG_DEBUG").is_some() {
            let q = s.loader.q.lock().unwrap();
            eprintln!("probe phase={} bound={} vis={} blank={} first={} last={} wanted={} ahead={} inflight={} made={}", s.phases[p].name, s.bound.len(), vis, blank, first, last, q.wanted.len(), q.ahead.len(), q.inflight.len(), s.textures_made);
        }
        let d = &mut s.data[p];
        d.probes += 1;
        d.vis_sum += vis;
        d.blank_sum += blank;
        if blank > 0 {
            d.probes_blank += 1;
        }
        // The look-ahead the app's grid has: it builds, and so fetches, a screen and a half
        // either side of what is showing. Here the far side is what the LRU already holds.
        if vis > 0 {
            let reach = (vis as f64 * 1.5) as u32;
            let n = s.args.n as u32;
            let down: Vec<u32> = (last + 1..(last + 1 + reach).min(n)).collect();
            let up: Vec<u32> = (first.saturating_sub(reach)..first).rev().collect();
            let dir = match s.phases[p].kind {
                ng_common::Kind::Linear(v) | ng_common::Kind::Fling(v, _) => v,
                ng_common::Kind::Idle => 1.0,
            };
            let (a, b) = if dir >= 0.0 { (down, up) } else { (up, down) };
            let list: Vec<u32> = a.into_iter().chain(b).filter(|i| !s.cache.contains(i) && !s.bound.contains_key(i)).collect();
            s.loader.look_ahead((first + last) / 2, list);
        }
    }

    // Last, so the check above saw the frame that was on screen. Moving the list binds and
    // unbinds tiles there and then, and those reach for the state, so it is let go of first.
    let adj = sc.vadjustment();
    let want = s.base + s.phases[p].offset(t);
    let max = (adj.upper() - adj.page_size()).max(0.0);
    if s.phases[p].is_scroll() {
        if want < -1.0 || want > max + 1.0 {
            s.hit_end = true;
        }
        drop(guard);
        adj.set_value(want.clamp(0.0, max));
    }

}

fn finish(st: &Rc<RefCell<State>>, sc: &gtk::ScrolledWindow, win: &gtk::ApplicationWindow) {
    let s = st.borrow();
    let display = gtk::prelude::WidgetExt::display(win);
    let surface = win.surface();
    let env = json!({
        "machine": ng_common::machine_env(),
        "gtk": format!("{}.{}.{}", gtk::major_version(), gtk::minor_version(), gtk::micro_version()),
        "renderer": win.renderer().map(|r| r.type_().name().to_string()),
        "backend": display.type_().name(),
        "scale": surface.as_ref().map(|x| x.scale()),
        "refresh_hz": surface.as_ref().and_then(|x| display.monitor_at_surface(x)).map(|m| m.refresh_rate() as f64 / 1000.0),
        "view": [sc.width(), sc.height()],
        "grid_width": sc.child().map(|c| c.width()),
        "columns": s.columns,
        "tile_drawn": [s.tile_drawn.0, s.tile_drawn.1],
        "list_height": sc.vadjustment().upper(),
        "hit_end": s.hit_end,
        "textures_made": s.textures_made,
        "textures_kept": s.cache.len(),
        "lru_limit": s.args.lru,
        "frame_time_source": "gaps between GdkFrameClock ticks (g_get_monotonic_time in a tick callback)",
    });
    let out = s.rec.finish("native-gtk4", &s.phases, &s.data, env, s.args.config_json());
    std::fs::write(&s.args.out, serde_json::to_string_pretty(&out).unwrap()).expect("write the result");
    eprintln!("[native] wrote {}", s.args.out.display());
}
