/**
 * Adaptive step-up verification for sensitive actions (#901).
 *
 * `abuseRiskScoring` decides whether an operation needs more proof
 * (`step_up`). This module tracks where a subject stands in that proof:
 *
 *   none      → no record; a challenge is required
 *   verified  → proof accepted; valid until `expiresAt`
 *   expired   → the verified window has passed; proof is required again
 *   failed    → proof was rejected; retries remain until the budget is spent
 *   locked    → the attempt budget is spent; refused until `lockedUntil`
 *
 * Low-risk operations never reach this module, so ordinary traffic has no
 * extra friction. A locked subject is refused even with a valid proof: the
 * lock is a brake on guessing, not a reward for a correct answer.
 *
 * The pure functions carry all transition logic. `StepUpVerificationStore`
 * keeps records per process, like the other abuse-risk stores, and only ever
 * holds hashed wallets. Runbook: docs/operations/step-up-verification.md
 */

import { hashSubject, type HighImpactOperation } from "./abuseRiskScoring";

export const STEP_UP_VERIFIED_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_MAX_FAILED_ATTEMPTS = 3;
export const STEP_UP_LOCKOUT_MS = 15 * 60 * 1000;

export type StepUpCode =
  | "STEP_UP_REQUIRED"
  | "STEP_UP_EXPIRED"
  | "STEP_UP_FAILED"
  | "STEP_UP_LOCKED";

export interface StepUpRecord {
  state: "verified" | "failed";
  verifiedAt?: number;
  expiresAt?: number;
  failedAttempts: number;
  lockedUntil?: number;
}

export type StepUpEvaluation =
  | { allowed: true; reason: "verified" }
  | {
      allowed: false;
      code: StepUpCode;
      attemptsRemaining: number;
      lockedUntil?: number;
    };

/**
 * Decide whether a step-up operation may proceed given the subject's record.
 * Pure: the caller supplies `now`, so the same input always gives the same result.
 */
export function evaluateStepUp(
  record: StepUpRecord | undefined,
  now: number,
  maxAttempts: number = STEP_UP_MAX_FAILED_ATTEMPTS,
): StepUpEvaluation {
  const deny = (code: StepUpCode, attemptsRemaining: number, lockedUntil?: number): StepUpEvaluation => ({
    allowed: false,
    code,
    attemptsRemaining,
    ...(lockedUntil !== undefined ? { lockedUntil } : {}),
  });

  if (!record) {
    return deny("STEP_UP_REQUIRED", maxAttempts);
  }

  if (record.lockedUntil !== undefined && now < record.lockedUntil) {
    return deny("STEP_UP_LOCKED", 0, record.lockedUntil);
  }

  if (record.state === "verified") {
    if (record.expiresAt !== undefined && now < record.expiresAt) {
      return { allowed: true, reason: "verified" };
    }
    return deny("STEP_UP_EXPIRED", maxAttempts);
  }

  // A failed record whose lock has elapsed starts a fresh attempt budget.
  if (record.lockedUntil !== undefined) {
    return deny("STEP_UP_REQUIRED", maxAttempts);
  }
  return deny("STEP_UP_FAILED", Math.max(0, maxAttempts - record.failedAttempts));
}

/**
 * Apply one proof attempt to a subject's record and return the next record.
 * A valid proof verifies the subject and clears the attempt count. An invalid
 * proof spends one attempt, and spending the last one starts the lockout.
 */
export function applyStepUpProof(
  previous: StepUpRecord | undefined,
  proofValid: boolean,
  now: number,
  options: { maxAttempts?: number; lockoutMs?: number; verifiedTtlMs?: number } = {},
): StepUpRecord {
  const maxAttempts = options.maxAttempts ?? STEP_UP_MAX_FAILED_ATTEMPTS;
  const lockoutMs = options.lockoutMs ?? STEP_UP_LOCKOUT_MS;
  const verifiedTtlMs = options.verifiedTtlMs ?? STEP_UP_VERIFIED_TTL_MS;

  if (proofValid) {
    return {
      state: "verified",
      verifiedAt: now,
      expiresAt: now + verifiedTtlMs,
      failedAttempts: 0,
    };
  }

  const lockElapsed = previous?.lockedUntil !== undefined && now >= previous.lockedUntil;
  const base = previous && !lockElapsed ? previous.failedAttempts : 0;
  const failedAttempts = base + 1;
  return {
    state: "failed",
    failedAttempts,
    ...(failedAttempts >= maxAttempts ? { lockedUntil: now + lockoutMs } : {}),
  };
}

/** Key for one subject, operation and target. The wallet is hashed, never stored raw. */
export function stepUpKey(wallet: string, operation: HighImpactOperation, target?: string): string {
  return `${hashSubject(wallet)}|${operation}|${target ?? ""}`;
}

export interface StepUpStoreOptions {
  maxRecords?: number;
}

/**
 * Bounded in-memory store of step-up records. A restart clears records, which
 * means a subject must verify again: the safe direction for this control.
 */
export class StepUpVerificationStore {
  private readonly records = new Map<string, StepUpRecord>();
  private readonly maxRecords: number;

  constructor(options: StepUpStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 10_000;
  }

  get(key: string): StepUpRecord | undefined {
    return this.records.get(key);
  }

  /** Apply one proof attempt and store the resulting record. */
  applyProof(key: string, proofValid: boolean, now: number = Date.now()): StepUpRecord {
    const next = applyStepUpProof(this.records.get(key), proofValid, now);
    if (!this.records.has(key) && this.records.size >= this.maxRecords) {
      // Evict the oldest-inserted record; Map preserves insertion order.
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    this.records.set(key, next);
    return next;
  }

  reset(key?: string): void {
    if (key) this.records.delete(key);
    else this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}

export const stepUpVerificationStore = new StepUpVerificationStore();

/** Plain-language remedy for each denial, returned to the caller with the code. */
export function stepUpRemedy(code: StepUpCode): string {
  switch (code) {
    case "STEP_UP_REQUIRED":
      return "Sign a fresh wallet-session challenge (GET /api/wallet-session/challenge) and retry.";
    case "STEP_UP_EXPIRED":
      return "Your verification has expired. Sign a fresh wallet-session challenge and retry.";
    case "STEP_UP_FAILED":
      return "The verification was not accepted. Sign a fresh wallet-session challenge and retry; attempts are limited.";
    case "STEP_UP_LOCKED":
      return "Too many verification attempts. Wait until the lockout ends (see lockedUntil), then sign a fresh challenge.";
  }
}
