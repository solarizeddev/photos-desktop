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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { StoreLockedError, clearDataKey, initStore, setDataKey } from "./store.ts";
import { NO_PREVIEW, TRIES, ThumbRepairs, UNDRAWABLE_FOR_MS, type RepairLookup } from "./thumbRepair.ts";

let key: Buffer;

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-repair-")));
  key = randomBytes(32);
  setDataKey(Buffer.from(key));
});

/** A library whose kinds are known for some and looked up for the rest. */
function library(kinds: Record<string, string>, known: string[] = Object.keys(kinds), thumbs: string[] = []) {
  const looked: string[] = [];
  const lookup: RepairLookup = {
    hasThumb: (uid) => thumbs.includes(uid),
    known: (uid) => (known.includes(uid) ? kinds[uid] : null),
    lookUp: async (uid) => {
      looked.push(uid);
      return kinds[uid] ?? "";
    },
  };
  return { lookup, looked };
}

describe("videos without a thumbnail", () => {
  it("are noted only for Proton's answer that it has none, and handed out the latest first", async () => {
    const repairs = new ThumbRepairs();
    repairs.note("a", NO_PREVIEW);
    repairs.note("b", "Network error");
    repairs.note("c", NO_PREVIEW);
    repairs.note("d", NO_PREVIEW);
    const { lookup } = library({ a: "video/mp4", c: "video/quicktime", d: "video/mp4" });
    expect(await repairs.next(2, lookup)).toEqual(["d", "c"]);
    expect(await repairs.next(2, lookup)).toEqual(["a"]);
    expect(await repairs.next(2, lookup)).toEqual([]);
  });

  it("leaves out photos, those with a thumbnail kept here, and those already handed out", async () => {
    const repairs = new ThumbRepairs();
    for (const uid of ["photo", "kept", "unknown", "video"]) repairs.note(uid, NO_PREVIEW);
    const { lookup, looked } = library({ photo: "image/jpeg", kept: "video/mp4", unknown: "video/mp4", video: "video/mp4" }, ["photo", "kept", "video"], ["kept"]);
    expect(await repairs.next(5, lookup)).toEqual(["video", "unknown"]);
    expect(looked).toEqual(["unknown"]);
    repairs.note("video", NO_PREVIEW);
    repairs.note("photo", NO_PREVIEW);
    expect(await repairs.next(5, lookup)).toEqual([]);
    expect(repairs.isHanded("video")).toBe(true);
  });

  it("asks again a few times for one not drawn for a passing reason, and not for one passed over", async () => {
    const repairs = new ThumbRepairs();
    const { lookup } = library({ v: "video/mp4", big: "video/mp4" });
    repairs.note("v", NO_PREVIEW);
    for (let i = 0; i < TRIES; i++) {
      expect(await repairs.next(1, lookup)).toEqual(["v"]);
      repairs.letGo(["v"]);
    }
    expect(await repairs.next(1, lookup)).toEqual([]);
    repairs.note("big", NO_PREVIEW);
    repairs.pass("big");
    repairs.note("big", NO_PREVIEW);
    expect(await repairs.next(1, lookup)).toEqual([]);
  });

  it("leaves one this computer could not draw alone for a week, across a restart", async () => {
    let now = 1_000_000;
    const { lookup } = library({ v: "video/mp4", w: "video/mp4" });
    const first = new ThumbRepairs(undefined, () => now);
    first.note("v", NO_PREVIEW);
    first.note("w", NO_PREVIEW);
    expect(await first.next(2, lookup)).toEqual(["w", "v"]);
    // Only what was handed out counts.
    expect(first.cannotDraw(["v", "x"])).toBe(1);
    first.settle("w");

    const second = new ThumbRepairs(undefined, () => now);
    second.note("v", NO_PREVIEW);
    expect(await second.next(2, lookup)).toEqual([]);

    now += UNDRAWABLE_FOR_MS + 1;
    const later = new ThumbRepairs(undefined, () => now);
    later.note("v", NO_PREVIEW);
    expect(await later.next(2, lookup)).toEqual(["v"]);
  });

  it("forgets everything at lock, and touches nothing while the store is locked", async () => {
    const repairs = new ThumbRepairs();
    const { lookup } = library({ v: "video/mp4" });
    repairs.note("v", NO_PREVIEW);
    repairs.clear();
    clearDataKey();
    await expect(repairs.next(1, lookup)).rejects.toThrow(StoreLockedError);
    setDataKey(Buffer.from(key));
    expect(await repairs.next(1, lookup)).toEqual([]);
  });
});
