import type { AgentDefinition } from '../agents/agent-definitions';
import type { AgentUsage, AnalysisOutput } from '../ai.types';
import type { AiToolSpec } from '../tools/ai-tool';

export interface AgentRunOptions {
  signal: AbortSignal;
  maxTurns: number;
}

export interface AgentRunnerResult {
  output: AnalysisOutput;
  usage: AgentUsage;
  model: string;
}

/**
 * Runs one agent to completion. The OpenAI Agents SDK implementation lives in
 * openai-agents.runner.ts; AiService only sees this interface (and tests swap it out).
 * Implementations throw AiError subclasses, never raw SDK/HTTP errors.
 */
export interface AgentRunner {
  run(agent: AgentDefinition, tools: AiToolSpec[], input: string, options: AgentRunOptions): Promise<AgentRunnerResult>;
}

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');
