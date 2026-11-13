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
 * The SDK's download slots, taken and given back so none is lost.
 *
 * The SDK lets five downloads run at once. `getFileDownloader` takes a slot as it makes the
 * downloader, and the slot comes back only when a download of it ends (in that download's
 * `finally`, however it ends). A downloader made and then not used (the viewer stepped on
 * while it was set up, a file over a size cap, a pin taken back) kept its slot for good;
 * after five of those every download in the app waited for ever: a video stuck on its
 * loading note, and, because the viewer's calls queue on one lane, search and everything
 * else behind it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How long to wait for a free slot before giving up with an error rather than hanging. */
export const SLOT_WAIT_MS = 60_000;

export type OpenedDownloader = {
  downloader: any;
  /** Gives the slot back without downloading. For a downloader that will not be used. */
  unused(): void;
};

/**
 * A downloader for `uid`, with the way to give its slot back unused. Waiting for a free
 * slot gives up after `waitMs`, so a slot lost some other way shows as an error, not a hang.
 */
export async function openDownloader(client: any, uid: string, waitMs = SLOT_WAIT_MS): Promise<OpenedDownloader> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  let downloader: any;
  try {
    downloader = await client.getFileDownloader(uid, stop.signal);
  } finally {
    clearTimeout(timer);
  }
  let done = false;
  return {
    downloader,
    unused() {
      if (done) return;
      done = true;
      releaseUnusedDownloader(downloader, stop);
    },
  };
}

/**
 * Hands back the slot of a downloader that will not be used. The SDK gives a slot back
 * only when a download ends, so one is started with `stop` already fired: it ends at once,
 * and its end gives the slot back.
 */
export function releaseUnusedDownloader(downloader: any, stop: AbortController): void {
  stop.abort();
  try {
    void Promise.resolve(
      downloader.downloadToStream(new WritableStream<Uint8Array>({ write() {} })).completion(),
    ).catch(() => {});
  } catch {
    /* a downloader that will not even start has nothing to give back */
  }
}
