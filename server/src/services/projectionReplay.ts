/**
 * Versioned event replay for rebuilding projections (#1024).
 *
 * A projection is a pure reducer over journaled contract events. A replay
 * builds a NEW copy of the projection from the event journal (isolated by
 * run id), and only an explicit activation makes it the served copy; the
 * previous copy is kept so activation can be rolled back. Nothing a replay
 * does can corrupt the projection that is currently live.
 *
 * Versioning is checked on two axes:
 *   - projection version — bumped whenever the reducer's output changes, so
 *     runs built by different reducer versions are never confused;
 *   - event schema version — each projection declares which versions of each
 *     event it understands. An event in an unknown version either stops a
 *     strict run (checkpointed just before it, so it can resume after the
 *     consumer is upgraded) or, in lenient mode, is skipped and sampled for
 *     review.
 *
 * Runs are resumable: progress is checkpointed after every page and each
 * projection row remembers the last event applied to it, so re-processing a
 * page after a crash is idempotent. A lease prevents two workers from driving
 * the same run.
 *
 * See docs/operations/event-replay.md.
 */

import { randomUUID } from "crypto";
import { ProjectionDocument, ProjectionPointer, ProjectionRun } from "../models/ProjectionRun";
import { EventJournal } from "../models/EventJournal";
import { readJournalPage, type JournalCursor } from "./eventJournal";
import { logger, recordAuditEvent } from "./auditTrail";

export interface ReplayEvent {
  eventId: string;
  ledger: number;
  eventType: string;
  eventVersion: number;
  payload: Record<string, any>;
}

export interface ProjectionDefinition<D = Record<string, unknown>> {
  name: string;
  version: number;
  description: string;
  /** Event type → schema versions this reducer understands. */
  supportedEvents: Record<string, readonly number[]>;
  keyOf: (event: ReplayEvent) => string | null;
  /** Pure: returns the next row, or null to delete it. */
  apply: (current: D | null, event: ReplayEvent) => D | null;
}

export class ReplayError extends Error {
  constructor(
    readonly code:
      | "unknown_projection"
      | "run_not_found"
      | "run_not_claimable"
      | "run_not_activatable"
      | "nothing_to_roll_back"
      | "checkpoint_event_missing",
    message: string,
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface PromptListingRow {
  promptId: string;
  creator: string | null;
  asset: string | null;
  priceStroops: string | null;
  active: boolean;
  salesCount: number;
  revenueStroops: string;
  /** True when a purchase/update arrived for a prompt with no creation event. */
  incomplete: boolean;
}

function emptyListing(promptId: string): PromptListingRow {
  return {
    promptId,
    creator: null,
    asset: null,
    priceStroops: null,
    active: false,
    salesCount: 0,
    revenueStroops: "0",
    incomplete: true,
  };
}

/** Per-prompt listing and sales summary, rebuilt purely from events. */
export const promptListingProjection: ProjectionDefinition<PromptListingRow> = {
  name: "prompt_listing",
  version: 1,
  description: "Per-prompt listing state (creator, price, sale status) and sales totals.",
  supportedEvents: {
    PromptCreated: [1, 2],
    PromptPurchased: [1, 2],
    PromptPriceUpdated: [1, 2],
    PromptSaleStatusUpdated: [1, 2],
  },
  keyOf: (event) => (event.payload?.prompt_id !== undefined ? String(event.payload.prompt_id) : null),
  apply: (current, event) => {
    const p = event.payload;
    const row = current ?? emptyListing(String(p.prompt_id));
    switch (event.eventType) {
      case "PromptCreated":
        return {
          ...row,
          creator: p.creator ?? null,
          asset: p.asset ?? null,
          priceStroops: p.price_stroops !== undefined ? String(p.price_stroops) : null,
          active: true,
          incomplete: false,
        };
      case "PromptPurchased":
        return {
          ...row,
          salesCount: row.salesCount + 1,
          revenueStroops: (BigInt(row.revenueStroops) + BigInt(p.price_stroops ?? 0)).toString(),
        };
      case "PromptPriceUpdated":
        return { ...row, priceStroops: String(p.price_stroops) };
      case "PromptSaleStatusUpdated":
        return { ...row, active: Boolean(p.active) };
      default:
        return row;
    }
  },
};

const PROJECTIONS: Record<string, ProjectionDefinition<any>> = {
  [promptListingProjection.name]: promptListingProjection,
};

export function getProjection(name: string): ProjectionDefinition<any> {
  const projection = PROJECTIONS[name];
  if (!projection) throw new ReplayError("unknown_projection", `Unknown projection: ${name}`);
  return projection;
}

export function listProjections() {
  return Object.values(PROJECTIONS).map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    supportedEvents: p.supportedEvents,
  }));
}

