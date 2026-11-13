/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { unwarmedBatches } from "./warmBatches";

describe("the thumbnail warmer's batches", () => {
  it("goes through the library in order, a batch at a time", () => {
    expect([...unwarmedBatches(["a", "b", "c", "d", "e"], new Set(), 2)]).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("carries on past what an earlier pass warmed", () => {
    expect([...unwarmedBatches(["a", "b", "c", "d", "e"], new Set(["a", "b", "d"]), 2)]).toEqual([["c", "e"]]);
  });

  it("leaves out a uid warmed while the pass is under way", () => {
    const warmed = new Set<string>();
    const batches = unwarmedBatches(["a", "b", "c", "d"], warmed, 2);
    expect(batches.next().value).toEqual(["a", "b"]);
    warmed.add("c");
    expect(batches.next().value).toEqual(["d"]);
    expect(batches.next().done).toBe(true);
  });

  it("gives nothing once everything is warm", () => {
    expect([...unwarmedBatches(["a"], new Set(["a"]), 4)]).toEqual([]);
  });
});
