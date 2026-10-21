import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic duplicate-record merge (#902).
 *
 * The merge model is mocked. The tests cover the pure plan, resolution and
 * redirect rules, plus the execute path's stale-plan refusal, pending-before-write
 * ordering, and failure recording.
 */

vi.mock("../models/RecordMerge", () => ({
  default: {
    create: vi.fn(),
    updateOne: vi.fn(),
    findOne: vi.fn(),
  },
}));

import RecordMerge from "../models/RecordMerge";
import {
  RecordMergeError,
  buildRollbackNotes,
  executeRecordMerge,
  planRecordMerge,
  resolveMergeConflicts,
  resolveMergedRecordId,
  type MergeableRecord,
  type RecordMergeAdapter,
} from "../services/recordMerge";

function record(overrides: Partial<MergeableRecord> = {}): MergeableRecord {
  return {
    id: "prompt-src",
    ownerId: "owner-1",
    isActive: true,
    mergedInto: null,
    onChainId: null,
    activeLicenseCount: 0,
    fields: { title: "Prompt A", description: "", tags: ["ai"], price: 5 },
    ...overrides,
  };
}

const target = () =>
  record({
    id: "prompt-tgt",
    fields: { title: "Prompt A", description: "Full guide", tags: ["ai", "writing"], price: 5 },
  });

/** Target with an empty description, so a source that has one merges without conflict. */
const emptyDescriptionTarget = () =>
  record({
    id: "prompt-tgt",
    fields: { title: "Prompt A", description: "", tags: ["ai", "writing"], price: 5 },
  });

function adapterWith(
  records: Record<string, MergeableRecord>,
  applyMerge = vi.fn().mockResolvedValue(undefined),
): RecordMergeAdapter {
  return {
    loadRecord: vi.fn(async (id: string) => records[id] ?? null),
    applyMerge,
  };
}

/** Returns the RecordMergeError code thrown by `fn`, or undefined if it did not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as RecordMergeError).code;
  }
  return undefined;
}

describe("planRecordMerge", () => {
  it("plans a clean merge that fills empty fields without conflicts", () => {
    const source = record({
      fields: { title: "Prompt A", description: "Short summary", tags: [], price: 5 },
    });
    const emptyDescription = record({
      id: "prompt-tgt",
      fields: { title: "Prompt A", description: "", tags: ["ai", "writing"], price: 5 },
    });
    const plan = planRecordMerge(source, emptyDescription);

    expect(plan.eligible).toBe(true);
    expect(plan.denials).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([
      { field: "description", from: "", to: "Short summary", origin: "source" },
    ]);
    expect(plan.mergedFields).toMatchObject({
      title: "Prompt A",
      description: "Short summary",
      tags: ["ai", "writing"],
      price: 5,
    });
  });

  it("lists conflicts when both records hold different content", () => {
    const source = record({
      fields: { title: "Prompt B", description: "Full guide", tags: ["ai"], price: "5" as unknown as number },
    });
    const plan = planRecordMerge(source, target());

    expect(plan.eligible).toBe(true);
    expect(plan.conflicts).toEqual([
      { field: "title", category: "value_conflict", sourceValue: "Prompt B", targetValue: "Prompt A" },
      { field: "tags", category: "value_conflict", sourceValue: ["ai"], targetValue: ["ai", "writing"] },
      { field: "price", category: "type_mismatch", sourceValue: "5", targetValue: 5 },
    ]);
  });

  it("denies merges across owners, into itself, or into an inactive target", () => {
    const sameId = planRecordMerge(record(), record());
    expect(sameId.denials.map((d) => d.code)).toContain("same_record");

    const owners = planRecordMerge(record({ ownerId: "owner-2" }), target());
    expect(owners.eligible).toBe(false);
    expect(owners.denials.map((d) => d.code)).toEqual(["owner_mismatch"]);
    expect(owners.mergedFields).toBeNull();

    const inactive = planRecordMerge(record(), { ...target(), isActive: false });
    expect(inactive.denials.map((d) => d.code)).toEqual(["target_inactive"]);
  });

  it("denies a source that has licences, an on-chain listing, or was already merged", () => {
    const licensed = planRecordMerge(record({ activeLicenseCount: 2 }), target());
    expect(licensed.denials.map((d) => d.code)).toEqual(["source_has_licenses"]);

    const onChain = planRecordMerge(record({ onChainId: "CABC" }), target());
    expect(onChain.denials.map((d) => d.code)).toEqual(["source_on_chain"]);

    const alreadyMerged = planRecordMerge(record({ mergedInto: "prompt-x" }), target());
    expect(alreadyMerged.denials.map((d) => d.code)).toEqual(["source_merged"]);
  });

  it("produces the same plan hash for the same inputs, whatever the key order", () => {
    const a = planRecordMerge(record(), target());
    const reordered = record({
      fields: { price: 5, tags: ["ai"], description: "", title: "Prompt A" },
    });
    const b = planRecordMerge(reordered, target());
    expect(a.planHash).toBe(b.planHash);
  });

  it("changes the plan hash when either record changes", () => {
    const before = planRecordMerge(record(), target());
    const after = planRecordMerge(record({ fields: { ...record().fields, title: "Changed" } }), target());
    expect(after.planHash).not.toBe(before.planHash);
  });
});

describe("resolveMergeConflicts", () => {
  const conflicting = () =>
    planRecordMerge(
      record({ fields: { title: "Prompt B", description: "", tags: ["ai"], price: 5 } }),
      target(),
    );

  it("refuses to merge while any conflict is unresolved", () => {
    expect(codeOf(() => resolveMergeConflicts(conflicting(), {}))).toBe("conflict_unresolved");
    expect(codeOf(() => resolveMergeConflicts(conflicting(), { title: "keep_source" }))).toBe(
      "conflict_unresolved",
    );
  });

  it("applies explicit choices to each conflicting field", () => {
    const merged = resolveMergeConflicts(conflicting(), {
      title: "keep_source",
      tags: "keep_target",
    });
    expect(merged.title).toBe("Prompt B");
    expect(merged.tags).toEqual(["ai", "writing"]);
  });

  it("rejects resolutions for fields that do not conflict, and invalid choices", () => {
    expect(
      codeOf(() =>
        resolveMergeConflicts(conflicting(), {
          title: "keep_source",
          tags: "keep_target",
          description: "keep_source",
        }),
      ),
    ).toBe("unknown_resolution");
    expect(
      codeOf(() => resolveMergeConflicts(conflicting(), { title: "keep_both", tags: "keep_target" })),
    ).toBe("invalid_resolution");
  });

  it("will not resolve a denied merge", () => {
    const denied = planRecordMerge(record({ activeLicenseCount: 1 }), target());
    expect(codeOf(() => resolveMergeConflicts(denied, {}))).toBe("denied");
  });
});

describe("rollback notes", () => {
  it("names both records and carries the pre-merge values needed to revert", () => {
    const notes = buildRollbackNotes({
      mergeId: "mrg_test",
      sourceId: "prompt-src",
      targetId: "prompt-tgt",
      snapshot: {
        source: { isActive: true, fields: { title: "Prompt B" } },
        target: { isActive: true, fields: { title: "Prompt A" } },
      },
    });
    expect(notes).toContain("mrg_test");
    expect(notes).toContain("prompt-src isActive to true");
    expect(notes).toContain("Prompt B");
    expect(notes).toContain("Prompt A");
  });
});

describe("resolveMergedRecordId", () => {
  it("returns the record itself when it was never merged", async () => {
    const result = await resolveMergedRecordId("x", async () => null);
    expect(result).toEqual({ id: "x", hops: [] });
  });

  it("follows a chain of merges to the record that holds the content", async () => {
    const redirects: Record<string, string> = { a: "b", b: "c" };
    const result = await resolveMergedRecordId("a", async (id) => redirects[id] ?? null);
    expect(result).toEqual({ id: "c", hops: ["b", "c"] });
  });

  it("stops on a redirect loop", async () => {
    const redirects: Record<string, string> = { a: "b", b: "a" };
    await expect(resolveMergedRecordId("a", async (id) => redirects[id] ?? null)).rejects.toMatchObject({
      code: "merge_cycle",
    });
  });

  it("stops when the chain exceeds the hop limit", async () => {
    const redirects: Record<string, string> = { a: "b", b: "c", c: "d" };
    await expect(
      resolveMergedRecordId("a", async (id) => redirects[id] ?? null, 2),
    ).rejects.toMatchObject({ code: "merge_cycle" });
  });
});

describe("executeRecordMerge", () => {
  beforeEach(() => {
    vi.mocked(RecordMerge.create).mockReset();
    vi.mocked(RecordMerge.updateOne).mockReset();
  });

  it("refuses a stale preview and writes nothing", async () => {
    const source = record();
    const adapter = adapterWith({ "prompt-src": source, "prompt-tgt": emptyDescriptionTarget() });

    await expect(
      executeRecordMerge(adapter, {
        sourceId: "prompt-src",
        targetId: "prompt-tgt",
        expectedPlanHash: "not-the-current-hash",
        actor: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "stale_plan" });

    expect(RecordMerge.create).not.toHaveBeenCalled();
    expect(adapter.applyMerge).not.toHaveBeenCalled();
  });

  it("records a pending merge before writing, then marks it committed", async () => {
    const source = record({
      fields: { title: "Prompt A", description: "Short summary", tags: [], price: 5 },
    });
    const adapter = adapterWith({ "prompt-src": source, "prompt-tgt": emptyDescriptionTarget() });
    const expectedPlanHash = planRecordMerge(source, emptyDescriptionTarget()).planHash;

    const result = await executeRecordMerge(adapter, {
      sourceId: "prompt-src",
      targetId: "prompt-tgt",
      expectedPlanHash,
      actor: "admin-1",
    });

    expect(result.status).toBe("committed");
    expect(RecordMerge.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", sourceId: "prompt-src", targetId: "prompt-tgt" }),
    );
    expect(vi.mocked(RecordMerge.create).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.applyMerge).mock.invocationCallOrder[0],
    );
    expect(RecordMerge.updateOne).toHaveBeenCalledWith(
      { mergeId: result.mergeId },
      { $set: expect.objectContaining({ status: "committed" }) },
    );
  });

  it("marks the merge failed and rethrows when the write does not complete", async () => {
    const source = record({
      fields: { title: "Prompt A", description: "Short summary", tags: [], price: 5 },
    });
    const applyMerge = vi.fn().mockRejectedValue(new Error("write timeout"));
    const adapter = adapterWith({ "prompt-src": source, "prompt-tgt": emptyDescriptionTarget() }, applyMerge);
    const expectedPlanHash = planRecordMerge(source, emptyDescriptionTarget()).planHash;

    await expect(
      executeRecordMerge(adapter, {
        sourceId: "prompt-src",
        targetId: "prompt-tgt",
        expectedPlanHash,
        actor: "admin-1",
      }),
    ).rejects.toThrow("write timeout");

    expect(RecordMerge.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({ status: "failed", failureReason: "write timeout" }) },
    );
  });
});
