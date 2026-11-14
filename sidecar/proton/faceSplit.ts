/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * Splitting a person in two: two people who look alike (siblings, a parent and a grown child)
 * that the grouping put together.
 *
 * The grouping asks of every pair of faces one absolute question, "alike enough?", with one bar
 * for everyone (FACE_CLUSTER_THRESHOLD), and two lookalikes clear it. A split asks a relative
 * one instead: is this face closer to the faces the user said are A, or to those they said are
 * B? Two people can both clear the bar and still be consistently closer to themselves than to
 * each other, which is what this tells apart, with the same face numbers the scan made.
 *
 *   - The examples: the faces the user picks for each side, a person B already named (their
 *     confirmed faces), and what another device said about faces of this person (`conflicts`).
 *   - Each side's direction is the mean of its examples, refined over a few rounds with the
 *     faces that clearly lean that way; a face's margin is how much closer it is to A than B.
 *   - A face goes to a side when its margin is clear (a stricter bar for a weak face, as the
 *     grouping has) and its nearest examples agree. Otherwise it is unsure, and is not guessed:
 *     it stays with A, unconfirmed, for the user to answer. One that is near neither side at
 *     all goes to the leftovers.
 *   - Two faces in one photo are two people: if both lean the same way, the clearer one keeps
 *     that side and the other takes the other, or both are unsure when neither is clear.
 *   - How far to trust it: each example is left out in turn and sorted like the rest. If the
 *     examples do not land where the user put them, or few faces lean clearly, the result
 *     says the two look too alike to split reliably.
 *
 * Applied, the result is kept in the one form both this computer's regroup and the phone's
 * keep: the faces of each side confirmed as that side, and B's also marked as not A, with the
 * time, so the other device moves them too (see faceSync).
 */

import { randomBytes } from "node:crypto";
import { dot, FACE_SUGGEST_THRESHOLD } from "./faceCluster.ts";
import { isConfidentFace } from "./faceAlign.ts";
import { curationKey, foldPersonName, mint, noteCuration, otherPerson, personOf, portableFaceId } from "./facePeople.ts";
import type { Curation, FaceRecord, FaceStore, Person } from "./faceStore.ts";

/** A face as the window shows one: its photo and where it sits. */
export type SplitFace = { faceId: string; uid: string; box: [number, number, number, number] };

export type SplitStart = {
  personId: string;
  name: string | null;
  /** Faces in the person. */
  faces: number;
  /** Photos with exactly two of the person's faces: one answer labels both. */
  pairs: { left: SplitFace; right: SplitFace }[];
  /** The clearest faces from the two ends of the person, alternating, to pick examples from. */
  contrast: SplitFace[];
  /** Faces of this person another device confirmed as someone else, by that name. */
  elsewhere: { name: string; faceIds: string[]; sample: SplitFace[] }[];
};

export type SplitSide = "a" | "b" | "unsure" | "neither";

export type SplitPlan = {
  counts: Record<SplitSide, number>;
  /** Examples left out one at a time that still landed on their side, of those tried. */
  checked: { right: number; tried: number };
  /** Of the faces not given as examples, the share that leans clearly one way. */
  clearShare: number;
  verdict: "reliable" | "weak" | "unreliable" | "few";
  /** The least certain faces of each side, for a look before applying. */
  leastSureA: SplitFace[];
  leastSureB: SplitFace[];
  /** The unsure faces, hardest first, with which way each leans. */
  unsure: (SplitFace & { lean: "a" | "b" | "even" })[];
};

export type SplitApplied = { stayed: number; moved: number; others: number; unsure: number; undo: string };

/** Margins below these are not clear: confident faces, and weak ones (as the grouping's strict delta). */
const MARGIN = 0.05;
const MARGIN_WEAK = 0.1;
/** Rounds of refining each side's direction with the faces that clearly lean that way. */
const ROUNDS = 3;
/** An example counts this many times over a face that only leans that way. */
const EXAMPLE_WEIGHT = 5;
/** Nearest examples asked to agree, and how many examples per side are asked at most. */
const NEIGHBOURS = 7;
const NEIGHBOUR_POOL = 150;
/** Examples per side tried left out, at most. */
const CHECK_POOL = 200;
/** Unsure faces listed for review, at most. */
const UNSURE_LISTED = 400;
/** A split's undo kept, at most this many, until the app closes. */
const UNDO_KEPT = 5;

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

function view(f: FaceRecord): SplitFace {
  return { faceId: f.id, uid: f.uid, box: f.box };
}

/** The unit-length direction of a weighted sum. */
function direction(sum: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i];
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = sum[i] * inv;
  return out;
}

