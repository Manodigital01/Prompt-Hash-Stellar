/**
 * Deterministic duplicate-record merge with explicit conflict resolution (#902).
 *
 *   plan    → pure. Checks eligibility, diffs the mergeable fields, lists
 *             conflicts, and returns a `planHash` that binds the preview to
 *             the exact records it was computed from.
 *   resolve → pure. Every conflict needs an explicit `keep_source` or
 *             `keep_target`. Nothing is picked silently.
 *   execute → IO. Re-plans against the current records and refuses when the
 *             supplied `planHash` no longer matches (a stale preview). It then
 *             writes a pending merge record with a rollback snapshot, applies
 *             the writes, and marks the merge committed.
 *
 * Merged sources stay addressable: `resolveMergedRecordId` follows committed
 * redirects, with cycle detection and a hop limit.
 *
 * Runbook: docs/operations/record-merge.md
 */

import { createHash, randomUUID } from "crypto";
import { canonicalJson } from "./canonicalSerialization";
import RecordMerge, { type RecordMergeStatus } from "../models/RecordMerge";

/** Fields that can be merged. Ownership, on-chain identity and status never merge. */
export const MERGEABLE_FIELDS = ["title", "description", "tags", "price"] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export const MAX_MERGE_REDIRECT_HOPS = 10;

export type MergeDenialCode =
  | "same_record"
  | "owner_mismatch"
  | "source_merged"
  | "target_merged"
  | "target_inactive"
  | "source_on_chain"
  | "source_has_licenses";

export type MergeConflictCategory = "value_conflict" | "type_mismatch";

export type MergeResolution = "keep_source" | "keep_target";

export type MergeErrorCode =
  | "denied"
  | "conflict_unresolved"
  | "unknown_resolution"
  | "invalid_resolution"
  | "stale_plan"
  | "not_found"
  | "merge_cycle";

export class RecordMergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordMergeError";
  }
}

export interface MergeableRecord {
  id: string;
  ownerId: string;
  isActive: boolean;
  /** Set when this record was merged into another. */
  mergedInto?: string | null;
  /** On-chain listings cannot be redirected by a database write. */
  onChainId?: string | null;
  /** Purchases that reference this record. Any licence blocks the merge. */
  activeLicenseCount: number;
  fields: Partial<Record<MergeableField, unknown>>;
}

export interface MergeDenial {
  code: MergeDenialCode;
  message: string;
}

export interface MergeChange {
  field: MergeableField;
  from: unknown;
  to: unknown;
  origin: "source" | "target";
}

export interface MergeConflict {
  field: MergeableField;
  category: MergeConflictCategory;
  sourceValue: unknown;
  targetValue: unknown;
}

export interface MergePlan {
  sourceId: string;
  targetId: string;
  eligible: boolean;
  denials: MergeDenial[];
  /** Target fields the merge would change. Empty when nothing moves. */
  changes: MergeChange[];
  conflicts: MergeConflict[];
  /**
   * Result fields with every conflict left at its target value. Resolution
   * replaces those values. Null when the merge is denied.
   */
  mergedFields: Partial<Record<MergeableField, unknown>> | null;
  planHash: string;
}

/** Empty values never count as content, so they never conflict. */
function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Pure merge plan. Same inputs always produce the same plan and `planHash`,
 * because fields are visited in `MERGEABLE_FIELDS` order and values are
 * serialized canonically.
 */
