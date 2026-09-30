import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { REPORT_DATE_FIELDS, type ReportDateField } from '../reports.interface';

export class ReportsFilterQueryDto {
  @ApiPropertyOptional({ enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  @IsOptional()
  @IsIn(['BACKTEST', 'PAPER', 'LIVE'])
  mode?: 'BACKTEST' | 'PAPER' | 'LIVE';

  @ApiPropertyOptional({ example: 'BTCUSDT' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  strategy?: string;

  @ApiPropertyOptional({ description: 'Backtest run id (only trades of that execution)' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on `dateField`' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on `dateField`' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: REPORT_DATE_FIELDS,
    default: 'entryTime',
    description: 'Which trade date from/to apply to. Use exitTime for "PnL realized in this period".',
  })
  @IsOptional()
  @IsIn(REPORT_DATE_FIELDS)
  dateField?: ReportDateField;
}
