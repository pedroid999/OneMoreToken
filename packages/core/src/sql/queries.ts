import { z } from "zod";

/** A saved SQL query is one bounded query text (spec §7.1, Phase 4 T4). */
export const MAX_SQL_LENGTH = 20_000;
/** Per-file and per-request limit for a saved query. */
export const MAX_SAVED_QUERY_BYTES = 64 * 1024;
export const SAVED_QUERY_ID = /^[a-z0-9-]{1,64}$/;

const fields = {
  name: z.string().trim().min(1).max(120),
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
};

/** Body of PUT /api/sql/views/:id: the schema, the id and the timestamp belong to the server. */
export const SavedQueryInputSchema = z.object(fields).strict();
export type SavedQueryInput = z.infer<typeof SavedQueryInputSchema>;

/** Stored file `sql-views/<id>.json`: private, atomic and never followed when it is a symlink. */
export const SavedQuerySchema = z
  .object({
    schema: z.literal("omt.saved-query/1"),
    id: z.string().regex(SAVED_QUERY_ID),
    ...fields,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SavedQuery = z.infer<typeof SavedQuerySchema>;
