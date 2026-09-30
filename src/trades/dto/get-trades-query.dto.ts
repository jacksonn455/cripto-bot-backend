import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const SORTABLE_FIELDS = ['entryTime', 'exitTime', 'pnl', 'pnlPct'] as const;

export class GetTradesQueryDto {
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

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'] })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';

  @ApiPropertyOptional({ description: 'Backtest run id (trades of one backtest execution)' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: 'true = only seed (fake) trades, false = only real ones' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isSeed?: boolean;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on entryTime' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on entryTime' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;

  @ApiPropertyOptional({ enum: SORTABLE_FIELDS, default: 'entryTime' })
  @IsOptional()
  @IsIn(SORTABLE_FIELDS)
  sortBy: (typeof SORTABLE_FIELDS)[number] = 'entryTime';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}
