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
 * thumbnail server for byte ranges, and each is answered as soon as its bytes are here.
 *
 * Before, the whole file was downloaded into the sidecar, sent through the request channel
 * as base64 (holding the window's lane for seconds), decoded back in the window and played
 * from a blob, which WebKitGTK's player reads poorly: playback came in jerks, nothing
 * played until the whole file was in, and a video past the in-memory cap did not play.
 *
 * The video is still downloaded once, whole, in order and verified, into memory: the SDK's
 * own download, which hands its download slot back however it ends. What changes is that a
 * range is served the moment the bytes it covers have arrived, and a seek back is answered
 * at once. The SDK hands blocks over in batches (all of a short video's together, at the
 * end), so a phone clip of a few tens of MB still waits for its download before its first
 * frame, as before; a longer one starts while the rest arrives. A seek ahead waits for the
 * download to get there. Closing a video stops its download and lets its memory go.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One video, ready to be read a range at a time. */
export type VideoSource = {
  size: number;
  mime: string;
  /**
   * The bytes from `start` to `end` inclusive, in pieces, until done or `gone` fires.
   * Throws if the video turns out shorter than `size` before `end` is reached.
   */
  read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array>;
  /** Stops anything still fetching for it and lets its memory go. */
  close?(): void;
  /** True once it can serve nothing more (its download failed): opened afresh on the next ask. */
  broken?(): boolean;
};

/** How much is handed to the server's response at once. */
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
 * A video whose bytes are still arriving, in order, into a buffer of the size the uploader
 * stated. A read is answered from what is here and waits for the rest; one that needs bytes
 * past where the download ended (it failed, was closed, or the file is shorter than stated)
 * throws, so the server can cut the answer short and the player falls back.
 */
export class ArrivingVideo implements VideoSource {
  private bytes: Buffer;
  private have = 0;
  private ended: "done" | "failed" | null = null;
  private wake = new Set<() => void>();

  constructor(
    readonly size: number,
    readonly mime: string,
    private onClose: () => void = () => {},
  ) {
    // Pages are committed as they are written, so a long video costs what has arrived.
    this.bytes = Buffer.allocUnsafe(size);
  }

  /** The next bytes of the download. Past the stated size they are dropped. */
  append(chunk: Uint8Array): void {
    if (this.ended) return;
    const room = this.size - this.have;
    const take = Math.min(room, chunk.length);
    if (take > 0) {
      this.bytes.set(take === chunk.length ? chunk : chunk.subarray(0, take), this.have);
      this.have += take;
    }
    this.notify();
  }

  /** The download is over: `ok` when it finished, false when it failed or was stopped. */
  end(ok: boolean): void {
    if (this.ended) return;
    this.ended = ok ? "done" : "failed";
    this.notify();
  }

  /** How much has arrived (for tests). */
  arrived(): number {
    return this.have;
  }

  close(): void {
    if (!this.ended) this.end(false);
    this.onClose();
    // Nothing is served from it any more, and the buffer can go: a read under way stops
    // with an error rather than writing out bytes that are no longer there.
    this.have = 0;
    this.bytes = Buffer.alloc(0);
  }

  async *read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array> {
    let at = start;
    while (at <= end && !gone.aborted) {
      if (at < this.have) {
        const upTo = Math.min(end + 1, this.have, at + PIECE);
        // A copy: the buffer can be let go of while the piece is still being written out.
        yield Buffer.from(this.bytes.subarray(at, upTo));
        at = upTo;
        continue;
      }
      if (this.ended) throw new Error(this.ended === "done" ? "video shorter than stated" : "video download stopped");
      await this.changed(gone);
    }
  }

  private changed(gone: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.wake.delete(done);
        gone.removeEventListener("abort", done);
        resolve();
      };
      this.wake.add(done);
      gone.addEventListener("abort", done, { once: true });
    });
  }

  private notify(): void {
    for (const wake of [...this.wake]) wake();
  }
}

/**
 * Downloads a video into an `ArrivingVideo`, through the SDK's whole-file download: verified,
 * one block at a time in order, and handing back the SDK's download slot however it ends
 * (finished, failed, or stopped through `stop`, which `close` fires).
 */
export function downloadVideo(downloader: any, size: number, mime: string, stop: AbortController): ArrivingVideo {
  const video = new ArrivingVideo(size, mime, () => stop.abort());
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      if (stop.signal.aborted) throw new Error("video closed");
      video.append(chunk);
    },
  });
  let controller: any;
  try {
    controller = downloader.downloadToStream(sink);
  } catch {
    video.end(false);
    return video;
  }
  void Promise.resolve(controller.completion()).then(
    () => video.end(true),
    // A signature that could not be checked still leaves every byte downloaded: playing
    // it is no worse than the seekable stream the SDK offers players, which checks none.
    () => video.end(!!controller.isDownloadCompleteWithSignatureIssues?.()),
  );
  return video;
}

