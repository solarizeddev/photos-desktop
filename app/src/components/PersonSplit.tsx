/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FaceCover } from "./Library";
import { CloseIcon, FaceIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import "../styles/Confirm.css";
import "../styles/AlbumDialogs.css";
import "../styles/PersonSplit.css";

type Box = [number, number, number, number];
type SplitFace = { faceId: string; uid: string; box: Box };
type Start = {
  personId: string;
  name: string | null;
  faces: number;
  pairs: { left: SplitFace; right: SplitFace }[];
  contrast: SplitFace[];
  elsewhere: { name: string; faceIds: string[]; sample: SplitFace[] }[];
};
type Plan = {
  counts: { a: number; b: number; unsure: number; neither: number };
  checked: { right: number; tried: number };
  clearShare: number;
  verdict: "reliable" | "weak" | "unreliable" | "few";
  leastSureA: SplitFace[];
  leastSureB: SplitFace[];
  unsure: (SplitFace & { lean: "a" | "b" | "even" })[];
};
type Applied = { stayed: number; moved: number; others: number; unsure: number; undo: string };
type Side = "a" | "b";

/** Unsure faces shown at once in the review. */
const REVIEW_PAGE = 12;

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

/**
 * Splitting a person in two (see the sidecar's faceSplit): naming the other person, picking a
 * few faces of each, a preview of the split with how far to trust it, the unsure faces to
 * answer, and the split carried out with an undo. `act` runs a face call and reads the people
 * again afterwards, as every other change to the people does.
 */
export function PersonSplit({
  personId,
  name,
  names,
  act,
  onClose,
}: {
  personId: string;
  /** The person's name, or null while unnamed. */
  name: string | null;
  /** Everyone else already named, offered as the other person. */
  names: string[];
  act: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onClose: () => void;
}) {
  const t = useT();
  const here = name ?? t("faces.split.thisPerson");
  const [step, setStep] = useState<"name" | "pick" | "preview" | "review" | "done">("name");
  const [start, setStart] = useState<Start | null>(null);
  const [error, setError] = useState("");
  const [other, setOther] = useState("");
  const [picks, setPicks] = useState<Map<string, Side>>(new Map());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    rpc<Start>("faceSplitStart", { id: personId }).then(
      (s) => live && setStart(s),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [personId]);

  // Escape closes it, before anything under it hears the key; not once it is done, where the
  // undo is offered and closing is a choice of its own.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (step !== "done") onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, onClose]);

  const suggestions = useMemo(() => {
    const q = fold(other);
    const pool = [...new Set([...(start?.elsewhere.map((e) => e.name) ?? []), ...names])];
    return pool.filter((n) => fold(n) !== fold(here) && (!q || fold(n).includes(q))).slice(0, 6);
  }, [other, names, start, here]);

  const a = [...picks].filter(([, s]) => s === "a").map(([id]) => id);
  const b = [...picks].filter(([, s]) => s === "b").map(([id]) => id);
  const otherName = other.trim();
  const sameName = !!otherName && fold(otherName) === fold(here);

  // What another device said, for the name chosen, counts as examples of that person.
  const fromElsewhere = useMemo(
    () => start?.elsewhere.find((e) => fold(e.name) === fold(otherName))?.faceIds ?? [],
    [start, otherName],
  );
  const bWithElsewhere = useMemo(() => [...new Set([...b, ...fromElsewhere])], [b, fromElsewhere]);

  // The split worked out again as examples change, a moment after the last change.
  const planned = useRef(0);
  useEffect(() => {
    if (step !== "preview" && step !== "review") return;
    if (a.length === 0 || bWithElsewhere.length === 0) return;
    const ticket = ++planned.current;
    setPlanning(true);
    const timer = window.setTimeout(() => {
      rpc<Plan>("faceSplitPlan", { id: personId, other: otherName, a, b: bWithElsewhere }).then(
        (p) => {
          if (planned.current !== ticket) return;
          setPlan(p);
          setPlanning(false);
        },
        (e) => {
          if (planned.current !== ticket) return;
          setError(String(e));
          setPlanning(false);
        },
      );
    }, 300);
    return () => window.clearTimeout(timer);
    // The picks are read through `a` and `b`, which are new arrays on each draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, picks, personId, otherName, bWithElsewhere]);

  const shown = useMemo(() => {
    const faces: SplitFace[] = [];
    if (start) {
      for (const p of start.pairs) faces.push(p.left, p.right);
      faces.push(...start.contrast);
      for (const e of start.elsewhere) faces.push(...e.sample);
    }
    if (plan) faces.push(...plan.leastSureA, ...plan.leastSureB, ...plan.unsure.slice(0, REVIEW_PAGE * 3));
    return faces;
  }, [start, plan]);
  const thumbs = useThumbnails(useMemo(() => [...new Set(shown.map((f) => f.uid))], [shown]));

  const choose = (faceId: string, side: Side | null) =>
    setPicks((before) => {
      const next = new Map(before);
      if (side === null || next.get(faceId) === side) next.delete(faceId);
      else next.set(faceId, side);
      return next;
    });

  async function apply() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await act<Applied>("faceSplitApply", { id: personId, other: otherName, a, b: bWithElsewhere });
      setApplied(out);
      setStep("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!applied || busy) return;
    setBusy(true);
    try {
      await act("faceSplitUndo", { token: applied.undo });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const face = (f: SplitFace, extra?: string) => (
    <span className={`ps-face${extra ? ` ${extra}` : ""}`}>
      {thumbs[f.uid] ? (
        <span className="lib-facebox">
          <FaceCover uid={f.uid} thumb={thumbs[f.uid]!} box={f.box} />
        </span>
      ) : (
        <span className="ps-face-empty">
          <FaceIcon size={22} />
        </span>
      )}
    </span>
  );

  const sideButtons = (faceId: string) => (
    <span className="ps-sides">
      <button className={`ps-side a${picks.get(faceId) === "a" ? " on" : ""}`} onClick={() => choose(faceId, "a")}>
        {here}
      </button>
      <button
        className={`ps-side b${picks.get(faceId) === "b" ? " on" : ""}`}
        disabled={!otherName}
        onClick={() => choose(faceId, "b")}
      >
        {otherName || "…"}
      </button>
    </span>
  );

  const unsureLeft = plan ? plan.unsure.filter((f) => !picks.has(f.faceId) && !reviewed.has(f.faceId)) : [];

  return (
    // Closed by a press on the backdrop itself, not by a click: a click that began in a field
    // inside (selecting a name by dragging) and ended outside must not close it.
    <div
      className="cf-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && step !== "done") onClose();
      }}
    >
      <div className="cf-panel ad-picker ps-panel" role="dialog" aria-label={t("faces.split.title", { name: here })} onClick={(e) => e.stopPropagation()}>
        <div className="ad-picker-head">
          <div className="ad-picker-titles">
            <h3 className="cf-title">{t("faces.split.title", { name: here })}</h3>
            {start && <p className="cf-msg">{t("faces.split.faceCount", { count: start.faces.toLocaleString() })}</p>}
          </div>
          {step !== "done" && (
            <button className="ad-close" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")}>
              <CloseIcon size={18} />
            </button>
          )}
        </div>

        {error && <p className="ps-error">{error}</p>}

        {step === "name" && (
          <div className="ps-body">
            <label className="ps-label" htmlFor="ps-other">
              {t("faces.split.otherLabel")}
            </label>
            <p className="cf-msg">{t("faces.split.otherHint", { name: here })}</p>
            <input
              id="ps-other"
              className="ps-input"
              autoFocus
              maxLength={100}
              value={other}
              placeholder={t("faces.split.otherPlaceholder")}
              onChange={(e) => setOther(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otherName && !sameName) setStep("pick");
              }}
            />
            {sameName && <p className="ps-error">{t("faces.split.sameName")}</p>}
            {suggestions.length > 0 && (
              <div className="ps-chips">
                {suggestions.map((s) => (
                  <button key={s} className="ps-chip" onClick={() => setOther(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {start && start.elsewhere.length > 0 && (
              <div className="ps-elsewhere">
                {start.elsewhere.map((e) => (
                  <button key={e.name} className="ps-elsewhere-row" onClick={() => setOther(e.name)}>
                    <span className="ps-strip">{e.sample.slice(0, 4).map((f) => <span key={f.faceId}>{face(f, "small")}</span>)}</span>
                    <span>{t("faces.split.elsewhere", { count: e.faceIds.length.toLocaleString(), name: e.name })}</span>
                  </button>
                ))}
                <p className="ps-note">{t("faces.split.elsewhereHint")}</p>
              </div>
            )}
            <div className="ps-actions">
              <button className="cf-btn" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="cf-btn primary" disabled={!otherName || sameName || !start} onClick={() => setStep("pick")}>
                {t("faces.split.next")}
              </button>
            </div>
          </div>
        )}

        {step === "pick" && start && (
          <div className="ps-body">
            <div className="ps-counts">
              <span className="ps-count a">{t("faces.split.examples", { name: here, count: a.length })}</span>
              <span className="ps-count b">
                {t("faces.split.examples", { name: otherName, count: bWithElsewhere.length })}
              </span>
              <span className="ps-note">{t("faces.split.pickHint")}</span>
            </div>
            {start.pairs.length > 0 && (
              <section className="ps-section">
                <h4 className="ps-h">{t("faces.split.pairs")}</h4>
                <p className="ps-note">{t("faces.split.pairsHint")}</p>
                <div className="ps-pairs">
                  {start.pairs.map((p) => {
                    const leftA = picks.get(p.left.faceId) === "a" && picks.get(p.right.faceId) === "b";
                    const leftB = picks.get(p.left.faceId) === "b" && picks.get(p.right.faceId) === "a";
                    const set = (l: Side | null) =>
                      setPicks((before) => {
                        const next = new Map(before);
                        if (l === null) {
                          next.delete(p.left.faceId);
                          next.delete(p.right.faceId);
                        } else {
                          next.set(p.left.faceId, l);
                          next.set(p.right.faceId, l === "a" ? "b" : "a");
                        }
                        return next;
                      });
                    return (
                      <div key={p.left.faceId} className={`ps-pair${leftA || leftB ? " on" : ""}`}>
                        <span className="ps-pair-faces">
                          {face(p.left, leftA ? "a" : leftB ? "b" : undefined)}
                          {face(p.right, leftA ? "b" : leftB ? "a" : undefined)}
                        </span>
                        <button className="ps-pair-pick" disabled={!otherName} onClick={() => set(leftA ? "b" : leftB ? null : "a")}>
                          {leftA
                            ? t("faces.split.leftRight", { left: here, right: otherName })
                            : leftB
                              ? t("faces.split.leftRight", { left: otherName, right: here })
                              : t("faces.split.whoIsWho")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            <section className="ps-section">
              <h4 className="ps-h">{t("faces.split.contrast")}</h4>
              <div className="ps-grid">
                {start.contrast.map((f) => (
                  <div key={f.faceId} className={`ps-cell${picks.get(f.faceId) ? ` ${picks.get(f.faceId)}` : ""}`}>
                    {face(f)}
                    {sideButtons(f.faceId)}
                  </div>
                ))}
              </div>
            </section>
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("name")}>
                {t("faces.split.back")}
              </button>
              <button className="cf-btn primary" disabled={a.length === 0 || bWithElsewhere.length === 0} onClick={() => setStep("preview")}>
                {t("faces.split.preview")}
              </button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="ps-body">
            {!plan ? (
              <p className="cf-msg">{t("faces.split.planning")}</p>
            ) : (
              <>
                <div className={`ps-bar${planning ? " busy" : ""}`} role="img" aria-label={`${here} ${plan.counts.a}, ${otherName} ${plan.counts.b}`}>
                  <span className="ps-bar-a" style={{ flexGrow: plan.counts.a }} />
                  <span className="ps-bar-b" style={{ flexGrow: plan.counts.b }} />
                  <span className="ps-bar-u" style={{ flexGrow: plan.counts.unsure + plan.counts.neither }} />
                </div>
                <div className="ps-legend">
                  <span><strong className="a">{here}</strong> {plan.counts.a.toLocaleString()}</span>
                  <span><strong className="b">{otherName}</strong> {plan.counts.b.toLocaleString()}</span>
                  <span><strong>{t("faces.split.unsure")}</strong> {plan.counts.unsure.toLocaleString()}</span>
                  {plan.counts.neither > 0 && (
                    <span><strong>{t("faces.split.others")}</strong> {plan.counts.neither.toLocaleString()}</span>
                  )}
                </div>
                <div className={`ps-verdict ${plan.verdict}`}>
                  <strong>{t(`faces.split.verdict.${plan.verdict}`)}</strong>
                  <span>
                    {t(`faces.split.verdictHint.${plan.verdict}`, {
                      right: plan.checked.right,
                      tried: plan.checked.tried,
                      share: Math.round(plan.clearShare * 100),
                    })}
                  </span>
                </div>
                <p className="ps-note">{t("faces.split.unsureNote", { name: here })}</p>
                <div className="ps-columns">
                  <section className="ps-section">
                    <h4 className="ps-h a">{t("faces.split.leastSure", { name: here })}</h4>
                    <div className="ps-strip wrap">
                      {plan.leastSureA.map((f) => (
                        <button key={f.faceId} className="ps-move" title={t("faces.split.moveTo", { name: otherName })} onClick={() => choose(f.faceId, "b")}>
                          {face(f, picks.get(f.faceId) ?? "a")}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="ps-section">
                    <h4 className="ps-h b">{t("faces.split.leastSure", { name: otherName })}</h4>
                    <div className="ps-strip wrap">
                      {plan.leastSureB.map((f) => (
                        <button key={f.faceId} className="ps-move" title={t("faces.split.moveTo", { name: here })} onClick={() => choose(f.faceId, "a")}>
                          {face(f, picks.get(f.faceId) ?? "b")}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <p className="ps-note">{t("faces.split.wrongOne")}</p>
              </>
            )}
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("pick")}>
                {t("faces.split.addExamples")}
              </button>
              {plan && plan.counts.unsure > 0 && (
                <button className="cf-btn" onClick={() => setStep("review")}>
                  {t("faces.split.reviewUnsure", { count: plan.counts.unsure.toLocaleString() })}
                </button>
              )}
              <button className="cf-btn primary" disabled={!plan || planning || busy} onClick={() => void apply()}>
                {t("faces.split.apply")}
              </button>
            </div>
          </div>
        )}

        {step === "review" && plan && (
          <div className="ps-body">
            <h4 className="ps-h">{t("faces.split.reviewTitle")}</h4>
            <p className="ps-note">{t("faces.split.reviewHint")}</p>
            <div className="ps-grid">
              {unsureLeft.slice(0, REVIEW_PAGE).map((f) => (
                <div key={f.faceId} className="ps-cell">
                  {face(f)}
                  <span className="ps-lean">
                    {f.lean === "even" ? t("faces.split.even") : t("faces.split.leans", { name: f.lean === "a" ? here : otherName })}
                  </span>
                  {sideButtons(f.faceId)}
                  <button className="ps-skip" onClick={() => setReviewed((r) => new Set(r).add(f.faceId))}>
                    {t("faces.split.skip")}
                  </button>
                </div>
              ))}
            </div>
            {unsureLeft.length === 0 && <p className="cf-msg">{t("faces.split.reviewDone")}</p>}
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("preview")}>
                {t("faces.split.back")}
              </button>
              <button className="cf-btn primary" disabled={planning || busy} onClick={() => void apply()}>
                {t("faces.split.apply")}
              </button>
            </div>
          </div>
        )}

        {step === "done" && applied && (
          <div className="ps-body">
            <p className="cf-msg">
              {t("faces.split.done", {
                name: here,
                other: otherName,
                stayed: applied.stayed.toLocaleString(),
                moved: applied.moved.toLocaleString(),
                others: applied.others.toLocaleString(),
                unsure: applied.unsure.toLocaleString(),
              })}
            </p>
            <p className="ps-note">{t("faces.split.phoneNote", { name: here })}</p>
            <div className="ps-actions">
              <button className="cf-btn" disabled={busy} onClick={() => void undo()}>
                {t("faces.split.undo")}
              </button>
              <button className="cf-btn primary" onClick={onClose}>
                {t("faces.split.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
