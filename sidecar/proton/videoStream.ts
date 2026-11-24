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

import type { OpenedDownloader } from "./downloadSlots.ts";
import { diag } from "./diag.ts";

/**
 * A video played the way a web page plays one: the window's player asks the loopback
 * thumbnail server for byte ranges, and each is answered as soon as its bytes are here.
 *
 * Otherwise the whole file is downloaded into the sidecar, sent through the request channel
 * as base64 (holding the window's lane for seconds), decoded back in the window and played
 * from a blob, which WebKitGTK's player reads poorly: nothing plays until the whole file is
 * in, and playback comes in jerks.
 *
 * The video is still downloaded once, whole, in order and verified, into memory, through the
 * SDK's own download, which hands its download slot back however it ends. What changes is
 * that a range is served the moment the bytes it covers have arrived, and a seek back is
 * answered at once. A seek ahead waits for the download to get there. Closing a video stops
 * its download and lets its memory go.
 *
 * A video too large to hold whole is read from Proton a block at a time where the player
 * asks, and a few blocks ahead of it, through the SDK's seekable stream (see `SeekingVideo`).
 *
 * Nothing waits for ever: a video whose first bytes are not here within VIDEO_START_MS is
 * answered with an error, and so is a read whose next bytes stall that long, so the viewer
 * falls back to the whole file. A video that can never be streamed is remembered for a while
 * and refused at once, so the viewer goes to the whole file without trying again.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The largest video downloaded whole into the sidecar's memory while it plays, its signature
 * checked. A larger one is read a block at a time as it plays (see `SeekingVideo`). It is
 * also the most the videos kept open hold together, besides the one playing.
 */
export const MAX_STREAMED_VIDEO = 300 * 1024 * 1024;

/** How long a video's lookup and first bytes are waited for. */
export const VIDEO_START_MS = 30_000;
/** How long a read waits for the next bytes of a download that has stopped moving. */
export const VIDEO_STALL_MS = 30_000;

/** How long a video that can never be streamed is refused without being looked up again. */
const NOT_STREAMABLE_MS = 10 * 60_000;

/**
 * The answer for a video that can never be streamed: Proton does not say how large it is,
 * it is not a video, it is kept offline over the size held in memory, its signature did not
 * check out, or it is too large to hold whole and an old file that cannot be read a block at
 * a time. The viewer plays it the older way, or says why it cannot.
 */
export const NOT_STREAMABLE = "not-streamable";

/** A video to stream, one that can never be, or null when it cannot be had just now. */
export type VideoAnswer = VideoSource | typeof NOT_STREAMABLE | null;

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
  /** True once it must never be played (its signature did not check out). */
  refused?(): boolean;
  /** The most of it held in memory at once, when that is less than its size. */
  holds?: number;
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
 * A video whose bytes are still arriving, in order, kept as the pieces the download hands
 * over, so it holds what has arrived and never more. A read is answered from what is here
 * and waits for the rest; one that needs bytes past where the download ended (it failed, was
 * closed, or the file is shorter than stated) throws, so the server can cut the answer short
 * and the player falls back.
 */
export class ArrivingVideo implements VideoSource {
  private chunks: Uint8Array[] = [];
  /** Where each of `chunks` starts in the file. */
  private starts: number[] = [];
  private have = 0;
  private ended: "done" | "failed" | "unverified" | null = null;
  private wake = new Set<() => void>();

  constructor(
    readonly size: number,
    readonly mime: string,
    private onClose: () => void = () => {},
    private stallMs = VIDEO_STALL_MS,
  ) {}

