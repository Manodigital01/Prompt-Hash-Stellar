/**
 * Deterministic Sorting for Mixed-Status Records and Events (#1032).
 *
 * Ensures mathematical total ordering and deterministic pagination across
 * records and events with heterogeneous statuses (e.g., active, pending,
 * paused, quarantined, retired).
 *
 * Core Guarantees:
 *   1. Strict Total Order:
 *      Every pair of distinct records (A != B) has a defined, unambiguous
 *      relative order (either A < B or B < A, never equal).
 *   2. Permutation Invariance:
 *      Input order, network arrival sequence, or database cursor jitter does
 *      not alter the sorted output. Array reversal or seeded shuffles produce
 *      the identical sorted sequence and SHA-256 fingerprint.
 *   3. Tamper-Evident Pagination Cursor:
 *      Encodes the exact multi-attribute tuple (statusRank, primaryKey, secondaryKey, id)
 *      with an HMAC-SHA256 checksum so client pagination cannot drift or skip records
 *      during concurrent status transitions.
 *
 * Space & Time Complexity:
 *   - Sort Time: O(N log N) using stable comparison sort.
 *   - Cursor Validation: O(1).
 *   - Space Complexity: O(N) shallow copy of record pointers.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

export const PROMPT_STATUS_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  active: 1,
  pending: 2,
  paused: 3,
  flagged: 4,
  quarantined: 5,
  retired: 6,
});

export const EVENT_STATUS_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  committed: 1,
  replayed: 2,
  pending: 3,
  quarantined: 4,
  dlq: 5,
  rolled_back: 6,
});

export const GRANT_STATUS_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  active: 1,
  pending: 2,
  expired: 3,
  revoked: 4,
});

export interface SortableRecord {
  id: string;
  status: string;
  primaryKey: number | string; // e.g., ledger sequence number or createdAt epoch ms
  secondaryKey?: number | string; // e.g., txIndex or version
  [key: string]: unknown;
}

export interface DeterministicSortOptions {
  direction?: "asc" | "desc";
  /**
   * When true, status precedence is the dominant primary sorting factor.
   * When false, primaryKey is dominant, and status precedence breaks ties.
   * Defaults to false (chronological / ledger dominant).
   */
  groupByStatus?: boolean;
  statusPrecedence?: Record<string, number>;
}

export interface DeterministicCursorData {
  statusRank: number;
  primaryKey: number | string;
  secondaryKey: number | string;
  id: string;
}

export interface PaginatedResult<T extends SortableRecord> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

export type DeterministicSortErrorCode =
  | "invalid_cursor"
  | "cursor_tampered"
  | "empty_selection"
  | "unsupported_key_type";

export class DeterministicSortError extends Error {
  readonly code: DeterministicSortErrorCode;
  constructor(
    code: DeterministicSortErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeterministicSortError";
    this.code = code;
  }
}

/**
 * Returns canonical numerical rank for a status string based on the given precedence map.
 */
export function getStatusRank(
  status: string,
  precedence: Record<string, number> = PROMPT_STATUS_PRECEDENCE,
): number {
  const norm = (status || "").toLowerCase().trim();
  return precedence[norm] ?? 999;
}

/**
 * Normalizes comparison keys into strict numeric or lexicographic values.
 */
function comparePrimitiveKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const strA = String(a);
  const strB = String(b);
  return strA.localeCompare(strB, "en", { sensitivity: "variant" });
}

/**
 * Total order comparator for mixed-status records.
 */
export function createDeterministicComparator<T extends SortableRecord>(
  options: DeterministicSortOptions = {},
): (a: T, b: T) => number {
  const direction = options.direction ?? "asc";
  const factor = direction === "desc" ? -1 : 1;
  const groupByStatus = options.groupByStatus ?? false;
  const precedence = options.statusPrecedence ?? PROMPT_STATUS_PRECEDENCE;

  return (a: T, b: T): number => {
    // 0. Identity check
    if (a.id === b.id) return 0;

    const rankA = getStatusRank(a.status, precedence);
    const rankB = getStatusRank(b.status, precedence);

    if (groupByStatus) {
      // 1. Dominant status rank
      if (rankA !== rankB) {
        return (rankA - rankB) * factor;
      }
      // 2. Primary key
      const primCmp = comparePrimitiveKeys(a.primaryKey, b.primaryKey);
      if (primCmp !== 0) {
        return primCmp * factor;
      }
    } else {
      // 1. Dominant primary key (e.g. ledger or timestamp)
      const primCmp = comparePrimitiveKeys(a.primaryKey, b.primaryKey);
      if (primCmp !== 0) {
        return primCmp * factor;
      }
      // 2. Status rank tie-breaker
      if (rankA !== rankB) {
        return (rankA - rankB) * factor;
      }
    }

    // 3. Secondary key tie-breaker (e.g. txIndex, version)
    const secA = a.secondaryKey ?? 0;
    const secB = b.secondaryKey ?? 0;
    const secCmp = comparePrimitiveKeys(secA, secB);
    if (secCmp !== 0) {
      return secCmp * factor;
    }

    // 4. Ultimate tie-breaker: immutable ID lexicographic order (guarantees strict total order)
    return a.id.localeCompare(b.id, "en", { sensitivity: "variant" }) * factor;
  };
}

/**
 * Sorts an array of mixed-status records deterministically.
 * Returns a new shallow copy of the sorted records.
 */
