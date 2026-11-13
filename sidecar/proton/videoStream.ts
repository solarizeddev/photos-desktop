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
 * A video played the way a web page plays one: the window's player asks the loopback
 * thumbnail server for byte ranges, and only those ranges are fetched and decrypted.
 *
 * Before, the whole file was downloaded into the sidecar, sent through the request channel
 * as base64 (holding the window's lane for seconds), decoded back in the window and played
 * from a blob, which WebKitGTK's player reads poorly: playback came in jerks, nothing
 * played until the whole file was in, and a video past the in-memory cap did not play at
 * all. Now playback starts after the first blocks, seeking fetches only what it lands on,
 * and the size of the file does not matter.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One video, ready to be read a range at a time. */
export type VideoSource = {
  size: number;
  mime: string;
  /** The bytes from `start` to `end` inclusive, in pieces, until done or `gone` fires. */
  read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array>;
};

/** How much is asked of the decrypting stream at once. */
const PIECE = 256 * 1024;

/**
 * The range a `Range` header asks for, within a file of `size` bytes: `null` for the whole
 * file (no header, or one this server does not read, which HTTP says to ignore), or
 * "unsatisfiable" for one that starts past the end. Only the first of several ranges is
 * served, which every player is content with.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)(?:,.*)?$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last n bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { start, end };
}

/** A video kept on this computer: its bytes are already here, so a range is a slice. */
export function videoFromBytes(bytes: Buffer, mime: string): VideoSource {
  return {
    size: bytes.length,
    mime,
    async *read(start, end, gone) {
      for (let at = start; at <= end && !gone.aborted; at += PIECE) {
        yield bytes.subarray(at, Math.min(end + 1, at + PIECE));
      }
    },
  };
}

/**
 * A video on Proton, read through the SDK's seekable stream: each range opens its own
 * stream at its start, and fetches and decrypts only the blocks it covers. `size` is the
 * size the uploader stated, which is all there is before the whole file has been read; a
 * read that runs out early simply ends there.
 */
export function videoFromDownloader(downloader: any, size: number, mime: string): VideoSource {
  return {
    size,
    mime,
    async *read(start, end, gone) {
      const stream = downloader.getSeekableStream();
      try {
        await stream.seek(start);
        for (let at = start; at <= end && !gone.aborted; ) {
          const { value, done } = await stream.read(Math.min(PIECE, end + 1 - at));
          if (!value || value.length === 0) break;
          yield value;
          at += value.length;
          if (done) break;
        }
      } finally {
        // The player moved on or the range is done: let the stream go, and the blocks it
        // kept with it.
        try {
          await stream.cancel?.();
        } catch {
          /* already closed, or held by its own reader: dropping it is enough */
        }
      }
    },
  };
}

/** How many opened videos are kept, so the ranges of one playback do not each look it up. */
const OPEN_KEPT = 4;

/**
 * The videos opened lately, by uid. A player asks for many ranges of one video (the start,
 * the index at the end, then on as it plays and seeks): the node and its downloader are
 * looked up once for all of them.
 */
export class OpenVideos {
  private open = new Map<string, Promise<VideoSource | null>>();

  constructor(private load: (uid: string) => Promise<VideoSource | null>) {}

  get(uid: string): Promise<VideoSource | null> {
    const known = this.open.get(uid);
    if (known) {
      this.open.delete(uid);
      this.open.set(uid, known);
      return known;
    }
    const opening = this.load(uid).catch(() => null);
    this.open.set(uid, opening);
    // A video that could not be opened is not kept: the next ask tries again.
    void opening.then((v) => {
      if (!v && this.open.get(uid) === opening) this.open.delete(uid);
    });
    while (this.open.size > OPEN_KEPT) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.open.delete(oldest);
    }
    return opening;
  }

  /** Forget every opened video: at lock. */
  clear(): void {
    this.open.clear();
  }
}
