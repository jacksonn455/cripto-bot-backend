import { z } from 'zod';

/**
 * Structured answer every agent must return (enforced by the SDK's structured output). It is
 * data for a human to read: `recommendations` are never executed by the application.
 * Every field is required (OpenAI strict schemas don't allow optional properties).
 */
export const AnalysisOutputSchema = z.object({
  summary: z.string().describe('Resumo em 2-5 frases, em português'),
  findings: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
      }),
    )
    .max(10),
  recommendations: z
    .array(
      z.object({
        action: z.string().describe('O que um humano poderia avaliar/fazer'),
        rationale: z.string(),
        requiresBacktest: z.boolean().describe('true se mexe na estratégia/risco e precisa de backtest antes'),
      }),
    )
    .max(10),
  confidence: z.enum(['low', 'medium', 'high']),
  dataUsed: z.array(z.string()).describe('Quais ferramentas/dados embasaram a resposta'),
});

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

export const AGENT_KEYS = [
  'performance-analyst',
  'trade-reviewer',
  'signal-explainer',
  'risk-analyst',
  'market-analyst',
] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

/** Free-form question plus optional scoping the agent should respect. */
export interface AgentRunInput {
  question?: string;
  symbol?: string;
  mode?: 'BACKTEST' | 'PAPER' | 'LIVE';
  from?: string;
  to?: string;
}

export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  agent: AgentKey;
  model: string;
  output: AnalysisOutput;
  usage: AgentUsage;
  durationMs: number;
  /** Always true: nothing an agent returns is acted upon automatically. */
  advisoryOnly: true;
}

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  /** Why it is not usable, when it isn't. Never contains the key. */
  reason?: string;
  model: string;
  tracingEnabled: boolean;
  agents: Array<{ key: AgentKey; name: string; description: string; tools: string[] }>;
}
