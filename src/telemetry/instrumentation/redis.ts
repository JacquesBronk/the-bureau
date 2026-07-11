/**
 * instrumentation/redis.ts — Redis command instrumentation seam (§4.2).
 *
 * Wraps every ioredis command method with a span + metric emission.
 * Returns the client unchanged when OTel is disabled (getMeter() === null).
 *
 * Wire-up (calling wrapRedisClient inside getRedis()) happens in the
 * wire-core-init task. This file only provides the seam + tests.
 */
import { getMeter, getTracer } from '../core.js';
import { METRIC, ATTR } from '../schema.js';

// Type-only imports — erased at compile time, safe on all platforms.
import type { Span } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// SpanStatusCode — lazy-loaded once at module init to avoid static-import hang
// ---------------------------------------------------------------------------

// SpanStatusCode.ERROR = 2 per OTel spec (stable value). Used as fallback
// before the async pre-load below resolves.
let _spanStatusCodeError = 2;

// Eagerly pre-load @opentelemetry/api in the background so SpanStatusCode is
// available by the time wrapRedisClient() is called (after initTelemetry()).
// Matches core.ts's WSL cold-start workaround pattern.
import('@opentelemetry/api')
  .then((api) => { _spanStatusCodeError = api.SpanStatusCode.ERROR; })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Key-prefix → operation classification
// ---------------------------------------------------------------------------

// Read-oriented ioredis commands (first key arg is a lookup, not a mutation).
const READ_COMMANDS = new Set([
  'get', 'hget', 'hgetall', 'hmget', 'exists', 'ttl', 'pttl',
  'smembers', 'sismember', 'srandmember', 'scard',
  'lrange', 'llen', 'lindex',
  'zrange', 'zrangebyscore', 'zrevrange', 'zrevrangebyscore', 'zscore', 'zcard', 'zrank',
  'xrevrange', 'xrange', 'xlen', 'xinfo',
  'scan', 'hscan', 'sscan', 'zscan',
  'type', 'strlen',
]);

/**
 * Derive the Bureau-semantic operation label from the Redis command and the
 * first colon-segment of the key. Used for the bureau.redis.operation attribute.
 *
 * Examples from the spec: event.publish, event.read, telemetry.write,
 * graph.read, anomaly.cooldown.check.
 */
function classifyOperation(command: string, key?: string): string {
  if (!key) return `redis.${command}`;

  const colon = key.indexOf(':');
  const prefix = colon >= 0 ? key.slice(0, colon) : key;
  const remainder = colon >= 0 ? key.slice(colon + 1) : '';

  switch (prefix) {
    case 'events':
      if (['xadd', 'publish'].includes(command)) return 'event.publish';
      if (['xread', 'xreadgroup', 'xrevrange', 'xrange', 'xlen', 'xinfo'].includes(command))
        return 'event.read';
      return READ_COMMANDS.has(command) ? 'event.read' : 'event.write';

    case 'graph':
      return READ_COMMANDS.has(command) ? 'graph.read' : 'graph.write';

    case 'telemetry':
      return READ_COMMANDS.has(command) ? 'telemetry.read' : 'telemetry.write';

    case 'handoff':
      return READ_COMMANDS.has(command) ? 'handoff.read' : 'handoff.write';

    case 'workspace':
      return READ_COMMANDS.has(command) ? 'workspace.read' : 'workspace.write';

    case 'bureau':
      // bureau:cache-anomaly:* — anomaly cooldown keys
      if (remainder.startsWith('cache-anomaly:')) {
        return READ_COMMANDS.has(command)
          ? 'anomaly.cooldown.check'
          : 'anomaly.cooldown.set';
      }
      return `bureau.${command}`;

    case 'lock':
      return ['del', 'unlink'].includes(command) ? 'lock.release' : 'lock.acquire';

    case 'peer':
      return READ_COMMANDS.has(command) ? 'peer.read' : 'peer.write';

    default:
      return `redis.${command}`;
  }
}

/**
 * Extract the first colon-segment of a key for bureau.redis.key_prefix.
 * Never returns the full key — cardinality safety (§4.2).
 */
function extractKeyPrefix(key?: unknown): string {
  if (!key || typeof key !== 'string') return 'unknown';
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(0, colon) : key;
}

// ioredis command names whose first argument is a Redis key.
const KEY_BEARING_COMMANDS = new Set([
  'get', 'set', 'setex', 'psetex', 'setnx', 'getset', 'getdel',
  'del', 'unlink', 'exists', 'ttl', 'pttl', 'expire', 'pexpire', 'expireat',
  'hget', 'hset', 'hmset', 'hmget', 'hgetall', 'hdel', 'hincrby', 'hscan',
  'xadd', 'xread', 'xreadgroup', 'xrevrange', 'xrange', 'xlen', 'xinfo',
  'xtrim', 'xdel', 'xack', 'xclaim',
  'zadd', 'zrangebyscore', 'zrevrangebyscore', 'zrange', 'zrevrange',
  'zrem', 'zincrby', 'zcard', 'zscore', 'zrank', 'zrevrank', 'zscan',
  'sadd', 'smembers', 'sismember', 'srandmember', 'srem', 'scard', 'sscan',
  'lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen', 'lindex', 'lset',
  'publish', 'subscribe', 'unsubscribe', 'psubscribe', 'punsubscribe',
  'scan',
  'incr', 'incrby', 'incrbyfloat', 'decr', 'decrby',
  'eval', 'evalsha',
  'type', 'strlen', 'append',
]);

// ---------------------------------------------------------------------------
// Wrap implementation
// ---------------------------------------------------------------------------

