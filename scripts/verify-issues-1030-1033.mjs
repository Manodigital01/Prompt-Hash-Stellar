/**
 * Automated Verification Script for Issues #1030, #1031, #1032, and #1033.
 *
 * Verifies that all 4 vertical slices satisfy acceptance criteria:
 *   - Normal, failure, retry, and authorization pathways
 *   - Mathematical invariants and cryptographic signatures
 *   - Edge cases, recovery/rollback behavior, and bounded complexity
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-issues-1030-1033.mjs
 */

import assert from "node:assert/strict";

console.log("=================================================================");
console.log("Starting Executable Verification: Issues #1030, #1031, #1032, #1033");
console.log("=================================================================\n");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Issue #1030: Dry-Run Policy Evaluator with Affected-Record Previews
// ─────────────────────────────────────────────────────────────────────────────
console.log("--- Verifying Issue #1030: Dry-Run Policy Evaluator ---");

await runAsyncTest("#1030 Normal & Irreversible Path: Evaluates predicates and flags Soroban retired finality", async () => {
  const { evaluatePolicyDryRun } = await import(
    "../server/src/services/dryRunPolicyEvaluator.ts"
  );

  const secret = "test-secret-1030";
  const actor = { id: "admin-1", permissions: new Set(["policy:evaluate"]) };
  const records = [
    { id: "p1", version: 1, status: "active", priceXlm: 150 },
    { id: "p2", version: 2, status: "paused", priceXlm: 40 },
    { id: "p3", version: 1, status: "active", priceXlm: 80 },
  ];

  // Price cap policy
  const pricePolicy = {
    id: "pol_price_100",
    name: "Price Cap 100",
    targetResource: "prompts",
    predicate: { field: "priceXlm", operator: "gt", value: 100 },
    action: "price_cap",
    parameters: { maxPrice: 100 },
    requiredPermission: "policy:evaluate",
  };

  const result = await evaluatePolicyDryRun(secret, pricePolicy, actor, records);
  assert.equal(result.affectedCount, 1);
  assert.equal(result.affectedPreviews[0].recordId, "p1");
  assert.equal(result.totalFinancialImpactXlm, 50);

  // Retiring policy (flags irreversible Soroban status)
  const retirePolicy = {
    id: "pol_retire",
    name: "Retire Paused",
    targetResource: "prompts",
    predicate: { field: "status", operator: "eq", value: "paused" },
    action: "inactivity_retire",
    parameters: { targetStatus: "retired" },
    requiredPermission: "policy:evaluate",
  };

  const retireResult = await evaluatePolicyDryRun(secret, retirePolicy, actor, records);
  assert.equal(retireResult.affectedCount, 1);
  assert.equal(retireResult.irreversibleCount, 1);
  assert.equal(retireResult.affectedPreviews[0].isIrreversible, true);
  assert.equal(retireResult.affectedPreviews[0].severity, "critical");
});

await runAsyncTest("#1030 Authorization & Drift Path: Rejects unauthorized actor and detects record drift", async () => {
  const { evaluatePolicyDryRun, verifyPolicyPlanConfirmationToken } = await import(
    "../server/src/services/dryRunPolicyEvaluator.ts"
  );

  const secret = "test-secret-1030";
  const unauthorizedActor = { id: "viewer", permissions: new Set(["read"]) };
  const authorizedActor = { id: "admin", permissions: new Set(["admin"]) };
  const records = [{ id: "p1", version: 1, status: "active", priceXlm: 150 }];

  const policy = {
    id: "pol_1",
    name: "Policy 1",
    targetResource: "prompts",
    predicate: { field: "status", operator: "eq", value: "active" },
    action: "price_cap",
    parameters: { maxPrice: 100 },
    requiredPermission: "policy:evaluate",
  };

  // Unauthorized actor throws
  let unauthorizedThrown = false;
  try {
    await evaluatePolicyDryRun(secret, policy, unauthorizedActor, records);
  } catch (err) {
    unauthorizedThrown = true;
    assert.equal(err.code, "unauthorized");
  }
  assert.ok(unauthorizedThrown);

  // Confirmation token drift detection
  const res = await evaluatePolicyDryRun(secret, policy, authorizedActor, records);
  const isValid = verifyPolicyPlanConfirmationToken(secret, res.confirmationToken, {
    policyId: policy.id,
    targetResource: policy.targetResource,
    actorId: authorizedActor.id,
    affectedRecordSummaries: [{ id: "p1", version: 1 }],
    totalFinancialImpactXlm: res.totalFinancialImpactXlm,
  });
  assert.equal(isValid, true);

  // Drifted version 2 fails
  const isDrifted = verifyPolicyPlanConfirmationToken(secret, res.confirmationToken, {
    policyId: policy.id,
    targetResource: policy.targetResource,
    actorId: authorizedActor.id,
    affectedRecordSummaries: [{ id: "p1", version: 2 }],
    totalFinancialImpactXlm: res.totalFinancialImpactXlm,
  });
  assert.equal(isDrifted, false);
});

