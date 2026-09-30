import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class WalkForwardDto {
  @ApiProperty({ description: 'Length of each walk-forward test window, in days', minimum: 1 })
  @IsInt()
  @IsPositive()
  testWindowDays: number;
}

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

export class RunBacktestDto {
  @ApiProperty({ example: 'TrendRegimeStrategy' })
  @IsString()
  strategy: string;

  @ApiPropertyOptional({ example: 'BTCUSDT', description: 'One symbol (kept for compatibility); or use `symbols`' })
  @IsOptional()
  @Matches(SYMBOL_RE, { message: 'symbol must look like BTCUSDT' })
  symbol?: string;

  @ApiPropertyOptional({
    example: ['BTCUSDT', 'ETHUSDT'],
    description:
      'Up to 10 symbols. The initial balance is split equally and each symbol is simulated on its own ' +
      '(fixed allocation, no shared margin); the run reports the combined result.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(SYMBOL_RE, { each: true, message: 'each symbol must look like BTCUSDT' })
  symbols?: string[];

  @ApiProperty({ example: '1h' })
  @IsIn(INTERVALS)
  timeframe: string;

  @ApiPropertyOptional({
    example: '4h',
    description:
      'Timeframe of the regime filter candles. Defaults to TREND_REGIME_TIMEFRAME, the one the live ' +
      'loop uses; equal to `timeframe` = regime computed on the same candles.',
  })
  @IsOptional()
  @IsIn(INTERVALS)
  regimeTimeframe?: string;

  @ApiProperty({ description: 'ISO date, inclusive start' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO date, inclusive end' })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({ default: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  initialBalance: number = 10000;

  @ApiPropertyOptional({ default: 0.001, description: '0.001 = 0.1% per side' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  feesPct: number = 0.001;

  @ApiPropertyOptional({ default: 0.0005 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  slippagePct: number = 0.0005;

  @ApiPropertyOptional({
    default: 0.0003,
    description:
      'Short carry cost per day held, as a fraction of the entry notional (0.0003 = 0.03%/day, ' +
      '≈ the 0.01%/8h interest component of Binance perpetual funding). Only charged on SHORT ' +
      'trades; 0 = not modeled.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.05)
  shortBorrowPctPerDay: number = 0.0003;

  @ApiPropertyOptional({
    type: WalkForwardDto,
    description:
      'When set, splits [from,to] into consecutive test windows and reports a result per window ' +
      '(v1: no automatic parameter re-optimization per window, only sequential out-of-sample runs).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WalkForwardDto)
  walkForward?: WalkForwardDto;

  @ApiPropertyOptional({
    description:
      'Overrides for the strategy parameters (see GET /strategies), e.g. { "emaFast": 10 } or ' +
      '{ "allowShort": 1 } to compare long-only (baseline) vs long+short. ' +
      'Unspecified ones keep their configured value. Part of the params hash, so each distinct ' +
      'combination counts as one more tested variation.',
    example: { emaFast: 10, emaSlow: 40 },
  })
  @IsOptional()
  @IsObject()
  strategyParams?: Record<string, unknown>;
}
