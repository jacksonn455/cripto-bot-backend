import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { FUNDING_ORDERS, FundingService, type FundingOrder } from './funding.service';

class FundingRankingQueryDto {
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

  @ApiPropertyOptional({ description: 'Symbol substring, case-insensitive (e.g. "doge")', example: 'BTC' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,20}$/, { message: 'search must be letters/digits only' })
  search?: string;

  @ApiPropertyOptional({
    enum: FUNDING_ORDERS,
    default: 'desc',
    description: 'desc = highest (longs pay most), asc = lowest/negative (shorts pay), abs = largest in magnitude',
  })
  @IsOptional()
  @IsIn(FUNDING_ORDERS)
  order: FundingOrder = 'desc';
}

@ApiTags('funding')
@Controller('funding')
export class FundingController {
  constructor(private readonly fundingService: FundingService) {}

  @Get('ranking')
  @ApiOperation({
    summary: 'Perpetual funding rates of the latest scan: one page + whole-scan stats + the bot symbols (read-only)',
  })
  getRanking(@Query() query: FundingRankingQueryDto) {
    return this.fundingService.getPage(query);
  }
}
