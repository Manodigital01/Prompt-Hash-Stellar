import mongoose from "mongoose";

export const MAINTAINER_NOTE_TYPES = ["triage", "decision", "risk", "handoff"] as const;
export const MAINTAINER_NOTE_VISIBILITIES = ["private", "maintainers", "restricted"] as const;

export type MaintainerNoteType = (typeof MAINTAINER_NOTE_TYPES)[number];
export type MaintainerNoteVisibility = (typeof MAINTAINER_NOTE_VISIBILITIES)[number];

/**
 * Structured maintainer note on a subject such as a prompt or a support case (#903).
 *
 * Notes are never deleted through the API. Retention redacts the text and keeps
 * the author, timestamps, and `auditRefs`, so the record of what was written and
 * who touched it survives. `version` increments on each edit and gates concurrent
 * writes.
 */
const maintainerNoteSchema = new mongoose.Schema(
  {
    noteId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    subjectId: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: MAINTAINER_NOTE_TYPES as unknown as string[],
    },
    visibility: {
      type: String,
      required: true,
      enum: MAINTAINER_NOTE_VISIBILITIES as unknown as string[],
      default: "maintainers",
    },
    text: {
      type: String,
      default: "",
      maxLength: 2000,
    },
    author: {
      type: String,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    updatedBy: {
      type: String,
      required: true,
    },
    redactedAt: {
      type: Date,
      default: null,
    },
    redactedBy: {
      type: String,
      default: null,
    },
    redactionReason: {
      type: String,
      default: null,
      maxLength: 500,
    },
    archivedAt: {
      type: Date,
      default: null,
      index: true,
    },
    auditRefs: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

maintainerNoteSchema.index({ subjectId: 1, archivedAt: 1, createdAt: -1 });

const MaintainerNote =
  mongoose.models.MaintainerNote || mongoose.model("MaintainerNote", maintainerNoteSchema);

export default MaintainerNote;
