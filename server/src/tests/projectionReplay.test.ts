import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Versioned event replay for rebuilding projections (#1024).
 *
 * Runs the real journal, replay engine and admin routes against an in-memory
 * mongod. `requireAdminScope` is a header-driven stub (HMAC tokens are
 * covered by adminAuth.test.ts).
 */

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const [sub, scopes = ""] = String(req.headers["x-test-admin"] ?? "").split("|");
    if (!scopes.split(",").includes(scope)) {
      res.status(401).json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    req.admin = { sub };
    next();
  },
}));

import { AuditLog } from "../models/AuditLog";
import { EventJournal } from "../models/EventJournal";
import { ProjectionDocument, ProjectionRun } from "../models/ProjectionRun";
import { appendToJournal, normalizePayload, type JournalEntry } from "../services/eventJournal";
import {
  activateRun,
  classifyEvent,
  parseReplayEvent,
  promptListingProjection,
  readActiveProjectionRow,
  rollbackProjection,
  runReplay,
  startReplay,
} from "../services/projectionReplay";
import { projectionReplayRouter } from "../routes/projectionReplayRoutes";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";
import { resetRealMongo, setupRealMongo, teardownRealMongo } from "./helpers/realMongo";

let dbReady = false;
let http: HttpTestServer;

beforeAll(async () => {
  dbReady = await setupRealMongo();
  if (dbReady) {
    await Promise.all([EventJournal.init(), ProjectionDocument.init(), ProjectionRun.init()]);
  }
  http = await startHttpServer((app) => app.use("/api/admin/projections", projectionReplayRouter));
});
afterAll(async () => {
  await http?.close();
  await teardownRealMongo();
});
beforeEach(async () => {
  if (dbReady) await resetRealMongo();
});
afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;
function ev(ledger: number, eventType: string, payload: Record<string, unknown>, eventVersion = 1): JournalEntry {
  seq += 1;
  return {
    eventId: `${String(ledger).padStart(12, "0")}-${String(seq).padStart(10, "0")}`,
    ledger,
    eventType,
    eventVersion,
    payload,
  };
}

async function seedHistory() {
  const events = [
    ev(10, "PromptCreated", { prompt_id: 1n, creator: "GCREATOR1", price_stroops: 10_000_000n, asset: "CNATIVE" }),
    ev(11, "PromptCreated", { prompt_id: 2n, creator: "GCREATOR2", price_stroops: 5_000_000n, asset: "CNATIVE" }),
    ev(12, "PromptPurchased", { prompt_id: 1n, buyer: "GBUYER1", creator: "GCREATOR1", price_stroops: 10_000_000n }),
    ev(13, "PromptPriceUpdated", { prompt_id: 1n, price_stroops: 12_000_000n }),
    ev(14, "PromptTipped", { prompt_id: 1n, amount: 1n }), // not used by this projection
    ev(15, "PromptPurchased", { prompt_id: 1n, buyer: "GBUYER2", creator: "GCREATOR1", price_stroops: 12_000_000n }, 2),
    ev(16, "PromptSaleStatusUpdated", { prompt_id: 2n, active: false }),
  ];
  for (const event of events) await appendToJournal(event);
  return events;
}

const EXPECTED_PROMPT_1 = {
  promptId: "1",
  creator: "GCREATOR1",
  asset: "CNATIVE",
  priceStroops: "12000000",
  active: true,
  salesCount: 2,
  revenueStroops: "22000000",
  incomplete: false,
};

describe("event journal", () => {
  it("normalizes bigints and bytes into JSON-safe values", () => {
    expect(normalizePayload({ a: 1n, b: new Uint8Array([0xde, 0xad]), c: [2n], d: undefined })).toEqual({
      a: "1",
      b: "dead",
      c: ["2"],
    });
  });

  it("appends idempotently and refuses edits", async () => {
    if (!dbReady) return;
    const entry = ev(1, "PromptCreated", { prompt_id: 9n });
    expect(await appendToJournal(entry)).toBe(true);
    expect(await appendToJournal({ ...entry, payload: { prompt_id: 99n } })).toBe(false);
    const stored: any = await EventJournal.findOne({ eventId: entry.eventId }).lean();
    expect(stored.payload.prompt_id).toBe("9");
    await expect(EventJournal.updateOne({ eventId: entry.eventId }, { $set: { ledger: 2 } })).rejects.toThrow(/immutable/);
  });
});