export function planRecordMerge(source: MergeableRecord, target: MergeableRecord): MergePlan {
  const denials: MergeDenial[] = [];
  const deny = (code: MergeDenialCode, message: string) => denials.push({ code, message });

  if (source.id === target.id) {
    deny("same_record", "A record cannot be merged into itself.");
  }
  if (source.ownerId !== target.ownerId) {
    deny("owner_mismatch", "Records with different owners cannot be merged.");
  }
  if (source.mergedInto) {
    deny("source_merged", "The source record has already been merged.");
  }
  if (target.mergedInto) {
    deny("target_merged", "The target record has been merged into another record.");
  }
  if (!target.isActive) {
    deny("target_inactive", "The target record must be active.");
  }
  if (source.onChainId) {
    deny("source_on_chain", "A record with an on-chain listing cannot be merged away.");
  }
  if (source.activeLicenseCount > 0) {
    deny(
      "source_has_licenses",
      `The source record has ${source.activeLicenseCount} licence(s) and cannot be merged away.`,
    );
  }

  const changes: MergeChange[] = [];
  const conflicts: MergeConflict[] = [];
  const mergedFields: Partial<Record<MergeableField, unknown>> = {};

  for (const field of MERGEABLE_FIELDS) {
    const sourceValue = source.fields[field];
    const targetValue = target.fields[field];

    if (isEmpty(sourceValue)) {
      if (targetValue !== undefined) mergedFields[field] = targetValue;
      continue;
    }
    if (isEmpty(targetValue)) {
      mergedFields[field] = sourceValue;
      changes.push({ field, from: targetValue ?? null, to: sourceValue, origin: "source" });
      continue;
    }
    if (sameValue(sourceValue, targetValue)) {
      mergedFields[field] = targetValue;
      continue;
    }

    const category: MergeConflictCategory =
      valueType(sourceValue) === valueType(targetValue) ? "value_conflict" : "type_mismatch";
    conflicts.push({ field, category, sourceValue, targetValue });
    mergedFields[field] = targetValue;
  }

  const eligible = denials.length === 0;
  const planHash = createHash("sha256")
    .update(
      canonicalJson({
        sourceId: source.id,
        targetId: target.id,
        eligible,
        denials: denials.map((d) => d.code),
        source: pickFields(source.fields),
        target: pickFields(target.fields),
        activeLicenseCount: source.activeLicenseCount,
      }),
    )
    .digest("hex");

  return {
    sourceId: source.id,
    targetId: target.id,
    eligible,
    denials,
    changes,
    conflicts,
    mergedFields: eligible ? mergedFields : null,
    planHash,
  };
}

function pickFields(fields: MergeableRecord["fields"]) {
  const picked: Record<string, unknown> = {};
  for (const field of MERGEABLE_FIELDS) {
    picked[field] = fields[field] ?? null;
  }
  return picked;
}

/**
 * Apply explicit resolutions to a plan and return the fields to write.
 * Every conflict must be resolved, and nothing outside the conflict set may be
 * named, so a typo cannot silently keep the wrong side.
 */
export function resolveMergeConflicts(
  plan: MergePlan,
  resolutions: Partial<Record<string, MergeResolution>> = {},
): Partial<Record<MergeableField, unknown>> {
  if (!plan.eligible || !plan.mergedFields) {
    throw new RecordMergeError("denied", "The merge is not eligible and cannot be resolved.");
  }

  const conflictFields = new Set<string>(plan.conflicts.map((c) => c.field));
  for (const [field, choice] of Object.entries(resolutions)) {
    if (!conflictFields.has(field)) {
      throw new RecordMergeError("unknown_resolution", `${field} is not a conflicting field.`);
    }
    if (choice !== "keep_source" && choice !== "keep_target") {
      throw new RecordMergeError("invalid_resolution", `${field} must be keep_source or keep_target.`);
    }
  }

  const unresolved = plan.conflicts.filter((c) => !resolutions[c.field]).map((c) => c.field);
  if (unresolved.length > 0) {
    throw new RecordMergeError(
      "conflict_unresolved",
      `Resolve every conflict before merging: ${unresolved.join(", ")}.`,
    );
  }

  const result: Partial<Record<MergeableField, unknown>> = { ...plan.mergedFields };
  for (const conflict of plan.conflicts) {
    result[conflict.field] =
      resolutions[conflict.field] === "keep_source" ? conflict.sourceValue : conflict.targetValue;
  }
  return result;
}

/**
 * Human-readable steps for reverting a committed merge. Stored with the merge
 * record so an operator does not need the original code to undo it.
 */
export function buildRollbackNotes(input: {
  mergeId: string;
  sourceId: string;
  targetId: string;
  snapshot: MergeSnapshot;
}): string {
  return [
    `Rollback merge ${input.mergeId}:`,
    `1. Set source ${input.sourceId} isActive to ${input.snapshot.source.isActive} and clear mergedInto.`,
    `2. Restore source fields: ${canonicalJson(input.snapshot.source.fields)}.`,
    `3. Restore target ${input.targetId} fields: ${canonicalJson(input.snapshot.target.fields)}.`,
    "4. Keep this merge record for audit and note the rollback on the ticket.",
  ].join("\n");
}

