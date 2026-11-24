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

import { describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

const BIG = 151 * 1024 * 1024;
vi.mock("./offline.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./offline.ts")>()),
  isOfflineReady: (uid: string) => uid.startsWith("kept"),
}));
vi.mock("./store.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store.ts")>()),
  originalSize: (uid: string) => (uid === "kept-big" ? BIG : uid === "kept-small" ? 4 : null),
  originalGet: (uid: string) => (uid === "kept-small" ? Buffer.from([1, 2, 3, 4]) : null),
  metaGet: () => ({ mediaType: "video/mp4" }),
}));

import { ProtonSession } from "./session.ts";
import { NOT_STREAMABLE, type VideoSource } from "./videoStream.ts";

/** A session signed in to a Proton that counts what is asked of it. */
function signedIn(node: { mediaType: string }, claimed: number) {
  const session = new ProtonSession();
  const asked = { nodes: 0, downloaders: 0, released: 0 };
  (session as any).photos = {
    async getNode() {
      asked.nodes++;
      return node;
    },
    async getFileDownloader() {
      asked.downloaders++;
      return {
        getClaimedSizeInBytes: () => claimed,
        downloadToStream() {
          asked.released++;
          return { completion: async () => {} };
        },
      };
    },
  };
  const videos = (session as any).videos as { get(uid: string): Promise<unknown> };
  return { session, asked, videos };
}

describe("the video the viewer streams", () => {
  it("never downloads a video kept offline that is too large to hold, and refuses it", async () => {
    const { session, asked, videos } = signedIn({ mediaType: "video/mp4" }, 1000);
    expect(await videos.get("kept-big")).toBe(NOT_STREAMABLE);
    expect(asked).toEqual({ nodes: 0, downloaders: 0, released: 0 });
    expect(session.videoNotStreamable("kept-big")).toBe(true);
  });

  it("plays a small one kept offline from the disk", async () => {
    const { asked, videos } = signedIn({ mediaType: "video/mp4" }, 1000);
    const v = (await videos.get("kept-small")) as VideoSource;
    expect(v.size).toBe(4);
    expect(asked.nodes).toBe(0);
  });

  it("refuses one that is not a video, or whose size Proton does not give, giving its slot back", async () => {
    const photo = signedIn({ mediaType: "image/jpeg" }, 1000);
    expect(await photo.videos.get("p")).toBe(NOT_STREAMABLE);
    const unsized = signedIn({ mediaType: "video/mp4" }, 0);
    expect(await unsized.videos.get("u")).toBe(NOT_STREAMABLE);
    expect(unsized.asked.released).toBe(1);
    // Asked again, it is refused without a second lookup.
    expect(await unsized.videos.get("u")).toBe(NOT_STREAMABLE);
    expect(unsized.asked.nodes).toBe(1);
    expect(unsized.session.videoNotStreamable("u")).toBe(true);
  });
});

describe("a video too large to hold whole", () => {
  const LARGE = 400 * 1024 * 1024;

  /**
   * A session whose Proton has a large video behind seekable streams, each holding a slot
   * until its downloader's signal fires, as the SDK's do; `blockSizes` false for an old file.
   */
  function large(blockSizes = true) {
    const session = new ProtonSession();
    const asked = { downloaders: 0, inUse: 0, whole: 0 };
    (session as any).photos = {
      getNode: async () => ({ mediaType: "video/mp4" }),
      async getFileDownloader(_uid: string, signal: AbortSignal) {
        asked.downloaders++;
        asked.inUse++;
        return {
          getClaimedSizeInBytes: () => LARGE,
          downloadToStream() {
            asked.whole++;
            asked.inUse--;
            return { completion: async () => {} };
          },
          getSeekableStream() {
            if (!blockSizes) throw new Error("Revision does not have defined claimed block sizes");
            signal.addEventListener("abort", () => asked.inUse--, { once: true });
            let at = 0;
            return {
              seek: (p: number) => void (at = p),
              async read(n: number) {
                const value = new Uint8Array(n);
                for (let i = 0; i < n; i++) value[i] = (at + i) & 0xff;
                return { value, done: false };
              },
            };
          },
        };
      },
    };
    const videos = (session as any).videos as { get(uid: string): Promise<unknown>; clear(): void };
    return { session, asked, videos };
  }

  it("is read a block at a time, on up to three streams, each slot back when it closes", async () => {
    const { asked, videos } = large();
    const v = (await videos.get("big")) as VideoSource;
    expect(v.size).toBe(LARGE);
    const parts: Uint8Array[] = [];
    for await (const piece of v.read(LARGE - 10, LARGE - 1, new AbortController().signal)) parts.push(piece);
    expect(Array.from(Buffer.concat(parts))).toEqual(Array.from({ length: 10 }, (_, i) => (LARGE - 10 + i) & 0xff));
    await vi.waitFor(() => expect(asked.downloaders).toBe(3));
    expect(asked.whole).toBe(0);
    videos.clear();
    await vi.waitFor(() => expect(asked.inUse).toBe(0));
  });

  it("is refused when it is an old file that cannot be read that way, its slot given back", async () => {
    const { session, asked, videos } = large(false);
    expect(await videos.get("old")).toBe(NOT_STREAMABLE);
    expect(session.videoNotStreamable("old")).toBe(true);
    await vi.waitFor(() => expect(asked.inUse).toBe(0));
  });
});