describe("classifyEvent", () => {
  it("separates applied, ignored and unsupported-version events", () => {
    const base = { eventId: "x", ledger: 1, payload: {} };
    expect(classifyEvent(promptListingProjection, { ...base, eventType: "PromptCreated", eventVersion: 2 })).toBe("applied");
    expect(classifyEvent(promptListingProjection, { ...base, eventType: "PromptTipped", eventVersion: 1 })).toBe("ignored");
    expect(classifyEvent(promptListingProjection, { ...base, eventType: "PromptCreated", eventVersion: 3 })).toBe("unsupported");
  });
});

describe("parseReplayEvent", () => {
  const valid = { eventId: "000000000001-0000000001", ledger: 1, eventType: "PromptCreated", eventVersion: 1, payload: {} };

  it("accepts a well-formed row", () => {
    expect(parseReplayEvent(valid)).toEqual({ ok: true, event: valid });
  });

  it("rejects a row without a usable identity and marks it uncheckpointable", () => {
    expect(parseReplayEvent({ ...valid, eventId: "" })).toMatchObject({ ok: false, checkpointable: false });
    expect(parseReplayEvent({ ...valid, ledger: -1 })).toMatchObject({ ok: false, checkpointable: false });
    expect(parseReplayEvent(null)).toMatchObject({ ok: false, checkpointable: false });
  });

  it("rejects bad type, version or payload but keeps the identity checkpointable", () => {
    expect(parseReplayEvent({ ...valid, eventType: "" })).toMatchObject({ ok: false, checkpointable: true });
    expect(parseReplayEvent({ ...valid, eventVersion: 0 })).toMatchObject({
      ok: false,
      reason: "eventVersion must be a positive integer",
      checkpointable: true,
    });
    expect(parseReplayEvent({ ...valid, payload: [] })).toMatchObject({ ok: false, checkpointable: true });
  });
});

