import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

class ListRunsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  strategy?: string;

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
}

@ApiTags('backtest')
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post('run')
  @ApiOperation({ summary: 'Run a backtest (optionally with walk-forward windows)' })
  run(@Body() dto: RunBacktestDto) {
    return this.backtestService.run(dto);
  }

  @Get('runs')
  @ApiOperation({ summary: 'Past backtest runs, newest first, paginated' })
  listRuns(@Query() query: ListRunsQueryDto) {
    return this.backtestService.listRuns(query);
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a single backtest run by id' })
  async getRun(@Param('runId') runId: string) {
    const run = await this.backtestService.getRun(runId);
    if (!run) {
      throw new NotFoundException(`Backtest run ${runId} not found`);
    }
    return run;
  }
}
