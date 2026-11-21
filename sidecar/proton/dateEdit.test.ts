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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { canCarryDate, dateEditInfo, DateEditor, missingTags, replaceOne, sameCapture, untilIdle, type DateEditDeps } from "./dateEdit.ts";
import { initStore, setDataKey } from "./store.ts";
import { emptyLabels, rekeyLabels, setLabels } from "./labelStore.ts";
import { HiddenStore } from "./hidden.ts";
import { emptyPeople, type PeopleState } from "./faceStore.ts";
import { curationKey, rekeyPeople } from "./facePeople.ts";

const OLD = "vol~old";
const NEW = "vol~new";
const WANT = Date.UTC(2021, 5, 4, 10, 30, 0);
const BEFORE = Date.UTC(2024, 0, 1, 12, 0, 0);

let jpeg: Buffer;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).jpeg().toBuffer();
});

type Fake = {
  photos: any;
  uploads: number;
  calls: string[];
  nodes: Map<string, any>;
};

/** A Drive that keeps nodes in a map, and a session around it that writes down what it was asked. */
function fake(opts: { albums?: string[]; tags?: number[]; live?: boolean; keepsDate?: boolean; joinFails?: boolean } = {}) {
  const f: Fake = { photos: null, uploads: 0, calls: [], nodes: new Map() };
  f.nodes.set(OLD, {
    uid: OLD,
    name: { ok: true, value: "IMG_1.jpg" },
    mediaType: "image/jpeg",
    activeRevision: { ok: true, value: { claimedAdditionalMetadata: { Camera: { Model: "x" } } } },
    photo: {
      captureTime: new Date(BEFORE),
      tags: opts.tags ?? [],
      albums: (opts.albums ?? []).map((nodeUid) => ({ nodeUid })),
      relatedPhotoNodeUids: opts.live ? ["vol~video"] : [],
    },
  });
  f.photos = {
    getNode: async (uid: string) => f.nodes.get(uid),
    nodes: { access: { notifyNodeChanged: async () => {} } },
    getFileDownloader: async () => ({
      downloadToStream: (stream: WritableStream<Uint8Array>) => ({
        completion: async () => {
          const w = stream.getWriter();
          await w.write(new Uint8Array(jpeg));
          await w.close();
        },
      }),
    }),
    iterateThumbnails: async function* () {},
    getFileUploader: async (_name: string, meta: any) => {
      f.uploads++;
      f.calls.push("upload");
      return {
        uploadFromStream: async () => ({
          completion: async () => {
            f.nodes.set(NEW, {
              uid: NEW,
              photo: {
                captureTime: opts.keepsDate ? new Date(BEFORE) : meta.captureTime,
                tags: [],
                albums: [],
                relatedPhotoNodeUids: [],
              },
            });
            return { nodeUid: NEW };
          },
        }),
      };
    },
    updatePhotos: async function* (updates: any[]) {
      f.calls.push(`tags:${updates[0].tagsToAdd.join(",")}`);
      f.nodes.get(NEW).photo.tags.push(...updates[0].tagsToAdd);
      yield { ok: true, uid: NEW };
    },
  };
  const deps: DateEditDeps = {
    photos: f.photos,
    addToAlbum: async (album, uids) => {
      f.calls.push(`album:${album}`);
      if (opts.joinFails) return uids.map((uid) => ({ uid, ok: false }));
      f.nodes.get(NEW).photo.albums.push({ nodeUid: album });
      return uids.map((uid) => ({ uid, ok: true }));
    },
    trash: async (uids) => {
      f.calls.push(`trash:${uids.join(",")}`);
      return uids.map((uid) => ({ uid, ok: true }));
    },
    carry: async (from, to) => {
      f.calls.push(`carry:${from}>${to}`);
    },
  };
  return { f, deps };
}

