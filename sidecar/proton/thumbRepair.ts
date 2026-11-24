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

// Thumbnails for the videos Proton holds none for: they went up from a computer that could not
// draw one (an import on Linux whose decoders did not know the format, say). Each one Proton
// answers "no image preview" for, as the grid and the duplicate finder ask, is noted here; the
// window hands the latest few to the host, which draws a picture of each from the thumbnail
// server's own stream of it, and the sidecar keeps that as its thumbnail on this computer, where
// the grid and the duplicate finder read it from then on. Proton's copy is left as it is.
//
// A video this computer's decoders could not draw is left alone for a week, across restarts, as
// a decoder may be added meanwhile. One not drawn for a passing reason (it could not be read in
// time) is asked for again a few times this session.

import { join } from "node:path";

import { THUMB_REPAIR_FILE, readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";

/** The SDK's answer for a photo with no thumbnail at all, as opposed to one it could not fetch. */
export const NO_PREVIEW = "This item has no image preview";
/** Photos without a thumbnail kept noted at once: the latest, which are the ones on screen. */
const THUMBLESS_KEPT = 200;
/** Kinds looked up on Proton per call for a video to draw. */
const KIND_LOOKUPS = 10;
/** The most videos handed out in one call. */
const MOST_AT_ONCE = 10;
/** Videos that could not be drawn, kept noted. */
const UNDRAWABLE_KEPT = 20_000;
/** How long a video that could not be drawn is left alone: a decoder may be added meanwhile. */
export const UNDRAWABLE_FOR_MS = 7 * 24 * 3_600_000;
/** Bumped when frames are drawn another way, so those that failed are tried again. */
const FRAME_RECIPE = 1;
/** How many times this session a video not drawn for a passing reason is handed out. */
export const TRIES = 3;

/** What the bookkeeping asks of the library: kept thumbnails and the kinds of photos. */
export type RepairLookup = {
  /** Whether a thumbnail is kept for it on this computer already. */
  hasThumb(uid: string): boolean;
  /** Its media type when known without asking Proton, else null. */
  known(uid: string): string | null;
  /** Its media type, asked of Proton; empty when that cannot be had. */
  lookUp(uid: string): Promise<string>;
};

export class ThumbRepairs {
  /** Photos Proton said it holds no thumbnail for, the latest last. */
  private thumbless = new Map<string, number>();
  /** Handed out to draw, and not answered for yet. */
  private handed = new Set<string>();
  /** How many times this session each was handed out. */
  private tries = new Map<string, number>();
  /** Not to be handed out again this session: no video, or one that cannot be read for a picture. */
  private passed = new Set<string>();
  /** Those this computer's decoders could not draw, and when; read from disk once. */
  private undrawable: Map<string, number> | null = null;
  private loggedOther = false;

  constructor(
    private readonly path: () => string = () => join(storeDir(), THUMB_REPAIR_FILE),
    private readonly now: () => number = Date.now,
  ) {}

  /** Notes `uid` when Proton's answer for its thumbnail was that it has none, and only then. */
  note(uid: string, error: unknown): void {
    if (String(error) !== NO_PREVIEW) {
      // Said once, so a reworded answer from the SDK does not leave this silently idle. Only
      // the start of it: the answer names no photo.
      if (!this.loggedOther && typeof error === "string" && /preview|thumbnail/i.test(error)) {
        this.loggedOther = true;
        process.stderr.write(`[thumbs] a thumbnail answer other than "no preview" (${error.slice(0, 60)})\n`);
      }
      return;
    }
    if (this.passed.has(uid) || this.handed.has(uid)) return;
    this.thumbless.delete(uid);
    this.thumbless.set(uid, this.now());
    while (this.thumbless.size > THUMBLESS_KEPT) {
      const oldest = this.thumbless.keys().next().value;
      if (oldest === undefined) break;
      this.thumbless.delete(oldest);
    }
  }

  /**
   * Up to `limit` videos to draw a thumbnail for, the latest noted first: Proton has none for
   * them, none was made here, and this computer has not failed to draw one lately. One whose
   * kind is not known is looked up, a few a call at most: a photo is not drawn this way.
   * Throws while the store is locked.
   */
  async next(limit: number, lookup: RepairLookup): Promise<string[]> {
    const undrawable = this.loadUndrawable();
    const want = Math.min(Math.max(1, Math.floor(limit) || 1), MOST_AT_ONCE);
    const out: string[] = [];
    let lookups = 0;
    for (const uid of [...this.thumbless.keys()].reverse()) {
      if (out.length >= want || lookups >= KIND_LOOKUPS) break;
      this.thumbless.delete(uid);
      if (undrawable.has(uid) || this.handed.has(uid) || this.passed.has(uid) || lookup.hasThumb(uid)) continue;
      let kind = lookup.known(uid);
      if (!kind) {
        lookups++;
        kind = await lookup.lookUp(uid).catch(() => "");
      }
      if (!kind.startsWith("video/")) {
        // One whose kind could not be had is noted again by the next grid that asks for it.
        if (kind) this.passed.add(uid);
        continue;
      }
      this.handed.add(uid);
      this.tries.set(uid, (this.tries.get(uid) ?? 0) + 1);
      out.push(uid);
    }
    return out;
  }

  /** Whether `uid` was handed out to draw and not answered for yet. */
  isHanded(uid: string): boolean {
    return this.handed.has(uid);
  }

  /** A video answered for: its thumbnail kept, or one that could not be. */
  settle(uid: string): void {
    this.handed.delete(uid);
  }

  /** Not handed out again this session: it cannot be read for a picture (too large, say). */
  pass(uid: string): void {
    this.passed.add(uid);
    this.thumbless.delete(uid);
  }

  /** Videos not drawn for a passing reason: noted again, the latest, up to TRIES handings. */
  letGo(uids: string[]): void {
    for (const uid of uids) {
      if (!this.handed.delete(uid)) continue;
      if (this.passed.has(uid) || (this.tries.get(uid) ?? 0) >= TRIES) continue;
      this.thumbless.set(uid, this.now());
    }
  }

  /**
   * Videos this computer's decoders could not draw: left alone for UNDRAWABLE_FOR_MS, and kept
   * so across restarts. Answers how many were handed out and are noted now. Throws while the
   * store is locked; a write that fails is tried again with the next one.
   */
  cannotDraw(uids: string[]): number {
    // Only what was handed out, and not let go of since: after a lock that is nothing, and the
    // locked store is not touched.
    const mine = uids.filter((uid) => this.handed.delete(uid));
    if (mine.length === 0) return 0;
    const kept = this.loadUndrawable();
    for (const uid of mine) {
      kept.delete(uid);
      kept.set(uid, this.now());
    }
    const latest = [...kept].slice(-UNDRAWABLE_KEPT);
    try {
      writeSealedAtomic(this.path(), Buffer.from(JSON.stringify({ r: FRAME_RECIPE, u: Object.fromEntries(latest) }), "utf8"));
    } catch {
      /* noted for this session, and written with the next one */
    }
    return mine.length;
  }

  /** Lets go of everything, at lock and sign-out; nothing is written. */
  clear(): void {
    this.thumbless.clear();
    this.handed.clear();
    this.tries.clear();
    this.passed.clear();
    this.undrawable = null;
  }

  private loadUndrawable(): Map<string, number> {
    if (this.undrawable) return this.undrawable;
    // Read before it counts as loaded: a locked store throws, and the next call reads again.
    const raw = readSealedOrSetAside(this.path());
    const kept = new Map<string, number>();
    try {
      const saved = raw ? (JSON.parse(raw.toString("utf8")) as { r?: unknown; u?: unknown }) : null;
      // Tried again once the way frames are drawn has changed, or a week on.
      if (saved?.r === FRAME_RECIPE && saved.u && typeof saved.u === "object") {
        const since = this.now() - UNDRAWABLE_FOR_MS;
        for (const [uid, at] of Object.entries(saved.u as Record<string, unknown>)) {
          if (typeof at === "number" && at > since) kept.set(uid, at);
        }
      }
    } catch {
      /* a file that will not parse starts the list over */
    }
    this.undrawable = kept;
    return kept;
  }
}