describe("replay engine", () => {
  it("normal path: rebuilds the projection across pages and activates it", async () => {
    if (!dbReady) return;
    await seedHistory();

    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    const done: any = await runReplay(run.runId, { batchSize: 2 });

    expect(done.status).toBe("completed");
    expect(done.counts).toEqual({ applied: 6, ignored: 1, unsupported: 0, malformed: 0 });
    expect(done.documents).toBe(2);

    // Nothing is served until activation.
    expect(await readActiveProjectionRow("prompt_listing", "1")).toBeNull();
    await activateRun(run.runId, "ops-alice");
    expect(await readActiveProjectionRow("prompt_listing", "1")).toEqual(EXPECTED_PROMPT_1);
    expect(await readActiveProjectionRow("prompt_listing", "2")).toMatchObject({ active: false, salesCount: 0 });

    const audit = await AuditLog.find({ action: { $in: ["admin_projection_replay", "admin_projection_activate"] } }).lean();
    expect(audit.map((a: any) => a.action).sort()).toEqual(["admin_projection_activate", "admin_projection_replay"]);
  });

  it("dry run computes counts without writing projection rows", async () => {
    if (!dbReady) return;
    await seedHistory();
    const run = await startReplay({ projection: "prompt_listing", mode: "dry_run", startedBy: "ops-alice" });
    const done: any = await runReplay(run.runId, { batchSize: 3 });
    expect(done).toMatchObject({ status: "completed", documents: 2 });
    expect(await ProjectionDocument.countDocuments()).toBe(0);
    await expect(activateRun(run.runId, "ops-alice")).rejects.toMatchObject({ code: "run_not_activatable" });
  });

  it("failure + retry path: a crash mid-run resumes from the checkpoint without double counting", async () => {
    if (!dbReady) return;
    await seedHistory();
    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });

    // Fail the checkpoint write after the second page's rows were persisted:
    // the worst case, where rows are ahead of the checkpoint.
    const realUpdateOne = ProjectionRun.updateOne.bind(ProjectionRun);
    let checkpoints = 0;
    vi.spyOn(ProjectionRun, "updateOne").mockImplementation(((filter: any, update: any) => {
      if (update?.$set?.checkpoint && !update.$set.status && ++checkpoints === 2) {
        return Promise.reject(new Error("primary stepped down"));
      }
      return realUpdateOne(filter, update);
    }) as any);

    const failed: any = await runReplay(run.runId, { batchSize: 2 });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/primary stepped down/);
    expect(failed.checkpoint.ledger).toBe(11);

    vi.restoreAllMocks();
    const resumed: any = await runReplay(run.runId, { batchSize: 2 });
    expect(resumed.status).toBe("completed");
    expect(resumed.attempts).toBe(2);
    expect(resumed.counts).toEqual({ applied: 6, ignored: 1, unsupported: 0, malformed: 0 });

    await activateRun(run.runId, "ops-alice");
    // The re-processed purchase at ledger 12 was not applied twice.
    expect(await readActiveProjectionRow("prompt_listing", "1")).toEqual(EXPECTED_PROMPT_1);
  });

  it("a running run with a live lease cannot be claimed twice; completed runs cannot restart", async () => {
    if (!dbReady) return;
    await seedHistory();
    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    await ProjectionRun.updateOne(
      { runId: run.runId },
      { $set: { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) } },
    );
    await expect(runReplay(run.runId)).rejects.toMatchObject({ code: "run_not_claimable" });

    // An abandoned run (lease expired) is taken over.
    await ProjectionRun.updateOne({ runId: run.runId }, { $set: { leaseExpiresAt: new Date(Date.now() - 1) } });
    expect(((await runReplay(run.runId)) as any).status).toBe("completed");
    await expect(runReplay(run.runId)).rejects.toMatchObject({ code: "run_not_claimable" });
  });

  it("strict mode stops before an unsupported event version and resumes after an upgrade", async () => {
    if (!dbReady) return;
    await seedHistory();
    await appendToJournal(ev(20, "PromptPriceUpdated", { prompt_id: 2n, price_stroops: 1n }, 3));
    await appendToJournal(ev(21, "PromptPurchased", { prompt_id: 2n, price_stroops: 1n }));

    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    const stopped: any = await runReplay(run.runId);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/unsupported_version: PromptPriceUpdated v3 at ledger 20/);
    expect(stopped.checkpoint.ledger).toBe(16);
    await expect(activateRun(run.runId, "ops-alice")).rejects.toMatchObject({ code: "run_not_activatable" });

    // Consumer upgrade: the reducer learns v3 without changing its output.
    promptListingProjection.supportedEvents.PromptPriceUpdated = [1, 2, 3];
    try {
      const resumed: any = await runReplay(run.runId);
      expect(resumed.status).toBe("completed");
      expect(resumed.counts.applied).toBe(8);
    } finally {
      promptListingProjection.supportedEvents.PromptPriceUpdated = [1, 2];
    }
  });

  it("lenient mode skips unsupported versions, samples them, and blocks activation", async () => {
    if (!dbReady) return;
    await seedHistory();
    await appendToJournal(ev(20, "PromptPriceUpdated", { prompt_id: 2n, price_stroops: 1n }, 3));

    const run = await startReplay({ projection: "prompt_listing", mode: "build", strict: false, startedBy: "ops-alice" });
    const done: any = await runReplay(run.runId);
    expect(done.status).toBe("completed");
    expect(done.counts.unsupported).toBe(1);
    expect(done.unsupportedSamples[0]).toMatchObject({ eventType: "PromptPriceUpdated", eventVersion: 3, ledger: 20 });
    await expect(activateRun(run.runId, "ops-alice")).rejects.toMatchObject({ code: "run_not_activatable" });
  });

  it("a malformed row stops a strict run, names the event, and keeps the checkpoint before it", async () => {
    if (!dbReady) return;
    await seedHistory();
    const bad = ev(20, "PromptPurchased", { prompt_id: 1n }, 0);
    await appendToJournal(bad);

    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    const stopped: any = await runReplay(run.runId);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("malformed_event: eventVersion must be a positive integer");
    expect(stopped.error).toContain(bad.eventId);
    expect(stopped.checkpoint.ledger).toBe(16);
    await expect(activateRun(run.runId, "ops-alice")).rejects.toMatchObject({ code: "run_not_activatable" });
  });

  it("lenient mode skips a malformed row, samples it, and blocks activation", async () => {
    if (!dbReady) return;
    await seedHistory();
    const bad = ev(20, "PromptPurchased", { prompt_id: 1n }, 0);
    await appendToJournal(bad);

    const run = await startReplay({ projection: "prompt_listing", mode: "build", strict: false, startedBy: "ops-alice" });
    const done: any = await runReplay(run.runId);
    expect(done.status).toBe("completed");
    expect(done.counts.malformed).toBe(1);
    expect(done.malformedSamples).toEqual([
      { eventId: bad.eventId, ledger: 20, reason: "eventVersion must be a positive integer" },
    ]);
    await expect(activateRun(run.runId, "ops-alice")).rejects.toMatchObject({ code: "run_not_activatable" });
  });

  it("refuses to resume from a checkpoint event that has left the journal", async () => {
    if (!dbReady) return;
    await seedHistory();
    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    await ProjectionRun.updateOne(
      { runId: run.runId },
      { $set: { status: "failed", checkpoint: { ledger: 12, eventId: "000000000012-missing" } } },
    );

    const failed: any = await runReplay(run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^checkpoint_event_missing: event 000000000012-missing at ledger 12/);
    expect(await ProjectionDocument.countDocuments({ runId: run.runId })).toBe(0);
  });

  it("a reducer that throws stops the run at that event, with the event named and the checkpoint before it", async () => {
    if (!dbReady) return;
    await seedHistory();
    const realApply = promptListingProjection.apply;
    vi.spyOn(promptListingProjection, "apply").mockImplementation((current: any, event: any) => {
      if (event.ledger === 12) throw new Error("unexpected purchase shape");
      return realApply(current, event);
    });

    const run = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    const failed: any = await runReplay(run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^apply_failed: PromptPurchased v1 at ledger 12 \(.+\): unexpected purchase shape$/);
    expect(failed.checkpoint.ledger).toBe(11);
  });

  it("rolls activation back to the previous run", async () => {
    if (!dbReady) return;
    await seedHistory();
    const first = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    await runReplay(first.runId);
    await activateRun(first.runId, "ops-alice");

    await appendToJournal(ev(30, "PromptPurchased", { prompt_id: 1n, price_stroops: 12_000_000n }));
    const second = await startReplay({ projection: "prompt_listing", mode: "build", startedBy: "ops-alice" });
    await runReplay(second.runId);
    await activateRun(second.runId, "ops-alice");
    expect(await readActiveProjectionRow("prompt_listing", "1")).toMatchObject({ salesCount: 3 });

    const pointer: any = await rollbackProjection("prompt_listing", "ops-bob");
    expect(pointer.activeRunId).toBe(first.runId);
    expect(await readActiveProjectionRow("prompt_listing", "1")).toMatchObject({ salesCount: 2 });
    expect(await AuditLog.countDocuments({ action: "admin_projection_rollback", actor: "ops-bob" })).toBe(1);
  });
});

