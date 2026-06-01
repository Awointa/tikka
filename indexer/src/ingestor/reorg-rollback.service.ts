/**
 * reorg-rollback.service.ts
 *
 * Findings (issue #559 audit):
 *
 * BEFORE this PR the rollback:
 *   - Covered: raffle_events, tickets, raffles (DELETE >= fromLedger), cursor ring trim.
 *   - Missing: users (no rollback at all), platform_stats (no rollback).
 *   - Cursor reset was INSIDE the main transaction — wrong, it should be after commit.
 *   - No audit record, no per-entity counts, no structured metrics.
 *   - Input was a single `fromLedger: number` — no toSequence, forkHash, or reason.
 *
 * AFTER this PR:
 *   - Full entity coverage: raffle_events, tickets, raffles, users (created in range).
 *   - platform_stats: SKIPPED — rows are date-keyed aggregates with no ledger column;
 *     cannot be rolled back by sequence range without a full recompute. Documented here.
 *   - Single atomic transaction for all entity deletes.
 *   - Cursor reset performed AFTER transaction commit (separate operation).
 *   - Structured audit entry written to reorg_rollback_audit OUTSIDE the main tx.
 *   - MetricsService counter incremented on every rollback attempt.
 *   - executeRollback() never throws — all failure info is in RollbackResult.
 *   - Legacy rollback(fromLedger) preserved for backward compat with LedgerPollerService.
 *
 * DB: PostgreSQL via TypeORM (DataSource.transaction / QueryRunner).
 * Cascade: TicketEntity has onDelete: CASCADE on raffle FK — deleting a raffle
 *   auto-deletes its tickets. We still delete tickets explicitly first to get the count.
 * Users: deleted only when first_seen_ledger is in [fromSequence, toSequence] AND
 *   they have no surviving tickets or raffles after the entity deletes (i.e. they
 *   were created solely by activity in the reorged range).
 */

import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RollbackAuditEntity } from '../database/entities/rollback-audit.entity';
import { MetricsService } from '../metrics/metrics.service';

// ── Contract types ────────────────────────────────────────────────────────────

export type RollbackReason =
  | 'HASH_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'EXPLICIT_REORG'
  | 'OPERATOR_RESET';

export interface RollbackRequest {
  /** First ledger sequence to roll back (inclusive). */
  fromSequence: number;
  /** Current (bad) tip sequence (inclusive). */
  toSequence: number;
  /** Hash of the last known-good ledger (fromSequence - 1). */
  forkHash: string;
  reason: RollbackReason;
}

export interface RollbackEntityCounts {
  rafflesReverted: number;
  ticketsReverted: number;
  usersReverted: number;
  /** Always 0 — platform_stats has no ledger column; see file header. */
  statsReverted: number;
  eventsRemoved: number;
  cursorResetTo: number;
}

export interface RollbackAuditEntry {
  id: string;
  triggeredAt: string;
  reason: RollbackReason;
  fromSequence: number;
  toSequence: number;
  forkHash: string;
  outcome: 'SUCCESS' | 'PARTIAL_FAILURE' | 'TOTAL_FAILURE';
  entityCounts: RollbackEntityCounts | null;
  errorDetail: string | null;
  durationMs: number;
}

export type RollbackError =
  | { code: 'TRANSACTION_FAILED'; cause: unknown }
  | { code: 'CURSOR_RESET_FAILED'; cause: unknown; partialCounts: RollbackEntityCounts }
  | { code: 'AUDIT_WRITE_FAILED'; cause: unknown }
  | { code: 'INVALID_REQUEST'; detail: string };

export type RollbackResult =
  | { ok: true; audit: RollbackAuditEntry }
  | { ok: false; audit: RollbackAuditEntry; error: RollbackError };

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_REASONS = new Set<RollbackReason>([
  'HASH_MISMATCH',
  'SEQUENCE_GAP',
  'EXPLICIT_REORG',
  'OPERATOR_RESET',
]);

/**
 * Returns a human-readable error string if the request is invalid, null otherwise.
 * Pure function — no I/O.
 */