describe("changing a Drive photo's date", () => {
  it("carries a favourite another device gave the photo after this app cached it", async () => {
    const { f, deps } = fake({ tags: [] });
    // The SDK's cached copy predates the favourite; only a re-read after notifyNodeChanged sees it.
    let notified = false;
    const cached = f.nodes.get(OLD);
    const current = { ...cached, photo: { ...cached.photo, tags: [0] } };
    f.photos.nodes.access.notifyNodeChanged = async (uid: string) => {
      if (uid === OLD) notified = true;
    };
    f.photos.getNode = async (uid: string) => (uid === OLD ? (notified ? current : cached) : f.nodes.get(uid));
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.calls).toContain("tags:0");
  });

  it("replaces it with a copy in every album, its tags and data carried, and trashes the original last", async () => {
    const { f, deps } = fake({ albums: ["vol~a1", "vol~a2"], tags: [0] });
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.calls).toEqual(["upload", "tags:0", "album:vol~a1", "album:vol~a2", `carry:${OLD}>${NEW}`, `trash:${OLD}`]);
    expect(f.nodes.get(NEW).photo.captureTime.getTime()).toBe(WANT);
  });

  it("leaves a photo that already shows the date alone", async () => {
    const { f, deps } = fake();
    f.nodes.get(OLD).photo.captureTime = new Date(WANT + 400);
    expect(await replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).toBe("unchanged");
    expect(f.calls).toEqual([]);
  });

  it("keeps the original when the copy cannot join one of its albums", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"], joinFails: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/album/);
    expect(f.calls.some((c) => c.startsWith("trash"))).toBe(false);
    expect(f.calls.some((c) => c.startsWith("carry"))).toBe(false);
  });

  it("keeps the original when Drive did not take the new date", async () => {
    const { f, deps } = fake({ keepsDate: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/date/);
    expect(f.calls).toEqual(["upload"]);
  });

  it("carries on after a restart without a second upload", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    const saves: string[] = [];
    // The first run stops right after the upload was recorded.
    await expect(
      replaceOne(deps, entry, () => {
        saves.push(entry.stage);
        if (entry.stage === "uploaded") throw new Error("stopped");
      }),
    ).rejects.toThrow("stopped");
    expect(entry).toMatchObject({ stage: "uploaded", newUid: NEW, albums: ["vol~a1"] });
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.uploads).toBe(1);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("never changes one half of a Live Photo", async () => {
    const { f, deps } = fake({ live: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/Live Photo/);
    expect(f.uploads).toBe(0);
  });

  it("knows what counts as the same date, which tags are missing and which files can carry a date", () => {
    expect(sameCapture(WANT, WANT + 999)).toBe(true);
    expect(sameCapture(WANT, WANT + 60_000)).toBe(false);
    expect(missingTags({ photo: { tags: [3] } }, [0, 3])).toEqual([0]);
    expect(canCarryDate("image/jpeg")).toBe(true);
    expect(canCarryDate("video/quicktime")).toBe(true);
    expect(canCarryDate("image/webp")).toBe(false);
  });
});

describe("what this computer keeps by a photo, moved to its copy", () => {
  it("moves the labels, leaving the old link an empty, newer entry", () => {
    const state = emptyLabels();
    setLabels(state, "old", ["Trip"], 1);
    expect(rekeyLabels(state, "old", "new", 5)).toBe(true);
    expect(state.photos.new.l).toEqual(["Trip"]);
    expect(state.photos.old).toEqual({ l: [], t: 5 });
    expect(rekeyLabels(state, "old", "new", 6)).toBe(false);
  });

  it("hides the copy of a hidden photo and lists it in its hidden albums", () => {
    const store = new HiddenStore(false);
    store.set("photos", [OLD], true, 1);
    store.set("albums", ["vol~album"], true, 1, new Map([["vol~album", [OLD]]]));
    expect(store.rekeyPhoto(OLD, NEW, 2)).toBe(true);
    const hidden = store.hiddenPhotoTest();
    expect(hidden(NEW)).toBe(true);
    expect(store.rekeyPhoto(OLD, NEW, 3)).toBe(false);
  });

  it("points the people's choices about the faces at the copy", () => {
    const p: PeopleState = emptyPeople();
    p.assign[`${OLD}#0`] = "p1";
    p.confirmed[`${OLD}#0`] = "Anna";
    p.blocked[`${OLD}#1`] = ["Bob"];
    p.rejected = [`${OLD}#2`, "vol~other#0"];
    p.covers.Anna = OLD;
    p.curation[curationKey(2, "Bob", "old#1")] = { kind: 2, name: "Bob", ref: "old#1", removed: false, at: 1 };
    p.curation[curationKey(1, "Anna", "old")] = { kind: 1, name: "Anna", ref: "old", removed: false, at: 1 };
    const ids = new Map([0, 1, 2].map((i) => [`${OLD}#${i}`, `${NEW}#${i}`]));
    rekeyPeople(p, OLD, NEW, ids);
    expect(p.assign).toEqual({ [`${NEW}#0`]: "p1" });
    expect(p.confirmed).toEqual({ [`${NEW}#0`]: "Anna" });
    expect(p.blocked).toEqual({ [`${NEW}#1`]: ["Bob"] });
    expect(p.rejected).toEqual([`${NEW}#2`, "vol~other#0"]);
    expect(p.covers.Anna).toBe(NEW);
    expect(Object.values(p.curation).map((c) => c.ref).sort()).toEqual(["new", "new#1"]);
    expect(p.curation[curationKey(2, "Bob", "new#1")]).toBeDefined();
  });
});

