/**
 * Fixture Generators for Rare Failure and Recovery Paths (#1033).
 *
 * Generates deterministic, seedable test fixtures and execution harnesses
 * for low-frequency operational failures on Stellar and Soroban:
 *   1. Soroban RPC Timeout & Ledger Expiry (TRY_AGAIN_LATER, tx_too_late)
 *   2. Account Sequence Desynchronization (tx_bad_seq)
 *   3. Irreversible Smart Contract Finality Conflicts (InvalidStatusTransition)
 *   4. Content Hash Integrity Tampering (ContentHashMismatch)
 *   5. Event Journal Ledger Sequence Gaps & Fork Divergence
 *   6. Security Event Token Invalidation Mid-Transaction
 *
 * Space & Time Complexity:
 *   - Generation Time: O(N) where N is number of scenario records.
 *   - Execution / Simulation Time: O(1) per scenario assertion.
 *   - Space: O(N) bounded memory per fixture payload.
 */

import { createHash } from "crypto";

export type RareFailureScenarioType =
  | "soroban_rpc_timeout"
  | "stellar_bad_sequence"
  | "partial_bulk_finality_collision"
  | "content_hash_tamper"
  | "event_journal_gap"
  | "security_revocation_race";

export type RecoveryAction =
  | "RETRY"
  | "ROLLBACK"
  | "QUARANTINE"
  | "RESYNC"
  | "MANUAL_INTERVENTION";

export interface SimulatedFaultDefinition<TError = unknown> {
  step: string;
  errorCode: string;
  errorDetails: TError;
  canRetry: boolean;
  maxAttempts: number;
}

export interface ExpectedRecoveryDefinition<TFinalState = unknown> {
  action: RecoveryAction;
  compensationSteps: string[];
  expectedState: TFinalState;
  assertFinalState: (actualState: TFinalState) => boolean;
}

export interface RareFailureFixture<TInitial, TError, TFinal> {
  fixtureId: string;
  scenarioType: RareFailureScenarioType;
  seed: number;
  description: string;
  initialState: TInitial;
  simulatedFault: SimulatedFaultDefinition<TError>;
  expectedRecovery: ExpectedRecoveryDefinition<TFinal>;
  fingerprint: string;
}

/**
 * Seedable PRNG (mulberry32) returning floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates an SHA-256 fingerprint of fixture parameters for reproducibility tracking.
 */
function computeFixtureFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ─── Scenario 1: Soroban RPC Congestion & tx_too_late ───────────────────────

export interface SorobanTimeoutInitialState {
  promptId: string;
  buyerAddress: string;
  priceXlm: number;
  initialLedger: number;
  maxLedgerBound: number;
}

export interface SorobanTimeoutFinalState {
  operationStatus: "CONFIRMED";
  confirmedLedger: number;
  attemptsCount: number;
  txHash: string;
}

export function generateSorobanTimeoutFixture(
  seed: number,
  options?: Partial<SorobanTimeoutInitialState>,
): RareFailureFixture<SorobanTimeoutInitialState, { rpcStatus: string; coreCode: string }, SorobanTimeoutFinalState> {
  const prng = mulberry32(seed);
  const initialLedger = options?.initialLedger ?? 50_000_000 + Math.floor(prng() * 100_000);
  const maxLedgerBound = initialLedger + 5; // tight bound to trigger timeout

  const initialState: SorobanTimeoutInitialState = {
    promptId: options?.promptId ?? `prompt_${Math.floor(prng() * 9999)}`,
    buyerAddress: options?.buyerAddress ?? "GBZXN7PIRZGNMHGA728R374OXZW6W5Y45PNM26QCOHOHOGIPLDTZQK7U",
    priceXlm: options?.priceXlm ?? 50,
    initialLedger,
    maxLedgerBound,
  };

  const expectedFinalLedger = initialLedger + 8;
  const expectedTxHash = createHash("sha256").update(`tx_${seed}_${expectedFinalLedger}`).digest("hex");

  return {
    fixtureId: `fx_soroban_timeout_${seed}`,
    scenarioType: "soroban_rpc_timeout",
    seed,
    description: "Soroban RPC responds with TRY_AGAIN_LATER followed by tx_too_late; recovery re-simulates and extends ledger bounds.",
    initialState,
    simulatedFault: {
      step: "sendTransaction",
      errorCode: "tx_too_late",
      errorDetails: {
        rpcStatus: "TRY_AGAIN_LATER",
        coreCode: "tx_too_late",
      },
      canRetry: true,
      maxAttempts: 3,
    },
    expectedRecovery: {
      action: "RETRY",
      compensationSteps: [
        "query_latest_ledger_sequence",
        "re_simulate_soroban_footprint",
        "extend_max_ledger_bounds",
        "re_sign_and_broadcast",
      ],
      expectedState: {
        operationStatus: "CONFIRMED",
        confirmedLedger: expectedFinalLedger,
        attemptsCount: 2,
        txHash: expectedTxHash,
      },
      assertFinalState: (state) =>
        state.operationStatus === "CONFIRMED" &&
        state.confirmedLedger > initialState.maxLedgerBound &&
        state.attemptsCount > 1,
    },
    fingerprint: computeFixtureFingerprint({ seed, initialState }),
  };
}

