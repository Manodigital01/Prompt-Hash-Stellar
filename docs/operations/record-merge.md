# Duplicate prompt merge (#902)

Duplicate or overlapping prompts are merged by an operator in three steps:
preview, resolve, execute. A merge never overwrites a field silently, never
moves a record that buyers or the chain depend on, and can be reverted from
the stored snapshot.

Source: `server/src/services/recordMerge.ts`,
`server/src/routes/recordMergeRoutes.ts`, `server/src/models/RecordMerge.ts`.

## Eligibility

A merge is denied, and returns every denial reason, when:

| Code                   | Why                                                  |
| ---------------------- | ---------------------------------------------------- |
| `same_record`          | Source and target are the same prompt                |
| `owner_mismatch`       | Owners differ                                        |
| `source_merged`        | The source already redirects to another prompt       |
| `target_merged`        | The target has itself been merged away               |
| `target_inactive`      | The target is not active                             |
| `source_on_chain`      | The source has an on-chain listing; a database write cannot redirect it |
| `source_has_licenses`  | The source has purchase records                      |

## Mergeable fields

`title`, `description`, `tags`, `price`. Ownership, on-chain identity, and
status never merge.

## Conflict categories

For each mergeable field, the plan compares the two values:

- An empty value (missing, `null`, `""`, or `[]`) never conflicts. The
  non-empty side is taken, and the change is listed.
- Equal values are not a change.
- Both sides present and different, same type: `value_conflict`.
- Both sides present and different, different types: `type_mismatch`.

Every conflict must be resolved. `keep_source` or `keep_target`, one per
conflicting field. Naming a field that does not conflict, naming an unknown
choice, or leaving a conflict unresolved is refused.

## Workflow

1. **Plan** (`POST /api/admin/record-merges/plan`, scope `record_merge:read`).
   Nothing is written. The response has `eligible`, `denials`, `changes`,
   `conflicts`, `mergedFields`, and `planHash`.
2. **Resolve.** Choose a side for each conflict.
3. **Execute** (`POST /api/admin/record-merges/execute`, scope
   `record_merge:write`). Send `sourceId`, `targetId`, `planHash` from step 1,
   and `resolutions`.

Execute re-plans against the current records. If the `planHash` no longer
matches, the request fails with `409 stale_plan`, because the records changed
after the preview. Plan again.

## Execution order and evidence

1. A `RecordMerge` document is written with status `pending`, the resolutions,
   the merged fields, a snapshot of both records, and rollback notes. This
   happens before any content moves.
2. The target receives the merged fields, and the source is deactivated.
3. The record becomes `committed`. If step 2 throws, it becomes `failed` with
   the reason, and the error is returned.
4. On success, a `record_merge_committed` audit event is written (best effort).

Redirects follow only committed merges. `GET
/api/admin/record-merges/resolve/:promptId` returns the record that now holds
the content, with the hops it followed. A loop, or a chain longer than 10
hops, returns `409 merge_cycle`.

## Rollback

Each merge stores `rollbackNotes` and a `snapshot`. To revert: restore the
source's `isActive` and fields, restore the target's fields from the snapshot,
and keep the merge record for audit. There is no automatic rollback endpoint.

## Limitations

- The two writes are not one database transaction. A crash between them leaves
  a `pending` record and an inconsistent pair. Look for `pending` merges after
  an incident and reconcile them from the snapshot.
- Purchases are counted per prompt id as a proxy for licences. The count is
  taken when the preview is built and checked again at execute, through the
  plan hash.
