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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTLE_MS, ScrollSpeed } from "./scrollSpeed";

describe("how fast the list moves", () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => vi.useRealTimers());

  /** One scroll step `dt` ms after the last, to `top`. */
  const step = (s: ScrollSpeed, top: number, dt = 16) => {
    now += dt;
    s.step(top);
  };

  it("reads a fling as fast and a slow scroll as not", () => {
    const slow = new ScrollSpeed(4000, () => {}, () => now);
    for (let i = 1; i <= 10; i++) step(slow, i * 16);
    expect(slow.isFast()).toBe(false);

    const fling = new ScrollSpeed(4000, () => {}, () => now);
    for (let i = 1; i <= 10; i++) step(fling, i * 200);
    expect(fling.isFast()).toBe(true);
  });

  it("does not take one long frame for a fling", () => {
    const s = new ScrollSpeed(4000, () => {}, () => now);
    step(s, 0);
    step(s, 600, 400);
    expect(s.isFast()).toBe(false);
  });

  it("says once when scrolling stops, and is slow again then", () => {
    const settled = vi.fn();
    const s = new ScrollSpeed(4000, settled, () => now);
    for (let i = 1; i <= 10; i++) step(s, i * 200);
    expect(s.moving()).toBe(true);
    // Steps keep coming: the timer waits on until they stop.
    now += SETTLE_MS / 2;
    vi.advanceTimersByTime(SETTLE_MS / 2);
    step(s, 2400);
    now += SETTLE_MS / 2;
    vi.advanceTimersByTime(SETTLE_MS / 2);
    expect(settled).not.toHaveBeenCalled();
    now += SETTLE_MS;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(s.moving()).toBe(false);
    expect(s.isFast()).toBe(false);
  });
});