// ---------------------------------------------------------------------------
// Pure replay step (shared by the engine and tests)
// ---------------------------------------------------------------------------

interface StoredRow {
  data: unknown;
  lastLedger: number;
  lastEventId: string;
}

export type EventDisposition = "applied" | "ignored" | "unsupported";

function isAfter(event: ReplayEvent, row: StoredRow | null): boolean {
  if (!row) return true;
  return event.ledger > row.lastLedger || (event.ledger === row.lastLedger && event.eventId > row.lastEventId);
}

export function classifyEvent(projection: ProjectionDefinition<any>, event: ReplayEvent): EventDisposition {
  const versions = projection.supportedEvents[event.eventType];
  if (!versions) return "ignored";
  return versions.includes(event.eventVersion) ? "applied" : "unsupported";
}

export type ParsedReplayEvent =
  | { ok: true; event: ReplayEvent }
  | { ok: false; reason: string; checkpointable: boolean };

/**
 * Checks a journal row's shape before any reducer sees it. `checkpointable`
 * is false when the row's identity (`eventId`, `ledger`) is unusable: the
 * replay cursor cannot move past such a row, so no mode may skip it.
 */
export function parseReplayEvent(raw: any): ParsedReplayEvent {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "row is not an object", checkpointable: false };
  }
  if (typeof raw.eventId !== "string" || raw.eventId.length === 0) {
    return { ok: false, reason: "eventId must be a non-empty string", checkpointable: false };
  }
  if (!Number.isSafeInteger(raw.ledger) || raw.ledger < 0) {
    return { ok: false, reason: "ledger must be a non-negative integer", checkpointable: false };
  }
  if (typeof raw.eventType !== "string" || raw.eventType.length === 0) {
    return { ok: false, reason: "eventType must be a non-empty string", checkpointable: true };
  }
  if (!Number.isSafeInteger(raw.eventVersion) || raw.eventVersion < 1) {
    return { ok: false, reason: "eventVersion must be a positive integer", checkpointable: true };
  }
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    return { ok: false, reason: "payload must be an object", checkpointable: true };
  }
  return {
    ok: true,
    event: {
      eventId: raw.eventId,
      ledger: raw.ledger,
      eventType: raw.eventType,
      eventVersion: raw.eventVersion,
      payload: raw.payload,
    },
  };
}

