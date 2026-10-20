# Dry-Run Policy Evaluator with Affected-Record Previews (#1030)

Governance and operational policy changes in PromptHash Stellar affect prompt pricing, platform fees, seller status, and buyer access. Applying broad policy changes without pre-flight simulation risks unexpected financial disruptions or irreversible Soroban smart contract status transitions.

The Dry-Run Policy Evaluator (`server/src/services/dryRunPolicyEvaluator.ts`) provides a side-effect-free, bounded simulation engine that computes field-level diffs, flags irreversible state transitions, estimates total financial impacts (in XLM), and binds execution plans to an HMAC confirmation token.

---

## 1. Core Workflow

1. **Policy Specification**:
   An operator submits a policy definition declaring the target resource (`prompts`, `users`, `purchases`, `maintainer_grants`), matching predicates (`field`, `operator`, `value`), action type, and required permission.
2. **Permission Check**:
   The actor must possess explicit permissions (`policy:evaluate` or `admin`). Unauthorized actors are rejected before any records are scanned.
3. **Bounded Scan & Evaluation ($O(N)$ Time, $O(K)$ Space)**:
   Candidate records (up to `MAX_EVALUATION_RECORDS = 10,000`) are inspected. Predicates are evaluated in $O(1)$ time per record. Previews are capped to `MAX_PREVIEW_RECORDS = 100` to prevent memory blowup while preserving exact aggregate metrics.
4. **Impact Analysis & Finality Warnings**:
   - Diffs: Field-by-field before and after projections.
   - Financial Impact: Aggregate XLM volume / fee shift calculated across matching records.
   - Irreversibility: Transitions to `retired` status on Soroban are flagged as `isIrreversible: true` with `severity: "critical"`, alerting operators to smart contract finality constraints.
5. **HMAC Plan Confirmation Token**:
   The engine computes an HMAC-SHA256 signature over the policy ID, actor ID, affected record IDs (sorted), versions, and financial impact. If any record drifts before execution, the token becomes invalid.

---

## 2. Predicate Operators

| Operator | Supported Types | Description |
| :--- | :--- | :--- |
| `eq` / `ne` | string, number, boolean | Strict equality or inequality. |
| `gt` / `gte` | number | Numeric comparison (e.g. `priceXlm >= 100`). |
| `lt` / `lte` | number | Numeric comparison (e.g. `platformFeeBps < 200`). |
| `in` / `not_in` | Array | Set membership checks. |
| `contains` | string, Array | Substring containment or array element inclusion. |
| `regex` | string | Safe regex pattern evaluation. |

---

## 3. Irreversible Actions & Rollback Constraints

Certain Soroban contract actions cannot be reversed on the Stellar ledger:
- Transitioning a prompt to `PromptSaleStatus::Retired` is permanent (`ensure(prompt.status != PromptSaleStatus::Retired, Error::InvalidStatusTransition)`).
- The evaluator flags these transitions with `isIrreversible: true` and `severity: "critical"`.
- Operators must review the itemized previews before executing any plan bearing irreversible flags.

---

## 4. Operational Recovery & Failure Modes

- **Oversized Batches (`selection_too_large`)**:
  Requests exceeding 10,000 records are rejected to protect server event loops. Operators should paginate or partition policy evaluations.
- **Record State Drift (`confirmation_mismatch`)**:
  If a listing is updated or retired by a creator between the dry-run and execution, the confirmation token fails verification, preventing stale executions.
- **Read Retries**:
  Record loading handles transient database faults with exponential backoff before reporting evaluation results.
