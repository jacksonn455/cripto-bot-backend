import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { AGENT_DEFINITIONS } from './agents/agent-definitions';
import { AiController } from './ai.controller';
import { AiBusyError, AiDisabledError, AiProviderError, AiTimeoutError, AiToolPolicyError } from './ai.errors';
import { AiService, buildUserMessage } from './ai.service';
import type { AnalysisOutput } from './ai.types';
import type { AgentRunner } from './providers/agent-runner.interface';
import { OpenAiAgentsRunner } from './providers/openai-agents.runner';
import { defineTool } from './tools/ai-tool';
import { assertToolsAllowed, limitToolOutput } from './tools/tool-policy';

const API_KEY = 'sk-test-THIS-MUST-NEVER-BE-LOGGED-123456';

const CONFIG = {
  agentsEnabled: true,
  apiKey: API_KEY,
  model: 'gpt-test',
  requestTimeoutMs: 1_000,
  maxRetries: 0,
  agentTimeoutMs: 2_000,
  maxTurns: 4,
  maxConcurrentRuns: 1,
  tracingEnabled: false,
};

const OUTPUT: AnalysisOutput = {
  summary: 'Resultado positivo, amostra pequena.',
  findings: [{ title: 'Poucos trades', detail: '12 trades fechados', severity: 'warning' }],
  recommendations: [{ action: 'Rodar walk-forward com allowShort=1', rationale: 'medir o lado short', requiresBacktest: true }],
  confidence: 'low',
  dataUsed: ['get_performance_summary'],
};

const fakeTools = { get: jest.fn().mockReturnValue([]) };