describe("admin routes", () => {
  const WRITER = { "x-test-admin": "ops-alice|projections:read,projections:write" };
  const READER = { "x-test-admin": "viewer|projections:read" };

  async function waitForRun(runId: string) {
    for (let i = 0; i < 50; i++) {
      const res = await jsonCall(http.baseUrl, `/api/admin/projections/runs/${runId}`, { headers: READER });
      if (res.body.status === "completed" || res.body.status === "failed") return res.body;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("run did not finish");
  }

  it("authorization path: reads need projections:read, mutations need projections:write", async () => {
    if (!dbReady) return;
    expect((await jsonCall(http.baseUrl, "/api/admin/projections")).status).toBe(401);
    expect((await jsonCall(http.baseUrl, "/api/admin/projections", { headers: READER })).status).toBe(200);

    const denied = await jsonCall(http.baseUrl, "/api/admin/projections/prompt_listing/replays", {
      method: "POST",
      headers: READER,
      body: JSON.stringify({ mode: "build" }),
    });
    expect(denied.status).toBe(401);
    expect(await ProjectionRun.countDocuments()).toBe(0);
  });

  it("starts, polls, activates and rolls back through the API", async () => {
    if (!dbReady) return;
    await seedHistory();

    const started = await jsonCall(http.baseUrl, "/api/admin/projections/prompt_listing/replays", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({ mode: "build", batchSize: 2 }),
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ projection: "prompt_listing", projectionVersion: 1, startedBy: "ops-alice" });

    const finished = await waitForRun(started.body.runId);
    expect(finished.status).toBe("completed");

    const activated = await jsonCall(http.baseUrl, `/api/admin/projections/runs/${started.body.runId}/activate`, {
      method: "POST",
      headers: WRITER,
    });
    expect(activated.status).toBe(200);
    expect(activated.body.activeRunId).toBe(started.body.runId);

    const listing = await jsonCall(http.baseUrl, "/api/admin/projections", { headers: READER });
    expect(listing.body.projections[0].pointer.activeRunId).toBe(started.body.runId);

    // Only one activation exists: nothing to roll back to yet.
    const rollback = await jsonCall(http.baseUrl, "/api/admin/projections/prompt_listing/rollback", {
      method: "POST",
      headers: WRITER,
    });
    expect(rollback.status).toBe(409);

    const resumeCompleted = await jsonCall(
      http.baseUrl,
      `/api/admin/projections/runs/${started.body.runId}/resume`,
      { method: "POST", headers: WRITER },
    );
    expect(resumeCompleted.status).toBe(409);
  });

  it("validates input and unknown resources", async () => {
    if (!dbReady) return;
    const badMode = await jsonCall(http.baseUrl, "/api/admin/projections/prompt_listing/replays", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(badMode.status).toBe(400);

    const unknown = await jsonCall(http.baseUrl, "/api/admin/projections/nope/replays", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({}),
    });
    expect(unknown.status).toBe(404);

    const missing = await jsonCall(http.baseUrl, "/api/admin/projections/runs/does-not-exist", { headers: READER });
    expect(missing.status).toBe(404);
  });
});