  /** The next bytes of the download. Past the stated size they are dropped. */
  append(chunk: Uint8Array): void {
    if (this.ended) return;
    const take = Math.min(this.size - this.have, chunk.length);
    if (take > 0) {
      this.starts.push(this.have);
      this.chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
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

  /**
   * Its signature did not check out: nothing more of it is served, and a read under way
   * stops with an error.
   */
  reject(): void {
    if (this.ended === "unverified") return;
    this.ended = "unverified";
    this.close();
  }

  /** Its download failed or stopped: the next ask opens the video afresh. */
  broken(): boolean {
    return this.ended === "failed" || this.ended === "unverified";
  }

  refused(): boolean {
    return this.ended === "unverified";
  }

  /** Resolves once the first bytes are here, the download is over, or `signal` fires. */
  async started(signal: AbortSignal): Promise<void> {
    while (this.have === 0 && !this.ended && !signal.aborted) await this.changed(signal);
  }

  close(): void {
    if (!this.ended) this.end(false);
    this.onClose();
    // Nothing is served from it any more, and its memory can go: a read under way stops
    // with an error rather than writing out bytes that are no longer kept.
    this.have = 0;
    this.chunks = [];
    this.starts = [];
    this.notify();
  }

  async *read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array> {
    let at = start;
    while (at <= end && !gone.aborted) {
      if (at < this.have) {
        const i = this.chunkAt(at);
        const from = at - this.starts[i];
        const upTo = Math.min(end + 1, this.starts[i] + this.chunks[i].length, at + PIECE);
        yield this.chunks[i].subarray(from, from + upTo - at);
        at = upTo;
        continue;
      }
      if (this.ended === "unverified") throw new Error("video signature not verified");
      if (this.ended) throw new Error(this.ended === "done" ? "video shorter than stated" : "video download stopped");
      if (!(await this.changed(gone, this.stallMs))) {
        // Nothing arrived for the whole wait: the download is stopped, which gives its slot
        // back, and the answer is cut so the player gives up.
        this.close();
        throw new Error("video download stalled");
      }
    }
  }

  /** The piece that holds byte `at`, which has arrived. */
  private chunkAt(at: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** True when something changed or `gone` fired, false once `timeoutMs` passed first. */
  private changed(gone: AbortSignal, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (moved: boolean) => {
        clearTimeout(timer);
        this.wake.delete(done);
        gone.removeEventListener("abort", done);
        resolve(moved);
      };
      const done = () => finish(true);
      this.wake.add(done);
      gone.addEventListener("abort", done, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  private notify(): void {
    for (const wake of [...this.wake]) wake();
  }
}

/**
 * Downloads a video into an `ArrivingVideo`, through the SDK's whole-file download: verified,
 * one block at a time in order, and handing back the SDK's download slot however it ends
 * (finished, failed, or stopped by `close`).
 */
export function downloadVideo(
  opened: OpenedDownloader,
  size: number,
  mime: string,
  stallMs = VIDEO_STALL_MS,
): ArrivingVideo {
  let closed = false;
  const video = new ArrivingVideo(
    size,
    mime,
    () => {
      closed = true;
      opened.stop();
    },
    stallMs,
  );
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw new Error("video closed");
      video.append(chunk);
    },
  });
  let controller: any;
  try {
    controller = opened.downloader.downloadToStream(sink);
  } catch {
    video.end(false);
    return video;
  }
  void Promise.resolve(controller.completion()).then(
    () => video.end(true),
    // A signature that did not check out fails the video, as the whole-file route fails
    // it: nothing more of it is played, and the viewer's fallback refuses it as well.
    () => (controller.isDownloadCompleteWithSignatureIssues?.() ? video.reject() : video.end(false)),
  );
  return video;
}

/**
 * Downloads a video to play and waits for its first bytes, so the answer's headers go out
 * only for one that is coming. Null when the download failed first or `signal` fired (its
 * slot is given back either way); NOT_STREAMABLE when its signature did not check out.
 */
export async function startVideo(
  opened: OpenedDownloader,
  size: number,
  mime: string,
  signal: AbortSignal,
  stallMs = VIDEO_STALL_MS,
): Promise<VideoAnswer> {
  const video = downloadVideo(opened, size, mime, stallMs);
  await video.started(signal);
  if (video.refused()) return NOT_STREAMABLE;
  if (signal.aborted || video.broken()) {
    video.close();
    return null;
  }
  return video;
}

/** Why a read failed, as a word for the log: never the error's own text, which may name the file. */
function failure(e: unknown): string {
  const text = e instanceof Error ? e.message : "";
  if (text === "video read stalled") return "stalled";
  if (text === "video shorter than stated") return "short";
  return e instanceof Error ? e.name || "Error" : "unknown";
}

/** What one seekable read asks of the SDK: one Proton block. */
const SPAN = 16 * PIECE;
/** How many spans are read ahead of the player, and how many pieces are kept in all. */
const AHEAD = 6;
const KEPT_PIECES = 16 * 16;
/**
 * A seekable read that has not answered in this long is given up, and the video with it.
 * Longer than VIDEO_STALL_MS: one read is a block token and then a whole block.
 */
const READ_STALL_MS = 60_000;

/**
 * The SDK's seekable stream, as the SDK hands it out: seek to a position, then read so many
 * bytes from there. One per downloader: stopping the downloader gives its slot back, once.
 */
export type SeekableStream = {
  seek(position: number): void | Promise<void>;
  read(numBytes: number): Promise<{ value: Uint8Array; done: boolean }>;
};

/** One seekable stream of a video, and how to let it go (which gives its slot back). */
type Lane = { stream: SeekableStream; close: () => void; busy: boolean; leaving: boolean; first: boolean };

/**
 * A video too large to hold whole, played through the SDK's seekable stream. It is read a
 * block (span) at a time, and AHEAD spans past the one the player is in are read before it
 * gets there. Each read is a block token and the block from Proton, one after the other, so
 * one stream alone falls behind a high bitrate video and the player keeps stopping: a video
 * can be given more streams (lanes, each its own downloader), and reads ahead run on the
 * lanes that are free. Only the last KEPT_PIECES pieces read are kept.
 *
 * The seekable stream does not check the file's signature, as the whole-file download does;
 * for playing it back that is the SDK's own advice. Nothing is written to disk, and this is
 * never a source for saving or exporting the file.
 *
 * Each lane holds one of the SDK's download slots until it is let go: its `close` stops its
 * downloader, which fires the signal the SDK's seekable stream gives its slot back on. A lane
 * added later can be asked to leave (`leave`), as soon as it has finished the read it is on.
 * A read that fails, or hangs past READ_STALL_MS, ends the video: `broken` then says so, and
 * the next ask opens it afresh.
 */
export class SeekingVideo implements VideoSource {
  readonly holds = KEPT_PIECES * PIECE;
  private pieces = new Map<number, Uint8Array>();
  private loading = new Map<number, Promise<boolean>>();
  private lanes: Lane[] = [];
  /** Readers the player waits on, for a lane to come free. Reads ahead never wait. */
  private queue: Array<() => void> = [];
  /** The span the player read last: reads ahead follow it. */
  private wanted = 0;
  private closed = false;
  private failed: Error | null = null;
  /** When the player last read from it. */
  private readAt = Date.now();

  constructor(
    readonly size: number,
    readonly mime: string,
    stream: SeekableStream,
    onClose: () => void,
  ) {
    this.lanes.push({ stream, close: onClose, busy: false, leaving: false, first: true });
  }

  /**
   * One more stream to read on. Returns how to ask it to leave, or null if the video is
   * already closed or broken, in which case the stream is let go at once.
   */
  addLane(stream: SeekableStream, onClose: () => void): (() => void) | null {
    if (this.closed || this.failed) {
      onClose();
      return null;
    }
    const lane: Lane = { stream, close: onClose, busy: false, leaving: false, first: false };
    this.lanes.push(lane);
    this.freed();
    return () => {
      lane.leaving = true;
      if (!lane.busy) this.drop(lane);
    };
  }

  /** How many streams it reads on. */
  laneCount(): number {
    return this.lanes.length;
  }

  /** Closed, or broken: no lane is worth adding. */
  done(): boolean {
    return this.closed || this.failed !== null;
  }

  /** How long since the player last read from it (ms). */
  idleFor(now = Date.now()): number {
    return now - this.readAt;
  }

  /**
   * Lets every lane but the first go, each once its read is done: a video not being played
   * keeps no more than one slot.
   */
  shed(): void {
    for (const lane of [...this.lanes]) {
      if (lane.first) continue;
      lane.leaving = true;
      if (!lane.busy) this.drop(lane);
    }
  }

  /** Resolves once its first block is read, or that failed, or `signal` fired. */
  async started(signal: AbortSignal): Promise<void> {
    const left = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([this.load(0, true, signal).catch(() => {}), left]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pieces.clear();
    this.letGo();
  }

  broken(): boolean {
    return this.failed !== null;
  }

  private fail(e: Error): void {
    this.failed = e;
    diag.log("drive", "video_failed", { why: failure(e), lanes: this.lanes.length });
    this.letGo();
  }

  /** Every lane let go (each slot back), and every reader waiting for one woken. */
  private letGo(): void {
    for (const lane of this.lanes.splice(0)) lane.close();
    for (const wake of this.queue.splice(0)) wake();
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

  /** Piece `index`, from those kept or read now; null if the player gave up or it closed. */
  private async piece(index: number, gone: AbortSignal): Promise<Uint8Array | null> {
    const span = Math.floor((index * PIECE) / SPAN);
    this.wanted = span;
    this.readAt = Date.now();
    // A piece kept may still be thrown out by reads ahead, and a read ahead it waited on may
    // have failed on its lane: it is read again then. A read that never ran (the player that
    // asked for it first gave up waiting) is not a try: this one asks again itself.
    for (let tries = 0; tries < 3; ) {
      const kept = this.pieces.get(index);
      if (kept) {
        this.pieces.delete(index);
        this.pieces.set(index, kept);
        this.ahead();
        return kept;
      }
      if (this.closed || gone.aborted) return null;
      if (this.failed) throw this.failed;
      const leave = new Promise<"left">((resolve) => {
        if (gone.aborted) resolve("left");
        else gone.addEventListener("abort", () => resolve("left"), { once: true });
      });
      const loaded = this.load(span, true, gone);
      void loaded.catch(() => {});
      // The lanes left free read on from here meanwhile (at the start, and after a seek).
      this.ahead();
      const ended = loaded.then(
        (ran) => (ran ? "ran" : "skipped"),
        () => "ran" as const,
      );
      const outcome = await Promise.race([ended, leave]);
      if (outcome === "left") return null;
      if (outcome === "ran") tries++;
    }
    const kept = this.pieces.get(index);
    if (kept) return kept;
    if (this.failed) throw this.failed;
    return null;
  }

  /** Reads ahead of the player on the lanes that are free now. */
  private ahead(): void {
    for (let s = this.wanted + 1; s <= this.wanted + AHEAD; s++) {
      if (this.closed || this.failed || !this.lanes.some((l) => !l.busy && !l.leaving)) return;
      if (s * SPAN >= this.size || this.loading.has(s) || this.hasSpan(s)) continue;
      void this.load(s, false).catch(() => {});
    }
  }

  private hasSpan(span: number): boolean {
    const first = (span * SPAN) / PIECE;
    const last = Math.floor((Math.min(this.size, (span + 1) * SPAN) - 1) / PIECE);
    return this.pieces.has(first) && this.pieces.has(last);
  }

  /**
   * Span `span` read into the pieces kept, once however many ask for it. Resolves true once
   * the span was read, false if no read ran (no lane free, or the asker gave up waiting).
   */
  private load(span: number, wait: boolean, gone?: AbortSignal): Promise<boolean> {
    const known = this.loading.get(span);
    if (known) return known;
    const loading = this.readSpan(span, wait, gone).finally(() => {
      if (this.loading.get(span) === loading) this.loading.delete(span);
    });
    this.loading.set(span, loading);
    return loading;
  }

  private async readSpan(span: number, wait: boolean, gone?: AbortSignal): Promise<boolean> {
    const lane = await this.lane(wait, gone);
    if (!lane) return false;
    let aheadFailed = false;
    try {
      if (this.closed) return true;
      const from = span * SPAN;
      const length = Math.min(SPAN, this.size - from);
      if (length <= 0) throw new Error("video shorter than stated");
      let stall: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          (async () => {
            await lane.stream.seek(from);
            return (await lane.stream.read(length)).value;
          })(),
          new Promise<never>((_, reject) => {
            stall = setTimeout(() => reject(new Error("video read stalled")), READ_STALL_MS);
          }),
        ]);
        if (this.closed) return true;
        if (value.length < length) throw new Error("video shorter than stated");
        const first = from / PIECE;
        for (let i = 0; i * PIECE < value.length; i++) this.keep(first + i, value.subarray(i * PIECE, (i + 1) * PIECE));
        return true;
      } catch (e) {
        // A read ahead that failed on a lane added later costs only that lane (a stream the
        // SDK errored stays errored): the player's own read of the span tries again. On the
        // first lane it fails the video, as any other read does.
        if (!wait && !lane.first && !this.closed) {
          diag.log("drive", "video_lane_failed", { why: failure(e) });
          lane.leaving = true;
          aheadFailed = true;
          throw e;
        }
        // The stream is no use any more (failed, ended short, or hung): every lane goes, and
        // the next ask opens the video afresh. What was read is still served meanwhile.
        if (!this.failed && !this.closed) this.fail(e instanceof Error ? e : new Error("video read failed"));
        throw this.failed ?? e;
      } finally {
        clearTimeout(stall);
      }
    } finally {
      lane.busy = false;
      if (lane.leaving) this.drop(lane);
      // After a failed read ahead only a waiting player is woken, not more reads ahead.
      this.freed(!aheadFailed);
    }
  }

  /** A free lane, taken; for a read ahead (`wait` false) only if one is free now. */
  private async lane(wait: boolean, gone?: AbortSignal): Promise<Lane | null> {
    for (;;) {
      if (this.closed || this.failed || gone?.aborted) return null;
      const free = this.lanes.find((l) => !l.busy && !l.leaving);
      if (free) {
        free.busy = true;
        return free;
      }
      if (!wait) return null;
      // A player that gives up waiting (a drag of the slider asks for one place after
      // another) leaves the queue, rather than having a block read for it nobody wants.
      await new Promise<void>((resolve) => {
        const left = () => {
          const at = this.queue.indexOf(woken);
          if (at >= 0) this.queue.splice(at, 1);
          resolve();
        };
        const woken = () => {
          gone?.removeEventListener("abort", left);
          resolve();
        };
        this.queue.push(woken);
        gone?.addEventListener("abort", left, { once: true });
      });
    }
  }

  /** A lane came free (or was added): the player first, the newest ask first, then reads ahead. */
  private freed(readAhead = true): void {
    const next = this.queue.pop();
    if (next) next();
    else if (readAhead) this.ahead();
  }

  private drop(lane: Lane): void {
    const at = this.lanes.indexOf(lane);
    if (at < 0) return;
    this.lanes.splice(at, 1);
    lane.close();
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
 * A video played through the downloader's seekable stream (see `SeekingVideo`), or null
 * where it cannot be read that way (an old file, with no block sizes on record), in which
 * case the downloader's slot is given back.
 */
export function seekVideo(opened: OpenedDownloader, size: number, mime: string): SeekingVideo | null {
  let stream: SeekableStream;
  try {
    stream = opened.downloader.getSeekableStream();
  } catch {
    opened.unused();
    return null;
  }
  return new SeekingVideo(size, mime, stream, () => opened.stop());
}

/**
 * Opens a video too large to hold whole, to play a block at a time, and reads its first
 * block, so the answer's headers go out only for one that is coming. NOT_STREAMABLE for a
 * file that cannot be read that way; null when the first read failed or `signal` fired. The
 * slot is given back whenever no video is returned.
 */
export async function startSeeking(
  opened: OpenedDownloader,
  size: number,
  mime: string,
  signal: AbortSignal,
): Promise<SeekingVideo | typeof NOT_STREAMABLE | null> {
  const video = seekVideo(opened, size, mime);
  if (!video) return signal.aborted ? null : NOT_STREAMABLE;
  await video.started(signal);
  if (signal.aborted || video.broken()) {
    video.close();
    return null;
  }
  return video;
}

/** How many videos are kept open: the one playing and the one stepped back from. */
const OPEN_KEPT = 2;

/** A video nobody has read from, and with no answer open, for this long is closed. */
const IDLE_MS = 90_000;

type OpenEntry = { video: Promise<VideoSource | null>; used: number; reading: number; opened?: VideoSource };

/** The waits and the memory of the videos kept open (tests shorten them). */
export type OpenLimits = { startMs?: number; keptBytes?: number; refusedMs?: number };

/**
 * The videos opened lately, by uid. A player asks for many ranges of one video (the start,
 * the index at the end, then on as it plays and seeks): it is opened once for all of them.
 * One that falls out (more than OPEN_KEPT, more than MAX_STREAMED_VIDEO held together, idle
 * for IDLE_MS, or at lock) is closed: its download stops and its memory goes.
 */
export class OpenVideos {
  private open = new Map<string, OpenEntry>();
  /** Videos that can never be streamed, by uid, with when that is forgotten. */
  private refusals = new Map<string, number>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private startMs: number;
  private keptBytes: number;
  private refusedMs: number;

  constructor(
    private load: (uid: string, signal: AbortSignal) => Promise<VideoAnswer>,
    private now: () => number = Date.now,
    private idleMs = IDLE_MS,
    limits: OpenLimits = {},
  ) {
    this.startMs = limits.startMs ?? VIDEO_START_MS;
    this.keptBytes = limits.keptBytes ?? MAX_STREAMED_VIDEO;
    this.refusedMs = limits.refusedMs ?? NOT_STREAMABLE_MS;
  }

  get(uid: string): Promise<VideoAnswer> {
    let known = this.open.get(uid);
    // One found unplayable while open is let go and not opened again for a while.
    if (known?.opened?.refused?.()) {
      this.refuse(uid);
      known = undefined;
    }
    if (this.refused(uid)) return Promise.resolve(NOT_STREAMABLE);
    // One whose download failed is let go and opened afresh.
    if (known?.opened?.broken?.()) {
      this.drop(uid);
      known = undefined;
    }
    if (known) {
      this.open.delete(uid);
      known.used = this.now();
      this.open.set(uid, known);
      this.keepWithinBytes();
      return this.answer(uid, known);
    }
    const entry: OpenEntry = { video: Promise.resolve(null), used: this.now(), reading: 0 };
    entry.video = this.loadWithin(uid).then((v) => {
      if (v === NOT_STREAMABLE) {
        if (this.open.get(uid) === entry) this.refuse(uid);
        return null;
      }
      entry.opened = v ?? undefined;
      return v ? this.keptInUse(v, entry) : null;
    });
    this.open.set(uid, entry);
    // A video that could not be opened is not kept: the next ask tries again.
    void entry.video.then((v) => {
      if (!v && this.open.get(uid) === entry) this.open.delete(uid);
      if (v) this.keepWithinBytes();
    });
    while (this.open.size > OPEN_KEPT) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.startSweep();
    return this.answer(uid, entry);
  }

  /**
   * True for a video that can never be streamed, refused lately or found unplayable while
   * open: the viewer asks, after a stream fails, whether to try it again or play it the
   * older way at once.
   */
  notStreamable(uid: string): boolean {
    return this.refused(uid) || !!this.open.get(uid)?.opened?.refused?.();
  }

  private answer(uid: string, entry: OpenEntry): Promise<VideoAnswer> {
    return entry.video.then((v) => v ?? (this.refused(uid) ? NOT_STREAMABLE : null));
  }

  /**
   * The video for `uid`, or null when its lookup and first bytes are not in within startMs:
   * the wait is given up (which stops the lookup, or gives back a download slot it waits
   * for) and the answer goes out as an error, so the viewer is not left without one.
   */
  private loadWithin(uid: string): Promise<VideoAnswer> {
    const stop = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        stop.abort();
        diag.log("drive", "video_slow_start", { ms: this.startMs });
        resolve(null);
      }, this.startMs);
      timer.unref?.();
      this.load(uid, stop.signal).then(
        (v) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(v);
          } else if (v && v !== NOT_STREAMABLE) {
            // In after the wait was given up: nobody is waiting for it.
            v.close?.();
          }
        },
        () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      );
    });
  }

  /**
   * Every piece written out counts as use, and so does an answer still open: a paused
   * player keeps its connection and reads nothing, and closing its video then would have it
   * downloaded again from the start when play resumes.
   */
  private keptInUse(v: VideoSource, entry: OpenEntry): VideoSource {
    const now = this.now;
    const settle = () => this.keepWithinBytes();
    return {
      size: v.size,
      mime: v.mime,
      close: () => v.close?.(),
      broken: () => v.broken?.() ?? false,
      refused: () => v.refused?.() ?? false,
      holds: v.holds,
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
          settle();
        }
      },
    };
  }

  /**
   * Keeps the videos open within keptBytes together, each counted at its full size, which
   * its download reaches soon enough (or at the most it holds, for one read a block at a
   * time): the oldest go first, never the one asked for last (the one playing) nor one
   * still being read.
   */
  private keepWithinBytes(): void {
    const entries = [...this.open];
    const newest = entries[entries.length - 1]?.[0];
    const held = (v: VideoSource | undefined) => (v ? Math.min(v.size, v.holds ?? v.size) : 0);
    let total = 0;
    for (const [, e] of entries) total += held(e.opened);
    for (const [uid, e] of entries) {
      if (total <= this.keptBytes) break;
      if (uid === newest || e.reading > 0 || !e.opened) continue;
      total -= held(e.opened);
      this.drop(uid);
    }
  }

  /** Closes videos left idle. Called on a timer; public for tests. */
  closeIdle(): void {
    const now = this.now();
    for (const [uid, entry] of [...this.open]) {
      if (entry.reading === 0 && now - entry.used >= this.idleMs) this.drop(uid);
    }
    if (this.open.size === 0) this.stopSweep();
  }

  /** Close every video and forget every refusal: at lock and sign-out. */
  clear(): void {
    for (const uid of [...this.open.keys()]) this.drop(uid);
    this.refusals.clear();
    this.stopSweep();
  }

  /** How many videos are open (for tests). */
  size(): number {
    return this.open.size;
  }

  private refused(uid: string): boolean {
    const until = this.refusals.get(uid);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.refusals.delete(uid);
    return false;
  }

  /** Remembers `uid` as never streamable for refusedMs, and lets go of it if open. */
  private refuse(uid: string): void {
    const now = this.now();
    for (const [old, until] of this.refusals) if (now >= until) this.refusals.delete(old);
    this.refusals.set(uid, now + this.refusedMs);
    this.drop(uid);
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
