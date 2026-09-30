import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ByHourQueryDto } from './dto/by-hour-query.dto';
import { EquityCurveQueryDto } from './dto/equity-curve-query.dto';
import { PaginatedReportsFilterQueryDto } from './dto/paginated-reports-filter-query.dto';
import { ReportsFilterQueryDto } from './dto/reports-filter-query.dto';
import { EquitySnapshotsService } from './equity-snapshots.service';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly equitySnapshots: EquitySnapshotsService,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'PnL, win rate, drawdown, Sharpe/Sortino and more over closed trades' })
  summary(@Query() query: ReportsFilterQueryDto) {
    return this.reports.summary(query);
  }

  @Get('equity-curve')
  @ApiOperation({ summary: 'Equity curve points for a mode/run, optionally within a time range' })
  equityCurve(@Query() query: EquityCurveQueryDto) {
    return this.equitySnapshots.findCurve(query);
  }

  @Get('by-strategy')
  @ApiOperation({ summary: 'Aggregated performance grouped by strategy' })
  byStrategy(@Query() query: PaginatedReportsFilterQueryDto) {
    return this.reports.byStrategy(query, query.page, query.limit);
  }

  @Get('by-symbol')
  @ApiOperation({ summary: 'Aggregated performance grouped by symbol' })
  bySymbol(@Query() query: PaginatedReportsFilterQueryDto) {
    return this.reports.bySymbol(query, query.page, query.limit);
  }

  @Get('by-hour')
  @ApiOperation({ summary: 'Aggregated performance by hour of day and day of week (exit time, in `tz`)' })
  byHour(@Query() query: ByHourQueryDto) {
    const { tz, ...filter } = query;
    return this.reports.byHour(filter, tz);
  }

  @Get('compare-modes')
  @ApiOperation({
    summary: 'Full metrics per mode side by side (BACKTEST vs PAPER vs LIVE)',
    description:
      'Always returns the three modes. `runId` selects the backtest run (default: all runs); ' +
      '`from`/`to`/`dateField` apply only to PAPER and LIVE. `mode` is ignored.',
  })
  compareModes(@Query() query: ReportsFilterQueryDto) {
    return this.reports.compareModes({
      symbol: query.symbol,
      strategy: query.strategy,
      from: query.from,
      to: query.to,
      dateField: query.dateField,
      runId: query.runId,
    });
  }
}
