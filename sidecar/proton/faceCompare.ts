/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * A one-off measurement, started by hand: how well stronger face models tell two named people
 * apart, next to the phone's GhostFaceNet, on this library's own photos. It answers whether a
 * "high accuracy" model for this computer is worth offering (two lookalike siblings, issue 152).
 *
 * Started with the environment variable PFP_FACE_COMPARE="Name one,Name two" once the library
 * is open. For a sample of each person's faces, spread over the years, the photo is read and
 * the faces found again exactly as the scan finds them; each face is lined up once, and the
 * same 112-pixel crop goes to every model. Nothing is kept: no face, person or setting changes.
 * The result goes to the log and to `face-model-comparison.txt` in the app's data folder, with
 * the two people as A and B and no names, ids or file names.
 *
 * Who is who comes from the people as they are now (after a split, its result), which the
 * current model made: where it is wrong, the others are marked down for being right. So a gain
 * shown by another model is, if anything, larger than shown.
 *
 * The candidates (InsightFace, as Immich uses them) are for non-commercial research use only,
 * and are not part of the app: they are fetched only when this is started.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALIGNED, normalizeInPlace, similarityTransform, warpAligned } from "./faceAlign.ts";
import { dot } from "./faceCluster.ts";
import { foldPersonName } from "./facePeople.ts";
import type { FaceRecord, FaceStore } from "./faceStore.ts";
import { openModel } from "./inference.ts";
import { decodeLikePhone, type Decoded } from "./phoneDecode.ts";
import { pinnedModel, type PinnedModelSpec } from "./pinnedModel.ts";
import { storeDir } from "./store.ts";

/** A model to compare: its file, and how it wants the lined-up face. */
export type Candidate = { key: string; label: string; spec: PinnedModelSpec };

/**
 * InsightFace's recognition models, as Immich serves them: the lined-up face in planes, red,
 * green, blue, each (x - 127.5) / 127.5; a 512-number face out.
 */
export const CANDIDATES: Candidate[] = [
  {
    key: "buffalo_l",
    label: "InsightFace buffalo_l (ArcFace ResNet-50, WebFace600K)",
    spec: {
      url: "https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx",
      file: "compare-buffalo_l-recognition.onnx",
      size: 174_383_860,
      sha256: "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    },
  },
  {
    key: "antelopev2",
    label: "InsightFace antelopev2 (ArcFace ResNet-100, Glint360K)",
    spec: {
      url: "https://huggingface.co/immich-app/antelopev2/resolve/main/recognition/model.onnx",
      file: "compare-antelopev2-recognition.onnx",
      size: 260_665_334,
      sha256: "4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf",
    },
  },
];

/** Faces of each person measured, at most. */
export const PER_PERSON = 300;
/** A face found again counts as the stored one when their boxes overlap this much (intersection over union). */
const SAME_BOX = 0.5;
/** A face is clearly one side when it is closer to that side's mean by this share of the model's same-minus-different gap. */
const CLEAR_OF_GAP = 0.15;
/** A download that has not moved for this long is given up. */
const STALLED_MS = 120_000;
/** Same-or-different pairs used for the separation numbers, at most, per kind. */
const MAX_PAIRS = 60_000;

/** The lined-up face as InsightFace's models take it: planes, (x - 127.5) / 127.5. */
export function insightInput(aligned: Uint8Array): Float32Array {
  const plane = ALIGNED * ALIGNED;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    out[i] = (aligned[i * 3] - 127.5) / 127.5;
    out[plane + i] = (aligned[i * 3 + 1] - 127.5) / 127.5;
    out[2 * plane + i] = (aligned[i * 3 + 2] - 127.5) / 127.5;
  }
  return out;
}

/**
 * A measured face: whose it is, the year taken (null undated), its photo and when it was taken
 * (0 unknown), and one embedding per model.
 */
export type Sample = { side: "a" | "b"; year: number | null; uid?: string; at?: number; byModel: Map<string, Float32Array> };

/** A face of the same photo, or taken within this long of it, is not asked as its nearest: a burst's frames are near copies. */
const SAME_MOMENT_MS = 10 * 60_000;

