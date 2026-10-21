/**
 * Allow-listed operational metadata. User content, credentials, raw requests,
 * and payment details must never be copied into operational event metadata.
 */
export type OperationalMetadata = Record<string, string | number | boolean | null>;

const ALLOWED_METADATA = new Set([
  "requestId",
  "jobId",
  "resourceType",
  "resourceId",
  "operation",
  "status",
  "attempt",
  "durationMs",
  "errorCode",
]);

export function minimizeOperationalMetadata(
  metadata: Record<string, unknown> | undefined,
): OperationalMetadata {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) =>
        ALLOWED_METADATA.has(key) &&
        (value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"),
    ),
  ) as OperationalMetadata;
}

export const OPERATIONAL_RETENTION_WINDOWS = {
  timelineEventsDays: 90,
  promptEventsDays: 30,
  exportMetadataDays: 30,
  supportEvidenceDays: 365,
} as const;
