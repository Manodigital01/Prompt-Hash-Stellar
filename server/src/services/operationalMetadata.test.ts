import { describe, expect, it } from "vitest";
import {
  minimizeOperationalMetadata,
  OPERATIONAL_RETENTION_WINDOWS,
} from "./operationalMetadata";

describe("operational metadata minimization", () => {
  it("keeps only scalar operational identifiers and outcomes", () => {
    expect(
      minimizeOperationalMetadata({
        requestId: "req-1",
        status: "failed",
        durationMs: 42,
        nested: { prompt: "secret" },
        promptText: "private prompt",
        walletAddress: "G...",
      }),
    ).toEqual({ requestId: "req-1", status: "failed", durationMs: 42 });
  });

  it("has finite windows for operational data", () => {
    expect(OPERATIONAL_RETENTION_WINDOWS).toMatchObject({
      timelineEventsDays: 90,
      promptEventsDays: 30,
      exportMetadataDays: 30,
      supportEvidenceDays: 365,
    });
  });
});
