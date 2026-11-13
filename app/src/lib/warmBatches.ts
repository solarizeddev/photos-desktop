/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * The library's uids in timeline order, `size` at a time, leaving out those already in
 * `warmed`. Read lazily, so a uid warmed while the pass is under way (by an earlier pass
 * whose answer lands late) is not asked for again.
 */
export function* unwarmedBatches(uids: readonly string[], warmed: ReadonlySet<string>, size: number): Generator<string[]> {
  let batch: string[] = [];
  for (const uid of uids) {
    if (warmed.has(uid)) continue;
    batch.push(uid);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
