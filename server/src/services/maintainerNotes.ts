/**
 * Structured maintainer notes with visibility and retention (#903).
 *
 * Pure rules: input validation, visibility (`canViewNote`), the edit, redact and
 * archive transitions, retention due dates, and the retention report.
 *
 * IO helpers write the audit row first (with `throwOnError`), then persist.
 * Edits and redactions are guarded by the note's `version`, so a stale write
 * gets `version_conflict` instead of overwriting newer content.
 *
 * Visibility:
 *   private     → the author only
 *   maintainers → any admin holding `maintainer_notes:read`
 *   restricted  → admins holding `maintainer_notes:restricted`
 * A note's author can always see it. Redaction is limited to
 * `maintainer_notes:restricted` holders, who can redact any note.
 *
 * Runbook: docs/operations/maintainer-notes.md
 */

import { randomUUID } from "crypto";
import MaintainerNote, {
  MAINTAINER_NOTE_TYPES,
  MAINTAINER_NOTE_VISIBILITIES,
  type MaintainerNoteType,
  type MaintainerNoteVisibility,
} from "../models/MaintainerNote";
import { recordAuditEvent } from "./auditTrail";

export const MAINTAINER_NOTE_MAX_LENGTH = 2000;
export const MIN_NOTE_REDACTION_REASON_LENGTH = 12;

export const MAINTAINER_NOTE_SCOPES = {
  read: "maintainer_notes:read",
  write: "maintainer_notes:write",
  restricted: "maintainer_notes:restricted",
} as const;

