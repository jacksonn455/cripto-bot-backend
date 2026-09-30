import { ForbiddenException } from '@nestjs/common';
import { ControlApiKeyGuard, GlobalApiKeyGuard } from './control-api-key.guard';

function ctx(header?: string, path = '/bot/pause') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path, header: (name: string) => (name === 'x-control-api-key' ? header : undefined) }),
    }),
  } as never;
}

describe('ControlApiKeyGuard', () => {
  it('blocks pause/resume/kill-switch without the right key when CONTROL_API_KEY is set', () => {
    const guard = new ControlApiKeyGuard({ apiKey: 'segredo', requireKeyForAllRoutes: false });
    expect(() => guard.canActivate(ctx())).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('errada'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx('segredo'))).toBe(true);
  });

  it('allows everything when no key is configured (local dev default)', () => {
    expect(new ControlApiKeyGuard({ apiKey: '', requireKeyForAllRoutes: false }).canActivate(ctx())).toBe(true);
  });
});

describe('GlobalApiKeyGuard', () => {
  it('is a no-op unless API_KEY_REQUIRED_FOR_ALL is on', () => {
    const guard = new GlobalApiKeyGuard({ apiKey: 'segredo', requireKeyForAllRoutes: false });
    expect(guard.canActivate(ctx(undefined, '/trades'))).toBe(true);
  });

  it('requires the key on every route except /health when on', () => {
    const guard = new GlobalApiKeyGuard({ apiKey: 'segredo', requireKeyForAllRoutes: true });
    expect(() => guard.canActivate(ctx(undefined, '/trades'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('errada', '/backtest/run'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx('segredo', '/trades'))).toBe(true);
    expect(guard.canActivate(ctx(undefined, '/health'))).toBe(true);
  });
});
