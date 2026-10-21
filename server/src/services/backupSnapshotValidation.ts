/**
 * Read-only validation of a backup snapshot (#906).
 *
 * A restore is only as good as the snapshot it reads. This module checks a
 * snapshot written by `runBackup({ localDir })` before anyone relies on it:
 * the manifest, each collection's checksum, size and record count, record
 * parse health, and the cross-record invariants a restored database must
 * satisfy (no duplicate keys, no references to missing prompts, indexer
 * finality never ahead of indexing).
 *
 * It works on bytes in memory. It never connects to a database and never
 * writes anything; the CLI in `server/src/scripts/validateBackupSnapshot.ts`
 * only writes a report when asked. See docs/operations/backup-and-recovery.md.
 */

import crypto from "crypto";
import zlib from "zlib";
import { BACKUP_COLLECTIONS, type BackupManifest } from "./backupService";

export type SnapshotIssueKind =
  | "manifest_invalid"
  | "manifest_hash_mismatch"
  | "missing_file"
  | "corrupt_archive"
  | "checksum_mismatch"
  | "size_mismatch"
  | "record_count_mismatch"
  | "malformed_record"
  | "duplicate_key"
  | "orphaned_reference"
  | "inconsistent_state";

export interface SnapshotIssue {
  kind: SnapshotIssueKind;
  collection: string;
  message: string;
  line?: number;
  recordId?: string;
}

export interface SnapshotValidationReport {
  ok: boolean;
  readOnly: true;
  collectionsChecked: number;
  recordsScanned: number;
  issues: SnapshotIssue[];
  issueCounts: Partial<Record<SnapshotIssueKind, number>>;
}

export interface SnapshotInput {
  /** Exact bytes of `manifest.json` as written to disk. */
  manifestBytes: Buffer;
  /** Compressed `<collection>.ndjson.gz` bytes, keyed by collection name. */
  files: Partial<Record<string, Buffer>>;
  /** Manifest hash recorded when the backup ran (`BackupRun.manifestSha256`), if known. */
  expectedManifestSha256?: string;
}

type Doc = Record<string, unknown>;

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function idOf(doc: Doc): string {
  return String(doc._id ?? "");
}

export function validateBackupSnapshot(input: SnapshotInput): SnapshotValidationReport {
  const issues: SnapshotIssue[] = [];

  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(input.manifestBytes.toString("utf8"));
  } catch {
    manifest = null;
  }
  if (!manifest || typeof manifest !== "object" || manifest.version !== "1.0.0" || !manifest.collections) {
    issues.push({
      kind: "manifest_invalid",
      collection: "manifest",
      message: "manifest.json is not a readable version 1.0.0 manifest",
    });
    return summarize(issues, 0, 0);
  }

  if (input.expectedManifestSha256 && sha256(input.manifestBytes) !== input.expectedManifestSha256) {
    issues.push({
      kind: "manifest_hash_mismatch",
      collection: "manifest",
      message: "manifest.json does not match the hash recorded for this backup",
    });
  }

  const records: Record<string, Doc[]> = {};
  let recordsScanned = 0;

  for (const name of BACKUP_COLLECTIONS) {
    const entry = manifest.collections[name];
    if (!entry) {
      issues.push({ kind: "manifest_invalid", collection: name, message: `manifest does not list ${name}` });
      continue;
    }

    const file = input.files[name];
    if (!file) {
      issues.push({ kind: "missing_file", collection: name, message: `${name}.ndjson.gz is missing` });
      continue;
    }

    let raw: Buffer;
    try {
      raw = zlib.gunzipSync(file);
    } catch (err) {
      issues.push({
        kind: "corrupt_archive",
        collection: name,
        message: `${name}.ndjson.gz cannot be decompressed: ${errorMessage(err)}`,
      });
      continue;
    }

    if (sha256(raw) !== entry.sha256) {
      issues.push({
        kind: "checksum_mismatch",
        collection: name,
        message: `${name} SHA-256 does not match the manifest`,
      });
    }
    if (raw.length !== entry.uncompressedBytes) {
      issues.push({
        kind: "size_mismatch",
        collection: name,
        message: `${name} is ${raw.length} bytes, manifest says ${entry.uncompressedBytes}`,
      });
    }

    const lines = raw
      .toString("utf8")
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.trim().length > 0);

    if (lines.length !== entry.docCount) {
      const direction = lines.length < entry.docCount ? "missing" : "unexpected";
      issues.push({
        kind: "record_count_mismatch",
        collection: name,
        message: `manifest expects ${entry.docCount} records, snapshot holds ${lines.length} (${direction} records)`,
      });
    }

    const docs: Doc[] = [];
    for (const { line, number } of lines) {
      try {
        const doc = JSON.parse(line);
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
        docs.push(doc as Doc);
      } catch {
        issues.push({
          kind: "malformed_record",
          collection: name,
          line: number,
          message: `line ${number} is not a JSON object`,
        });
      }
    }

    recordsScanned += lines.length;
    records[name] = docs;
  }

  checkDuplicateKeys(records, issues);
  checkReferences(records, issues);
  checkConsistency(records, issues);

  return summarize(issues, Object.keys(records).length, recordsScanned);
}

