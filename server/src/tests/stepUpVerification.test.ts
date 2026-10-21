import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * Adaptive step-up verification (#901).
 *
 * Covers the pure transition rules, the bounded store, and the guard's
 * step-up branch end to end: low risk passes untouched, high risk needs
 * proof, and expired, failed, locked and retried verifications each return
 * their own code.
 */

vi.mock("../services/auditTrail", () => ({ recordAuditEvent: vi.fn() }));

import { abuseRiskGuard } from "../middleware/abuseRiskGuard";
import { abuseActivityLedger, abuseReviewQueue } from "../services/abuseRiskScoring";
import { recordAuditEvent } from "../services/auditTrail";
import {
  STEP_UP_LOCKOUT_MS,
  STEP_UP_MAX_FAILED_ATTEMPTS,
  STEP_UP_VERIFIED_TTL_MS,
  StepUpVerificationStore,
  applyStepUpProof,
  evaluateStepUp,
  stepUpKey,
  stepUpVerificationStore,
} from "../services/stepUpVerification";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const NOW = 1_800_000_000_000;
const KEY = stepUpKey(WALLET, "payout_request", "t");

function mockRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = vi.fn(() => res);
  return res;
}

function mockReq(authorization?: string) {
  return {
    headers: authorization ? { authorization } : {},
    socket: { remoteAddress: "9.9.9.9" },
    body: { wallet: WALLET },
  } as any;
}

/**
 * Seed a failed streak that scores as a single signal (`failed_attempt_streak`).
 * Targets are distinct so `repeat_target` never fires alongside it, which
 * would otherwise corroborate into `review` instead of `step_up`.
 */
function seedFailureStreak() {
  for (let i = 0; i < 6; i++) {
    abuseActivityLedger.record(
      { operation: "payout_request", wallet: WALLET, target: `other-${i}` },
      false,
    );
  }
}

const guard = () =>
  abuseRiskGuard({
    operation: "payout_request",
    extract: (req) => ({ wallet: req.body.wallet, target: "t", amount: 100 }),
    mode: () => "enforce",
    // The proof is decided per request by the Authorization header in these
    // tests: a bearer token counts as a valid fresh session.
    stepUpSatisfied: (req) => req.headers.authorization === "Bearer valid",
  });

function run(req: any) {
  const res = mockRes();
  const next = vi.fn();
  guard()(req, res, next);
  return { res, next, body: res.json.mock.calls[0]?.[0] };
}

describe("evaluateStepUp", () => {
  it("requires a challenge when no record exists", () => {
    expect(evaluateStepUp(undefined, NOW)).toEqual({
      allowed: false,
      code: "STEP_UP_REQUIRED",
      attemptsRemaining: STEP_UP_MAX_FAILED_ATTEMPTS,
    });
  });

  it("allows a verified subject inside the TTL window", () => {
    const record = applyStepUpProof(undefined, true, NOW);
    expect(evaluateStepUp(record, NOW + STEP_UP_VERIFIED_TTL_MS - 1)).toEqual({
      allowed: true,
      reason: "verified",
    });
  });

  it("reports an expired verification once the window has passed", () => {
    const record = applyStepUpProof(undefined, true, NOW);
    const result = evaluateStepUp(record, NOW + STEP_UP_VERIFIED_TTL_MS);
    expect(result).toMatchObject({ allowed: false, code: "STEP_UP_EXPIRED" });
  });

  it("counts failed attempts and reports what remains", () => {
    const first = applyStepUpProof(undefined, false, NOW);
    expect(evaluateStepUp(first, NOW)).toMatchObject({
      allowed: false,
      code: "STEP_UP_FAILED",
      attemptsRemaining: STEP_UP_MAX_FAILED_ATTEMPTS - 1,
    });

    const second = applyStepUpProof(first, false, NOW + 1);
    expect(evaluateStepUp(second, NOW + 1)).toMatchObject({
      code: "STEP_UP_FAILED",
      attemptsRemaining: 1,
    });
  });

  it("locks the subject when the attempt budget is spent", () => {
    let record = applyStepUpProof(undefined, false, NOW);
    record = applyStepUpProof(record, false, NOW + 1);
    record = applyStepUpProof(record, false, NOW + 2);

    expect(record.lockedUntil).toBe(NOW + 2 + STEP_UP_LOCKOUT_MS);
    expect(evaluateStepUp(record, NOW + 3)).toEqual({
      allowed: false,
      code: "STEP_UP_LOCKED",
      attemptsRemaining: 0,
      lockedUntil: NOW + 2 + STEP_UP_LOCKOUT_MS,
    });
  });

  it("reports a lock regardless of later proof; the guard checks this before applying proof", () => {
    let record = applyStepUpProof(undefined, false, NOW);
    record = applyStepUpProof(record, false, NOW + 1);
    record = applyStepUpProof(record, false, NOW + 2);
    expect(evaluateStepUp(record, NOW + 3)).toMatchObject({ code: "STEP_UP_LOCKED" });
  });

  it("starts a fresh attempt budget once the lockout has elapsed", () => {
    let record = applyStepUpProof(undefined, false, NOW);
    record = applyStepUpProof(record, false, NOW + 1);
    record = applyStepUpProof(record, false, NOW + 2);
    const afterLock = NOW + 2 + STEP_UP_LOCKOUT_MS;

    expect(evaluateStepUp(record, afterLock)).toMatchObject({
      code: "STEP_UP_REQUIRED",
      attemptsRemaining: STEP_UP_MAX_FAILED_ATTEMPTS,
    });

    const retried = applyStepUpProof(record, false, afterLock);
    expect(retried.failedAttempts).toBe(1);
    expect(retried.lockedUntil).toBeUndefined();
  });

  it("clears the failure count after a successful retry", () => {
    let record = applyStepUpProof(undefined, false, NOW);
    record = applyStepUpProof(record, false, NOW + 1);
    record = applyStepUpProof(record, true, NOW + 2);

    expect(record).toMatchObject({ state: "verified", failedAttempts: 0 });
    expect(evaluateStepUp(record, NOW + 3)).toEqual({ allowed: true, reason: "verified" });

    const nextFailure = applyStepUpProof(record, false, NOW + 4);
    expect(nextFailure.failedAttempts).toBe(1);
  });
});