// ─── Scenario 2: Stellar Account Sequence Desynchronization (tx_bad_seq) ───

export interface BadSequenceInitialState {
  sourceAccount: string;
  cachedSequence: string;
  actualNetworkSequence: string;
}

export interface BadSequenceFinalState {
  resyncedSequence: string;
  txCommitted: boolean;
  resyncAttempts: number;
}

export function generateBadSequenceRecoveryFixture(
  seed: number,
): RareFailureFixture<BadSequenceInitialState, { resultXdrCode: string }, BadSequenceFinalState> {
  const prng = mulberry32(seed);
  const baseSeq = 100_000_000n + BigInt(Math.floor(prng() * 100_000));
  const cachedSequence = baseSeq.toString();
  const actualNetworkSequence = (baseSeq + 2n).toString(); // out of sync by 2

  const initialState: BadSequenceInitialState = {
    sourceAccount: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GNOEDVLQC5WWXBXRXG2V",
    cachedSequence,
    actualNetworkSequence,
  };

  const nextValidSequence = (baseSeq + 3n).toString();

  return {
    fixtureId: `fx_bad_seq_${seed}`,
    scenarioType: "stellar_bad_sequence",
    seed,
    description: "Concurrent client submissions trigger tx_bad_seq; recovery queries Horizon to refresh sequence and re-submits.",
    initialState,
    simulatedFault: {
      step: "submitTransaction",
      errorCode: "tx_bad_seq",
      errorDetails: {
        resultXdrCode: "tx_bad_seq",
      },
      canRetry: true,
      maxAttempts: 2,
    },
    expectedRecovery: {
      action: "RESYNC",
      compensationSteps: [
        "fetch_account_sequence_from_network",
        "rebuild_transaction_with_incremented_sequence",
        "re_sign_transaction",
        "re_submit_transaction",
      ],
      expectedState: {
        resyncedSequence: nextValidSequence,
        txCommitted: true,
        resyncAttempts: 1,
      },
      assertFinalState: (state) =>
        state.txCommitted === true && BigInt(state.resyncedSequence) > BigInt(initialState.cachedSequence),
    },
    fingerprint: computeFixtureFingerprint({ seed, initialState }),
  };
}

// ─── Scenario 3: Irreversible Smart Contract Finality Collision ─────────────

export interface PartialBulkInitialState {
  creatorAddress: string;
  batchPromptIds: string[];
  alreadyRetiredPromptId: string;
}

export interface PartialBulkFinalState {
  succeededCount: number;
  failedCount: number;
  itemizedFailures: Array<{ promptId: string; error: string; isIrreversible: boolean }>;
}

export function generatePartialBulkRetireFixture(
  seed: number,
): RareFailureFixture<PartialBulkInitialState, { contractError: string }, PartialBulkFinalState> {
  const prng = mulberry32(seed);
  const batchPromptIds = [
    `prompt_active_1_${seed}`,
    `prompt_already_retired_${seed}`,
    `prompt_active_2_${seed}`,
  ];
  const alreadyRetiredPromptId = batchPromptIds[1];

  const initialState: PartialBulkInitialState = {
    creatorAddress: "GCREATOR111111111111111111111111111111111111111111111111111",
    batchPromptIds,
    alreadyRetiredPromptId,
  };

  return {
    fixtureId: `fx_bulk_finality_${seed}`,
    scenarioType: "partial_bulk_finality_collision",
    seed,
    description: "Bulk retire attempts to retire an already-retired prompt; Soroban throws InvalidStatusTransition.",
    initialState,
    simulatedFault: {
      step: "set_prompt_sale_status",
      errorCode: "InvalidStatusTransition",
      errorDetails: {
        contractError: "ensure(prompt.status != PromptSaleStatus::Retired, Error::InvalidStatusTransition)",
      },
      canRetry: false,
      maxAttempts: 1,
    },
    expectedRecovery: {
      action: "ROLLBACK",
      compensationSteps: [
        "isolate_failed_prompt_id",
        "record_itemized_failure_diagnostics",
        "allow_unaffected_prompts_to_commit",
        "render_creator_ledger_finality_warning",
      ],
      expectedState: {
        succeededCount: 2,
        failedCount: 1,
        itemizedFailures: [
          {
            promptId: alreadyRetiredPromptId,
            error: "Prompt is already retired on Soroban ledger; status change is irreversible.",
            isIrreversible: true,
          },
        ],
      },
      assertFinalState: (state) =>
        state.succeededCount === 2 &&
        state.failedCount === 1 &&
        state.itemizedFailures[0]?.isIrreversible === true,
    },
    fingerprint: computeFixtureFingerprint({ seed, initialState }),
  };
}