await runAsyncTest("#1030 Bounded Selection & Preview Cap: Truncates preview while maintaining count", async () => {
  const { evaluatePolicyDryRun } = await import(
    "../server/src/services/dryRunPolicyEvaluator.ts"
  );

  const secret = "test-secret-1030";
  const actor = { id: "admin", permissions: new Set(["admin"]) };
  const records = Array.from({ length: 30 }, (_, i) => ({
    id: `rec_${i}`,
    version: 1,
    status: "active",
    priceXlm: 120,
  }));

  const policy = {
    id: "pol_cap",
    name: "Cap All",
    targetResource: "prompts",
    predicate: { field: "status", operator: "eq", value: "active" },
    action: "price_cap",
    parameters: { maxPrice: 100 },
    requiredPermission: "policy:evaluate",
  };

  const res = await evaluatePolicyDryRun(secret, policy, actor, records, { maxPreview: 5 });
  assert.equal(res.affectedCount, 30);
  assert.equal(res.affectedPreviews.length, 5); // Bounded to maxPreview
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Issue #1031: Stale Session and Token Revocation After Security Events
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n--- Verifying Issue #1031: Stale Session and Token Revocation ---");

await runAsyncTest("#1031 Normal & Revocation Path: Invalidation of stale sessions prior to security event cutoff", async () => {
  const { SessionRevocationRegistry } = await import("../server/src/services/sessionRevocationService.ts");

  const registry = new SessionRevocationRegistry();
  const wallet = "GBZXN7PIRZGNMHGA728R374OXZW6W5Y45PNM26QCOHOHOGIPLDTZQK7U";
  const adminActor = { id: "sec-ops", permissions: new Set(["security:revoke"]) };

  const t0 = 100_000;
  const oldSessionIssuedAt = t0;

  // Initially valid
  assert.equal(registry.isRevoked(wallet, oldSessionIssuedAt, "nonce-1", t0 + 100).revoked, false);

  // Security event occurs at t0 + 5000 (key compromise)
  const securityEventTime = t0 + 5000;
  registry.recordSecurityEvent(
    {
      type: "wallet_compromise",
      targetSubject: wallet,
      reason: "Key compromised",
      revokedBefore: securityEventTime,
      actor: adminActor,
    },
    securityEventTime,
  );

  // Old session is now rejected
  const oldCheck = registry.isRevoked(wallet, oldSessionIssuedAt, "nonce-1", securityEventTime + 100);
  assert.equal(oldCheck.revoked, true);
  assert.equal(oldCheck.code, "subject_revoked_by_security_event");

  // Re-authenticated session issued after security event is accepted
  const newSessionIssuedAt = securityEventTime + 1000;
  const newCheck = registry.isRevoked(wallet, newSessionIssuedAt, "nonce-2", securityEventTime + 2000);
  assert.equal(newCheck.revoked, false);
});

await runAsyncTest("#1031 Global Emergency Cutoff & Nonce Invalidation", async () => {
  const { SessionRevocationRegistry } = await import("../server/src/services/sessionRevocationService.ts");

  const registry = new SessionRevocationRegistry();
  const adminActor = { id: "sec-ops", permissions: new Set(["admin"]) };
  const wallet1 = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GNOEDVLQC5WWXBXRXG2V";
  const wallet2 = "GBZXN7PIRZGNMHGA728R374OXZW6W5Y45PNM26QCOHOHOGIPLDTZQK7U";

  // Global cutoff
  registry.recordSecurityEvent(
    {
      type: "global_emergency_cutoff",
      targetSubject: "*",
      reason: "Root secret rotation",
      revokedBefore: 50_000,
      actor: adminActor,
    },
    50_000,
  );

  assert.equal(registry.isRevoked(wallet1, 40_000).revoked, true);
  assert.equal(registry.isRevoked(wallet2, 40_000).revoked, true);
  assert.equal(registry.isRevoked(wallet1, 60_000).revoked, false);
});

await runAsyncTest("#1031 Recovery & Rollback Path: Reinstate subject clears false alarm", async () => {
  const { SessionRevocationRegistry } = await import("../server/src/services/sessionRevocationService.ts");

  const registry = new SessionRevocationRegistry();
  const wallet = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GNOEDVLQC5WWXBXRXG2V";
  const adminActor = { id: "admin-1", permissions: new Set(["admin"]) };

  registry.recordSecurityEvent(
    {
      type: "suspicious_activity",
      targetSubject: wallet,
      reason: "Suspicious activity alert",
      revokedBefore: 50_000,
      actor: adminActor,
    },
    50_000,
  );

  assert.equal(registry.isRevoked(wallet, 40_000, "n1").revoked, true);

  // Reinstate subject
  const reinstated = registry.reinstateSubject(wallet, adminActor, "False positive alert");
  assert.equal(reinstated, true);

  // Session now valid again
  assert.equal(registry.isRevoked(wallet, 40_000, "n1").revoked, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Issue #1032: Deterministic Sorting for Mixed-Status Records and Events
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n--- Verifying Issue #1032: Deterministic Sorting ---");

await runAsyncTest("#1032 Total Order & Permutation Invariance: Mixed-status sorting is deterministic", async () => {
  const {
    sortMixedStatusRecords,
    computeSortedSequenceFingerprint,
    verifySortingInvariants,
  } = await import("../server/src/services/deterministicSorting.ts");

  const records = [
    { id: "p3", status: "retired", primaryKey: 100, secondaryKey: 1 },
    { id: "p1", status: "active", primaryKey: 100, secondaryKey: 2 },
    { id: "p2", status: "paused", primaryKey: 100, secondaryKey: 1 },
    { id: "p0", status: "active", primaryKey: 90, secondaryKey: 1 },
  ];

  const sorted = sortMixedStatusRecords(records);
  assert.equal(sorted[0].id, "p0"); // lowest primaryKey
  assert.equal(sorted[1].id, "p1"); // primaryKey 100, status active (rank 1)
  assert.equal(sorted[2].id, "p2"); // primaryKey 100, status paused (rank 3)
  assert.equal(sorted[3].id, "p3"); // primaryKey 100, status retired (rank 6)

  // Verify reverse invariance
  const sortedRev = sortMixedStatusRecords([...records].reverse());
  assert.equal(
    computeSortedSequenceFingerprint(sorted),
    computeSortedSequenceFingerprint(sortedRev),
  );

  const verification = verifySortingInvariants(records);
  assert.equal(verification.isTotalOrder, true);
  assert.equal(verification.isPermutationInvariant, true);
});

await runAsyncTest("#1032 Deterministic Pagination & Cursor Integrity: Zero drift and tamper detection", async () => {
  const {
    paginateMixedStatusRecords,
    decodeDeterministicCursor,
  } = await import("../server/src/services/deterministicSorting.ts");

  const secret = "cursor-secret-1032";
  const records = Array.from({ length: 9 }, (_, i) => ({
    id: `r_${i}`,
    status: i % 2 === 0 ? "active" : "paused",
    primaryKey: 100 + i * 10,
  }));

  const page1 = paginateMixedStatusRecords(records, { limit: 4, secret });
  assert.equal(page1.items.length, 4);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);

  const page2 = paginateMixedStatusRecords(records, { limit: 4, cursor: page1.nextCursor, secret });
  assert.equal(page2.items.length, 4);
  assert.equal(page2.hasMore, true);

  const page3 = paginateMixedStatusRecords(records, { limit: 4, cursor: page2.nextCursor, secret });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.hasMore, false);

  // Union check: 4 + 4 + 1 = 9 records, no duplicates
  const allIds = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
  assert.equal(allIds.length, 9);
  assert.equal(new Set(allIds).size, 9);

  // Tamper detection
  const validCursor = page1.nextCursor;
  const [p, s] = validCursor.split(".");
  const tampered = `${Buffer.from(JSON.stringify({ id: "hacked", primaryKey: 999 })).toString("base64url")}.${s}`;

  let tamperedCaught = false;
  try {
    decodeDeterministicCursor(tampered, secret);
  } catch (err) {
    tamperedCaught = true;
    assert.equal(err.code, "cursor_tampered");
  }
  assert.ok(tamperedCaught);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Issue #1033: Fixture Generators for Rare Failure and Recovery Paths
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n--- Verifying Issue #1033: Rare Failure Fixture Generators ---");

await runAsyncTest("#1033 Seedable Determinism & Soroban Timeout Scenario", async () => {
  const {
    generateSorobanTimeoutFixture,
    generateBadSequenceRecoveryFixture,
    generatePartialBulkRetireFixture,
    generateContentIntegrityTamperFixture,
    generateEventJournalGapFixture,
  } = await import("../server/src/services/rareFailureFixtureGenerator.ts");

  const f1 = generateSorobanTimeoutFixture(999);
  const f2 = generateSorobanTimeoutFixture(999);
  assert.equal(f1.fingerprint, f2.fingerprint);
  assert.deepEqual(f1.initialState, f2.initialState);

  // Soroban timeout recovery
  assert.equal(f1.simulatedFault.errorCode, "tx_too_late");
  assert.equal(f1.expectedRecovery.action, "RETRY");
  assert.ok(f1.expectedRecovery.assertFinalState(f1.expectedRecovery.expectedState));

  // Bad sequence recovery (tx_bad_seq)
  const fBadSeq = generateBadSequenceRecoveryFixture(101);
  assert.equal(fBadSeq.simulatedFault.errorCode, "tx_bad_seq");
  assert.equal(fBadSeq.expectedRecovery.action, "RESYNC");
  assert.ok(fBadSeq.expectedRecovery.assertFinalState(fBadSeq.expectedRecovery.expectedState));

  // Partial bulk retire failure (Soroban contract finality collision)
  const fBulk = generatePartialBulkRetireFixture(202);
  assert.equal(fBulk.simulatedFault.errorCode, "InvalidStatusTransition");
  assert.equal(fBulk.expectedRecovery.action, "ROLLBACK");
  assert.ok(fBulk.expectedRecovery.assertFinalState(fBulk.expectedRecovery.expectedState));

  // Content hash tamper detection
  const fTamper = generateContentIntegrityTamperFixture(303);
  assert.equal(fTamper.simulatedFault.errorCode, "ContentHashMismatch");
  assert.equal(fTamper.expectedRecovery.action, "QUARANTINE");
  assert.ok(fTamper.expectedRecovery.assertFinalState(fTamper.expectedRecovery.expectedState));

  // Event journal gap
  const fGap = generateEventJournalGapFixture(404);
  assert.equal(fGap.simulatedFault.errorCode, "LedgerSequenceGap");
  assert.equal(fGap.expectedRecovery.action, "RESYNC");
  assert.ok(fGap.expectedRecovery.assertFinalState(fGap.expectedRecovery.expectedState));
});

console.log("\n=================================================================");
console.log(`Verification Complete: ${passed} Passed, ${failed} Failed`);
console.log("=================================================================");
if (failed > 0) {
  process.exit(1);
}
