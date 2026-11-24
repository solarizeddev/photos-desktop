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

import { describe, expect, it } from "vitest";
import { importKey, signData } from "@protontech/crypto/subtle/hmac.ts";

import { LibraryIndex, contentHashOf, matchFile, type LibraryPhoto } from "./importMatch.ts";
import { HASH_WORDS, type Fingerprint } from "./pdq.ts";

const KEY = new Uint8Array(32).map((_, i) => i + 1);
const SHA1 = "a9993e364706816aba3e25717850c26c9cd0d89d";

function index(uids: string[], hashes: [string, string][] = [], hidden = new Set<string>(), listed = new Set(uids)) {
  return new LibraryIndex(uids, hashes, listed, KEY, (uid) => hidden.has(uid));
}

describe("the import's library check", () => {
  it("keys a file's SHA-1 the way Proton keys a content hash", async () => {
    const key = await importKey(KEY);
    const theirs = Buffer.from(await signData(key, new TextEncoder().encode(SHA1))).toString("hex");
    expect(contentHashOf(SHA1, KEY)).toBe(theirs);
  });

  it("finds the same file under any name", () => {
    const lib = index(["v~1"], [["v~1", contentHashOf(SHA1, KEY)]]);
    expect(lib.canMatchContent()).toBe(true);
    expect(lib.sameFile(SHA1)).toBe("v~1");
    expect(lib.sameFile("b".repeat(40))).toBeNull();
  });

  it("finds a Live Photo's video by its bytes, as the photo it belongs to", () => {
    const video = "c".repeat(40);
    const lib = index(["v~1"], [["v~1", contentHashOf(SHA1, KEY)], ["v~1", contentHashOf(video, KEY)]]);
    expect(lib.sameFile(video)).toBe("v~1");
  });

  it("does not take a trashed photo's hash for one still there", () => {
    const lib = index(["v~1"], [["v~gone", contentHashOf(SHA1, KEY)]]);
    expect(lib.sameFile(SHA1)).toBeNull();
  });

  it("points at a shown copy rather than a hidden one, and says when only a hidden one has the bytes", () => {
    const hash = contentHashOf(SHA1, KEY);
    const both = index(["v~h", "v~s"], [["v~h", hash], ["v~s", hash]], new Set(["v~h"]));
    expect(both.sameFile(SHA1)).toBe("v~s");
    const hiddenOnly = index(["v~h"], [["v~h", hash]], new Set(["v~h"]));
    expect(hiddenOnly.hidden(hiddenOnly.sameFile(SHA1)!)).toBe(true);
  });

  it("matches by content only when the listing went through every photo of the library", () => {
    const hashes: [string, string][] = [["v~1", contentHashOf(SHA1, KEY)]];
    expect(index(["v~1", "v~2"], hashes, new Set(), new Set(["v~1"])).canMatchContent()).toBe(false);
    // A photo listed without a hash still counts as gone through: it is found by name and bytes.
    expect(index(["v~1", "v~2"], hashes).canMatchContent()).toBe(true);
  });

  it("cannot match by content without the key", () => {
    expect(new LibraryIndex(["v~1"], [["v~1", contentHashOf(SHA1, KEY)]], new Set(["v~1"]), null).canMatchContent()).toBe(false);
  });

  it("matches against an empty library, which holds nothing to find", () => {
    expect(index([]).canMatchContent()).toBe(true);
    expect(new LibraryIndex([], [], new Set(), null).canMatchContent()).toBe(true);
  });
});

const T = Date.UTC(2024, 5, 1, 12, 0, 0);

/** A fingerprint: `seed` decides its bits, so equal seeds match and far ones do not. */
function print(seed: number): Fingerprint {
  const bits = new Uint32Array(HASH_WORDS).map((_, i) => (seed * 2654435761 + i * 40503) >>> 0);
  return { bits, quality: 80, color: new Uint8Array(48).fill(seed % 200) };
}

/** A library given with its dates and looks, so what is probably there can be found too. */
function looking(photos: LibraryPhoto[], hashes: [string, string][] = [], prints: Record<string, Fingerprint> = {}, hidden = new Set<string>()) {
  const uids = photos.map((p) => p.uid);
  return new LibraryIndex(uids, hashes, new Set(uids), KEY, (uid) => hidden.has(uid), {
    photos,
    printOf: async (uid) => prints[uid] ?? null,
  });
}

