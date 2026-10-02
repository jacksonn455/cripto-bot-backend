import { Inject, Injectable } from '@nestjs/common';
import { ControlService } from '../control/control.service';
import { CANDIDATE_LEDGER_STORE, type CandidateLedgerStore, type CandidateQuery } from './candidate-ledger.store';
import { summarizeFunnel, type CandidateFunnel } from './candidate-funnel';
import type { CandidateRecord } from './candidate.types';
import type { CandidateFilterQueryDto, GetCandidatesQueryDto } from './dto/get-candidates-query.dto';

export interface PauseImpact {
  pausedAt: Date;
  resumedAt: Date | null;
  durationMs: number;
  reason: string;
  additionalReasons: Array<{ reason: string; at: Date }>;
  /** Candidates while this pause lasted, at any stage. */
  candidates: number;
  /** Strategy-accepted entries vetoed with BOT_PAUSED. */
  blockedByPause: number;
  /** Of those, entries RiskManager would have approved right after a manual resume. */
  wouldTradeIfResumed: number;
  blockedShadow: CandidateFunnel['paused']['blockedShadow'];
}

@Injectable()
export class CandidatesService {
  constructor(
    @Inject(CANDIDATE_LEDGER_STORE) private readonly store: CandidateLedgerStore,
    private readonly control: ControlService,
  ) {}

  async list(query: GetCandidatesQueryDto): Promise<{ items: CandidateRecord[]; total: number; page: number; limit: number }> {
    const filter = toQuery(query);
    const [items, total] = await Promise.all([
      this.store.find({ ...filter, skip: (query.page - 1) * query.limit, limit: query.limit }),
      this.store.count(filter),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async funnel(query: CandidateFilterQueryDto): Promise<CandidateFunnel> {
    return summarizeFunnel(await this.store.find(toQuery(query)));
  }

  /** Each pause episode with what it cost: candidates seen, entries it blocked, and their shadow outcome. */
  async pauseImpact(limit = 20, now = Date.now()): Promise<PauseImpact[]> {
    const episodes = await this.control.listPauseEpisodes(limit);
    return Promise.all(
      episodes.map(async (e) => {
        const from = new Date(e.pausedAt).getTime();
        const to = e.resumedAt ? new Date(e.resumedAt).getTime() : now;
        const records = (await this.store.find({ mode: e.mode, from, to })).filter((r) => r.botPaused);
        const f = summarizeFunnel(records);
        return {
          pausedAt: e.pausedAt,
          resumedAt: e.resumedAt ?? null,
          durationMs: e.durationMs ?? to - from,
          reason: e.reason,
          additionalReasons: e.additionalReasons ?? [],
          candidates: f.total,
          blockedByPause: f.paused.blockedByPause,
          wouldTradeIfResumed: f.paused.wouldTradeIfResumed,
          blockedShadow: f.paused.blockedShadow,
        };
      }),
    );
  }
}

function toQuery(q: CandidateFilterQueryDto): CandidateQuery {
  return {
    mode: q.mode,
    runId: q.runId,
    symbol: q.symbol,
    side: q.side,
    setupType: q.setupType,
    from: q.from ? new Date(q.from).getTime() : undefined,
    to: q.to ? new Date(q.to).getTime() : undefined,
  };
}
