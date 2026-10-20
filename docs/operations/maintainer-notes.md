# Structured maintainer notes (#903)

Maintainer notes are typed, scoped, versioned records on a subject such as a
prompt or a support case. They replace free-form metadata: each note has a type,
a visibility, an author, a retention period, and an audit trail.

Source: `server/src/services/maintainerNotes.ts`,
`server/src/routes/maintainerNoteRoutes.ts`, `server/src/models/MaintainerNote.ts`.

## Note fields

| Field        | Rules                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| `type`       | `triage`, `decision`, `risk`, or `handoff`                                |
| `visibility` | `private`, `maintainers` (default), or `restricted`                       |
| `text`       | 1 to 2000 characters after trimming. Empty after redaction.               |
| `author`     | Admin token `sub` that created the note. Never taken from the body.       |
| `version`    | Starts at 1. Increments on every edit, archive, and redaction.            |
| `auditRefs`  | Audit evidence references, one per change. Survive redaction.             |

## Visibility

| Visibility    | Who can see it                                              |
| ------------- | ----------------------------------------------------------- |
| `private`     | The author only                                             |
| `maintainers` | Any admin token with `maintainer_notes:read`                |
| `restricted`  | Admin tokens with `maintainer_notes:restricted`             |

The author can always see their own note. A note the caller cannot see is
reported as `404`, the same as a note that does not exist, so its existence
does not leak.

## Scopes and routes

Mounted at `/api/admin/maintainer-notes`.

| Method and path                           | Scope                         | Purpose                                 |
| ----------------------------------------- | ----------------------------- | --------------------------------------- |
| `GET /subjects/:subjectId/notes`          | `maintainer_notes:read`       | Visible notes; `?includeArchived=true`  |
| `POST /subjects/:subjectId/notes`         | `maintainer_notes:write`      | Create                                  |
| `PATCH /notes/:noteId`                    | `maintainer_notes:write`      | Edit text or visibility (author only)   |
| `POST /notes/:noteId/archive`             | `maintainer_notes:write`      | Hide from default listings              |
| `POST /notes/:noteId/redact`              | `maintainer_notes:restricted` | Clear text, keep the audit trail        |
| `GET /retention-report`                   | `maintainer_notes:restricted` | Notes whose retention has elapsed       |

`PATCH` requires `expectedVersion`, the version the caller read. A mismatch
returns `409 version_conflict`, so a stale edit cannot overwrite newer content.

## Lifecycle

- **Edit.** Only the author, and only while the note is neither redacted nor
  archived.
- **Archive.** Sets `archivedAt`. Archived notes are excluded from listings
  unless `includeArchived=true`.
- **Redact.** Requires a reason of at least 12 characters. Clears `text`, sets
  `redactedAt`, `redactedBy`, and `redactionReason`, and keeps `author`,
  timestamps, and `auditRefs`. A note can be redacted once.

Notes are never deleted through the API.

## Retention

| Type       | Retained for |
| ---------- | ------------ |
| `triage`   | 180 days     |
| `handoff`  | 90 days      |
| `risk`     | 365 days     |
| `decision` | 730 days     |

`GET /retention-report` lists the notes whose period has passed, grouped as
`retained`, `due`, or `redacted`. Retention does not delete anything. An
operator redacts each due note through the redact route, which keeps the audit
references.

## Audit actions

| Action                       | When                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `maintainer_note_created`    | Note created (written with `throwOnError`)                |
| `maintainer_note_edited`     | Text or visibility changed                                |
| `maintainer_note_archived`   | Note archived                                             |
| `maintainer_note_redacted`   | Text cleared; the reason is in the audit reason field     |
| `maintainer_note_accessed`   | A listing was read; records the count, never the text     |

Each audit row carries an `auditRef` in its metadata, and the note's
`auditRefs` points back to it. The write-path actions are recorded before the
change is persisted. If the audit write fails, the change is refused. A crash
after the audit row and before the persist leaves an audit row with no matching
change; the `version` in the audit reason shows which change did not land.

## Tests

`server/src/tests/maintainerNotes.test.ts` covers validation, visibility for each
level, edit authorisation, redaction and its reason rule, archive, retention
periods, the retention report, audit-before-create, stale-version refusal, and
the hidden-note `404`.
