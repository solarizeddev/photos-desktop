/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, expect, it } from "vitest";

import { ALIGNED } from "./faceAlign.ts";
import { aucOf, insightInput, overlap, separation, spreadOverYears, type Sample } from "./faceCompare.ts";
import type { FaceRecord } from "./faceStore.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

describe("the separation numbers", () => {
  it("rank pairs: all above is 1, all below is 0, the same is a half", () => {
    expect(aucOf([3, 4], [1, 2])).toBe(1);
    expect(aucOf([1, 2], [3, 4])).toBe(0);
    expect(aucOf([1, 1], [1, 1])).toBe(0.5);
    expect(aucOf([2, 3], [1, 2.5])).toBeCloseTo(0.75);
  });

  /** Two people `apart` from each other, `n` faces each, from one model. */
  function twoPeople(apart: number, n = 60, spread = 0.5): Sample[] {
    const rand = seeded(5);
    const a = direction(rand);
    const b = faceOf(a, rand, apart);
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ side: "a", year: 2020 + (i % 3), byModel: new Map([["m", faceOf(a, rand, spread)]]) });
      out.push({ side: "b", year: 2020 + (i % 3), byModel: new Map([["m", faceOf(b, rand, spread)]]) });
    }
    return out;
  }

  it("tell two different people apart, and say two copies of one are not", () => {
    const apart = separation(twoPeople(1.5), "m");
    expect(apart.faces).toEqual({ a: 60, b: 60 });
    expect(apart.auc).toBeGreaterThan(0.99);
    expect(apart.nearest).toBeGreaterThan(0.95);
    expect(apart.nearestSameAge).toBeGreaterThan(0.95);
    expect(apart.clearRight).toBeGreaterThan(0.9);
    expect(apart.clearWrong).toBe(0);
    const one = separation(twoPeople(0), "m");
    expect(one.auc).toBeLessThan(0.6);
    expect(one.dPrime).toBeLessThan(0.3);
    expect(one.nearest).toBeLessThan(0.65);
  });

  it("rank a lookalike between the two", () => {
    const close = separation(twoPeople(0.4), "m");
    expect(close.auc).toBeGreaterThan(0.6);
    expect(close.auc).toBeLessThan(separation(twoPeople(1.5), "m").auc);
  });

  it("do not count a burst's frames as each other's nearest", () => {
    // Two people too alike to tell apart, each face shot twice in a burst.
    const rand = seeded(9);
    const a = direction(rand);
    const out: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      const v = faceOf(a, rand, 0.5);
      const side = i % 2 ? "a" : "b";
      const twin = faceOf(v, rand, 0.05);
      out.push({ side, year: 2020, uid: `p${i}`, at: i * 3_600_000, byModel: new Map([["m", v]]) });
      out.push({ side, year: 2020, uid: `p${i}b`, at: i * 3_600_000 + 1000, byModel: new Map([["m", twin]]) });
    }
    expect(separation(out, "m").nearest).toBeLessThan(0.7);
    // Without the moments, the twins make it look perfect.
    const blind = out.map((s) => ({ ...s, uid: undefined, at: undefined }));
    expect(separation(blind, "m").nearest).toBeGreaterThan(0.95);
  });

  it("say nothing of one person alone", () => {
    const one = twoPeople(1.5, 20).filter((s) => s.side === "a");
    const r = separation(one, "m");
    expect(r.auc).toBeNaN();
    expect(r.cross).toBeNaN();
    expect(r.clearRight).toBeNaN();
    expect(r.nearestSameAge).toBeNull();
  });

  it("leave out faces a model has no embedding for", () => {
    const samples = twoPeople(1.5, 10);
    samples[0].byModel.delete("m");
    expect(separation(samples, "m").faces).toEqual({ a: 9, b: 10 });
  });
});

describe("matching a face found again", () => {
  it("measures box overlap", () => {
    expect(overlap([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(overlap([0, 0, 1, 1], [2, 2, 3, 3])).toBe(0);
    expect(overlap([0, 0, 2, 1], [1, 0, 3, 1])).toBeCloseTo(1 / 3);
  });
});

describe("the sample", () => {
  const face = (id: string, score: number): FaceRecord => ({
    id,
    uid: id.split("#")[0],
    box: [0, 0, 1, 1],
    points: [],
    score,
    blur: 100,
    sideways: 0,
    embedding: new Float32Array(1),
  });

  it("takes a turn per year, newest first and clearest first, undated last", () => {
    const years: Record<string, number | null> = { x1: 2026, x2: 2026, x3: 2024, x4: 2024, x5: null };
    const faces = [face("x1#0", 0.7), face("x2#0", 0.9), face("x3#0", 0.8), face("x4#0", 0.6), face("x5#0", 0.99)];
    const pick = spreadOverYears(faces, (f) => years[f.uid], 4).map((f) => f.uid);
    expect(pick).toEqual(["x2", "x3", "x5", "x1"]);
    expect(spreadOverYears(faces, (f) => years[f.uid], 99)).toHaveLength(5);
  });
});

describe("InsightFace's input", () => {
  it("is in planes, red, green, blue, each (x - 127.5) / 127.5", () => {
    const aligned = new Uint8Array(ALIGNED * ALIGNED * 3);
    aligned.set([255, 0, 127.5 | 0], 0);
    const input = insightInput(aligned);
    const plane = ALIGNED * ALIGNED;
    expect(input).toHaveLength(plane * 3);
    expect(input[0]).toBeCloseTo(1);
    expect(input[plane]).toBeCloseTo(-1);
    expect(input[2 * plane]).toBeCloseTo((127 - 127.5) / 127.5);
  });
});
