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

import { describe, it, expect } from "vitest";
import { TAG } from "./tags";
import { badgeTier, tileBadges } from "./tileBadges";

const base = { tags: [] as number[], isVideo: false, durationMs: null, offline: false, local: false, tier: "all" as const, selectionMode: false, showBadges: true };

describe("a tile's marks", () => {
  it("shows every mark at the full tier", () => {
    const b = tileBadges({ ...base, tags: [TAG.Favorite, TAG.Raw, TAG.Video], isVideo: true, durationMs: 5000, offline: true, local: true });
    expect(b).toEqual({ play: true, offline: true, durationMs: 5000, local: true, favorite: true, type: "raw", stack: null });
  });

  it("shows a burst's stack and its count at every size", () => {
    expect(tileBadges({ ...base, tier: "minimal", stack: 12 }).stack).toBe(12);
    expect(tileBadges({ ...base, stack: 1 }).stack).toBeNull();
  });

  it("keeps one secondary beside the cloud at the compact tier, in Android's order", () => {
    const b = tileBadges({ ...base, tier: "compact", tags: [TAG.Favorite, TAG.Panorama], offline: true, local: true });
    expect(b).toMatchObject({ offline: true, favorite: false, type: null, local: true });
    const c = tileBadges({ ...base, tier: "compact", tags: [TAG.Favorite, TAG.Panorama] });
    expect(c).toMatchObject({ type: "panorama", favorite: false });
  });

  it("leaves the cloud alone at the smallest tier", () => {
    const b = tileBadges({ ...base, tier: "minimal", tags: [TAG.Favorite], offline: true, local: true });
    expect(b).toMatchObject({ offline: false, favorite: false, local: true });
  });

  it("puts the play icon and the length aside while selecting", () => {
    const b = tileBadges({ ...base, isVideo: true, durationMs: 5000, selectionMode: true, offline: true });
    expect(b).toMatchObject({ play: false, durationMs: null, offline: true });
  });

  it("reads the tier from the tile's width", () => {
    expect(badgeTier(120)).toBe("all");
    expect(badgeTier(90)).toBe("compact");
    expect(badgeTier(60)).toBe("minimal");
  });
});
