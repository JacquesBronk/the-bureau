# UI Hardening
> Make interfaces production-ready by handling every real-world edge case.

## When to Use
Load this tool after the core UI is built and tests pass. This is the resilience pass — it catches the scenarios that work in demos but break in production.

## Process

Work through each category. For each item, ask: "What happens when this goes wrong?" If the answer is "the UI breaks" or "nothing, I hope" — fix it.

### Text and Content Overflow
- [ ] Long text truncates with ellipsis or wraps gracefully — no horizontal scrollbars, no broken layouts
- [ ] User-generated content is bounded: names, titles, descriptions can be arbitrarily long
- [ ] Empty strings display a meaningful placeholder or fallback, not a blank space or collapsed element
- [ ] Numbers display correctly at extremes: 0, negative, very large, decimal precision
- [ ] Date/time formats handle timezones and locale differences if the project supports i18n
- [ ] RTL text direction works if the project supports RTL languages

### Loading States
- [ ] Every async operation shows a loading indicator
- [ ] Loading indicators appear quickly (within 100ms) to avoid flicker-then-content
- [ ] Skeleton screens match the shape of the loaded content
- [ ] Loading states are accessible: `aria-busy="true"` on loading containers, `aria-live` for completion announcements
- [ ] Repeated rapid loading (e.g., pagination, search-as-you-type) debounces requests and shows the latest result

### Error States
- [ ] API failures show a user-facing error message, not a blank screen or console error
- [ ] Error messages are actionable: tell the user what happened and what they can do (retry, go back, contact support)
- [ ] Network timeout has a distinct message from server error
- [ ] Partial failures show what succeeded alongside what failed
- [ ] Retry buttons exist where operations can be retried
- [ ] Error boundaries catch rendering errors and show fallback UI (React: `ErrorBoundary`, others: equivalent)

### Empty States
- [ ] Lists with zero items show a meaningful empty state, not a blank area
- [ ] Empty states suggest an action (e.g., "No projects yet. Create your first project.")
- [ ] Search with no results distinguishes "no results found" from "loading" from "error"
- [ ] Filtered views show "no results match your filters" with a way to clear filters

### Rapid and Concurrent User Input
- [ ] Button clicks are debounced or disabled after first click to prevent duplicate submissions
- [ ] Form submissions disable the submit button and show a loading state
- [ ] Search input debounces API calls (250-500ms typical)
- [ ] Race conditions are handled: if the user triggers action A then action B, the UI shows B's result, not A's
- [ ] Optimistic updates have rollback on failure

### Network Resilience
- [ ] Slow network (3G): UI remains responsive, loading states are visible
- [ ] Offline: if the app supports offline, UI degrades gracefully; if not, a clear offline message appears
- [ ] Request cancellation: navigating away cancels in-flight requests (AbortController, cleanup functions)

### Internationalization (if project uses i18n)
- [ ] All user-facing strings use the i18n system — no hardcoded English text
- [ ] Text expansion is handled: German/Finnish text can be 30-50% longer than English
- [ ] Pluralization uses the i18n library's plural rules, not string concatenation
- [ ] Number and date formatting uses locale-aware formatters

### Security
- [ ] User-generated content is sanitized before rendering (no raw `innerHTML` / `dangerouslySetInnerHTML` without sanitization)
- [ ] URLs from user input or API are validated before use in `href`, `src`, or `fetch`
- [ ] Sensitive data (tokens, passwords) is never rendered in the DOM or logged to console

## Iron Law
If the component works in the happy path but breaks under any condition listed above, it is not done. Fix it before reporting completion.

## Red Flags
- "Users won't enter text that long" — They will. Or an attacker will.
- "The API always returns data" — It won't. Handle the absence.
- "We'll add error handling in a follow-up" — No. Ship it resilient or don't ship it.
- "This only needs to work in English" — Check with the project. If i18n exists, use it.