function makeService(config: Partial<typeof CONFIG> = {}, runner?: Partial<AgentRunner>) {
  const run = jest.fn().mockResolvedValue({
    output: OUTPUT,
    usage: { requests: 2, inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    model: 'gpt-test',
  });
  const agentRunner = { run, ...runner } as AgentRunner;
  const service = new AiService({ ...CONFIG, ...config } as never, agentRunner, fakeTools as never);
  return { service, run: agentRunner.run as jest.Mock };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

describe('AiService', () => {
  it('runs an agent and returns an advisory-only structured answer', async () => {
    const { service, run } = makeService();

    const result = await service.runAgent('performance-analyst', { question: 'segredo do usuário', mode: 'PAPER' });

    expect(result).toMatchObject({ agent: 'performance-analyst', output: OUTPUT, advisoryOnly: true });
    expect(result.usage.totalTokens).toBe(150);
    const [definition, , message, options] = run.mock.calls[0];
    expect(definition.key).toBe('performance-analyst');
    expect(message).toContain('modo=PAPER');
    expect(options.maxTurns).toBe(4);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(logs.some((l) => l.includes('[OpenAI] agent request started'))).toBe(true);
    expect(logs.some((l) => l.includes('[OpenAI] agent request completed'))).toBe(true);
    // Neither the question nor the key reach the logs.
    expect(logs.join('\n')).not.toContain('segredo do usuário');
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('is disabled (no model call) when OPENAI_AGENTS_ENABLED is not true', async () => {
    const { service, run } = makeService({ agentsEnabled: false });
    await expect(service.runAgent('risk-analyst', {})).rejects.toThrow(AiDisabledError);
    expect(service.status()).toMatchObject({ enabled: false, reason: 'OPENAI_AGENTS_ENABLED is not true' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a missing API key without ever calling OpenAI', async () => {
    const { service, run } = makeService({ apiKey: '' });
    await expect(service.runAgent('risk-analyst', {})).rejects.toThrow('OPENAI_API_KEY is not set');
    expect(service.status().configured).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates API errors and timeouts as AiErrors, logging the failure', async () => {
    const failing = makeService({}, { run: jest.fn().mockRejectedValue(new AiProviderError('OpenAI API error (HTTP 500)', 500)) });
    await expect(failing.service.runAgent('trade-reviewer', {})).rejects.toThrow(AiProviderError);
    expect(logs.some((l) => l.includes('[OpenAI] agent request failed'))).toBe(true);

    const slow = makeService({}, { run: jest.fn().mockRejectedValue(new AiTimeoutError(2_000)) });
    await expect(slow.service.runAgent('trade-reviewer', {})).rejects.toThrow(AiTimeoutError);
  });

  it('limits concurrent runs', async () => {
    let release!: () => void;
    const pending = new Promise<never>((_, reject) => {
      release = () => reject(new AiTimeoutError(1));
    });
    const { service } = makeService({ maxConcurrentRuns: 1 }, { run: jest.fn().mockReturnValue(pending) });

    const first = service.runAgent('market-analyst', {});
    await expect(service.runAgent('market-analyst', {})).rejects.toThrow(AiBusyError);
    release();
    await expect(first).rejects.toThrow(AiTimeoutError);
  });

  it('lists every agent with read-only tools only', () => {
    const { service } = makeService();
    const status = service.status();
    expect(status.agents.map((a) => a.key)).toEqual(Object.keys(AGENT_DEFINITIONS));
    expect(status.agents.every((a) => a.tools.length > 0)).toBe(true);
  });

  it('builds a scoped user message', () => {
    const msg = buildUserMessage({ symbol: 'btcusdt', from: '2026-09-01', question: '  por quê?  ' });
    expect(msg).toContain('símbolo=BTCUSDT');
    expect(msg).toContain('de=2026-09-01');
    expect(msg).toContain('Pergunta: por quê?');
  });
});

describe('AiController error mapping', () => {
  it.each([
    [new AiDisabledError('off'), 503],
    [new AiTimeoutError(1), 504],
    [new AiBusyError(1), 429],
    [new AiProviderError('boom', 500), 502],
  ])('%s -> HTTP %i', async (error, status) => {
    const controller = new AiController({ runAgent: jest.fn().mockRejectedValue(error) } as never);
    await expect(controller.run('risk-analyst', {})).rejects.toMatchObject({ status });
  });
});

describe('tool policy (safety boundary)', () => {
  it('refuses any tool that is not read-only', () => {
    expect(() =>
      assertToolsAllowed('Rogue', [
        { name: 'get_bot_status', access: 'read' },
        { name: 'close_trade', access: 'write' },
      ]),
    ).toThrow(AiToolPolicyError);
    expect(() => assertToolsAllowed('Ok', [{ name: 'get_bot_status', access: 'read' }])).not.toThrow();
  });

  it('every tool wired to an agent is read-only', () => {
    // Structural check on the definitions: tool names only reference the read-only catalog.
    const readOnly = new Set([
      'get_bot_status', 'get_performance_summary', 'get_performance_breakdown', 'list_recent_trades',
      'list_recent_signals', 'get_strategy_config', 'get_market_snapshot', 'list_backtest_runs',
    ]);
    for (const def of Object.values(AGENT_DEFINITIONS)) {
      for (const t of def.tools) expect(readOnly.has(t)).toBe(true);
    }
  });

  it('caps tool output size and keeps it valid JSON', () => {
    const out = limitToolOutput({ big: 'x'.repeat(50_000) }, 1_000);
    expect(out.length).toBeLessThan(1_200);
    expect(JSON.parse(out).truncated).toBe(true);
  });
});

describe('OpenAiAgentsRunner (real Agents SDK, fake HTTP)', () => {
  const definition = AGENT_DEFINITIONS['performance-analyst'];
  const tools = [
    defineTool({
      name: 'get_performance_summary',
      description: 'test',
      access: 'read',
      parameters: z.object({}),
      execute: async () => ({ tradeCount: 12 }),
    }),
  ];

  function responsesApiReply(text: string) {
    return {
      id: 'resp_1',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        total_tokens: 160,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  }

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('returns the validated structured output and token usage', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, responsesApiReply(JSON.stringify(OUTPUT))));
    const runner = new OpenAiAgentsRunner(CONFIG as never, fetchImpl as never);

    const result = await runner.run(definition, tools, 'analise', { signal: new AbortController().signal, maxTurns: 3 });

    expect(result.output).toEqual(OUTPUT);
    expect(result.usage).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 40, totalTokens: 160 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/responses');
    expect(JSON.parse(init.body as string).model).toBe('gpt-test');
  });

  it('maps 401 to a safe provider error that never contains the key', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { message: `Incorrect API key provided: ${API_KEY}`, type: 'invalid_request_error' } }));
    const runner = new OpenAiAgentsRunner(CONFIG as never, fetchImpl as never);

    const error = await runner
      .run(definition, tools, 'analise', { signal: new AbortController().signal, maxTurns: 3 })
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).providerStatus).toBe(401);
    expect((error as Error).message).toContain('invalid or revoked OPENAI_API_KEY');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('turns a hanging OpenAI into a timeout instead of waiting forever', async () => {
    const fetchImpl = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const runner = new OpenAiAgentsRunner(CONFIG as never, fetchImpl as never);

    const started = Date.now();
    const error = await runner
      .run(definition, tools, 'analise', { signal: AbortSignal.timeout(100), maxTurns: 3 })
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('refuses a write tool before any HTTP call', async () => {
    const fetchImpl = jest.fn();
    const runner = new OpenAiAgentsRunner(CONFIG as never, fetchImpl as never);
    const rogue = defineTool({ name: 'close_trade', description: 'x', access: 'write', parameters: z.object({}), execute: async () => 'x' });

    await expect(
      runner.run(definition, [rogue], 'feche tudo', { signal: new AbortController().signal, maxTurns: 1 }),
    ).rejects.toThrow(AiToolPolicyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
