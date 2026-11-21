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

// Changing the capture date of photos already on Drive, the way the Android app does it.
//
// Drive keeps a photo's date in the revision it was uploaded with and allows no second
// revision, so a date is changed by a corrected copy: the original is downloaded, the new
// date is written into the file's own metadata (`embedDate.ts`, never touching the picture),
// the copy is uploaded with that date, its tags and the original's other metadata, and it
// joins every album the original was in. What this computer keeps by the photo (hidden,
// labels, faces, the search index, kept offline, an album cover) moves to the copy. The
// original goes to the Drive trash last, and only once all of that is confirmed: a step
// that fails leaves both, never a photo dropped from an album.
//
// The queue is kept on disk with each photo's stage and its copy, so a restart carries on
// where it stopped without a second upload. One photo at a time: an original is held whole
// in memory while its copy is made.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { webcrypto } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { ThumbnailType } from "@protontech/drive-sdk";

import { openDownloader } from "./downloadSlots.ts";
import { embedCaptureDate } from "./embedDate.ts";
import { dateFromName } from "./nameDate.ts";
import { activeRevisionOf, nodeName, toMillis } from "./nodes.ts";
import { SDK_STALL_MS, StallError, isStall, withStallGuard } from "./stallGuard.ts";
import { readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** One photo and the capture time it should have. */
export type DateEditItem = { uid: string; captureMs: number };

/** How far a photo got: its copy uploaded, in its albums, and what this computer keeps moved. */
type Stage = "queued" | "uploaded" | "joined" | "carried";

type QueueEntry = DateEditItem & { stage: Stage; newUid?: string; albums?: string[]; tags?: number[] };

export type DateEditStatus = {
  running: boolean;
  total: number;
  done: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** The photos that could not be changed and why, newest last. */
  errors: { uid: string; error: string }[];
  cancelled: boolean;
};

/** What the date editor shows of a photo before anything is changed. */
export type DateEditInfo = {
  uid: string;
  name: string;
  captureMs: number;
  /** The date its file name records, or null. */
  nameMs: number | null;
  /** Why it cannot be changed, or null when it can. */
  blocked: "live" | "type" | "read" | null;
};

/** What the session does for the queue: the Drive actions that touch this computer's own data too. */
export type DateEditDeps = {
  photos: any;
  addToAlbum: (albumUid: string, uids: string[]) => Promise<{ uid: string; ok: boolean }[]>;
  trash: (uids: string[]) => Promise<{ uid: string; ok: boolean; error?: string }[]>;
  /** Moves what this computer keeps by `oldUid` (hidden, labels, faces, search, offline, covers) to `newUid`. */
  carry: (oldUid: string, newUid: string) => Promise<void>;
  /** How long a step may show no sign of life before it is given up on; the SDK's stall time unless a test says. */
  stallMs?: number;
};

/** A one-photo album add, trash or carry may wait behind other work, so it gets a few stall times. */
const MUTATION_STALLS = 3;

/** Steps given up on one after another before the run pauses, keeping the rest of the queue on disk. */
const STALLS_BEFORE_PAUSE = 3;

/**
 * `work`, given up on once it shows no sign of life for `idleMs`. `work` calls `touch` as it makes
 * progress (bytes moved), which starts the wait afresh; on giving up, `abort` stops it and a
 * `StallError` is thrown. A run over 2000 photos is one photo after another, so a single step that
 * never answered used to hold all the rest, with the panel showing the same count for good.
 */
export async function untilIdle<T>(what: string, idleMs: number, work: (touch: () => void) => Promise<T>, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let fail: (e: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const arm = () => {
    if (settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        abort?.();
      } catch {
        /* stopping is best-effort; the step is let go of either way */
      }
      fail(new StallError(what, idleMs));
    }, idleMs);
  };
  arm();
  const run = Promise.resolve().then(() => work(arm));
  run.catch(() => {}); // abandoned when the stall wins
  try {
    return await Promise.race([run, stalled]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

const QUEUE_FILE = "date-edit.enc";

/** Two times count as the same capture when they are within this of each other. */
const SAME_MS = 1000;

/** The file types whose own metadata can carry a new date (see `embedDate.ts`). */
const EMBEDDABLE = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/3gpp",
]);

export function sameCapture(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) < SAME_MS;
}

