# Accessibility Checklist
> WCAG 2.2 AA compliance verification for UI components and pages.

## When to Use
Load this tool during or after building UI components — before claiming any frontend work is complete. Run through the checklist for every component, page, or interaction you build.

## Process

Work through each section. Check every item. If an item does not apply, note why and move on. Do not skip items without justification.

### Semantic HTML
- [ ] Use correct HTML elements (`<button>` not `<div onClick>`, `<nav>`, `<main>`, `<article>`, `<aside>`, `<header>`, `<footer>`)
- [ ] Headings follow a logical hierarchy (`h1` > `h2` > `h3`, no skipped levels)
- [ ] Lists use `<ul>`, `<ol>`, or `<dl>` — not styled divs
- [ ] Tables use `<th>`, `<caption>`, and `scope` attributes for data tables
- [ ] Forms use `<label>` elements explicitly associated with inputs via `for`/`id`
- [ ] Landmarks (`<main>`, `<nav>`, `<aside>`) are present and not duplicated without labels

### Keyboard Navigation
- [ ] Every interactive element is reachable via Tab key
- [ ] Tab order follows visual reading order (no positive `tabindex` values)
- [ ] Custom widgets implement expected keyboard patterns (Arrow keys for menus, Escape to close, Enter/Space to activate)
- [ ] Focus is never trapped — user can always Tab out of a component (except modals, which trap focus intentionally)
- [ ] Focus is managed after dynamic changes: opening a dialog moves focus into it; closing returns focus to the trigger
- [ ] Skip links are present for page-level navigation

### Focus Visibility (WCAG 2.2 — 2.4.11, 2.4.12)
- [ ] Focus indicator is always visible — never hidden by overlapping content, sticky headers, or z-index issues
- [ ] Focus indicator has sufficient contrast (3:1 minimum against adjacent colors)
- [ ] Focus indicator encloses the entire component or has a visible area of at least 1 CSS pixel along the perimeter
- [ ] Custom focus styles use `outline` or `box-shadow`, never just `background-color` change

### ARIA
- [ ] ARIA is used only where semantic HTML is insufficient — prefer native elements
- [ ] `aria-label` or `aria-labelledby` is set on elements that lack visible text labels
- [ ] `aria-live` regions announce dynamic content changes to screen readers
- [ ] `aria-expanded`, `aria-selected`, `aria-checked` reflect widget state accurately
- [ ] `role` attributes match the widget pattern (e.g., `role="dialog"` for modals, `role="tablist"` for tabs)
- [ ] No `aria-hidden="true"` on focusable elements

### Color and Contrast
- [ ] Text contrast meets 4.5:1 (normal text) or 3:1 (large text, 18px+ or 14px+ bold)
- [ ] UI component contrast meets 3:1 against adjacent colors (borders, icons, form controls)
- [ ] Information is not conveyed by color alone — use icons, text, or patterns as redundant cues
- [ ] Focus indicators meet 3:1 contrast

### Touch and Pointer (WCAG 2.2 — 2.5.7, 2.5.8)
- [ ] Touch targets are at least 24x24 CSS pixels (Level AA)
- [ ] Inline text links are exempt but adjacent targets have adequate spacing
- [ ] Drag-and-drop interactions have a single-pointer alternative (button, select, etc.)
- [ ] No functionality depends solely on multipoint or path-based gestures

### Forms and Input
- [ ] Error messages are associated with the field (`aria-describedby` or `aria-errormessage`)
- [ ] Required fields are indicated both visually and programmatically (`aria-required` or `required`)
- [ ] Autocomplete attributes are set for common fields (`name`, `email`, `tel`, `address-*`)
- [ ] Redundant entry (WCAG 2.2 — 3.3.7): previously entered information is auto-populated or available for selection — users should not need to re-enter the same data in the same session

### Authentication (WCAG 2.2 — 3.3.8)
- [ ] Authentication does not require cognitive function tests (object recognition, personal content recall)
- [ ] Copy-paste is allowed in password fields
- [ ] Authentication supports assistive technology (password managers, autofill)

### Consistent Help (WCAG 2.2 — 3.2.6)
- [ ] If help mechanisms exist (contact info, chat, FAQ links), they appear in the same relative location across pages

### Media and Images
- [ ] Images have meaningful `alt` text, or `alt=""` for decorative images
- [ ] SVG icons have `aria-hidden="true"` when decorative, or `role="img"` + `aria-label` when meaningful
- [ ] Video has captions; audio has transcripts
- [ ] No content flashes more than 3 times per second

### Motion and Animation
- [ ] Animations respect `prefers-reduced-motion` — disable or reduce non-essential motion
- [ ] No auto-playing content that cannot be paused or stopped
- [ ] Carousel/slider has pause controls and does not auto-advance without user control

## Iron Law
Accessibility is a hard requirement, not a stretch goal. No component ships without passing this checklist. If a check fails, fix it before moving to the next phase.

## Red Flags
- "I'll add accessibility later" — No. Build it in from the start.
- "Screen reader users won't use this feature" — You don't know that. Build for everyone.
- "The design doesn't show focus styles" — Add them anyway. Design specs omit what they assume exists.
- "ARIA will fix the semantic issue" — Use the correct HTML element first. ARIA is a last resort.