/** What a seekable read asks of the SDK at once, and how much of what it read is kept. */
const SPAN = 16 * PIECE;
const KEPT_PIECES = 128;
/** A seekable read that has not answered in this long is given up, and the video with it. */
const READ_STALL_MS = 60_000;

/**
 * The SDK's seekable stream, as the SDK hands it out: seek to a position, then read so many
 * bytes from there. One per video: closing it gives the download slot back, once.
 */
export type SeekableStream = {
  seek(position: number): void | Promise<void>;
  read(numBytes: number): Promise<{ value: Uint8Array; done: boolean }>;
};

/**
 * A video too large to hold whole, played through the SDK's seekable stream: each range the
 * player asks for is read from Proton as it is asked, a block at a time, and only the last
 * KEPT_PIECES pieces read are kept. Reads take turns on the one stream, a piece-aligned span
 * at a time, so a player reading in two places (the start and the index at the end, or a seek
 * while a read is open) costs a re-read of a block now and then, not one per piece.
 *
 * The seekable stream does not check the file's signature, as the whole-file download does;
 * for playing it back that is the SDK's own advice. Nothing is written to disk, and this is
 * never a source for saving or exporting the file.
 *
 * It holds one of the SDK's download slots from open to close (a whole download gives its
 * slot back when done): `onClose` gives it back, by firing the downloader's signal, which is
 * the only way the SDK's seekable stream lets go of it (its own cancel is refused, its reader
 * being held). A read that fails, or hangs past READ_STALL_MS, ends the video: `broken` then
 * says so, and the next ask opens it afresh.
 */
export class SeekingVideo implements VideoSource {
  private pieces = new Map<number, Uint8Array>();
  private turn: Promise<void> = Promise.resolve();
  private closed = false;
  private failed: Error | null = null;

  constructor(
    readonly size: number,
    readonly mime: string,
    private stream: SeekableStream,
    private onClose: () => void,
  ) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pieces.clear();
    this.onClose();
  }

  broken(): boolean {
    return this.failed !== null;
  }

  async *read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array> {
    let at = start;
    const last = Math.min(end, this.size - 1);
    while (at <= last && !gone.aborted) {
      const index = Math.floor(at / PIECE);
      const piece = await this.piece(index, gone);
      if (!piece) return;
      const from = at - index * PIECE;
      const upTo = Math.min(piece.length, last - index * PIECE + 1);
      if (upTo <= from) throw new Error("video shorter than stated");
      yield piece.subarray(from, upTo);
      at = index * PIECE + upTo;
    }
  }

  /** Piece `index`, from those kept or read now (with the span after it); null if given up. */
  private async piece(index: number, gone: AbortSignal): Promise<Uint8Array | null> {
    const kept = this.pieces.get(index);
    if (kept) {
      this.pieces.delete(index);
      this.pieces.set(index, kept);
      return kept;
    }
    // One read of the stream at a time: it has one position. A reader the player gave up
    // while it waited leaves at once, its turn passed on when the one before it ends.
    const before = this.turn;
    let release!: () => void;
    this.turn = new Promise<void>((resolve) => (release = resolve));
    const leave = new Promise<false>((resolve) => {
      if (gone.aborted) resolve(false);
      else gone.addEventListener("abort", () => resolve(false), { once: true });
    });
    if (!(await Promise.race([before.then(() => true), leave]))) {
      void before.then(release);
      return null;
    }
    try {
      if (gone.aborted || this.closed) return null;
      if (this.failed) throw this.failed;
      // Another reader may have read it while this one waited.
      const now = this.pieces.get(index);
      if (now) return now;
      const from = index * PIECE;
      const length = Math.min(SPAN, this.size - from);
      if (length <= 0) throw new Error("video shorter than stated");
      let stall: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          (async () => {
            await this.stream.seek(from);
            return (await this.stream.read(length)).value;
          })(),
          new Promise<never>((_, reject) => {
            stall = setTimeout(() => reject(new Error("video read stalled")), READ_STALL_MS);
          }),
        ]);
        if (this.closed) return null;
        if (value.length < length) throw new Error("video shorter than stated");
        for (let i = 0; i * PIECE < value.length; i++) this.keep(index + i, value.subarray(i * PIECE, (i + 1) * PIECE));
      } catch (e) {
        // The stream is no use any more (failed, ended short, or hung): the video is closed,
        // which gives the slot back, and the next ask opens it afresh.
        this.failed = e instanceof Error ? e : new Error("video read failed");
        this.close();
        throw this.failed;
      } finally {
        clearTimeout(stall);
      }
      return this.pieces.get(index) ?? null;
    } finally {
      release();
    }
  }

  private keep(index: number, bytes: Uint8Array): void {
    this.pieces.delete(index);
    // A copy, so the SDK's buffer the span came from can go.
    this.pieces.set(index, Uint8Array.from(bytes));
    while (this.pieces.size > KEPT_PIECES) {
      const oldest = this.pieces.keys().next().value;
      if (oldest === undefined) break;
      this.pieces.delete(oldest);
    }
  }
}

