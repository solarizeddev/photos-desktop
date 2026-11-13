/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * The canvas grid's thumbnail worker: fetches a thumbnail from the loopback server, decodes
 * it, cuts it to fill a tile of exactly the size it is drawn at (centred, as object-fit:
 * cover does), rounds its corners, and hands the finished bitmap to the page. The page then
 * only copies it onto the canvas: it never decodes, scales or clips a picture.
 *
 * A fetch the page calls off (its tile scrolled far away) is aborted here, which closes the
 * connection, which tells the server to stop fetching it: WebKit never does that for an
 * <img> whose tile went, so every tile scrolled past used to hold a connection.
 *
 * No imports: it is bundled on its own.
 */

type Cut = { w: number; h: number; r: number };
type In =
  | ({ kind: "probe"; url: string } & Cut)
  | ({ kind: "load"; key: string; url: string } & Cut)
  | { kind: "cancel"; key: string };

/** The worker's own scope, typed by hand: the app's TypeScript is set up for the page. */
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
};
const running = new Map<string, AbortController>();
/** Whether this engine resizes in createImageBitmap, and has an OffscreenCanvas to round corners on. */
let canResize = true;
const canRound = typeof OffscreenCanvas === "function";

async function cut(blob: Blob, { w, h, r }: Cut): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob);
  const k = Math.max(w / full.width, h / full.height);
  const sw = Math.min(full.width, w / k);
  const sh = Math.min(full.height, h / k);
  const sx = (full.width - sw) / 2;
  const sy = (full.height - sh) / 2;
  let fitted = full;
  if (canResize) {
    try {
      fitted = await createImageBitmap(full, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
      full.close();
    } catch {
      canResize = false;
    }
  }
  if (!canRound) return fitted;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return fitted;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.clip();
  if (fitted === full) ctx.drawImage(full, sx, sy, sw, sh, 0, 0, w, h);
  else ctx.drawImage(fitted, 0, 0);
  fitted.close();
  return canvas.transferToImageBitmap();
}

scope.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.kind === "cancel") {
    running.get(m.key)?.abort();
    running.delete(m.key);
    return;
  }
  if (m.kind === "probe") {
    // The worker can be trusted once a fetch to the server is answered at all: that is what
    // a missing CORS header or a refused connection would stop. A thumbnail that is not
    // there (404) still says the road is open; one that is decodes as a test of the rest.
    let res: Response;
    try {
      res = await fetch(m.url);
    } catch (err) {
      scope.postMessage({ kind: "ready", ok: false, error: String(err) });
      return;
    }
    let fits = false;
    if (res.ok) {
      try {
        const b = await cut(await res.blob(), m);
        fits = b.width === m.w && b.height === m.h;
        b.close();
      } catch {
        /* a picture that will not decode says nothing about the worker */
      }
    }
    scope.postMessage({ kind: "ready", ok: true, cut: canResize && fits, round: canRound });
    return;
  }
  const stop = new AbortController();
  running.get(m.key)?.abort();
  running.set(m.key, stop);
  try {
    const res = await fetch(m.url, { signal: stop.signal });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    if (stop.signal.aborted) return;
    const bitmap = await cut(blob, m);
    if (stop.signal.aborted) {
      bitmap.close();
      return;
    }
    scope.postMessage({ kind: "done", key: m.key, bitmap, w: m.w, h: m.h }, [bitmap]);
  } catch {
    if (!stop.signal.aborted) scope.postMessage({ kind: "failed", key: m.key });
  } finally {
    if (running.get(m.key) === stop) running.delete(m.key);
  }
};