function sameMoment(x: Sample, y: Sample): boolean {
  if (x.uid && x.uid === y.uid) return true;
  return !!x.at && !!y.at && Math.abs(x.at - y.at) < SAME_MOMENT_MS;
}

/** Something the comparison itself says, with nothing private in it: logged as it is. */
export class CompareStop extends Error {}

export type Separation = {
  faces: { a: number; b: number };
  /** The chance a same-person pair is more alike than a two-person pair (1 is perfect, 0.5 chance). */
  auc: number;
  /** How far apart the same-person and two-person likeness are, in their spread (d-prime). */
  dPrime: number;
  /** Mean likeness of same-person pairs, and of two-person pairs. */
  same: number;
  cross: number;
  /** Each face's single most alike other face is the same person, of all faces. */
  nearest: number;
  /** As `nearest`, asking only faces taken within a year of it (the same age); null undated. */
  nearestSameAge: number | null;
  /**
   * Each face against the two sides' means without itself: clearly its own side, clearly the
   * other. "Clearly" is a share of the model's own gap between same-person and two-person
   * likeness, as models spread their likeness differently.
   */
  clearRight: number;
  clearWrong: number;
};

/** Seeded, so the same library gives the same sample and the same pairs. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The area under the curve of `pos` over `neg`: by ranks, ties counting half. */
export function aucOf(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  const all = [...pos.map((v) => ({ v, p: true })), ...neg.map((v) => ({ v, p: false }))].sort((x, y) => x.v - y.v);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k].p) rankSum += rank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

function meanVar(xs: number[]): [number, number] {
  if (!xs.length) return [NaN, NaN];
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return [m, xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length];
}

/** How well one model's embeddings (`key`) tell side A from side B. */
export function separation(samples: Sample[], key: string): Separation {
  const faces = samples.filter((s) => s.byModel.has(key));
  const emb = faces.map((s) => s.byModel.get(key)!);
  const n = faces.length;
  const counts = { a: faces.filter((s) => s.side === "a").length, b: faces.filter((s) => s.side === "b").length };

  // Every pair when there are few enough, else a fixed random draw of them.
  const same: number[] = [];
  const cross: number[] = [];
  const totalPairs = (n * (n - 1)) / 2;
  if (totalPairs <= 2 * MAX_PAIRS) {
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) (faces[i].side === faces[j].side ? same : cross).push(dot(emb[i], emb[j]));
  } else {
    const rand = seeded(152);
    for (let t = 0; t < 4 * MAX_PAIRS && (same.length < MAX_PAIRS || cross.length < MAX_PAIRS); t++) {
      const i = Math.floor(rand() * n);
      const j = Math.floor(rand() * n);
      if (i === j) continue;
      const list = faces[i].side === faces[j].side ? same : cross;
      if (list.length < MAX_PAIRS) list.push(dot(emb[i], emb[j]));
    }
  }
  const [ms, vs] = meanVar(same);
  const [mc, vc] = meanVar(cross);

  // The most alike other face, of all and of the same age.
  let nearestRight = 0;
  let nearestAsked = 0;
  let ageRight = 0;
  let ageAsked = 0;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bestSide: string | null = null;
    let bestAge = -Infinity;
    let bestAgeSide: string | null = null;
    const year = faces[i].year;
    for (let j = 0; j < n; j++) {
      if (i === j || sameMoment(faces[i], faces[j])) continue;
      const s = dot(emb[i], emb[j]);
      if (s > best) {
        best = s;
        bestSide = faces[j].side;
      }
      const other = faces[j].year;
      if (year !== null && other !== null && Math.abs(other - year) <= 1 && s > bestAge) {
        bestAge = s;
        bestAgeSide = faces[j].side;
      }
    }
    if (bestSide !== null) nearestAsked++;
    if (bestSide === faces[i].side) nearestRight++;
    if (bestAgeSide !== null) {
      ageAsked++;
      if (bestAgeSide === faces[i].side) ageRight++;
    }
  }

  // Against the two means, each face left out of its own.
  const dim = emb[0]?.length ?? 0;
  const sums = { a: new Float32Array(dim), b: new Float32Array(dim) };
  faces.forEach((s, i) => {
    const sum = sums[s.side];
    for (let d = 0; d < dim; d++) sum[d] += emb[i][d];
  });
  const unit = (v: Float32Array) => {
    let q = 0;
    for (const x of v) q += x * x;
    const inv = q > 0 ? 1 / Math.sqrt(q) : 0;
    return v.map((x) => x * inv);
  };
  const otherMean = { a: unit(sums.b), b: unit(sums.a) };
  let clearRight = 0;
  let clearWrong = 0;
  const bar = CLEAR_OF_GAP * (ms - mc);
  const bothSides = counts.a >= 2 && counts.b >= 2;
  if (bothSides && bar > 0)
    faces.forEach((s, i) => {
      const own = Float32Array.from(sums[s.side]);
      for (let d = 0; d < dim; d++) own[d] -= emb[i][d];
      const m = dot(emb[i], unit(own)) - dot(emb[i], otherMean[s.side]);
      if (m >= bar) clearRight++;
      else if (m <= -bar) clearWrong++;
    });

  const share = (k: number, of: number) => (of && bothSides ? k / of : NaN);
  return {
    faces: counts,
    auc: aucOf(same, cross),
    dPrime: (ms - mc) / Math.sqrt((vs + vc) / 2 || 1),
    same: ms,
    cross: mc,
    nearest: share(nearestRight, nearestAsked),
    nearestSameAge: ageAsked && bothSides ? ageRight / ageAsked : null,
    clearRight: bar > 0 ? share(clearRight, n) : NaN,
    clearWrong: bar > 0 ? share(clearWrong, n) : NaN,
  };
}

