/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));
vi.mock("./ocr.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ocr.ts")>()),
  ocrModelStatus: () => ({ state: "ready" }),
  readText: vi.fn(async () => ({ width: 1, height: 1, blocks: [] })),
}));

import { ProtonSession } from "./session.ts";

/** A session whose photo fetches wait until the test lets each one finish. */
function withFetches() {
  const session = new ProtonSession();
  const fetching: { uid: string; finish: () => void }[] = [];
  (session as any).ocrBytes = (source: { uid: string }) =>
    new Promise<Buffer>((resolve) => fetching.push({ uid: source.uid, finish: () => resolve(Buffer.from([1])) }));
  return { session, fetching };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("reading text as the viewer steps through photos", () => {
  it("fetches one photo at a time, and never one a newer read has passed", async () => {
    const { session, fetching } = withFetches();

    const a = session.ocrStart({ uid: "a" }).id;
    await settle();
    expect(fetching.map((f) => f.uid)).toEqual(["a"]);
    const b = session.ocrStart({ uid: "b" }).id;
    const c = session.ocrStart({ uid: "c" }).id;
    await settle();
    expect(fetching.map((f) => f.uid)).toEqual(["a"]);

    fetching[0].finish();
    await settle();
    await settle();
    // b was passed by c while it waited: it is never fetched, and c goes next.
    expect(fetching.map((f) => f.uid)).toEqual(["a", "c"]);
    expect(session.ocrResult(a)?.state).toBe("failed");
    expect(session.ocrResult(b)?.state).toBe("failed");

    fetching[1].finish();
    await vi.waitFor(() => expect(session.ocrResult(c)?.state).toBe("done"));
  });

  it("fetches nothing for reads passed before their turn came", async () => {
    const { session, fetching } = withFetches();

    const a = session.ocrStart({ uid: "a" }).id;
    session.ocrStart({ uid: "b" });
    const c = session.ocrStart({ uid: "c" }).id;
    await settle();
    expect(fetching.map((f) => f.uid)).toEqual(["c"]);
    expect(session.ocrResult(a)?.state).toBe("failed");
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(c)?.state).toBe("done"));
  });

  it("reads the newest photo once the fetch ahead of it is done", async () => {
    const { session, fetching } = withFetches();

    const a = session.ocrStart({ uid: "a" }).id;
    await settle();
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(a)?.state).toBe("done"));

    const b = session.ocrStart({ uid: "b" }).id;
    await settle();
    expect(fetching.map((f) => f.uid)).toEqual(["a", "b"]);
    fetching[1].finish();
    await vi.waitFor(() => expect(session.ocrResult(b)?.state).toBe("done"));
  });

  it("lets the next fetch go when one fails", async () => {
    const session = new ProtonSession();
    let calls = 0;
    (session as any).ocrBytes = async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return Buffer.from([1]);
    };
    const a = session.ocrStart({ uid: "a" }).id;
    await vi.waitFor(() => expect(session.ocrResult(a)?.state).toBe("failed"));
    const b = session.ocrStart({ uid: "b" }).id;
    await vi.waitFor(() => expect(session.ocrResult(b)?.state).toBe("done"));
  });
});
