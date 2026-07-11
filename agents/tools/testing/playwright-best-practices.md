# Playwright Best Practices
> Modern Playwright patterns for reliable, maintainable e2e tests.

## When to Use
Load this tool when writing or reviewing Playwright e2e tests. Covers locator strategy, fixtures, authentication, and common anti-patterns.

## Locator Priority

Use locators in this order. Higher is better — fall back only when the preferred option is unavailable.

1. **`getByRole()`** — Best. Matches how users and assistive technology see the page. Always pass accessible name: `page.getByRole('button', { name: 'Submit' })`.
2. **`getByLabel()`** — For form fields associated with a `<label>`.
3. **`getByPlaceholder()`** — When no label exists but placeholder text is meaningful.
4. **`getByText()`** — For non-interactive elements identified by visible text.
5. **`getByTestId()`** — Last resort for elements with no accessible role, label, or meaningful text. Requires `data-testid` attribute.

**Never use:** CSS class selectors, XPath, tag nesting, `:nth-child`, DOM structure. These break when styles or layout change.

**Chain and filter** to narrow scope:
```typescript
page.getByRole('listitem').filter({ hasText: 'Product 2' });
page.getByRole('navigation').getByRole('link', { name: 'Login' });
```

## Web-First Assertions

Use `expect(locator)` — these auto-retry until the condition is met or timeout expires.

```typescript
// CORRECT — auto-retries
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
await expect(page.getByRole('alert')).toHaveText('Saved successfully');

// WRONG — evaluates once, no retry
expect(await page.getByText('welcome').isVisible()).toBe(true);
```

Common web-first assertions:
- `toBeVisible()`, `toBeHidden()`, `toBeEnabled()`, `toBeDisabled()`
- `toHaveText()`, `toContainText()`, `toHaveValue()`
- `toHaveURL()`, `toHaveTitle()`
- `toHaveCount()` for list assertions

## Fixtures Over Page Objects

Prefer custom test fixtures (`test.extend()`) over standalone Page Object classes. Fixtures encapsulate setup AND teardown in one place, are lazily initialized, composable, and type-safe.

### Defining fixtures
```typescript
// fixtures.ts
import { test as base } from '@playwright/test';
import { TodoPage } from './pages/todo-page';

type MyFixtures = {
  todoPage: TodoPage;
};

export const test = base.extend<MyFixtures>({
  todoPage: async ({ page }, use) => {
    const todoPage = new TodoPage(page);
    await todoPage.goto();
    await use(todoPage);        // test runs here
    await todoPage.removeAll(); // teardown
  },
});

export { expect } from '@playwright/test';
```

### Using fixtures in tests
```typescript
import { test, expect } from './fixtures';

test('can add todo', async ({ todoPage }) => {
  await todoPage.addToDo('Buy milk');
  await expect(todoPage.items).toHaveCount(1);
});
```

### Worker-scoped fixtures
For expensive setup shared across tests in one worker (e.g., accounts, server connections):
```typescript
export const test = base.extend<{}, { account: Account }>({
  account: [async ({ browser }, use, workerInfo) => {
    const account = await createAccount('user' + workerInfo.workerIndex);
    await use(account);
    await deleteAccount(account);
  }, { scope: 'worker' }],
});
```

### Automatic fixtures
Run for every test without being requested:
```typescript
saveLogs: [async ({}, use, testInfo) => {
  const logs: string[] = [];
  await use();
  if (testInfo.status !== 'passed') {
    await testInfo.attach('logs', { body: logs.join('\n') });
  }
}, { auto: true }],
```

## Authentication via storageState

Authenticate once, reuse across tests. Never re-login in every test.

### Setup project pattern (shared account)
```typescript
// auth.setup.ts
import { test as setup, expect } from '@playwright/test';

const authFile = 'playwright/.auth/user.json';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/dashboard');
  await page.context().storageState({ path: authFile });
});
```

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { storageState: 'playwright/.auth/user.json' },
    },
  ],
});
```

### Per-worker auth (isolated accounts for parallel tests that modify state)
```typescript
export const test = base.extend<{}, { workerStorageState: string }>({
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
  workerStorageState: [async ({ browser }, use) => {
    const id = test.info().parallelIndex;
    const fileName = path.resolve(test.info().project.outputDir, `.auth/${id}.json`);
    if (fs.existsSync(fileName)) { await use(fileName); return; }
    const page = await browser.newPage({ storageState: undefined });
    // ... login with worker-specific account ...
    await page.context().storageState({ path: fileName });
    await page.close();
    await use(fileName);
  }, { scope: 'worker' }],
});
```

### Multiple roles in one test
```typescript
test('admin approves user request', async ({ browser }) => {
  const adminCtx = await browser.newContext({ storageState: 'playwright/.auth/admin.json' });
  const userCtx = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
  const adminPage = await adminCtx.newPage();
  const userPage = await userCtx.newPage();
  // Interact with both pages...
  await adminCtx.close();
  await userCtx.close();
});
```

**Security:** Auth state files contain sensitive cookies — add `playwright/.auth/` to `.gitignore`.

## API-Based Test Data Setup

Use Playwright's `request` fixture to set up test data via API calls instead of UI interactions. Faster and more reliable.

```typescript
test('displays created items', async ({ page, request }) => {
  // Create test data via API
  await request.post('/api/items', { data: { name: 'Test Item', status: 'active' } });

  // Then verify via UI
  await page.goto('/items');
  await expect(page.getByRole('cell', { name: 'Test Item' })).toBeVisible();
});
```

For authenticated API calls, use `storageState` with the `request` fixture — it shares cookies automatically.

## Trace and Screenshot Configuration

Configure failure diagnostics in `playwright.config.ts`:
```typescript
export default defineConfig({
  use: {
    trace: 'on-first-retry',      // Captures trace on retry — best balance of speed vs diagnostics
    screenshot: 'only-on-failure', // Screenshot on failure
    video: 'retain-on-failure',    // Video only for failed tests
  },
  retries: process.env.CI ? 2 : 0,
});
```

View traces: `npx playwright show-trace trace.zip`

## Iron Law
Every locator must target user-visible attributes or explicit test contracts (`data-testid`). If you cannot locate an element without relying on CSS classes or DOM structure, the UI needs to be made more testable — request changes from the developer rather than writing a brittle selector.

## Red Flags
- "I'll use `page.locator('.btn-primary')` since it's quick" — STOP. Use `getByRole`.
- "I'll add `page.waitForTimeout(2000)` to let the page load" — STOP. Use web-first assertions or `waitForURL`.
- "I'll log in through the UI at the start of every test" — STOP. Use `storageState`.
- "I'll put all Page Objects in `beforeEach`" — Consider fixtures instead.
- "The element has no role or label, so I'll use XPath" — STOP. Request a `data-testid` from the developer.
