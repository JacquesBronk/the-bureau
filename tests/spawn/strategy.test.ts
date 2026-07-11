import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildEnv,
  DEFAULT_INHERIT_VARS,
  BUREAU_EXCLUDED,
  ALLOWLIST_EXTRAS,
} from '../../src/spawn/strategy.js';
import type { SpawnOpts } from '../../src/spawn/strategy.js';

describe('buildEnv', () => {
  // Capture original env and restore after each test.
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clean slate for predictable results.
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('inherits default safe vars in allowlist mode', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/user';
    process.env.SECRET = 'should-not-appear';

    const env = buildEnv({});
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.SECRET).toBeUndefined();
  });

  it('passes BUREAU_* vars through (excluding WS secrets)', () => {
    process.env.BUREAU_SERVER_URL = 'http://localhost:4000';
    process.env.BUREAU_WS_SECRET = 'super-secret';
    process.env.BUREAU_WS_PORT = '7070';
    process.env.BUREAU_WS_INSECURE = 'true';

    const env = buildEnv({});
    expect(env.BUREAU_SERVER_URL).toBe('http://localhost:4000');
    expect(env.BUREAU_WS_SECRET).toBeUndefined();
    expect(env.BUREAU_WS_PORT).toBeUndefined();
    expect(env.BUREAU_WS_INSECURE).toBeUndefined();
  });

  it('passes OTEL_* vars through', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4317';
    process.env.OTEL_SERVICE_NAME = 'the-bureau';

    const env = buildEnv({});
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel:4317');
    expect(env.OTEL_SERVICE_NAME).toBe('the-bureau');
  });

  it('passes allowlist extra vars (API keys etc.)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.REDIS_URL = 'redis://redis.local:6379';
    process.env.NODE_ENV = 'test';

    const env = buildEnv({});
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env.REDIS_URL).toBe('redis://redis.local:6379');
    expect(env.NODE_ENV).toBe('test');
  });

  it('explicit vars override host values', () => {
    process.env.REDIS_URL = 'redis://original:6379';

    const env = buildEnv({ env: { mode: 'allowlist', vars: { REDIS_URL: 'redis://override:6379' } } });
    expect(env.REDIS_URL).toBe('redis://override:6379');
  });

  it('cmdEnv overrides opts.env.vars', () => {
    const env = buildEnv(
      { env: { mode: 'allowlist', vars: { SESSION_ID: 'from-opts' } } },
      { SESSION_ID: 'from-cmd' },
    );
    expect(env.SESSION_ID).toBe('from-cmd');
  });

  it('inherits extra vars listed in opts.env.inherit', () => {
    process.env.MY_CUSTOM_VAR = 'hello';

    const env = buildEnv({ env: { mode: 'allowlist', vars: {}, inherit: ['MY_CUSTOM_VAR'] } });
    expect(env.MY_CUSTOM_VAR).toBe('hello');
  });

  it('does not include vars not in allowlist', () => {
    process.env.UNRELATED = 'nope';
    process.env.ANOTHER_SECRET = 'also-nope';

    const env = buildEnv({});
    expect(env.UNRELATED).toBeUndefined();
    expect(env.ANOTHER_SECRET).toBeUndefined();
  });

  it('blocklist mode passes all host vars except listed ones', () => {
    process.env.PATH = '/usr/bin';
    process.env.SECRET = 'visible-in-blocklist';
    process.env.STRIP_ME = 'should-be-gone';

    const env = buildEnv({ env: { mode: 'blocklist', vars: {}, inherit: ['STRIP_ME'] } });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SECRET).toBe('visible-in-blocklist');
    expect(env.STRIP_ME).toBeUndefined();
  });

  it('sets default MCP_TIMEOUT when not present', () => {
    const env = buildEnv({});
    expect(env.MCP_TIMEOUT).toBe('30000');
  });

  it('preserves MCP_TIMEOUT from host env if set', () => {
    process.env.MCP_TIMEOUT = '60000';
    const env = buildEnv({});
    expect(env.MCP_TIMEOUT).toBe('60000');
  });

  it('exports complete BUREAU_EXCLUDED set for documentation', () => {
    expect(BUREAU_EXCLUDED.has('BUREAU_WS_SECRET')).toBe(true);
    expect(BUREAU_EXCLUDED.has('BUREAU_WS_PORT')).toBe(true);
    expect(BUREAU_EXCLUDED.has('BUREAU_WS_INSECURE')).toBe(true);
  });

  it('DEFAULT_INHERIT_VARS includes expected safe vars', () => {
    for (const v of ['PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM']) {
      expect(DEFAULT_INHERIT_VARS).toContain(v);
    }
  });

  it('ALLOWLIST_EXTRAS includes expected keys', () => {
    expect(ALLOWLIST_EXTRAS.has('REDIS_URL')).toBe(true);
    expect(ALLOWLIST_EXTRAS.has('SESSION_ID')).toBe(true);
    expect(ALLOWLIST_EXTRAS.has('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('inherits provider routing vars when set on the host (global-default path)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://litellm:4000';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-lite';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-xyz';
    const env = buildEnv({});
    expect(env.ANTHROPIC_BASE_URL).toBe('http://litellm:4000');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-lite');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-xyz');

    // Per-spawn cmdEnv (the primary path) must win over the inherited global.
    const overridden = buildEnv({}, { ANTHROPIC_BASE_URL: 'http://override:9999' });
    expect(overridden.ANTHROPIC_BASE_URL).toBe('http://override:9999');
  });
});
