// The app's timeline layout worked out by hand, for the two grids that do not use the app's
// components: the same columns, tile size, gap and month headers as VirtualSections and
// PhotoGrid lay out (6 px gap, tiles 0.85 as wide as tall, as many columns as fit at the
// tile size, stretched to fill), so all three grids show the same tiles in the same places.

export const GAP = 6;
export const ASPECT = 0.85;
/** `.g-monthhdr`: 24 px above, 10 px below, a 22 px title line. Measured once by the page. */
export const HEADER_GUESS = 62;

export type Section = { key: string; start: number; count: number; top: number; height: number };

export type Layout = {
  columns: number;
  tile: number;
  rowH: number;
  pitch: number;
  header: number;
  sections: Section[];
  height: number;
};

/** The same month-like sections the native side makes (ng_common::sections). */
export function sectionCounts(n: number, sections: boolean): number[] {
  const out: number[] = [];
  let i = 0;
  let m = 0;
  while (i < n) {
    const c = sections ? Math.min(n - i, 150 + ((m * 977) % 700)) : n;
    out.push(c);
    i += c;
    m++;
  }
  return out;
}

export function layout(counts: number[], gridWidth: number, cell: number, header: number): Layout {
  const columns = Math.max(1, Math.floor((gridWidth + GAP) / (cell + GAP)));
  const tile = (gridWidth - GAP * (columns - 1)) / columns;
  const rowH = tile / ASPECT;
  const pitch = rowH + GAP;
  const sections: Section[] = [];
  let y = 0;
  let start = 0;
  counts.forEach((count, m) => {
    const rows = Math.ceil(count / columns);
    const height = header + (rows > 0 ? rows * rowH + (rows - 1) * GAP : 0);
    sections.push({ key: "Month " + m, start, count, top: y, height });
    y += height;
    start += count;
  });
  return { columns, tile, rowH, pitch, header, sections, height: y };
}

/** One tile placed: which item, and where (x within the grid, y within the whole list). */
export type Placed = { idx: number; x: number; y: number };
/** One header placed. */
export type PlacedHeader = { key: string; count: number; y: number };

/**
 * What is in a stretch of the list. Its objects are reused from one call to the next (only
 * the first `n` and `hn` are current), so working it out on every scroll step makes no
 * garbage. Tile indexes rise with y, so the tiles in a stretch are `first..last`.
 */
export class Range {
  tiles: Placed[] = [];
  n = 0;
  heads: PlacedHeader[] = [];
  hn = 0;
  get first(): number {
    return this.n > 0 ? this.tiles[0].idx : -1;
  }
  get last(): number {
    return this.n > 0 ? this.tiles[this.n - 1].idx : -2;
  }
  private tile(idx: number, x: number, y: number): void {
    const t = this.tiles[this.n];
    if (t) {
      t.idx = idx;
      t.x = x;
      t.y = y;
    } else this.tiles.push({ idx, x, y });
    this.n++;
  }
  private head(key: string, count: number, y: number): void {
    const h = this.heads[this.hn];
    if (h) {
      h.key = key;
      h.count = count;
      h.y = y;
    } else this.heads.push({ key, count, y });
    this.hn++;
  }

  /**
   * Every tile and header with any part between `from` and `to` (list coordinates). Sections
   * are found by binary search, so this costs what is in the range, not the list's length.
   */
  fill(l: Layout, from: number, to: number): this {
    this.n = 0;
    this.hn = 0;
    const s = l.sections;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].top <= from) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < s.length && s[i].top < to; i++) {
      const sec = s[i];
      if (sec.top + sec.height <= from) continue;
      if (l.header > 0 && sec.top + l.header > from) this.head(sec.key, sec.count, sec.top);
      const gridTop = sec.top + l.header;
      const rows = Math.ceil(sec.count / l.columns);
      const r0 = Math.max(0, Math.floor((from - gridTop) / l.pitch));
      const r1 = Math.min(rows, Math.ceil((to - gridTop) / l.pitch));
      for (let r = r0; r < r1; r++) {
        const y = gridTop + r * l.pitch;
        for (let c = 0; c < l.columns; c++) {
          const k = r * l.columns + c;
          if (k >= sec.count) break;
          this.tile(sec.start + k, c * (l.tile + GAP), y);
        }
      }
    }
    return this;
  }
}

/**
 * The thumbnail the app asks for (app/src/lib/thumbSize.ts, copied so this folder builds on
 * a branch without it): the tile's height in device pixels, rounded up to one of the widths
 * the sidecar cuts to, or the full thumbnail past the largest.
 */
const THUMB_WIDTHS = [128, 192, 256, 320, 384];
export function thumbPxFor(tileWidth: number, pixelRatio: number): number | null {
  const px = Math.ceil((tileWidth / ASPECT) * (pixelRatio > 0 ? pixelRatio : 1));
  if (!Number.isFinite(px) || px <= 0) return null;
  for (const w of THUMB_WIDTHS) if (px <= w) return w;
  return null;
}
export function thumbUrlFor(base: string, uid: string, px: number | null, attempt: number): string {
  const q = new URLSearchParams();
  if (px) q.set("w", String(px));
  if (attempt) q.set("a", String(attempt));
  const qs = q.toString();
  return base + encodeURIComponent(uid) + (qs ? `?${qs}` : "");
}

/** What each grid tells the measuring loop ten times a second. */
export type Probe = { vis: number; blank: number; columns: number; tile: [number, number]; built: number };

export type MountedGrid = {
  scroller: HTMLElement;
  gridWidth: number;
  probe(): Probe;
};

/**
 * How fast the list is moving, in px/s, from its scroll steps. Above `fast` the grids stop
 * asking for thumbnails (Google Photos' web grid and Glide during a fling do the same): a
 * tile on screen for a few frames is not worth a fetch and a decode, and asking for it
 * pushes the tiles the reader will stop on to the back of the line. `onSettle` runs once
 * scrolling has stopped, or slowed below `fast`, so what is on screen is then asked for.
 */
export class Speed {
  private top = 0;
  private at = 0;
  private v = 0;
  /** One timer for the whole scroll: it checks, when it fires, whether scrolling went on. */
  private settle: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private fast: number,
    private onSettle: () => void,
  ) {}
  /** Called on each scroll step. */
  step(top: number): void {
    const now = performance.now();
    const dt = now - this.at;
    if (this.at > 0 && dt > 0 && dt < 250) {
      // Smoothed over a few steps, so one long frame does not read as a fling.
      this.v = this.v * 0.6 + (Math.abs(top - this.top) / dt) * 1000 * 0.4;
    } else {
      this.v = 0;
    }
    this.top = top;
    this.at = now;
    if (!this.settle) this.arm(SETTLE_MS);
  }
  isFast(): boolean {
    return this.v > this.fast;
  }
  private arm(ms: number): void {
    this.settle = setTimeout(() => {
      const quiet = performance.now() - this.at;
      if (quiet < SETTLE_MS) return this.arm(SETTLE_MS - quiet);
      this.settle = null;
      this.v = 0;
      this.onSettle();
    }, ms);
  }
}

/** How long without a scroll step counts as stopped. */
const SETTLE_MS = 120;
