import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Structured maintainer notes (#903).
 *
 * Pure tests cover validation, visibility, edit, redaction, archive, and
 * retention. IO tests use a mocked model and audit trail to check that evidence
 * is written first, that stale edits are refused, and that hidden notes do not
 * leak through reads.
 */

vi.mock("../services/auditTrail", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../models/MaintainerNote", () => ({
  default: {
    create: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  MAINTAINER_NOTE_TYPES: ["triage", "decision", "risk", "handoff"],
  MAINTAINER_NOTE_VISIBILITIES: ["private", "maintainers", "restricted"],
}));

import MaintainerNote from "../models/MaintainerNote";
import { recordAuditEvent } from "../services/auditTrail";
import {
  MAINTAINER_NOTE_MAX_LENGTH,
  MaintainerNoteError,
  applyNoteArchive,
  applyNoteEdit,
  applyNoteRedaction,
  buildRetentionReport,
  canViewNote,
  createMaintainerNote,
  editMaintainerNote,
  listVisibleMaintainerNotes,
  noteRetentionStatus,
  toNoteView,
  validateNoteInput,
  type NoteRecord,
} from "../services/maintainerNotes";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const READ = "maintainer_notes:read";
const WRITE = "maintainer_notes:write";
const RESTRICTED = "maintainer_notes:restricted";

function makeNote(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    noteId: "mnt_1",
    subjectId: "prompt-1",
    type: "triage",
    visibility: "maintainers",
    text: "Duplicate of prompt-2, check pricing.",
    author: "maint-ann",
    version: 1,
    updatedBy: "maint-ann",
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    updatedAt: new Date(NOW.getTime() - 10 * DAY),
    redactedAt: null,
    redactedBy: null,
    redactionReason: null,
    archivedAt: null,
    auditRefs: ["maudit_created"],
    ...overrides,
  };
}

const ann = { sub: "maint-ann", scopes: [READ, WRITE] };
const bob = { sub: "maint-bob", scopes: [READ, WRITE] };
const auditor = { sub: "auditor-1", scopes: [READ, RESTRICTED] };

