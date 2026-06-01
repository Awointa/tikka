import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the reorg_rollback_audit table (issue #559).
 * Written OUTSIDE the rollback transaction so it is preserved even on failure.
 */
export class CreateReorgRollbackAudit1748736600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reorg_rollback_audit (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        triggered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason              VARCHAR(32)  NOT NULL,
        from_sequence       INTEGER      NOT NULL,
        to_sequence         INTEGER      NOT NULL,
        fork_hash           VARCHAR(128) NOT NULL,
        outcome             VARCHAR(16)  NOT NULL,
        raffles_reverted    INTEGER,
        tickets_reverted    INTEGER,
        users_reverted      INTEGER,
        stats_reverted      INTEGER,
        events_removed      INTEGER,
        cursor_reset_to     INTEGER,
        error_detail        TEXT,
        duration_ms         INTEGER      NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_rra_triggered_at ON reorg_rollback_audit (triggered_at DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS reorg_rollback_audit`);
  }
}
