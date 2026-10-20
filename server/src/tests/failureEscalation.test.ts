import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Configurable escalation rules (#904).
 *
 * Covers policy validation, the escalation state machine (first notification,
 * repeats, exhaustion, resolution, and a policy change), the maintainer report,
 * and the sweep's claim-before-send behaviour. The model, audit trail and logger
 * are mocked.
 */

vi.mock("../services/auditTrail", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/structuredLogger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../models/OperationFailure", () => ({
  default: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
}));

import OperationFailure from "../models/OperationFailure";
import { recordAuditEvent } from "../services/auditTrail";
import {
  DEFAULT_ESCALATION_POLICY,
  EscalationPolicyError,
  auditingNotifier,
  buildEscalationReport,
  evaluateEscalation,
  loadEscalationPolicy,
  runEscalationSweep,
  validateEscalationPolicy,
  type EscalationPolicy,
  type EscalatableFailure,
} from "../services/failureEscalation";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** High severity: first notice after 2h, then every 2h, at most 5 times. */
const policy: EscalationPolicy = validateEscalationPolicy(DEFAULT_ESCALATION_POLICY);

function failure(overrides: Partial<EscalatableFailure> = {}): EscalatableFailure {
  return {
    id: "fail-1",
    severity: "high",
    operationType: "payout_settlement",
    relatedResource: "prompt-9",
    firstFailedAt: ago(5 * HOUR),
    resolvedAt: null,
    escalation: {},
    ...overrides,
  };
}

function issuesOf(input: unknown): string[] {
  try {
    validateEscalationPolicy(input);
    return [];
  } catch (err) {
    return err instanceof EscalationPolicyError ? err.issues : [String(err)];
  }
}

describe("evaluateEscalation", () => {
  it("does not notify before the first window opens", () => {
    const decision = evaluateEscalation(failure({ firstFailedAt: ago(1 * HOUR) }), policy, NOW);
    expect(decision.status).toBe("not_yet_due");
  });

  it("notifies once the first window has passed", () => {
    const decision = evaluateEscalation(failure({ firstFailedAt: ago(3 * HOUR) }), policy, NOW);
    expect(decision).toMatchObject({ status: "due", notificationNumber: 1 });
  });

  it("waits for the repeat interval after the first notification", () => {
    const waiting = evaluateEscalation(
      failure({ firstFailedAt: ago(3 * HOUR), escalation: { notificationsSent: 1 } }),
      policy,
      NOW,
    );
    expect(waiting).toMatchObject({ status: "scheduled", notificationNumber: 2 });
  });

  it("repeats until the repeat interval has elapsed", () => {
    const repeat = evaluateEscalation(
      failure({ firstFailedAt: ago(5 * HOUR), escalation: { notificationsSent: 1 } }),
      policy,
      NOW,
    );
    expect(repeat).toMatchObject({ status: "due", notificationNumber: 2 });
  });

  it("stops once the notification budget is spent", () => {
    const decision = evaluateEscalation(
      failure({ firstFailedAt: ago(40 * HOUR), escalation: { notificationsSent: 5 } }),
      policy,
      NOW,
    );
    expect(decision.status).toBe("exhausted");
  });

  it("stops escalating as soon as the failure is resolved", () => {
    const decision = evaluateEscalation(
      failure({ firstFailedAt: ago(40 * HOUR), resolvedAt: ago(1 * HOUR) }),
      policy,
      NOW,
    );
    expect(decision.status).toBe("resolved");
  });

  it("changes the outcome when the policy changes", () => {
    const slower = validateEscalationPolicy({
      ...DEFAULT_ESCALATION_POLICY,
      version: 2,
      rules: DEFAULT_ESCALATION_POLICY.rules.map((rule) =>
        rule.severity === "high" ? { ...rule, afterMs: 6 * HOUR } : rule,
      ),
    });
    const sameFailure = failure({ firstFailedAt: ago(3 * HOUR) });

    expect(evaluateEscalation(sameFailure, policy, NOW).status).toBe("due");
    expect(evaluateEscalation(sameFailure, slower, NOW).status).toBe("not_yet_due");
  });
});

describe("validateEscalationPolicy", () => {
  it("accepts the default policy", () => {
    expect(issuesOf(DEFAULT_ESCALATION_POLICY)).toEqual([]);
  });

  it("requires exactly one rule for every severity", () => {
    const withoutLow = { ...DEFAULT_ESCALATION_POLICY, rules: DEFAULT_ESCALATION_POLICY.rules.slice(0, 3) };
    expect(issuesOf(withoutLow)).toContain('no rule for severity "low"');

    const duplicated = {
      ...DEFAULT_ESCALATION_POLICY,
      rules: [...DEFAULT_ESCALATION_POLICY.rules, DEFAULT_ESCALATION_POLICY.rules[1]],
    };
    expect(issuesOf(duplicated).join(" ")).toContain('"high" is defined more than once');
  });

  it("rejects repeat intervals below one minute and empty notification budgets", () => {
    const bad = {
      ...DEFAULT_ESCALATION_POLICY,
      rules: DEFAULT_ESCALATION_POLICY.rules.map((rule) =>
        rule.severity === "critical" ? { ...rule, repeatEveryMs: 1000, maxNotifications: 0 } : rule,
      ),
    };
    const issues = issuesOf(bad);
    expect(issues.some((i) => i.includes("repeatEveryMs"))).toBe(true);
    expect(issues.some((i) => i.includes("maxNotifications"))).toBe(true);
  });

  it("reports every problem in one pass", () => {
    expect(issuesOf({ version: 0, rules: "nope" })).toEqual([
      "version must be a positive integer",
      "rules must be an array",
    ]);
  });
});