/**
 * Wrap every ioredis command on `client` with a telemetry span + metric
 * emission. Returns `client` unchanged when OTel is disabled.
 *
 * Pipeline / multi: wraps only the terminal exec() call, not individual
 * queued commands. The exec() span carries bureau.redis.batch_size.
 */
export function wrapRedisClient<T extends object>(client: T): T {
  const meter = getMeter();
  const tracer = getTracer();

  if (meter === null || tracer === null) {
    return client;
  }

  // Instruments created once per wrapped client.
  const durationHistogram = meter.createHistogram(METRIC.REDIS_OPERATION_DURATION, {
    unit: 'ms',
    description: 'Duration of Redis command executions',
  });
  const errorsCounter = meter.createCounter(METRIC.REDIS_OPERATION_ERRORS, {
    description: 'Number of Redis command errors',
  });

  // Capture local references — Proxy closures keep them alive.
  const localTracer = tracer;

  /**
   * Wrap a regular (non-pipeline) command method with a span + metrics.
   */
  function wrapCommand(command: string, originalFn: Function): Function {
    return function commandWrapper(this: unknown, ...args: unknown[]) {
      const key = KEY_BEARING_COMMANDS.has(command) ? (args[0] as string | undefined) : undefined;
      const keyPrefix = extractKeyPrefix(key);
      const operation = classifyOperation(command, key);

      const attrs = {
        [ATTR.DB_SYSTEM]: 'redis',
        [ATTR.DB_OPERATION]: command,
        [ATTR.REDIS_OPERATION]: operation,
        [ATTR.REDIS_KEY_PREFIX]: keyPrefix,
      };

      return localTracer.startActiveSpan(`redis.${command}`, (span: Span) => {
        span.setAttributes(attrs);
        const start = Date.now();

        const onSuccess = (result: unknown): unknown => {
          durationHistogram.record(Date.now() - start, attrs);
          span.end();
          return result;
        };

        const onError = (err: unknown): never => {
          span.setStatus({ code: _spanStatusCodeError });
          span.recordException(err as Error);
          errorsCounter.add(1, attrs);
          durationHistogram.record(Date.now() - start, attrs);
          span.end();
          throw err;
        };

        let result: unknown;
        try {
          result = originalFn.apply(this, args);
        } catch (err) {
          return onError(err);
        }

        if (isPromiseLike(result)) {
          return (result as Promise<unknown>).then(onSuccess, onError);
        }
        return onSuccess(result);
      });
    };
  }

  /**
   * Wrap pipeline() / multi() so the terminal exec() carries a single span
   * with bureau.redis.batch_size = number of queued commands.
   * Individual pipeline command calls are counted but NOT individually spanned.
   */
  function wrapPipelineFactory(createFn: Function): Function {
    return function pipelineFactory(this: unknown, ...args: unknown[]) {
      const innerPipeline = createFn.apply(this, args) as object;
      let commandCount = 0;
      let pipelineProxy: object;

      pipelineProxy = new Proxy(innerPipeline, {
        get(pTarget: object, pProp: string | symbol) {
          const inner = (pTarget as Record<string | symbol, unknown>)[pProp];

          if (typeof pProp !== 'string' || typeof inner !== 'function') {
            return inner;
          }

          if (pProp === 'exec') {
            // Wrap the terminal exec() call with a single pipeline span.
            return function execWrapper(this: unknown, ...execArgs: unknown[]) {
              const batchSize = commandCount;
              const pipeAttrs = {
                [ATTR.DB_SYSTEM]: 'redis',
                [ATTR.DB_OPERATION]: 'exec',
                [ATTR.REDIS_OPERATION]: 'pipeline.exec',
                [ATTR.REDIS_BATCH_SIZE]: batchSize,
              };

              return localTracer.startActiveSpan('redis.pipeline', (span: Span) => {
                span.setAttributes(pipeAttrs);
                const start = Date.now();

                const durationAttrs = {
                  [ATTR.DB_SYSTEM]: 'redis',
                  [ATTR.DB_OPERATION]: 'exec',
                  [ATTR.REDIS_OPERATION]: 'pipeline.exec',
                };

                const onSuccess = (result: unknown): unknown => {
                  durationHistogram.record(Date.now() - start, durationAttrs);
                  span.end();
                  return result;
                };

                const onError = (err: unknown): never => {
                  span.setStatus({ code: _spanStatusCodeError });
                  span.recordException(err as Error);
                  errorsCounter.add(1, durationAttrs);
                  durationHistogram.record(Date.now() - start, durationAttrs);
                  span.end();
                  throw err;
                };

                let result: unknown;
                try {
                  result = (inner as Function).apply(pTarget, execArgs);
                } catch (err) {
                  return onError(err);
                }

                if (isPromiseLike(result)) {
                  return (result as Promise<unknown>).then(onSuccess, onError);
                }
                return onSuccess(result);
              });
            };
          }

          // Non-exec pipeline commands: count for batch_size, chain the proxy.
          return function pipelineCommandWrapper(this: unknown, ...cmdArgs: unknown[]) {
            commandCount++;
            (inner as Function).apply(pTarget, cmdArgs);
            return pipelineProxy;
          };
        },
      });

      return pipelineProxy;
    };
  }

  return new Proxy(client, {
    get(target: T, prop: string | symbol) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== 'string' || typeof value !== 'function') {
        return value;
      }

      if (prop === 'pipeline' || prop === 'multi') {
        return wrapPipelineFactory(value as Function);
      }

      return wrapCommand(prop, value as Function);
    },
  }) as T;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>)['then'] === 'function';
}
