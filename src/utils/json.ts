/**
 * Extract JSON from LLM output that might have surrounding prose.
 *
 * Strategy: Try each '{' position in the string until we find one that parses
 * as valid JSON, balancing braces while respecting strings and escape sequences.
 * This handles cases where the preamble text contains literal '{' characters.
 *
 * Limitation: only handles JSON objects (starting with '{'), not top-level
 * JSON arrays (starting with '['). All adversary prompts request object output, so
 * array-at-root is not expected. If the full text happens to be a bare JSON array
 * (no surrounding prose), the initial JSON.parse call in step 1 will catch it.
 *
 * Steps:
 * 1. Raw parse — handles bare JSON (both objects and arrays)
 * 2. Markdown code fence extraction — handles ```json fences
 * 3. Iterative brace-scan — tries each '{' position until one parses
 */
export function extractJson(text: string): unknown {
  // 1. Try raw parse first (handles arrays too)
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through
  }

  // 2. Look for JSON block in markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // 3. Iterative brace-scan: try each '{' position until we find one that parses
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) break;

    // Walk from 'start', balancing braces while respecting strings and escape sequences.
    let depth = 0;
    let inString = false;
    let escape = false;
    let foundClose = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        // Note: single-quoted strings are not handled here. Standard JSON only uses
        // double-quoted strings (RFC 8259), so single quotes are never valid JSON string
        // delimiters. LLMs occasionally output single-quoted pseudo-JSON; if that occurs,
        // the brace scanner will fail to balance correctly and fall through to a parse error.
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // This '{' didn't produce valid JSON — try the next one
            searchFrom = start + 1;
            foundClose = true;
            break;
          }
        }
      }
    }

    if (!foundClose) {
      // Unbalanced braces or end of string — advance past this '{' and try next
      searchFrom = start + 1;
    }
  }

  throw new Error(
    `Could not extract JSON from output. ` +
      `Ensure the harness command returns valid JSON (optionally wrapped in a \`\`\`json code fence). ` +
      `Output preview: ${text.slice(0, 300).replace(/\n/g, "\\n")}`
  );
}
