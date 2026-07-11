# UI Polish
> Final quality pass that fixes the details separating functional UI from professional UI.

## When to Use
Load this tool as the last step before reporting a frontend task as complete. This runs after implementation, tests, accessibility, and hardening. It is the visual and interaction quality gate.

## Process

Review each category with fresh eyes. Compare every element against its neighbors and the existing design system. Inconsistency is the enemy.

### Spacing and Alignment
- [ ] Spacing between elements uses design system tokens (e.g., 4px/8px/12px/16px/24px scale) — no arbitrary values
- [ ] Related elements are closer together than unrelated elements (proximity principle)
- [ ] Vertical rhythm is consistent: same spacing between repeated items (list rows, card grids, form fields)
- [ ] Horizontal alignment: labels align with labels, values with values, actions with actions
- [ ] Container padding is consistent across similar components
- [ ] Nothing is off by 1-2px — check edges, baselines, and icon centering

### Typography
- [ ] Font sizes use the project's type scale — no hardcoded pixel values outside the scale
- [ ] Font weights are used consistently: headings bold, body regular, captions light/regular
- [ ] Line heights provide readable spacing (1.4-1.6 for body text, tighter for headings)
- [ ] Text truncation is applied consistently for similar content types
- [ ] No orphaned words on short lines where `text-wrap: balance` or similar could help

### Color and Contrast
- [ ] Colors come from the design system palette — no hex codes outside the system
- [ ] Hover, active, and disabled states are visually distinct and consistent across similar components
- [ ] Status colors (success/warning/error/info) are used consistently and with non-color indicators
- [ ] Dark mode (if supported) works correctly: no hard-white backgrounds, proper contrast, shadows adapt

### Interaction Feedback
- [ ] Buttons show immediate feedback on click (color change, loading spinner, or disable)
- [ ] Hover states exist on all interactive elements (desktop)
- [ ] Transitions are smooth and fast (150-250ms for UI state changes, 300-500ms for layout shifts)
- [ ] No layout shifts when content loads or state changes — dimensions are reserved
- [ ] Focus, hover, active, and disabled states are all defined for interactive elements

### Responsive Behavior
- [ ] Layout works from 320px to wide desktop without horizontal scroll
- [ ] Touch targets are at least 44px on mobile (48px preferred)
- [ ] Stacking order makes sense at every breakpoint — important content is not buried
- [ ] Images and media scale proportionally, no distortion
- [ ] Modals and overlays are usable on small screens

### Consistency
- [ ] Component appearance matches other instances of the same component type in the project
- [ ] Icon size and style match the project's icon system
- [ ] Border radius, shadow depth, and elevation match the design system
- [ ] Empty and error states match the visual language of the rest of the app
- [ ] Transitions and animations use consistent timing and easing across the app

### Micro-interactions
- [ ] Loading spinners or skeleton screens replace content during async operations
- [ ] Success/error feedback appears near the action that triggered it
- [ ] Animations respect `prefers-reduced-motion` media query
- [ ] Scroll behavior is smooth where appropriate (`scroll-behavior: smooth` for anchor links)
- [ ] No unnecessary animations that slow down task completion

## Iron Law
Every component you build or modify must pass this checklist before you report it complete. Fix inconsistencies within the components you are working on. Do not reach into unrelated components to "fix" their styling — that is scope creep, not polish.

## Red Flags
- "It looks fine on my screen" — Check multiple viewport sizes. Check dark mode.
- "The spacing is close enough" — It's not. Use the exact token value.
- "Nobody will notice that 1px difference" — Cumulative micro-issues create an amateur feel. Fix them.
- "I'll clean up the styles later" — Polish is not optional. It ships with the feature.
