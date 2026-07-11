/**
 * Parse the text content from a Bureau MCP tool response into its structured value.
 *
 * Handles all four envelope conventions documented in src/types/api.ts:
 *   - Pure JSON:  the full text is JSON.parse'd directly.
 *   - Text+`---`: human text, then `\n---\n`, then JSON. Returns parsed JSON tail.
 *   - Labelled:   get_task_graph emits `Detailed:\n<json>` and optionally `Graph:\n<json>`.
 *                 Returns { detailed: unknown, graph: unknown | undefined }.
 *   - Plain text: no JSON present (e.g. check_health with zero peers). Returns the raw string.
 */
export function parseToolOutput(text: string): unknown {
  // Labelled envelope: get_task_graph
  if (text.includes("\nDetailed:\n") || text.startsWith("Detailed:\n")) {
    const detailedMatch = text.match(/(?:^|\n)Detailed:\n([\s\S]*?)(?:\n\nGraph:\n([\s\S]*))?$/);
    if (detailedMatch) {
      const detailed = JSON.parse(detailedMatch[1].trimEnd());
      const graph = detailedMatch[2] !== undefined ? JSON.parse(detailedMatch[2].trimEnd()) : undefined;
      return { detailed, graph };
    }
  }

  // Text + `---` envelope: split on FIRST occurrence
  const sepIdx = text.indexOf("\n---\n");
  if (sepIdx !== -1) {
    return JSON.parse(text.slice(sepIdx + 5));
  }

  // Pure JSON: attempt direct parse
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to plain text
    }
  }

  // Plain text fallback
  return text;
}
