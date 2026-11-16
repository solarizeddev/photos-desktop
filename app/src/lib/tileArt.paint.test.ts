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

import { paintTile, pileEdges, type Palette } from "./tileArt";
import type { TileBadges } from "./tileBadges";

/** A context that notes what is drawn, and the colour each rounded rect is filled with. */
function recorder() {
  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  const images: number[][] = [];
  let pending: { x: number; y: number; w: number; h: number } | null = null;
  const ctx: any = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clip() {},
    fillRect() {},
    beginPath() {
      pending = null;
    },
    roundRect(x: number, y: number, w: number, h: number) {
      pending = { x, y, w, h };
    },
    fill() {
      if (pending) rects.push({ ...pending, fill: String(ctx.fillStyle) });
    },
    stroke() {},
    arc() {},
    drawImage(_img: unknown, ...args: number[]) {
      images.push(args);
    },
  };
  return { ctx, rects, images };
}

const palette: Palette = { bg: "bg", bg2: "bg2", accent: "acc", synced: "ok", font: "f", edgeNear: "near", edgeFar: "far" };
const marks = (stack: number | null): TileBadges => ({
  play: false,
  offline: false,
  durationMs: null,
  local: false,
  favorite: false,
  type: null,
  stack,
});
const picture = { width: 300, height: 300 } as unknown as ImageBitmap;

describe("a burst's tile", () => {
  it("stands on two frame edges when large enough, its picture moved in to the front one", () => {
    const { ctx, rects, images } = recorder();
    paintTile(ctx, 1, palette, null, 0, 0, 150, 150, picture, marks(12), { selected: false, hovered: false });
    // Far, a sliver of page, near, a sliver of page, all inside the 150 px cell.
    expect(rects.map((r) => r.fill)).toEqual(["far", "bg", "near", "bg"]);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(150);
      expect(r.y + r.h).toBeLessThanOrEqual(150);
    }
    // Drawn into the front frame: 6 px narrower and lower than the cell.
    expect(images[0].slice(-4)).toEqual([0, 6, 144, 144]);
  });

  it("crops a picture cut for the whole cell rather than shrinking it", () => {
    const { ctx, images } = recorder();
    const cut = { width: 150, height: 150 } as unknown as ImageBitmap;
    paintTile(ctx, 1, palette, null, 0, 0, 150, 150, cut, marks(5), { selected: false, hovered: false });
    expect(images[0]).toEqual([3, 3, 144, 144, 0, 6, 144, 144]);
  });

  it("orders its edges by how far they stand from the page, in either theme", () => {
    expect(pileEdges("#090909", "#3a3a3c", "#2c2c2e")).toEqual({ edgeNear: "#3a3a3c", edgeFar: "#2c2c2e" });
    expect(pileEdges("rgb(251, 251, 252)", "#e2e2e5", "#d8d8dc")).toEqual({ edgeNear: "#d8d8dc", edgeFar: "#e2e2e5" });
  });

  it("keeps the plain tile when small, and when it is no stack", () => {
    for (const [size, stack] of [
      [90, 12],
      [150, null],
    ] as const) {
      const { ctx, rects } = recorder();
      // No picture: a plain tile's corners are stamped with a page canvas, which a test has not.
      paintTile(ctx, 1, palette, null, 0, 0, size, size, undefined, marks(stack), { selected: false, hovered: false });
      expect(rects.some((r) => r.fill === "far" || r.fill === "near")).toBe(false);
    }
  });
});
