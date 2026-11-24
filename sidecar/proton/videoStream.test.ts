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

import { describe, it, expect, vi } from "vitest";
import {
  ArrivingVideo,
  NOT_STREAMABLE,
  OpenVideos,
  SeekingVideo,
  downloadVideo,
  parseRange,
  startSeeking,
  startVideo,
  videoFromBytes,
  type VideoAnswer,
  type VideoSource,
} from "./videoStream.ts";
import { openDownloader } from "./downloadSlots.ts";

const live = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

/** The video an ask answered with, which the test expects to be one. */
const source = (v: VideoAnswer) => v as VideoSource;

const FILE = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));

/**
 * The SDK's download slots and a downloader of `bytes`, modelled as the SDK has them: the
 * slot is taken when the downloader is made and given back only in the `finally` of a
 * download, which stops at the next block once its signal fires.
 */
function sdk(bytes: Buffer, block = 100_000, signatureIssues = false) {
  const queue = { inUse: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const auto = { on: true };
  const client = {
    async getFileDownloader(_uid: string, signal: AbortSignal) {
      queue.inUse++;
      return {
        getClaimedSizeInBytes: () => bytes.length,
        downloadToStream(sink: WritableStream<Uint8Array>) {
          const completion = (async () => {
            const writer = sink.getWriter();
            try {
              for (let at = 0; at < bytes.length; at += block) {
                if (!auto.on) await gate;
                if (signal.aborted) throw new Error("aborted");
                // A fresh array each block, as the SDK hands them over.
                await writer.write(Uint8Array.from(bytes.subarray(at, at + block)));
                await new Promise((r) => setTimeout(r, 1));
              }
              await writer.close();
              if (signatureIssues) throw new Error("signature");
            } finally {
              queue.inUse--;
            }
          })();
          return { completion: () => completion, isDownloadCompleteWithSignatureIssues: () => signatureIssues };
        },
      };
    },
  };
  return { queue, client, hold: () => (auto.on = false), go: () => release() };
}

describe("a Range header", () => {
  it("reads a start and an end, a start alone, and the last n bytes", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("keeps an end past the file to the file, and serves the first of several ranges", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
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

describe("a video kept on this computer", () => {
  it("is sliced", async () => {
    const v = videoFromBytes(FILE, "video/mp4");
    expect((await collect(v.read(1000, 400_000, live()))).equals(FILE.subarray(1000, 400_001))).toBe(true);
  });
});

describe("a video still arriving", () => {
  it("answers what is here at once and waits for the rest", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3]));
    const reading = collect(v.read(2, 7, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.append(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect([...(await reading)]).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("serves a range across the pieces it arrived in", async () => {
    const v = new ArrivingVideo(FILE.length, "video/mp4");
    for (let at = 0; at < FILE.length; at += 70_001) v.append(Uint8Array.from(FILE.subarray(at, at + 70_001)));
    v.end(true);
    expect((await collect(v.read(69_000, 500_123, live()))).equals(FILE.subarray(69_000, 500_124))).toBe(true);
    expect((await collect(v.read(FILE.length - 5, FILE.length - 1, live()))).equals(FILE.subarray(FILE.length - 5))).toBe(true);
  });

  it("throws when the file ends short of a range, so the answer is cut", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2]));
    v.end(true);
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("shorter");
  });

  it("drops bytes past the stated size", async () => {
    const v = new ArrivingVideo(3, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3, 4]));
    expect(v.arrived()).toBe(3);
  });

  it("stops a read under way when it is closed, and serves nothing after", async () => {
    let closed = 0;
    const v = new ArrivingVideo(10, "video/mp4", () => closed++);
    v.append(Buffer.from([0, 1]));
    const reading = collect(v.read(0, 9, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.close();
    await expect(reading).rejects.toThrow("stopped");
    await expect(collect(v.read(0, 1, live()))).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it("ends a waiting read quietly when the player goes", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    const gone = new AbortController();
    const reading = collect(v.read(0, 9, gone.signal));
    gone.abort();
    expect((await reading).length).toBe(0);
  });
});

describe("downloading a video to play", () => {
  it("plays from the first bytes, and gives the download slot back when done", async () => {
    const s = sdk(FILE);
    const v = downloadVideo(await openDownloader(s.client, "v"), FILE.length, "video/mp4");
    expect(s.queue.inUse).toBe(1);
    expect((await collect(v.read(0, 99, live()))).equals(FILE.subarray(0, 100))).toBe(true);
    expect((await collect(v.read(600_000, FILE.length - 1, live()))).equals(FILE.subarray(600_000))).toBe(true);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.broken()).toBe(false);
  });

  it("gives the slot back when closed before the download is done", async () => {
    const s = sdk(FILE);
    s.hold();
    const v = downloadVideo(await openDownloader(s.client, "v"), FILE.length, "video/mp4");
    v.close();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.broken()).toBe(true);
  });

  it("never holds more than one slot per video, however many videos are played one after another", async () => {
    const s = sdk(FILE);
    const open = new OpenVideos(async (uid) => downloadVideo(await openDownloader(s.client, uid), FILE.length, "video/mp4"));
    for (let i = 0; i < 12; i++) {
      const v = source(await open.get(`v${i}`));
      await collect(v.read(0, 999, live()));
    }
    open.clear();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
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
    open.clear();
  });

  it("closes the oldest past two, and every one at clear", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }));
    await open.get("a");
    await open.get("b");
    await open.get("c");
    await vi.waitFor(() => expect(closed).toEqual(["a"]));
    open.clear();
    await vi.waitFor(() => expect(closed.sort()).toEqual(["a", "b", "c"]));
  });

  it("closes a video left idle, but not one still being read", async () => {
    let now = 0;
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }),
      () => now,
      1000,
    );
    const playing = source(await open.get("playing"));
    await open.get("left");
    now = 900;
    await collect(playing.read(0, 10, live()));
    now = 1500;
    open.closeIdle();
    await vi.waitFor(() => expect(closed).toEqual(["left"]));
    expect(open.size()).toBe(1);
    open.clear();
  });

  it("keeps a video whose answer is still open, as a paused player's is", async () => {
    let now = 0;
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }),
      () => now,
      1000,
    );
    const paused = source(await open.get("paused"));
    const reading = paused.read(0, FILE.length - 1, live());
    await reading.next(); // the answer is open; the player has stopped reading
    now = 5000;
    open.closeIdle();
    expect(closed).toEqual([]);
    await reading.return(undefined); // the player goes: the answer closes
    now = 7000;
    open.closeIdle();
    await vi.waitFor(() => expect(closed).toEqual(["paused"]));
  });

  it("tries again for one that could not be opened, and opens afresh one that broke", async () => {
    let opens = 0;
    let broken = false;
    const open = new OpenVideos(async () => {
      opens++;
      if (opens === 1) throw new Error("network");
      return { ...videoFromBytes(FILE, "video/mp4"), broken: () => broken };
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).not.toBeNull();
    broken = true;
    await open.get("u");
    expect(opens).toBe(3);
    open.clear();
  });
});

