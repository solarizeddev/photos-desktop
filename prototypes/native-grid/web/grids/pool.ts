// The "pool" grid: the app's tiles as plain DOM, but built once and reused. A fixed set of
// tile elements, each absolutely placed by a transform, is handed from the tiles that
// scroll away to the tiles that scroll in: only a moved transform and a new picture per
// tile, no element made or taken down, no React, nothing laid out again but the tiles that
// moved. One screen is kept built above and below the view (the app keeps two).
//
// Pictures are fetched here, not by pointing the <img> at the server. WebKit never stops an
// image's download when its `src` changes or the element goes (CachedImage keeps loading
// with no one to show it to), so every tile that scrolled past held one of the six
// connections to the server until its thumbnail arrived. Here a fetch is aborted the moment
// its tile is handed on, tiles on screen are fetched first, and a picture is shown only once
// `img.decode()` is done: WebKit otherwise decodes a small on-screen image on the main
// thread while it paints.
//
// If this is smooth at 3440x1386 where the app's grid is not, the cost is in how the app
// builds its grid, and that is what to change in the app.

import { HEADER_GUESS, Range, Speed, layout, sectionCounts, thumbPxFor, thumbUrlFor, type Layout, type MountedGrid } from "./layout";

/** Screens kept built either side of the view. */
const OVERSCAN = 1;
/** Fetches at once: the six connections the engine holds per host, and two in line. */
const IN_FLIGHT = 8;
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;
/** Where an unused element waits: off the list, and not painted. */
const PARKED = "translate(-10000px, 0)";
/**
 * The app's stylesheet animates `.g-cell` transforms and fades pictures in: a reused tile
 * would glide from where it was to where it goes, and every running animation is a layer.
 */
const PLACED_CSS = "position: absolute; left: 0; top: 0; contain: strict; transition: none;";

type Tile = {
  el: HTMLDivElement;
  img: HTMLImageElement;
  idx: number;
  y: number;
  parked: boolean;
  state: "none" | "loading" | "ok" | "failed";
  stop: AbortController | null;
  blob: string;
};
type Header = { el: HTMLDivElement; title: HTMLSpanElement; count: HTMLSpanElement; key: string };