describe("StepUpVerificationStore", () => {
  it("keys records per wallet, operation and target without storing the raw wallet", () => {
    expect(stepUpKey(WALLET, "payout_request", "t")).toBe(
      stepUpKey(WALLET.toLowerCase(), "payout_request", "t"),
    );
    expect(stepUpKey(WALLET, "payout_request", "t")).not.toBe(
      stepUpKey(WALLET, "ownership_transfer", "t"),
    );
    expect(stepUpKey(WALLET, "payout_request", "t")).not.toContain(WALLET);
  });

  it("evicts the oldest record once the bound is reached", () => {
    const store = new StepUpVerificationStore({ maxRecords: 2 });
    store.applyProof("a", true, NOW);
    store.applyProof("b", true, NOW);
    store.applyProof("c", true, NOW);

    expect(store.size).toBe(2);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });
});

describe("abuseRiskGuard step-up enforcement (#901)", () => {
  beforeEach(() => {
    abuseActivityLedger.reset();
    abuseReviewQueue.clear();
    stepUpVerificationStore.reset();
    vi.mocked(recordAuditEvent).mockClear();
  });

  it("lets low-risk operations through with no verification step", () => {
    const { next, res } = run(mockReq());
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(stepUpVerificationStore.size).toBe(0);
  });

  it("requires proof for a high-risk operation with no verification", () => {
    seedFailureStreak();
    const { next, body, res } = run(mockReq());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(body).toMatchObject({
      code: "STEP_UP_REQUIRED",
      attemptsRemaining: STEP_UP_MAX_FAILED_ATTEMPTS,
    });
    expect(body.remedy).toContain("wallet-session challenge");
  });

  it("admits a fresh session and records the verification", () => {
    seedFailureStreak();
    const { next } = run(mockReq("Bearer valid"));
    expect(next).toHaveBeenCalledOnce();
    expect(stepUpVerificationStore.get(KEY)).toMatchObject({ state: "verified" });
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "step_up_verified", result: "success" }),
    );
  });

  it("admits a verified subject without a fresh session while the window is open", () => {
    seedFailureStreak();
    stepUpVerificationStore.applyProof(KEY, true, Date.now());
    const { next } = run(mockReq());
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns STEP_UP_EXPIRED when a verification has aged out", () => {
    seedFailureStreak();
    stepUpVerificationStore.applyProof(KEY, true, Date.now() - STEP_UP_VERIFIED_TTL_MS - 1000);
    const { next, body } = run(mockReq());
    expect(next).not.toHaveBeenCalled();
    expect(body.code).toBe("STEP_UP_EXPIRED");
  });

  it("returns STEP_UP_FAILED with attempts remaining after a rejected proof", () => {
    seedFailureStreak();
    const { next, body, res } = run(mockReq("Bearer bad"));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(body).toMatchObject({
      code: "STEP_UP_FAILED",
      attemptsRemaining: STEP_UP_MAX_FAILED_ATTEMPTS - 1,
    });
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "step_up_failed", result: "blocked" }),
    );
  });

  it("admits a successful retry after a failed attempt", () => {
    seedFailureStreak();
    run(mockReq("Bearer bad"));
    const { next } = run(mockReq("Bearer valid"));
    expect(next).toHaveBeenCalledOnce();
  });

  it("locks after the attempt budget is spent and refuses even a valid proof", () => {
    seedFailureStreak();
    for (let i = 0; i < STEP_UP_MAX_FAILED_ATTEMPTS; i++) {
      run(mockReq("Bearer bad"));
    }
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "step_up_locked", result: "blocked" }),
    );

    const { next, body } = run(mockReq("Bearer valid"));
    expect(next).not.toHaveBeenCalled();
    expect(body).toMatchObject({ code: "STEP_UP_LOCKED", attemptsRemaining: 0 });
    expect(typeof body.lockedUntil).toBe("string");
  });
});