// ─── Scenario 4: Encrypted Content Integrity Hash Tampering ─────────────────

export interface ContentTamperInitialState {
  promptId: string;
  expectedContentHashHex: string;
  corruptedCiphertextHex: string;
}

export interface ContentTamperFinalState {
  quarantined: boolean;
  plaintextDelivered: boolean;
  auditSecurityAlertEmitted: boolean;
}

export function generateContentIntegrityTamperFixture(
  seed: number,
): RareFailureFixture<ContentTamperInitialState, { check: string }, ContentTamperFinalState> {
  const authenticPayload = `Authentic AI Prompt Template Data #${seed}`;
  const authenticHash = createHash("sha256").update(authenticPayload).digest("hex");
  const corruptedPayload = `${authenticPayload} [TAMPERED_BYTE]`;
  const corruptedCiphertextHex = Buffer.from(corruptedPayload, "utf8").toString("hex");

  const initialState: ContentTamperInitialState = {
    promptId: `prompt_encrypted_${seed}`,
    expectedContentHashHex: authenticHash,
    corruptedCiphertextHex,
  };

  return {
    fixtureId: `fx_content_tamper_${seed}`,
    scenarioType: "content_hash_tamper",
    seed,
    description: "Unlock flow decrypts ciphertext whose hash fails on-chain integrity check; service refuses delivery and quarantines.",
    initialState,
    simulatedFault: {
      step: "verifyContentHash",
      errorCode: "ContentHashMismatch",
      errorDetails: {
        check: "computedHash !== storedContractHash",
      },
      canRetry: false,
      maxAttempts: 1,
    },
    expectedRecovery: {
      action: "QUARANTINE",
      compensationSteps: [
        "halt_plaintext_return",
        "emit_quarantine_event_to_journal",
        "flag_creator_listing_for_moderation",
        "log_forensic_integrity_alert",
      ],
      expectedState: {
        quarantined: true,
        plaintextDelivered: false,
        auditSecurityAlertEmitted: true,
      },
      assertFinalState: (state) =>
        state.quarantined === true && state.plaintextDelivered === false && state.auditSecurityAlertEmitted === true,
    },
    fingerprint: computeFixtureFingerprint({ seed, initialState }),
  };
}

// ─── Scenario 5: Event Journal Ledger Gap & Reorg Recovery ──────────────────

export interface EventJournalGapInitialState {
  lastProcessedLedger: number;
  incomingLedger: number;
  gapSize: number;
}

export interface EventJournalGapFinalState {
  backfillTriggered: boolean;
  gapsFilledCount: number;
  resumedLedger: number;
}

export function generateEventJournalGapFixture(
  seed: number,
): RareFailureFixture<EventJournalGapInitialState, { missingLedgers: number[] }, EventJournalGapFinalState> {
  const prng = mulberry32(seed);
  const lastProcessedLedger = 10_000 + Math.floor(prng() * 5_000);
  const gapSize = 3;
  const incomingLedger = lastProcessedLedger + gapSize + 1; // missing gapSize ledgers

  const missingLedgers: number[] = [];
  for (let i = 1; i <= gapSize; i++) {
    missingLedgers.push(lastProcessedLedger + i);
  }

  const initialState: EventJournalGapInitialState = {
    lastProcessedLedger,
    incomingLedger,
    gapSize,
  };

  return {
    fixtureId: `fx_event_gap_${seed}`,
    scenarioType: "event_journal_gap",
    seed,
    description: "Indexer detects sequence gap in ledger journal; halts cursor advancement and schedules backfill.",
    initialState,
    simulatedFault: {
      step: "validateSequenceContinuity",
      errorCode: "LedgerSequenceGap",
      errorDetails: { missingLedgers },
      canRetry: true,
      maxAttempts: 3,
    },
    expectedRecovery: {
      action: "RESYNC",
      compensationSteps: [
        "pause_live_projection_cursor",
        "queue_targeted_backfill_job",
        "replay_missing_events_in_total_order",
        "resume_live_indexer_cursor",
      ],
      expectedState: {
        backfillTriggered: true,
        gapsFilledCount: gapSize,
        resumedLedger: incomingLedger,
      },
      assertFinalState: (state) =>
        state.backfillTriggered === true &&
        state.gapsFilledCount === gapSize &&
        state.resumedLedger === incomingLedger,
    },
    fingerprint: computeFixtureFingerprint({ seed, initialState }),
  };
}
