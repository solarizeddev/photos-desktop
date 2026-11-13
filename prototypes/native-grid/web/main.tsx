// The baseline page: the app's timeline grid, exactly as the Photos view mounts it
// (VirtualSections with a month header, PhotoGrid inside), over the same tiles and the same
// thumbnail server as the native side, driven through the same scroll script.

import { useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import "@app/styles/theme.css";
import "@app/styles/Photos.css";
import { VirtualSections } from "@app/components/VirtualSections";
import { PhotoGrid } from "@app/components/PhotoGrid";
import { connectThumbServer } from "@app/lib/thumbStore";
import type { MountedGrid, Probe } from "./grids/layout";
import { mountPool } from "./grids/pool";
import { mountCanvas } from "./grids/canvas";

type Phase = { name: string; kind: "idle" | "linear" | "fling"; v?: number; tau?: number; ms: number };
/** `grid`: "app" (the app's own components), "pool" (reused DOM tiles) or "canvas". */
type Config = { n: number; cell: number; sections: boolean; grid?: string; phases: Phase[] };

const log = (m: string) => fetch("/log", { method: "POST", body: m }).catch(() => {});
window.addEventListener("error", (e) => log("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("rejection: " + String(e.reason)));

function App({ cfg }: { cfg: Config }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The same month-like sections the native side makes (ng_common::sections).
  const sections = useMemo(() => {
    const out = [];
    let i = 0;
    let m = 0;
    while (i < cfg.n) {
      const c = cfg.sections ? Math.min(cfg.n - i, 150 + ((m * 977) % 700)) : cfg.n;
      out.push({ key: "Month " + m, items: Array.from({ length: c }, (_, k) => ({ uid: "u" + (i + k), tags: [] as number[] })) });
      i += c;
      m++;
    }
    return out;
  }, [cfg]);
  const selected = useMemo(() => new Set<string>(), []);
  return (
    <div className="g-scroll" ref={scrollRef}>
      <VirtualSections
        scrollRef={scrollRef}
        sections={sections}
        cellSize={cfg.cell}
        header={cfg.sections ? (s) => (
          <div className="g-monthhdr">
            <span className="g-monthtitle">{s.key}</span>
            <span className="g-monthcount">{s.items.length} photos</span>
          </div>
        ) : undefined}
        grid={(_, items) => (
          <PhotoGrid items={items} cellSize={cfg.cell} selected={selected} onToggle={() => {}} onOpen={() => {}} onContext={() => {}} />
        )}
      />
    </div>
  );
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** How far the list has moved `t` ms into a phase: ng_common::Phase::offset, to the letter. */
function offset(p: Phase, t: number): number {
  const s = Math.min(Math.max(t, 0), p.ms) / 1000;
  if (p.kind === "linear") return p.v! * s;
  if (p.kind === "fling") return p.v! * p.tau! * (1 - Math.exp(-s / p.tau!));
  return 0;
}

/** The app's grid, mounted by React; its tiles are read back from the page. */
async function mountApp(cfg: Config): Promise<MountedGrid> {
  createRoot(document.getElementById("root")!).render(<App cfg={cfg} />);
  let sc: HTMLElement | null = null;
  while (!(sc = document.querySelector(".g-scroll")) || !sc.querySelector(".g-cell")) await frame();
  const scroller = sc;
  return {
    scroller,
    get gridWidth() {
      return (scroller.querySelector(".g-grid") as HTMLElement | null)?.clientWidth ?? 0;
    },
    probe(): Probe {
      const view = scroller.getBoundingClientRect();
      const cells = scroller.querySelectorAll<HTMLElement>(".g-cell");
      const xs = new Set<number>();
      let vis = 0;
      let blank = 0;
      let tile: [number, number] = [0, 0];
      for (const c of cells) {
        const r = c.getBoundingClientRect();
        if (r.bottom <= view.top || r.top >= view.bottom) continue;
        vis++;
        xs.add(Math.round(r.left));
        tile = [Math.round(r.width), Math.round(r.height)];
        if (!c.querySelector("img[data-ok]")) blank++;
      }
      return { vis, blank, columns: xs.size, tile, built: cells.length };
    },
  };
}

async function run() {
  const cfg: Config = await (await fetch("/config.json")).json();
  const grid = cfg.grid ?? "app";
  const extra: Record<string, unknown> = {};
  let g: MountedGrid;
  if (grid === "pool" || grid === "canvas") {
    const base = location.origin + "/t/tok/";
    const root = document.getElementById("root")!;
    g = grid === "pool" ? mountPool(root, cfg, base) : mountCanvas(root, cfg, base, (where) => (extra.decode_in = where));
    await frame();
  } else {
    await connectThumbServer();
    g = await mountApp(cfg);
  }
  const sc = g.scroller;

  const data = cfg.phases.map((p) => ({ name: p.name, dts: [] as number[], probes: 0, probesBlank: 0, blankSum: 0, visSum: 0 }));
  const env = { columns: 0, tile_drawn: [0, 0], hit_end: false, cells_built_max: 0 };
  let base = 0;
  let last = performance.now();
  let lastProbe = 0;
  for (let i = 0; i < cfg.phases.length; i++) {
    const p = cfg.phases[i];
    const d = data[i];
    fetch("/mark?p=" + p.name);
    const t0 = last;
    for (;;) {
      await frame();
      const now = performance.now();
      d.dts.push(now - last);
      last = now;
      const t = now - t0;
      if (t >= p.ms) break;
      // Ten times a second: which tiles are on screen, and which of them have no picture yet.
      if (now - lastProbe >= 100) {
        lastProbe = now;
        const { vis, blank, columns, tile, built } = g.probe();
        if (vis > 0) env.tile_drawn = tile;
        env.columns = Math.max(env.columns, columns);
        env.cells_built_max = Math.max(env.cells_built_max, built);
        d.probes++;
        d.visSum += vis;
        d.blankSum += blank;
        if (blank > 0) d.probesBlank++;
      }
      if (p.kind !== "idle") {
        const want = base + offset(p, t);
        const max = sc.scrollHeight - sc.clientHeight;
        if (want < -1 || want > max + 1) env.hit_end = true;
        sc.scrollTop = Math.min(Math.max(want, 0), max);
      }
    }
    base += offset(p, p.ms);
  }
  await fetch("/mark?p=end");
  await fetch("/report", {
    method: "POST",
    body: JSON.stringify({
      phases: data,
      env: { ...env, ...extra, ua: navigator.userAgent, scale: devicePixelRatio, view: [sc.clientWidth, sc.clientHeight], window: [innerWidth, innerHeight], list_height: sc.scrollHeight, grid_width: g.gridWidth || null },
    }),
  });
}

run().catch((e) => log("run failed: " + (e?.stack ?? e)));