export function isLivePhoto(node: any): boolean {
  return !!node?.photo?.mainPhotoNodeUid || (node?.photo?.relatedPhotoNodeUids ?? []).length > 0;
}

export function canCarryDate(mediaType: string | null | undefined): boolean {
  return EMBEDDABLE.has(String(mediaType ?? "").toLowerCase().split(";")[0].trim());
}

/** The albums a node lists itself in. */
export function albumUidsOf(node: any): string[] {
  return [...new Set(((node?.photo?.albums ?? []) as any[]).map((a) => String(a?.nodeUid ?? "")).filter(Boolean))];
}

/** The tags `want` lists that `node` does not carry. */
export function missingTags(node: any, want: number[]): number[] {
  const has = new Set((node?.photo?.tags ?? []) as number[]);
  return want.filter((tag) => !has.has(tag));
}

/**
 * `ms` as the ISO string a camera would claim: its wall clock in this machine's zone, with that
 * zone's offset, the form Proton's clients read a claimed capture time in.
 */
export function claimedCaptureString(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/**
 * The original's claimed metadata with its camera capture time set to the new one: Proton's web
 * shows a photo's date from this claim before the plain capture time.
 */
export function withClaimedCaptureTime(claimed: any, captureMs: number): Record<string, unknown> {
  const base = claimed && typeof claimed === "object" ? claimed : {};
  const camera = base.Camera && typeof base.Camera === "object" ? base.Camera : {};
  return { ...base, Camera: { ...camera, CaptureTime: claimedCaptureString(captureMs) } };
}

/** Reads a node from Drive again rather than from the SDK's cache, which a write made here leaves stale. */
async function freshNode(photos: any, uid: string, idleMs = SDK_STALL_MS): Promise<any> {
  return untilIdle("getNode(dateEdit)", idleMs, async () => {
    const access = photos?.nodes?.access;
    if (typeof access?.notifyNodeChanged === "function") {
      try {
        await access.notifyNodeChanged(uid);
      } catch {
        /* the read below still answers, perhaps from the cache */
      }
    }
    return photos.getNode(uid);
  });
}

/** The original's bytes, given up on (and the download stopped) when no bytes arrive for `idleMs`. */
async function downloadOriginal(photos: any, uid: string, idleMs: number): Promise<Buffer> {
  const opened = await openDownloader(photos, uid);
  const chunks: Uint8Array[] = [];
  return untilIdle(
    "download(dateEdit)",
    idleMs,
    async (touch) => {
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
          touch();
        },
      });
      await opened.downloader.downloadToStream(stream as any, touch).completion();
      return Buffer.concat(chunks);
    },
    () => opened.stop.abort(),
  );
}

/** The thumbnails the original carries, so the copy shows the same pictures. Best-effort. */
async function storedThumbnails(photos: any, uid: string): Promise<any[]> {
  const out: any[] = [];
  try {
    for (const type of [ThumbnailType.Type1, ThumbnailType.Type2]) {
      for await (const r of withStallGuard(photos.iterateThumbnails([uid], type), SDK_STALL_MS, "iterateThumbnails")) {
        const result = r as any;
        if (result.ok) out.push({ type, thumbnail: result.thumbnail });
      }
    }
  } catch {
    /* uploaded without the one that failed; Drive makes its own */
  }
  return out;
}

/** Nodes read per `iterateNodes` call by the date editor's listing. */
const INFO_BATCH = 200;

/** One photo's row in the editor, from its node. */
function infoOf(uid: string, node: any): DateEditInfo {
  const name = nodeName(node);
  return {
    uid,
    name,
    captureMs: toMillis(node?.photo?.captureTime),
    nameMs: name ? dateFromName(name) : null,
    blocked: isLivePhoto(node) ? "live" : canCarryDate(node?.mediaType) ? null : "type",
  };
}

const unread = (uid: string): DateEditInfo => ({ uid, name: "", captureMs: 0, nameMs: null, blocked: "read" });