function addInto(sum: Float32Array, v: Float32Array, weight: number): void {
  for (let i = 0; i < sum.length; i++) sum[i] += v[i] * weight;
}

const confident = (f: FaceRecord) => isConfidentFace(f.score, f.blur, f.sideways);

/** The faces of a person, as grouped now. */
function facesOfPerson(store: FaceStore, personId: string): FaceRecord[] {
  const p = store.people;
  const rejected = new Set(p.rejected);
  return store.allFaces().filter((f) => p.assign[f.id] === personId && !rejected.has(f.id));
}

/** What the window opens a split with: the examples to pick from, and what other devices said. */
export function splitStart(store: FaceStore, personId: string): SplitStart {
  const p = store.people;
  const person = personOf(p, personId);
  if (person.isOther) throw new Error("The leftovers cannot be split");
  const faces = facesOfPerson(store, personId);

  // Photos where two of the person's faces appear: two people, so one answer labels both.
  const byPhoto = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    let list = byPhoto.get(f.uid);
    if (!list) byPhoto.set(f.uid, (list = []));
    list.push(f);
  }
  const pairs = [...byPhoto.values()]
    .filter((list) => list.length === 2 && list.every(confident))
    .sort((x, y) => Math.min(y[0].score, y[1].score) - Math.min(x[0].score, x[1].score))
    .slice(0, 8)
    .map(([l, r]) => ({ left: view(l), right: view(r) }));

  // The two ends of the person: a few rounds of two-means over its clear faces, then the faces
  // nearest each end, clearest first. Lookalikes merged into one sit at the two ends.
  const clear = faces.filter(confident).sort((x, y) => y.score - x.score).slice(0, 3000);
  const contrast: SplitFace[] = [];
  if (clear.length >= 2) {
    const mean = new Float32Array(clear[0].embedding.length);
    for (const f of clear) addInto(mean, f.embedding, 1);
    const centre = direction(mean);
    let first = clear[0];
    for (const f of clear) if (dot(f.embedding, centre) < dot(first.embedding, centre)) first = f;
    let second = clear[0];
    for (const f of clear) if (dot(f.embedding, first.embedding) < dot(second.embedding, first.embedding)) second = f;
    let ca = first.embedding;
    let cb = second.embedding;
    let side = new Uint8Array(clear.length);
    for (let round = 0; round < 6; round++) {
      const sa = new Float32Array(ca.length);
      const sb = new Float32Array(cb.length);
      side = new Uint8Array(clear.length);
      clear.forEach((f, i) => {
        const toB = dot(f.embedding, cb) > dot(f.embedding, ca);
        side[i] = toB ? 1 : 0;
        addInto(toB ? sb : sa, f.embedding, 1);
      });
      ca = direction(sa);
      cb = direction(sb);
    }
    const ends = [0, 1].map((s) =>
      clear
        .map((f, i) => ({ f, i }))
        .filter(({ i }) => side[i] === s)
        .sort((x, y) => dot(y.f.embedding, s ? cb : ca) - dot(x.f.embedding, s ? cb : ca))
        .slice(0, 8)
        .map(({ f }) => view(f)),
    );
    for (let i = 0; i < 8; i++) for (const end of ends) if (end[i]) contrast.push(end[i]);
  }

  // What another device confirmed some of these faces as, by name.
  const byName = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    const conflict = p.conflicts[f.id];
    if (!conflict) continue;
    const key = foldPersonName(conflict.there);
    let list = byName.get(key);
    if (!list) byName.set(key, (list = []));
    list.push(f);
  }
  const elsewhere = [...byName.values()]
    .map((list) => ({
      name: p.conflicts[list[0].id].there,
      faceIds: list.map((f) => f.id),
      sample: list.slice(0, 6).map(view),
    }))
    .sort((x, y) => y.faceIds.length - x.faceIds.length);

  return { personId, name: person.name, faces: faces.length, pairs, contrast, elsewhere };
}

type Labelled = { sides: Map<string, SplitSide>; margins: Map<string, number>; faces: FaceRecord[]; plan: SplitPlan };

/**
 * Works out the split of `personId` between itself (A) and `otherName` (B) from the examples
 * picked for each, without changing anything.
 */
export async function planSplit(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
): Promise<SplitPlan> {
  return (await label(store, personId, otherName, picked)).plan;
}