export interface MergeSnapshot {
  source: { isActive: boolean; fields: MergeableRecord["fields"] };
  target: { isActive: boolean; fields: MergeableRecord["fields"] };
}

/**
 * Follow committed redirects from a merged record to the record that now holds
 * its content. Stops with `merge_cycle` on a loop or after too many hops.
 */
export async function resolveMergedRecordId(
  id: string,
  lookupRedirect: (sourceId: string) => Promise<string | null>,
  maxHops: number = MAX_MERGE_REDIRECT_HOPS,
): Promise<{ id: string; hops: string[] }> {
  const seen = new Set<string>([id]);
  const hops: string[] = [];
  let current = id;

  for (;;) {
    const next = await lookupRedirect(current);
    if (!next) return { id: current, hops };
    if (seen.has(next) || hops.length >= maxHops) {
      throw new RecordMergeError("merge_cycle", `Merge redirect from ${id} loops or exceeds ${maxHops} hops.`);
    }
    seen.add(next);
    hops.push(next);
    current = next;
  }
}

// ─── IO ──────────────────────────────────────────────────────────────────────

/** Storage operations the merge needs. Supplied by the caller so this module stays free of persistence details. */
export interface RecordMergeAdapter {
  loadRecord(id: string): Promise<MergeableRecord | null>;
  /** Write the merged fields to the target and deactivate the source. */
  applyMerge(input: { sourceId: string; targetId: string; mergedFields: MergeableRecord["fields"] }): Promise<void>;
}

export interface ExecuteRecordMergeInput {
  sourceId: string;
  targetId: string;
  expectedPlanHash: string;
  resolutions?: Partial<Record<string, MergeResolution>>;
  actor: string;
  requestId?: string | null;
  now?: Date;
}

export interface ExecuteRecordMergeResult {
  mergeId: string;
  status: RecordMergeStatus;
  plan: MergePlan;
  mergedFields: Partial<Record<MergeableField, unknown>>;
}

export async function executeRecordMerge(
  adapter: RecordMergeAdapter,
  input: ExecuteRecordMergeInput,
): Promise<ExecuteRecordMergeResult> {
  const source = await adapter.loadRecord(input.sourceId);
  const target = await adapter.loadRecord(input.targetId);
  if (!source || !target) {
    throw new RecordMergeError("not_found", "Source or target record was not found.");
  }

  const plan = planRecordMerge(source, target);
  if (plan.planHash !== input.expectedPlanHash) {
    throw new RecordMergeError("stale_plan", "The records changed since the preview. Plan again.");
  }
  const mergedFields = resolveMergeConflicts(plan, input.resolutions ?? {});

  // Unique per attempt, so a retry after a failed write never collides with
  // the earlier pending or failed record. The planHash still guards staleness.
  const mergeId = `mrg_${randomUUID()}`;
  const snapshot: MergeSnapshot = {
    source: { isActive: source.isActive, fields: source.fields },
    target: { isActive: target.isActive, fields: target.fields },
  };

  await RecordMerge.create({
    mergeId,
    sourceId: source.id,
    targetId: target.id,
    status: "pending",
    planHash: plan.planHash,
    resolutions: input.resolutions ?? {},
    mergedFields,
    snapshot,
    rollbackNotes: buildRollbackNotes({ mergeId, sourceId: source.id, targetId: target.id, snapshot }),
    actor: input.actor,
    requestId: input.requestId ?? null,
    createdAt: input.now ?? new Date(),
  });

  try {
    await adapter.applyMerge({ sourceId: source.id, targetId: target.id, mergedFields });
  } catch (err) {
    await RecordMerge.updateOne(
      { mergeId },
      { $set: { status: "failed", failureReason: err instanceof Error ? err.message : "unknown error" } },
    );
    throw err;
  }

  await RecordMerge.updateOne(
    { mergeId },
    { $set: { status: "committed", resolvedAt: input.now ?? new Date() } },
  );

  return { mergeId, status: "committed", plan, mergedFields };
}

/** Redirect lookup backed by committed merge records. */
export function committedRedirectLookup(sourceId: string): Promise<string | null> {
  return RecordMerge.findOne({ sourceId, status: "committed" })
    .lean()
    .then((doc) => (doc as { targetId?: string } | null)?.targetId ?? null);
}
