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
 * The SDK's download slots, given back when a downloader is not used.
 *
 * The SDK lets five downloads run at once. `getFileDownloader` takes a slot as it makes the
 * downloader, and the slot comes back only when a download of it ends (in that download's
 * `finally`, however it ends). A downloader made and then not used (the viewer stepped on
 * while it was set up, a file over a size cap, a pin taken back) kept its slot for good;
 * after five of those every download in the app waited for ever.
 *
 * A large video reads ahead on more than one of them while they are free: those are lent,
 * and come back as soon as any other download needs one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How many downloads the SDK lets run at once. */
export const SDK_SLOTS = 5;

/**
 * Slots lent out: those of a playing video's extra read lanes. Any other download that finds
 * every slot taken has the newest given back, so a video never keeps a save, an export or an
 * offline copy waiting.
 */
const lent: Array<() => void> = [];
/** How often a download still waiting for a slot takes back one more lent slot. */
const RECLAIM_EVERY_MS = 500;
/** How long a download may wait to be made before lent slots are taken back regardless. */
const RECLAIM_AFTER_MS = 1_500;

/** Slots held by the downloaders made here, and those being made now (taking one). */
let held = 0;
let opening = 0;

/** How many of the SDK's slots this app holds, or is taking now. */
export function slotsHeld(): number {
  return held + opening;
}

/**
 * Lends a slot, given back by `giveBack` when another download needs it. Returns how to take
 * it off the list, for when it is let go some other way.
 */
export function lendSlot(giveBack: () => void): () => void {
  lent.push(giveBack);
  return () => {
    const at = lent.indexOf(giveBack);
    if (at >= 0) lent.splice(at, 1);
  };
}

export type OpenedDownloader = {
  downloader: any;
  /** Gives the slot back when no read of it has started. Does nothing once one has. */
  unused(): void;
  /**
   * Stops a read of it under way (a download, whose end gives the slot back, or its seekable
   * stream, which gives it back as its signal fires); or gives the slot back unused.
   */
  stop(): void;
};

/**
 * A downloader for `uid`, with the way to give its slot back unused. Waits for a free slot
 * as long as the SDK makes it wait, or until `signal` fires. A video's extra read lane
 * `borrow`s: unlike every other download, it never takes a lent slot back.
 */
export async function openDownloader(
  client: any,
  uid: string,
  signal?: AbortSignal,
  { borrow = false }: { borrow?: boolean } = {},
): Promise<OpenedDownloader> {
  // A lent slot comes back at once when every slot is counted taken, and one more every so
  // often while this still waits (a slot can be held where this does not count it).
  if (!borrow && slotsHeld() >= SDK_SLOTS) lent.pop()?.();
  const since = Date.now();
  const reclaim = borrow
    ? undefined
    : setInterval(() => {
        if (slotsHeld() >= SDK_SLOTS || Date.now() - since >= RECLAIM_AFTER_MS) lent.pop()?.();
      }, RECLAIM_EVERY_MS);
  const stop = new AbortController();
  const own = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let downloader: any;
  opening++;
  try {
    downloader = await client.getFileDownloader(uid, own);
  } finally {
    opening--;
    clearInterval(reclaim);
  }
  held++;
  let holding = true;
  const letGo = () => {
    if (!holding) return;
    holding = false;
    held--;
  };
  let started = false;
  let seeking = false;
  const start = downloader.downloadToStream?.bind(downloader);
  if (start) {
    downloader.downloadToStream = (...args: unknown[]) => {
      started = true;
      const controller = start(...args);
      void Promise.resolve()
        .then(() => controller.completion())
        .catch(() => {})
        .finally(letGo);
      return controller;
    };
  }
  const seekable = downloader.getSeekableStream?.bind(downloader);
  if (seekable) {
    downloader.getSeekableStream = (...args: unknown[]) => {
      // A stream made on a signal already fired never sees it fire, and would keep the slot
      // for good. One that cannot be made (an old file) leaves the slot to `unused`.
      if (own.aborted) throw new Error("download stopped");
      const stream = seekable(...args);
      started = true;
      seeking = true;
      return stream;
    };
  }
  const unused = () => {
    if (started) return;
    started = true;
    releaseUnusedDownloader(start, stop, letGo);
  };
  return {
    downloader,
    unused,
    stop() {
      if (!started) return unused();
      stop.abort();
      if (seeking) letGo();
    },
  };
}

/**
 * Hands back the slot of a downloader that will not be used. The SDK gives a slot back
 * only when a download ends, so one is started with `stop` already fired: it ends at once,
 * and its end gives the slot back.
 */
function releaseUnusedDownloader(
  start: ((...args: unknown[]) => any) | undefined,
  stop: AbortController,
  done: () => void,
): void {
  stop.abort();
  try {
    void Promise.resolve(start?.(new WritableStream<Uint8Array>({ write() {} }))?.completion())
      .catch(() => {})
      .finally(done);
  } catch {
    /* a downloader that will not even start has nothing to give back */
    done();
  }
}