async function label(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
): Promise<Labelled> {
  const p = store.people;
  const person = personOf(p, personId);
  if (person.isOther) throw new Error("The leftovers cannot be split");
  const fold = foldPersonName(otherName);
  if (!fold) throw new Error("A name is needed for the other person");
  if (person.name && foldPersonName(person.name) === fold) throw new Error("Pick someone other than this person");
  const faces = facesOfPerson(store, personId);
  const inPerson = new Set(faces.map((f) => f.id));
  const byId = new Map(store.allFaces().map((f) => [f.id, f]));

  // The examples. Picked for A: faces of this person. For B: picked here, and the faces already
  // confirmed as B by name, wherever they are now, the clearest first.
  const aIds = new Set(picked.a.filter((id) => inPerson.has(id)));
  const bIds = new Set(picked.b.filter((id) => byId.has(id) && !aIds.has(id)));
  const named = Object.entries(p.confirmed)
    .filter(([id, n]) => foldPersonName(n) === fold && byId.has(id) && !aIds.has(id))
    .map(([id]) => byId.get(id)!)
    .sort((x, y) => y.score - x.score)
    .slice(0, 300);
  for (const f of named) bIds.add(f.id);
  if (aIds.size === 0 || bIds.size === 0) throw new Error("Pick at least one face of each person");
  const aSeeds = [...aIds].map((id) => byId.get(id)!);
  const bSeeds = [...bIds].map((id) => byId.get(id)!);

  const dim = faces[0]?.embedding.length ?? aSeeds[0].embedding.length;
  const seedSum = (seeds: FaceRecord[]) => {
    const s = new Float32Array(dim);
    for (const f of seeds) addInto(s, f.embedding, EXAMPLE_WEIGHT);
    return s;
  };
  const aSeedSum = seedSum(aSeeds);
  const bSeedSum = seedSum(bSeeds);
  let ca = direction(aSeedSum);
  let cb = direction(bSeedSum);
  const rest = faces.filter((f) => !aIds.has(f.id) && !bIds.has(f.id));

  // Each side refined with the faces that lean clearly its way.
  for (let round = 0; round < ROUNDS; round++) {
    const sa = Float32Array.from(aSeedSum);
    const sb = Float32Array.from(bSeedSum);
    for (const f of rest) {
      if (!confident(f)) continue;
      const m = dot(f.embedding, ca) - dot(f.embedding, cb);
      if (m >= MARGIN) addInto(sa, f.embedding, 1);
      else if (m <= -MARGIN) addInto(sb, f.embedding, 1);
    }
    ca = direction(sa);
    cb = direction(sb);
    await yieldNow();
  }

  // The examples the nearest-neighbour check asks: the user's picks first, then the clearest.
  const pool = (seeds: FaceRecord[], picks: Set<string>) =>
    [...seeds].sort((x, y) => Number(picks.has(y.id)) - Number(picks.has(x.id)) || y.score - x.score).slice(0, NEIGHBOUR_POOL);
  const voters = [
    ...pool(aSeeds, new Set(picked.a)).map((f) => ({ f, a: true })),
    ...pool(bSeeds, new Set(picked.b)).map((f) => ({ f, a: false })),
  ];
  const nearestAgree = (f: FaceRecord, towardA: boolean): boolean => {
    const k = Math.min(NEIGHBOURS, voters.length);
    const best: { s: number; a: boolean }[] = [];
    for (const v of voters) {
      const s = dot(f.embedding, v.f.embedding);
      if (best.length < k) {
        best.push({ s, a: v.a });
        best.sort((x, y) => x.s - y.s);
      } else if (s > best[0].s) {
        best[0] = { s, a: v.a };
        best.sort((x, y) => x.s - y.s);
      }
    }
    const forA = best.filter((b) => b.a).length;
    return towardA ? forA * 2 > best.length : forA * 2 < best.length;
  };

  const sides = new Map<string, SplitSide>();
  const margins = new Map<string, number>();
  for (const f of aSeeds) if (inPerson.has(f.id)) sides.set(f.id, "a");
  for (const f of bSeeds) if (inPerson.has(f.id)) sides.set(f.id, "b");
  let done = 0;
  for (const f of rest) {
    const sa = dot(f.embedding, ca);
    const sb = dot(f.embedding, cb);
    const m = sa - sb;
    margins.set(f.id, m);
    const bar = confident(f) ? MARGIN : MARGIN_WEAK;
    if (Math.max(sa, sb) < FACE_SUGGEST_THRESHOLD) sides.set(f.id, "neither");
    else if (Math.abs(m) < bar || !nearestAgree(f, m > 0)) sides.set(f.id, "unsure");
    else sides.set(f.id, m > 0 ? "a" : "b");
    if ((++done & 0xff) === 0) await yieldNow();
  }
  for (const f of [...aSeeds, ...bSeeds]) margins.set(f.id, dot(f.embedding, ca) - dot(f.embedding, cb));

  // Two of the person's faces in one photo are two people.
  const byPhoto = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    let list = byPhoto.get(f.uid);
    if (!list) byPhoto.set(f.uid, (list = []));
    list.push(f);
  }
  for (const list of byPhoto.values()) {
    if (list.length !== 2) continue;
    const [x, y] = list;
    const sx = sides.get(x.id)!;
    const sy = sides.get(y.id)!;
    if (sx !== sy || (sx !== "a" && sx !== "b")) continue;
    const seedX = aIds.has(x.id) || bIds.has(x.id);
    const seedY = aIds.has(y.id) || bIds.has(y.id);
    if (seedX && seedY) continue;
    const [hi, lo] = margins.get(x.id)! >= margins.get(y.id)! ? [x, y] : [y, x];
    const gap = margins.get(hi.id)! - margins.get(lo.id)!;
    const flip = (f: FaceRecord, to: SplitSide) => {
      if (!aIds.has(f.id) && !bIds.has(f.id)) sides.set(f.id, to);
    };
    if (gap >= MARGIN || seedX || seedY) {
      flip(hi, "a");
      flip(lo, "b");
    } else {
      flip(x, "unsure");
      flip(y, "unsure");
    }
  }

  // How far to trust it: each example left out and sorted by the other examples alone.
  let right = 0;
  let tried = 0;
  const check = (seeds: FaceRecord[], own: Float32Array, other: Float32Array) => {
    const cOther = direction(other);
    // An example alone on its side has nothing left to be sorted against.
    if (seeds.length < 2) return;
    for (const f of seeds.slice(0, CHECK_POOL)) {
      const without = Float32Array.from(own);
      addInto(without, f.embedding, -EXAMPLE_WEIGHT);
      const cOwn = direction(without);
      tried++;
      if (dot(f.embedding, cOwn) > dot(f.embedding, cOther)) right++;
    }
  };
  check(aSeeds, aSeedSum, bSeedSum);
  check(bSeeds, bSeedSum, aSeedSum);

  const counts: Record<SplitSide, number> = { a: 0, b: 0, unsure: 0, neither: 0 };
  for (const s of sides.values()) counts[s]++;
  const judged = rest.filter((f) => sides.get(f.id) !== "neither");
  const clear = judged.filter((f) => {
    const m = Math.abs(margins.get(f.id)!);
    return m >= (confident(f) ? MARGIN : MARGIN_WEAK);
  }).length;
  const clearShare = judged.length ? clear / judged.length : 1;
  const accuracy = tried ? right / tried : 0;
  const verdict: SplitPlan["verdict"] =
    tried < 4 ? "few" : accuracy >= 0.95 && clearShare >= 0.75 ? "reliable" : accuracy < 0.85 || clearShare < 0.5 ? "unreliable" : "weak";

  const ofSide = (side: SplitSide) =>
    rest
      .filter((f) => sides.get(f.id) === side)
      .sort((x, y) => Math.abs(margins.get(x.id)!) - Math.abs(margins.get(y.id)!));
  const unsure = ofSide("unsure")
    .slice(0, UNSURE_LISTED)
    .map((f) => {
      const m = margins.get(f.id)!;
      return { ...view(f), lean: (Math.abs(m) < MARGIN / 2 ? "even" : m > 0 ? "a" : "b") as "a" | "b" | "even" };
    });
  const plan: SplitPlan = {
    counts,
    checked: { right, tried },
    clearShare,
    verdict,
    leastSureA: ofSide("a").slice(0, 12).map(view),
    leastSureB: ofSide("b").slice(0, 12).map(view),
    unsure,
  };
  return { sides, margins, faces, plan };
}

