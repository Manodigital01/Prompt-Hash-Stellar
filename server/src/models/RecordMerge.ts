import mongoose from "mongoose";

export const RECORD_MERGE_STATUSES = ["pending", "committed", "failed"] as const;

export type RecordMergeStatus = (typeof RECORD_MERGE_STATUSES)[number];

/**
 * Persisted record of one duplicate-record merge (#902).
 *
 * `pending` is written before any content moves, so a crash leaves evidence.
 * `committed` means the source now redirects to `targetId`. A failed write
 * leaves `failed` with the reason. `snapshot` holds the pre-merge state of both
 * records, and `rollbackNotes` says how to undo the merge.
 */
const recordMergeSchema = new mongoose.Schema(
  {
    mergeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    sourceId: {
      type: String,
      required: true,
      index: true,
    },
    targetId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: RECORD_MERGE_STATUSES as unknown as string[],
      default: "pending",
      index: true,
    },
    planHash: {
      type: String,
      required: true,
    },
    resolutions: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    mergedFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    rollbackNotes: {
      type: String,
      required: true,
    },
    failureReason: {
      type: String,
      default: null,
    },
    actor: {
      type: String,
      required: true,
    },
    requestId: {
      type: String,
      default: null,
    },
    createdAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false },
);

// Redirect lookups read committed merges by source.
recordMergeSchema.index({ sourceId: 1, status: 1 });

const RecordMerge =
  mongoose.models.RecordMerge || mongoose.model("RecordMerge", recordMergeSchema);

export default RecordMerge;
