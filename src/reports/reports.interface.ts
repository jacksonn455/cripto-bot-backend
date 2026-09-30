import type { MetricsSummary } from './metrics.util';

export const REPORT_DATE_FIELDS = ['entryTime', 'exitTime'] as const;
export type ReportDateField = (typeof REPORT_DATE_FIELDS)[number];

export interface ReportsFilter {
  mode?: string;
  symbol?: string;
  strategy?: string;
  from?: string;
  to?: string;
  /** Trade date that from/to apply to; defaults to entryTime. */
  dateField?: ReportDateField;
  /** Backtest run id. */
  runId?: string;
}

export interface EquityCurveFilter {
  mode?: string;
  runId?: string;
  from?: string;
  to?: string;
}

export interface GroupedMetric {
  key: string;
  tradeCount: number;
  totalPnl: number;
  winRate: number;
  profitFactor: number;
}

/** One column of GET /reports/compare-modes. */
export interface ModeComparison {
  mode: 'BACKTEST' | 'PAPER' | 'LIVE';
  /** Which backtest run the BACKTEST column covers (null = all runs, or not a backtest). */
  runId: string | null;
  summary: MetricsSummary;
}
