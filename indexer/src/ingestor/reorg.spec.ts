import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CursorManagerService } from './cursor-manager.service';
import { IndexerCursorEntity } from '../database/entities/indexer-cursor.entity';

function makeRepo(entity: Partial<IndexerCursorEntity> | null = null) {
  const manager = {
    findOne: jest.fn().mockResolvedValue(entity),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  return {
    findOne: jest.fn().mockResolvedValue(entity),
    manager,
  };
}

/** Minimal valid cursor row — includes all fields validateOnLoad() requires. */
function cursorRow(overrides: Partial<IndexerCursorEntity> = {}): Partial<IndexerCursorEntity> {
  return {
    lastLedger: 1000,
    lastPagingToken: 'tok',
    ledgerHashes: [{ ledger: 1000, hash: 'abc' }],
    processedEventCount: 0,
    savedAt: new Date(),
    checkpointVersion: 1,
    ...overrides,
  };
}

describe('CursorManagerService', () => {
  let service: CursorManagerService;

  async function build(entity: Partial<IndexerCursorEntity> | null = null) {
    const repo = makeRepo(entity);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CursorManagerService,
        { provide: getRepositoryToken(IndexerCursorEntity), useValue: repo },
      ],
    }).compile();
    service = module.get<CursorManagerService>(CursorManagerService);
    return repo;
  }

  describe('getCursor', () => {
    it('returns null when no cursor row exists', async () => {
      await build(null);
      expect(await service.getCursor()).toBeNull();
    });

    it('returns cursor with ledgerHashes', async () => {
      await build(cursorRow({
        lastLedger: 1000,
        lastPagingToken: 'tok',
        ledgerHashes: [{ ledger: 999, hash: 'abc' }],
      }));
      const cursor = await service.getCursor();
      expect(cursor?.lastLedger).toBe(1000);
      expect(cursor?.ledgerHashes).toHaveLength(1);
    });
  });

  describe('checkForReorg', () => {
    it('returns null when no stored hash for that ledger', async () => {
      await build(cursorRow({ lastLedger: 1000, ledgerHashes: [] }));
      expect(await service.checkForReorg(1000, 'anyhash')).toBeNull();
    });

    it('returns null when hash matches', async () => {
      await build(cursorRow({
        lastLedger: 1000,
        ledgerHashes: [{ ledger: 1000, hash: 'correct' }],
      }));
      expect(await service.checkForReorg(1000, 'correct')).toBeNull();
    });

    it('returns divergence ledger when hash differs', async () => {
      await build(cursorRow({
        lastLedger: 1000,
        ledgerHashes: [{ ledger: 1000, hash: 'original' }],
      }));
      expect(await service.checkForReorg(1000, 'forked')).toBe(1000);
    });
  });

  describe('saveCursor', () => {
    it('appends new hash to the ring and upserts', async () => {
      const repo = await build(cursorRow({
        lastLedger: 999,
        ledgerHashes: [{ ledger: 999, hash: 'prev' }],
        processedEventCount: 10,
      }));

      // Load cursor first so lastCheckpoint is populated (needed for monotonicity check)
      await service.getCursor();
      await service.saveCursor(1000, 'newhash', 'token-1', 11);

      expect(repo.manager.upsert).toHaveBeenCalledWith(
        IndexerCursorEntity,
        expect.objectContaining({
          id: 1,
          lastLedger: 1000,
          lastPagingToken: 'token-1',
          ledgerHashes: [
            { ledger: 999, hash: 'prev' },
            { ledger: 1000, hash: 'newhash' },
          ],
        }),
        ['id'],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ReorgRollbackService
// ---------------------------------------------------------------------------
import { ReorgRollbackService, RollbackRequest } from './reorg-rollback.service';
import { DataSource } from 'typeorm';

function makeDataSource(queryMock: jest.Mock) {
  return {
    transaction: jest.fn().mockImplementation(async (cb: any) => {
      const manager = { query: queryMock };
      return cb(manager);
    }),
    query: queryMock,
    getRepository: jest.fn().mockReturnValue({
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockResolvedValue({ id: 'audit-id', ...({} as any) }),
    }),
  } as unknown as DataSource;
}

const baseRequest: RollbackRequest = {
  fromSequence: 1050,
  toSequence: 1060,
  forkHash: 'abc123',
  reason: 'HASH_MISMATCH',
};

describe('ReorgRollbackService', () => {
  let service: ReorgRollbackService;
  let queryMock: jest.Mock;
  let metricsMock: { incrementReorgDetected: jest.Mock };

  beforeEach(() => {
    queryMock = jest.fn().mockResolvedValue([[], 1]);
    metricsMock = { incrementReorgDetected: jest.fn() };
    service = new ReorgRollbackService(
      makeDataSource(queryMock) as DataSource,
      metricsMock as any,
    );
  });

  describe('executeRollback', () => {
    it('returns ok:true and deletes all entity types in range', async () => {
      const result = await service.executeRollback(baseRequest);
      expect(result.ok).toBe(true);

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM raffle_events'),
        [1050, 1060],
      );
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM tickets'),
        [1050, 1060],
      );
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM raffles'),
        [1050, 1060],
      );
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM users'),
        [1050, 1060],
      );
    });

    it('trims ledger_hashes ring inside the transaction', async () => {
      await service.executeRollback(baseRequest);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE indexer_cursor'),
        [1050],
      );
    });

    it('resets cursor to fromSequence - 1 after commit', async () => {
      await service.executeRollback(baseRequest);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('SET last_ledger'),
        [1049, 1050], // resetTo = 1050 - 1 = 1049
      );
    });

    it('cursor reset is NOT inside the transaction (called on dataSource directly)', async () => {
      // The transaction mock captures calls to manager.query.
      // The cursor reset must go through dataSource.query, not manager.query.
      // We verify by checking the transaction callback does NOT call SET last_ledger.
      let transactionManagerCalls: Array<[string, unknown[]]> = [];
      const trackingQuery = jest.fn().mockImplementation((sql: string, params: unknown[]) => {
        transactionManagerCalls.push([sql, params]);
        return Promise.resolve([[], 1]);
      });
      const ds = {
        transaction: jest.fn().mockImplementation(async (cb: any) => {
          const manager = { query: trackingQuery };
          return cb(manager);
        }),
        query: jest.fn().mockResolvedValue([[], 0]),
        getRepository: jest.fn().mockReturnValue({
          create: jest.fn().mockImplementation((v: any) => v),
          save: jest.fn().mockResolvedValue({ id: 'x' }),
        }),
      } as unknown as DataSource;

      const svc = new ReorgRollbackService(ds, metricsMock as any);
      await svc.executeRollback(baseRequest);

      const txSetLedger = transactionManagerCalls.some(([sql]) => sql.includes('SET last_ledger'));
      expect(txSetLedger).toBe(false);

      expect((ds.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('SET last_ledger'),
        expect.any(Array),
      );
    });

    it('returns PARTIAL_FAILURE with entity counts when cursor reset fails after commit', async () => {
      // Transaction succeeds, but cursor reset throws
      const cursorFailQuery = jest.fn()
        .mockResolvedValueOnce([[], 1]) // events
        .mockResolvedValueOnce([[], 2]) // tickets
        .mockResolvedValueOnce([[], 1]) // raffles
        .mockResolvedValueOnce([[], 0]) // users
        .mockResolvedValueOnce(undefined) // cursor ring trim
        .mockRejectedValueOnce(new Error('cursor update failed')); // cursor reset

      const ds = {
        transaction: jest.fn().mockImplementation(async (cb: any) => {
          const manager = { query: cursorFailQuery };
          return cb(manager);
        }),
        query: cursorFailQuery,
        getRepository: jest.fn().mockReturnValue({
          create: jest.fn().mockImplementation((v: any) => v),
          save: jest.fn().mockResolvedValue({ id: 'x' }),
        }),
      } as unknown as DataSource;

      const svc = new ReorgRollbackService(ds, metricsMock as any);
      const result = await svc.executeRollback(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CURSOR_RESET_FAILED');
        expect(result.audit.outcome).toBe('PARTIAL_FAILURE');
        // Entity counts must be preserved even though cursor reset failed
        expect(result.error.partialCounts.eventsRemoved).toBe(1);
        expect(result.error.partialCounts.ticketsReverted).toBe(2);
        expect(result.error.partialCounts.rafflesReverted).toBe(1);
      }
    });

    it('audit entry outcome is SUCCESS on full success', async () => {
      const result = await service.executeRollback(baseRequest);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.audit.outcome).toBe('SUCCESS');
    });

    it('audit entry outcome is TOTAL_FAILURE when transaction fails', async () => {
      const ds = {
        transaction: jest.fn().mockRejectedValue(new Error('tx fail')),
        query: jest.fn().mockResolvedValue([[], 0]),
        getRepository: jest.fn().mockReturnValue({
          create: jest.fn().mockImplementation((v: any) => v),
          save: jest.fn().mockResolvedValue({ id: 'x' }),
        }),
      } as unknown as DataSource;
      const svc = new ReorgRollbackService(ds, metricsMock as any);
      const result = await svc.executeRollback(baseRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.audit.outcome).toBe('TOTAL_FAILURE');
    });

    it('increments reorg metric on success', async () => {
      await service.executeRollback(baseRequest);
      expect(metricsMock.incrementReorgDetected).toHaveBeenCalled();
    });

    describe('input validation', () => {
      async function expectInvalid(overrides: Partial<RollbackRequest>) {
        const result = await service.executeRollback({ ...baseRequest, ...overrides });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_REQUEST');
          expect(result.audit.outcome).toBe('TOTAL_FAILURE');
        }
      }

      it('rejects toSequence < fromSequence', () =>
        expectInvalid({ fromSequence: 100, toSequence: 50 }));

      it('rejects fromSequence = 0', () =>
        expectInvalid({ fromSequence: 0, toSequence: 10 }));

      it('rejects fromSequence < 0', () =>
        expectInvalid({ fromSequence: -5, toSequence: 10 }));

      it('rejects empty forkHash', () =>
        expectInvalid({ forkHash: '' }));

      it('rejects whitespace-only forkHash', () =>
        expectInvalid({ forkHash: '   ' }));

      it('rejects unknown reason', () =>
        expectInvalid({ reason: 'UNKNOWN' as any }));

      it('does not open a transaction on invalid input', async () => {
        const txSpy = jest.spyOn((service as any).dataSource, 'transaction');
        await service.executeRollback({ ...baseRequest, fromSequence: 0 });
        expect(txSpy).not.toHaveBeenCalled();
      });
    });

    it('returns ok:false with TRANSACTION_FAILED when transaction throws', async () => {
      const failingDs = {
        transaction: jest.fn().mockRejectedValue(new Error('db error')),
        query: jest.fn().mockResolvedValue([[], 0]),
        getRepository: jest.fn().mockReturnValue({
          create: jest.fn().mockImplementation((v: any) => v),
          save: jest.fn().mockResolvedValue({ id: 'x' }),
        }),
      } as unknown as DataSource;
      const svc = new ReorgRollbackService(failingDs, metricsMock as any);
      const result = await svc.executeRollback(baseRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('TRANSACTION_FAILED');
    });
  });

  describe('entity coverage invariants', () => {
    it('deletes events before tickets before raffles (FK-safe order)', async () => {
      const callOrder: string[] = [];
      const orderedQuery = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('DELETE FROM raffle_events')) callOrder.push('events');
        else if (sql.includes('DELETE FROM tickets')) callOrder.push('tickets');
        else if (sql.includes('DELETE FROM raffles')) callOrder.push('raffles');
        else if (sql.includes('DELETE FROM users')) callOrder.push('users');
        return Promise.resolve([[], 1]);
      });
      const svc = new ReorgRollbackService(makeDataSource(orderedQuery) as DataSource, metricsMock as any);
      await svc.executeRollback(baseRequest);
      expect(callOrder.indexOf('events')).toBeLessThan(callOrder.indexOf('tickets'));
      expect(callOrder.indexOf('tickets')).toBeLessThan(callOrder.indexOf('raffles'));
    });

    it('user delete SQL includes NOT EXISTS guards for tickets and raffles', async () => {
      await service.executeRollback(baseRequest);
      const userCall = queryMock.mock.calls.find(
        ([sql]: [string]) => sql.includes('DELETE FROM users'),
      );
      expect(userCall).toBeDefined();
      const [sql] = userCall;
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('tickets');
      expect(sql).toContain('raffles');
    });

    it('never touches platform_stats', async () => {
      await service.executeRollback(baseRequest);
      const statsCalls = queryMock.mock.calls.filter(
        ([sql]: [string]) => sql.toLowerCase().includes('platform_stats'),
      );
      expect(statsCalls).toHaveLength(0);
    });

    it('entity counts in result reflect row counts returned by queries', async () => {
      const countedQuery = jest.fn()
        .mockResolvedValueOnce([[], 7])  // events
        .mockResolvedValueOnce([[], 3])  // tickets
        .mockResolvedValueOnce([[], 2])  // raffles
        .mockResolvedValueOnce([[], 1])  // users
        .mockResolvedValue(undefined);   // cursor ring trim + reset

      const svc = new ReorgRollbackService(makeDataSource(countedQuery) as DataSource, metricsMock as any);
      const result = await svc.executeRollback(baseRequest);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audit.entityCounts?.eventsRemoved).toBe(7);
        expect(result.audit.entityCounts?.ticketsReverted).toBe(3);
        expect(result.audit.entityCounts?.rafflesReverted).toBe(2);
        expect(result.audit.entityCounts?.usersReverted).toBe(1);
        expect(result.audit.entityCounts?.statsReverted).toBe(0);
      }
    });

    it('single-ledger range (fromSequence === toSequence) passes validation and executes', async () => {
      const result = await service.executeRollback({
        ...baseRequest,
        fromSequence: 1050,
        toSequence: 1050,
      });
      expect(result.ok).toBe(true);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM raffle_events'),
        [1050, 1050],
      );
    });

    it('statsReverted is always 0 in entity counts', async () => {
      const result = await service.executeRollback(baseRequest);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.audit.entityCounts?.statsReverted).toBe(0);
    });
  });
    it('delegates to executeRollback with HASH_MISMATCH reason', async () => {
      const spy = jest.spyOn(service, 'executeRollback').mockResolvedValue({
        ok: true,
        audit: {} as any,
      });
      await service.rollback(1050);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ fromSequence: 1050, reason: 'HASH_MISMATCH' }),
      );
    });
  });
});
