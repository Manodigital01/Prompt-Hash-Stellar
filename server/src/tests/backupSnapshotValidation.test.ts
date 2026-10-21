import crypto from "crypto";
import zlib from "zlib";
import { describe, expect, it } from "vitest";
import { BACKUP_COLLECTIONS, type BackupManifest } from "../services/backupService";
import { validateBackupSnapshot, type SnapshotInput } from "../services/backupSnapshotValidation";

/**
 * Snapshot read-only validation (#906).
 *
 * Fixtures mirror what runBackup writes: gzipped NDJSON per collection, and a
 * manifest whose checksums and counts describe the ORIGINAL data. A corrupted
 * snapshot is then built by storing different bytes than the manifest records.
 */

type Data = Record<string, Record<string, unknown>[]>;

const CLEAN: Data = {
  prompts: [
    { _id: "p1", onChainId: "1", title: "Alpha" },
    { _id: "p2", onChainId: "2", title: "Beta" },
  ],
  purchases: [{ _id: "b1", promptId: "1" }],
  promptversions: [
    { _id: "v1", promptId: "1", versionIndex: 0 },
    { _id: "v2", promptId: "1", versionIndex: 1 },
  ],
  indexerstates: [{ _id: "i1", lastIndexedLedger: 120, lastFinalizedLedger: 110 }],
  auditlogs: [{ _id: "a1", action: "prompt_created" }],
};

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ndjsonOf(docs: Record<string, unknown>[] = []): Buffer {
  return Buffer.from(docs.length > 0 ? docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n" : "");
}

/** Manifest describes `original`; the stored files hold `stored` (defaults to the same data). */
function buildSnapshot(original: Data, stored: Data = original): SnapshotInput {
  const manifest: BackupManifest = {
    version: "1.0.0",
    timestamp: "2026-10-20T00-00-00-000Z",
    prefix: "backups",
    totalDocuments: 0,
    collections: {},
  };
  const files: Record<string, Buffer> = {};
  for (const name of BACKUP_COLLECTIONS) {
    const docs = original[name] ?? [];
    const ndjson = ndjsonOf(docs);
    const compressed = zlib.gzipSync(ndjson);
    manifest.totalDocuments += docs.length;
    manifest.collections[name] = {
      name,
      key: `backups/2026-10-20T00-00-00-000Z/${name}.ndjson.gz`,
      docCount: docs.length,
      sha256: sha256(ndjson),
      uncompressedBytes: ndjson.length,
      compressedBytes: compressed.length,
    };
    files[name] = zlib.gzipSync(ndjsonOf(stored[name] ?? []));
  }
  return { manifestBytes: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), files };
}