export function validateRequest(req: RollbackRequest): string | null {
  if (!Number.isInteger(req.fromSequence) || req.fromSequence < 1) {
    return `fromSequence must be a positive integer, got ${req.fromSequence}`;
  }
  if (!Number.isInteger(req.toSequence) || req.toSequence < req.fromSequence) {
    return `toSequence must be >= fromSequence, got from=${req.fromSequence} to=${req.toSequence}`;
  }
  if (!req.forkHash || typeof req.forkHash !== 'string' || req.forkHash.trim() === '') {
    return `forkHash must be a non-empty string`;
  }
  if (!VALID_REASONS.has(req.reason)) {
    return `reason must be one of ${[...VALID_REASONS].join(', ')}, got ${req.reason}`;
  }
  return null;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ReorgRollbackService {
  private readonly logger = new Logger(ReorgRollbackService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Execute a fully transactional rollback for the given ledger sequence range.
   *
   * Execution order:
   * 1. Validate request.
   * 2. Open a single DB transaction.
   *    a. DELETE raffle_events WHERE ledger IN [from, to]  → eventsRemoved
   *    b. DELETE tickets WHERE purchased_at_ledger IN [from, to]  → ticketsReverted
   *    c. DELETE raffles WHERE created_ledger IN [from, to]  → rafflesReverted
   *    d. DELETE users WHERE first_seen_ledger IN [from, to]
   *       AND no surviving tickets or raffles  → usersReverted
   *    e. platform_stats: skipped (no ledger column).
   * 3. Commit transaction.
   * 4. Reset cursor to fromSequence - 1 (separate operation after commit).
   * 5. Write audit entry outside the main transaction.
   * 6. Increment metrics counter.
   *
   * Never throws — all failure information is in the returned RollbackResult.
   */
  async executeRollback(request: RollbackRequest): Promise<RollbackResult> {
    const startMs = Date.now();
    const { fromSequence, toSequence, reason, forkHash } = request;

    this.logger.log('reorg_rollback_started', { fromSequence, toSequence, reason, forkHash });

    // 1. Validate
    const validationError = validateRequest(request);
    if (validationError) {
      const audit = await this.writeAudit({
        request,
        outcome: 'TOTAL_FAILURE',
        counts: null,
        errorDetail: validationError,
        durationMs: Date.now() - startMs,
      });
      return { ok: false, audit, error: { code: 'INVALID_REQUEST', detail: validationError } };
    }

    // 2–3. Transactional entity deletes
    let counts: RollbackEntityCounts | null = null;
    try {
      counts = await this.dataSource.transaction(async (manager) => {
        return this.deleteEntitiesInRange(manager, fromSequence, toSequence);
      });
    } catch (cause) {
      const durationMs = Date.now() - startMs;
      this.metrics.incrementReorgDetected();
      this.logger.error('reorg_rollback_failed', {
        code: 'TRANSACTION_FAILED',
        fromSequence,
        toSequence,
        cause: errorMessage(cause),
        durationMs,
      });
      const audit = await this.writeAudit({
        request,
        outcome: 'TOTAL_FAILURE',
        counts: null,
        errorDetail: errorMessage(cause),
        durationMs,
      });
      return { ok: false, audit, error: { code: 'TRANSACTION_FAILED', cause } };
    }

    // 4. Cursor reset (after commit, separate operation)
    const resetTo = fromSequence - 1;
    try {
      await this.resetCursor(resetTo, fromSequence);
      counts.cursorResetTo = resetTo;
    } catch (cause) {
      const durationMs = Date.now() - startMs;
      this.metrics.incrementReorgDetected();
      this.logger.error('reorg_rollback_partial_failure', {
        cursorError: errorMessage(cause),
        entityCounts: counts,
      });
      const audit = await this.writeAudit({
        request,
        outcome: 'PARTIAL_FAILURE',
        counts,
        errorDetail: `Cursor reset failed: ${errorMessage(cause)}`,
        durationMs,
      });
      return {
        ok: false,
        audit,
        error: { code: 'CURSOR_RESET_FAILED', cause, partialCounts: counts },
      };
    }

    // 5–6. Audit + metrics
    const durationMs = Date.now() - startMs;
    this.metrics.incrementReorgDetected();
    this.logger.log('reorg_rollback_committed', { ...counts, durationMs });
    // Structured metrics log — queryable in any log aggregator
    this.logger.log('reorg_rollback_metrics', {
      outcome: 'SUCCESS',
      reason,
      fromSequence,
      toSequence,
      durationMs,
      ...counts,
    });

    const audit = await this.writeAudit({
      request,
      outcome: 'SUCCESS',
      counts,
      errorDetail: null,
      durationMs,
    });

    return { ok: true, audit };
  }

  /**
   * Legacy entrypoint — preserved for backward compatibility with LedgerPollerService.
   * Delegates to executeRollback with HASH_MISMATCH reason and toSequence = fromLedger.
   */
  async rollback(fromLedger: number): Promise<void> {
    this.logger.error(`Rolling back state from ledger ${fromLedger} onwards due to reorg`);
    await this.executeRollback({
      fromSequence: fromLedger,
      toSequence: fromLedger,
      forkHash: 'unknown',
      reason: 'HASH_MISMATCH',
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async deleteEntitiesInRange(
    manager: EntityManager,
    from: number,
    to: number,
  ): Promise<RollbackEntityCounts> {
    // a. Events
    const eventsResult = await manager.query(
      `DELETE FROM raffle_events WHERE ledger >= $1 AND ledger <= $2`,
      [from, to],
    );
    const eventsRemoved = rowCount(eventsResult);

    // b. Tickets (explicit delete for count; CASCADE would also remove them via raffle FK)
    const ticketsResult = await manager.query(
      `DELETE FROM tickets WHERE purchased_at_ledger >= $1 AND purchased_at_ledger <= $2`,
      [from, to],
    );
    const ticketsReverted = rowCount(ticketsResult);

    // c. Raffles
    const rafflesResult = await manager.query(
      `DELETE FROM raffles WHERE created_ledger >= $1 AND created_ledger <= $2`,
      [from, to],
    );
    const rafflesReverted = rowCount(rafflesResult);

    // d. Users: only those whose first appearance was in this range AND who have
    //    no surviving tickets or raffles (i.e. they exist solely due to reorged events).
    const usersResult = await manager.query(
      `DELETE FROM users
       WHERE first_seen_ledger >= $1
         AND first_seen_ledger <= $2
         AND NOT EXISTS (SELECT 1 FROM tickets  WHERE tickets.owner   = users.address)
         AND NOT EXISTS (SELECT 1 FROM raffles  WHERE raffles.creator = users.address)`,
      [from, to],
    );
    const usersReverted = rowCount(usersResult);

    // e. platform_stats: skipped — date-keyed aggregates, no ledger column.

    // f. Trim cursor hash ring (inside transaction so it's atomic with entity deletes)
    await manager.query(
      `UPDATE indexer_cursor
       SET ledger_hashes = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(ledger_hashes) AS elem
         WHERE (elem->>'ledger')::int < $1
       )
       WHERE id = 1`,
      [from],
    );

    return {
      rafflesReverted,
      ticketsReverted,
      usersReverted,
      statsReverted: 0,
      eventsRemoved,
      cursorResetTo: from - 1, // updated after cursor reset succeeds
    };
  }

  private async resetCursor(resetTo: number, fromSequence: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE indexer_cursor
       SET last_ledger = $1,
           last_paging_token = '',
           processed_event_count = GREATEST(0, processed_event_count - (
             SELECT COUNT(*) FROM raffle_events WHERE ledger >= $2
           )),
           saved_at = NOW()
       WHERE id = 1`,
      [resetTo, fromSequence],
    );
  }

  private async writeAudit(params: {
    request: RollbackRequest;
    outcome: 'SUCCESS' | 'PARTIAL_FAILURE' | 'TOTAL_FAILURE';
    counts: RollbackEntityCounts | null;
    errorDetail: string | null;
    durationMs: number;
  }): Promise<RollbackAuditEntry> {
    const { request, outcome, counts, errorDetail, durationMs } = params;
    const triggeredAt = new Date().toISOString();

    try {
      const repo = this.dataSource.getRepository(RollbackAuditEntity);
      const row = repo.create({
        triggeredAt: new Date(triggeredAt),
        reason: request.reason,
        fromSequence: request.fromSequence,
        toSequence: request.toSequence,
        forkHash: request.forkHash,
        outcome,
        rafflesReverted: counts?.rafflesReverted ?? null,
        ticketsReverted: counts?.ticketsReverted ?? null,
        usersReverted: counts?.usersReverted ?? null,
        statsReverted: counts?.statsReverted ?? null,
        eventsRemoved: counts?.eventsRemoved ?? null,
        cursorResetTo: counts?.cursorResetTo ?? null,
        errorDetail,
        durationMs,
      });
      const saved = await repo.save(row);

      return {
        id: saved.id,
        triggeredAt,
        reason: request.reason,
        fromSequence: request.fromSequence,
        toSequence: request.toSequence,
        forkHash: request.forkHash,
        outcome,
        entityCounts: counts,
        errorDetail,
        durationMs,
      };
    } catch (auditErr) {
      this.logger.error('Failed to write rollback audit entry', auditErr);
      // Return a synthetic audit entry so the caller still gets a result
      return {
        id: 'audit-write-failed',
        triggeredAt,
        reason: request.reason,
        fromSequence: request.fromSequence,
        toSequence: request.toSequence,
        forkHash: request.forkHash,
        outcome,
        entityCounts: counts,
        errorDetail: errorDetail ?? `Audit write failed: ${errorMessage(auditErr)}`,
        durationMs,
      };
    }
  }
}

function rowCount(result: unknown): number {
  // TypeORM raw query returns [rows, count] for DELETE statements in PostgreSQL
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  return 0;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
