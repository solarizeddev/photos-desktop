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
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;
/** Where an unused element waits: off the list, and not painted. */
const PARKED = "translate(-10000px, 0)";

type Tile = { el: HTMLDivElement; img: HTMLImageElement; idx: number; url: string; y: number; waiting: boolean };
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
    const t: Tile = { el, img, idx: -1, url: "", y: 0, waiting: false };
    // Shown only when the picture that loaded is still the one this element is for.
    img.addEventListener("load", () => {
      if (img.src === t.url) img.setAttribute("data-ok", "");
    });
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

  /** Points a tile's picture at its thumbnail, unless it already shows it. */
  const show = (t: Tile) => {
    t.waiting = false;
    const url = thumbUrlFor(base, "u" + t.idx, px, 0);
    if (t.url !== url) {
      t.img.removeAttribute("data-ok");
      t.url = url;
      t.img.src = url;
    } else if (t.img.complete && t.img.naturalWidth > 0) {
      t.img.setAttribute("data-ok", "");
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
      t.idx = -1;
      free.push(t);
    }
    for (const p of placed) {
      let t = byIdx.get(p.idx);
      if (!t) {
        t = free.pop() ?? makeTile();
        t.idx = p.idx;
        byIdx.set(p.idx, t);
        t.y = p.y;
        t.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
        if (speed.isFast()) {
          // Moving too fast to be worth a picture: shown blank until the list slows.
          t.waiting = true;
          if (t.url) {
            t.img.removeAttribute("data-ok");
            t.img.removeAttribute("src");
            t.url = "";
          }
        } else {
          show(t);
        }
      } else if (t.waiting && !speed.isFast()) {
        show(t);
      }
    }
    // What is left over is parked, once: a parked one is not touched again. Its picture
    // goes, so the engine can drop a load still under way and the decoded image.
    for (const t of free) {
      if (t.el.style.transform === PARKED) continue;
      t.el.style.transform = PARKED;
      t.waiting = false;
      if (t.url) {
        t.img.removeAttribute("data-ok");
        t.img.removeAttribute("src");
        t.url = "";
      }
    }

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

  const speed = new Speed(scroller.clientHeight * FAST_SCREENS_S, () => update());
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
        if (!t.img.hasAttribute("data-ok")) blank++;
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

