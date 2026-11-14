/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { dot, FACE_CLUSTER_MERGE_THRESHOLD } from "./faceCluster.ts";
import { curationKey, regroupAll } from "./facePeople.ts";
import { applySplit, planSplit, splitStart, undoSplit } from "./faceSplit.ts";
import { FaceStore, type FaceRecord } from "./faceStore.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-split-")));
  setDataKey(randomBytes(32));
});

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  return v.map((x) => x / Math.sqrt(n));
}

const face = (uid: string, index: number, embedding: Float32Array, score = 0.9): FaceRecord => ({
  id: `${uid}#${index}`,
  uid,
  box: [0.1 + index * 0.4, 0.1, 0.3 + index * 0.4, 0.4],
  points: [],
  score,
  blur: 100,
  sideways: 0,
  embedding,
});

/**
 * Two siblings put together as one person, "Alex", every face confirmed as Alex the way naming
 * a group confirms it: `alex` and `sam` photos of one each, and `both` photos with the two.
 * `apart` is how far Sam's identity is from Alex's: small is a lookalike, 0 a twin.
 */
function merged(apart: number, alex = 120, sam = 90, both = 6) {
  const rand = seeded(7);
  const a = direction(rand);
  const b = unit(a.map((x, i) => x + apart * (direction(rand)[i] ?? 0)));
  const store = new FaceStore();
  store.load();
  const p = store.people;
  p.people.push({ id: "pA", name: "Alex", isOther: false });
  const truth = new Map<string, "a" | "b">();
  const put = (uid: string, faces: FaceRecord[]) => {
    store.put(uid, faces);
    for (const f of faces) {
      p.assign[f.id] = "pA";
      p.confirmed[f.id] = "Alex";
    }
  };
  for (let i = 0; i < alex; i++) {
    const f = face(`vol~a${i}`, 0, faceOf(a, rand, 0.55));
    put(f.uid, [f]);
    truth.set(f.id, "a");
  }
  for (let i = 0; i < sam; i++) {
    const f = face(`vol~b${i}`, 0, faceOf(b, rand, 0.55));
    put(f.uid, [f]);
    truth.set(f.id, "b");
  }
  for (let i = 0; i < both; i++) {
    const uid = `vol~ab${i}`;
    const fa = face(uid, 0, faceOf(a, rand, 0.55));
    const fb = face(uid, 1, faceOf(b, rand, 0.55));
    put(uid, [fa, fb]);
    truth.set(fa.id, "a");
    truth.set(fb.id, "b");
  }
  p.grouped = true;
  return { store, truth, a, b };
}

const pick = (truth: Map<string, "a" | "b">, side: "a" | "b", n: number) =>
  [...truth].filter(([, s]) => s === side).slice(0, n).map(([id]) => id);

