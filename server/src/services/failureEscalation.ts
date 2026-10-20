/**
 * Configurable escalation for unresolved user-impacting failures (#904).
 *
 * A policy holds one rule per severity. Each rule sets when the first
 * notification is due (`afterMs` after the failure), how often it repeats
 * (`repeatEveryMs`), and how many notifications are allowed in total. Resolved
 * failures stop escalating at once.
 *
 * Pure parts: policy validation, `evaluateEscalation`, and the maintainer report.
 * IO parts: `runEscalationSweep` claims each notification with a guarded write
 * before sending, so overlapping sweeps cannot both notify. A failed send
 * releases its claim. Trade-off: a process that crashes between claim and send
 * misses that one notification. The failure still appears as an active
 * escalation in the report.
 *
 * The policy comes from `ESCALATION_POLICY_JSON` when set, otherwise from
 * `DEFAULT_ESCALATION_POLICY`. An invalid policy is an error, not a fallback.
 *
 * Runbook: docs/operations/failure-escalation.md
 */

import OperationFailure from "../models/OperationFailure";
import { recordAuditEvent } from "./auditTrail";
import { logger } from "./structuredLogger";

export const ESCALATION_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type EscalationSeverity = (typeof ESCALATION_SEVERITIES)[number];

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const MAX_WINDOW_MS = 30 * 24 * HOUR_MS;
export const MIN_REPEAT_MS = 60 * SECOND_MS;
export const MAX_NOTIFICATIONS_LIMIT = 50;

export interface EscalationRule {
  severity: EscalationSeverity;
  /** Time after `firstFailedAt` before the first notification is due. */
  afterMs: number;
  /** Interval between later notifications. */
  repeatEveryMs: number;
  /** Total notifications allowed for one failure. */
  maxNotifications: number;
  /** Where the notification goes, such as `on_call` or `maintainers`. */
  channel: string;
}

export interface EscalationPolicy {
  version: number;
  rules: EscalationRule[];
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  version: 1,
  rules: [
    { severity: "critical", afterMs: 0, repeatEveryMs: 30 * 60 * SECOND_MS, maxNotifications: 10, channel: "on_call" },
    { severity: "high", afterMs: 2 * HOUR_MS, repeatEveryMs: 2 * HOUR_MS, maxNotifications: 5, channel: "maintainers" },
    { severity: "medium", afterMs: 12 * HOUR_MS, repeatEveryMs: 12 * HOUR_MS, maxNotifications: 3, channel: "maintainers" },
    { severity: "low", afterMs: 24 * HOUR_MS, repeatEveryMs: 24 * HOUR_MS, maxNotifications: 2, channel: "maintainers" },
  ],
};

