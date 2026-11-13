// The "canvas" grid: the whole view is one <canvas>, drawn again on each scroll step, as a
// native grid draws its tiles. No element per tile, so nothing for WebKit to style, lay out
// or paint tile by tile; the page's only work per frame is a drawImage per tile on screen.
//
// Thumbnails are fetched and decoded in a worker (fetch, then createImageBitmap there) and
// handed over decoded, so the main thread never decodes a JPEG. If the worker cannot make
// ImageBitmaps, the page does it itself, and says so in the result.
//
// Not drawn: rounded corners, hover, badges, fade-in. The app's grid has those; the tiles'
// pictures, places, sizes and month headers are the same.

import { HEADER_GUESS, Speed, inRange, layout, sectionCounts, thumbPxFor, thumbUrlFor, type Layout, type MountedGrid, type Placed, type PlacedHeader } from "./layout";

/** Screens ahead of the view whose thumbnails are asked for, and kept asked for. */
const AHEAD = 1;
/** Screens either side beyond which a fetch still under way is called off. */
const KEEP = 2;
/** Fetches asked of the loader at once: the six the engine holds open per host, and a few in line. */
const IN_FLIGHT = 12;
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;
/** Decoded thumbnails kept: at 128x151 px some 77 KB each, about 120 MB. */
const KEPT = 1500;

type FromWorker = { idx: number; bitmap?: ImageBitmap; failed?: boolean } | { ready: boolean };

const WORKER = `
const running = new Map();
let can = typeof createImageBitmap === "function";
postMessage({ ready: can });
onmessage = async (e) => {
  const m = e.data;
  if (m.cancel !== undefined) { running.get(m.cancel)?.abort(); running.delete(m.cancel); return; }
  const stop = new AbortController();
  running.set(m.idx, stop);
  try {
    const blob = await (await fetch(m.url, { signal: stop.signal })).blob();
    if (stop.signal.aborted) return;
    const bitmap = await createImageBitmap(blob);
    if (stop.signal.aborted) { bitmap.close(); return; }
    postMessage({ idx: m.idx, bitmap }, [bitmap]);
  } catch (err) {
    if (!stop.signal.aborted) postMessage({ idx: m.idx, failed: true });
  } finally {
    if (running.get(m.idx) === stop) running.delete(m.idx);
  }
};`;

type Loader = { load(idx: number, url: string): void; cancel(idx: number): void; where: string };

export function mountCanvas(root: HTMLElement, cfg: { n: number; cell: number; sections: boolean }, base: string, onReady: (where: string) => void): MountedGrid {
  const scroller = document.createElement("div");
  scroller.className = "g-scroll";
  const list = document.createElement("div");
  list.style.cssText = "position: relative; width: 100%;";
  const canvas = document.createElement("canvas");
  // Stays at the top of the view while the list scrolls under it.
  canvas.style.cssText = "position: sticky; top: 0; display: block;";
  list.appendChild(canvas);
  scroller.appendChild(list);
  root.appendChild(scroller);

  const header = cfg.sections ? measureHeader(list) : 0;
  const gridWidth = list.clientWidth;
  const viewH = scroller.clientHeight;
  const l: Layout = layout(sectionCounts(cfg.n, cfg.sections), gridWidth, cfg.cell, header);
  list.style.height = `${Math.max(l.height, viewH)}px`;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(gridWidth * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = `${gridWidth}px`;
  canvas.style.height = `${viewH}px`;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const px = thumbPxFor(l.tile, dpr);

  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = color("--bg", "#111");
  const bg2 = color("--bg2", "#1c1c1c");
  const fg = color("--fg-primary", "#eee");
  const mute = color("--fg-mute", "#888");
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";

  // Decoded thumbnails, oldest first. A bitmap let go of is closed, so its memory goes now.
  const kept = new Map<number, ImageBitmap>();
  const asked = new Set<number>();
  const failed = new Set<number>();
  const keep = (idx: number, bitmap: ImageBitmap) => {
    kept.set(idx, bitmap);
    while (kept.size > KEPT) {
      const [oldest, b] = kept.entries().next().value!;
      kept.delete(oldest);
      b.close();
    }
  };

  let dirty = true;
  let frameAsked = false;
  const redrawSoon = () => {
    dirty = true;
    if (frameAsked) return;
    frameAsked = true;
    requestAnimationFrame(() => {
      frameAsked = false;
      if (dirty) draw();
    });
  };

  const arrived = (idx: number, bitmap: ImageBitmap | null) => {
    if (!asked.delete(idx)) {
      bitmap?.close();
      return;
    }
    if (bitmap) keep(idx, bitmap);
    else failed.add(idx);
    pump();
    redrawSoon();
  };

  const loader: Loader = makeLoader(arrived, onReady);

  const placed: Placed[] = [];
  const headers: PlacedHeader[] = [];
  const ahead: Placed[] = [];
  const unusedHeaders: PlacedHeader[] = [];
  let lastVis = 0;
  let lastBlank = 0;
  let lastTop = 0;

  /** Asks for what is on screen first, then a screen ahead in the way the list is going. */
  const pump = () => {
    if (speed.isFast()) return;
    const top = scroller.scrollTop;
    const going = top >= lastTop ? 1 : -1;
    for (const p of placed) {
      if (asked.size >= IN_FLIGHT) return;
      ask(p.idx);
    }
    const from = going > 0 ? top + viewH : top - viewH * AHEAD;
    inRange(l, from, from + viewH * AHEAD, ahead, unusedHeaders);
    if (going < 0) ahead.reverse();
    for (const p of ahead) {
      if (asked.size >= IN_FLIGHT) return;
      ask(p.idx);
    }
  };
  const ask = (idx: number) => {
    if (asked.has(idx) || failed.has(idx)) return;
    const b = kept.get(idx);
    if (b) {
      // Seen again: now the newest.
      kept.delete(idx);
      kept.set(idx, b);
      return;
    }
    asked.add(idx);
    loader.load(idx, thumbUrlFor(base, "u" + idx, px, 0));
  };
  /** Calls off fetches for tiles that have gone far from the view. */
  const prune = (top: number) => {
    const lo = top - viewH * KEEP;
    const hi = top + viewH * (1 + KEEP);
    for (const idx of [...asked]) {
      const y = yOf(l, idx);
      if (y + l.rowH >= lo && y <= hi) continue;
      asked.delete(idx);
      loader.cancel(idx);
    }
  };

  const draw = () => {
    dirty = false;
    // Near the end the canvas cannot stay stuck at the top: draw from where it really is.
    const top = Math.min(scroller.scrollTop, Math.max(0, list.offsetHeight - viewH));
    inRange(l, top, top + viewH, placed, headers);
    ctx.setTransform(dpr, 0, 0, dpr, 0, -top * dpr);
    ctx.fillStyle = bg;
    ctx.fillRect(0, top, gridWidth, viewH);
    let blank = 0;
    for (const p of placed) {
      const b = kept.get(p.idx);
      if (!b) {
        blank++;
        ctx.fillStyle = bg2;
        ctx.fillRect(p.x, p.y, l.tile, l.rowH);
        continue;
      }
      // Cut to fill the tile, centred, as `object-fit: cover` does.
      const k = Math.max(l.tile / b.width, l.rowH / b.height);
      const sw = l.tile / k;
      const sh = l.rowH / k;
      ctx.drawImage(b, (b.width - sw) / 2, (b.height - sh) / 2, sw, sh, p.x, p.y, l.tile, l.rowH);
    }
    for (const h of headers) {
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = fg;
      ctx.font = `600 22px ${family}`;
      const line = h.y + header - 10;
      ctx.fillText(h.key, 0, line);
      ctx.fillStyle = mute;
      ctx.font = `12.5px ${family}`;
      const label = `${h.count} photos`;
      ctx.fillText(label, gridWidth - ctx.measureText(label).width, line);
    }
    lastVis = placed.length;
    lastBlank = blank;
  };

  const speed = new Speed(viewH * FAST_SCREENS_S, () => pump());
  scroller.addEventListener(
    "scroll",
    () => {
      speed.step(scroller.scrollTop);
      draw();
      const top = scroller.scrollTop;
      prune(top);
      pump();
      lastTop = top;
    },
    { passive: true },
  );
  draw();
  pump();

  return {
    scroller,
    gridWidth,
    probe() {
      return { vis: lastVis, blank: lastBlank, columns: l.columns, tile: [Math.round(l.tile), Math.round(l.rowH)], built: kept.size };
    },
  };
}

/** Where tile `idx` starts, in list coordinates. */
function yOf(l: Layout, idx: number): number {
  const s = l.sections;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].start <= idx) lo = mid;
    else hi = mid - 1;
  }
  const sec = s[lo];
  return sec.top + l.header + Math.floor((idx - sec.start) / l.columns) * l.pitch;
}