/** What a split changed, kept so it can be taken back. */
type SplitUndo = {
  personId: string;
  createdId: string | null;
  faces: Record<string, { assign?: string; confirmed?: string; blocked?: string[]; conflict?: unknown }>;
  /** Each "not this person" mark the split set or took away, and what was held for it before. */
  marks: { key: string; name: string; ref: string; before: Curation | undefined }[];
};

const undos = new Map<string, SplitUndo>();

/**
 * Splits the person: its faces sorted as `planSplit` sorts them, B's moved to the person of
 * that name (made if there is none), and the result kept as confirmations and marks.
 */
export async function applySplit(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
  at = Date.now(),
): Promise<SplitApplied> {
  const { sides, faces } = await label(store, personId, otherName, picked);
  const p = store.people;
  const person = personOf(p, personId);
  const name = otherName.trim().slice(0, 100);
  const fold = foldPersonName(name);
  let other: Person | undefined = p.people.find((x) => x.id !== personId && x.name && foldPersonName(x.name) === fold);
  let createdId: string | null = null;
  if (!other) {
    other = { id: mint(p), name, isOther: false };
    p.people.push(other);
    p.namedAt[fold] = at;
    createdId = other.id;
  }
  const undo: SplitUndo = { personId, createdId, faces: {}, marks: [] };
  const remember = (faceId: string) => {
    if (undo.faces[faceId]) return;
    undo.faces[faceId] = {
      assign: p.assign[faceId],
      confirmed: p.confirmed[faceId],
      blocked: p.blocked[faceId] ? [...p.blocked[faceId]] : undefined,
      conflict: p.conflicts[faceId],
    };
  };
  const mark = (faceId: string, markName: string, removed: boolean) => {
    const ref = portableFaceId(faceId);
    const key = curationKey(2, markName, ref);
    undo.marks.push({ key, name: markName, ref, before: p.curation[key] ? { ...p.curation[key] } : undefined });
    noteCuration(p, 2, markName, [ref], removed, at);
  };
  const block = (faceId: string, blockName: string) => {
    const list = p.blocked[faceId] ?? [];
    if (!list.some((n) => foldPersonName(n) === foldPersonName(blockName))) p.blocked[faceId] = [...list, blockName];
    mark(faceId, blockName, false);
  };
  const unblock = (faceId: string, blockName: string) => {
    const list = p.blocked[faceId];
    if (!list?.some((n) => foldPersonName(n) === foldPersonName(blockName))) return;
    const rest = list.filter((n) => foldPersonName(n) !== foldPersonName(blockName));
    if (rest.length) p.blocked[faceId] = rest;
    else delete p.blocked[faceId];
    mark(faceId, blockName, true);
  };
  const leftovers = otherPerson(p);
  let stayed = 0;
  let moved = 0;
  let others = 0;
  let unsure = 0;
  for (const f of faces) {
    const side = sides.get(f.id);
    // Sorting yields to the rest of the sidecar, and a scan or a hand may have moved a face
    // meanwhile: only the faces still in the person are split.
    if (!side || p.assign[f.id] !== person.id) continue;
    remember(f.id);
    if (side === "a") {
      p.assign[f.id] = person.id;
      if (person.name) p.confirmed[f.id] = person.name;
      delete p.conflicts[f.id];
      stayed++;
    } else if (side === "b") {
      p.assign[f.id] = other.id;
      p.confirmed[f.id] = other.name!;
      unblock(f.id, other.name!);
      if (person.name) block(f.id, person.name);
      delete p.conflicts[f.id];
      moved++;
    } else if (side === "neither") {
      p.assign[f.id] = leftovers.id;
      delete p.confirmed[f.id];
      if (person.name) block(f.id, person.name);
      delete p.conflicts[f.id];
      others++;
    } else {
      // Not guessed: it stays, unconfirmed, so a regroup or the user can still move it.
      delete p.confirmed[f.id];
      unsure++;
    }
  }
  store.markPeople();
  store.edits++;
  const token = randomBytes(9).toString("base64url");
  undos.set(token, undo);
  while (undos.size > UNDO_KEPT) undos.delete(undos.keys().next().value!);
  return { stayed, moved, others, unsure, undo: token };
}

