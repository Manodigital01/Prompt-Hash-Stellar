# Ownership transfer disputes (#907)

An approved ownership transfer (see [`transfer-recovery.md`](transfer-recovery.md)
and `server/src/controllers/transferControllers.ts`) can be contested. A dispute
puts the listing on hold until a maintainer accepts it (the listing goes back to
the previous owner) or rejects it (the transfer stands).

The rules are in `server/src/services/ownershipTransferDisputes.ts`. The
controllers are in `server/src/controllers/ownershipDisputeControllers.ts`.

## Who can dispute, and when

- Either party to an **approved** transfer can open a dispute.
- It must be opened within **14 days** of the transfer's approval.
- Only one **open** dispute can exist per transfer. A partial unique index enforces this.
- A transfer that is pending, rejected, cancelled or expired cannot be disputed.
- A wallet that is not a party to the transfer is refused (`403`).

## States

```
open ──withdraw (filer)──────────▶ withdrawn   transfer stands
  │
  ├──accept (maintainer)─────────▶ accepted    listing reverted to the previous owner
  └──reject (maintainer)─────────▶ rejected    transfer stands
```

`accepted`, `rejected` and `withdrawn` are terminal.

## Hold

While a dispute is `open`, the listing is on hold: `POST /api/prompts/transfers/request`
returns `423` for that prompt, so the contested owner cannot be moved again
before a decision. The hold ends when the dispute leaves `open`.

## Evidence

Either party can add up to 10 evidence items while the dispute is open: a note
(up to 2000 characters) and an optional `https` link (up to 500 characters).
Items are never edited or removed. Each one is audited.

## Resolution

A maintainer calls `POST /api/admin/ownership-disputes/:disputeId/resolve` with
`{ "action": "accept" | "reject", "notes": "..." }`. The token needs the
`disputes:resolve` scope. Notes are required.

On **accept**, the decision is claimed first (a compare-and-swap on `open`).
Then `Prompt.owner` is reverted, but only if the recipient still owns the
listing. If the reversal cannot be applied, the dispute goes back to `open`
and the request returns `409` with the reason. The listing is never left
half-reverted.

## Endpoints

| Method and path | Who | Purpose |
| --- | --- | --- |
| `POST /api/prompts/transfers/:transferId/disputes` | Party (wallet session) | Open a dispute |
| `GET /api/prompts/transfers/disputes/:disputeId?walletAddress=` | Party (wallet session) | View state and evidence |
| `POST /api/prompts/transfers/disputes/:disputeId/evidence` | Party (wallet session) | Add evidence |
| `POST /api/prompts/transfers/disputes/:disputeId/withdraw` | Filer (wallet session) | Withdraw |
| `POST /api/admin/ownership-disputes/:disputeId/resolve` | Maintainer (`disputes:resolve`) | Accept or reject |

Parties see the status, the hold and the evidence. Maintainers also see who
filed and who decided.

## Audit

Every transition is recorded in the audit log:
`ownership_dispute_opened`, `ownership_dispute_evidence_added`,
`ownership_dispute_withdrawn`, `ownership_dispute_accepted`,
`ownership_dispute_rejected`.

## Tests

- `server/src/tests/ownershipTransferDispute.test.ts`: eligibility, transitions,
  hold, evidence validation and the party and maintainer views.
- `server/src/tests/ownershipTransfer.test.ts`: a new transfer request is refused
  with `423` while a dispute is open.
