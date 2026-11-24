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

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: vi.fn() }));
vi.mock("./lightboxSignal", () => ({ isLightboxOpen: () => false }));
vi.mock("./platform", () => ({ isLinux: true }));
vi.mock("./thumbStore", () => ({
  thumbServerUp: vi.fn(() => true),
  thumbsMade: vi.fn(),
  videoFrameUrl: (uid: string) => `http://127.0.0.1:1/t/tok/${uid}/vf`,
}));

import { invoke } from "@tauri-apps/api/core";
import { rpc } from "./rpc";
import { thumbServerUp, thumbsMade } from "./thumbStore";
import { repairRound } from "./thumbRepair";

/** The sidecar's answers: `uids` to draw, and `stored` once handed back. */
function sidecar(uids: string[], stored: string[]) {
  vi.mocked(rpc).mockImplementation(async (method: string) => {
    if (method === "thumblessVideos") return { uids };
    if (method === "putLocalThumbnails") return { stored };
    throw new Error(method);
  });
}

beforeEach(() => {
  vi.mocked(rpc).mockReset();
  vi.mocked(invoke).mockReset();
  vi.mocked(thumbsMade).mockReset();
  vi.mocked(thumbServerUp).mockReturnValue(true);
});

describe("a round of thumbnails drawn here", () => {
  it("hands back what was drawn, what cannot be, and what may be tried again, and redraws the tiles", async () => {
    sidecar(["a", "b", "c"], ["a"]);
    vi.mocked(invoke).mockResolvedValue({ frames: { a: "/tmp/pfp-frame/frame-1.jpg" }, failed: { b: "decode", c: "timeout" } });
    expect(await repairRound(() => true)).toBe(3);
    expect(invoke).toHaveBeenCalledWith("thumb_frames", {
      items: ["a", "b", "c"].map((uid) => ({ uid, url: `http://127.0.0.1:1/t/tok/${uid}/vf` })),
    });
    expect(rpc).toHaveBeenLastCalledWith("putLocalThumbnails", {
      frames: { a: "/tmp/pfp-frame/frame-1.jpg" },
      undrawable: ["b"],
      letGo: ["c"],
      roundOver: true,
    });
    expect(thumbsMade).toHaveBeenCalledWith(["a"]);
  });

  it("lets every one go when the host could not be asked", async () => {
    sidecar(["a"], []);
    vi.mocked(invoke).mockRejectedValue(new Error("gone"));
    await repairRound(() => true);
    expect(rpc).toHaveBeenLastCalledWith("putLocalThumbnails", { frames: {}, undrawable: [], letGo: ["a"], roundOver: true });
    expect(thumbsMade).not.toHaveBeenCalled();
  });

  it("still hands frames back after a lock began, so they are deleted, but redraws nothing", async () => {
    let open = true;
    sidecar(["a"], ["a"]);
    vi.mocked(invoke).mockImplementation(async () => {
      open = false;
      return { frames: { a: "/tmp/pfp-frame/frame-1.jpg" }, failed: {} };
    });
    await repairRound(() => open);
    expect(rpc).toHaveBeenLastCalledWith("putLocalThumbnails", expect.objectContaining({ roundOver: false }));
    expect(thumbsMade).not.toHaveBeenCalled();
  });

  it("asks for nothing before the server is up, or when nothing is waiting", async () => {
    vi.mocked(thumbServerUp).mockReturnValue(false);
    expect(await repairRound(() => true)).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    vi.mocked(thumbServerUp).mockReturnValue(true);
    sidecar([], []);
    expect(await repairRound(() => true)).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
