import { AiToolPolicyError } from '../ai.errors';

/**
 * The safety boundary between agents and the trading system.
 *
 * Every tool handed to an agent must be declared with an access level. This version allows
 * only `read` tools: an agent can look at trades, signals, reports, strategy parameters and
 * market data, but there is no code path from an agent to ExecutionService, ControlService's
 * pause/resume/kill switch, order placement or any write to Mongo.
 *
 * Adding an action tool later means changing this policy on purpose — and it should then go
 * through the same authorization as the HTTP API (ControlApiKeyGuard) plus an explicit human
 * approval step (the Agents SDK supports `needsApproval` for that), never auto-execution.
 */
export type ToolAccess = 'read' | 'write';

export interface ToolDescriptor {
  name: string;
  access: ToolAccess;
}

export const ALLOWED_TOOL_ACCESS: readonly ToolAccess[] = ['read'];

export function assertToolsAllowed(agentName: string, tools: readonly ToolDescriptor[]): void {
  const forbidden = tools.filter((t) => !ALLOWED_TOOL_ACCESS.includes(t.access));
  if (forbidden.length > 0) {
    throw new AiToolPolicyError(
      `Agent "${agentName}" was given non read-only tools (${forbidden.map((t) => t.name).join(', ')}); ` +
        'agents may only analyze, never act on trades',
    );
  }
}

/** Caps what a tool returns to the model (cost + prompt size), keeping it valid JSON. */
export function limitToolOutput(value: unknown, maxChars = 12_000): string {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxChars) return json;
  return JSON.stringify({ truncated: true, note: `output cut to ${maxChars} chars`, partial: json.slice(0, maxChars) });
}