export class EscalationPolicyError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid escalation policy: ${issues.join("; ")}`);
    this.name = "EscalationPolicyError";
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Check a policy document and return it typed. Every issue is collected, so an
 * operator can fix them all in one pass. Each severity must appear exactly once,
 * so no failure ever lacks a rule.
 */
export function validateEscalationPolicy(input: unknown): EscalationPolicy {
  const issues: string[] = [];
  if (!input || typeof input !== "object") {
    throw new EscalationPolicyError(["policy must be an object"]);
  }
  const policy = input as { version?: unknown; rules?: unknown };

  if (!isInteger(policy.version) || policy.version < 1) {
    issues.push("version must be a positive integer");
  }
  if (!Array.isArray(policy.rules)) {
    issues.push("rules must be an array");
    throw new EscalationPolicyError(issues);
  }

  const seen = new Set<string>();
  policy.rules.forEach((rule: Partial<EscalationRule>, index) => {
    const at = `rules[${index}]`;
    if (!rule || typeof rule !== "object") {
      issues.push(`${at} must be an object`);
      return;
    }
    if (!(ESCALATION_SEVERITIES as readonly string[]).includes(rule.severity as string)) {
      issues.push(`${at}.severity must be one of: ${ESCALATION_SEVERITIES.join(", ")}`);
    } else if (seen.has(rule.severity as string)) {
      issues.push(`${at}.severity "${rule.severity}" is defined more than once`);
    } else {
      seen.add(rule.severity as string);
    }
    if (!isInteger(rule.afterMs) || rule.afterMs < 0 || rule.afterMs > MAX_WINDOW_MS) {
      issues.push(`${at}.afterMs must be an integer from 0 to ${MAX_WINDOW_MS}`);
    }
    if (!isInteger(rule.repeatEveryMs) || rule.repeatEveryMs < MIN_REPEAT_MS || rule.repeatEveryMs > MAX_WINDOW_MS) {
      issues.push(`${at}.repeatEveryMs must be an integer from ${MIN_REPEAT_MS} to ${MAX_WINDOW_MS}`);
    }
    if (!isInteger(rule.maxNotifications) || rule.maxNotifications < 1 || rule.maxNotifications > MAX_NOTIFICATIONS_LIMIT) {
      issues.push(`${at}.maxNotifications must be an integer from 1 to ${MAX_NOTIFICATIONS_LIMIT}`);
    }
    if (typeof rule.channel !== "string" || rule.channel.trim().length === 0 || rule.channel.length > 40) {
      issues.push(`${at}.channel must be a non-empty string of at most 40 characters`);
    }
  });

  for (const severity of ESCALATION_SEVERITIES) {
    if (!seen.has(severity)) issues.push(`no rule for severity "${severity}"`);
  }

  if (issues.length > 0) throw new EscalationPolicyError(issues);

  const rules = policy.rules as EscalationRule[];
  return {
    version: policy.version as number,
    rules: ESCALATION_SEVERITIES.map((severity) => {
      const rule = rules.find((candidate) => candidate.severity === severity) as EscalationRule;
      return {
        severity,
        afterMs: rule.afterMs,
        repeatEveryMs: rule.repeatEveryMs,
        maxNotifications: rule.maxNotifications,
        channel: rule.channel.trim(),
      };
    }),
  };
}

/**
 * Read the policy from `ESCALATION_POLICY_JSON`. Unset or blank uses the default.
 * Anything else must parse and validate, or the call throws.
 */
export function loadEscalationPolicy(raw: string | undefined): EscalationPolicy {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ESCALATION_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EscalationPolicyError(["ESCALATION_POLICY_JSON is not valid JSON"]);
  }
  return validateEscalationPolicy(parsed);
}

export interface EscalationState {
  notificationsSent?: number;
  notificationAttempts?: number;
  lastEscalatedAt?: Date | null;
  lastAttemptAt?: Date | null;
  policyVersion?: number;
  lastError?: string;
}

export interface EscalatableFailure {
  id: string;
  severity: EscalationSeverity;
  operationType?: string;
  relatedResource?: string;
  firstFailedAt: Date;
  resolvedAt?: Date | null;
  escalation?: EscalationState;
}

export type EscalationDecision =
  | { status: "resolved" }
  | { status: "no_rule" }
  | { status: "not_yet_due"; rule: EscalationRule; dueAt: Date }
  | { status: "scheduled"; rule: EscalationRule; dueAt: Date; notificationNumber: number }
  | { status: "due"; rule: EscalationRule; dueAt: Date; notificationNumber: number }
  | { status: "exhausted"; rule: EscalationRule };

export type DueEscalation = Extract<EscalationDecision, { status: "due" }>;

/**
 * Decide whether a failure needs a notification now. Pure: the caller supplies
 * `now`. Notification n (1-based) is due at `firstFailedAt + afterMs + (n-1) * repeatEveryMs`.
 */
export function evaluateEscalation(
  failure: Pick<EscalatableFailure, "severity" | "firstFailedAt" | "resolvedAt" | "escalation">,
  policy: EscalationPolicy,
  now: Date,
): EscalationDecision {
  if (failure.resolvedAt) return { status: "resolved" };

  const rule = policy.rules.find((candidate) => candidate.severity === failure.severity);
  if (!rule) return { status: "no_rule" };

  const sent = failure.escalation?.notificationsSent ?? 0;
  const firstDueAt = new Date(new Date(failure.firstFailedAt).getTime() + rule.afterMs);
  if (now.getTime() < firstDueAt.getTime()) {
    return { status: "not_yet_due", rule, dueAt: firstDueAt };
  }
  if (sent >= rule.maxNotifications) {
    return { status: "exhausted", rule };
  }

  const notificationNumber = sent + 1;
  const dueAt = new Date(firstDueAt.getTime() + (notificationNumber - 1) * rule.repeatEveryMs);
  if (now.getTime() < dueAt.getTime()) {
    return { status: "scheduled", rule, dueAt, notificationNumber };
  }
  return { status: "due", rule, dueAt, notificationNumber };
}

const SEVERITY_RANK: Record<EscalationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface EscalationReportEntry {
  id: string;
  severity: EscalationSeverity;
  operationType: string | null;
  relatedResource: string | null;
  firstFailedAt: string;
  ageHours: number;
  status: "due" | "scheduled" | "exhausted";
  channel: string;
  notificationsSent: number;
  maxNotifications: number;
  nextDueAt: string | null;
}

export interface EscalationReport {
  generatedAt: string;
  policyVersion: number;
  counts: { due: number; scheduled: number; exhausted: number; not_yet_due: number; resolved: number };
  /** Escalations that have started: due now, waiting for the next repeat, or out of notifications. */
  active: EscalationReportEntry[];
}

/** Maintainer view of escalations that have started. Sorted by severity, then oldest first. */
export function buildEscalationReport(
  failures: EscalatableFailure[],
  policy: EscalationPolicy,
  now: Date = new Date(),
): EscalationReport {
  const report: EscalationReport = {
    generatedAt: now.toISOString(),
    policyVersion: policy.version,
    counts: { due: 0, scheduled: 0, exhausted: 0, not_yet_due: 0, resolved: 0 },
    active: [],
  };

  for (const failure of failures) {
    const decision = evaluateEscalation(failure, policy, now);
    if (decision.status === "resolved") {
      report.counts.resolved += 1;
      continue;
    }
    if (decision.status === "not_yet_due" || decision.status === "no_rule") {
      report.counts.not_yet_due += 1;
      continue;
    }
    if (decision.status === "exhausted") {
      report.counts.exhausted += 1;
    } else if (decision.status === "due") {
      report.counts.due += 1;
    } else {
      report.counts.scheduled += 1;
    }

    const sent = failure.escalation?.notificationsSent ?? 0;
    report.active.push({
      id: failure.id,
      severity: failure.severity,
      operationType: failure.operationType ?? null,
      relatedResource: failure.relatedResource ?? null,
      firstFailedAt: new Date(failure.firstFailedAt).toISOString(),
      ageHours: Math.floor((now.getTime() - new Date(failure.firstFailedAt).getTime()) / HOUR_MS),
      status: decision.status,
      channel: decision.rule.channel,
      notificationsSent: sent,
      maxNotifications: decision.rule.maxNotifications,
      nextDueAt: "dueAt" in decision ? decision.dueAt.toISOString() : null,
    });
  }

  report.active.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      new Date(a.firstFailedAt).getTime() - new Date(b.firstFailedAt).getTime(),
  );
  return report;
}

// ─── IO ──────────────────────────────────────────────────────────────────────

export type EscalationNotifier = (failure: EscalatableFailure, decision: DueEscalation) => Promise<void>;

export interface SweepResult {
  evaluated: number;
  notified: number;
  failed: number;
  skipped: number;
}

export async function loadUnresolvedFailures(limit = 500): Promise<EscalatableFailure[]> {
  const docs = await OperationFailure.find({ resolvedAt: null })
    .sort({ firstFailedAt: 1 })
    .limit(Math.min(Math.max(Math.floor(limit), 1), 5000))
    .lean();
  return (docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
    id: String(doc._id),
    severity: doc.severity as EscalationSeverity,
    operationType: doc.operationType as string | undefined,
    relatedResource: doc.relatedResource as string | undefined,
    firstFailedAt: doc.firstFailedAt as Date,
    resolvedAt: (doc.resolvedAt as Date | null | undefined) ?? null,
    escalation: doc.escalation as EscalationState | undefined,
  }));
}

/** Matches "no notifications yet", whether the field is absent or zero. */
function sentFilter(sent: number): Record<string, unknown> {
  if (sent === 0) {
    return {
      $or: [{ "escalation.notificationsSent": 0 }, { "escalation.notificationsSent": { $exists: false } }],
    };
  }
  return { "escalation.notificationsSent": sent };
}

async function claimNotification(
  failure: EscalatableFailure,
  sent: number,
  policyVersion: number,
  now: Date,
): Promise<boolean> {
  const claimed = await OperationFailure.findOneAndUpdate(
    { _id: failure.id, resolvedAt: null, ...sentFilter(sent) },
    {
      $set: {
        "escalation.notificationsSent": sent + 1,
        "escalation.lastEscalatedAt": now,
        "escalation.lastAttemptAt": now,
        "escalation.policyVersion": policyVersion,
      },
      $inc: { "escalation.notificationAttempts": 1 },
    },
    { new: true },
  ).lean();
  return claimed !== null;
}

async function releaseNotificationClaim(failure: EscalatableFailure, sent: number, error: string): Promise<void> {
  await OperationFailure.updateOne(
    { _id: failure.id, "escalation.notificationsSent": sent + 1 },
    { $set: { "escalation.notificationsSent": sent, "escalation.lastError": error.slice(0, 500) } },
  );
}

/**
 * Notify every failure whose next notification is due. Each send is claimed
 * first, so a failure is notified at most once per due slot.
 */
export async function runEscalationSweep(input: {
  policy: EscalationPolicy;
  notify: EscalationNotifier;
  now?: Date;
  limit?: number;
}): Promise<SweepResult> {
  const now = input.now ?? new Date();
  const failures = await loadUnresolvedFailures(input.limit);
  const result: SweepResult = { evaluated: failures.length, notified: 0, failed: 0, skipped: 0 };

  for (const failure of failures) {
    const decision = evaluateEscalation(failure, input.policy, now);
    if (decision.status !== "due") continue;

    const sent = failure.escalation?.notificationsSent ?? 0;
    const claimed = await claimNotification(failure, sent, input.policy.version, now);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    try {
      await input.notify(failure, decision);
      result.notified += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      await releaseNotificationClaim(failure, sent, message);
      result.failed += 1;
    }
  }
  return result;
}

/** Default notifier: a structured log line plus an audit row. Replace with a real channel when one exists. */
export const auditingNotifier: EscalationNotifier = async (failure, decision) => {
  logger.warn("failure escalation", {
    action: "failureEscalation",
    failureId: failure.id,
    severity: failure.severity,
    channel: decision.rule.channel,
    notificationNumber: decision.notificationNumber,
  });
  await recordAuditEvent(
    {
      action: "failure_escalated",
      result: "success",
      target: failure.id,
      targetType: "operation_failure",
      reason: `severity=${failure.severity} channel=${decision.rule.channel} notification=${decision.notificationNumber}`,
      metadata: { channel: decision.rule.channel, notificationNumber: decision.notificationNumber },
    },
    { throwOnError: true },
  );
};
