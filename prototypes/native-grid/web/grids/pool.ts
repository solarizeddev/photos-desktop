// The "pool" grid: the app's tiles as plain DOM, but built once and reused. A fixed set of
// tile elements, each absolutely placed by a transform, is handed from the tiles that
// scroll away to the tiles that scroll in: only a moved transform and a new `src` per tile,
// no element made or taken down, no React, nothing laid out again but the tiles that moved.
// One screen is kept built above and below the view (the app keeps two).
//
// What it asks of WebKit is what it asks of every page: fetch and decode the thumbnails,
// lay out and paint the tiles. If this is smooth at 3440x1386 where the app's grid is not,
// the cost is in how the app builds its grid, and that is what to change in the app.

import { HEADER_GUESS, Speed, inRange, layout, sectionCounts, thumbPxFor, thumbUrlFor, type Layout, type MountedGrid, type Placed, type PlacedHeader } from "./layout";

/** Screens kept built either side of the view. */
const OVERSCAN = 1;
/** Thumbnails fetched at once: the six connections the engine holds per host, and two in line. */
const IN_FLIGHT = 8;
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;
/** Where an unused element waits: off the list, and not painted. */
const PARKED = "translate(-10000px, 0)";

/**
 * A tile element and the picture it is loading or showing. Pictures are fetched here, not
 * by pointing the <img> at the server: WebKit never stops an image's download when its
 * `src` changes or the element goes (CachedImage keeps loading with no one to show it to),
 * so every tile that scrolled past held one of the six connections to the server until its
 * thumbnail arrived. A fetch is aborted the moment its tile is handed on. The picture is
 * decoded (`img.decode()`, off the main thread) before it is shown: WebKit otherwise
 * decodes a small on-screen image on the main thread while it paints.
 */
type Tile = {
  el: HTMLDivElement;
  img: HTMLImageElement;
  idx: number;
  y: number;
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
  const headers: Header[] = [];
  const freeHeaders: Header[] = [];
  const byKey = new Map<string, Header>();
  const placed: Placed[] = [];
  const placedHeaders: PlacedHeader[] = [];
  const wanted = new Set<number>();
  const wantedKeys = new Set<string>();

  const makeTile = (): Tile => {
    const el = document.createElement("div");
    el.className = "g-cell";
    // Size known up front, so nothing inside can make the list lay out again.
    el.style.cssText = `position: absolute; left: 0; top: 0; width: ${l.tile}px; height: ${l.rowH}px; contain: strict; transform: ${PARKED};`;
    const img = document.createElement("img");
    img.decoding = "async";
    img.alt = "";
    const t: Tile = { el, img, idx: -1, y: 0, state: "none", stop: null, blob: "" };
    el.appendChild(img);
    list.appendChild(el);
    tiles.push(t);
    return t;
  };

  const makeHeader = (): Header => {
    const el = document.createElement("div");
    el.className = "g-monthhdr";
    el.style.cssText = `position: absolute; left: 0; top: 0; width: ${gridWidth}px; box-sizing: border-box; height: ${header}px; contain: strict; transform: ${PARKED};`;
    const title = document.createElement("span");
    title.className = "g-monthtitle";
    const count = document.createElement("span");
    count.className = "g-monthcount";
    el.append(title, count);
    list.appendChild(el);
    const h: Header = { el, title, count, key: "" };
    headers.push(h);
    return h;
  };

  let inFlight = 0;
  let lastTop = 0;

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
    fetch(thumbUrlFor(base, "u" + t.idx, px, 0), { signal: stop.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(async (blob) => {
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
      .finally(() => {
        inFlight--;
        pump();
      });
  };

  /** Starts fetches: tiles on screen first, then those ahead in the way the list is going. */
  const pump = () => {
    if (speed.isFast() || inFlight >= IN_FLIGHT) return;
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    for (const p of placed) {
      if (p.y + l.rowH <= top || p.y >= bottom) continue;
      const t = byIdx.get(p.idx);
      if (t && t.state === "none") load(t);
      if (inFlight >= IN_FLIGHT) return;
    }
    const down = top >= lastTop;
    for (let i = 0; i < placed.length; i++) {
      const t = byIdx.get(placed[down ? i : placed.length - 1 - i].idx);
      if (t && t.state === "none") load(t);
      if (inFlight >= IN_FLIGHT) return;
    }
  };

  const update = () => {
    const top = scroller.scrollTop;
    const view = scroller.clientHeight;
    inRange(l, top - view * OVERSCAN, top + view * (1 + OVERSCAN), placed, placedHeaders);

    // Tiles: first let go of those no longer wanted, then hand them to the new ones.
    wanted.clear();
    for (const p of placed) wanted.add(p.idx);
    for (const [idx, t] of byIdx) {
      if (wanted.has(idx)) continue;
      byIdx.delete(idx);
      release(t);
      t.idx = -1;
      free.push(t);
    }
    for (const p of placed) {
      if (byIdx.has(p.idx)) continue;
      const t = free.pop() ?? makeTile();
      t.idx = p.idx;
      t.y = p.y;
      byIdx.set(p.idx, t);
      t.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    // What is left over is parked, once: a parked one is not touched again.
    for (const t of free) {
      if (t.el.style.transform !== PARKED) t.el.style.transform = PARKED;
    }
    pump();
    lastTop = top;

    wantedKeys.clear();
    for (const h of placedHeaders) wantedKeys.add(h.key);
    for (const [key, h] of byKey) {
      if (wantedKeys.has(key)) continue;
      byKey.delete(key);
      h.el.style.transform = PARKED;
      freeHeaders.push(h);
    }
    for (const p of placedHeaders) {
      if (byKey.has(p.key)) continue;
      const h = freeHeaders.pop() ?? makeHeader();
      h.key = p.key;
      h.title.textContent = p.key;
      h.count.textContent = `${p.count} photos`;
      h.el.style.transform = `translate(0px, ${p.y}px)`;
      byKey.set(p.key, h);
    }
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
        const y = t.y;
        if (y + l.rowH <= top || y >= bottom) continue;
        vis++;
        if (t.state !== "ok") blank++;
      }
      return { vis, blank, columns: l.columns, tile: [Math.round(l.tile), Math.round(l.rowH)], built: tiles.length };
    },
  };
}

/** A month header's height, as the app's stylesheet draws it. */
function measureHeader(list: HTMLElement): number {
  const el = document.createElement("div");
  el.className = "g-monthhdr";
  el.style.visibility = "hidden";
  el.innerHTML = '<span class="g-monthtitle">Month 0</span><span class="g-monthcount">1 photos</span>';
  list.appendChild(el);
  const h = el.getBoundingClientRect().height || HEADER_GUESS;
  el.remove();
  return h;
}

