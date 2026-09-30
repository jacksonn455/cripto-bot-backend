import { AGENT_PROMPTS, SHARED_GUARDRAILS } from '../prompts/agent-prompts';
import type { AgentKey } from '../ai.types';
import type { ToolName } from '../tools/trading-data.tools';

export interface AgentDefinition {
  key: AgentKey;
  /** Shown in traces/logs. */
  name: string;
  description: string;
  instructions: string;
  tools: readonly ToolName[];
}

/**
 * The specialized agents. Adding one = a prompt in prompts/agent-prompts.ts + an entry here
 * choosing from the read-only tools; nothing else needs to change.
 */
export const AGENT_DEFINITIONS: Record<AgentKey, AgentDefinition> = {
  'performance-analyst': {
    key: 'performance-analyst',
    name: 'Performance Analyst',
    description: 'Avalia PnL, drawdown, Sharpe/Sortino, custos e Long vs Short, comparando backtest e paper.',
    instructions: `${SHARED_GUARDRAILS}\n\n${AGENT_PROMPTS['performance-analyst']}`,
    tools: ['get_performance_summary', 'get_performance_breakdown', 'list_backtest_runs', 'get_strategy_config'],
  },
  'trade-reviewer': {
    key: 'trade-reviewer',
    name: 'Trade Reviewer',
    description: 'Revisa trades recentes: motivo de entrada/saída, MAE/MFE e aderência às regras.',
    instructions: `${SHARED_GUARDRAILS}\n\n${AGENT_PROMPTS['trade-reviewer']}`,
    tools: ['list_recent_trades', 'get_performance_summary', 'get_strategy_config'],
  },
  'signal-explainer': {
    key: 'signal-explainer',
    name: 'Signal Explainer',
    description: 'Explica em linguagem simples as últimas decisões e os sinais vetados pelo risco.',
    instructions: `${SHARED_GUARDRAILS}\n\n${AGENT_PROMPTS['signal-explainer']}`,
    tools: ['get_bot_status', 'list_recent_signals', 'get_strategy_config', 'get_market_snapshot'],
  },
  'risk-analyst': {
    key: 'risk-analyst',
    name: 'Risk Analyst',
    description: 'Avalia exposição, perda diária, sequência de stops, limites e riscos operacionais.',
    instructions: `${SHARED_GUARDRAILS}\n\n${AGENT_PROMPTS['risk-analyst']}`,
    tools: ['get_bot_status', 'list_recent_trades', 'get_performance_summary', 'get_strategy_config'],
  },
  'market-analyst': {
    key: 'market-analyst',
    name: 'Market Analyst',
    description: 'Descreve o regime atual (tendência/volatilidade) dos símbolos e o que implica para a estratégia.',
    instructions: `${SHARED_GUARDRAILS}\n\n${AGENT_PROMPTS['market-analyst']}`,
    tools: ['get_market_snapshot', 'get_strategy_config', 'get_bot_status'],
  },
};
