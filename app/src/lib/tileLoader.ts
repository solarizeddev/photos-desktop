/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { bench, benchCount } from "./benchProbe";

/**
 * The canvas grid's thumbnails, decoded and ready to draw, by photo.
 *
 * Fetched and decoded in a worker (see tileWorker), cut to the tile's size in device pixels
 * with its corners rounded, so drawing one is a plain copy. A few at a time: the grid asks
 * for the tiles it wants most first and calls off the ones that scrolled far away, which
 * aborts their fetch. Kept up to a memory budget, oldest first out, and every bitmap let go
 * of is closed so its memory goes at once, not at the next collection.
 *
 * If the worker cannot do it (no module workers, or the thumbnail server refuses it), the
 * page does: an <img> decoded off the main thread with `decode()` and cut the same way.
 */

/** Fetches at once: the six connections the engine holds per host, and two in line. */
export const IN_FLIGHT = 8;

/** Decoded thumbnails kept, in bytes: some 1,600 tiles of 126 x 148 device pixels. */
const BUDGET = 120 * 1024 * 1024;

/** A thumbnail that would not load is asked again this many times, a little later each time. */
const RETRIES = 3;
const RETRY_MS = 1500;

export type Cut = { w: number; h: number; r: number };

type Entry = { bitmap: ImageBitmap; w: number; h: number; bytes: number };

export class TileLoader {
  private kept = new Map<string, Entry>();
  private bytes = 0;
  private asked = new Set<string>();
  private failed = new Map<string, { tries: number; until: number }>();
  private size: Cut = { w: 1, h: 1, r: 0 };
  private worker: Worker | null = null;
  private mode: "starting" | "worker" | "page" = "starting";
  private waiting: { key: string; url: string }[] = [];
  private page = new Map<string, HTMLImageElement>();
  private closed = false;
  /** How the thumbnails are made, once it is known: for the log and the measurement. */
  where = "starting";
  /** Whether the thumbnails come with their corners rounded; if not, the grid clips them. */
  rounded = false;

