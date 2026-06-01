# Reorg Rollback Invariants

## Trigger Conditions

| Reason           | Description                                          |
|------------------|------------------------------------------------------|
| `HASH_MISMATCH`  | Checkpoint hash differs from chain at same sequence  |
| `SEQUENCE_GAP`   | Gap in ingested ledger sequences detected            |
| `EXPLICIT_REORG` | Chain RPC signalled a reorganisation                 |
| `OPERATOR_RESET` | Manual rollback via operator tooling                 |

## Entity Coverage

| Entity          | Scope                                    | Notes                                                    |
|-----------------|------------------------------------------|----------------------------------------------------------|
| Events          | `ledger IN [from, to]`                   | Deleted first — no FK dependencies on other entities     |
| Tickets         | `purchased_at_ledger IN [from, to]`      | Deleted before raffles (FK: ticket → raffle)             |
| Raffles         | `created_ledger IN [from, to]`           | Deleted after tickets                                    |
| Users           | `first_seen_ledger IN [from, to]`        | Only users with **no surviving** tickets or raffles      |
| Platform Stats  | —                                        | **Skipped** — date-keyed aggregates, no ledger column    |
| Cursor hash ring| Entries with `ledger >= fromSequence`    | Trimmed inside the transaction                           |
| Cursor position | Reset to `fromSequence - 1`              | Reset **after** transaction commits (separate operation) |

## Atomicity Guarantee

All entity deletes (events, tickets, raffles, users, cursor ring trim) run inside a
single database transaction. Either all succeed and commit, or none are written.

Cursor position reset occurs after commit in a separate operation — see Partial Failure below.

## Partial Failure: Cursor Reset Fails After Commit

If the transaction commits but the subsequent cursor reset fails:

- **Entities are clean** — reverted to pre-reorg state.
- **Cursor still points to the reorged tip** — the indexer will attempt to resume
  from the wrong sequence on next start.
- Outcome is `PARTIAL_FAILURE`; the audit log records the committed entity counts
  and the cursor error.
- **Operator action required**: inspect the audit log for the last known-good
  sequence and reset the cursor manually before restarting the indexer.

```sql
-- Find the most recent partial failure and the safe resume sequence:
SELECT from_sequence - 1 AS safe_resume_sequence, *
FROM reorg_rollback_audit
WHERE outcome = 'PARTIAL_FAILURE'
ORDER BY triggered_at DESC
LIMIT 1;
```

## Audit Log

Every rollback attempt writes a `reorg_rollback_audit` row **outside** the main
transaction, so it is preserved even if the rollback fails partway through.

```sql
-- Query recent rollbacks:
SELECT * FROM reorg_rollback_audit ORDER BY triggered_at DESC LIMIT 20;

-- Count by outcome:
SELECT outcome, COUNT(*) FROM reorg_rollback_audit GROUP BY outcome;
```

## Operator Recovery from PARTIAL_FAILURE

```bash
# 1. Check the stale cursor and safe resume point:
npm run status

# 2. Reset the cursor to the safe sequence (destructive — use with care):
# <document the operator reset command here, or note it is a follow-up task>

# 3. Restart the indexer — it will resume from the reset sequence.
```