describe("a video whose signature does not check out", () => {
  it("is not played on, gives its slot back, and is refused when asked again", async () => {
    const s = sdk(FILE, 100_000, true);
    const open = new OpenVideos(async (uid) => downloadVideo(await openDownloader(s.client, uid), FILE.length, "video/mp4"));
    const v = source(await open.get("u"));
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.refused?.()).toBe(true);
    // Every byte had arrived, and still none of it is served.
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("signature");
    expect(open.notStreamable("u")).toBe(true);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(open.size()).toBe(0);
    open.clear();
  });

  it("cuts a read under way", async () => {
    const s = sdk(FILE, 100_000, true);
    s.hold();
    const v = downloadVideo(await openDownloader(s.client, "u"), FILE.length * 2, "video/mp4");
    const reading = collect(v.read(0, FILE.length * 2 - 1, live()));
    s.go();
    await expect(reading).rejects.toThrow("signature");
    expect(v.refused()).toBe(true);
  });
});

describe("waiting for a video", () => {
  it("answers null when the lookup does not come back in time, and stops waiting for a slot", async () => {
    let signal: AbortSignal | undefined;
    const open = new OpenVideos(
      (_uid, s) => {
        signal = s;
        return new Promise<VideoAnswer>(() => {});
      },
      Date.now,
      90_000,
      { startMs: 30 },
    );
    expect(await open.get("u")).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(open.size()).toBe(0);
    open.clear();
  });

  it("gives the slot back when the first bytes do not come in time", async () => {
    const s = sdk(FILE);
    s.hold();
    const open = new OpenVideos(
      async (uid, signal) => startVideo(await openDownloader(s.client, uid, signal), FILE.length, "video/mp4", signal),
      Date.now,
      90_000,
      { startMs: 30 },
    );
    expect(await open.get("u")).toBeNull();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    open.clear();
  });

  it("closes a video that comes in after the wait was given up", async () => {
    let closed = 0;
    let finish!: (v: VideoAnswer) => void;
    const open = new OpenVideos(() => new Promise<VideoAnswer>((r) => (finish = r)), Date.now, 90_000, { startMs: 20 });
    expect(await open.get("u")).toBeNull();
    finish({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed++ });
    await vi.waitFor(() => expect(closed).toBe(1));
  });

  it("ends a read whose next bytes stall, and stops the download", async () => {
    let stopped = 0;
    const v = new ArrivingVideo(10, "video/mp4", () => stopped++, 30);
    v.append(Buffer.from([0, 1, 2]));
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("stalled");
    expect(stopped).toBe(1);
    expect(v.broken()).toBe(true);
  });

  it("keeps a read waiting while the bytes keep coming", async () => {
    const v = new ArrivingVideo(6, "video/mp4", () => {}, 60);
    const reading = collect(v.read(0, 5, live()));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 15));
      v.append(Buffer.from([i]));
    }
    expect([...(await reading)]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("a video that can never be streamed", () => {
  it("is refused at once for a while without being looked up again, and again after", async () => {
    let now = 0;
    let looks = 0;
    const open = new OpenVideos(
      async () => {
        looks++;
        return NOT_STREAMABLE;
      },
      () => now,
      90_000,
      { refusedMs: 1000 },
    );
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(open.notStreamable("u")).toBe(true);
    expect(looks).toBe(1);
    now = 1500;
    expect(open.notStreamable("u")).toBe(false);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(looks).toBe(2);
    open.clear();
    expect(open.notStreamable("u")).toBe(false);
  });

  it("is told apart from one that failed for now, which is looked up again", async () => {
    let looks = 0;
    const open = new OpenVideos(async () => {
      looks++;
      return null;
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).toBeNull();
    expect(open.notStreamable("u")).toBe(false);
    expect(looks).toBe(2);
    open.clear();
  });
});

describe("the memory the videos kept open hold", () => {
  const sized = (size: number, closed: string[], uid: string): VideoSource => ({
    ...videoFromBytes(Buffer.alloc(size), "video/mp4"),
    close: () => closed.push(uid),
  });

  it("stays within the cap, the oldest closed first and the newest kept", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => sized(uid === "small" ? 300 : 700, closed, uid), Date.now, 90_000, {
      keptBytes: 1000,
    });
    await open.get("small");
    await open.get("big");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    await open.get("other");
    await vi.waitFor(() => expect(closed).toEqual(["small", "big"]));
    expect(open.size()).toBe(1);
    open.clear();
  });

  it("keeps one still being read past the cap until its answer closes", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => sized(700, closed, uid), Date.now, 90_000, { keptBytes: 1000 });
    const first = source(await open.get("first"));
    const reading = first.read(0, 699, live());
    await reading.next();
    await open.get("second");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    await reading.return(undefined);
    await vi.waitFor(() => expect(closed).toEqual(["first"]));
    open.clear();
  });

  it("counts a video read a block at a time at what it holds, not at its size", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => (uid === "large" ? { ...sized(5000, closed, uid), holds: 100 } : sized(300, closed, uid)),
      Date.now,
      90_000,
      { keptBytes: 1000 },
    );
    await open.get("small");
    await open.get("large");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    open.clear();
  });
});

