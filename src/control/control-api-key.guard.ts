import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { controlConfig } from '../config/configuration';

/** Hashing first gives equal-length buffers, so the comparison leaks neither content nor length. */
const digest = (value: string) => createHash('sha256').update(value).digest();

function assertKey(context: ExecutionContext, apiKey: string): true {
  const request = context.switchToHttp().getRequest<Request>();
  const provided = request.header('x-control-api-key') ?? '';
  if (!timingSafeEqual(digest(provided), digest(apiKey))) {
    throw new ForbiddenException('Invalid or missing X-Control-Api-Key header');
  }
  return true;
}

/** Guards the mutating /bot/* endpoints — pause/resume/kill-switch can send real orders. */
@Injectable()
export class ControlApiKeyGuard implements CanActivate {
  constructor(
    @Inject(controlConfig.KEY) private readonly config: ReturnType<typeof controlConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.apiKey) {
      // No key configured: allow (local-dev default), but set CONTROL_API_KEY before the API is
      // reachable by anyone else — these endpoints can close positions.
      return true;
    }
    return assertKey(context, this.config.apiKey);
  }
}

/** Paths reachable without the key even when API_KEY_REQUIRED_FOR_ALL=true (host health checks). */
const PUBLIC_PATHS = new Set(['/health']);

/**
 * Global guard: with API_KEY_REQUIRED_FOR_ALL=true, every route (reads included) needs the key —
 * for a publicly reachable backend whose only legitimate client is the dashboard proxy.
 */
@Injectable()
export class GlobalApiKeyGuard implements CanActivate {
  constructor(
    @Inject(controlConfig.KEY) private readonly config: ReturnType<typeof controlConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.requireKeyForAllRoutes) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (PUBLIC_PATHS.has(request.path)) return true;
    return assertKey(context, this.config.apiKey);
  }
}
