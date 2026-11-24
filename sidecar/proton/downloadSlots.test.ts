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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SDK_SLOTS, lendSlot, openDownloader, slotsHeld } from "./downloadSlots.ts";
import { getOriginal, getVideo, releaseOriginal } from "./download.ts";
import { downloadWhole } from "./viewerMeta.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A photos client with the SDK's download slots as the SDK has them: five, taken when a
 * downloader is made (waiting, until its signal fires, while all are taken), and given back
 * only in the `finally` of a download of it, which fails at once if its signal has fired.
 */
function slotClient(opts: { claimed?: number; bytes?: number; setupMs?: number; mediaType?: string } = {}) {
  const { claimed = 64, bytes = 64, setupMs = 0, mediaType = "image/jpeg" } = opts;
  const slots = { inUse: 0, written: 0 };
  return {
    slots,
    getNode: async (uid: string) => ({ uid, name: { ok: true, value: `${uid}.jpg` }, mediaType }),
    async getFileDownloader(_uid: string, signal?: AbortSignal) {
      while (slots.inUse >= 5) {
        if (signal?.aborted) throw new Error("AbortError");
        await sleep(2);
      }
      slots.inUse++;
      await sleep(setupMs);
      return {
        getClaimedSizeInBytes: () => claimed,
        // As the SDK's: the slot goes back once, when the downloader's signal fires.
        getSeekableStream() {
          signal?.addEventListener("abort", () => slots.inUse--, { once: true });
          return { seek() {}, read: async () => ({ value: new Uint8Array(0), done: true }) };
        },
        downloadToStream(stream: WritableStream<Uint8Array>) {
          const completion = (async () => {
            try {
              if (signal?.aborted) throw new Error("AbortError");
              const writer = stream.getWriter();
              await writer.write(new Uint8Array(bytes).fill(7));
              slots.written++;
              await writer.close();
            } finally {
              slots.inUse--;
            }
          })();
          return { completion: () => completion };
        },
      };
    },
  };
}

describe("a downloader that is not used", () => {
  it("gives its slot back without downloading anything", async () => {
    const client = slotClient();
    const { unused } = await openDownloader(client, "u");
    expect(client.slots.inUse).toBe(1);
    unused();
    unused(); // a second call gives nothing back twice
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
    expect(client.slots.written).toBe(0);
  });

  it("leaves a download already under way alone", async () => {
    const client = slotClient();
    const { downloader, unused } = await openDownloader(client, "u");
    const run = downloader.downloadToStream(new WritableStream()).completion();
    unused();
    await run;
    expect(client.slots.written).toBe(1);
    expect(client.slots.inUse).toBe(0);
  });

  it("keeps the caller's signal: a fired one stops the download", async () => {
    const client = slotClient();
    const caller = new AbortController();
    const { downloader } = await openDownloader(client, "u", caller.signal);
    caller.abort();
    await expect(downloader.downloadToStream(new WritableStream()).completion()).rejects.toThrow();
    expect(client.slots.inUse).toBe(0);
  });

  it("stop gives back the slot of one never downloaded", async () => {
    const client = slotClient();
    (await openDownloader(client, "u")).stop();
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
    expect(client.slots.written).toBe(0);
  });

  it("five left unused do not stop the sixth download", async () => {
    const client = slotClient();
    for (let i = 0; i < 5; i++) (await openDownloader(client, `u${i}`)).unused();
    const { downloader } = await openDownloader(client, "next");
    await downloader.downloadToStream(new WritableStream()).completion();
    expect(client.slots.inUse).toBe(0);
  });
});

describe("the paths that made a downloader and then did not download", () => {
  beforeEach(() => releaseOriginal());

  it("the viewer stepping on while a photo's original was being set up", async () => {
    const client = slotClient({ setupMs: 20 });
    // Twenty photos stepped through faster than each downloader is made.
    for (let i = 0; i < 20; i++) {
      await getOriginal(client, `p${i}`);
      await sleep(1);
      releaseOriginal(`p${i}`);
    }
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0), { timeout: 3000 });
  });

  it("a video over the size cap", async () => {
    const client = slotClient({ claimed: 500 * 1024 * 1024, mediaType: "video/mp4" });
    for (let i = 0; i < 8; i++) await expect(getVideo(client, `v${i}`)).rejects.toThrow("VIDEO_TOO_LARGE");
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });

  it("a whole-file read over its cap", async () => {
    const client = slotClient({ claimed: 2048 });
    for (let i = 0; i < 8; i++) expect(await downloadWhole(client, `w${i}`, 1024)).toBeNull();
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });
});

describe("a downloader read through its seekable stream", () => {
  it("is counted until stopped, and stopping it gives its slot back once", async () => {
    const client = slotClient();
    const before = slotsHeld();
    const opened = await openDownloader(client, "v");
    opened.downloader.getSeekableStream();
    expect(slotsHeld()).toBe(before + 1);
    opened.unused(); // a stream under way is not a downloader left unused
    expect(client.slots.inUse).toBe(1);
    opened.stop();
    opened.stop();
    await sleep(5);
    expect(client.slots.inUse).toBe(0);
    expect(slotsHeld()).toBe(before);
  });

  it("makes no stream once its signal has fired, and its slot goes back unused", async () => {
    const client = slotClient();
    const caller = new AbortController();
    const opened = await openDownloader(client, "v", caller.signal);
    caller.abort();
    expect(() => opened.downloader.getSeekableStream()).toThrow();
    opened.unused();
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });
});

describe("a slot lent to a video's read lane", () => {
  it("comes back when another download finds every slot taken, but not for another lane", async () => {
    const client = slotClient();
    const full: Array<{ unused(): void }> = [];
    while (slotsHeld() < SDK_SLOTS) full.push(await openDownloader(client, `full${full.length}`));
    let given = 0;
    const unlend = lendSlot(() => given++);
    // Another lane does not take it.
    const lane = await openDownloader(slotClient(), "lane", undefined, { borrow: true });
    expect(given).toBe(0);
    // Anything else does.
    const save = await openDownloader(slotClient(), "save");
    expect(given).toBe(1);
    unlend();
    for (const o of [...full, lane, save]) o.unused();
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });

  it("comes back for a download that waits a while, however few slots are counted", async () => {
    vi.useFakeTimers();
    try {
      let given = 0;
      const unlend = lendSlot(() => given++);
      let made!: () => void;
      const slow = {
        getFileDownloader: () => new Promise((resolve) => (made = () => resolve({}))),
      };
      const opening = openDownloader(slow, "save");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(given).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(given).toBe(1);
      made();
      (await opening).unused();
      unlend();
    } finally {
      vi.useRealTimers();
    }
  });
});
