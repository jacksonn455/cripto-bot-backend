import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const INTERVALS = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
] as const;

export class GetCandlesQueryDto {
  @ApiPropertyOptional({ example: 'BTCUSDT' })
  @IsString()
  @Matches(/^[A-Z0-9]{5,20}$/, { message: 'symbol must look like BTCUSDT' })
  symbol: string = 'BTCUSDT';

  @ApiPropertyOptional({ enum: INTERVALS, default: '1h' })
  @IsIn(INTERVALS)
  interval: (typeof INTERVALS)[number] = '1h';

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 100;

  @ApiPropertyOptional({ description: 'Epoch ms, inclusive: first candle opening at/after this time' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  startTime?: number;

  @ApiPropertyOptional({ description: 'Epoch ms, inclusive: last candle opening at/before this time' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endTime?: number;
}
