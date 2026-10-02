import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ControlApiKeyGuard } from '../control/control-api-key.guard';
import { CandidatesService } from './candidates.service';
import { CandidateFilterQueryDto, GetCandidatesQueryDto } from './dto/get-candidates-query.dto';
import { ShadowOutcomeService } from './shadow-outcome.service';

@ApiTags('candidates')
@Controller('candidates')
export class CandidatesController {
  constructor(
    private readonly candidates: CandidatesService,
    private readonly shadow: ShadowOutcomeService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Candidate ledger, newest first: every triggered entry setup, accepted or rejected',
    description:
      'Each row: gates and where the candidate left the funnel (rejectedAt), features, the risk/pause ' +
      'outcome, the shadow outcome (what it would have done if traded) and, in AI_JUDGE_MODE=shadow, ' +
      'the judge assessment. Observability only: nothing here is read for trading.',
  })
  list(@Query() query: GetCandidatesQueryDto) {
    return this.candidates.list(query);
  }

  @Get('funnel')
  @ApiOperation({
    summary: 'Candidates → strategy gates → pause → risk → entered, with shadow R per rejection stage',
  })
  funnel(@Query() query: CandidateFilterQueryDto) {
    return this.candidates.funnel(query);
  }

  @Get('pauses')
  @ApiOperation({ summary: 'Pause episodes with the candidates they blocked and those candidates\' shadow outcome' })
  pauses() {
    return this.candidates.pauseImpact();
  }

  @Post('shadow/refresh')
  @UseGuards(ControlApiKeyGuard)
  @ApiOperation({ summary: 'Compute pending shadow outcomes of paper/live candidates now (reads market data only)' })
  refreshShadow() {
    return this.shadow.refreshPending();
  }
}
