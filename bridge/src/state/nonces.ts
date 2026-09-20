import type { NonceJournal, NonceRecord } from "../auth/verify";

import { JsonlJournal } from "./journal";

/**
 * JSON Lines backing store for `NonceCache`, per the "Replay protection" section of
 * docs/durability-v0.md. `filePath === undefined` yields a journal that persists nothing, which
 * is the in-memory behavior slice 1 had.
 */
export function createNonceJournal(filePath?: string): NonceJournal {
  const journal = new JsonlJournal<NonceRecord>(filePath);
  return {
    load: () => journal.load(),
    append: (record) => journal.append(record),
    rewrite: (records) => journal.rewrite(records),
  };
}
