import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { detectToolchains, type ServiceDetection } from '../buildconfig/detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'detect');

/** Index services by path so multi-service assertions are order-independent. */
function byPath(services: ServiceDetection[]): Record<string, ServiceDetection> {
  return Object.fromEntries(services.map(s => [s.path ?? '.', s]));
}

describe('detection fixture corpus', () => {
  it('node-basic: confident node, commandsTrusted:true (scripts.test present)', () => {
    const r = detectToolchains(join(FIXTURES, 'node-basic'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({
      path: '.',
      language: 'node',
      toolchain: 'node',
      verdict: 'confident',
      commandsTrusted: true,
    });
    expect(r.confident).toBe(true);
  });

  it('python-basic: confident python', () => {
    const r = detectToolchains(join(FIXTURES, 'python-basic'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({
      path: '.',
      language: 'python',
      toolchain: 'python',
      verdict: 'confident',
    });
  });

  it('dotnet-console: confident dotnet (.csproj manifest)', () => {
    const r = detectToolchains(join(FIXTURES, 'dotnet-console'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({
      path: '.',
      language: 'dotnet',
      toolchain: 'dotnet',
      verdict: 'confident',
    });
  });

  it('cpp-hello: unsupported cpp (CMakeLists.txt, no toolchain)', () => {
    const r = detectToolchains(join(FIXTURES, 'cpp-hello'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'cpp', verdict: 'unsupported' });
    expect(r.services[0].toolchain).toBeUndefined();
    expect(r.confident).toBe(false);
  });

  it('go-svc: unsupported go', () => {
    const r = detectToolchains(join(FIXTURES, 'go-svc'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'go', verdict: 'unsupported' });
    expect(r.confident).toBe(false);
  });

  it('rust-cli: unsupported rust', () => {
    const r = detectToolchains(join(FIXTURES, 'rust-cli'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'rust', verdict: 'unsupported' });
    expect(r.confident).toBe(false);
  });

  it('java-app: unsupported java', () => {
    const r = detectToolchains(join(FIXTURES, 'java-app'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'java', verdict: 'unsupported' });
    expect(r.confident).toBe(false);
  });

  it('ruby-script: unsupported ruby', () => {
    const r = detectToolchains(join(FIXTURES, 'ruby-script'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'ruby', verdict: 'unsupported' });
    expect(r.confident).toBe(false);
  });

  it('php-site: unsupported php', () => {
    const r = detectToolchains(join(FIXTURES, 'php-site'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', language: 'php', verdict: 'unsupported' });
    expect(r.confident).toBe(false);
  });

  it('unknown-xyz: unidentified (no language signal)', () => {
    const r = detectToolchains(join(FIXTURES, 'unknown-xyz'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0].verdict).toBe('unidentified');
    expect(r.confident).toBe(false);
  });

  it('empty-repo: unidentified (only .gitignore + README, no language signal)', () => {
    const r = detectToolchains(join(FIXTURES, 'empty-repo'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0].verdict).toBe('unidentified');
    expect(r.confident).toBe(false);
  });

  it('node-empty: confident node, commandsTrusted:false (0-byte package.json)', () => {
    const r = detectToolchains(join(FIXTURES, 'node-empty'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({
      path: '.',
      language: 'node',
      toolchain: 'node',
      verdict: 'confident',
      commandsTrusted: false,
    });
    expect(r.confident).toBe(false);
  });

  it('garbage-manifest: confident node, commandsTrusted:false (invalid JSON in package.json)', () => {
    const r = detectToolchains(join(FIXTURES, 'garbage-manifest'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({
      language: 'node',
      verdict: 'confident',
      commandsTrusted: false,
    });
  });

  it('ambiguous-root: ambiguous (package.json + pyproject.toml at root)', () => {
    const r = detectToolchains(join(FIXTURES, 'ambiguous-root'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ path: '.', verdict: 'ambiguous' });
    expect(r.confident).toBe(false);
  });

  it('mixed-node-dotnet: 2 services (./web=node, ./api=dotnet), both confident', () => {
    const r = detectToolchains(join(FIXTURES, 'mixed-node-dotnet'));
    expect(r.services).toHaveLength(2);
    const svc = byPath(r.services);
    expect(svc['./web']).toMatchObject({ language: 'node', toolchain: 'node', verdict: 'confident', commandsTrusted: true });
    expect(svc['./api']).toMatchObject({ language: 'dotnet', toolchain: 'dotnet', verdict: 'confident', commandsTrusted: true });
    expect(r.confident).toBe(true);
  });

  it('polyglot-mono: 3 services (./web=node, ./api=python, ./tool=go/unsupported)', () => {
    const r = detectToolchains(join(FIXTURES, 'polyglot-mono'));
    expect(r.services).toHaveLength(3);
    const svc = byPath(r.services);
    expect(svc['./web']).toMatchObject({ language: 'node', toolchain: 'node', verdict: 'confident' });
    expect(svc['./api']).toMatchObject({ language: 'python', toolchain: 'python', verdict: 'confident' });
    expect(svc['./tool']).toMatchObject({ language: 'go', verdict: 'unsupported' });
    expect(svc['./tool'].toolchain).toBeUndefined();
    expect(r.confident).toBe(false);
  });

  it('vendored-noise: python wins (pyproject.toml at root, dist/ + node_modules/ ignored)', () => {
    const r = detectToolchains(join(FIXTURES, 'vendored-noise'));
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ language: 'python', verdict: 'confident' });
  });
});