/** Returns the MaintainerNoteError code thrown by `fn`, or undefined if it did not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as MaintainerNoteError).code;
  }
  return undefined;
}

describe("validateNoteInput", () => {
  it("accepts a known type and defaults visibility to maintainers", () => {
    expect(validateNoteInput({ type: "risk", text: "  check the payout  " })).toEqual({
      type: "risk",
      visibility: "maintainers",
      text: "check the payout",
    });
  });

  it("rejects unknown types, unknown visibility, empty text, and over-long text", () => {
    expect(codeOf(() => validateNoteInput({ type: "gossip", text: "x" }))).toBe("invalid_type");
    expect(codeOf(() => validateNoteInput({ type: "risk", text: "x", visibility: "public" }))).toBe(
      "invalid_visibility",
    );
    expect(codeOf(() => validateNoteInput({ type: "risk", text: "   " }))).toBe("invalid_text");
    expect(
      codeOf(() => validateNoteInput({ type: "risk", text: "x".repeat(MAINTAINER_NOTE_MAX_LENGTH + 1) })),
    ).toBe("invalid_text");
  });
});

describe("canViewNote", () => {
  it("lets the author see their own private note", () => {
    expect(canViewNote(makeNote({ visibility: "private" }), ann)).toBe(true);
  });

  it("hides a private note from everyone else, even with every scope", () => {
    const everything = { sub: "maint-bob", scopes: [READ, WRITE, RESTRICTED] };
    expect(canViewNote(makeNote({ visibility: "private" }), everything)).toBe(false);
  });

  it("shows maintainer notes to any caller holding the read scope", () => {
    expect(canViewNote(makeNote({ visibility: "maintainers" }), bob)).toBe(true);
    expect(canViewNote(makeNote({ visibility: "maintainers" }), { sub: "x", scopes: [WRITE] })).toBe(false);
  });

  it("requires the restricted scope for restricted notes, not just read", () => {
    const note = makeNote({ visibility: "restricted" });
    expect(canViewNote(note, bob)).toBe(false);
    expect(canViewNote(note, auditor)).toBe(true);
  });
});

describe("toNoteView", () => {
  it("removes text from a redacted note but keeps the author and audit references", () => {
    const redacted = applyNoteRedaction(
      makeNote(),
      "Contained personal data in the note text.",
      "auditor-1",
      NOW,
      "maudit_redact",
    );
    const view = toNoteView(redacted);

    expect(view).toMatchObject({
      redacted: true,
      text: null,
      author: "maint-ann",
      auditRefs: ["maudit_created", "maudit_redact"],
    });
  });
});

describe("edit, redact and archive transitions", () => {
  it("lets the author edit, bumping the version and recording the audit reference", () => {
    const next = applyNoteEdit(makeNote(), { text: "Updated triage notes." }, "maint-ann", NOW, "maudit_edit");
    expect(next).toMatchObject({ text: "Updated triage notes.", version: 2, updatedBy: "maint-ann" });
    expect(next.auditRefs).toEqual(["maudit_created", "maudit_edit"]);
  });

  it("refuses an edit from anyone but the author", () => {
    expect(codeOf(() => applyNoteEdit(makeNote(), { text: "hi" }, "maint-bob", NOW, "x"))).toBe("not_author");
  });

  it("refuses edits to redacted or archived notes", () => {
    const redacted = applyNoteRedaction(makeNote(), "Removed at subject request.", "auditor-1", NOW, "r");
    expect(codeOf(() => applyNoteEdit(redacted, { text: "x" }, "maint-ann", NOW, "e"))).toBe("not_editable");
    const archived = applyNoteArchive(makeNote(), "maint-ann", NOW, "a");
    expect(codeOf(() => applyNoteEdit(archived, { text: "x" }, "maint-ann", NOW, "e"))).toBe("not_editable");
  });

  it("requires a meaningful redaction reason and redacts only once", () => {
    expect(codeOf(() => applyNoteRedaction(makeNote(), "short", "auditor-1", NOW, "r"))).toBe("invalid_reason");
    const redacted = applyNoteRedaction(makeNote(), "Removed at subject request.", "auditor-1", NOW, "r");
    expect(redacted).toMatchObject({ text: "", redactedBy: "auditor-1" });
    expect(codeOf(() => applyNoteRedaction(redacted, "Removed again, for tidiness.", "auditor-1", NOW, "r2"))).toBe("already_redacted");
  });

  it("archives a note once", () => {
    const archived = applyNoteArchive(makeNote(), "maint-ann", NOW, "a");
    expect(archived.archivedAt).toEqual(NOW);
    expect(codeOf(() => applyNoteArchive(archived, "maint-ann", NOW, "a2"))).toBe("not_editable");
  });
});

describe("retention", () => {
  it("makes a triage note due once its retention period has elapsed", () => {
    expect(noteRetentionStatus(makeNote({ createdAt: new Date(NOW.getTime() - 10 * DAY) }), NOW)).toBe("retained");
    expect(noteRetentionStatus(makeNote({ createdAt: new Date(NOW.getTime() - 181 * DAY) }), NOW)).toBe("due");
  });

  it("uses a longer period for decision notes than for handoff notes", () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    expect(noteRetentionStatus(makeNote({ type: "handoff", createdAt: old }), NOW)).toBe("due");
    expect(noteRetentionStatus(makeNote({ type: "decision", createdAt: old }), NOW)).toBe("retained");
  });

  it("reports due notes and counts redacted ones separately", () => {
    const notes = [
      makeNote({ noteId: "old", createdAt: new Date(NOW.getTime() - 400 * DAY) }),
      makeNote({ noteId: "fresh" }),
      makeNote({ noteId: "gone", createdAt: new Date(NOW.getTime() - 400 * DAY), redactedAt: NOW }),
    ];
    const report = buildRetentionReport(notes, NOW);
    expect(report.counts).toEqual({ retained: 1, due: 1, redacted: 1 });
    expect(report.due.map((d) => d.noteId)).toEqual(["old"]);
  });
});

// ─── IO ──────────────────────────────────────────────────────────────────────

/** Chainable query double for `find(...).sort().limit().lean()`. */
function queryOf(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.sort = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.lean = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe("maintainer note IO", () => {
  beforeEach(() => {
    vi.mocked(recordAuditEvent).mockClear();
    vi.mocked(MaintainerNote.create).mockReset();
    vi.mocked(MaintainerNote.findOne).mockReset();
    vi.mocked(MaintainerNote.find).mockReset();
    vi.mocked(MaintainerNote.findOneAndUpdate).mockReset();
  });

  it("writes the audit row before the note is created", async () => {
    await createMaintainerNote({ subjectId: "prompt-1", type: "triage", text: "Check duplicate.", author: "maint-ann", now: NOW });

    const auditOrder = vi.mocked(recordAuditEvent).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(MaintainerNote.create).mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(createOrder);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "maintainer_note_created" }),
      { throwOnError: true },
    );
  });

  it("never creates a note when its audit evidence cannot be written", async () => {
    vi.mocked(recordAuditEvent).mockRejectedValueOnce(new Error("audit store down"));
    await expect(
      createMaintainerNote({ subjectId: "prompt-1", type: "triage", text: "Check duplicate.", author: "maint-ann" }),
    ).rejects.toThrow("audit store down");
    expect(MaintainerNote.create).not.toHaveBeenCalled();
  });

  it("refuses an edit made against a stale version", async () => {
    vi.mocked(MaintainerNote.findOne).mockReturnValue({
      lean: () => Promise.resolve(makeNote({ version: 3 })),
    } as never);

    await expect(
      editMaintainerNote("mnt_1", { text: "new", expectedVersion: 2 }, ann, null, NOW),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(MaintainerNote.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("guards the write on the version it read, so a concurrent edit cannot be overwritten", async () => {
    vi.mocked(MaintainerNote.findOne).mockReturnValue({
      lean: () => Promise.resolve(makeNote({ version: 1 })),
    } as never);
    vi.mocked(MaintainerNote.findOneAndUpdate).mockReturnValue({
      lean: () => Promise.resolve(null),
    } as never);

    await expect(
      editMaintainerNote("mnt_1", { text: "new", expectedVersion: 1 }, ann, null, NOW),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(MaintainerNote.findOneAndUpdate).toHaveBeenCalledWith(
      { noteId: "mnt_1", version: 1 },
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports another maintainer's private note as not found", async () => {
    vi.mocked(MaintainerNote.findOne).mockReturnValue({
      lean: () => Promise.resolve(makeNote({ visibility: "private", author: "maint-ann" })),
    } as never);

    await expect(
      editMaintainerNote("mnt_1", { text: "x", expectedVersion: 1 }, bob, null, NOW),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists only the notes the viewer may see, and audits the read without note text", async () => {
    vi.mocked(MaintainerNote.find).mockReturnValue(
      queryOf([
        makeNote({ noteId: "open", visibility: "maintainers", text: "public-to-maintainers" }),
        makeNote({ noteId: "secret", visibility: "private", author: "maint-ann", text: "private-secret" }),
        makeNote({ noteId: "board", visibility: "restricted", text: "restricted-text" }),
      ]) as never,
    );

    const views = await listVisibleMaintainerNotes("prompt-1", bob);
    expect(views.map((v) => v.noteId)).toEqual(["open"]);

    const auditCall = vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0];
    expect(auditCall).toMatchObject({ action: "maintainer_note_accessed" });
    expect(JSON.stringify(auditCall)).not.toContain("public-to-maintainers");
  });
});
