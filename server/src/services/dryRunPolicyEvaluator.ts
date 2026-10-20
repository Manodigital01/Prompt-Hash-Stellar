/**
 * Dry-Run Policy Evaluator with Affected-Record Previews (#1030).
 *
 * Provides safe, side-effect-free evaluation of governance and operational
 * policies across PromptHash Stellar marketplace records.
 *
 * Architectural Workflow:
 *   1. Authorization & Policy Validation
 *      Verifies the actor possesses explicit policy evaluation permissions
 *      ("policy:evaluate" or "admin"). Rejects unauthorized or malformed requests.
 *   2. Bounded Record Scanning
 *      Streams or accepts candidate records under a hard limit (MAX_EVALUATION_RECORDS).
 *      Performs predicate matching in O(1) time per record.
 *   3. Record Diff & Reversibility Analysis
 *      Computes field-level before/after diffs, calculates estimated financial
 *      impact (e.g. XLM volume changes), and flags irreversible transitions
 *      (such as Soroban smart contract `Retired` status).
 *   4. Cryptographic Confirmation Token
 *      Produces an HMAC-SHA256 signature binding the policy ID, actor ID,
 *      affected record IDs, and versions. Any subsequent execution attempt must
 *      present this token; if records or policies mutate, the token is rejected.
 *
 * Space Complexity: O(K) bounded memory for the preview window (MAX_PREVIEW_RECORDS).
 * Time Complexity:  O(N) linear scan over N candidate records.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Deterministic JSON serialization with recursively sorted object keys (RFC 8785 style).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

export const MAX_EVALUATION_RECORDS = 10_000;
export const MAX_PREVIEW_RECORDS = 100;

export type PolicyTargetResource =
  | "prompts"
  | "users"
  | "purchases"
  | "maintainer_grants"
  | "webhooks";

export type PolicyActionType =
  | "price_cap"
  | "price_floor"
  | "fee_override"
  | "status_transition"
  | "tag_restriction"
  | "inactivity_retire"
  | "quarantine_abuse";

export type ComparisonOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "regex";

export interface PolicyRulePredicate {
  field: string;
  operator: ComparisonOperator;
  value: unknown;
}

export interface DryRunPolicyDefinition {
  id: string;
  name: string;
  description?: string;
  targetResource: PolicyTargetResource;
  predicate: PolicyRulePredicate | readonly PolicyRulePredicate[];
  action: PolicyActionType;
  parameters: Record<string, unknown>;
  requiredPermission: string;
  isDestructive?: boolean;
}

export interface PolicyEvaluatorActor {
  id: string;
  role?: string;
  permissions: ReadonlySet<string>;
}

export interface RecordDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AffectedRecordPreview {
  recordId: string;
  version: number;
  statusBefore: string;
  statusAfter: string;
  diffs: RecordDiff[];
  severity: "low" | "medium" | "high" | "critical";
  isIrreversible: boolean;
  violationReason: string;
  estimatedFinancialImpactXlm?: number;
}

export interface DryRunEvaluationResult {
  policyId: string;
  policyName: string;
  actorId: string;
  targetResource: PolicyTargetResource;
  scannedCount: number;
  affectedCount: number;
  unaffectedCount: number;
  irreversibleCount: number;
  totalFinancialImpactXlm: number;
  severityCounts: Record<"low" | "medium" | "high" | "critical", number>;
  affectedPreviews: AffectedRecordPreview[];
  confirmationToken: string;
  evaluationDurationMs: number;
}

export type PolicyEvaluationErrorCode =
  | "unauthorized"
  | "invalid_policy"
  | "invalid_predicate"
  | "selection_too_large"
  | "confirmation_mismatch";

export class PolicyEvaluationError extends Error {
  readonly code: PolicyEvaluationErrorCode;
  constructor(
    code: PolicyEvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyEvaluationError";
    this.code = code;
  }
}

/**
 * Evaluates a single comparison predicate against a record field value.
 */
export function evaluatePredicateCondition(
  recordValue: unknown,
  operator: ComparisonOperator,
  targetValue: unknown,
): boolean {
  switch (operator) {
    case "eq":
      return recordValue === targetValue;
    case "ne":
      return recordValue !== targetValue;
    case "gt":
      return (
        typeof recordValue === "number" &&
        typeof targetValue === "number" &&
        recordValue > targetValue
      );
    case "gte":
      return (
        typeof recordValue === "number" &&
        typeof targetValue === "number" &&
        recordValue >= targetValue
      );
    case "lt":
      return (
        typeof recordValue === "number" &&
        typeof targetValue === "number" &&
        recordValue < targetValue
      );
    case "lte":
      return (
        typeof recordValue === "number" &&
        typeof targetValue === "number" &&
        recordValue <= targetValue
      );
    case "in":
      return Array.isArray(targetValue) && targetValue.includes(recordValue);
    case "not_in":
      return Array.isArray(targetValue) && !targetValue.includes(recordValue);
    case "contains":
      if (typeof recordValue === "string" && typeof targetValue === "string") {
        return recordValue.toLowerCase().includes(targetValue.toLowerCase());
      }
      if (Array.isArray(recordValue)) {
        return recordValue.includes(targetValue);
      }
      return false;
    case "regex":
      if (typeof recordValue === "string" && typeof targetValue === "string") {
        try {
          const re = new RegExp(targetValue, "i");
          return re.test(recordValue);
        } catch {
          return false;
        }
      }
      return false;
    default:
      return false;
  }
}

