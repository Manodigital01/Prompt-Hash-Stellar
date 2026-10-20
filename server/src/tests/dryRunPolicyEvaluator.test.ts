import { describe, expect, it } from "vitest";
import {
  evaluatePolicyDryRun,
  generatePolicyPlanConfirmationToken,
  verifyPolicyPlanConfirmationToken,
  evaluatePredicateCondition,
  recordMatchesPolicy,
  PolicyEvaluationError,
  DryRunPolicyDefinition,
  PolicyEvaluatorActor,
} from "../services/dryRunPolicyEvaluator";

const SECRET = "dry-run-policy-secret-key-123456";

const ADMIN_ACTOR: PolicyEvaluatorActor = {
  id: "ops-alice",
  role: "admin",
  permissions: new Set(["admin"]),
};

const POLICY_ACTOR: PolicyEvaluatorActor = {
  id: "policy-officer-bob",
  role: "moderator",
  permissions: new Set(["policy:evaluate"]),
};

const UNAUTHORIZED_ACTOR: PolicyEvaluatorActor = {
  id: "viewer-carol",
  role: "viewer",
  permissions: new Set(["prompts:read"]),
};

describe("Dry-Run Policy Evaluator (#1030)", () => {
  const samplePrompts = [
    { id: "p1", version: 1, status: "active", priceXlm: 150, creator: "G1111", tags: ["gpt4", "crypto"] },
    { id: "p2", version: 2, status: "active", priceXlm: 45, creator: "G2222", tags: ["claude", "nlp"] },
    { id: "p3", version: 1, status: "paused", priceXlm: 200, creator: "G3333", tags: ["gpt4", "code"] },
    { id: "p4", version: 4, status: "active", priceXlm: 80, creator: "G4444", tags: ["vision", "art"] },
  ];

  it("evaluates price ceiling policy and generates affected record previews", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-price-cap-100",
      name: "Price Cap 100 XLM",
      targetResource: "prompts",
      predicate: { field: "priceXlm", operator: "gt", value: 100 },
      action: "price_cap",
      parameters: { maxPrice: 100 },
      requiredPermission: "policy:evaluate",
    };

    const result = await evaluatePolicyDryRun(SECRET, policy, POLICY_ACTOR, samplePrompts);

    expect(result.policyId).toBe("policy-price-cap-100");
    expect(result.scannedCount).toBe(4);
    expect(result.affectedCount).toBe(2); // p1 (150) and p3 (200)
    expect(result.unaffectedCount).toBe(2);
    expect(result.totalFinancialImpactXlm).toBe(50 + 100); // (150-100) + (200-100) = 150 XLM
    expect(result.affectedPreviews).toHaveLength(2);

    const p1Preview = result.affectedPreviews.find((p) => p.recordId === "p1");
    expect(p1Preview).toBeDefined();
    expect(p1Preview?.diffs).toEqual([
      { field: "priceXlm", before: 150, after: 100 },
    ]);
    expect(p1Preview?.severity).toBe("medium");
    expect(p1Preview?.isIrreversible).toBe(false);

    // Verify confirmation token matches
    const isValidToken = verifyPolicyPlanConfirmationToken(SECRET, result.confirmationToken, {
      policyId: policy.id,
      targetResource: policy.targetResource,
      actorId: POLICY_ACTOR.id,
      affectedRecordSummaries: [
        { id: "p1", version: 1 },
        { id: "p3", version: 1 },
      ],
      totalFinancialImpactXlm: 150,
    });
    expect(isValidToken).toBe(true);
  });

  it("detects irreversible status transitions (Soroban retired state)", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-retire-inactive",
      name: "Retire Paused Prompts",
      targetResource: "prompts",
      predicate: { field: "status", operator: "eq", value: "paused" },
      action: "inactivity_retire",
      parameters: { targetStatus: "retired" },
      requiredPermission: "policy:evaluate",
      isDestructive: true,
    };

    const result = await evaluatePolicyDryRun(SECRET, policy, ADMIN_ACTOR, samplePrompts);

    expect(result.affectedCount).toBe(1);
    expect(result.irreversibleCount).toBe(1);
    expect(result.affectedPreviews[0].recordId).toBe("p3");
    expect(result.affectedPreviews[0].isIrreversible).toBe(true);
    expect(result.affectedPreviews[0].severity).toBe("critical");
    expect(result.affectedPreviews[0].diffs).toEqual([
      { field: "status", before: "paused", after: "retired" },
    ]);
  });

  it("evaluates multiple composite predicates accurately", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-active-high-value",
      name: "Active and Price >= 100",
      targetResource: "prompts",
      predicate: [
        { field: "status", operator: "eq", value: "active" },
        { field: "priceXlm", operator: "gte", value: 100 },
      ],
      action: "price_cap",
      parameters: { maxPrice: 90 },
      requiredPermission: "policy:evaluate",
    };

    const result = await evaluatePolicyDryRun(SECRET, policy, POLICY_ACTOR, samplePrompts);

    // Only p1 satisfies both status === "active" and priceXlm >= 100 (p3 is paused)
    expect(result.affectedCount).toBe(1);
    expect(result.affectedPreviews[0].recordId).toBe("p1");
  });

  it("enforces strict actor authorization checks", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-test",
      name: "Test Policy",
      targetResource: "prompts",
      predicate: { field: "status", operator: "eq", value: "active" },
      action: "price_cap",
      parameters: { maxPrice: 50 },
      requiredPermission: "policy:evaluate",
    };

    await expect(
      evaluatePolicyDryRun(SECRET, policy, UNAUTHORIZED_ACTOR, samplePrompts),
    ).rejects.toThrow(PolicyEvaluationError);

    try {
      await evaluatePolicyDryRun(SECRET, policy, UNAUTHORIZED_ACTOR, samplePrompts);
    } catch (err: any) {
      expect(err.code).toBe("unauthorized");
    }
  });

  it("rejects evaluation when candidate set exceeds allowable bounds", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-test",
      name: "Test Policy",
      targetResource: "prompts",
      predicate: { field: "status", operator: "eq", value: "active" },
      action: "price_cap",
      parameters: { maxPrice: 50 },
      requiredPermission: "policy:evaluate",
    };

    const largeSet = Array.from({ length: 15 }, (_, i) => ({
      id: `p_${i}`,
      version: 1,
      status: "active",
      priceXlm: 50,
    }));

    await expect(
      evaluatePolicyDryRun(SECRET, policy, ADMIN_ACTOR, largeSet, { maxRecords: 10 }),
    ).rejects.toThrow(/exceeds maximum allowable evaluation limit/);
  });

  it("truncates preview items to maxPreview while maintaining total affected count", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-cap-all",
      name: "Cap All",
      targetResource: "prompts",
      predicate: { field: "status", operator: "eq", value: "active" },
      action: "price_cap",
      parameters: { maxPrice: 10 },
      requiredPermission: "policy:evaluate",
    };

    const records = Array.from({ length: 25 }, (_, i) => ({
      id: `rec_${i}`,
      version: 1,
      status: "active",
      priceXlm: 50,
    }));

    const result = await evaluatePolicyDryRun(SECRET, policy, ADMIN_ACTOR, records, {
      maxPreview: 5,
    });

    expect(result.affectedCount).toBe(25);
    expect(result.affectedPreviews).toHaveLength(5); // bounded to maxPreview
  });

  it("invalidates confirmation token if records or versions drift", async () => {
    const policy: DryRunPolicyDefinition = {
      id: "policy-drift-test",
      name: "Drift Test",
      targetResource: "prompts",
      predicate: { field: "status", operator: "eq", value: "active" },
      action: "price_cap",
      parameters: { maxPrice: 50 },
      requiredPermission: "policy:evaluate",
    };

    const result = await evaluatePolicyDryRun(SECRET, policy, ADMIN_ACTOR, samplePrompts);

    // Token verification succeeds with identical records and versions
    const valid = verifyPolicyPlanConfirmationToken(SECRET, result.confirmationToken, {
      policyId: policy.id,
      targetResource: policy.targetResource,
      actorId: ADMIN_ACTOR.id,
      affectedRecordSummaries: result.affectedPreviews.map((p) => ({
        id: p.recordId,
        version: p.version,
      })),
      totalFinancialImpactXlm: result.totalFinancialImpactXlm,
    });
    expect(valid).toBe(true);

    // If one record version changed from 1 to 2, confirmation token MUST fail
    const drifted = verifyPolicyPlanConfirmationToken(SECRET, result.confirmationToken, {
      policyId: policy.id,
      targetResource: policy.targetResource,
      actorId: ADMIN_ACTOR.id,
      affectedRecordSummaries: result.affectedPreviews.map((p, idx) => ({
        id: p.recordId,
        version: idx === 0 ? p.version + 1 : p.version,
      })),
      totalFinancialImpactXlm: result.totalFinancialImpactXlm,
    });
    expect(drifted).toBe(false);
  });

  it("tests various predicate comparison operators", () => {
    expect(evaluatePredicateCondition("hello", "contains", "ell")).toBe(true);
    expect(evaluatePredicateCondition("hello", "contains", "xyz")).toBe(false);
    expect(evaluatePredicateCondition(["art", "nft"], "contains", "art")).toBe(true);
    expect(evaluatePredicateCondition(10, "lte", 10)).toBe(true);
    expect(evaluatePredicateCondition(5, "gt", 10)).toBe(false);
    expect(evaluatePredicateCondition("active", "in", ["active", "paused"])).toBe(true);
    expect(evaluatePredicateCondition("deleted", "not_in", ["active", "paused"])).toBe(true);
    expect(evaluatePredicateCondition("G1234567890", "regex", "^G[0-9A-Z]+$")).toBe(true);
  });
});
