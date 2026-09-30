import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { GetTradesQueryDto } from './dto/get-trades-query.dto';
import { TradesService } from './trades.service';

@ApiTags('trades')
@Controller('trades')
export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  @Get()
  @ApiOperation({ summary: 'List trades with filters, sorting and pagination' })
  @ApiOkResponse({ description: 'Paginated list of trades' })
  findAll(@Query() query: GetTradesQueryDto) {
    return this.tradesService.findAll(query);
  }

  @Get('export.csv')
  @ApiOperation({ summary: 'Export filtered trades as CSV' })
  async exportCsv(@Query() query: GetTradesQueryDto, @Res() res: Response) {
    const csv = await this.tradesService.exportCsv(query);
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', 'attachment; filename="trades.csv"');
    res.send(csv);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single trade by id' })
  findOne(@Param('id') id: string) {
    return this.tradesService.findOne(id);
  }
}