/** How much two boxes (left, top, right, bottom) overlap: intersection over union. */
export function overlap(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const w = Math.max(0, Math.min(x[2], y[2]) - Math.max(x[0], y[0]));
  const h = Math.max(0, Math.min(x[3], y[3]) - Math.max(x[1], y[1]));
  const inter = w * h;
  const union = (x[2] - x[0]) * (x[3] - x[1]) + (y[2] - y[0]) * (y[3] - y[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Up to `max` faces, spread over the years: a turn per year, newest first, in a fixed random
 * order within a year (not the clearest first: those are the easy faces, often frames of one
 * burst); undated last.
 */
export function spreadOverYears(faces: FaceRecord[], yearOf: (f: FaceRecord) => number | null, max: number): FaceRecord[] {
  const byYear = new Map<number | null, FaceRecord[]>();
  for (const f of faces) {
    const year = yearOf(f);
    let list = byYear.get(year);
    if (!list) byYear.set(year, (list = []));
    list.push(f);
  }
  const years = [...byYear.keys()].sort((x, y) => (y ?? -Infinity) - (x ?? -Infinity));
  const rand = seeded(7);
  for (const year of years) {
    const list = byYear.get(year)!.sort((x, y) => (x.id < y.id ? -1 : 1));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const out: FaceRecord[] = [];
  for (let i = 0; out.length < max; i++) {
    let any = false;
    for (const year of years) {
      const f = byYear.get(year)![i];
      if (!f) continue;
      any = true;
      if (out.length < max) out.push(f);
    }
    if (!any) break;
  }
  return out;
}

/** What the comparison needs from the face scan. */
export type CompareDeps = {
  store: FaceStore;
  /** The photos' bytes, as the scan reads them. */
  pictures: (uids: string[]) => AsyncIterable<{ uid: string; bytes: Buffer | null }>;
  /**
   * Opens the scan's own models for the comparison alone (so the scan closing its own cannot
   * stop it): a finder of a photo's faces as the scan finds them (boxes 0 to 1, points,
   * GhostFaceNet face), and the way to close them.
   */
  openFinder: () => Promise<{ find: (img: Decoded, uid: string) => Promise<FaceRecord[]>; release: () => void }>;
  /** Whether the library it started with is still open: false after a sign-out or a lock. */
  alive: () => boolean;
  /** Each photo's capture time in ms, by uid; empty when not known. */
  times: ReadonlyMap<string, number>;
  log: (line: string) => void;
};

/** The two people's faces, by name as they are grouped now. */
function facesOf(store: FaceStore, name: string): FaceRecord[] {
  const fold = foldPersonName(name);
  const p = store.people;
  const ids = new Set(p.people.filter((x) => x.name && foldPersonName(x.name) === fold).map((x) => x.id));
  const rejected = new Set(p.rejected);
  return store.allFaces().filter((f) => ids.has(p.assign[f.id]) && !rejected.has(f.id));
}

const fmt = (v: number | null, digits = 3) => (v === null || Number.isNaN(v) ? "-" : v.toFixed(digits));
const pct = (v: number | null) => (v === null || Number.isNaN(v) ? "-" : `${(v * 100).toFixed(1)}%`);

/** Runs the comparison for the two names; returns the report's text. */
export async function compareFaceModels(names: [string, string], deps: CompareDeps): Promise<string> {
  const { store, log } = deps;
  const ort = await import("onnxruntime-node");
  const yearOf = (f: FaceRecord) => {
    const t = deps.times.get(f.uid);
    return t && t > 0 ? new Date(t).getFullYear() : null;
  };
  const chosen = new Map<string, "a" | "b">();
  const sides: ["a" | "b", string][] = [
    ["a", names[0]],
    ["b", names[1]],
  ];
  for (const [side, name] of sides) {
    const faces = facesOf(store, name);
    if (faces.length < 10)
      throw new CompareStop(`person ${side.toUpperCase()} has ${faces.length} faces to measure; 10 at least are needed`);
    for (const f of spreadOverYears(faces, yearOf, PER_PERSON)) if (!chosen.has(f.id)) chosen.set(f.id, side);
  }
  const byId = new Map(store.allFaces().map((f) => [f.id, f]));
  const byPhoto = new Map<string, FaceRecord[]>();
  for (const id of chosen.keys()) {
    const f = byId.get(id)!;
    let list = byPhoto.get(f.uid);
    if (!list) byPhoto.set(f.uid, (list = []));
    list.push(f);
  }
  log(`[face-compare] ${chosen.size} faces in ${byPhoto.size} photos; fetching the models`);

  // Everything opened is closed at the end, however it ends.
  const sessions: { key: string; session: any; ms: number; runs: number }[] = [];
  let finder: Awaited<ReturnType<CompareDeps["openFinder"]>> | null = null;
  const samples: Sample[] = [];
  let photos = 0;
  let unmatched = 0;
  let unread = 0;
  let ghostMs = 0;
  let ghostRuns = 0;
  let warmed = false;
  let finished = false;
  let agreement = 0;
  const started = Date.now();
  const files = CANDIDATES.map((c) => ({ c, model: pinnedModel(c.spec, "face-compare") }));
  try {
    // The candidates, fetched and checked against their pinned bytes, then opened.
    for (const { c, model } of files) {
      if (model.status().state !== "ready") {
        model.startDownload();
        let last = -1;
        let movedAt = Date.now();
        for (;;) {
          if (!deps.alive()) throw new CompareStop("the library was closed (signed out, locked or signed in again)");
          const st = model.status();
          if (st.state === "ready") break;
          if (st.state === "failed") throw new CompareStop(`${c.key}: the download failed`);
          if (st.state === "downloading" && st.done !== last) {
            if (Math.floor(st.done / 50e6) !== Math.floor(Math.max(0, last) / 50e6))
              log(`[face-compare] ${c.key}: ${Math.round(st.done / 1e6)} of ${Math.round(st.total / 1e6)} MB`);
            last = st.done;
            movedAt = Date.now();
          }
          if (Date.now() - movedAt > STALLED_MS) throw new CompareStop(`${c.key}: the download stopped moving`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!(await model.intact())) throw new CompareStop(`${c.key}: the file on disk is not the pinned one`);
      let opened: { session: any };
      try {
        opened = await openModel(model.path(), false);
      } catch {
        throw new CompareStop(`${c.key}: the model could not be opened`);
      }
      const shape = opened.session.inputMetadata?.[0]?.shape as unknown[] | undefined;
      if (shape && shape.length !== 4) throw new CompareStop(`${c.key}: the model does not take a picture in planes`);
      sessions.push({ key: c.key, session: opened.session, ms: 0, runs: 0 });
    }
    finder = await deps.openFinder();

    // Each photo read once; its faces found again as the scan finds them, matched to the chosen
    // ones by their boxes, lined up once, and given to every model.
    for await (const { uid, bytes } of deps.pictures([...byPhoto.keys()])) {
      if (!deps.alive()) throw new CompareStop("the library was closed (signed out, locked or signed in again)");
      photos++;
      const wanted = byPhoto.get(uid) ?? [];
      if (!bytes) {
        unread += wanted.length;
        continue;
      }
      let img: Decoded;
      try {
        img = await decodeLikePhone(bytes);
      } catch {
        unread += wanted.length;
        continue;
      }
      const t0 = performance.now();
      let found: FaceRecord[];
      try {
        found = await finder.find(img, uid);
      } catch {
        // A photo the scan's models cannot take, as the scan passes over it.
        unread += wanted.length;
        continue;
      }
      // The first photo found warms the models up: not counted in their time.
      if (warmed) {
        ghostMs += performance.now() - t0;
        ghostRuns++;
      }
      warmed = true;
      for (const f of wanted) {
        let best: FaceRecord | null = null;
        let bestOverlap = SAME_BOX;
        for (const g of found) {
          const o = overlap(f.box, g.box);
          if (o >= bestOverlap) {
            best = g;
            bestOverlap = o;
          }
        }
        if (!best) {
          unmatched++;
          continue;
        }
        agreement += dot(f.embedding, best.embedding);
        const aligned = warpAligned(img.rgb, img.width, img.height, similarityTransform(best.points));
        const input = new ort.Tensor("float32", insightInput(aligned), [1, 3, ALIGNED, ALIGNED]);
        const byModel = new Map<string, Float32Array>([["ghostfacenet", best.embedding]]);
        for (const s of sessions) {
          const t = performance.now();
          const out = await s.session.run({ [s.session.inputNames[0]]: input });
          // The first run of a model warms it up: not counted in its time.
          if (s.runs > 0) s.ms += performance.now() - t;
          s.runs++;
          const vector = Float32Array.from(out[s.session.outputNames[0]].data as Float32Array);
          if (vector.length !== 512) throw new CompareStop(`${s.key}: the model gives ${vector.length} numbers a face, not 512`);
          byModel.set(s.key, normalizeInPlace(vector));
          // A large model's run holds the sidecar for a moment: the window's calls go between.
          await new Promise((r) => setImmediate(r));
        }
        samples.push({ side: chosen.get(f.id)!, year: yearOf(f), uid, at: deps.times.get(uid) ?? 0, byModel });
      }
      if (photos % 50 === 0) log(`[face-compare] ${photos} of ${byPhoto.size} photos, ${samples.length} faces measured`);
    }
    finished = true;
  } finally {
    for (const s of sessions) void s.session.release?.().catch(() => {});
    finder?.release();
    // The candidates are not part of the app: their files go once measured. Kept when it
    // stopped before the end, so trying again does not fetch them again.
    if (finished)
      for (const { model } of files) {
        try {
          model.remove();
        } catch {
          log("[face-compare] a compared model's file could not be removed");
        }
      }
  }

  // The report.
  const lines: string[] = [];
  const now = new Date();
  lines.push(`Face model comparison, ${now.toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push(
    `Faces measured: A ${samples.filter((s) => s.side === "a").length}, B ${samples.filter((s) => s.side === "b").length} ` +
      `(from ${photos} photos; ${unmatched} not found again, ${unread} unreadable)`,
  );
  lines.push(`Stored and re-found GhostFaceNet faces agree: mean cosine ${fmt(samples.length ? agreement / samples.length : NaN)} (1.000 = read exactly as scanned)`);
  const years = samples.map((s) => s.year).filter((y): y is number => y !== null);
  if (years.length) lines.push(`Years: ${Math.min(...years)} to ${Math.max(...years)}`);
  else lines.push("Capture times unknown: the sample is not spread over the years, and there is no same-age or last-years measure.");
  lines.push("");
  const models = [
    { key: "ghostfacenet", label: "GhostFaceNet (now, as on the phone)", ms: ghostMs, runs: ghostRuns },
    ...sessions.map((s) => ({ key: s.key, label: CANDIDATES.find((c) => c.key === s.key)!.label, ms: s.ms, runs: Math.max(0, s.runs - 1) })),
  ];
  const head = ["model", "AUC", "d'", "same", "cross", "1-NN", "1-NN same age", "clear right", "clear wrong", "ms"];
  const rows: string[][] = [head];
  const recent: string[] = [];
  const maxYear = years.length ? Math.max(...years) : null;
  for (const m of models) {
    const r = separation(samples, m.key);
    rows.push([
      m.key,
      fmt(r.auc),
      fmt(r.dPrime, 2),
      fmt(r.same),
      fmt(r.cross),
      pct(r.nearest),
      pct(r.nearestSameAge),
      pct(r.clearRight),
      pct(r.clearWrong),
      // GhostFaceNet's time is the whole finding of a photo's faces; the others' one face each.
      m.runs ? `${(m.ms / m.runs).toFixed(0)}${m.key === "ghostfacenet" ? "/photo" : "/face"}` : "-",
    ]);
    if (maxYear !== null) {
      const last = samples.filter((s) => s.year !== null && s.year >= maxYear - 1);
      if (last.filter((s) => s.side === "a").length >= 10 && last.filter((s) => s.side === "b").length >= 10) {
        const rr = separation(last, m.key);
        recent.push(`  ${m.key}: AUC ${fmt(rr.auc)}, 1-NN ${pct(rr.nearest)}, clear right ${pct(rr.clearRight)}, clear wrong ${pct(rr.clearWrong)} (${rr.faces.a}/${rr.faces.b} faces)`);
      }
    }
  }
  const widths = head.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) lines.push(r.map((c, i) => c.padEnd(widths[i])).join("  "));
  if (recent.length) {
    lines.push("");
    lines.push(`The last two years only (${maxYear! - 1} to ${maxYear}):`);
    lines.push(...recent);
  }
  lines.push("");
  lines.push("AUC: chance a same-person pair is more alike than an A-B pair (1 perfect, 0.5 chance).");
  lines.push("d': same-person vs A-B likeness apart, in their spread; higher separates better.");
  lines.push("1-NN: each face's most alike other face is the same person. Same age: asking faces within a year.");
  lines.push(
    `clear right / wrong: against the two sides' means without the face, toward its own / the other side by ${CLEAR_OF_GAP} of the model's same-minus-A-B gap or more.`,
  );
  lines.push("1-NN leaves out faces of the same photo or taken within 10 minutes (burst frames).");
  lines.push(
    "A model that hardly separates the two has a small gap, so most faces land in clear right or wrong: read clear wrong and AUC, not clear right alone. '-' where the gap is none.",
  );
  lines.push("ms: indicative only. GhostFaceNet's is finding all of a photo's faces on 2 threads; the others' one face on all threads, while the app may be scanning.");
  lines.push("Who is who comes from the current grouping, made with GhostFaceNet: a gain by another model is if anything understated.");
  lines.push(`Took ${Math.round((Date.now() - started) / 1000)} s. The compared models' files were removed afterwards.`);
  const text = lines.join("\n") + "\n";
  try {
    const path = join(storeDir(), "face-model-comparison.txt");
    writeFileSync(path, text);
    log(`[face-compare] written to ${path}`);
  } catch (e) {
    log(`[face-compare] could not write the report: ${(e as Error).name}`);
  }
  for (const line of lines) log(`[face-compare] ${line}`);
  return text;
}