describe("loadEscalationPolicy", () => {
  it("uses the default when no policy is configured", () => {
    expect(loadEscalationPolicy(undefined)).toBe(DEFAULT_ESCALATION_POLICY);
    expect(loadEscalationPolicy("   ")).toBe(DEFAULT_ESCALATION_POLICY);
  });

  it("parses and validates a configured policy", () => {
    const parsed = loadEscalationPolicy(JSON.stringify({ ...DEFAULT_ESCALATION_POLICY, version: 7 }));
    expect(parsed.version).toBe(7);
  });

  it("treats malformed configuration as an error, not a silent default", () => {
    expect(() => loadEscalationPolicy("{not json")).toThrow(EscalationPolicyError);
  });
});

describe("buildEscalationReport", () => {
  it("lists started escalations, most severe first, and counts the rest", () => {
    const failures: EscalatableFailure[] = [
      failure({ id: "resolved", resolvedAt: ago(1 * HOUR), firstFailedAt: ago(40 * HOUR) }),
      failure({ id: "too-new", firstFailedAt: ago(1 * HOUR) }),
      failure({ id: "high-due", severity: "high", firstFailedAt: ago(3 * HOUR) }),
      failure({ id: "critical-due", severity: "critical", firstFailedAt: ago(10 * 60 * 1000) }),
      failure({
        id: "medium-exhausted",
        severity: "medium",
        firstFailedAt: ago(60 * HOUR),
        escalation: { notificationsSent: 3 },
      }),
    ];

    const report = buildEscalationReport(failures, policy, NOW);

    expect(report.counts).toEqual({ due: 2, scheduled: 0, exhausted: 1, not_yet_due: 1, resolved: 1 });
    expect(report.active.map((entry) => entry.id)).toEqual(["critical-due", "high-due", "medium-exhausted"]);
    expect(report.active[0]).toMatchObject({ status: "due", channel: "on_call", notificationsSent: 0 });
  });
});

// ─── IO ──────────────────────────────────────────────────────────────────────

function queryOf(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.sort = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.lean = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe("runEscalationSweep", () => {
  beforeEach(() => {
    vi.mocked(OperationFailure.find).mockReset();
    vi.mocked(OperationFailure.findOneAndUpdate).mockReset();
    vi.mocked(OperationFailure.updateOne).mockReset();
    vi.mocked(recordAuditEvent).mockClear();
  });

  const dueDoc = {
    _id: "fail-1",
    severity: "high",
    operationType: "payout_settlement",
    relatedResource: "prompt-9",
    firstFailedAt: ago(3 * HOUR),
    resolvedAt: null,
    escalation: {},
  };

  it("notifies a due failure after claiming the slot", async () => {
    vi.mocked(OperationFailure.find).mockReturnValue(queryOf([dueDoc]) as never);
    vi.mocked(OperationFailure.findOneAndUpdate).mockReturnValue({
      lean: () => Promise.resolve({ _id: "fail-1" }),
    } as never);
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await runEscalationSweep({ policy, notify, now: NOW });

    expect(result).toEqual({ evaluated: 1, notified: 1, failed: 0, skipped: 0 });
    expect(OperationFailure.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "fail-1", resolvedAt: null }),
      expect.objectContaining({ $inc: { "escalation.notificationAttempts": 1 } }),
      expect.anything(),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fail-1" }),
      expect.objectContaining({ status: "due", notificationNumber: 1 }),
    );
  });

  it("does not send when another sweep already claimed the slot", async () => {
    vi.mocked(OperationFailure.find).mockReturnValue(queryOf([dueDoc]) as never);
    vi.mocked(OperationFailure.findOneAndUpdate).mockReturnValue({
      lean: () => Promise.resolve(null),
    } as never);
    const notify = vi.fn();

    const result = await runEscalationSweep({ policy, notify, now: NOW });

    expect(result.skipped).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("releases the claim and records the error when the send fails", async () => {
    vi.mocked(OperationFailure.find).mockReturnValue(queryOf([dueDoc]) as never);
    vi.mocked(OperationFailure.findOneAndUpdate).mockReturnValue({
      lean: () => Promise.resolve({ _id: "fail-1" }),
    } as never);
    const notify = vi.fn().mockRejectedValue(new Error("channel offline"));

    const result = await runEscalationSweep({ policy, notify, now: NOW });

    expect(result.failed).toBe(1);
    expect(OperationFailure.updateOne).toHaveBeenCalledWith(
      { _id: "fail-1", "escalation.notificationsSent": 1 },
      { $set: { "escalation.notificationsSent": 0, "escalation.lastError": "channel offline" } },
    );
  });

  it("leaves failures that are not yet due alone", async () => {
    const early = { ...dueDoc, _id: "fail-2", firstFailedAt: ago(30 * 60 * 1000) };
    vi.mocked(OperationFailure.find).mockReturnValue(queryOf([early]) as never);
    const notify = vi.fn();

    const result = await runEscalationSweep({ policy, notify, now: NOW });

    expect(result).toEqual({ evaluated: 1, notified: 0, failed: 0, skipped: 0 });
    expect(OperationFailure.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes an audit row for each notification and fails the send if it cannot be recorded", async () => {
    vi.mocked(recordAuditEvent).mockRejectedValueOnce(new Error("audit store down"));

    await expect(
      auditingNotifier(failure(), { status: "due", rule: policy.rules[1], dueAt: NOW, notificationNumber: 1 }),
    ).rejects.toThrow("audit store down");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "failure_escalated" }),
      { throwOnError: true },
    );
  });
});
