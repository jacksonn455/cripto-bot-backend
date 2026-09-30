import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

export class EquityCurveQueryDto {
  @ApiPropertyOptional({ enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  @IsOptional()
  @IsIn(['BACKTEST', 'PAPER', 'LIVE'])
  mode?: 'BACKTEST' | 'PAPER' | 'LIVE';

  @ApiPropertyOptional({ description: 'Backtest run id' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on timestamp' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on timestamp' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