describe("a video read range by range from Proton", () => {
  /** A file of `size` bytes, each the low byte of its position, behind a fake seekable stream. */
  function seekable(size: number) {
    let position = 0;
    const log = { seeks: [] as number[], reads: 0 };
    let failAt: number | null = null;
    const stream = {
      seek(p: number) {
        log.seeks.push(p);
        position = p;
      },
      async read(n: number) {
        log.reads++;
        await new Promise((r) => setTimeout(r, 1));
        if (failAt !== null && position <= failAt && failAt < position + n) throw new Error("block failed");
        const len = Math.max(0, Math.min(n, size - position));
        const value = new Uint8Array(len);
        for (let i = 0; i < len; i++) value[i] = (position + i) & 0xff;
        position += len;
        return { value, done: position >= size };
      },
    };
    return { stream, log, fail: (at: number) => (failAt = at) };
  }
  const bytesOf = async (gen: AsyncGenerator<Uint8Array>) => {
    const parts: Uint8Array[] = [];
    for await (const piece of gen) parts.push(Uint8Array.from(piece));
    return Array.from(Buffer.concat(parts));
  };
  const MB = 1024 * 1024;

  it("answers any range with the right bytes, the end of the file included", async () => {
    const { stream } = seekable(10 * MB + 123);
    const video = new SeekingVideo(10 * MB + 123, "video/mp4", stream, () => {});
    const middle = await bytesOf(video.read(3 * MB + 7, 3 * MB + 300_000, live()));
    expect(middle.length).toBe(300_000 - 7 + 1);
    expect(middle.every((b, i) => b === ((3 * MB + 7 + i) & 0xff))).toBe(true);
    const tail = await bytesOf(video.read(10 * MB, 10 * MB + 500, live()));
    expect(tail.length).toBe(123);
    expect(tail[122]).toBe((10 * MB + 122) & 0xff);
    video.close();
  });

  it("serves what it kept without asking again", async () => {
    const { stream, log } = seekable(20 * MB);
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => {});
    await bytesOf(video.read(0, 1 * MB, live()));
    const reads = log.reads;
    await bytesOf(video.read(100, 2 * MB, live()));
    expect(log.reads).toBe(reads);
    video.close();
  });

  it("takes turns on the one stream when two ranges are read at once", async () => {
    const { stream } = seekable(30 * MB);
    const video = new SeekingVideo(30 * MB, "video/mp4", stream, () => {});
    const [a, b] = await Promise.all([
      bytesOf(video.read(0, 6 * MB, live())),
      bytesOf(video.read(25 * MB, 30 * MB - 1, live())),
    ]);
    expect(a.every((x, i) => x === (i & 0xff))).toBe(true);
    expect(b.every((x, i) => x === ((25 * MB + i) & 0xff))).toBe(true);
    video.close();
  });

  it("stops a read the player gave up, and lets the slot go once on close", async () => {
    const { stream } = seekable(20 * MB);
    let closed = 0;
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => closed++);
    const stop = new AbortController();
    let got = 0;
    for await (const piece of video.read(0, 20 * MB - 1, stop.signal)) {
      got += piece.length;
      if (got > MB) stop.abort();
    }
    expect(got).toBeLessThan(20 * MB);
    video.close();
    video.close();
    expect(closed).toBe(1);
  });

  it("is broken and closed once a read fails, and opened afresh on the next ask", async () => {
    const { stream, fail } = seekable(20 * MB);
    fail(9 * MB);
    let closed = 0;
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => closed++);
    await expect(bytesOf(video.read(9 * MB, 10 * MB, live()))).rejects.toThrow();
    expect(video.broken()).toBe(true);
    expect(closed).toBe(1);
    // A read of what it does not hold fails too: the server cuts the answer short and the
    // player asks again, which opens it afresh.
    await expect(bytesOf(video.read(0, 100, live()))).rejects.toThrow();
    let loads = 0;
    const open = new OpenVideos(async () =>
      ++loads === 1 ? video : new SeekingVideo(20 * MB, "video/mp4", seekable(20 * MB).stream, () => {}),
    );
    await open.get("u");
    const again = source(await open.get("u"));
    expect(loads).toBe(2);
    expect(again.broken!()).toBe(false);
    open.clear();
  });

  it("lets a reader the player gave up leave while it waits its turn", async () => {
    const { stream } = seekable(40 * MB);
    const video = new SeekingVideo(40 * MB, "video/mp4", stream, () => {});
    const first = bytesOf(video.read(0, 8 * MB, live()));
    const leaving = new AbortController();
    const second = bytesOf(video.read(30 * MB, 31 * MB, leaving.signal));
    leaving.abort();
    expect((await second).length).toBe(0);
    expect((await first).length).toBe(8 * MB + 1);
    video.close();
  });

  it("reads ahead of the player on its other lanes", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    const two = seekable(64 * MB);
    const three = seekable(64 * MB);
    video.addLane(two.stream, () => {});
    video.addLane(three.stream, () => {});
    expect(video.laneCount()).toBe(3);
    const first = await bytesOf(video.read(0, 100, live()));
    expect(first.length).toBe(101);
    await vi.waitFor(() => expect(one.log.reads + two.log.reads + three.log.reads).toBeGreaterThanOrEqual(5));
    // The four blocks after the first were read before the player asked for them.
    const seeks = () => [...one.log.seeks, ...two.log.seeks, ...three.log.seeks];
    expect(seeks().sort((a, b) => a - b).slice(0, 5)).toEqual([0, 4 * MB, 8 * MB, 12 * MB, 16 * MB]);
    const later = await bytesOf(video.read(16 * MB, 16 * MB + 10, live()));
    expect(later[0]).toBe((16 * MB) & 0xff);
    // Already read ahead: that block is not asked of Proton again.
    expect(seeks().filter((p) => p === 16 * MB).length).toBe(1);
    video.close();
  });

  it("lets a lane asked to leave finish its read first, and plays on without it", async () => {
    const video = new SeekingVideo(64 * MB, "video/mp4", seekable(64 * MB).stream, () => {});
    let left = 0;
    const leave = video.addLane(seekable(64 * MB).stream, () => left++)!;
    const reading = bytesOf(video.read(0, 9 * MB, live()));
    leave();
    const bytes = await reading;
    expect(bytes.length).toBe(9 * MB + 1);
    expect(bytes.every((b, i) => b === (i & 0xff))).toBe(true);
    await vi.waitFor(() => expect(left).toBe(1));
    expect(video.laneCount()).toBe(1);
    expect(video.broken()).toBe(false);
    video.close();
  });

  it("lets a lane go whose read ahead failed, and plays on", async () => {
    const video = new SeekingVideo(64 * MB, "video/mp4", seekable(64 * MB).stream, () => {});
    const bad = seekable(64 * MB);
    // Every read on this lane fails.
    bad.stream.read = async () => {
      throw new Error("block failed");
    };
    let left = 0;
    video.addLane(bad.stream, () => left++);
    const bytes = await bytesOf(video.read(0, 12 * MB, live()));
    expect(bytes.length).toBe(12 * MB + 1);
    expect(bytes.every((b, i) => b === (i & 0xff))).toBe(true);
    expect(video.broken()).toBe(false);
    await vi.waitFor(() => expect(left).toBe(1));
    video.close();
  });

  it("is broken, not spinning, when a read ahead fails on its only stream", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    // The SDK's stream stays errored once a read has failed.
    let reads = 0;
    const read = one.stream.read;
    one.stream.read = async (n: number) => {
      if (++reads > 1) throw new Error("stream errored");
      return read(n);
    };
    const first = await bytesOf(video.read(0, 100, live()));
    expect(first.length).toBe(101);
    await vi.waitFor(() => expect(video.broken()).toBe(true));
    expect(reads).toBeLessThan(10);
  });

  it("reads nothing for a place the player left while it waited, and serves the newest first", async () => {
    const { stream, log } = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", stream, () => {});
    const first = bytesOf(video.read(0, 100, live()));
    // Two places asked for while the one stream is busy; the player leaves the first.
    const left = new AbortController();
    const skipped = bytesOf(video.read(40 * MB, 40 * MB + 10, left.signal));
    const wanted = bytesOf(video.read(52 * MB, 52 * MB + 10, live()));
    left.abort();
    expect((await skipped).length).toBe(0);
    expect((await wanted)[0]).toBe((52 * MB) & 0xff);
    await first;
    expect(log.seeks).not.toContain(40 * MB);
    video.close();
  });

  it("serves a live ask whose block the asks before it gave up on", async () => {
    const video = new SeekingVideo(64 * MB, "video/mp4", seekable(64 * MB).stream, () => {});
    const busy = bytesOf(video.read(0, 100, live()));
    const leaving = [new AbortController(), new AbortController(), new AbortController()];
    const gaveUp = leaving.map((c, i) => bytesOf(video.read(40 * MB + i * 1000, 40 * MB + i * 1000 + 10, c.signal)));
    const stays = bytesOf(video.read(40 * MB + 5000, 40 * MB + 5010, live()));
    for (const c of leaving) {
      c.abort();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(gaveUp);
    const bytes = await stays;
    expect(bytes.length).toBe(11);
    expect(bytes[0]).toBe((40 * MB + 5000) & 0xff);
    await busy;
    expect(video.broken()).toBe(false);
    video.close();
  });

  it("lets a lane added after it closed go at once", () => {
    const video = new SeekingVideo(20 * MB, "video/mp4", seekable(20 * MB).stream, () => {});
    video.close();
    let left = 0;
    expect(video.addLane(seekable(20 * MB).stream, () => left++)).toBeNull();
    expect(left).toBe(1);
  });

  /** A downloader of its own, as `openDownloader` hands it out, counting how its slot goes back. */
  function opened(stream: () => unknown) {
    const given = { unused: 0, stopped: 0 };
    return {
      given,
      downloader: { getSeekableStream: stream },
      unused: () => given.unused++,
      stop: () => given.stopped++,
    };
  }

  it("has read its first block when it starts, and gives its slot back when closed", async () => {
    const { stream, log } = seekable(20 * MB);
    const o = opened(() => stream);
    const video = source(await startSeeking(o, 20 * MB, "video/mp4", live()));
    expect(log.seeks[0]).toBe(0);
    expect(log.reads).toBeGreaterThanOrEqual(1);
    video.close!();
    expect(o.given).toEqual({ unused: 0, stopped: 1 });
  });

  it("is not played for a file with no block sizes on record, and its slot goes back", async () => {
    const o = opened(() => {
      throw new Error("Revision does not have defined claimed block sizes");
    });
    expect(await startSeeking(o, 500 * MB, "video/mp4", live())).toBe(NOT_STREAMABLE);
    expect(o.given).toEqual({ unused: 1, stopped: 0 });
  });

  it("is not answered when its first block fails, and its slot goes back", async () => {
    const { stream, fail } = seekable(20 * MB);
    fail(0);
    const o = opened(() => stream);
    expect(await startSeeking(o, 20 * MB, "video/mp4", live())).toBeNull();
    expect(o.given.stopped).toBe(1);
  });
});