/** The worker, or the page itself when the worker cannot make ImageBitmaps. */
function makeLoader(arrived: (idx: number, b: ImageBitmap | null) => void, onReady: (where: string) => void): Loader {
  const pending: { idx: number; url: string }[] = [];
  const page = new Map<number, AbortController>();
  let worker: Worker | null = null;
  let mode: "starting" | "worker" | "page" = "starting";

  const onPage = (idx: number, url: string) => {
    const stop = new AbortController();
    page.set(idx, stop);
    fetch(url, { signal: stop.signal })
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob))
      .then(
        (b) => {
          if (page.get(idx) !== stop) return b.close();
          page.delete(idx);
          arrived(idx, b);
        },
        () => {
          if (page.get(idx) !== stop) return;
          page.delete(idx);
          arrived(idx, null);
        },
      );
  };

  const settle = (to: "worker" | "page") => {
    mode = to;
    if (to === "page") {
      worker?.terminate();
      worker = null;
    }
    onReady(to);
    for (const p of pending.splice(0)) loader.load(p.idx, p.url);
  };

  const workerUrl = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
  try {
    worker = new Worker(workerUrl);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if ("ready" in m) return settle(m.ready ? "worker" : "page");
      arrived(m.idx, m.bitmap ?? null);
    };
    worker.onerror = () => {
      if (mode === "starting") settle("page");
    };
  } catch {
    settle("page");
  } finally {
    // The worker has its script once it is made; the address is not needed after.
    URL.revokeObjectURL(workerUrl);
  }

  const loader: Loader = {
    get where() {
      return mode;
    },
    load(idx, url) {
      if (mode === "starting") pending.push({ idx, url });
      else if (mode === "worker") worker!.postMessage({ idx, url });
      else onPage(idx, url);
    },
    cancel(idx) {
      if (mode === "starting") {
        const at = pending.findIndex((p) => p.idx === idx);
        if (at >= 0) pending.splice(at, 1);
      } else if (mode === "worker") worker!.postMessage({ cancel: idx });
      else {
        page.get(idx)?.abort();
        page.delete(idx);
      }
    },
  };
  return loader;
}

function measureHeader(list: HTMLElement): number {
  const el = document.createElement("div");
  el.className = "g-monthhdr";
  el.style.cssText = "visibility: hidden; position: absolute;";
  el.innerHTML = '<span class="g-monthtitle">Month 0</span><span class="g-monthcount">1 photos</span>';
  list.appendChild(el);
  const h = el.getBoundingClientRect().height || HEADER_GUESS;
  el.remove();
  return h;
}