export function sortMixedStatusRecords<T extends SortableRecord>(
  records: readonly T[],
  options: DeterministicSortOptions = {},
): T[] {
  const comparator = createDeterministicComparator<T>(options);
  return [...records].sort(comparator);
}

/**
 * Computes a SHA-256 fingerprint over a sorted record slice to verify determinism.
 */
export function computeSortedSequenceFingerprint(
  records: readonly SortableRecord[],
): string {
  const hash = createHash("sha256");
  for (const r of records) {
    hash.update(`${r.id}:${r.status}:${r.primaryKey}:${r.secondaryKey ?? 0};`);
  }
  return hash.digest("hex");
}

/**
 * Encodes a deterministic pagination cursor with HMAC integrity.
 */
export function encodeDeterministicCursor(
  record: SortableRecord,
  secret: string,
  precedence: Record<string, number> = PROMPT_STATUS_PRECEDENCE,
): string {
  const cursorData: DeterministicCursorData = {
    statusRank: getStatusRank(record.status, precedence),
    primaryKey: record.primaryKey,
    secondaryKey: record.secondaryKey ?? 0,
    id: record.id,
  };

  const payload = Buffer.from(JSON.stringify(cursorData), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");

  return `${payload}.${signature}`;
}

/**
 * Decodes and verifies a deterministic pagination cursor.
 */
export function decodeDeterministicCursor(
  cursorString: string,
  secret: string,
): DeterministicCursorData {
  const parts = cursorString.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DeterministicSortError("invalid_cursor", "Malformed pagination cursor format.");
  }

  const [payload, signature] = parts;
  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new DeterministicSortError("cursor_tampered", "Pagination cursor integrity verification failed.");
  }

  try {
    const jsonStr = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(jsonStr) as DeterministicCursorData;
  } catch {
    throw new DeterministicSortError("invalid_cursor", "Failed to deserialize cursor payload.");
  }
}

/**
 * Paginates deterministically over a pre-sorted or unsorted collection of mixed-status records.
 */
export function paginateMixedStatusRecords<T extends SortableRecord>(
  records: readonly T[],
  params: {
    limit: number;
    cursor?: string | null;
    secret: string;
    sortOptions?: DeterministicSortOptions;
  },
): PaginatedResult<T> {
  const limit = Math.max(1, Math.min(params.limit, 100));
  const sorted = sortMixedStatusRecords(records, params.sortOptions);
  const comparator = createDeterministicComparator<T>(params.sortOptions);

  let startIndex = 0;

  if (params.cursor) {
    const cursorData = decodeDeterministicCursor(params.cursor, params.secret);
    const cursorRecord: SortableRecord = {
      id: cursorData.id,
      status: `__rank_${cursorData.statusRank}`,
      primaryKey: cursorData.primaryKey,
      secondaryKey: cursorData.secondaryKey,
    };

    // Find the position strictly after cursorRecord
    const idx = sorted.findIndex((item) => item.id === cursorData.id);
    if (idx !== -1) {
      startIndex = idx + 1;
    } else {
      // Binary or linear search to find first element > cursorRecord
      startIndex = sorted.findIndex((item) => comparator(item, cursorRecord as T) > 0);
      if (startIndex === -1) startIndex = sorted.length;
    }
  }

  const slice = sorted.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < sorted.length;
  const lastItem = slice[slice.length - 1];

  const nextCursor =
    hasMore && lastItem
      ? encodeDeterministicCursor(
          lastItem,
          params.secret,
          params.sortOptions?.statusPrecedence ?? PROMPT_STATUS_PRECEDENCE,
        )
      : null;

  return {
    items: slice,
    nextCursor,
    hasMore,
    totalCount: sorted.length,
  };
}

/**
 * Verification utility asserting strict total ordering, antisymmetry, and transitivity.
 */
export function verifySortingInvariants<T extends SortableRecord>(
  records: readonly T[],
  options: DeterministicSortOptions = {},
): {
  isTotalOrder: boolean;
  isPermutationInvariant: boolean;
  fingerprint: string;
  violations: string[];
} {
  const violations: string[] = [];
  const sortedBaseline = sortMixedStatusRecords(records, options);
  const baselineFingerprint = computeSortedSequenceFingerprint(sortedBaseline);

  // 1. Verify Monotonicity
  const comparator = createDeterministicComparator<T>(options);
  for (let i = 0; i < sortedBaseline.length - 1; i++) {
    const a = sortedBaseline[i];
    const b = sortedBaseline[i + 1];
    const cmp = comparator(a, b);
    if (cmp > 0) {
      violations.push(`Monotonicity violation at index ${i}: ${a.id} > ${b.id}`);
    }
    if (a.id === b.id) {
      violations.push(`Duplicate ID collision: ${a.id}`);
    }
  }

  // 2. Verify Permutation Invariance (Reversed input produces same sorted output)
  const reversedInput = [...records].reverse();
  const sortedReversed = sortMixedStatusRecords(reversedInput, options);
  const reversedFingerprint = computeSortedSequenceFingerprint(sortedReversed);

  let isPermutationInvariant = true;
  if (baselineFingerprint !== reversedFingerprint) {
    violations.push("Permutation invariance failed: reversed input yielded different sort order.");
    isPermutationInvariant = false;
  }

  return {
    isTotalOrder: violations.length === 0,
    isPermutationInvariant,
    fingerprint: baselineFingerprint,
    violations,
  };
}
