import { validationSchema } from './validation.schema';

const validate = (env: Record<string, string>) => validationSchema.validate(env, { abortEarly: false, allowUnknown: true });

describe('validationSchema (new integrations)', () => {
  it('boots with everything off by default', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      DISCORD_ENABLED: false,
      OPENAI_AGENTS_ENABLED: false,
      REDIS_ENABLED: true,
      TELEGRAM_EVENTS: 'alerts',
      DISCORD_EVENTS: 'alerts,trades,reports,signals',
    });
  });

  it('requires a Discord webhook URL when Discord is enabled', () => {
    expect(validate({ DISCORD_ENABLED: 'true' }).error?.message).toContain(
      'DISCORD_WEBHOOK_URL is required when DISCORD_ENABLED=true',
    );
    expect(
      validate({ DISCORD_ENABLED: 'true', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc_DEF-1' }).error,
    ).toBeUndefined();
  });

  it('rejects a non-Discord webhook without echoing the (secret) value', () => {
    const secret = 'https://evil.example.com/api/webhooks/123/TOPSECRET';
    const { error } = validate({ DISCORD_ENABLED: 'true', DISCORD_WEBHOOK_URL: secret });
    expect(error?.message).toContain('must be a Discord webhook URL');
    expect(error?.message).not.toContain('TOPSECRET');
  });

  it('requires OPENAI_API_KEY when agents are enabled, without echoing it', () => {
    expect(validate({ OPENAI_AGENTS_ENABLED: 'true' }).error?.message).toContain('OPENAI_API_KEY is required');
    const short = validate({ OPENAI_AGENTS_ENABLED: 'true', OPENAI_API_KEY: 'sk-SHORTKEY' });
    expect(short.error?.message).toContain('looks invalid');
    expect(short.error?.message).not.toContain('SHORTKEY');
    expect(validate({ OPENAI_AGENTS_ENABLED: 'true', OPENAI_API_KEY: 'sk-proj-0123456789abcdefghij' }).error).toBeUndefined();
  });

  it('validates notification categories and Redis URLs', () => {
    expect(validate({ DISCORD_EVENTS: 'trades,foo' }).error?.message).toContain('DISCORD_EVENTS');
    expect(validate({ REDIS_URL: 'http://localhost:6379' }).error?.message).toContain('REDIS_URL');
    expect(validate({ REDIS_URL: 'rediss://default:pw@host:6380' }).error).toBeUndefined();
    expect(validate({ REDIS_URL: '' }).error).toBeUndefined();
  });
});
