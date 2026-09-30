import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { openAiConfig } from '../config/configuration';
import { AGENT_DEFINITIONS } from './agents/agent-definitions';
import { AiBusyError, AiDisabledError, AiError } from './ai.errors';
import { AGENT_KEYS, type AgentKey, type AgentRunInput, type AgentRunResult, type AiStatus } from './ai.types';
import { AGENT_RUNNER, type AgentRunner } from './providers/agent-runner.interface';
import { TradingDataTools } from './tools/trading-data.tools';

/**
 * Entry point of the AI layer. Nothing in strategy/risk/execution depends on it: if OpenAI is
 * disabled, misconfigured, slow or down, only /ai/* requests fail (503/504/502) and trading goes on.
 */
@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private running = 0;

  constructor(
    @Inject(openAiConfig.KEY) private readonly config: ReturnType<typeof openAiConfig>,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    private readonly tools: TradingDataTools,
  ) {}

  onModuleInit(): void {
    const status = this.status();
    if (status.enabled && status.configured) {
      this.logger.log(
        `[OpenAI] agents enabled (model=${status.model}, tracing=${status.tracingEnabled ? 'on' : 'off'}): ${AGENT_KEYS.join(', ')}`,
      );
    } else {
      this.logger.log(`[OpenAI] agents off: ${status.reason}`);
    }
  }

  status(): AiStatus {
    const reason = !this.config.agentsEnabled
      ? 'OPENAI_AGENTS_ENABLED is not true'
      : !this.config.apiKey
        ? 'OPENAI_API_KEY is not set'
        : undefined;
    return {
      enabled: this.config.agentsEnabled,
      configured: Boolean(this.config.apiKey),
      reason,
      model: this.config.model || 'sdk-default',
      tracingEnabled: this.config.tracingEnabled,
      agents: AGENT_KEYS.map((key) => ({
        key,
        name: AGENT_DEFINITIONS[key].name,
        description: AGENT_DEFINITIONS[key].description,
        tools: [...AGENT_DEFINITIONS[key].tools],
      })),
    };
  }

  async runAgent(key: AgentKey, input: AgentRunInput): Promise<AgentRunResult> {
    const status = this.status();
    if (status.reason) throw new AiDisabledError(status.reason);
    if (this.running >= this.config.maxConcurrentRuns) throw new AiBusyError(this.config.maxConcurrentRuns);

    const definition = AGENT_DEFINITIONS[key];
    const started = Date.now();
    this.running++;
    // Never logs the question itself (may contain anything) nor the key — only its size.
    this.logger.log(`[OpenAI] agent request started (agent=${key}, questionChars=${input.question?.length ?? 0})`);
    try {
      const result = await this.runner.run(definition, this.tools.get(definition.tools), buildUserMessage(input), {
        signal: AbortSignal.timeout(this.config.agentTimeoutMs),
        maxTurns: this.config.maxTurns,
      });
      const durationMs = Date.now() - started;
      this.logger.log(
        `[OpenAI] agent request completed (agent=${key}, ${durationMs}ms, requests=${result.usage.requests}, tokens=${result.usage.totalTokens})`,
      );
      return { agent: key, model: result.model, output: result.output, usage: result.usage, durationMs, advisoryOnly: true };
    } catch (err) {
      const message = err instanceof AiError ? err.message : (err as Error).message;
      this.logger.warn(`[OpenAI] agent request failed (agent=${key}, ${Date.now() - started}ms): ${message}`);
      throw err;
    } finally {
      this.running--;
    }
  }
}

/** Turns the request scope into the user message; tools still fetch the actual data. */
export function buildUserMessage(input: AgentRunInput): string {
  const scope = [
    input.mode ? `modo=${input.mode}` : null,
    input.symbol ? `símbolo=${input.symbol.toUpperCase()}` : null,
    input.from ? `de=${input.from}` : null,
    input.to ? `até=${input.to}` : null,
  ].filter(Boolean);
  return [
    `Data/hora atual (UTC): ${new Date().toISOString()}`,
    scope.length ? `Escopo pedido: ${scope.join(', ')}` : 'Escopo pedido: todos os dados disponíveis',
    `Pergunta: ${input.question?.trim() || 'Faça a análise padrão do seu papel.'}`,
  ].join('\n');
}
