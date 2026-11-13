// The "canvas" grid: no element per tile. The tiles are drawn into one <canvas> taller than
// the view (a screen above it and a screen below), which the list scrolls like any content:
// a scroll step that stays inside what is drawn costs no drawing at all. When the view gets
// near the canvas's edge, the canvas is moved to centre on it again: what is already drawn
// is shifted by one copy and only the newly exposed strip is drawn. A thumbnail that arrives
// is drawn into its tile alone. (Map viewers and Google Photos' web tiles work this way.)
//
// Thumbnails are fetched and decoded in a worker, which also cuts each one to the tile's
// exact size in device pixels, so the page only copies it 1:1 and never decodes or scales.
// If the worker cannot decode, the page does it, and the result says so.
//
// Not drawn: rounded corners, hover, badges, fade-in. The app's grid has those; the tiles'
// pictures, places, sizes and month headers are the same.

import { GAP, Range, Speed, layout, sectionCounts, thumbPxFor, thumbUrlFor, type Layout, type MountedGrid } from "./layout";
import { measureHeader } from "./pool";

/** Screens ahead of the view whose thumbnails are asked for. */
const AHEAD = 1;
/** Screens either side beyond which a fetch still under way is called off. */
const KEEP = 2;
/** Fetches asked of the loader at once: the six the engine holds open per host, and two in line. */
const IN_FLIGHT = 8;
/** Decoded thumbnails kept: at 126x148 device px some 75 KB each, about 110 MB. */
const KEPT = 1500;
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;
/** The tallest canvas made, in device pixels: GPU textures stop at 8192 on many cards. */
const MAX_CANVAS = 8000;

/** What the page sends the worker, and what it answers. */
type ToWorker = { probe: string; w: number; h: number } | { idx: number; url: string; w: number; h: number } | { cancel: number };
type FromWorker = { ready: boolean; resize: boolean } | { idx: number; bitmap?: ImageBitmap; failed?: boolean };

/**
 * The worker: fetch, decode, cut to fill a w x h tile (centred, as object-fit: cover), and
 * hand the bitmap over. It says it is ready only after it has done one real thumbnail.
 */
const WORKER = `
const running = new Map();
let resize = true;
async function cut(blob, w, h) {
  const full = await createImageBitmap(blob);
  const k = Math.max(w / full.width, h / full.height);
  const sw = Math.min(full.width, w / k), sh = Math.min(full.height, h / k);
  const sx = (full.width - sw) / 2, sy = (full.height - sh) / 2;
  if (!resize) return full;
  try {
    const out = await createImageBitmap(full, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
    full.close();
    return out;
  } catch (e) {
    resize = false;
    return full;
  }
}
onmessage = async (e) => {
  const m = e.data;
  if (m.cancel !== undefined) { running.get(m.cancel)?.abort(); running.delete(m.cancel); return; }
  if (m.probe !== undefined) {
    try {
      const b = await cut(await (await fetch(m.probe)).blob(), m.w, m.h);
      b.close();
      postMessage({ ready: true, resize });
    } catch (err) {
      postMessage({ ready: false, resize: false });
    }
    return;
  }
  const stop = new AbortController();
  running.set(m.idx, stop);
  try {
    const blob = await (await fetch(m.url, { signal: stop.signal })).blob();
    if (stop.signal.aborted) return;
    const bitmap = await cut(blob, m.w, m.h);
    if (stop.signal.aborted) { bitmap.close(); return; }
    postMessage({ idx: m.idx, bitmap }, [bitmap]);
  } catch (err) {
    if (!stop.signal.aborted) postMessage({ idx: m.idx, failed: true });
  } finally {
    if (running.get(m.idx) === stop) running.delete(m.idx);
  }
};`;

