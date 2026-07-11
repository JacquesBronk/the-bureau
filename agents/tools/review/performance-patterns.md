# Performance Analysis Patterns
> Systematic catalog of performance anti-patterns and optimization strategies across backend, frontend, and data access layers.

## When to Use

Load this tool when performing a performance review, analyzing code for bottlenecks, or evaluating optimization opportunities. Reference the relevant section based on the codebase layer you are analyzing.

## Process

Work through each applicable section in order of impact: data access first (highest leverage), then algorithmic, then runtime/memory, then frontend, then network. Skip sections that don't apply to the codebase under review.

## 1. Data Access Patterns

### N+1 Queries
- **Signal**: Loop that executes a query per iteration; ORM lazy-loading inside a loop
- **Fix**: Batch fetch with `WHERE id IN (...)`, eager loading, or `JOIN`
- **Impact**: Reduces n queries to 1-2; often 10-100x improvement at scale

### Missing Indexes
- **Signal**: `WHERE`, `ORDER BY`, or `JOIN ON` columns without indexes; `EXPLAIN` shows sequential scan
- **Fix**: Add index on filtered/sorted columns; consider composite indexes for multi-column queries
- **Impact**: O(n) scan to O(log n) lookup; seconds to milliseconds at >10k rows

### Unbounded Result Sets
- **Signal**: `SELECT *` without `LIMIT`; no pagination on list endpoints; `findAll()` without constraints
- **Fix**: Add pagination (`LIMIT`/`OFFSET` or cursor-based); select only needed columns
- **Impact**: Prevents OOM at scale; reduces network payload and serialization cost

### Connection Pool Exhaustion
- **Signal**: Unclosed connections, connection creation inside loops, no pool size limits
- **Fix**: Use connection pooling; ensure connections are returned via `try/finally` or context managers
- **Impact**: Prevents cascading failures under load

## 2. Algorithmic Patterns

### Quadratic Loops
- **Signal**: Nested loops over the same or related collections; `.includes()` / `.indexOf()` inside a loop
- **Fix**: Use a `Set` or `Map` for O(1) lookups; sort + binary search; restructure to single pass
- **Impact**: O(n^2) to O(n) or O(n log n); matters when n > ~1000

### Redundant Computation
- **Signal**: Same expensive function called multiple times with identical inputs; recomputation inside render loops
- **Fix**: Memoize results; hoist computation out of loops; cache at the appropriate scope
- **Impact**: Linear reduction proportional to duplication factor

### Suboptimal Data Structures
- **Signal**: Array used for frequent membership checks; linear search through sorted data; linked list for indexed access
- **Fix**: Match data structure to access pattern — `Set` for membership, `Map` for key-value, sorted array + binary search for ordered data
- **Impact**: Often O(n) to O(1) or O(log n) per operation

### String Building in Loops
- **Signal**: String concatenation (`+=`) inside loops; repeated `JSON.stringify` of growing objects
- **Fix**: Use array + `join()`, `StringBuilder`, or streaming serialization
- **Impact**: O(n^2) to O(n) for string operations; significant when n > ~10k

## 3. Memory and Resource Patterns

### Resource Leaks
- **Signal**: `open()` / `new Stream()` / `createConnection()` without corresponding close; event listeners added but never removed; timers/intervals not cleared
- **Fix**: Use `try/finally`, `using`, `defer`, context managers, or RAII patterns; clear listeners and timers on cleanup
- **Impact**: Prevents memory growth and file descriptor exhaustion over time

### Unnecessary Object Copies
- **Signal**: Deep clone when shallow would suffice; spread operator in tight loops; `JSON.parse(JSON.stringify(...))` for cloning
- **Fix**: Use shallow copy, structural sharing, or immutable data structures; avoid cloning when mutation is safe
- **Impact**: Reduces GC pressure and allocation cost proportional to object size

### Unbounded Caches
- **Signal**: Cache (`Map`, `{}`, memoization) that grows without eviction; no `maxSize` or TTL
- **Fix**: Add LRU eviction, TTL, or size limits; use `WeakMap` for GC-friendly caching of object keys
- **Impact**: Prevents memory leaks in long-running processes

### Buffer Sizing
- **Signal**: Fixed large buffer allocation regardless of input; reading entire file into memory for streaming-compatible operations
- **Fix**: Use streaming/chunked processing; size buffers to expected input; use memory-mapped I/O for large files
- **Impact**: Reduces peak memory; enables processing of inputs larger than available RAM

## 4. Frontend Patterns

### Bundle Size
- **Signal**: Large dependencies imported for small utility; no code splitting; no tree-shaking; entire library imported for one function
- **Fix**: Import specific modules (`lodash/get` not `lodash`); dynamic `import()` for routes/features; analyze with bundle analyzer
- **Impact**: Reduces initial load time; each 100KB of JS adds ~100ms parse time on mobile

### Render Performance
- **Signal**: Component re-renders on every parent render; expensive computation in render path; missing `key` props causing full list re-renders
- **Fix**: `React.memo` / `useMemo` / `useCallback` for expensive paths; stable keys; virtualize long lists (>100 items)
- **Impact**: Reduces frame drops and interaction latency; critical for lists and real-time updates

### Layout Thrashing
- **Signal**: Alternating DOM reads and writes (read `offsetHeight`, set `style.height`, repeat); forced synchronous layout in loops
- **Fix**: Batch reads before writes; use `requestAnimationFrame`; use CSS transforms instead of layout properties for animation
- **Impact**: Eliminates jank; reduces layout recalculations from O(n) to O(1)

### Image Optimization
- **Signal**: Uncompressed images; images larger than display size; no lazy loading for below-fold images; no modern format (WebP/AVIF)
- **Fix**: Compress and resize; use `srcset` for responsive images; add `loading="lazy"`; convert to WebP/AVIF with fallback
- **Impact**: Often the single largest payload reduction; 50-80% size savings typical

## 5. Network and I/O Patterns

### Request Waterfalls
- **Signal**: Sequential API calls where earlier responses don't inform later requests; `await` in a loop
- **Fix**: `Promise.all` / `Promise.allSettled` for independent requests; batch APIs; GraphQL for multiple resources
- **Impact**: Total latency drops from sum to max of individual requests

### Missing Compression
- **Signal**: No gzip/brotli on text responses; uncompressed JSON payloads; no `Accept-Encoding` handling
- **Fix**: Enable server-side compression; use brotli for static assets; compress at the reverse proxy level
- **Impact**: 60-80% reduction in text payload size

### Polling vs. Push
- **Signal**: `setInterval` polling an endpoint for updates; short poll intervals (<5s) for infrequent changes
- **Fix**: WebSocket or SSE for real-time updates; long polling as middle ground; exponential backoff for polling
- **Impact**: Reduces server load and improves update latency

### Synchronous I/O on Hot Path
- **Signal**: `readFileSync`, blocking network calls, CPU-intensive computation on main thread/event loop
- **Fix**: Use async variants; offload CPU work to worker threads/processes; use streaming for large I/O
- **Impact**: Unblocks event loop; prevents request queuing; critical for server throughput

## Iron Law

Never report a performance finding without stating the expected data scale at which it matters and how to measure the improvement. "This is slow" is not a finding.

## Red Flags

- "This looks like it could be slow" — Do you have evidence? Check the scale context before reporting.
- "Let me optimize this just in case" — Premature optimization. Only optimize measured or scale-justified bottlenecks.
- "The optimized version is more complex but faster" — Is the speedup worth the readability cost? At what scale?
- "I'll skip the data access layer" — Data access is almost always the highest-leverage area. Start there.
