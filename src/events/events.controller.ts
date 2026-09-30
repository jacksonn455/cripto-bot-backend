import { Controller, Get, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { Observable } from 'rxjs';
import { EventsService } from './events.service';

class RecentEventsQueryDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ description: 'Event id: return events older than this one (paging)' })
  @IsOptional()
  @IsMongoId()
  before?: string;
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.eventsService.asObservable();
  }

  @Get('recent')
  @ApiOperation({ summary: 'Event history (last 30 days), newest first — same types and ids as the SSE stream' })
  recent(@Query() query: RecentEventsQueryDto) {
    return this.eventsService.recent(query.limit, query.before);
  }
}
