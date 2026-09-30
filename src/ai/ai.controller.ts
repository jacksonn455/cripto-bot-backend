import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ControlApiKeyGuard } from '../control/control-api-key.guard';
import { AiError } from './ai.errors';
import { AiService } from './ai.service';
import { AGENT_KEYS, type AgentKey } from './ai.types';
import { RunAgentDto } from './dto/run-agent.dto';

const AGENT_ENUM = Object.fromEntries(AGENT_KEYS.map((k) => [k, k])) as Record<AgentKey, AgentKey>;

/**
 * Advisory AI endpoints. Runs are guarded by X-Control-Api-Key (each call costs money and reads
 * trading data) and rate limited; results are returned to the caller only — never acted upon.
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether OpenAI agents are enabled/configured, the model and the available agents' })
  status() {
    return this.ai.status();
  }

  @Post('agents/:agent/run')
  @UseGuards(ControlApiKeyGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam({ name: 'agent', enum: AGENT_KEYS })
  @ApiOperation({
    summary: 'Runs one analysis agent (read-only tools) and returns its structured, advisory answer',
    description:
      'Requires X-Control-Api-Key when CONTROL_API_KEY is set. 503 = agents disabled/misconfigured, ' +
      '504 = timeout, 502 = OpenAI error, 429 = too many concurrent runs.',
  })
  async run(@Param('agent', new ParseEnumPipe(AGENT_ENUM)) agent: AgentKey, @Body() body: RunAgentDto) {
    try {
      return await this.ai.runAgent(agent, body);
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

function toHttpException(err: unknown): Error {
  if (!(err instanceof AiError)) return err as Error;
  switch (err.kind) {
    case 'disabled':
      return new ServiceUnavailableException(`AI agents unavailable: ${err.message}`);
    case 'timeout':
      return new GatewayTimeoutException(err.message);
    case 'busy':
      return new HttpException(err.message, HttpStatus.TOO_MANY_REQUESTS);
    default:
      return new BadGatewayException(err.message);
  }
}