describe("dateEditInfo", () => {
  const node = (uid: string, name: string, ms: number) => ({
    uid,
    name: { ok: true, value: name },
    mediaType: "image/jpeg",
    photo: { captureTime: new Date(ms), relatedPhotoNodeUids: [] },
  });

  it("reads a big selection in a few batches, not one node at a time, in the order asked", async () => {
    const uids = Array.from({ length: 450 }, (_, i) => `vol~${i}`);
    const batches: number[] = [];
    let singles = 0;
    const photos = {
      iterateNodes: async function* (asked: string[]) {
        batches.push(asked.length);
        for (const uid of [...asked].reverse()) yield node(uid, `IMG_${uid}.jpg`, 1_600_000_000_000);
      },
      getNode: async () => {
        singles++;
        return null;
      },
    };
    const out = await dateEditInfo(photos, uids);
    expect(batches).toEqual([200, 200, 50]);
    expect(singles).toBe(0);
    expect(out.map((i) => i.uid)).toEqual(uids);
    expect(out[0]).toMatchObject({ name: "IMG_vol~0.jpg", captureMs: 1_600_000_000_000, blocked: null });
  });

  it("marks a vanished photo unreadable, and reads alone what a failed batch left", async () => {
    const photos = {
      iterateNodes: async function* (asked: string[]) {
        yield { missingUid: asked[0] };
        yield node(asked[1], "b.jpg", 1);
        throw new Error("network");
      },
      getNode: async (uid: string) => node(uid, "c.jpg", 2),
    };
    const out = await dateEditInfo(photos, ["vol~a", "vol~b", "vol~c"]);
    expect(out.map((i) => [i.uid, i.name, i.blocked])).toEqual([
      ["vol~a", "", "read"],
      ["vol~b", "b.jpg", null],
      ["vol~c", "c.jpg", null],
    ]);
  });
});

describe("a step that never answers", () => {
  const never = () => new Promise<never>(() => {});

  it("gives up on an upload that sends nothing, and stops it through the uploader's signal", async () => {
    const { f, deps } = fake();
    let signal: AbortSignal | undefined;
    f.photos.getFileUploader = async (_n: string, _m: any, s: AbortSignal) => {
      signal = s;
      return { uploadFromStream: async () => ({ completion: never }) };
    };
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    await expect(replaceOne({ ...deps, stallMs: 30 }, entry, () => {})).rejects.toThrow(/upload\(dateEdit\)/);
    expect(signal?.aborted).toBe(true);
    expect(entry.stage).toBe("queued");
  });

  it("gives up on a download that stops sending", async () => {
    const { f, deps } = fake();
    f.photos.getFileDownloader = async () => ({ downloadToStream: () => ({ completion: never }) });
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    await expect(replaceOne({ ...deps, stallMs: 30 }, entry, () => {})).rejects.toThrow(/download\(dateEdit\)/);
  });

  it("waits as long as the work keeps showing progress", async () => {
    const out = await untilIdle("slow", 40, async (touch) => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 25));
        touch();
      }
      return "done";
    });
    expect(out).toBe("done");
  });
});

describe("the date run", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-dateedit-")));
    setDataKey(randomBytes(32));
  });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("pauses after a few stalls in a row, keeping the rest for the next run instead of waiting each out", async () => {
    const { f, deps } = fake();
    f.photos.getNode = () => new Promise(() => {});
    const editor = new DateEditor();
    editor.attach({ ...deps, stallMs: 20 });
    editor.start(Array.from({ length: 10 }, (_, i) => ({ uid: `vol~${i}`, captureMs: WANT })));
    await until(() => !editor.getStatus().running);
    const status = editor.getStatus();
    expect(status.failed).toBe(3);
    expect(status.errors.at(-1)?.error).toMatch(/7 photos left/);
    editor.detach();

    // The seven left carry on at the next sign-in, and count in that run.
    f.photos.getNode = async (uid: string) => f.nodes.get(uid);
    const next = new DateEditor();
    next.attach({ ...deps, stallMs: 20 });
    expect(next.getStatus().total).toBe(7);
    await until(() => !next.getStatus().running);
    expect(next.getStatus().done).toBe(7);
    next.detach();
  });

  it("trashes the copy of a photo given up on before anything moved to it", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"], joinFails: true });
    const editor = new DateEditor();
    editor.attach(deps);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await until(() => !editor.getStatus().running);
    expect(editor.getStatus().failed).toBe(1);
    expect(f.calls).toContain(`trash:${NEW}`);
    expect(f.calls).not.toContain(`trash:${OLD}`);
    editor.detach();
  });
});
