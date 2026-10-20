import mongoose from "mongoose";

export type SupportCaseEventType =
  | "status"
  | "note"
  | "evidence"
  | "escalation"
  | "resolution";
export type SupportCaseEventVisibility = "user" | "private";

export interface ISupportCaseTimelineEvent extends mongoose.Document {
  caseId: mongoose.Types.ObjectId;
  sequence: number;
  type: SupportCaseEventType;
  visibility: SupportCaseEventVisibility;
  actor: string;
  actorType: "user" | "maintainer" | "system";
  payload: Record<string, unknown>;
  previousHash: string;
  eventHash: string;
  createdAt: Date;
}

const schema = new mongoose.Schema<ISupportCaseTimelineEvent>(
  {
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "SupportCase", required: true, index: true },
    sequence: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ["status", "note", "evidence", "escalation", "resolution"], required: true },
    visibility: { type: String, enum: ["user", "private"], required: true },
    actor: { type: String, required: true },
    actorType: { type: String, enum: ["user", "maintainer", "system"], required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    previousHash: { type: String, required: true },
    eventHash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ caseId: 1, sequence: 1 }, { unique: true });
schema.index({ caseId: 1, createdAt: 1 });
schema.pre("findOneAndUpdate", function () { throw new Error("Support case timeline events are immutable."); });
schema.pre("updateOne", function () { throw new Error("Support case timeline events are immutable."); });
schema.pre("updateMany", function () { throw new Error("Support case timeline events are immutable."); });

const SupportCaseTimelineEvent = mongoose.models.SupportCaseTimelineEvent ||
  mongoose.model<ISupportCaseTimelineEvent>("SupportCaseTimelineEvent", schema);

export default SupportCaseTimelineEvent;
