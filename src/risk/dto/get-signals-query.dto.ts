import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetSignalsQueryDto {
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

  @ApiPropertyOptional({ description: 'true = approved by risk, false = vetoed' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  approved?: boolean;

  @ApiPropertyOptional({ description: 'Backtest run id' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on candleTime' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on candleTime' })
  @IsOptional()
  @IsISO8601()
  to?: string;

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
