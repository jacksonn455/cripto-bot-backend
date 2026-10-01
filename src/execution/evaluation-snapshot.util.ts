import type { ConditionResult, EvaluationSnapshot } from '../control/evaluation-snapshot.store';
import type { Candle } from '../exchange/types/candle.type';
import type { EntryConditions, Signal } from '../strategy/strategy.interface';

export interface SnapshotLabels {
  emaFast: number;
  emaSlow: number;
  emaRegime: number;
  timeframe: string;
  regimeTimeframe: string;
}

const fmt = (v: number | undefined) => (v === undefined ? 'n/d' : v.toFixed(2));

/** The strategy's own condition verdicts, with the values and limits it compared, in words. */
export function conditionResults(c: EntryConditions, labels: SnapshotLabels): ConditionResult[] {
  const short = c.side === 'SHORT';
  const fast = `EMA${labels.emaFast}`;
  const slow = `EMA${labels.emaSlow}`;
  const regimeEma = `EMA${labels.emaRegime} (${labels.regimeTimeframe})`;
  const band = c.regime.bandPct > 0 ? ` com banda de ${(c.regime.bandPct * 100).toFixed(2)}%` : '';
  return [
    {
      key: 'cross',
      ok: c.cross.ok,
      value: c.cross.emaFast ?? null,
      threshold: `${slow} ${fmt(c.cross.emaSlow)}`,
      message: c.cross.ok
        ? `${fast} cruzou ${short ? 'abaixo' : 'acima'} da ${slow} neste candle`
        : `${fast} ${fmt(c.cross.emaFast)} não cruzou ${short ? 'abaixo' : 'acima'} da ${slow} ${fmt(c.cross.emaSlow)} neste candle`,
    },
    {
      key: 'regime',
      ok: c.regime.ok,
      value: c.regime.close,
      threshold: `${regimeEma} ${fmt(c.regime.ema)}`,
      message:
        c.regime.ema === undefined
          ? `${regimeEma} ainda sem histórico suficiente`
          : `Fechamento ${fmt(c.regime.close)} ${c.regime.ok ? (short ? 'abaixo' : 'acima') : short ? 'não está abaixo' : 'não está acima'} da ${regimeEma} ${fmt(c.regime.ema)}${band}`,
    },
    {
      key: 'rsi',
      ok: c.rsi.ok,
      value: c.rsi.value ?? null,
      threshold: `${c.rsi.min} a ${c.rsi.max}`,
      message:
        c.rsi.value === undefined
          ? 'RSI ainda sem histórico suficiente'
          : `RSI ${c.rsi.value.toFixed(1)} ${c.rsi.ok ? 'dentro' : 'fora'} da faixa ${c.rsi.min} a ${c.rsi.max}`,
    },
  ];
}

/** Snapshot of one evaluated candle; `signal` null = the strategy couldn't evaluate (SKIP). */
export function buildSnapshot(args: {
  mode: string;
  symbol: string;
  candle: Candle;
  signal: Signal | null;
  decision: EvaluationSnapshot['decision'];
  source: EvaluationSnapshot['source'];
  labels: SnapshotLabels;
  now?: Date;
}): EvaluationSnapshot {
  const { signal, labels } = args;
  const base = {
    mode: args.mode,
    symbol: args.symbol,
    timeframe: labels.timeframe,
    regimeTimeframe: labels.regimeTimeframe,
    candleOpenTime: args.candle.openTime,
    candleCloseTime: args.candle.closeTime,
    evaluatedAt: args.now ?? new Date(),
    source: args.source,
    decision: args.decision,
  };
  if (!signal) {
    return { ...base, action: 'SKIP', reason: 'strategy evaluation failed or not enough candle history yet', indicators: {} };
  }
  return {
    ...base,
    action: signal.action === 'NONE' ? 'HOLD' : signal.action,
    reason: signal.reason,
    price: signal.price,
    indicators: signal.indicators,
    ...(signal.conditions
      ? { side: signal.conditions.side, conditions: conditionResults(signal.conditions, labels) }
      : {}),
  };
}