export function mountCanvas(root: HTMLElement, cfg: { n: number; cell: number; sections: boolean }, base: string, onReady: (env: Record<string, unknown>) => void): MountedGrid {
  const scroller = document.createElement("div");
  scroller.className = "g-scroll";
  const list = document.createElement("div");
  list.style.cssText = "position: relative; width: 100%; contain: strict;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position: absolute; left: 0; top: 0; display: block;";
  list.appendChild(canvas);
  scroller.appendChild(list);
  root.appendChild(scroller);

  const header = cfg.sections ? measureHeader(list) : 0;
  const gridWidth = list.clientWidth;
  const viewH = scroller.clientHeight;
  const l: Layout = layout(sectionCounts(cfg.n, cfg.sections), gridWidth, cfg.cell, header);
  list.style.height = `${l.height}px`;
  const dpr = devicePixelRatio || 1;
  const px = thumbPxFor(l.tile, dpr);

  // Everything drawn is in device pixels, at whole-pixel places, so a bitmap cut to the
  // tile's size is copied 1:1 with no filtering.
  const D = (v: number) => Math.round(v * dpr);
  const tileW = D(l.tile);
  const tileH = D(l.rowH);
  // The canvas: the view and up to a screen either side, within what a GPU texture allows.
  const margin = Math.max(0, Math.min(viewH, Math.floor((MAX_CANVAS / dpr - viewH) / 2)));
  const bufH = viewH + 2 * margin;
  canvas.width = D(gridWidth);
  canvas.height = D(bufH);
  canvas.style.width = `${gridWidth}px`;
  canvas.style.height = `${bufH}px`;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingEnabled = false;
  /** Where the canvas's top is in the list, in CSS px (a whole number of device px). */
  let bufTop = 0;

  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = color("--bg", "#111");
  const bg2 = color("--bg2", "#1c1c1c");
  const fg = color("--fg-primary", "#eee");
  const mute = color("--fg-mute", "#888");
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const titleFont = `600 ${D(22)}px ${family}`;
  const countFont = `${D(12.5)}px ${family}`;

  // Decoded thumbnails, oldest first. A bitmap let go of is closed, so its memory goes now.
  const kept = new Map<number, ImageBitmap>();
  const asked = new Set<number>();
  const failed = new Set<number>();
  const view = new Range();
  const strip = new Range();
  const ahead = new Range();

  const keep = (idx: number, bitmap: ImageBitmap) => {
    kept.set(idx, bitmap);
    if (kept.size <= KEPT) return;
    // Oldest first, but never one drawn now: those are in the canvas's span.
    const lo = (bufTop - viewH) | 0;
    for (const [old, b] of kept) {
      if (kept.size <= KEPT) break;
      const y = yOf(l, old);
      if (y + l.rowH > lo && y < bufTop + bufH + viewH) continue;
      kept.delete(old);
      b.close();
    }
  };

  /** Draws one tile into the canvas, if it is in it. */
  const drawTile = (idx: number, x: number, y: number) => {
    const dy = D(y) - D(bufTop);
    if (dy + tileH <= 0 || dy >= canvas.height) return;
    const b = kept.get(idx);
    if (b && b.width === tileW && b.height === tileH) {
      ctx.drawImage(b, D(x), dy);
    } else if (b) {
      // The worker could not cut it to size: scaled here, centred and cut as cover.
      const k = Math.max(tileW / b.width, tileH / b.height);
      const sw = tileW / k;
      const sh = tileH / k;
      ctx.drawImage(b, (b.width - sw) / 2, (b.height - sh) / 2, sw, sh, D(x), dy, tileW, tileH);
    } else {
      ctx.fillStyle = bg2;
      ctx.fillRect(D(x), dy, tileW, tileH);
    }
  };

  /** Draws everything between `from` and `to` (list CSS px) into the canvas, clipped to it. */
  const drawSpan = (from: number, to: number) => {
    const y0 = D(from) - D(bufTop);
    const y1 = D(to) - D(bufTop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, canvas.width, y1 - y0);
    ctx.clip();
    ctx.fillStyle = bg;
    ctx.fillRect(0, y0, canvas.width, y1 - y0);
    strip.fill(l, from, to);
    for (let k = 0; k < strip.n; k++) {
      const p = strip.tiles[k];
      drawTile(p.idx, p.x, p.y);
    }
    if (strip.hn > 0) {
      ctx.textBaseline = "alphabetic";
      for (let k = 0; k < strip.hn; k++) {
        const h = strip.heads[k];
        const line = D(h.y + header - 10) - D(bufTop);
        ctx.fillStyle = fg;
        ctx.font = titleFont;
        ctx.textAlign = "left";
        ctx.fillText(h.key, 0, line);
        ctx.fillStyle = mute;
        ctx.font = countFont;
        ctx.textAlign = "right";
        ctx.fillText(`${h.count} photos`, canvas.width, line);
      }
    }
    ctx.restore();
  };

  /**
   * Keeps the view inside the canvas with room to spare. Moving the canvas shifts what is
   * drawn by one copy of itself and draws only the strip that was not there.
   */
  const follow = (force = false) => {
    const top = scroller.scrollTop;
    const lowest = Math.max(0, l.height - bufH);
    const want = Math.min(lowest, Math.max(0, Math.round((top - margin) * dpr) / dpr));
    const roomAbove = top - bufTop;
    const roomBelow = bufTop + bufH - (top + viewH);
    const nearEdge = (roomAbove < margin / 2 && bufTop > 0) || (roomBelow < margin / 2 && bufTop < lowest);
    if (!force && !nearEdge && roomAbove >= 0 && roomBelow >= 0) return;
    const shift = want - bufTop;
    if (force || Math.abs(shift) >= bufH) {
      bufTop = want;
      drawSpan(bufTop, bufTop + bufH);
    } else if (shift !== 0) {
      // A copy of the canvas onto itself, moved up (or down) by the shift.
      const s = D(want) - D(bufTop);
      ctx.drawImage(canvas, 0, -s);
      const was = bufTop;
      bufTop = want;
      if (shift > 0) drawSpan(was + bufH, bufTop + bufH);
      else drawSpan(bufTop, was);
    }
    canvas.style.transform = `translateY(${bufTop}px)`;
  };

  // Thumbnails that arrived since the last frame, drawn together in the next one.
  const arrivedNow: number[] = [];
  let frameAsked = false;
  const drawArrived = () => {
    frameAsked = false;
    for (const idx of arrivedNow) {
      const y = yOf(l, idx);
      const sec = sectionOf(l, idx);
      const col = (idx - sec.start) % l.columns;
      drawTile(idx, col * (l.tile + GAP), y);
    }
    arrivedNow.length = 0;
  };

  const arrived = (idx: number, bitmap: ImageBitmap | null) => {
    if (!asked.delete(idx)) {
      bitmap?.close();
      return;
    }
    if (bitmap) {
      keep(idx, bitmap);
      arrivedNow.push(idx);
      if (!frameAsked) {
        frameAsked = true;
        requestAnimationFrame(drawArrived);
      }
    } else failed.add(idx);
    pump();
  };

  const loader = makeLoader(arrived, thumbUrlFor(base, "u0", px, 0), tileW, tileH, onReady);
  let lastTop = 0;

  /** Asks for what is on screen first, from the edge the list is moving towards, then a screen ahead. */
  const pump = () => {
    if (speed.isFast() || asked.size >= IN_FLIGHT) return;
    const top = scroller.scrollTop;
    const down = top >= lastTop;
    view.fill(l, top, top + viewH);
    for (let k = 0; k < view.n && asked.size < IN_FLIGHT; k++) ask(view.tiles[down ? view.n - 1 - k : k].idx);
    if (down) ahead.fill(l, top + viewH, top + viewH * (1 + AHEAD));
    else ahead.fill(l, top - viewH * AHEAD, top);
    for (let k = 0; k < ahead.n && asked.size < IN_FLIGHT; k++) ask(ahead.tiles[down ? k : ahead.n - 1 - k].idx);
  };
  const ask = (idx: number) => {
    if (asked.has(idx) || failed.has(idx) || kept.has(idx)) return;
    asked.add(idx);
    loader.load(idx, thumbUrlFor(base, "u" + idx, px, 0));
  };
  /** Calls off fetches for tiles that have gone far from the view. */
  const prune = (top: number) => {
    const lo = top - viewH * KEEP;
    const hi = top + viewH * (1 + KEEP);
    for (const idx of asked) {
      const y = yOf(l, idx);
      if (y + l.rowH >= lo && y <= hi) continue;
      asked.delete(idx);
      loader.cancel(idx);
    }
  };

  const speed = new Speed(viewH * FAST_SCREENS_S, () => pump());
  scroller.addEventListener(
    "scroll",
    () => {
      const top = scroller.scrollTop;
      speed.step(top);
      follow();
      prune(top);
      pump();
      lastTop = top;
    },
    { passive: true },
  );
  follow(true);
  pump();

  const probeRange = new Range();
  return {
    scroller,
    gridWidth,
    probe() {
      const top = scroller.scrollTop;
      probeRange.fill(l, top, top + viewH);
      let blank = 0;
      for (let k = 0; k < probeRange.n; k++) if (!kept.has(probeRange.tiles[k].idx)) blank++;
      // A canvas has no tiles to build; what it holds instead is the decoded thumbnails.
      return { vis: probeRange.n, blank, columns: l.columns, tile: [Math.round(l.tile), Math.round(l.rowH)], built: probeRange.n };
    },
  };
}

