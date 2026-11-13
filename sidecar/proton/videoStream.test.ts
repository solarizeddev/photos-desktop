/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { OpenVideos, parseRange, videoFromBytes, videoFromDownloader } from "./videoStream.ts";

const live = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

/** The SDK's seekable stream over `bytes`, handing out at most `block` bytes a read. */
function fakeDownloader(bytes: Buffer, block = 1000) {
  const opened: number[] = [];
  return {
    opened,
    getSeekableStream() {
      let at = 0;
      return {
        seek(p: number) {
          at = p;
          opened.push(p);
        },
        async read(n: number) {
          const take = Math.min(n, block, bytes.length - at);
          const value = bytes.subarray(at, at + Math.max(0, take));
          at += value.length;
          return { value, done: at >= bytes.length };
        },
      };
    },
  };
}

const FILE = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));

describe("a Range header", () => {
  it("reads a start and an end, a start alone, and the last n bytes", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("keeps an end past the file to the file", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("serves the first of several ranges", () => {
    expect(parseRange("bytes=0-9, 20-29", 1000)).toEqual({ start: 0, end: 9 });
  });

  it("answers the whole file for none, or one it does not read", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("items=0-9", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("bytes=9-3", 1000)).toBeNull();
  });

  it("is unsatisfiable past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("reading a video a range at a time", () => {
  it("slices a video kept on this computer", async () => {
    const v = videoFromBytes(FILE, "video/mp4");
    expect(v.size).toBe(FILE.length);
    expect((await collect(v.read(1000, 400_000, live()))).equals(FILE.subarray(1000, 400_001))).toBe(true);
  });

  it("reads a range from the SDK's seekable stream, from where it starts", async () => {
    const d = fakeDownloader(FILE);
    const v = videoFromDownloader(d, FILE.length, "video/mp4");
    expect((await collect(v.read(123_456, 654_321, live()))).equals(FILE.subarray(123_456, 654_322))).toBe(true);
    expect(d.opened).toEqual([123_456]);
  });

  it("ends early when the stated size is larger than the file", async () => {
    const v = videoFromDownloader(fakeDownloader(FILE), FILE.length + 5000, "video/mp4");
    const got = await collect(v.read(690_000, FILE.length + 4999, live()));
    expect(got.equals(FILE.subarray(690_000))).toBe(true);
  });

  it("stops reading once the player has gone", async () => {
    const v = videoFromDownloader(fakeDownloader(FILE), FILE.length, "video/mp4");
    const gone = new AbortController();
    let pieces = 0;
    for await (const _ of v.read(0, FILE.length - 1, gone.signal)) {
      if (++pieces === 2) gone.abort();
    }
    expect(pieces).toBe(2);
  });
});

describe("the videos kept open", () => {
  it("opens a video once for all its ranges", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      return videoFromBytes(FILE, "video/mp4");
    });
    const [a, b] = await Promise.all([open.get("u"), open.get("u")]);
    expect(a).toBe(b);
    await open.get("u");
    expect(opens).toBe(1);
  });

  it("tries again for one that could not be opened, and forgets all at clear", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      if (opens === 1) throw new Error("network");
      return videoFromBytes(FILE, "video/mp4");
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).not.toBeNull();
    open.clear();
    await open.get("u");
    expect(opens).toBe(3);
  });
});
