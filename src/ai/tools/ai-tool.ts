import type { z } from 'zod';
import type { ToolAccess } from './tool-policy';

/**
 * SDK-agnostic tool definition. Tools are written against application services only; the
 * provider (providers/openai-agents.runner.ts) turns them into Agents SDK tools. That keeps the
 * OpenAI SDK out of the domain code and lets the policy inspect `access` before wiring.
 *
 * Parameters use `.nullable()` instead of `.optional()`: OpenAI strict function schemas require
 * every property to be present, so "not provided" is sent as null.
 */
export interface AiToolSpec<P extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  access: ToolAccess;
  parameters: P;
  execute(input: z.infer<P>): Promise<unknown>;
}

export function defineTool<P extends z.ZodObject>(spec: AiToolSpec<P>): AiToolSpec<P> {
  return spec;
}

/** null (from strict schemas) -> undefined, so it can be spread into service filters. */
export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}