function sectionOf(l: Layout, idx: number) {
  const s = l.sections;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].start <= idx) lo = mid;
    else hi = mid - 1;
  }
  return s[lo];
}

/** Where tile `idx` starts, in list coordinates. */
function yOf(l: Layout, idx: number): number {
  const sec = sectionOf(l, idx);
  return sec.top + l.header + Math.floor((idx - sec.start) / l.columns) * l.pitch;
}

type Loader = { load(idx: number, url: string): void; cancel(idx: number): void };

/** The worker, or the page itself when the worker cannot decode a thumbnail. */
function makeLoader(
  arrived: (idx: number, b: ImageBitmap | null) => void,
  probeUrl: string,
  w: number,
  h: number,
  onReady: (env: Record<string, unknown>) => void,
): Loader {
  const pending: { idx: number; url: string }[] = [];
  const page = new Map<number, AbortController>();
  let worker: Worker | null = null;
  let mode: "starting" | "worker" | "page" = "starting";
  const send = (m: ToWorker) => worker!.postMessage(m);

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

  const workerUrl = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
  const settle = (to: "worker" | "page", resize: boolean) => {
    if (mode !== "starting") return;
    mode = to;
    // The worker has its script by now; its address can go.
    URL.revokeObjectURL(workerUrl);
    if (to === "page") {
      worker?.terminate();
      worker = null;
    }
    onReady({ decode_in: to, decode_cut_in_worker: to === "worker" && resize });
    for (const p of pending.splice(0)) loader.load(p.idx, p.url);
  };
  try {
    worker = new Worker(workerUrl);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if ("ready" in m) return settle(m.ready ? "worker" : "page", m.resize);
      arrived(m.idx, m.bitmap ?? null);
    };
    worker.onerror = () => settle("page", false);
    send({ probe: probeUrl, w, h });
  } catch {
    settle("page", false);
  }

  const loader: Loader = {
    load(idx, url) {
      if (mode === "starting") pending.push({ idx, url });
      else if (mode === "worker") send({ idx, url, w, h });
      else onPage(idx, url);
    },
    cancel(idx) {
      if (mode === "starting") {
        const at = pending.findIndex((p) => p.idx === idx);
        if (at >= 0) pending.splice(at, 1);
      } else if (mode === "worker") send({ cancel: idx });
      else {
        page.get(idx)?.abort();
        page.delete(idx);
      }
    },
  };
  return loader;
}