export function mountPool(root: HTMLElement, cfg: { n: number; cell: number; sections: boolean }, base: string): MountedGrid {
  const scroller = document.createElement("div");
  scroller.className = "g-scroll";
  const list = document.createElement("div");
  // Its children are placed by hand: their layout cannot change the list's, nor the page's.
  list.style.cssText = "position: relative; contain: strict; width: 100%;";
  scroller.appendChild(list);
  root.appendChild(scroller);

  const header = cfg.sections ? measureHeader(list) : 0;
  const gridWidth = list.clientWidth;
  const l: Layout = layout(sectionCounts(cfg.n, cfg.sections), gridWidth, cfg.cell, header);
  list.style.height = `${l.height}px`;
  const px = thumbPxFor(l.tile, devicePixelRatio);

  const tiles: Tile[] = [];
  const free: Tile[] = [];
  const byIdx = new Map<number, Tile>();
  const freeHeaders: Header[] = [];
  const byKey = new Map<string, Header>();
  const range = new Range();
  /** The tiles built at the last update: `had0..had1`. */
  let had0 = 0;
  let had1 = -1;
  let inFlight = 0;
  let lastTop = 0;

  const makeTile = (): Tile => {
    const el = document.createElement("div");
    el.className = "g-cell";
    // Size known up front, so nothing inside can make the list lay out again.
    el.style.cssText = `${PLACED_CSS} width: ${l.tile}px; height: ${l.rowH}px; transform: ${PARKED};`;
    const img = document.createElement("img");
    img.decoding = "async";
    img.alt = "";
    img.style.transition = "none";
    el.appendChild(img);
    list.appendChild(el);
    const t: Tile = { el, img, idx: -1, y: 0, parked: true, state: "none", stop: null, blob: "" };
    tiles.push(t);
    return t;
  };

  const makeHeader = (): Header => {
    const el = document.createElement("div");
    el.className = "g-monthhdr";
    el.style.cssText = `${PLACED_CSS} width: ${gridWidth}px; box-sizing: border-box; height: ${header}px; transform: ${PARKED};`;
    const title = document.createElement("span");
    title.className = "g-monthtitle";
    const count = document.createElement("span");
    count.className = "g-monthcount";
    el.append(title, count);
    list.appendChild(el);
    return { el, title, count, key: "" };
  };

  /** Lets go of a tile's picture: its fetch stops, its blob goes, it shows nothing. */
  const release = (t: Tile) => {
    t.stop?.abort();
    t.stop = null;
    if (t.blob) {
      t.img.removeAttribute("data-ok");
      t.img.removeAttribute("src");
      URL.revokeObjectURL(t.blob);
      t.blob = "";
    }
    t.state = "none";
  };

  const load = (t: Tile) => {
    const stop = new AbortController();
    t.stop = stop;
    t.state = "loading";
    inFlight++;
    // The fetch slot is held until the bytes are here, not through the decode, which needs
    // no connection.
    let holding = true;
    const done = () => {
      if (!holding) return;
      holding = false;
      inFlight--;
      pump();
    };
    fetch(thumbUrlFor(base, "u" + t.idx, px, 0), { signal: stop.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(async (blob) => {
        done();
        if (t.stop !== stop) return;
        const url = URL.createObjectURL(blob);
        t.blob = url;
        t.img.src = url;
        await t.img.decode();
        if (t.stop !== stop) return;
        t.img.setAttribute("data-ok", "");
        t.state = "ok";
        t.stop = null;
      })
      .catch(() => {
        if (t.stop !== stop) return;
        t.state = "failed";
        t.stop = null;
      })
      .finally(done);
  };

  /**
   * Starts fetches: the tiles on screen first, from the edge the list is moving towards
   * (the rows coming in before the rows about to leave), then the screen ahead, nearest
   * first. Nothing behind the view is fetched.
   */
  const pump = () => {
    if (speed.isFast() || inFlight >= IN_FLIGHT) return;
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    const down = top >= lastTop;
    const { tiles: placed, n } = range;
    for (let k = 0; k < n; k++) {
      const p = placed[down ? n - 1 - k : k];
      if (p.y + l.rowH <= top || p.y >= bottom) continue;
      const t = byIdx.get(p.idx);
      if (t && t.state === "none") load(t);
      if (inFlight >= IN_FLIGHT) return;
    }
    for (let k = 0; k < n; k++) {
      const p = placed[down ? k : n - 1 - k];
      if (down ? p.y < bottom : p.y + l.rowH > top) continue;
      const t = byIdx.get(p.idx);
      if (t && t.state === "none") load(t);
      if (inFlight >= IN_FLIGHT) return;
    }
  };

  const update = () => {
    const top = scroller.scrollTop;
    const view = scroller.clientHeight;
    range.fill(l, top - view * OVERSCAN, top + view * (1 + OVERSCAN));
    const lo = range.first;
    const hi = range.last;

    // Tiles are indexed in list order, so what was built is `had0..had1` and what is wanted
    // is `lo..hi`: only the ends that moved are handed on, not every built tile looked at.
    const drop = (idx: number) => {
      const t = byIdx.get(idx);
      if (!t) return;
      byIdx.delete(idx);
      release(t);
      t.idx = -1;
      free.push(t);
    };
    for (let i = had0; i <= Math.min(had1, lo - 1); i++) drop(i);
    for (let i = Math.max(had0, hi + 1); i <= had1; i++) drop(i);

    for (let k = 0; k < range.n; k++) {
      const p = range.tiles[k];
      if (byIdx.has(p.idx)) continue;
      const t = free.pop() ?? makeTile();
      t.idx = p.idx;
      t.y = p.y;
      t.parked = false;
      byIdx.set(p.idx, t);
      t.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    had0 = lo;
    had1 = hi;
    // What is left over is parked, once.
    for (const t of free) {
      if (t.parked) continue;
      t.parked = true;
      t.el.style.transform = PARKED;
    }

    for (const [key, h] of byKey) {
      let still = false;
      for (let k = 0; k < range.hn && !still; k++) still = range.heads[k].key === key;
      if (still) continue;
      byKey.delete(key);
      h.el.style.transform = PARKED;
      freeHeaders.push(h);
    }
    for (let k = 0; k < range.hn; k++) {
      const p = range.heads[k];
      if (byKey.has(p.key)) continue;
      const h = freeHeaders.pop() ?? makeHeader();
      h.key = p.key;
      h.title.textContent = p.key;
      h.count.textContent = `${p.count} photos`;
      h.el.style.transform = `translate(0px, ${p.y}px)`;
      byKey.set(p.key, h);
    }

    pump();
    lastTop = top;
  };

  const speed = new Speed(scroller.clientHeight * FAST_SCREENS_S, () => pump());
  scroller.addEventListener(
    "scroll",
    () => {
      speed.step(scroller.scrollTop);
      update();
    },
    { passive: true },
  );
  update();

  return {
    scroller,
    gridWidth,
    probe() {
      const top = scroller.scrollTop;
      const bottom = top + scroller.clientHeight;
      let vis = 0;
      let blank = 0;
      for (const [, t] of byIdx) {
        if (t.y + l.rowH <= top || t.y >= bottom) continue;
        vis++;
        if (t.state !== "ok") blank++;
      }
      return { vis, blank, columns: l.columns, tile: [Math.round(l.tile), Math.round(l.rowH)], built: byIdx.size };
    },
  };
}

/** A month header's height, as the app measures it (offsetHeight, a whole number). */
export function measureHeader(list: HTMLElement): number {
  const el = document.createElement("div");
  el.className = "g-monthhdr";
  el.style.cssText = "visibility: hidden; position: absolute;";
  el.innerHTML = '<span class="g-monthtitle">Month 0</span><span class="g-monthcount">1 photos</span>';
  list.appendChild(el);
  const h = el.offsetHeight || HEADER_GUESS;
  el.remove();
  return h;
}
