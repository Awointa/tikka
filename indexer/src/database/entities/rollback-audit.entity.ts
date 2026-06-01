import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reorg_rollback_audit')
@Index('idx_rra_triggered_at', ['triggeredAt'])
export class RollbackAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'triggered_at', default: () => 'NOW()' })
  triggeredAt!: Date;

  @Column({ type: 'varchar', length: 32 })
  reason!: string;

  @Column({ type: 'integer', name: 'from_sequence' })
  fromSequence!: number;

  @Column({ type: 'integer', name: 'to_sequence' })
  toSequence!: number;

  @Column({ type: 'varchar', length: 128, name: 'fork_hash' })
  forkHash!: string;

  /** SUCCESS | PARTIAL_FAILURE | TOTAL_FAILURE */
  @Column({ type: 'varchar', length: 16 })
  outcome!: string;

  @Column({ type: 'integer', nullable: true, name: 'raffles_reverted' })
  rafflesReverted!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'tickets_reverted' })
  ticketsReverted!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'users_reverted' })
  usersReverted!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'stats_reverted' })
  statsReverted!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'events_removed' })
  eventsRemoved!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'cursor_reset_to' })
  cursorResetTo!: number | null;

  @Column({ type: 'text', nullable: true, name: 'error_detail' })
  errorDetail!: string | null;

  @Column({ type: 'integer', name: 'duration_ms' })
  durationMs!: number;
}