  constructor(
    /** A thumbnail is ready to draw (or will not come: then `bitmap` returns nothing). */
    private onArrive: (key: string) => void,
    /** A thumbnail address to try the worker on before trusting it. */
    probeUrl: string,
    size: Cut,
  ) {
    this.size = size;
    try {
      this.worker = new Worker(new URL("./tileWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e) => this.fromWorker(e.data);
      this.worker.onerror = () => this.settle("page");
      this.worker.postMessage({ kind: "probe", url: probeUrl, ...size });
    } catch {
      this.settle("page");
    }
  }

  /** The tile size in device pixels: thumbnails cut to another size are asked for again. */
  setSize(size: Cut): void {
    this.size = size;
  }

  /** A thumbnail to draw for `key`, of any size (one of another size is drawn scaled until its replacement comes). */
  bitmap(key: string): ImageBitmap | undefined {
    return this.kept.get(key)?.bitmap;
  }

  /** Whether `key` has nothing to draw, or only a picture cut for another size. */
  needs(key: string): boolean {
    const e = this.kept.get(key);
    return !e || e.w !== this.size.w || e.h !== this.size.h;
  }

  /** How many more fetches may start now. */
  room(): number {
    return Math.max(0, IN_FLIGHT - this.asked.size);
  }

  /** The keys being fetched: the grid calls off those that scrolled far away. */
  inFlight(): Iterable<string> {
    return this.asked;
  }

  /** Asks for `key` from `url` if it is needed and not already coming. False if not asked. */
  want(key: string, url: string): boolean {
    if (this.closed || this.asked.has(key) || !this.needs(key)) return false;
    const f = this.failed.get(key);
    if (f && (f.tries >= RETRIES || performance.now() < f.until)) return false;
    this.asked.add(key);
    if (bench.on) benchCount("fresh");
    if (this.mode === "starting") this.waiting.push({ key, url });
    else if (this.mode === "worker") this.worker!.postMessage({ kind: "load", key, url, ...this.size });
    else this.onPage(key, url);
    return true;
  }

  /** Calls off a fetch under way. */
  cancel(key: string): void {
    if (!this.asked.delete(key)) return;
    if (this.mode === "starting") {
      const at = this.waiting.findIndex((w) => w.key === key);
      if (at >= 0) this.waiting.splice(at, 1);
    } else if (this.mode === "worker") this.worker!.postMessage({ kind: "cancel", key });
    else {
      const img = this.page.get(key);
      this.page.delete(key);
      img?.removeAttribute("src");
    }
  }

  /**
   * Keeps the budget by letting go of the oldest thumbnails, but none `keep` says is still
   * near the screen.
   */
  trim(keep: (key: string) => boolean): void {
    if (this.bytes <= BUDGET) return;
    for (const [key, e] of this.kept) {
      if (this.bytes <= BUDGET) break;
      if (keep(key)) continue;
      this.drop(key, e);
    }
  }

  /** Lets every thumbnail go and stops: at lock, or when the grid goes. */
  close(): void {
    this.closed = true;
    for (const [key, e] of this.kept) this.drop(key, e);
    for (const key of [...this.asked]) this.cancel(key);
    this.worker?.terminate();
    this.worker = null;
    this.waiting = [];
  }

  private drop(key: string, e: Entry): void {
    this.kept.delete(key);
    this.bytes -= e.bytes;
    e.bitmap.close();
  }

  private keep(key: string, bitmap: ImageBitmap, w: number, h: number): void {
    const old = this.kept.get(key);
    if (old) this.drop(key, old);
    const bytes = bitmap.width * bitmap.height * 4;
    this.kept.set(key, { bitmap, w, h, bytes });
    this.bytes += bytes;
    this.failed.delete(key);
  }

  private arrived(key: string, made: { bitmap: ImageBitmap; w: number; h: number } | null): void {
    if (!this.asked.delete(key) || this.closed) {
      made?.bitmap.close();
      return;
    }
    if (made) {
      this.keep(key, made.bitmap, made.w, made.h);
      if (bench.on) benchCount("loads");
    } else {
      const f = this.failed.get(key) ?? { tries: 0, until: 0 };
      f.tries++;
      f.until = performance.now() + RETRY_MS * f.tries;
      this.failed.set(key, f);
      if (bench.on) benchCount("err");
    }
    this.onArrive(key);
  }

  private fromWorker(m: { kind: string; key?: string; bitmap?: ImageBitmap; w?: number; h?: number; ok?: boolean; cut?: boolean; round?: boolean }): void {
    if (m.kind === "ready") {
      this.rounded = !!(m.ok && m.round);
      this.settle(m.ok ? "worker" : "page", m.ok ? `worker${m.cut ? "" : ", scaled here"}${m.round ? "" : ", square"}` : undefined);
    } else if (m.kind === "done") {
      this.arrived(m.key!, { bitmap: m.bitmap!, w: m.w!, h: m.h! });
    } else if (m.kind === "failed") {
      this.arrived(m.key!, null);
    }
  }

  private settle(to: "worker" | "page", where?: string): void {
    if (this.mode !== "starting") return;
    this.mode = to;
    this.where = where ?? to;
    if (to === "page") {
      this.worker?.terminate();
      this.worker = null;
    }
    for (const w of this.waiting.splice(0)) {
      this.asked.delete(w.key);
      this.want(w.key, w.url);
    }
  }

  /** Without the worker: an <img>, decoded off the main thread, cut on the page. */
  private onPage(key: string, url: string): void {
    const img = new Image();
    img.decoding = "async";
    this.page.set(key, img);
    const size = this.size;
    img.src = url;
    img
      .decode()
      .then(async () => {
        if (this.page.get(key) !== img) return;
        this.page.delete(key);
        const k = Math.max(size.w / img.naturalWidth, size.h / img.naturalHeight);
        const sw = size.w / k;
        const sh = size.h / k;
        const bitmap = await createImageBitmap(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, {
          resizeWidth: size.w,
          resizeHeight: size.h,
          resizeQuality: "medium",
        });
        this.arrived(key, { bitmap, w: size.w, h: size.h });
      })
      .catch(() => {
        if (this.page.get(key) !== img) return;
        this.page.delete(key);
        this.arrived(key, null);
      });
  }
}
