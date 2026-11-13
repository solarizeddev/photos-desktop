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
 * cover does), and hands the bitmap to the page, which only copies it onto the canvas: it
 * never decodes or scales a picture.
 *
 * No OffscreenCanvas here: drawing on one in a worker and handing over the result with
 * transferToImageBitmap crashes WebKitGTK 2.52's web process (a release assertion on the
 * worker thread, some thousands of thumbnails in; reproduced under prototypes/native-grid
 * with `--web-grid appcanvas`). The corners are rounded where the tile is drawn instead.
 *
 * A fetch the page calls off (its tile scrolled far away) is aborted here, which closes the
 * connection, which tells the server to stop fetching it: WebKit never does that for an
 * <img> whose tile went, so every tile scrolled past used to hold a connection.
 *
 * No imports: it is bundled on its own.
 */

type Cut = { w: number; h: number; r: number };
type In =
  | ({ kind: "load"; key: string; url: string } & Cut)
  | { kind: "cancel"; key: string };

/** The worker's own scope, typed by hand: the app's TypeScript is set up for the page. */
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
};
const running = new Map<string, AbortController>();
/** Whether this engine resizes in createImageBitmap. */
let canResize = true;

async function cut(blob: Blob, { w, h }: Cut): Promise<ImageBitmap> {
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
  return fitted;
}

scope.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.kind === "cancel") {
    running.get(m.key)?.abort();
    running.delete(m.key);
    return;
  }
  const stop = new AbortController();
  running.get(m.key)?.abort();
  running.set(m.key, stop);
  try {
    let res: Response;
    try {
      res = await fetch(m.url, { signal: stop.signal });
    } catch (err) {
      // No answer at all: the server refused this worker (no CORS for its origin) or is
      // gone. The page decides whether to carry on without the worker.
      if (!stop.signal.aborted) scope.postMessage({ kind: "failed", key: m.key, unreachable: true });
      return;
    }
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
