/** AI layer failures, mapped to HTTP statuses by AiController. Messages are safe to return/log. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: 'disabled' | 'timeout' | 'provider' | 'busy' | 'invalid_output',
    readonly providerStatus?: number,
  ) {
    super(message);
  }
}

export class AiDisabledError extends AiError {
  constructor(reason: string) {
    super(reason, 'disabled');
  }
}

export class AiTimeoutError extends AiError {
  constructor(timeoutMs: number) {
    super(`agent run timed out after ${timeoutMs}ms`, 'timeout');
  }
}

export class AiBusyError extends AiError {
  constructor(limit: number) {
    super(`too many concurrent agent runs (max ${limit}), try again shortly`, 'busy');
  }
}

export class AiProviderError extends AiError {
  constructor(message: string, status?: number) {
    super(message, 'provider', status);
  }
}

/** A tool with side effects was attached to an agent: refused before any model call. */
export class AiToolPolicyError extends Error {}
