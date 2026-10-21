# Adaptive step-up verification (#901)

The risk scorer in `server/src/services/abuseRiskScoring.ts` decides whether a
high-impact operation needs more proof (`step_up`). This layer tracks where the
subject stands in that proof, so the guard can tell a first challenge apart
from an expired, failed, or locked verification.

Low-risk operations never reach this layer. Ordinary unlocks and purchases keep
their current behaviour, with no extra prompts and no state written.

Source: `server/src/services/stepUpVerification.ts`, and the `step_up` branch of
`server/src/middleware/abuseRiskGuard.ts`.

## States

| State      | Stored as                                  | Meaning                                        |
| ---------- | ------------------------------------------ | ---------------------------------------------- |
| none       | no record                                  | A challenge is required (`STEP_UP_REQUIRED`)   |
| verified   | `state: verified`, `expiresAt`             | Proof accepted; allowed until `expiresAt`      |
| expired    | `state: verified`, `expiresAt` passed      | Proof required again (`STEP_UP_EXPIRED`)       |
| failed     | `state: failed`, `failedAttempts`          | Proof rejected; retries remain (`STEP_UP_FAILED`) |
| locked     | `failed` with `lockedUntil`                | Refused until the lock ends (`STEP_UP_LOCKED`) |

## Constants

| Name                          | Value      | Meaning                                     |
| ----------------------------- | ---------- | ------------------------------------------- |
| `STEP_UP_VERIFIED_TTL_MS`     | 5 minutes  | How long a successful proof stays valid     |
| `STEP_UP_MAX_FAILED_ATTEMPTS` | 3          | Rejected proofs before the lock starts      |
| `STEP_UP_LOCKOUT_MS`          | 15 minutes | Length of the lock once the budget is spent |

## Enforcement rules

1. **Allowed means allowed.** A verified, unexpired record admits the operation
   without a fresh wallet session.
2. **A fresh wallet session verifies the subject.** This is the existing proof
   (`hasFreshWalletSession`). Acceptance clears the failure count.
3. **A presented but rejected proof spends one attempt.** A request counts as a
   proof attempt when it carries an `Authorization` header. A request without
   one is a challenge, not a failure.
4. **A lock is final for its window.** A locked subject is refused even with a
   valid proof, so the lock limits guessing and cannot be cleared by a correct
   answer during the lockout.
5. **A lapsed lock starts fresh.** When `lockedUntil` passes, the next proof
   gets a full attempt budget.

## Responses

Every denial is `403` and carries `code`, `attemptsRemaining`, `remedy`, plus
the existing `riskScore`, `summary`, and `reasons`. A locked response also
carries `lockedUntil` (ISO 8601).

| Code                  | When                                       | `attemptsRemaining` |
| --------------------- | ------------------------------------------ | ------------------- |
| `STEP_UP_REQUIRED`    | No record, or the lock has lapsed          | 3                   |
| `STEP_UP_EXPIRED`     | Verification window has passed             | 3                   |
| `STEP_UP_FAILED`      | Proof rejected, retries left               | 2 or 1              |
| `STEP_UP_LOCKED`      | Budget spent; lock still active            | 0                   |

## Audit actions

| Action             | Result    | When                                         |
| ------------------ | --------- | -------------------------------------------- |
| `step_up_verified` | `success` | A proof was accepted and the operation runs  |
| `step_up_failed`   | `blocked` | A presented proof was rejected               |
| `step_up_locked`   | `blocked` | A rejected proof spent the last attempt      |

Records are keyed by a hash of the wallet, the operation, and the target. The
raw wallet is never stored.

## Storage caveat

Records live in memory, per process, like the other abuse-risk stores. A
restart clears them, so every subject must verify again. That fails in the
safe direction for this control. The store is bounded (10,000 records by
default) and evicts the oldest entry first.

## Tests

`server/src/tests/stepUpVerification.test.ts` covers low risk (no step), high
risk with no proof, a fresh session, an open verified window, expiry, a
rejected proof, a successful retry after failure, and the lock with a valid
proof presented during it.
