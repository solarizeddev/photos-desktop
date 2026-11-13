/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Grid thumbnails served to the window over loopback HTTP, the way a web page gets its
 * images: the webview fetches several at once, decodes them off its main thread, and
 * never waits on the one request channel to the host. Before, each thumbnail crossed
 * that channel as base64 inside JSON, a batch at a time behind whatever else was queued,
 * and was parsed on the main thread, which is what made a large library load late.
 *
 * Reachable by nothing but the app's own window:
 *   - it listens on 127.0.0.1 only, so nothing on the network can connect;
 *   - every request names a 256-bit token minted at unlock and dropped at lock, which
 *     lives only in this process and the window, so another program or a web page in a
 *     browser cannot guess a URL;
 *   - the Host header must be this address exactly, so a hostname rebound to 127.0.0.1
 *     by a web page is refused;
 *   - no CORS header is sent, so no other origin can read a response;
 *   - responses carry `no-store`: the webview must not keep a decrypted thumbnail in its
 *     own disk cache, where the only copy on disk until now has been the sealed one.
 */

import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The bytes of one grid thumbnail, or null when there is none to give. `gone` fires when
 * the webview stops waiting, as it does for a tile scrolled away, so the thumbnail is not
 * fetched ahead of the ones still on screen.
 */
export type ThumbnailSource = (uid: string, gone: AbortSignal) => Promise<Buffer | null>;

/** A node uid: base64url halves joined by a tilde. Anything else is refused unread. */
const UID_SHAPE = /^[A-Za-z0-9_=~-]{1,256}$/;

/**
 * What the server is doing, for the app's log: the answers still open and since when, and
 * how the ones that ended went. A thumbnail that never arrives was invisible: the window
 * shows an empty tile, and nothing anywhere said whether the sidecar was still fetching it
 * or had never been asked. Counts and ages only, never uids.
 */
export type ServerStats = {
  open: number;
  oldestMs: number;
  served: number;
  missing: number;
  failed: number;
  dropped: number;
};
const openSince = new Map<number, number>();
let nextRequest = 0;
const ended = { served: 0, missing: 0, failed: 0, dropped: 0 };

/** The server's state now, and how the answers that ended since the last call went. */
export function takeServerStats(now = Date.now()): ServerStats {
  let oldest = now;
  for (const since of openSince.values()) oldest = Math.min(oldest, since);
  const out = { open: openSince.size, oldestMs: now - oldest, ...ended };
  ended.served = ended.missing = ended.failed = ended.dropped = 0;
  return out;
}

/** How often the server's line is written while it has anything to say. */
const STATS_EVERY_MS = 5_000;
let statsTimer: ReturnType<typeof setInterval> | null = null;

/** "[HH:MM:SS]" in UTC, as the host stamps its own lines in the same log. */
function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `[${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())}]`;
}

/**
 * Every few seconds while answers are open or have ended, one line in the app's log:
 *   [HH:MM:SS] [sidecar] [thumbs] open=<n> oldest=<ms> served=<n> missing=<n> failed=<n> dropped=<n>
 * `dropped` is answers the window stopped waiting for (a tile scrolled away).
 */
function watchServer(): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    const s = takeServerStats();
    if (s.open + s.served + s.missing + s.failed + s.dropped === 0) {
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      return;
    }
    process.stderr.write(
      `${stamp()} [sidecar] [thumbs] open=${s.open} oldest=${s.oldestMs} served=${s.served} ` +
        `missing=${s.missing} failed=${s.failed} dropped=${s.dropped}\n`,
    );
  }, STATS_EVERY_MS);
  statsTimer.unref?.();
}

let server: Server | null = null;
let port = 0;
let token: Buffer | null = null;
let source: ThumbnailSource | null = null;

/**
 * Starts serving (or keeps serving) and mints a fresh token, so a URL from before the
 * last lock is dead. Returns the base the window appends a uid to.
 */
export async function startThumbServer(from: ThumbnailSource): Promise<string> {
  source = from;
  token = randomBytes(32);
  if (!server) {
    const created = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => resolve());
    });
    const address = created.address();
    port = typeof address === "object" && address ? address.port : 0;
    server = created;
  }
  return `http://127.0.0.1:${port}/t/${token.toString("base64url")}/`;
}

/** Stops answering: the token is forgotten at once, and the port is let go. */
export async function stopThumbServer(): Promise<void> {
  token = null;
  source = null;
  const running = server;
  server = null;
  port = 0;
  if (running) {
    running.closeAllConnections?.();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
}

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const refuse = (code: number) => {
    res.writeHead(code, { "Cache-Control": "no-store" });
    res.end();
  };
  if (req.method !== "GET") return refuse(405);
  if (req.headers.host !== `127.0.0.1:${port}`) return refuse(403);

  // `/t/<token>/<uid>`, nothing else.
  const parts = (req.url ?? "").split("?")[0].split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "t") return refuse(404);
  const given = Buffer.from(parts[2], "base64url");
  const current = token;
  if (!current || given.length !== current.length || !timingSafeEqual(given, current)) {
    return refuse(403);
  }
  let uid: string;
  try {
    uid = decodeURIComponent(parts[3]);
  } catch {
    return refuse(400);
  }
  if (!UID_SHAPE.test(uid) || !source) return refuse(404);

  const gone = new AbortController();
  const id = nextRequest++;
  openSince.set(id, Date.now());
  watchServer();
  res.on("close", () => {
    openSince.delete(id);
    if (!res.writableFinished) {
      ended.dropped++;
      gone.abort();
    }
  });
  try {
    const bytes = await source(uid, gone.signal);
    if (gone.signal.aborted) return;
    if (!bytes) {
      ended.missing++;
      return refuse(404);
    }
    ended.served++;
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  } catch {
    ended.failed++;
    refuse(500);
  }
}