describe("siblings grouped as one person", () => {
  it("really are one group to the grouping's own rule", () => {
    const { a, b } = merged(0.6);
    expect(dot(a, b)).toBeGreaterThan(FACE_CLUSTER_MERGE_THRESHOLD);
  });

  it("are split apart from five faces of each", async () => {
    const { store, truth } = merged(0.6);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) });
    expect(plan.verdict).toBe("reliable");
    let wrong = 0;
    // Every face sorted to a side is on the right one; the rest wait for the user.
    const sides = new Map<string, string>();
    for (const f of plan.leastSureA) sides.set(f.faceId, "a");
    for (const f of plan.leastSureB) sides.set(f.faceId, "b");
    for (const [id, s] of sides) if (truth.get(id) !== s) wrong++;
    expect(wrong).toBe(0);
    expect(plan.counts.a + plan.counts.b).toBeGreaterThan(truth.size * 0.8);
    expect(plan.counts.neither).toBe(0);
  });

  it("keep two faces of one photo apart", async () => {
    const { store, truth } = merged(0.6);
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    expect(applied.moved).toBeGreaterThan(0);
    const p = store.people;
    for (let i = 0; i < 6; i++) {
      const left = p.assign[`vol~ab${i}#0`];
      const right = p.assign[`vol~ab${i}#1`];
      if (p.confirmed[`vol~ab${i}#0`] && p.confirmed[`vol~ab${i}#1`]) expect(left).not.toBe(right);
    }
  });

  it("stay split through a regroup, by the confirmations and marks the split leaves", async () => {
    const { store, truth } = merged(0.6);
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    const p = store.people;
    const sam = p.people.find((x) => x.name === "Sam")!;
    const moved = Object.entries(p.assign).filter(([, id]) => id === sam.id).map(([id]) => id);
    // The examples picked for Sam are among the faces moved.
    expect(moved.length).toBe(applied.moved);
    for (const id of moved.filter((id) => !pick(truth, "b", 5).includes(id))) {
      expect(p.confirmed[id]).toBe("Sam");
      expect(p.blocked[id]).toContain("Alex");
      expect(p.curation[curationKey(2, "Alex", id.slice(id.indexOf("~") + 1))]).toMatchObject({ removed: false, at: 50 });
    }
    await regroupAll(store);
    const samAfter = store.people.people.find((x) => x.name === "Sam")!;
    const after = Object.entries(store.people.assign).filter(([, id]) => id === samAfter.id).map(([id]) => id);
    expect(after.sort()).toEqual(moved.sort());
  });

  it("go back as they were on undo, with the marks taken back for the other device", async () => {
    const { store, truth } = merged(0.6);
    const before = JSON.stringify({ assign: store.people.assign, confirmed: store.people.confirmed });
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    expect(undoSplit(store, applied.undo, 60)).toBe(true);
    const p = store.people;
    expect(JSON.stringify({ assign: p.assign, confirmed: p.confirmed })).toBe(before);
    expect(Object.keys(p.blocked)).toEqual([]);
    expect(p.people.some((x) => x.name === "Sam")).toBe(false);
    const marks = Object.values(p.curation).filter((c) => c.kind === 2);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((c) => c.removed && c.at === 60)).toBe(true);
    expect(undoSplit(store, applied.undo, 70)).toBe(false);
  });
});

describe("twins", () => {
  it("are said to be too alike to split reliably, and mostly left for the user", async () => {
    const { store, truth } = merged(0);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) });
    expect(plan.verdict === "unreliable" || plan.verdict === "weak").toBe(true);
  });
});

describe("opening a split", () => {
  it("offers the photos with both, faces from both ends, and what another device said", () => {
    const { store, truth } = merged(0.6);
    const fromPhone = pick(truth, "b", 3);
    for (const id of fromPhone) store.people.conflicts[id] = { there: "Sam", device: "phone", at: 9 };
    const start = splitStart(store, "pA");
    expect(start.faces).toBe(truth.size);
    expect(start.pairs.length).toBe(6);
    expect(start.contrast.length).toBe(16);
    // The two ends are the two siblings: the alternating picks come from both.
    const ends = new Set(start.contrast.slice(0, 4).map((f) => truth.get(f.faceId)));
    expect(ends).toEqual(new Set(["a", "b"]));
    expect(start.elsewhere.map((e) => e.name)).toEqual(["Sam"]);
    expect([...start.elsewhere[0].faceIds].sort()).toEqual([...fromPhone].sort());
  });

  it("is refused for the leftovers, and for the person's own name as the other", async () => {
    const { store, truth } = merged(0.6);
    store.people.people.push({ id: "pX", name: null, isOther: true });
    expect(() => splitStart(store, "pX")).toThrow();
    await expect(planSplit(store, "pA", "alex", { a: pick(truth, "a", 1), b: pick(truth, "b", 1) })).rejects.toThrow();
    await expect(planSplit(store, "pA", "Sam", { a: [], b: pick(truth, "b", 1) })).rejects.toThrow();
  });
});