describe("what is probably in the library", () => {
  it("is looked for only when the library's dates and looks are given", async () => {
    expect(index(["v~1"]).canMatchProbable()).toBe(false);
    const lib = looking([{ uid: "v~1", captureTime: T, video: false }], [], { "v~1": print(7) });
    expect(lib.canMatchProbable()).toBe(true);
    const bare = new LibraryIndex(["v~1"], [], new Set(["v~1"]), KEY);
    expect((await matchFile(bare, { sha1: "x", takenMs: T, video: false, print: async () => print(7) })).verdict).toBe("new");
  });

  it("says first when it is the same file", async () => {
    const lib = looking([{ uid: "v~1", captureTime: T, video: false }], [["v~1", contentHashOf(SHA1, KEY)]]);
    const m = await matchFile(lib, { sha1: SHA1, takenMs: null, video: false, print: async () => null });
    expect(m).toMatchObject({ verdict: "already", uid: "v~1", why: "same_file", hidden: false });
  });

  it("is a picture taken at the same moment that looks the same, never a different one", async () => {
    const lib = looking([{ uid: "v~1", captureTime: T + 400, video: false }], [], { "v~1": print(7) });
    const same = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(7) });
    expect(same).toMatchObject({ verdict: "probable", uid: "v~1", why: "same_time_look" });
    const other = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(9_000_001) });
    expect(other.verdict).toBe("new");
  });

  it("sees a picture whose time was read in another time zone, only when it looks the same", async () => {
    const lib = looking([{ uid: "v~1", captureTime: T + 2 * 3600 * 1000, video: false }], [], { "v~1": print(7) });
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(7) })).verdict).toBe("probable");
    // With nothing to compare by, a match hours away is not enough.
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => null })).verdict).toBe("new");
  });

  it("asks about a picture it cannot read when one was taken in the same second", async () => {
    const lib = looking([{ uid: "v~1", captureTime: T, video: false }]);
    const m = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => null });
    expect(m).toMatchObject({ verdict: "probable", why: "same_time" });
  });

  it("is a video of the very same size and length whatever its date, unless many share it", async () => {
    const H = 3_600_000;
    const twin = { uid: "v~twin", captureTime: T + 300 * 86_400_000, video: true, size: 7_340_032, durationMs: 18_200 };
    const file = { sha1: "x", takenMs: T, video: true, size: 7_340_032, durationMs: 18_200, print: async () => null };
    expect(await matchFile(looking([twin]), file)).toMatchObject({ verdict: "probable", uid: "v~twin", why: "same_size_video" });
    // Five of one size and length: a dashcam's padded segments, not copies.
    const segments = Array.from({ length: 5 }, (_, k) => ({ ...twin, uid: `v~seg${k}`, captureTime: T + 10 * H + k * 60_000 }));
    expect((await matchFile(looking(segments), file)).verdict).toBe("new");
  });

  it("matches a video whole hours off by its length, and tells another clip by a different length", async () => {
    const H = 3_600_000;
    const lib = looking([{ uid: "v~utc", captureTime: T + 2 * H, video: true, size: 50_000_000, durationMs: 61_000 }]);
    const same = { sha1: "x", takenMs: T, video: true, size: 50_000_000, durationMs: 61_040, print: async () => null };
    expect(await matchFile(lib, same)).toMatchObject({ verdict: "probable", uid: "v~utc", why: "same_time_video" });
    expect((await matchFile(lib, { ...same, durationMs: 12_000 })).verdict).toBe("new");
    // Hours off with no length to go by: not asked about.
    expect((await matchFile(lib, { ...same, durationMs: null })).verdict).toBe("new");
  });

  it("tells another clip of the same second only by a clearly different length", async () => {
    const lib = looking([{ uid: "v~v", captureTime: T, video: true, size: 9_000_000, durationMs: 8_000 }]);
    const file = { sha1: "x", takenMs: T, video: true, size: 9_100_000, durationMs: 8_900, print: async () => null };
    // Read by two programs, 0.9 s apart: one clip still.
    expect((await matchFile(lib, file)).verdict).toBe("probable");
    expect((await matchFile(lib, { ...file, durationMs: 12_000 })).verdict).toBe("new");
  });

  it("does not match hours off against a series, nor a twin already claimed", async () => {
    const H = 3_600_000;
    const series = looking([
      { uid: "v~s1", captureTime: T + 3 * H, video: true, size: 5_000_000, durationMs: 10_000 },
      { uid: "v~s2", captureTime: T + 3 * H + 600_000, video: true, size: 5_000_001, durationMs: 10_000 },
    ]);
    const file = { sha1: "x", takenMs: T, video: true, size: 5_000_002, durationMs: 10_000, print: async () => null };
    expect((await matchFile(series, file)).verdict).toBe("new");
    const twin = looking([{ uid: "v~t", captureTime: T + 90 * 86_400_000, video: true, size: 7_000_000, durationMs: 20_000 }]);
    const copy = { sha1: "y", takenMs: T, video: true, size: 7_000_000, durationMs: 20_000, print: async () => null };
    expect((await matchFile(twin, copy, new Set(["v~t"]))).verdict).toBe("new");
    // Many export files of that size and length: a camera's segments.
    expect((await matchFile(twin, { ...copy, crowded: true })).verdict).toBe("new");
  });

  it("says so when the library only has a smaller copy of the video", async () => {
    const lib = looking([{ uid: "v~lite", captureTime: T, video: true, size: 4_000_000, durationMs: 30_000 }]);
    const original = { sha1: "x", takenMs: T, video: true, size: 20_000_000, durationMs: 30_000, print: async () => null };
    expect(await matchFile(lib, original)).toMatchObject({ verdict: "probable", uid: "v~lite", why: "smaller_in_library" });
  });

  it("matches a video only with a video of the same second", async () => {
    const lib = looking([
      { uid: "v~pic", captureTime: T, video: false },
      { uid: "v~vid", captureTime: T + 900_000, video: true },
    ]);
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: true, print: async () => null })).verdict).toBe("new");
    const lib2 = looking([{ uid: "v~vid", captureTime: T + 1000, video: true }]);
    expect(await matchFile(lib2, { sha1: "x", takenMs: T, video: true, print: async () => null })).toMatchObject({
      verdict: "probable",
      uid: "v~vid",
      why: "same_time_video",
    });
  });

  it("says when the match is a hidden photo", async () => {
    const lib = looking([{ uid: "v~h", captureTime: T, video: false }], [], {}, new Set(["v~h"]));
    expect(await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => null })).toMatchObject({
      verdict: "probable",
      hidden: true,
    });
  });

  it("calls a file with no date new when its bytes are not in the library", async () => {
    const lib = looking([{ uid: "v~1", captureTime: T, video: false }]);
    expect((await matchFile(lib, { sha1: "x", takenMs: null, video: false, print: async () => print(7) })).verdict).toBe("new");
  });
});