function checkDuplicateKeys(records: Record<string, Doc[]>, issues: SnapshotIssue[]): void {
  for (const [name, docs] of Object.entries(records)) {
    const seen = new Set<string>();
    for (const doc of docs) {
      const id = idOf(doc);
      if (seen.has(id)) {
        issues.push({ kind: "duplicate_key", collection: name, recordId: id, message: `_id ${id} appears more than once` });
      }
      seen.add(id);
    }
  }

  const versions = records.promptversions ?? [];
  const versionKeys = new Set<string>();
  for (const doc of versions) {
    const key = `${String(doc.promptId)}#${String(doc.versionIndex)}`;
    if (versionKeys.has(key)) {
      issues.push({
        kind: "duplicate_key",
        collection: "promptversions",
        recordId: idOf(doc),
        message: `prompt ${String(doc.promptId)} has two versions with index ${String(doc.versionIndex)}`,
      });
    }
    versionKeys.add(key);
  }
}

function checkReferences(records: Record<string, Doc[]>, issues: SnapshotIssue[]): void {
  // Without a prompts collection there is nothing to resolve references against.
  if (!records.prompts) return;

  const promptKeys = new Set<string>();
  for (const prompt of records.prompts) {
    promptKeys.add(idOf(prompt));
    if (typeof prompt.onChainId === "string") promptKeys.add(prompt.onChainId);
  }

  for (const name of ["purchases", "promptversions"]) {
    for (const doc of records[name] ?? []) {
      const promptId = String(doc.promptId ?? "");
      if (!promptKeys.has(promptId)) {
        issues.push({
          kind: "orphaned_reference",
          collection: name,
          recordId: idOf(doc),
          message: `references prompt ${promptId || "(none)"}, which is not in the snapshot`,
        });
      }
    }
  }
}

function checkConsistency(records: Record<string, Doc[]>, issues: SnapshotIssue[]): void {
  for (const doc of records.indexerstates ?? []) {
    const indexed = doc.lastIndexedLedger;
    const finalized = doc.lastFinalizedLedger;
    if (!isNonNegativeInteger(indexed) || !isNonNegativeInteger(finalized)) {
      issues.push({
        kind: "inconsistent_state",
        collection: "indexerstates",
        recordId: idOf(doc),
        message: "ledger cursors must be non-negative integers",
      });
    } else if (finalized > indexed) {
      issues.push({
        kind: "inconsistent_state",
        collection: "indexerstates",
        recordId: idOf(doc),
        message: `finalized ledger ${finalized} is ahead of indexed ledger ${indexed}`,
      });
    }
  }

  for (const doc of records.promptversions ?? []) {
    if (!isNonNegativeInteger(doc.versionIndex)) {
      issues.push({
        kind: "inconsistent_state",
        collection: "promptversions",
        recordId: idOf(doc),
        message: "versionIndex must be a non-negative integer",
      });
    }
  }
}

function summarize(issues: SnapshotIssue[], collectionsChecked: number, recordsScanned: number): SnapshotValidationReport {
  const issueCounts: Partial<Record<SnapshotIssueKind, number>> = {};
  for (const issue of issues) {
    issueCounts[issue.kind] = (issueCounts[issue.kind] ?? 0) + 1;
  }
  return {
    ok: issues.length === 0,
    readOnly: true,
    collectionsChecked,
    recordsScanned,
    issues,
    issueCounts,
  };
}
