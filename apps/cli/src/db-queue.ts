import type { Database } from "@omt/core";

const tails = new WeakMap<Database, Promise<void>>();

/** Serialize complete operations on one connection, including reads during writer transactions.
 * Rejection reaches the caller but never poisons the next operation (spec §11.1).
 */
export function withDatabase<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(db) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => {},
    () => {},
  );
  tails.set(db, tail);
  void tail.then(() => {
    if (tails.get(db) === tail) tails.delete(db);
  });
  return result;
}
