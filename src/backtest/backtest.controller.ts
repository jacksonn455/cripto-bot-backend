import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BacktestService, MAX_PBO_RUNS } from './backtest.service';
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

class CompareRunsQueryDto {
  @ApiProperty({ description: 'runId of the baseline (e.g. the current strategy)' })
  @IsString()
  baseline: string;

  @ApiProperty({ description: 'runId of the variant being tested' })
  @IsString()
  variant: string;
}

class PboQueryDto {
  @ApiProperty({ description: `2–${MAX_PBO_RUNS} runIds, comma-separated, all with the same walk-forward windows` })
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_PBO_RUNS)
  @IsString({ each: true })
  runIds: string[];
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

  @Get('compare')
  @ApiOperation({
    summary: 'Baseline vs variant, walk-forward window by window',
    description:
      'Share of the out-of-sample windows in which the variant beat the baseline (PnL, profit factor, ' +
      'expectancy), whether the runs are comparable at all, and whether the sample is too small ' +
      '(fewer than 30 trades on a traded side = inconclusive).',
  })
  compare(@Query() query: CompareRunsQueryDto) {
    return this.backtestService.compare(query.baseline, query.variant);
  }

  @Get('pbo')
  @ApiOperation({
    summary: 'Probability of Backtest Overfitting (CSCV) over several variants',
    description:
      'Bailey, Borwein, López de Prado & Zhu (2015): over every half/half split of the walk-forward ' +
      'windows, how often the in-sample best variant ends at or below the median out of sample.',
  })
  pbo(@Query() query: PboQueryDto) {
    return this.backtestService.pbo(query.runIds);
  }
}
