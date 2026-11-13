/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import sharp from "sharp";

import { COVER_SIZE, FaceCovers, cutFace, faceSquare, parseFaceBox, type FaceBox } from "./faceCover.ts";

/** A `width` x `height` JPEG, black but for a white square at `box`. */
async function picture(width: number, height: number, box: FaceBox, orientation?: number): Promise<Buffer> {
  const [l, t, r, b] = box;
  const spot = await sharp({
    create: { width: Math.round((r - l) * width), height: Math.round((b - t) * height), channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: "#000" } })
    .composite([{ input: spot, left: Math.round(l * width), top: Math.round(t * height) }])
    .jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

describe("the face square", () => {
  it("is 1.4 times the face's longer side, centred on it", () => {
    expect(faceSquare([0.4, 0.4, 0.5, 0.5], 1000, 1000)).toEqual({ left: 380, top: 380, size: 140 });
  });

  it("stays inside the picture at an edge", () => {
    expect(faceSquare([0, 0, 0.1, 0.1], 1000, 500)).toEqual({ left: 0, top: 0, size: 140 });
    expect(faceSquare([0.95, 0.9, 1, 1], 1000, 500)).toEqual({ left: 930, top: 430, size: 70 });
  });

  it("is never larger than the picture's shorter side", () => {
    expect(faceSquare([0, 0, 1, 1], 1200, 800)).toEqual({ left: 200, top: 0, size: 800 });
  });
});

describe("a face box from a URL", () => {
  it("reads four shares", () => {
    expect(parseFaceBox("0.1,0.2,0.3,0.4")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it.each(["", "0.1,0.2,0.3", "a,b,c,d", "0.5,0.2,0.3,0.4", "0,0,1.5,1", "-0.1,0,0.5,0.5", "1e-3,0,1,1", "Infinity,0,1,1"])(
    "refuses %j",
    (text) => {
      expect(parseFaceBox(text)).toBeNull();
    },
  );
});

describe("cutting a face", () => {
  it("returns a small square of the face", async () => {
    const box: FaceBox = [0.5, 0.2, 0.7, 0.45];
    const cut = await cutFace(await picture(2000, 1500, box), box);
    const meta = await sharp(cut!).metadata();
    expect(meta.width).toBe(COVER_SIZE);
    expect(meta.height).toBe(COVER_SIZE);
    // The face is in the middle of the cut.
    const { data } = await sharp(cut!).extract({ left: 150, top: 150, width: 20, height: 20 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(200);
  });

  it("cuts from the upright picture when EXIF turns it", async () => {
    // Stored 1500 x 2000 and turned a quarter (orientation 6): shown 2000 x 1500. The box is
    // where the face is in the picture as shown, which is where the scan found it.
    const shown: FaceBox = [0.5, 0.2, 0.7, 0.45];
    const stored = await sharp(await picture(2000, 1500, shown)).rotate(-90).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const cut = await cutFace(stored, shown);
    const { data } = await sharp(cut!).extract({ left: 150, top: 150, width: 20, height: 20 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(200);
  });

  it("does not enlarge a cut smaller than a cover", async () => {
    const box: FaceBox = [0.4, 0.4, 0.5, 0.5];
    const cut = await cutFace(await picture(200, 200, box), box);
    expect((await sharp(cut!).metadata()).width).toBe(28);
  });
});

describe("the cover cache", () => {
  const box: FaceBox = [0.4, 0.4, 0.5, 0.5];

  it("fetches a picture once for any number of asks, and keeps the cut", async () => {
    const jpeg = await picture(400, 400, box);
    let fetched = 0;
    const covers = new FaceCovers(async () => {
      fetched++;
      return jpeg;
    });
    const live = new AbortController().signal;
    const [a, b] = await Promise.all([covers.get("u", box, live), covers.get("u", box, live)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(await covers.get("u", box, live)).toBe(a);
    expect(fetched).toBe(1);
  });

  it("never fetches for an ask given up while it waited in line", async () => {
    const jpeg = await picture(400, 400, box);
    const asked: string[] = [];
    const release: (() => void)[] = [];
    const covers = new FaceCovers(async (uid) => {
      asked.push(uid);
      await new Promise<void>((r) => release.push(r));
      return jpeg;
    });
    const live = new AbortController().signal;
    const first = covers.get("a", box, live);
    const second = covers.get("b", box, live);
    const leaving = new AbortController();
    const third = covers.get("c", box, leaving.signal);
    const fourth = covers.get("d", box, live);
    await Promise.resolve();
    expect(asked).toEqual(["a", "b"]);
    leaving.abort();
    expect(await third).toBeNull();
    release.shift()!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["a", "b", "d"]);
    release.shift()!();
    release.shift()!();
    await Promise.all([second, fourth]);
    expect(asked).toEqual(["a", "b", "d"]);
  });

  it("answers null when there is no picture, and forgets everything at clear", async () => {
    const jpeg = await picture(400, 400, box);
    const covers = new FaceCovers(async (uid) => (uid === "none" ? null : jpeg));
    const live = new AbortController().signal;
    expect(await covers.get("none", box, live)).toBeNull();
    await covers.get("u", box, live);
    expect(covers.size()).toBe(1);
    covers.clear();
    expect(covers.size()).toBe(0);
  });

  it("does not keep a cut that finishes after a clear", async () => {
    const jpeg = await picture(400, 400, box);
    let release!: () => void;
    const covers = new FaceCovers(async () => {
      await new Promise<void>((r) => (release = r));
      return jpeg;
    });
    const pending = covers.get("u", box, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 0));
    covers.clear();
    release();
    await pending;
    expect(covers.size()).toBe(0);
  });
});
