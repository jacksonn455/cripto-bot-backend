import { parseCorsOrigins } from './cors.util';
import { validationSchema } from './validation.schema';

describe('parseCorsOrigins', () => {
  it('is empty (CORS off) when unset or blank', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins(' , ')).toEqual([]);
  });

  it('trims, drops trailing slashes and duplicates', () => {
    expect(parseCorsOrigins(' https://krypto.vercel.app/, http://localhost:3000,https://krypto.vercel.app')).toEqual([
      'https://krypto.vercel.app',
      'http://localhost:3000',
    ]);
  });
});

describe('validationSchema (deploy-related keys)', () => {
  const validate = (env: Record<string, unknown>) => validationSchema.validate(env, { abortEarly: false, allowUnknown: true });

  it('defaults to PAPER mode and to the loopback host', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value.TRADING_MODE).toBe('PAPER');
    expect(value.LIVE_TRADING_CONFIRMED).toBe(false);
    expect(value.HOST).toBe('127.0.0.1');
    expect(value.CORS_ORIGINS).toBe('');
  });

  it('requires MONGO_URI in production', () => {
    expect(validate({ NODE_ENV: 'production' }).error?.message).toMatch(/MONGO_URI is required/);
    expect(validate({ NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://u:p@c.mongodb.net/db' }).error).toBeUndefined();
  });

  it('rejects "*" and non-http origins in CORS_ORIGINS in production', () => {
    const base = { NODE_ENV: 'production', MONGO_URI: 'mongodb://localhost:27017/x' };
    expect(validate({ ...base, CORS_ORIGINS: '*' }).error?.message).toMatch(/CORS_ORIGINS/);
    expect(validate({ ...base, CORS_ORIGINS: 'krypto.vercel.app' }).error?.message).toMatch(/CORS_ORIGINS/);
    expect(validate({ ...base, CORS_ORIGINS: 'https://krypto.vercel.app,http://localhost:3000' }).error).toBeUndefined();
  });
});