/** How long each note type is kept before retention makes it due for redaction. */
export const NOTE_RETENTION_DAYS: Record<MaintainerNoteType, number> = {
  triage: 180,
  handoff: 90,
  risk: 365,
  decision: 730,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type MaintainerNoteErrorCode =
  | "invalid_type"
  | "invalid_visibility"
  | "invalid_text"
  | "invalid_reason"
  | "not_found"
  | "not_author"
  | "not_editable"
  | "already_redacted"
  | "version_conflict";

export class MaintainerNoteError extends Error {
  constructor(
    readonly code: MaintainerNoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MaintainerNoteError";
  }
}

export interface NoteViewer {
  sub: string;
  scopes: string[];
}

export interface NoteRecord {
  noteId: string;
  subjectId: string;
  type: MaintainerNoteType;
  visibility: MaintainerNoteVisibility;
  text: string;
  author: string;
  version: number;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  redactedAt: Date | null;
  redactedBy?: string | null;
  redactionReason?: string | null;
  archivedAt: Date | null;
  auditRefs: string[];
}

/** What a viewer may see. `text` is null for redacted notes. */
export interface NoteView {
  noteId: string;
  subjectId: string;
  type: MaintainerNoteType;
  visibility: MaintainerNoteVisibility;
  author: string;
  version: number;
  text: string | null;
  redacted: boolean;
  createdAt: string;
  updatedAt: string;
  redactedAt: string | null;
  archivedAt: string | null;
  auditRefs: string[];
}

export function validateNoteInput(input: {
  type: unknown;
  text: unknown;
  visibility?: unknown;
}): { type: MaintainerNoteType; visibility: MaintainerNoteVisibility; text: string } {
  if (!(MAINTAINER_NOTE_TYPES as readonly unknown[]).includes(input.type)) {
    throw new MaintainerNoteError("invalid_type", `type must be one of: ${MAINTAINER_NOTE_TYPES.join(", ")}.`);
  }
  const visibility = input.visibility ?? "maintainers";
  if (!(MAINTAINER_NOTE_VISIBILITIES as readonly unknown[]).includes(visibility)) {
    throw new MaintainerNoteError(
      "invalid_visibility",
      `visibility must be one of: ${MAINTAINER_NOTE_VISIBILITIES.join(", ")}.`,
    );
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > MAINTAINER_NOTE_MAX_LENGTH) {
    throw new MaintainerNoteError(
      "invalid_text",
      `text must be 1 to ${MAINTAINER_NOTE_MAX_LENGTH} characters.`,
    );
  }
  return {
    type: input.type as MaintainerNoteType,
    visibility: visibility as MaintainerNoteVisibility,
    text,
  };
}

/** Pure visibility decision. Hidden notes must be reported as not found, not forbidden. */
export function canViewNote(
  note: Pick<NoteRecord, "author" | "visibility">,
  viewer: NoteViewer,
): boolean {
  if (note.author === viewer.sub) return true;
  if (note.visibility === "private") return false;
  if (note.visibility === "restricted") return viewer.scopes.includes(MAINTAINER_NOTE_SCOPES.restricted);
  return viewer.scopes.includes(MAINTAINER_NOTE_SCOPES.read);
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function toNoteView(note: NoteRecord): NoteView {
  const redacted = Boolean(note.redactedAt);
  return {
    noteId: note.noteId,
    subjectId: note.subjectId,
    type: note.type,
    visibility: note.visibility,
    author: note.author,
    version: note.version,
    text: redacted ? null : note.text,
    redacted,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    redactedAt: iso(note.redactedAt),
    archivedAt: iso(note.archivedAt),
    auditRefs: [...note.auditRefs],
  };
}

export function applyNoteEdit(
  note: NoteRecord,
  patch: { text?: unknown; visibility?: unknown },
  actor: string,
  now: Date,
  auditRef: string,
): NoteRecord {
  if (note.author !== actor) {
    throw new MaintainerNoteError("not_author", "Only the author can edit a note.");
  }
  if (note.redactedAt || note.archivedAt) {
    throw new MaintainerNoteError("not_editable", "Redacted or archived notes cannot be edited.");
  }

  const next: NoteRecord = {
    ...note,
    version: note.version + 1,
    updatedAt: now,
    updatedBy: actor,
    auditRefs: [...note.auditRefs, auditRef],
  };
  if (patch.text !== undefined) {
    next.text = validateNoteInput({ type: note.type, text: patch.text, visibility: note.visibility }).text;
  }
  if (patch.visibility !== undefined) {
    next.visibility = validateNoteInput({ type: note.type, text: next.text, visibility: patch.visibility })
      .visibility;
  }
  return next;
}

/**
 * Redaction clears the text and keeps the author, timestamps, and audit
 * references. The reason is required, because the note's content is gone.
 */
export function applyNoteRedaction(
  note: NoteRecord,
  reason: unknown,
  actor: string,
  now: Date,
  auditRef: string,
): NoteRecord {
  if (note.redactedAt) {
    throw new MaintainerNoteError("already_redacted", "This note has already been redacted.");
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < MIN_NOTE_REDACTION_REASON_LENGTH) {
    throw new MaintainerNoteError(
      "invalid_reason",
      `reason must be at least ${MIN_NOTE_REDACTION_REASON_LENGTH} characters.`,
    );
  }
  return {
    ...note,
    text: "",
    redactedAt: now,
    redactedBy: actor,
    redactionReason: trimmed,
    version: note.version + 1,
    updatedAt: now,
    updatedBy: actor,
    auditRefs: [...note.auditRefs, auditRef],
  };
}

export function applyNoteArchive(
  note: NoteRecord,
  actor: string,
  now: Date,
  auditRef: string,
): NoteRecord {
  if (note.archivedAt) {
    throw new MaintainerNoteError("not_editable", "This note is already archived.");
  }
  return {
    ...note,
    archivedAt: now,
    version: note.version + 1,
    updatedAt: now,
    updatedBy: actor,
    auditRefs: [...note.auditRefs, auditRef],
  };
}

export type NoteRetentionStatus = "retained" | "due" | "redacted";

export function noteRetentionDueAt(note: Pick<NoteRecord, "type" | "createdAt">): Date {
  return new Date(new Date(note.createdAt).getTime() + NOTE_RETENTION_DAYS[note.type] * DAY_MS);
}

export function noteRetentionStatus(note: NoteRecord, now: Date): NoteRetentionStatus {
  if (note.redactedAt) return "redacted";
  return now.getTime() >= noteRetentionDueAt(note).getTime() ? "due" : "retained";
}

export interface RetentionReport {
  generatedAt: string;
  counts: Record<NoteRetentionStatus, number>;
  due: Array<{ noteId: string; subjectId: string; type: MaintainerNoteType; dueAt: string }>;
}

/**
 * Lists notes whose retention has elapsed. Retention does not delete anything.
 * Each due note is redacted by an operator, which keeps its audit references.
 */
export function buildRetentionReport(notes: NoteRecord[], now: Date = new Date()): RetentionReport {
  const report: RetentionReport = {
    generatedAt: now.toISOString(),
    counts: { retained: 0, due: 0, redacted: 0 },
    due: [],
  };
  for (const note of notes) {
    const status = noteRetentionStatus(note, now);
    report.counts[status] += 1;
    if (status === "due") {
      report.due.push({
        noteId: note.noteId,
        subjectId: note.subjectId,
        type: note.type,
        dueAt: noteRetentionDueAt(note).toISOString(),
      });
    }
  }
  return report;
}

// ─── IO ──────────────────────────────────────────────────────────────────────

function newAuditRef(): string {
  return `maudit_${randomUUID()}`;
}

async function recordNoteAudit(
  action:
    | "maintainer_note_created"
    | "maintainer_note_edited"
    | "maintainer_note_redacted"
    | "maintainer_note_archived"
    | "maintainer_note_accessed",
  input: { noteId: string; subjectId: string; actor: string; requestId?: string | null; auditRef: string; detail: string },
  throwOnError: boolean,
): Promise<void> {
  await recordAuditEvent(
    {
      action,
      result: "success",
      actor: input.actor,
      target: input.noteId,
      targetType: "maintainer_note",
      requestId: input.requestId ?? null,
      reason: `noteId=${input.noteId} subjectId=${input.subjectId} ${input.detail}`,
      metadata: { auditRef: input.auditRef, subjectId: input.subjectId },
    },
    { throwOnError },
  );
}

async function findNoteOrThrow(noteId: string, viewer: NoteViewer): Promise<NoteRecord> {
  const doc = (await MaintainerNote.findOne({ noteId }).lean()) as unknown as NoteRecord | null;
  // A hidden note looks the same as a missing one, so its existence does not leak.
  if (!doc || !canViewNote(doc, viewer)) {
    throw new MaintainerNoteError("not_found", "Maintainer note not found.");
  }
  return doc;
}

export async function createMaintainerNote(input: {
  subjectId: string;
  type: unknown;
  text: unknown;
  visibility?: unknown;
  author: string;
  requestId?: string | null;
  now?: Date;
}): Promise<NoteRecord> {
  const fields = validateNoteInput(input);
  const now = input.now ?? new Date();
  const noteId = `mnt_${randomUUID()}`;
  const auditRef = newAuditRef();

  // Evidence first: a note must never exist without a record of who wrote it.
  await recordNoteAudit(
    "maintainer_note_created",
    { noteId, subjectId: input.subjectId, actor: input.author, requestId: input.requestId, auditRef, detail: `type=${fields.type} visibility=${fields.visibility}` },
    true,
  );

  const note: NoteRecord = {
    noteId,
    subjectId: input.subjectId,
    type: fields.type,
    visibility: fields.visibility,
    text: fields.text,
    author: input.author,
    version: 1,
    updatedBy: input.author,
    createdAt: now,
    updatedAt: now,
    redactedAt: null,
    redactedBy: null,
    redactionReason: null,
    archivedAt: null,
    auditRefs: [auditRef],
  };
  await MaintainerNote.create(note);
  return note;
}

export async function editMaintainerNote(
  noteId: string,
  patch: { text?: unknown; visibility?: unknown; expectedVersion: number },
  viewer: NoteViewer,
  requestId?: string | null,
  now: Date = new Date(),
): Promise<NoteRecord> {
  const current = await findNoteOrThrow(noteId, viewer);
  if (current.version !== patch.expectedVersion) {
    throw new MaintainerNoteError("version_conflict", "The note changed since you read it.");
  }
  const auditRef = newAuditRef();
  const next = applyNoteEdit(current, patch, viewer.sub, now, auditRef);

  await recordNoteAudit(
    "maintainer_note_edited",
    { noteId, subjectId: current.subjectId, actor: viewer.sub, requestId, auditRef, detail: `version=${next.version}` },
    true,
  );

  const updated = await MaintainerNote.findOneAndUpdate(
    { noteId, version: patch.expectedVersion },
    {
      $set: {
        text: next.text,
        visibility: next.visibility,
        version: next.version,
        updatedBy: viewer.sub,
        auditRefs: next.auditRefs,
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    throw new MaintainerNoteError("version_conflict", "The note changed since you read it.");
  }
  return updated as unknown as NoteRecord;
}

/** Redaction is limited to `maintainer_notes:restricted` holders, who may redact any note. */
export async function redactMaintainerNote(
  noteId: string,
  input: { reason: unknown },
  viewer: NoteViewer,
  requestId?: string | null,
  now: Date = new Date(),
): Promise<NoteRecord> {
  const current = (await MaintainerNote.findOne({ noteId }).lean()) as unknown as NoteRecord | null;
  if (!current) {
    throw new MaintainerNoteError("not_found", "Maintainer note not found.");
  }
  const auditRef = newAuditRef();
  const next = applyNoteRedaction(current, input.reason, viewer.sub, now, auditRef);

  await recordNoteAudit(
    "maintainer_note_redacted",
    { noteId, subjectId: current.subjectId, actor: viewer.sub, requestId, auditRef, detail: `version=${next.version}` },
    true,
  );

  const updated = await MaintainerNote.findOneAndUpdate(
    { noteId, version: current.version },
    {
      $set: {
        text: "",
        redactedAt: now,
        redactedBy: viewer.sub,
        redactionReason: next.redactionReason,
        version: next.version,
        updatedBy: viewer.sub,
        auditRefs: next.auditRefs,
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    throw new MaintainerNoteError("version_conflict", "The note changed since it was read.");
  }
  return updated as unknown as NoteRecord;
}

export async function archiveMaintainerNote(
  noteId: string,
  viewer: NoteViewer,
  requestId?: string | null,
  now: Date = new Date(),
): Promise<NoteRecord> {
  const current = await findNoteOrThrow(noteId, viewer);
  const auditRef = newAuditRef();
  const next = applyNoteArchive(current, viewer.sub, now, auditRef);

  await recordNoteAudit(
    "maintainer_note_archived",
    { noteId, subjectId: current.subjectId, actor: viewer.sub, requestId, auditRef, detail: `version=${next.version}` },
    true,
  );

  const updated = await MaintainerNote.findOneAndUpdate(
    { noteId, version: current.version },
    {
      $set: {
        archivedAt: now,
        version: next.version,
        updatedBy: viewer.sub,
        auditRefs: next.auditRefs,
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    throw new MaintainerNoteError("version_conflict", "The note changed since you read it.");
  }
  return updated as unknown as NoteRecord;
}

/**
 * Notes on a subject that this viewer may see. Each read is audited, without
 * note text in the audit row, so access itself leaves evidence.
 */
export async function listVisibleMaintainerNotes(
  subjectId: string,
  viewer: NoteViewer,
  options: { includeArchived?: boolean; requestId?: string | null } = {},
): Promise<NoteView[]> {
  const query: Record<string, unknown> = { subjectId };
  if (!options.includeArchived) query.archivedAt = null;

  const docs = (await MaintainerNote.find(query)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean()) as unknown as NoteRecord[];
  const visible = docs.filter((note) => canViewNote(note, viewer));

  await recordNoteAudit(
    "maintainer_note_accessed",
    {
      noteId: "*",
      subjectId,
      actor: viewer.sub,
      requestId: options.requestId,
      auditRef: newAuditRef(),
      detail: `returned=${visible.length} includeArchived=${Boolean(options.includeArchived)}`,
    },
    false,
  );

  return visible.map(toNoteView);
}

/** All notes that have not been redacted, for the retention report. */
export async function loadRetentionCandidates(limit = 1000): Promise<NoteRecord[]> {
  return (await MaintainerNote.find({ redactedAt: null })
    .sort({ createdAt: 1 })
    .limit(Math.min(Math.max(Math.floor(limit), 1), 5000))
    .lean()) as unknown as NoteRecord[];
}
