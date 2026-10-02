import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export class CandidateFilterQueryDto {
  @ApiPropertyOptional({ enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  @IsOptional()
  @IsIn(['BACKTEST', 'PAPER', 'LIVE'])
  mode?: 'BACKTEST' | 'PAPER' | 'LIVE';

  @ApiPropertyOptional({ description: 'Backtest run id (runs created with recordCandidates: true)' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ example: 'BTCUSDT' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ enum: ['LONG', 'SHORT'] })
  @IsOptional()
  @IsIn(['LONG', 'SHORT'])
  side?: 'LONG' | 'SHORT';

  @ApiPropertyOptional({ enum: ['EMA_CROSS', 'PULLBACK'] })
  @IsOptional()
  @IsIn(['EMA_CROSS', 'PULLBACK'])
  setupType?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on the candidate candle close' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on the candidate candle close' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class GetCandidatesQueryDto extends CandidateFilterQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
