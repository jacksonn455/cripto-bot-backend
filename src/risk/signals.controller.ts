import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetSignalsQueryDto } from './dto/get-signals-query.dto';
import { SignalsService } from './signals.service';

@ApiTags('signals')
@Controller('signals')
export class SignalsController {
  constructor(private readonly signals: SignalsService) {}

  @Get()
  @ApiOperation({
    summary: 'Entry signals evaluated by risk, including vetoed ones (rejectReason), newest first',
    description:
      'Paper/live record one row per entry signal the risk manager evaluated. HOLD/exit decisions are ' +
      'not stored here (the latest one per symbol is in GET /bot/status). Backtests store their ' +
      'evaluated signals too, tagged with runId.',
  })
  list(@Query() query: GetSignalsQueryDto) {
    return this.signals.list(query);
  }
}
