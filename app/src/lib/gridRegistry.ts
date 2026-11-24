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

/**
 * What a grid drawn on a canvas tells the rest of the page about its tiles, which have no
 * elements to look up: where they are, for the rubber band, and how many are on screen and
 * drawn, for the scroll measurement. By the scroll area the grid is in.
 */

/** A tile's box: left and right in the window's coordinates, top and bottom in the scroll area's content (window y + scrollTop). */
export type CellBox = { uid: string; left: number; right: number; top: number; bottom: number };

export type DrawnGrid = {
  /** The tiles with any part between `y1` and `y2` (content coordinates, as in CellBox). */
  cells(y1: number, y2: number): CellBox[];
  /** Tiles on screen now, and how many of them show their picture. */
  onScreen(): { tiles: number; shown: number; width: number };
  /** How its thumbnails are decoded, for the measurement's log. */
  kind(): string;
};

const grids = new WeakMap<Element, DrawnGrid>();

export function registerDrawnGrid(scroller: Element, grid: DrawnGrid): () => void {
  grids.set(scroller, grid);
  return () => {
    if (grids.get(scroller) === grid) grids.delete(scroller);
  };
}

export function drawnGridIn(scroller: Element | null | undefined): DrawnGrid | undefined {
  return scroller ? grids.get(scroller) : undefined;
}