/**
 * What the editor shows of each photo: its name, date, the date its name records, and whether it can change.
 *
 * Read a few hundred nodes at a time through `iterateNodes`, as the map and the downloads do. One
 * `getNode` after another took minutes over a Fix dates selection of a couple of thousand photos, and one
 * that never answered held the panel on "Reading the photos" for good. A batch that stalls or fails
 * leaves only its unread photos to `getNode`, each under the same stall guard; a photo still unread is
 * shown as one that could not be read rather than holding up the rest.
 */
export async function dateEditInfo(photos: any, uids: string[]): Promise<DateEditInfo[]> {
  const found = new Map<string, DateEditInfo>();
  // Once one read alone has stalled the SDK is not answering: the rest are not waited out one by one.
  let wedged = false;
  for (let at = 0; at < uids.length; at += INFO_BATCH) {
    const batch = uids.slice(at, at + INFO_BATCH);
    try {
      for await (const node of withStallGuard(photos.iterateNodes(batch), SDK_STALL_MS, "iterateNodes(dateEdit)")) {
        const n = node as any;
        if (n?.missingUid) found.set(n.missingUid, unread(n.missingUid));
        else if (n?.uid) found.set(n.uid, infoOf(n.uid, n));
      }
    } catch (e) {
      process.stderr.write(`[dateedit] a batch of ${batch.length} could not be read together: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    for (const uid of batch) {
      if (found.has(uid)) continue;
      if (wedged) {
        found.set(uid, unread(uid));
        continue;
      }
      try {
        const node = await oneNode(photos, uid);
        found.set(uid, node ? infoOf(uid, node) : unread(uid));
      } catch (e) {
        if (e instanceof StallError) wedged = true;
        found.set(uid, unread(uid));
      }
    }
  }
  return uids.map((uid) => found.get(uid) ?? unread(uid));
}

/** `photos.getNode`, given up on after the SDK's stall time. */
async function oneNode(photos: any, uid: string): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StallError("getNode(dateEdit)", SDK_STALL_MS)), SDK_STALL_MS);
  });
  const read = Promise.resolve(photos.getNode(uid));
  read.catch(() => {}); // abandoned when the stall wins
  try {
    return await Promise.race([read, stall]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One photo, from the stage it reached. Answers "unchanged" when Drive already shows its date.
 * Throws with the reason a step failed; the original is then still in place.
 */
export async function replaceOne(deps: DateEditDeps, e: QueueEntry, save: () => void): Promise<"changed" | "unchanged"> {
  const { photos } = deps;
  const idleMs = deps.stallMs ?? SDK_STALL_MS;
  const mutation = <T>(what: string, work: () => Promise<T>) => untilIdle(what, idleMs * MUTATION_STALLS, work);
  if (e.stage === "queued") {
    // Read from Drive, not the SDK's cache: a favourite or an album another device gave the photo since this
    // app last read it must ride along to the copy, or trashing the original loses it.
    const node = await freshNode(photos, e.uid, idleMs);
    if (isLivePhoto(node)) throw new Error("A Live Photo's picture and video are dated together, so neither is changed alone");
    if (sameCapture(toMillis(node?.photo?.captureTime), e.captureMs)) return "unchanged";
    const name = nodeName(node);
    const mediaType = node?.mediaType;
    if (!name || !mediaType) throw new Error("The photo could not be read");
    if (!canCarryDate(mediaType)) throw new Error("This file type cannot carry a new date");

    const revision = activeRevisionOf(node);
    const original = await downloadOriginal(photos, e.uid, idleMs);
    const embedded = embedCaptureDate(original, e.captureMs);
    if (!embedded) throw new Error("This file type cannot carry a new date");
    const bytes = embedded.bytes;
    const digestInput = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    const sha1 = Buffer.from(await webcrypto.subtle.digest("SHA-1", digestInput)).toString("hex");
    const modified = toMillis(revision?.claimedModificationTime);
    const tags = ((node?.photo?.tags ?? []) as number[]).slice();
    const thumbnails = await storedThumbnails(photos, e.uid);
    // Stopped through the uploader's signal when it shows no progress for a stall time, so a copy
    // given up on is not finished later behind the run's back.
    const stopUpload = new AbortController();
    const uploader: any = await untilIdle(
      "getFileUploader(dateEdit)",
      idleMs,
      () =>
        photos.getFileUploader(
          name,
          {
            mediaType,
            expectedSize: bytes.byteLength,
            expectedSha1: sha1,
            ...(modified > 0 ? { modificationTime: new Date(modified) } : {}),
            captureTime: new Date(e.captureMs),
            tags,
            additionalMetadata: withClaimedCaptureTime(revision?.claimedAdditionalMetadata, e.captureMs),
          },
          stopUpload.signal,
        ),
      () => stopUpload.abort(),
    );
    const stream = Readable.toWeb(Readable.from(bytes)) as any;
    const { nodeUid } = await untilIdle(
      "upload(dateEdit)",
      idleMs,
      async (touch) => (await uploader.uploadFromStream(stream, thumbnails, touch)).completion(),
      () => stopUpload.abort(),
    );
    if (!nodeUid || nodeUid === e.uid) throw new Error("Drive did not keep a new copy");
    e.newUid = nodeUid;
    e.albums = albumUidsOf(node);
    e.tags = tags;
    e.stage = "uploaded";
    save();
    process.stderr.write(`[dateedit] uploaded a corrected copy (${embedded.how})\n`);
  }

  const newUid = e.newUid!;
  if (e.stage === "uploaded") {
    const copy = await freshNode(photos, newUid, idleMs);
    if (!sameCapture(toMillis(copy?.photo?.captureTime), e.captureMs)) {
      throw new Error("The new copy did not get the new date; the original is kept");
    }
    const lacking = missingTags(copy, e.tags ?? []);
    if (lacking.length > 0) {
      for await (const r of withStallGuard(photos.updatePhotos([{ nodeUid: newUid, tagsToAdd: lacking, tagsToRemove: [] }]), SDK_STALL_MS, "updatePhotos")) {
        if (!(r as any).ok) throw new Error("The new copy could not be marked as the original was; the original is kept");
      }
    }
    const albums = e.albums ?? [];
    const joined = new Set(albumUidsOf(copy));
    for (const album of albums) {
      if (joined.has(album)) continue;
      const results = await mutation("addToAlbum(dateEdit)", () => deps.addToAlbum(album, [newUid]));
      if (!results.some((r) => r.ok)) {
        const why = (results.find((r) => !r.ok) as { error?: string } | undefined)?.error ?? "no answer";
        process.stderr.write(`[dateedit] album add refused: ${why}\n`);
        throw new Error("The new copy could not be added to one of its albums; the original is kept");
      }
    }
    if (albums.length > 0) {
      const check = albumUidsOf(await freshNode(photos, newUid, idleMs));
      if (!albums.every((a) => check.includes(a))) throw new Error("The new copy is not in every album yet; the original is kept");
    }
    e.stage = "joined";
    save();
  }

  if (e.stage === "joined") {
    await mutation("carry(dateEdit)", () => deps.carry(e.uid, newUid));
    e.stage = "carried";
    save();
  }

  const [trashed] = await mutation("trash(dateEdit)", () => deps.trash([e.uid]));
  if (!trashed?.ok) throw new Error("The original could not be moved to the trash; both are kept");
  return "changed";
}

/** The queue as saved: what is left to do, each photo with the stage it reached. */
function readQueue(): QueueEntry[] {
  const raw = readSealedOrDiscard(join(storeDir(), QUEUE_FILE));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { v: 1; items: QueueEntry[] };
    return Array.isArray(parsed?.items) ? parsed.items.filter((i) => typeof i?.uid === "string" && i.captureMs > 0) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueEntry[]): void {
  const path = join(storeDir(), QUEUE_FILE);
  if (items.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(storeDir(), { recursive: true });
  writeSealedAtomic(path, Buffer.from(JSON.stringify({ v: 1, items }), "utf8"));
}

const idle = (): DateEditStatus => ({ running: false, total: 0, done: 0, changed: 0, unchanged: 0, failed: 0, errors: [], cancelled: false });

/** Runs the date changes one photo after another, kept on disk until each is through. */
export class DateEditor {
  private status: DateEditStatus = idle();
  private queue: QueueEntry[] = [];
  private running: Promise<void> | null = null;
  private cancel = false;
  private deps: DateEditDeps | null = null;

  /** Signed in: picks up a queue a restart cut short. */
  attach(deps: DateEditDeps): void {
    this.deps = deps;
    const saved = readQueue();
    if (saved.length === 0) return;
    this.queue = saved;
    this.status = { ...idle(), total: saved.length };
    this.kick();
  }

  /** Signed out or locked: stops after the current photo, keeping the queue on disk. */
  detach(): void {
    this.cancel = true;
    this.deps = null;
  }

  getStatus(): DateEditStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /** Adds photos to change; one already waiting takes the newer date. */
  start(items: DateEditItem[]): DateEditStatus {
    const fresh = items.filter((i) => typeof i?.uid === "string" && Number.isFinite(i.captureMs) && i.captureMs > 0);
    if (fresh.length === 0) return this.getStatus();
    // Photos a paused run left on disk carry on with these, and count in the new run.
    if (!this.running) this.status = { ...idle(), total: this.queue.length };
    for (const item of fresh) {
      const waiting = this.queue.find((q) => q.uid === item.uid);
      if (waiting && waiting.stage === "queued") waiting.captureMs = item.captureMs;
      else if (!waiting) {
        this.queue.push({ uid: item.uid, captureMs: item.captureMs, stage: "queued" });
        this.status.total++;
      }
    }
    writeQueue(this.queue);
    this.kick();
    return this.getStatus();
  }

  /** Stops after the photo in hand; the ones not started are dropped. A photo already uploaded is finished first. */
  stop(): DateEditStatus {
    if (!this.running) return this.getStatus();
    this.cancel = true;
    return this.getStatus();
  }

  private kick(): void {
    if (this.running || !this.deps) return;
    this.cancel = false;
    this.status.running = true;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.status.running = false;
    });
  }

  private async drain(): Promise<void> {
    let stalls = 0;
    while (this.queue.length > 0) {
      const deps = this.deps;
      if (!deps) return;
      const entry = this.queue[0];
      if (this.cancel && entry.stage === "queued") {
        this.status.cancelled = true;
        this.queue = this.queue.filter((q) => q.stage !== "queued");
        writeQueue(this.queue);
        continue;
      }
      try {
        const outcome = await replaceOne(deps, entry, () => writeQueue(this.queue));
        if (outcome === "changed") this.status.changed++;
        else this.status.unchanged++;
        stalls = 0;
      } catch (e) {
        this.status.failed++;
        this.status.errors.push({ uid: entry.uid, error: (e as Error)?.message ?? String(e) });
        process.stderr.write(`[dateedit] a photo was not changed: ${(e as Error)?.message ?? e}\n`);
        await this.dropCopy(deps, entry);
        stalls = isStall(e) ? stalls + 1 : 0;
      }
      this.status.done++;
      this.queue.shift();
      writeQueue(this.queue);
      if (stalls >= STALLS_BEFORE_PAUSE && this.queue.length > 0) {
        // Drive is not answering: the rest would each wait out a stall time. They stay on disk and
        // carry on at the next sign-in or the next date change started.
        const left = this.queue.length;
        this.status.errors.push({
          uid: "paused",
          error: `Drive stopped answering, so the run paused; the ${left} photos left are kept and carry on with the next date change or sign-in`,
        });
        process.stderr.write(`[dateedit] paused after ${stalls} stalls in a row, ${left} left\n`);
        this.status.total -= left;
        return;
      }
    }
  }

  /**
   * A photo given up on after its copy was sent but before anything this computer keeps moved to it:
   * the copy is trashed, so the library is not left with the photo twice. Once carried, both are kept.
   */
  private async dropCopy(deps: DateEditDeps, entry: QueueEntry): Promise<void> {
    if (!entry.newUid || (entry.stage !== "uploaded" && entry.stage !== "joined")) return;
    try {
      const idleMs = (deps.stallMs ?? SDK_STALL_MS) * MUTATION_STALLS;
      const [r] = await untilIdle("trash copy(dateEdit)", idleMs, () => deps.trash([entry.newUid!]));
      process.stderr.write(`[dateedit] the unfinished copy was ${r?.ok ? "trashed" : "not trashed"}\n`);
    } catch (e) {
      process.stderr.write(`[dateedit] the unfinished copy could not be trashed: ${(e as Error)?.message ?? e}\n`);
    }
  }
}

export const dateEditor = new DateEditor();