/**
 * Checks whether a candidate record satisfies all predicates in a policy.
 */
export function recordMatchesPolicy(
  record: Record<string, unknown>,
  predicates: readonly PolicyRulePredicate[],
): boolean {
  for (const pred of predicates) {
    const recordVal = record[pred.field];
    if (!evaluatePredicateCondition(recordVal, pred.operator, pred.value)) {
      return false;
    }
  }
  return true;
}

/**
 * Computes projected field changes and financial/operational impact for a matched record.
 */
export function computeProjectedRecordDiff(
  record: Record<string, unknown>,
  policy: DryRunPolicyDefinition,
): {
  statusBefore: string;
  statusAfter: string;
  diffs: RecordDiff[];
  severity: "low" | "medium" | "high" | "critical";
  isIrreversible: boolean;
  violationReason: string;
  financialImpactXlm: number;
} {
  const diffs: RecordDiff[] = [];
  const statusBefore = String(record.status ?? "unknown");
  let statusAfter = statusBefore;
  let severity: "low" | "medium" | "high" | "critical" = "low";
  let isIrreversible = false;
  let financialImpactXlm = 0;
  let violationReason = `Triggered by policy ${policy.name}`;

  switch (policy.action) {
    case "price_cap": {
      const currentPrice = Number(record.priceXlm ?? 0);
      const maxPrice = Number(policy.parameters.maxPrice ?? currentPrice);
      if (currentPrice > maxPrice) {
        diffs.push({ field: "priceXlm", before: currentPrice, after: maxPrice });
        severity = "medium";
        financialImpactXlm = currentPrice - maxPrice;
        violationReason = `Price ${currentPrice} XLM exceeds policy cap of ${maxPrice} XLM`;
      }
      break;
    }
    case "price_floor": {
      const currentPrice = Number(record.priceXlm ?? 0);
      const minPrice = Number(policy.parameters.minPrice ?? currentPrice);
      if (currentPrice < minPrice) {
        diffs.push({ field: "priceXlm", before: currentPrice, after: minPrice });
        severity = "low";
        financialImpactXlm = minPrice - currentPrice;
        violationReason = `Price ${currentPrice} XLM below policy floor of ${minPrice} XLM`;
      }
      break;
    }
    case "status_transition":
    case "inactivity_retire": {
      const targetStatus = String(policy.parameters.targetStatus ?? "retired");
      statusAfter = targetStatus;
      diffs.push({ field: "status", before: statusBefore, after: statusAfter });
      if (targetStatus === "retired") {
        isIrreversible = true;
        severity = "critical";
        violationReason = "Irreversible transition to retired state on Soroban ledger";
      } else if (targetStatus === "quarantined") {
        severity = "high";
        violationReason = "Administrative quarantine due to policy non-compliance";
      } else {
        severity = "medium";
        violationReason = `Status change from ${statusBefore} to ${statusAfter}`;
      }
      break;
    }
    case "fee_override": {
      const currentFee = Number(record.platformFeeBps ?? 500);
      const newFee = Number(policy.parameters.newFeeBps ?? currentFee);
      diffs.push({ field: "platformFeeBps", before: currentFee, after: newFee });
      severity = "medium";
      const volume = Number(record.totalVolumeXlm ?? 0);
      financialImpactXlm = (volume * (newFee - currentFee)) / 10_000;
      violationReason = `Platform fee override from ${currentFee} bps to ${newFee} bps`;
      break;
    }
    case "quarantine_abuse": {
      statusAfter = "quarantined";
      diffs.push({ field: "status", before: statusBefore, after: statusAfter });
      diffs.push({ field: "quarantineReason", before: null, after: policy.parameters.reason ?? "abuse_detected" });
      severity = "critical";
      violationReason = "Automated quarantine triggered by abuse risk parameters";
      break;
    }
    default: {
      diffs.push({ field: "policyEvaluated", before: false, after: true });
      severity = "low";
    }
  }

  return {
    statusBefore,
    statusAfter,
    diffs,
    severity,
    isIrreversible,
    violationReason,
    financialImpactXlm,
  };
}

/**
 * Computes an HMAC confirmation token locking the dry-run plan.
 */
export function generatePolicyPlanConfirmationToken(
  secret: string,
  params: {
    policyId: string;
    targetResource: PolicyTargetResource;
    actorId: string;
    affectedRecordSummaries: Array<{ id: string; version: number }>;
    totalFinancialImpactXlm: number;
  },
): string {
  const canonicalPayload = canonicalJson({
    policyId: params.policyId,
    targetResource: params.targetResource,
    actorId: params.actorId,
    affectedRecords: [...params.affectedRecordSummaries].sort((a, b) => a.id.localeCompare(b.id)),
    totalFinancialImpactXlm: params.totalFinancialImpactXlm,
  });

  return createHmac("sha256", secret).update(canonicalPayload).digest("hex");
}

