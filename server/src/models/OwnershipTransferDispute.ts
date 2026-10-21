import mongoose from "mongoose";
import { DISPUTE_STATUSES } from "../services/ownershipTransferDisputes";

/**
 * Dispute against an approved ownership transfer (#907).
 *
 * State rules live in services/ownershipTransferDisputes.ts. The partial
 * unique index allows one OPEN dispute per transfer; a second concurrent open
 * fails with a duplicate-key error, which the controller reports as a conflict.
 */
const evidenceSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, lowercase: true },
    role: { type: String, enum: ["filer", "counterparty"], required: true },
    note: { type: String, required: true },
    evidenceUrl: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ownershipTransferDisputeSchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, index: true },
    promptId: { type: String, required: true, index: true },
    fromWallet: { type: String, required: true, lowercase: true },
    toWallet: { type: String, required: true, lowercase: true },
    filerWallet: { type: String, required: true, lowercase: true },
    status: { type: String, enum: DISPUTE_STATUSES, default: "open", index: true },
    reason: { type: String, required: true },
    evidence: { type: [evidenceSchema], default: [] },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ownershipTransferDisputeSchema.index(
  { transferId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);

const OwnershipTransferDispute =
  mongoose.models.OwnershipTransferDispute ||
  mongoose.model("OwnershipTransferDispute", ownershipTransferDisputeSchema);

export default OwnershipTransferDispute;
