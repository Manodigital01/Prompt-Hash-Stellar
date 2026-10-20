import { createHash } from "node:crypto";
import SupportCaseTimelineEvent, {
  type SupportCaseEventType,
  type SupportCaseEventVisibility,
} from "../models/SupportCaseTimelineEvent.js";
import { canonicalJson } from "./canonicalSerialization.js";

const GENESIS = "0".repeat(64);

export function computeSupportCaseEventHash(input: {
  caseId: string; sequence: number; type: SupportCaseEventType;
  visibility: SupportCaseEventVisibility; actor: string; actorType: string;
  payload: Record<string, unknown>; previousHash: string; createdAt: Date;
}): string {
  return createHash("sha256").update(canonicalJson({ ...input, createdAt: input.createdAt.toISOString() })).digest("hex");
}

export class SupportCaseTimelineService {
  static async append(input: {
    caseId: string; type: SupportCaseEventType; visibility?: SupportCaseEventVisibility;
    actor: string; actorType?: "user" | "maintainer" | "system"; payload?: Record<string, unknown>;
  }) {
    const last = await SupportCaseTimelineEvent.findOne({ caseId: input.caseId }).sort({ sequence: -1 }).lean();
    const sequence = (last?.sequence ?? -1) + 1;
    const createdAt = new Date();
    const previousHash = last?.eventHash ?? GENESIS;
    const visibility = input.visibility ?? "user";
    const actorType = input.actorType ?? "system";
    const payload = input.payload ?? {};
    const eventHash = computeSupportCaseEventHash({ caseId: input.caseId, sequence, type: input.type, visibility, actor: input.actor, actorType, payload, previousHash, createdAt });
    return SupportCaseTimelineEvent.create({ caseId: input.caseId, sequence, type: input.type, visibility, actor: input.actor, actorType, payload, previousHash, eventHash, createdAt });
  }

  static async list(caseId: string, includePrivate = false) {
    const query: Record<string, unknown> = { caseId };
    if (!includePrivate) query.visibility = "user";
    return SupportCaseTimelineEvent.find(query).sort({ sequence: 1 }).lean();
  }

  static async verify(caseId: string) {
    const events = await this.list(caseId, true);
    let previousHash = GENESIS;
    for (const event of events) {
      const expected = computeSupportCaseEventHash({ caseId: String(event.caseId), sequence: event.sequence, type: event.type, visibility: event.visibility, actor: event.actor, actorType: event.actorType, payload: event.payload, previousHash, createdAt: new Date(event.createdAt) });
      if (event.previousHash !== previousHash || event.eventHash !== expected) return { valid: false, failedSequence: event.sequence };
      previousHash = event.eventHash;
    }
    return { valid: true, count: events.length, head: previousHash };
  }
}

export const supportCaseTimelineService = SupportCaseTimelineService;