/** Takes a split back, as long as the app has not been closed since. */
export function undoSplit(store: FaceStore, token: string, at = Date.now()): boolean {
  const undo = undos.get(token);
  if (!undo) return false;
  undos.delete(token);
  const p = store.people;
  const ids = new Set(p.people.map((x) => x.id));
  for (const [faceId, was] of Object.entries(undo.faces)) {
    if (was.assign && ids.has(was.assign)) p.assign[faceId] = was.assign;
    else if (was.assign === undefined) delete p.assign[faceId];
    if (was.confirmed !== undefined) p.confirmed[faceId] = was.confirmed;
    else delete p.confirmed[faceId];
    if (was.blocked) p.blocked[faceId] = [...was.blocked];
    else delete p.blocked[faceId];
    if (was.conflict) p.conflicts[faceId] = was.conflict as (typeof p.conflicts)[string];
  }
  // A mark held before the split goes back to what it was. One the split set is taken back,
  // with a time of its own, so another device that took it in takes it back too.
  for (const m of [...undo.marks].reverse()) {
    if (m.before) p.curation[m.key] = m.before;
    else noteCuration(p, 2, m.name, [m.ref], true, at);
  }
  if (undo.createdId && !Object.values(p.assign).includes(undo.createdId)) {
    p.people = p.people.filter((x) => x.id !== undo.createdId);
  }
  store.markPeople();
  store.edits++;
  return true;
}
