import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  Agent,
  AgentsError,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  tool,
  type Tool,
} from '@openai/agents';
import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { openAiConfig } from '../../config/configuration';
import type { AgentDefinition } from '../agents/agent-definitions';
import { AiProviderError, AiTimeoutError } from '../ai.errors';
import { AnalysisOutputSchema, type AgentUsage } from '../ai.types';
import type { AiToolSpec } from '../tools/ai-tool';
import { assertToolsAllowed, limitToolOutput } from '../tools/tool-policy';
import type { AgentRunner, AgentRunnerResult, AgentRunOptions } from './agent-runner.interface';

/** Optional fetch override for the OpenAI client (tests); production uses the global fetch. */
export const OPENAI_FETCH = Symbol('OPENAI_FETCH');

/**
 * The only place that touches the OpenAI Agents SDK. Uses its own OpenAI client (key, timeout,
 * retries from env) through a Runner instead of the SDK's global defaults, so the key is never
 * read from anywhere else and nothing leaks into other SDK users in the process.
 */
@Injectable()
export class OpenAiAgentsRunner implements AgentRunner {
  private readonly logger = new Logger(OpenAiAgentsRunner.name);
  private runner?: Runner;

  constructor(
    @Inject(openAiConfig.KEY) private readonly config: ReturnType<typeof openAiConfig>,
    @Optional() @Inject(OPENAI_FETCH) private readonly fetchImpl?: typeof fetch,
  ) {
    if (!config.tracingEnabled) setTracingDisabled(true);
  }

  async run(definition: AgentDefinition, tools: AiToolSpec[], input: string, options: AgentRunOptions): Promise<AgentRunnerResult> {
    // The safety boundary is checked on every run, before any network call.
    assertToolsAllowed(definition.name, tools);

    const agent = new Agent({
      name: definition.name,
      instructions: definition.instructions,
      ...(this.config.model ? { model: this.config.model } : {}),
      tools: tools.map((t) => this.toSdkTool(t)),
      outputType: AnalysisOutputSchema,
    });

    try {
      const result = await this.getRunner().run(agent, input, { maxTurns: options.maxTurns, signal: options.signal });
      const output = AnalysisOutputSchema.safeParse(result.finalOutput);
      if (!output.success) throw new AiProviderError('agent returned an output that does not match the schema');
      return {
        output: output.data,
        usage: sumUsage(result.rawResponses),
        model: this.config.model || 'sdk-default',
      };
    } catch (err) {
      throw this.mapError(err, options.signal);
    }
  }

  private getRunner(): Runner {
    this.runner ??= new Runner({
      modelProvider: new OpenAIProvider({
        openAIClient: new OpenAI({
          apiKey: this.config.apiKey,
          timeout: this.config.requestTimeoutMs,
          maxRetries: this.config.maxRetries,
          ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
        }),
      }),
      tracingDisabled: !this.config.tracingEnabled,
    });
    return this.runner;
  }

  private toSdkTool(spec: AiToolSpec): Tool {
    return tool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (input: unknown) => {
        const started = Date.now();
        try {
          const result = await spec.execute(input as never);
          this.logger.debug(`[OpenAI] tool ${spec.name} ok (${Date.now() - started}ms)`);
          return limitToolOutput(result);
        } catch (err) {
          // Returned to the model as data (it can explain the gap) instead of aborting the run.
          this.logger.warn(`[OpenAI] tool ${spec.name} failed: ${(err as Error).message}`);
          return limitToolOutput({ error: `tool failed: ${(err as Error).message}` });
        }
      },
    });
  }

  /** Translates SDK/HTTP errors into AiErrors with messages that are safe to return and log. */
  private mapError(err: unknown, signal: AbortSignal): Error {
    if (err instanceof AiProviderError) return err;
    const e = err as Error;
    if (
      signal.aborted ||
      err instanceof APIUserAbortError ||
      err instanceof APIConnectionTimeoutError ||
      e?.name === 'AbortError' ||
      e?.name === 'TimeoutError'
    ) {
      return new AiTimeoutError(this.config.agentTimeoutMs);
    }
    if (err instanceof APIError) {
      return new AiProviderError(`OpenAI API error${err.status ? ` (HTTP ${err.status})` : ''}: ${describeApiError(err)}`, err.status);
    }
    if (err instanceof MaxTurnsExceededError) {
      return new AiProviderError(`agent exceeded ${this.config.maxTurns} turns without an answer`);
    }
    if (err instanceof ModelBehaviorError) return new AiProviderError(`model misbehaved: ${e.message}`);
    if (err instanceof AgentsError) return new AiProviderError(`agent error: ${e.message}`);
    return new AiProviderError(`unexpected agent error: ${e?.message ?? String(err)}`);
  }
}

function describeApiError(err: APIError): string {
  if (err.status === 401) return 'invalid or revoked OPENAI_API_KEY';
  if (err.status === 429) return 'rate limit or quota exceeded';
  const detail = (err.error as { message?: unknown } | undefined)?.message;
  // Keep it short; OpenAI error bodies never echo the API key.
  return typeof detail === 'string' ? detail.slice(0, 200) : 'request failed';
}

function sumUsage(responses: ReadonlyArray<{ usage?: Partial<AgentUsage> }>): AgentUsage {
  return responses.reduce<AgentUsage>(
    (acc, r) => ({
      requests: acc.requests + (r.usage?.requests ?? 1),
      inputTokens: acc.inputTokens + (r.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.usage?.outputTokens ?? 0),
      totalTokens: acc.totalTokens + (r.usage?.totalTokens ?? 0),
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}