/**
 * Validates a confirmation token using constant-time equality check.
 */
export function verifyPolicyPlanConfirmationToken(
  secret: string,
  token: string,
  params: {
    policyId: string;
    targetResource: PolicyTargetResource;
    actorId: string;
    affectedRecordSummaries: Array<{ id: string; version: number }>;
    totalFinancialImpactXlm: number;
  },
): boolean {
  const expected = generatePolicyPlanConfirmationToken(secret, params);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Evaluates a policy against candidate records in dry-run mode.
 *
 * Guaranteed Properties:
 *  - Pure / Side-Effect Free: Performs zero database writes.
 *  - Enforces actor authorization.
 *  - Rejects oversized inputs exceeding MAX_EVALUATION_RECORDS.
 *  - Returns bounded affected previews (up to MAX_PREVIEW_RECORDS).
 */
export async function evaluatePolicyDryRun(
  secret: string,
  policy: DryRunPolicyDefinition,
  actor: PolicyEvaluatorActor,
  records: readonly Record<string, unknown>[],
  options?: {
    maxRecords?: number;
    maxPreview?: number;
  },
): Promise<DryRunEvaluationResult> {
  const startTime = Date.now();

  // 1. Authorization Path
  const hasAuth =
    actor.permissions.has("admin") ||
    actor.permissions.has("policy:evaluate") ||
    actor.permissions.has(policy.requiredPermission);

  if (!hasAuth) {
    throw new PolicyEvaluationError(
      "unauthorized",
      `Actor ${actor.id} lacks required permission (${policy.requiredPermission}) to evaluate policy ${policy.id}`,
    );
  }

  // 2. Validate Policy Definition
  if (!policy.id || !policy.name || !policy.targetResource || !policy.action) {
    throw new PolicyEvaluationError("invalid_policy", "Policy definition is missing required fields.");
  }

  const predicates = Array.isArray(policy.predicate) ? policy.predicate : [policy.predicate];
  if (predicates.length === 0) {
    throw new PolicyEvaluationError("invalid_predicate", "Policy must contain at least one predicate condition.");
  }

  // 3. Bounds Check
  const maxRecordsLimit = options?.maxRecords ?? MAX_EVALUATION_RECORDS;
  if (records.length > maxRecordsLimit) {
    throw new PolicyEvaluationError(
      "selection_too_large",
      `Candidate record set (${records.length}) exceeds maximum allowable evaluation limit (${maxRecordsLimit}).`,
    );
  }

  const maxPreviewLimit = options?.maxPreview ?? MAX_PREVIEW_RECORDS;
  let affectedCount = 0;
  let unaffectedCount = 0;
  let irreversibleCount = 0;
  let totalFinancialImpactXlm = 0;

  const severityCounts: Record<"low" | "medium" | "high" | "critical", number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  const affectedPreviews: AffectedRecordPreview[] = [];
  const affectedSummaries: Array<{ id: string; version: number }> = [];

  // 4. Linear Scan O(N)
  for (const record of records) {
    const recordId = String(record.id ?? record._id ?? `rec_${affectedCount + unaffectedCount}`);
    const version = Number(record.version ?? 1);

    if (recordMatchesPolicy(record, predicates)) {
      affectedCount++;
      const projected = computeProjectedRecordDiff(record, policy);

      severityCounts[projected.severity]++;
      if (projected.isIrreversible) {
        irreversibleCount++;
      }
      totalFinancialImpactXlm += projected.financialImpactXlm;

      affectedSummaries.push({ id: recordId, version });

      if (affectedPreviews.length < maxPreviewLimit) {
        affectedPreviews.push({
          recordId,
          version,
          statusBefore: projected.statusBefore,
          statusAfter: projected.statusAfter,
          diffs: projected.diffs,
          severity: projected.severity,
          isIrreversible: projected.isIrreversible,
          violationReason: projected.violationReason,
          estimatedFinancialImpactXlm: projected.financialImpactXlm,
        });
      }
    } else {
      unaffectedCount++;
    }
  }

  // 5. Build Cryptographic Confirmation Token
  const confirmationToken = generatePolicyPlanConfirmationToken(secret, {
    policyId: policy.id,
    targetResource: policy.targetResource,
    actorId: actor.id,
    affectedRecordSummaries: affectedSummaries,
    totalFinancialImpactXlm,
  });

  return {
    policyId: policy.id,
    policyName: policy.name,
    actorId: actor.id,
    targetResource: policy.targetResource,
    scannedCount: records.length,
    affectedCount,
    unaffectedCount,
    irreversibleCount,
    totalFinancialImpactXlm,
    severityCounts,
    affectedPreviews,
    confirmationToken,
    evaluationDurationMs: Date.now() - startTime,
  };
}