/**
 * A video played through the SDK's seekable stream (see `SeekingVideo`), or null where the
 * file cannot be read that way (an old one, with no block sizes on record), in which case the
 * downloader's slot is given back.
 */
export function seekVideo(
  downloader: any,
  size: number,
  mime: string,
  opened: { stop: AbortController; unused: () => void; released: () => void },
): SeekingVideo | null {
  let stream: SeekableStream;
  try {
    stream = downloader.getSeekableStream();
  } catch {
    opened.unused();
    return null;
  }
  return new SeekingVideo(size, mime, stream, () => {
    opened.stop.abort();
    opened.released();
  });
}

/** Hands back the slot of a downloader that will not be used: see `downloadSlots`. */
export { releaseUnusedDownloader } from "./downloadSlots.ts";

/** How many videos are kept open: the one playing and the one stepped back from. */
const OPEN_KEPT = 2;

/** A video nobody has read from, and with no answer open, for this long is closed. */
const IDLE_MS = 90_000;

/**
 * The videos opened lately, by uid. A player asks for many ranges of one video (the start,
 * the index at the end, then on as it plays and seeks): it is opened once for all of them.
 * One that falls out (more than OPEN_KEPT, or idle for IDLE_MS, or at lock) is closed: its
 * download stops and its memory goes.
 */
export class OpenVideos {
  private open = new Map<string, { video: Promise<VideoSource | null>; used: number; reading: number; opened?: VideoSource }>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private load: (uid: string) => Promise<VideoSource | null>,
    private now: () => number = Date.now,
    private idleMs = IDLE_MS,
  ) {}

  get(uid: string): Promise<VideoSource | null> {
    let known = this.open.get(uid);
    // One whose download failed is let go and opened afresh.
    if (known?.opened?.broken?.()) {
      this.drop(uid);
      known = undefined;
    }
    if (known) {
      this.open.delete(uid);
      known.used = this.now();
      this.open.set(uid, known);
      return known.video;
    }
    const entry: { video: Promise<VideoSource | null>; used: number; reading: number; opened?: VideoSource } = {
      video: Promise.resolve<VideoSource | null>(null),
      used: this.now(),
      reading: 0,
    };
    // Every piece written out counts as use, so a video still playing is never idle.
    entry.video = this.load(uid)
      .catch(() => null)
      .then((v) => {
        entry.opened = v ?? undefined;
        return v ? this.keptInUse(v, entry) : null;
      });
    const video = entry.video;
    this.open.set(uid, entry);
    // A video that could not be opened is not kept: the next ask tries again.
    void video.then((v) => {
      if (!v && this.open.get(uid) === entry) this.open.delete(uid);
    });
    while (this.open.size > OPEN_KEPT) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.startSweep();
    return video;
  }

  /**
   * Every piece written out counts as use, and so does an answer still open: a paused
   * player keeps its connection and reads nothing, and closing its video then would have it
   * downloaded again from the start when play resumes.
   */
  private keptInUse(v: VideoSource, entry: { used: number; reading: number }): VideoSource {
    const now = this.now;
    return {
      size: v.size,
      mime: v.mime,
      close: () => v.close?.(),
      broken: () => v.broken?.() ?? false,
      async *read(start, end, gone) {
        entry.reading++;
        try {
          for await (const piece of v.read(start, end, gone)) {
            entry.used = now();
            yield piece;
          }
        } finally {
          entry.reading--;
          entry.used = now();
        }
      },
    };
  }

  /** Closes videos left idle. Called on a timer; public for tests. */
  closeIdle(): void {
    const now = this.now();
    for (const [uid, entry] of [...this.open]) {
      if (entry.reading === 0 && now - entry.used >= this.idleMs) this.drop(uid);
    }
    if (this.open.size === 0) this.stopSweep();
  }

  /** Close every video: at lock. */
  clear(): void {
    for (const uid of [...this.open.keys()]) this.drop(uid);
    this.stopSweep();
  }

  /** How many videos are open (for tests). */
  size(): number {
    return this.open.size;
  }

  private drop(uid: string): void {
    const entry = this.open.get(uid);
    if (!entry) return;
    this.open.delete(uid);
    void entry.video.then((v) => v?.close?.());
  }

  private startSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.closeIdle(), Math.max(1000, Math.floor(this.idleMs / 3)));
    this.sweep.unref?.();
  }

  private stopSweep(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}