describe("validateBackupSnapshot (#906)", () => {
  it("passes a clean snapshot and reports that it is read-only", () => {
    const report = validateBackupSnapshot(buildSnapshot(CLEAN));

    expect(report.ok).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.collectionsChecked).toBe(BACKUP_COLLECTIONS.length);
    expect(report.recordsScanned).toBe(7);
  });

  it("catches a corrupted record by its checksum", () => {
    const stored = { ...CLEAN, prompts: [{ _id: "p1", onChainId: "1", title: "Alph4" }, CLEAN.prompts[1]] };
    const report = validateBackupSnapshot(buildSnapshot(CLEAN, stored));

    expect(report.ok).toBe(false);
    expect(report.issueCounts.checksum_mismatch).toBe(1);
    expect(report.issues.find((i) => i.kind === "checksum_mismatch")?.collection).toBe("prompts");
  });

  it("catches an archive that cannot be decompressed", () => {
    const input = buildSnapshot(CLEAN);
    input.files.purchases = Buffer.from("definitely not gzip");
    const report = validateBackupSnapshot(input);

    expect(report.issueCounts.corrupt_archive).toBe(1);
    expect(report.issues.find((i) => i.kind === "corrupt_archive")?.collection).toBe("purchases");
  });

  it("reports a missing collection file", () => {
    const input = buildSnapshot(CLEAN);
    delete input.files.auditlogs;
    const report = validateBackupSnapshot(input);

    expect(report.issueCounts.missing_file).toBe(1);
    expect(report.collectionsChecked).toBe(BACKUP_COLLECTIONS.length - 1);
  });

  it("reports missing records when the snapshot holds fewer than the manifest expects", () => {
    const stored = { ...CLEAN, promptversions: [CLEAN.promptversions[0]] };
    const report = validateBackupSnapshot(buildSnapshot(CLEAN, stored));

    const count = report.issues.find((i) => i.kind === "record_count_mismatch");
    expect(count?.collection).toBe("promptversions");
    expect(count?.message).toContain("missing records");
  });

  it("flags a purchase that references a prompt missing from the snapshot", () => {
    const data = { ...CLEAN, purchases: [{ _id: "b2", promptId: "99" }] };
    const report = validateBackupSnapshot(buildSnapshot(data));

    expect(report.issueCounts).toEqual({ orphaned_reference: 1 });
    expect(report.issues[0]).toMatchObject({ collection: "purchases", recordId: "b2" });
  });

  it("flags a version that references a missing prompt", () => {
    const data = { ...CLEAN, promptversions: [{ _id: "v9", promptId: "77", versionIndex: 0 }] };
    const report = validateBackupSnapshot(buildSnapshot(data));

    expect(report.issueCounts).toEqual({ orphaned_reference: 1 });
    expect(report.issues[0]).toMatchObject({ collection: "promptversions", recordId: "v9" });
  });

  it("flags a repeated _id as a duplicate key", () => {
    const data = { ...CLEAN, prompts: [...CLEAN.prompts, { _id: "p1", onChainId: "3", title: "Copy" }] };
    const report = validateBackupSnapshot(buildSnapshot(data));

    expect(report.issueCounts.duplicate_key).toBe(1);
    expect(report.issues.find((i) => i.kind === "duplicate_key")).toMatchObject({ collection: "prompts", recordId: "p1" });
  });

  it("flags two versions of one prompt sharing an index as a duplicate key", () => {
    const data = {
      ...CLEAN,
      promptversions: [
        { _id: "v1", promptId: "1", versionIndex: 0 },
        { _id: "v2", promptId: "1", versionIndex: 0 },
      ],
    };
    const report = validateBackupSnapshot(buildSnapshot(data));

    expect(report.issueCounts.duplicate_key).toBe(1);
    expect(report.issues[0].message).toContain("two versions with index 0");
  });

  it("flags indexer finality that is ahead of indexing", () => {
    const data = { ...CLEAN, indexerstates: [{ _id: "i1", lastIndexedLedger: 120, lastFinalizedLedger: 130 }] };
    const report = validateBackupSnapshot(buildSnapshot(data));

    expect(report.issueCounts).toEqual({ inconsistent_state: 1 });
    expect(report.issues[0].message).toContain("finalized ledger 130 is ahead of indexed ledger 120");
  });

  it("reports a line that is not a JSON object without stopping the scan", () => {
    const input = buildSnapshot(CLEAN);
    input.files.auditlogs = zlib.gzipSync(Buffer.from('{"_id":"a1"}\nnot json\n'));
    const report = validateBackupSnapshot(input);

    expect(report.issues.find((i) => i.kind === "malformed_record")).toMatchObject({
      collection: "auditlogs",
      line: 2,
    });
    expect(report.collectionsChecked).toBe(BACKUP_COLLECTIONS.length);
  });

  it("rejects an unreadable manifest and checks nothing else", () => {
    const report = validateBackupSnapshot({ manifestBytes: Buffer.from("{ nope"), files: {} });

    expect(report.ok).toBe(false);
    expect(report.issueCounts).toEqual({ manifest_invalid: 1 });
    expect(report.collectionsChecked).toBe(0);
  });

  it("compares the manifest hash only when the operator supplies the recorded one", () => {
    const input = buildSnapshot(CLEAN);
    const recorded = sha256(input.manifestBytes);

    expect(validateBackupSnapshot({ ...input, expectedManifestSha256: recorded }).ok).toBe(true);
    expect(validateBackupSnapshot({ ...input, expectedManifestSha256: "0".repeat(64) }).issueCounts).toEqual({
      manifest_hash_mismatch: 1,
    });
  });
});
