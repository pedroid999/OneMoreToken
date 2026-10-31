import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Database } from "../db/database";

/** gentle-shell session profile entries (spec §6.2): `bind` and `clear` in Pi `custom` entries. */
export const SESSION_PROFILE_CUSTOM_TYPE = "gentle-pi.session-profile/v1";
/** Any version of the family: an unknown version ends the current binding, never revives one. */
export const SESSION_PROFILE_FAMILY = "gentle-pi.session-profile/";

const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const value = z.string().min(1).max(256);

export const ProfileRouteSchema = z
  .object({ model: value.optional(), thinking: value.optional() })
  .strict();
export type ProfileRoute = z.infer<typeof ProfileRouteSchema>;

/** The hashed part of a snapshot: the complete routing of one profile (spec §6). */
export const ProfileDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    roles: z.record(z.string().regex(ROLE_NAME), ProfileRouteSchema),
  })
  .strict();
export type ProfileDefinition = z.infer<typeof ProfileDefinitionSchema>;

/** A `profiles` row whose definition is validated. */
export interface ProfileSnapshot {
  hash: string;
  name: string;
  definition: ProfileDefinition;
  first_seen_at: string;
}

type ObjectRecord = Record<string, unknown>;
const isObject = (input: unknown): input is ObjectRecord =>
  input !== null && typeof input === "object" && !Array.isArray(input);

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (isObject(input)) {
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

/** sha256 of the canonical `{name, roles}` (L10). */
export function profileHash(definition: ProfileDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

/** Whitelist of one role route: `model` and `thinking` (legacy `effort`); a string is its model. */
function route(raw: unknown): ProfileRoute | null {
  const source = typeof raw === "string" ? { model: raw } : isObject(raw) ? raw : null;
  if (!source) return null;
  const pick = (input: unknown) => (value.safeParse(input).success ? (input as string) : undefined);
  const model = pick(source.model);
  const thinking = pick(source.thinking) ?? pick(source.effort);
  if (model === undefined && thinking === undefined) return null;
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/** Only `<role>.{model, thinking|effort}` survives; every other key is dropped (spec §10, L10). */
export function profileSnapshot(
  name: unknown,
  roles: unknown,
  seenAt: string,
): ProfileSnapshot | null {
  if (!isObject(roles)) return null;
  const kept: Record<string, ProfileRoute> = {};
  for (const role of Object.keys(roles).sort()) {
    const entry = ROLE_NAME.test(role) ? route(roles[role]) : null;
    if (entry) kept[role] = entry;
  }
  const parsed = ProfileDefinitionSchema.safeParse({ name, roles: kept });
  if (!parsed.success || Object.keys(kept).length === 0) return null;
  return {
    hash: profileHash(parsed.data),
    name: parsed.data.name,
    definition: parsed.data,
    first_seen_at: seenAt,
  };
}

/** `profiles.json` of gentle-shell: only `profiles` is read; `kind`, when present, must match. */
export function parseProfilesFile(raw: unknown, seenAt: string): ProfileSnapshot[] | null {
  if (!isObject(raw) || !isObject(raw.profiles)) return null;
  if (raw.kind !== undefined && raw.kind !== "gentle-pi.agent_model_profiles") return null;
  const profiles = raw.profiles;
  return Object.keys(profiles)
    .sort()
    .flatMap((name) => profileSnapshot(name, profiles[name], seenAt) ?? []);
}

export function defaultProfilesPath(home = homedir()): string {
  return join(home, ".gentle-shell", "config", "gentle-ai", "profiles.json");
}

export type ProfilesFileResult = {
  status: "ok" | "missing" | "invalid";
  snapshots: ProfileSnapshot[];
};

/** One read-only whole-file read; never written, locked or kept beyond the whitelist. */
export function readProfilesFile(path: string, seenAt: string): ProfilesFileResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { status: missing ? "missing" : "invalid", snapshots: [] };
  }
  try {
    const snapshots = parseProfilesFile(JSON.parse(text), seenAt);
    return snapshots ? { status: "ok", snapshots } : { status: "invalid", snapshots: [] };
  } catch {
    return { status: "invalid", snapshots: [] };
  }
}

/** Snapshots accumulate (versioned, spec §6.2): a known hash only keeps its earliest sighting.
 * The caller owns the transaction and the writer queue.
 */
export async function upsertProfiles(
  db: Database,
  snapshots: readonly ProfileSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    await db.run(
      `INSERT INTO profiles (hash, name, definition, first_seen_at)
       VALUES ($1, $2, $3::JSON, $4::TIMESTAMPTZ)
       ON CONFLICT (hash) DO UPDATE SET
         first_seen_at = least(profiles.first_seen_at, excluded.first_seen_at)`,
      [snapshot.hash, snapshot.name, JSON.stringify(snapshot.definition), snapshot.first_seen_at],
    );
  }
}
