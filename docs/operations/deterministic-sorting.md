# Deterministic Sorting for Mixed-Status Records and Events (#1032)

In distributed blockchain architectures like PromptHash Stellar, records and events frequently exist in heterogeneous lifecycle states simultaneously:
- **Listing Prompts**: `active`, `pending`, `paused`, `flagged`, `quarantined`, `retired`
- **Ledger Events**: `committed`, `replayed`, `pending`, `quarantined`, `dlq`, `rolled_back`
- **Maintainer Grants**: `active`, `pending`, `expired`, `revoked`

When querying, projecting, or paginating over mixed-status collections, ambiguous ordering and tie-breaking inconsistencies cause cursor drift, duplicate items, or skipped records across page boundaries.

The Deterministic Sorting Engine (`server/src/services/deterministicSorting.ts`) provides a mathematically guaranteed total ordering mechanism with tamper-evident HMAC cursors.

---

## 1. Mathematical Total Order Guarantee

For any two distinct records $A$ and $B$, the comparator guarantees:
1. **Antisymmetry**: If $A < B$, then $B > A$.
2. **Transitivity**: If $A \le B$ and $B \le C$, then $A \le C$.
3. **Totality / Strict Tie-Breaking**: No two records with different IDs ever evaluate as equal ($cmp(A, B) \ne 0$).

### Multi-Tier Comparator Sequence
```
1. Primary Metric (Ledger Sequence / Timestamp) [or Status Rank if groupByStatus is enabled]
2. Status Precedence Rank (Canonical hierarchy lookup)
3. Secondary Sequence Metric (txIndex / version)
4. Ultimate Immutable Tie-Breaker (Lexicographic comparison of unique ID)
```

---

## 2. Canonical Status Precedence

Precedence maps assign a stable integer rank to each lifecycle status:

| Resource | Status Precedence Hierarchy |
| :--- | :--- |
| **Prompts** | `active` (1) > `pending` (2) > `paused` (3) > `flagged` (4) > `quarantined` (5) > `retired` (6) |
| **Events** | `committed` (1) > `replayed` (2) > `pending` (3) > `quarantined` (4) > `dlq` (5) > `rolled_back` (6) |
| **Grants** | `active` (1) > `pending` (2) > `expired` (3) > `revoked` (4) |

---

## 3. Tamper-Evident Pagination Cursors

Pagination cursors are encoded as signed base64url strings:
- **Payload**: `{ statusRank, primaryKey, secondaryKey, id }`
- **Integrity**: HMAC-SHA256 signature generated with server cursor secret.
- **Drift Resistance**: Because the cursor embeds the exact sort coordinates rather than an ephemeral offset, inserting or updating records concurrently does not skip items or return duplicates.

---

## 4. Verification & Permutation Invariance

The utility `verifySortingInvariants` tests that:
- Any permutation of input records (original, reversed, seeded shuffle) produces the **identical** sorted sequence and SHA-256 fingerprint.
- Multi-page pagination across the entire collection has zero duplicates and zero missing items.
