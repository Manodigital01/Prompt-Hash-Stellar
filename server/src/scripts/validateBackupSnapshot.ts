/**
 * Read-only backup snapshot validator CLI (#906).
 *
 *   ts-node src/scripts/validateBackupSnapshot.ts --dir <localDir> --timestamp <ts>
 *     [--expect-manifest-sha256 <hex>] [--out <report.json>]
 *
 * Reads `<dir>/<timestamp>/` and never connects to a database or modifies the
 * snapshot. A report file is written only when `--out` is given. Exit codes:
 * 0 = snapshot is clean, 1 = issues found, 2 = usage or unreadable snapshot.
 */

import fs from "fs";
import path from "path";
import { BACKUP_COLLECTIONS } from "../services/backupService";
import { validateBackupSnapshot } from "../services/backupSnapshotValidation";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const dir = readArg("--dir");
  const timestamp = readArg("--timestamp");
  if (!dir || !timestamp) {
    console.error("Usage: validateBackupSnapshot --dir <localDir> --timestamp <ts> [--expect-manifest-sha256 <hex>] [--out <report.json>]");
    process.exit(2);
  }

  const snapshotDir = path.join(dir, timestamp);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest.json found at ${manifestPath}`);
    process.exit(2);
  }

  const files: Record<string, Buffer> = {};
  for (const name of BACKUP_COLLECTIONS) {
    const filePath = path.join(snapshotDir, `${name}.ndjson.gz`);
    if (fs.existsSync(filePath)) files[name] = fs.readFileSync(filePath);
  }

  const report = validateBackupSnapshot({
    manifestBytes: fs.readFileSync(manifestPath),
    files,
    expectedManifestSha256: readArg("--expect-manifest-sha256"),
  });

  console.log(
    `Snapshot ${timestamp}: ${report.ok ? "OK" : "ISSUES FOUND"} ` +
      `(${report.collectionsChecked} collections, ${report.recordsScanned} records scanned)`,
  );
  for (const issue of report.issues) {
    const location = issue.line ? `${issue.collection}:${issue.line}` : issue.collection;
    console.log(`- [${issue.kind}] ${location}: ${issue.message}`);
  }

  const outPath = readArg("--out");
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${outPath}`);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
