import type { EvaluationSnapshot, EvaluationSnapshotStore } from './evaluation-snapshot.store';

const HOUR = 3_600_000;

export function snapshot(overrides: Partial<EvaluationSnapshot> = {}): EvaluationSnapshot {
  return {
    mode: 'PAPER',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    regimeTimeframe: '4h',
    candleOpenTime: 15 * HOUR,
    candleCloseTime: 16 * HOUR - 1,
    evaluatedAt: new Date('2026-10-01T16:00:30Z'),
    source: 'cycle',
    action: 'HOLD',
    reason: 'sem cruzamento EMA rapida/lenta',
    price: 64_000,
    indicators: { emaFast: 63_900, emaSlow: 64_100, emaRegime: 61_000, rsi: 55 },
    side: 'LONG',
    conditions: [
      { key: 'cross', ok: false, value: 63_900, threshold: 'EMA50 64100.00', message: 'x' },
      { key: 'regime', ok: true, value: 64_000, threshold: 'EMA200 (4h) 61000.00', message: 'y' },
      { key: 'rsi', ok: true, value: 55, threshold: '45 a 70', message: 'z' },
    ],
    decision: { outcome: 'NOT_ENTERED', reason: 'sem cruzamento EMA rapida/lenta' },
    ...overrides,
  };
}

/** Behavior both stores must share; run by the in-memory spec and the real-MongoDB one. */
export function evaluationSnapshotStoreContract(makeStore: () => EvaluationSnapshotStore) {
  let store: EvaluationSnapshotStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns null for a symbol never evaluated', async () => {
    await expect(store.get('PAPER', 'BTCUSDT')).resolves.toBeNull();
  });

  it('stores and returns the snapshot', async () => {
    await expect(store.save(snapshot())).resolves.toBe(true);
    await expect(store.get('PAPER', 'BTCUSDT')).resolves.toEqual({ snapshot: snapshot(), lastError: null, lastErrorAt: null });
  });

  it('a reconciliation never replaces a stored snapshot of the same candle (cycle or reconciliation)', async () => {
    await store.save(snapshot());
    await expect(store.save(snapshot({ source: 'reconciliation', action: 'ENTER_LONG' }))).resolves.toBe(false);
    expect((await store.get('PAPER', 'BTCUSDT'))!.snapshot).toEqual(snapshot());

    await store.save(snapshot({ symbol: 'ETHUSDT', source: 'reconciliation' }));
    await expect(store.save(snapshot({ symbol: 'ETHUSDT', source: 'reconciliation', reason: 'again' }))).resolves.toBe(false);
  });

  it('a cycle replaces a reconciliation of the same candle, and anything older', async () => {
    await store.save(snapshot({ source: 'reconciliation' }));
    await expect(store.save(snapshot({ source: 'cycle', action: 'ENTER_LONG' }))).resolves.toBe(true);
    const next = snapshot({ candleOpenTime: 16 * HOUR, candleCloseTime: 17 * HOUR - 1, side: undefined, conditions: undefined });
    await expect(store.save(next)).resolves.toBe(true);
    // Optional fields absent in the new snapshot don't linger from the previous one.
    expect((await store.get('PAPER', 'BTCUSDT'))!.snapshot).toEqual(next);
  });

  it('never goes back to an older candle', async () => {
    await store.save(snapshot({ candleCloseTime: 17 * HOUR - 1 }));
    await expect(store.save(snapshot())).resolves.toBe(false);
    await expect(store.save(snapshot({ source: 'reconciliation' }))).resolves.toBe(false);
  });

  it('keeps an error next to the snapshot until cleared (or a new snapshot is stored)', async () => {
    const at = new Date('2026-10-01T16:05:00Z');
    await store.recordError('PAPER', 'ETHUSDT', 'HTTP 451', at);
    await expect(store.get('PAPER', 'ETHUSDT')).resolves.toEqual({ snapshot: null, lastError: 'HTTP 451', lastErrorAt: at });

    await store.save(snapshot());
    await store.recordError('PAPER', 'BTCUSDT', 'timeout', at);
    await expect(store.get('PAPER', 'BTCUSDT')).resolves.toMatchObject({ snapshot: snapshot(), lastError: 'timeout' });
    await store.clearError('PAPER', 'BTCUSDT');
    await expect(store.get('PAPER', 'BTCUSDT')).resolves.toMatchObject({ snapshot: snapshot(), lastError: null });

    await store.save(snapshot({ symbol: 'ETHUSDT' }));
    await expect(store.get('PAPER', 'ETHUSDT')).resolves.toMatchObject({ lastError: null });
  });

  it('lists per mode', async () => {
    await store.save(snapshot());
    await store.save(snapshot({ symbol: 'ETHUSDT' }));
    await store.save(snapshot({ mode: 'LIVE' }));
    const symbols = (await store.list('PAPER')).map((s) => s.symbol).sort();
    expect(symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
}
