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
const T = Date.UTC(2024, 5, 1, 12, 0, 0);

/** A fingerprint: `seed` decides its bits, so equal seeds match and far ones do not. */
function print(seed: number): Fingerprint {
  const bits = new Uint32Array(HASH_WORDS).map((_, i) => (seed * 2654435761 + i * 40503) >>> 0);
  return { bits, quality: 80, color: new Uint8Array(48).fill(seed % 200) };
}

function index(photos: LibraryPhoto[], hashes: [string, string][] = [], prints: Record<string, Fingerprint> = {}, hidden = new Set<string>()) {
  return new LibraryIndex(photos, hashes, KEY, async (uid) => prints[uid] ?? null, (uid) => hidden.has(uid));
}

describe("the import's library check", () => {
  it("keys a file's SHA-1 the way Proton keys a content hash", async () => {
    const key = await importKey(KEY);
    const theirs = Buffer.from(await signData(key, new TextEncoder().encode(SHA1))).toString("hex");
    expect(contentHashOf(SHA1, KEY)).toBe(theirs);
  });

  it("finds the same file under any name", async () => {
    const lib = index([{ uid: "v~1", captureTime: T, video: false }], [["v~1", contentHashOf(SHA1, KEY)]]);
    expect(lib.canMatchContent()).toBe(true);
    const m = await matchFile(lib, { sha1: SHA1, takenMs: null, video: false, print: async () => null });
    expect(m).toMatchObject({ verdict: "already", uid: "v~1", why: "same_file", hidden: false });
  });

  it("does not take a trashed photo's hash for one still there", async () => {
    const lib = index([], [["v~gone", contentHashOf(SHA1, KEY)]]);
    expect(lib.sameFile(SHA1)).toBeNull();
  });

  it("holds back a picture taken at the same moment that looks the same, and lets a different one through", async () => {
    const lib = index([{ uid: "v~1", captureTime: T + 400, video: false }], [], { "v~1": print(7) });
    const same = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(7) });
    expect(same).toMatchObject({ verdict: "probable", uid: "v~1", why: "same_time_look" });
    const other = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(9_000_001) });
    expect(other.verdict).toBe("new");
  });

  it("sees a picture whose time was read in another time zone, only when it looks the same", async () => {
    const lib = index([{ uid: "v~1", captureTime: T + 2 * 3600 * 1000, video: false }], [], { "v~1": print(7) });
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => print(7) })).verdict).toBe("probable");
    // With nothing to compare by, a match hours away is not enough.
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => null })).verdict).toBe("new");
  });

  it("holds back a picture it cannot read when one was taken in the same second", async () => {
    const lib = index([{ uid: "v~1", captureTime: T, video: false }]);
    const m = await matchFile(lib, { sha1: "x", takenMs: T, video: false, print: async () => null });
    expect(m).toMatchObject({ verdict: "probable", why: "same_time" });
  });

  it("matches a video only with a video of the same second", async () => {
    const lib = index([
      { uid: "v~pic", captureTime: T, video: false },
      { uid: "v~vid", captureTime: T + 900_000, video: true },
    ]);
    expect((await matchFile(lib, { sha1: "x", takenMs: T, video: true, print: async () => null })).verdict).toBe("new");
    const lib2 = index([{ uid: "v~vid", captureTime: T + 1000, video: true }]);
    expect(await matchFile(lib2, { sha1: "x", takenMs: T, video: true, print: async () => null })).toMatchObject({
      verdict: "probable",
      uid: "v~vid",
      why: "same_time_video",
    });
  });

  it("says when the match is a hidden photo", async () => {
    const lib = index([{ uid: "v~h", captureTime: T, video: false }], [["v~h", contentHashOf(SHA1, KEY)]], {}, new Set(["v~h"]));
    expect(await matchFile(lib, { sha1: SHA1, takenMs: T, video: false, print: async () => null })).toMatchObject({ hidden: true });
  });

  it("calls a file with no date new when its bytes are not in the library", async () => {
    const lib = index([{ uid: "v~1", captureTime: T, video: false }]);
    expect((await matchFile(lib, { sha1: "x", takenMs: null, video: false, print: async () => print(7) })).verdict).toBe("new");
  });

  it("cannot match by content without the key or the hashes", () => {
    expect(new LibraryIndex([], [], null, async () => null).canMatchContent()).toBe(false);
    expect(index([]).canMatchContent()).toBe(false);
  });
});
