import { describe, expect, it } from "vitest";
import {
  DISPUTE_WINDOW_MS,
  MAX_EVIDENCE_ITEMS,
  checkDisputeEligibility,
  checkDisputeTransition,
  isHoldActive,
  toDisputeView,
  validateDisputeReason,
  validateEvidence,
  type DisputeEligibilityInput,
  type DisputeRecordLike,
} from "../services/ownershipTransferDisputes";

/**
 * Ownership transfer dispute rules (#907). The rules module is pure, so these
 * tests cover eligibility, the state machine, the hold and evidence checks
 * without a database. The controllers wrap the same rules in compare-and-swap
 * writes.
 */

const FROM = "GFROMWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TO = "GTOWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function eligibility(overrides: Partial<DisputeEligibilityInput> = {}): DisputeEligibilityInput {
  return {
    transfer: { status: "approved", fromWallet: FROM, toWallet: TO, decidedAt: new Date(NOW - 2 * DAY) },
    filerWallet: FROM,
    hasOpenDispute: false,
    now: NOW,
    ...overrides,
  };
}

describe("checkDisputeEligibility (#907)", () => {
  it("allows a valid dispute from either party to an approved transfer", () => {
    expect(checkDisputeEligibility(eligibility())).toEqual({ ok: true });
    expect(checkDisputeEligibility(eligibility({ filerWallet: TO.toLowerCase() }))).toEqual({ ok: true });
  });

  it("refuses a transfer that is not approved", () => {
    for (const status of ["pending", "rejected", "cancelled", "expired"] as const) {
      const result = checkDisputeEligibility(
        eligibility({ transfer: { status, fromWallet: FROM, toWallet: TO, decidedAt: new Date(NOW) } }),
      );
      expect(result).toMatchObject({ ok: false, status: 409 });
    }
  });

  it("refuses a dispute from a wallet that is not a party to the transfer", () => {
    const result = checkDisputeEligibility(eligibility({ filerWallet: "GSTRANGERCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a second dispute while one is already open", () => {
    expect(checkDisputeEligibility(eligibility({ hasOpenDispute: true }))).toMatchObject({ ok: false, status: 409 });
  });

  it("closes the window after DISPUTE_WINDOW_MS and not before", () => {
    const atEdge = eligibility({
      transfer: { status: "approved", fromWallet: FROM, toWallet: TO, decidedAt: new Date(NOW - DISPUTE_WINDOW_MS) },
    });
    expect(checkDisputeEligibility(atEdge)).toEqual({ ok: true });

    const late = eligibility({
      transfer: { status: "approved", fromWallet: FROM, toWallet: TO, decidedAt: new Date(NOW - DISPUTE_WINDOW_MS - 1) },
    });
    expect(checkDisputeEligibility(late)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("window") });
  });

  it("refuses an approved transfer that has no approval time", () => {
    const result = checkDisputeEligibility(
      eligibility({ transfer: { status: "approved", fromWallet: FROM, toWallet: TO, decidedAt: null } }),
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});

describe("checkDisputeTransition (#907)", () => {
  it("lets the filer withdraw an open dispute", () => {
    expect(checkDisputeTransition("open", "withdraw", "filer")).toEqual({ ok: true });
  });

  it("lets a maintainer accept or reject an open dispute", () => {
    expect(checkDisputeTransition("open", "accept", "maintainer")).toEqual({ ok: true });
    expect(checkDisputeTransition("open", "reject", "maintainer")).toEqual({ ok: true });
  });

  it("keeps the decision with the right role", () => {
    expect(checkDisputeTransition("open", "accept", "filer")).toMatchObject({ ok: false, status: 403 });
    expect(checkDisputeTransition("open", "withdraw", "maintainer")).toMatchObject({ ok: false, status: 403 });
  });

  it("treats accepted, rejected and withdrawn as terminal", () => {
    expect(checkDisputeTransition("accepted", "reject", "maintainer")).toEqual({
      ok: false,
      status: 409,
      error: "Dispute is already accepted.",
    });
    expect(checkDisputeTransition("rejected", "accept", "maintainer")).toMatchObject({ ok: false, status: 409 });
    expect(checkDisputeTransition("withdrawn", "withdraw", "filer")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("hold behaviour (#907)", () => {
  it("holds the listing only while the dispute is open", () => {
    expect(isHoldActive("open")).toBe(true);
    expect(isHoldActive("accepted")).toBe(false);
    expect(isHoldActive("rejected")).toBe(false);
    expect(isHoldActive("withdrawn")).toBe(false);
  });
});

describe("dispute input validation (#907)", () => {
  it("requires a reason and trims it", () => {
    expect(validateDisputeReason("   ")).toMatchObject({ ok: false, status: 400 });
    expect(validateDisputeReason("x".repeat(1001))).toMatchObject({ ok: false, status: 400 });
    expect(validateDisputeReason("  I did not approve this  ")).toEqual({ ok: true, value: "I did not approve this" });
  });

  it("accepts evidence with an https link and trims the note", () => {
    expect(validateEvidence({ note: "  receipt  ", evidenceUrl: "https://example.com/receipt" }, 0)).toEqual({
      ok: true,
      note: "receipt",
      evidenceUrl: "https://example.com/receipt",
    });
    expect(validateEvidence({ note: "no link" }, 0)).toEqual({ ok: true, note: "no link", evidenceUrl: "" });
  });

  it("rejects non-https, malformed, and empty evidence", () => {
    expect(validateEvidence({ note: "x", evidenceUrl: "http://example.com" }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(validateEvidence({ note: "x", evidenceUrl: "not a url" }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(validateEvidence({ note: "  " }, 0)).toMatchObject({ ok: false, status: 400 });
  });

  it("caps the number of evidence items per dispute", () => {
    expect(validateEvidence({ note: "one more" }, MAX_EVIDENCE_ITEMS - 1)).toMatchObject({ ok: true });
    expect(validateEvidence({ note: "too many" }, MAX_EVIDENCE_ITEMS)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("toDisputeView (#907)", () => {
  const dispute: DisputeRecordLike = {
    _id: "d1",
    transferId: "t1",
    promptId: "1",
    fromWallet: FROM,
    toWallet: TO,
    filerWallet: FROM,
    status: "open",
    reason: "Transfer was made without my approval",
    evidence: [{ wallet: TO, role: "counterparty", note: "I was paid for it", evidenceUrl: "", submittedAt: new Date(NOW) }],
    createdAt: new Date(NOW),
  };

  it("shows parties the state and the hold, without the other side's identity", () => {
    const view = toDisputeView(dispute, "party");

    expect(view).toMatchObject({ id: "d1", status: "open", holdActive: true });
    expect(view.statusLabel).toContain("on hold");
    expect(view).not.toHaveProperty("filerWallet");
    expect(view.evidence[0]).not.toHaveProperty("wallet");
  });

  it("shows maintainers who filed, who submitted each item, and who decided", () => {
    const view = toDisputeView({ ...dispute, status: "accepted", resolvedBy: "ops-sec-lead" }, "maintainer");

    expect(view).toMatchObject({ status: "accepted", holdActive: false, filerWallet: FROM, resolvedBy: "ops-sec-lead" });
    expect(view.evidence[0]).toMatchObject({ wallet: TO });
  });
});