function applyFailure(event: ReplayEvent, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `apply_failed: ${event.eventType} v${event.eventVersion} at ledger ${event.ledger} (${event.eventId}): ${message}`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 500;
const LEASE_MS = 60_000;
const MAX_UNSUPPORTED_SAMPLES = 20;
const MAX_MALFORMED_SAMPLES = 20;

export interface StartReplayInput {
  projection: string;
  mode: "build" | "dry_run";
  strict?: boolean;
  startedBy: string;
}

export async function startReplay(input: StartReplayInput) {
  const projection = getProjection(input.projection);
  const run = await ProjectionRun.create({
    runId: randomUUID(),
    projection: projection.name,
    projectionVersion: projection.version,
    mode: input.mode,
    strict: input.strict ?? true,
    startedBy: input.startedBy,
  });
  await recordAuditEvent({
    action: "admin_projection_replay",
    result: "success",
    actor: input.startedBy,
    target: run.runId,
    targetType: "projection_run",
    reason: `projection=${projection.name}@v${projection.version} mode=${input.mode} strict=${run.strict}`,
  });
  return run.toObject();
}

/**
 * Claim a run for this worker: pending or failed runs, or a running run whose
 * lease has expired (its worker died). Returns null when someone else holds it
 * or it already completed.
 */
async function claimRun(runId: string, now: Date) {
  return ProjectionRun.findOneAndUpdate(
    {
      runId,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "running", leaseExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: { status: "running", leaseExpiresAt: new Date(now.getTime() + LEASE_MS), error: null },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
}

/**
 * Drive a run to completion (or to a strict-mode stop / failure). Safe to call
 * again on a failed or abandoned run: it resumes from the last checkpoint.
 */
export async function runReplay(
  runId: string,
  options: { batchSize?: number; now?: () => Date } = {},
): Promise<any> {
  const now = options.now ?? (() => new Date());
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 5_000);

  const existing: any = await ProjectionRun.findOne({ runId }).lean();
  if (!existing) throw new ReplayError("run_not_found", `No replay run ${runId}`);

  const claimed: any = await claimRun(runId, now());
  if (!claimed) {
    throw new ReplayError("run_not_claimable", `Run ${runId} is ${existing.status} and cannot be (re)started now.`);
  }

  const projection = getProjection(claimed.projection);
  if (projection.version !== claimed.projectionVersion) {
    // The reducer changed underneath a half-built run; its rows would mix two
    // reducer versions. Fail it so the operator starts a fresh run.
    await ProjectionRun.updateOne(
      { runId },
      { $set: { status: "failed", error: `projection version changed to v${projection.version}; start a new run` } },
    );
    return ProjectionRun.findOne({ runId }).lean();
  }

  // Dry runs keep rows in memory, so they cannot resume mid-way: restart.
  const dryRun = claimed.mode === "dry_run";
  let cursor: JournalCursor = dryRun ? { ledger: 0, eventId: "" } : { ...claimed.checkpoint };
  const counts = { applied: 0, ignored: 0, unsupported: 0, malformed: 0, ...(dryRun ? {} : claimed.counts) };
  const samples: unknown[] = dryRun ? [] : [...(claimed.unsupportedSamples ?? [])];
  const malformedSamples: unknown[] = dryRun ? [] : [...(claimed.malformedSamples ?? [])];
  const memory = new Map<string, StoredRow | null>();

  try {
    // The checkpoint names the last event already applied. If that event has
    // left the journal, resuming would skip or re-apply history silently, so
    // refuse and let an operator start a fresh run instead.
    if (!dryRun && cursor.eventId) {
      const checkpointPresent = await EventJournal.exists({ eventId: cursor.eventId, ledger: cursor.ledger });
      if (!checkpointPresent) {
        throw new ReplayError(
          "checkpoint_event_missing",
          `checkpoint_event_missing: event ${cursor.eventId} at ledger ${cursor.ledger} is no longer in the journal; start a new run`,
        );
      }
    }

    for (;;) {
      const page = await readJournalPage(cursor, batchSize);
      if (page.length === 0) break;

      const dirty = new Map<string, StoredRow | null>();
      const pageCounts = { applied: 0, ignored: 0, unsupported: 0, malformed: 0 };
      const pageSamples: unknown[] = [];
      const pageMalformed: unknown[] = [];
      let pageCursor = cursor;
      let stop: string | null = null;

      for (const raw of page) {
        const parsed = parseReplayEvent(raw);
        if (!parsed.ok) {
          // Lenient mode may skip a malformed row, but only one whose identity
          // lets the checkpoint move past it; every other malformed row stops.
          if (!parsed.checkpointable || claimed.strict) {
            stop = `malformed_event: ${parsed.reason} (eventId ${JSON.stringify(raw?.eventId ?? null)}, ledger ${JSON.stringify(raw?.ledger ?? null)})`;
            break;
          }
          pageCounts.malformed += 1;
          if (malformedSamples.length + pageMalformed.length < MAX_MALFORMED_SAMPLES) {
            pageMalformed.push({ eventId: raw.eventId, ledger: raw.ledger, reason: parsed.reason });
          }
          pageCursor = { ledger: raw.ledger, eventId: raw.eventId };
          continue;
        }

        const event = parsed.event;
        const disposition = classifyEvent(projection, event);

        if (disposition === "unsupported") {
          if (claimed.strict) {
            stop = `unsupported_version: ${event.eventType} v${event.eventVersion} at ledger ${event.ledger} (${event.eventId}); projection ${projection.name}@v${projection.version} supports ${projection.supportedEvents[event.eventType].join(", ")}`;
            break;
          }
          pageCounts.unsupported += 1;
          if (samples.length + pageSamples.length < MAX_UNSUPPORTED_SAMPLES) {
            pageSamples.push({ eventId: event.eventId, ledger: event.ledger, eventType: event.eventType, eventVersion: event.eventVersion });
          }
        } else if (disposition === "ignored") {
          pageCounts.ignored += 1;
        } else {
          // A reducer bug or an unexpected payload stops the run at this event
          // (never half-applied); the checkpoint stays before it.
          let key: string | null;
          try {
            key = projection.keyOf(event);
          } catch (err) {
            stop = applyFailure(event, err);
            break;
          }
          if (key !== null) {
            let row = dirty.has(key) ? dirty.get(key)! : memory.get(key);
            if (row === undefined && !dryRun) {
              const stored: any = await ProjectionDocument.findOne({ runId, key }).lean();
              row = stored ? (stored.doc as StoredRow) : null;
            }
            row = row ?? null;
            // A row already past this event was written before a crash; the
            // page is being re-processed and the event must not apply twice.
            if (isAfter(event, row)) {
              let next: Record<string, unknown> | null;
              try {
                next = projection.apply(row ? (row.data as any) : null, event);
              } catch (err) {
                stop = applyFailure(event, err);
                break;
              }
              dirty.set(key, next === null ? null : { data: next, lastLedger: event.ledger, lastEventId: event.eventId });
            }
          }
          pageCounts.applied += 1;
        }
        pageCursor = { ledger: event.ledger, eventId: event.eventId };
      }

      // Persist rows first, then the checkpoint that covers them.
      if (dryRun) {
        for (const [key, row] of dirty) memory.set(key, row);
      } else if (dirty.size > 0) {
        await ProjectionDocument.bulkWrite(
          [...dirty].map(([key, row]) =>
            row === null
              ? { deleteOne: { filter: { runId, key } } }
              : {
                  updateOne: {
                    filter: { runId, key },
                    update: { $set: { runId, projection: projection.name, key, doc: row } },
                    upsert: true,
                  },
                },
          ),
        );
      }

      counts.applied += pageCounts.applied;
      counts.ignored += pageCounts.ignored;
      counts.unsupported += pageCounts.unsupported;
      counts.malformed += pageCounts.malformed;
      samples.push(...pageSamples);
      malformedSamples.push(...pageMalformed);
      cursor = pageCursor;

      await ProjectionRun.updateOne(
        { runId },
        {
          $set: {
            checkpoint: cursor,
            counts,
            unsupportedSamples: samples,
            malformedSamples,
            leaseExpiresAt: new Date(now().getTime() + LEASE_MS),
          },
        },
      );

      if (stop) {
        await ProjectionRun.updateOne({ runId }, { $set: { status: "failed", error: stop, leaseExpiresAt: null } });
        logger.warn("projection replay stopped on unsupported event version", { action: "projection_replay", runId, error: stop });
        return ProjectionRun.findOne({ runId }).lean();
      }
    }

    const documents = dryRun
      ? [...memory.values()].filter((row) => row !== null).length
      : await ProjectionDocument.countDocuments({ runId });
    await ProjectionRun.updateOne(
      { runId },
      {
        $set: {
          status: "completed",
          completedAt: now(),
          leaseExpiresAt: null,
          documents,
          ...(dryRun ? { checkpoint: cursor, counts, unsupportedSamples: samples, malformedSamples } : {}),
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ProjectionRun.updateOne({ runId }, { $set: { status: "failed", error: message, leaseExpiresAt: null } });
    logger.error("projection replay failed; resume to continue from the last checkpoint", {
      action: "projection_replay",
      runId,
      err: message,
    });
  }

  return ProjectionRun.findOne({ runId }).lean();
}

/** Make a completed build run the served copy of its projection. */
export async function activateRun(runId: string, actor: string) {
  const run: any = await ProjectionRun.findOne({ runId }).lean();
  if (!run) throw new ReplayError("run_not_found", `No replay run ${runId}`);
  if (run.status !== "completed" || run.mode !== "build") {
    throw new ReplayError("run_not_activatable", "Only a completed build run can be activated.");
  }
  if (run.counts?.unsupported > 0) {
    throw new ReplayError(
      "run_not_activatable",
      `Run skipped ${run.counts.unsupported} unsupported event(s); upgrade the projection and rebuild before activating.`,
    );
  }
  if (run.counts?.malformed > 0) {
    throw new ReplayError(
      "run_not_activatable",
      `Run skipped ${run.counts.malformed} malformed event(s); repair the journal and rebuild before activating.`,
    );
  }

  const current: any = await ProjectionPointer.findOne({ projection: run.projection }).lean();
  if (current?.activeRunId === runId) return current;

  const pointer = await ProjectionPointer.findOneAndUpdate(
    { projection: run.projection },
    {
      $set: {
        activeRunId: runId,
        activeVersion: run.projectionVersion,
        previousRunId: current?.activeRunId ?? null,
        previousVersion: current?.activeVersion ?? null,
        activatedBy: actor,
        activatedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  ).lean();

  await recordAuditEvent({
    action: "admin_projection_activate",
    result: "success",
    actor,
    target: run.projection,
    targetType: "projection",
    beforeState: { activeRunId: current?.activeRunId ?? null, activeVersion: current?.activeVersion ?? null },
    afterState: { activeRunId: runId, activeVersion: run.projectionVersion },
  });
  return pointer;
}

/** Swap back to the previously active run. */
export async function rollbackProjection(name: string, actor: string) {
  getProjection(name);
  const current: any = await ProjectionPointer.findOne({ projection: name }).lean();
  if (!current?.previousRunId) {
    throw new ReplayError("nothing_to_roll_back", `Projection ${name} has no previous run to roll back to.`);
  }
  const pointer = await ProjectionPointer.findOneAndUpdate(
    { projection: name, activeRunId: current.activeRunId },
    {
      $set: {
        activeRunId: current.previousRunId,
        activeVersion: current.previousVersion,
        previousRunId: current.activeRunId,
        previousVersion: current.activeVersion,
        activatedBy: actor,
        activatedAt: new Date(),
      },
    },
    { new: true },
  ).lean();

  await recordAuditEvent({
    action: "admin_projection_rollback",
    result: "success",
    actor,
    target: name,
    targetType: "projection",
    beforeState: { activeRunId: current.activeRunId, activeVersion: current.activeVersion },
    afterState: { activeRunId: current.previousRunId, activeVersion: current.previousVersion },
  });
  return pointer;
}

/** Read one row from the active copy of a projection (null if none active). */
export async function readActiveProjectionRow(name: string, key: string): Promise<unknown | null> {
  const pointer: any = await ProjectionPointer.findOne({ projection: name }).lean();
  if (!pointer?.activeRunId) return null;
  const row: any = await ProjectionDocument.findOne({ runId: pointer.activeRunId, key }).lean();
  return row ? (row.doc as StoredRow).data : null;
}

export async function getRun(runId: string) {
  const run = await ProjectionRun.findOne({ runId }).lean();
  if (!run) throw new ReplayError("run_not_found", `No replay run ${runId}`);
  return run;
}

/**
 * Remove rows of runs that are neither active nor the rollback target.
 * Returns the number of rows deleted.
 */
export async function pruneInactiveRuns(name: string): Promise<number> {
  const pointer: any = await ProjectionPointer.findOne({ projection: name }).lean();
  const keep = [pointer?.activeRunId, pointer?.previousRunId].filter(Boolean);
  const running = await ProjectionRun.find({ projection: name, status: { $in: ["pending", "running"] } })
    .select("runId")
    .lean();
  keep.push(...running.map((r: any) => r.runId));
  const result = await ProjectionDocument.deleteMany({ projection: name, runId: { $nin: keep } });
  return result.deletedCount ?? 0;
}
