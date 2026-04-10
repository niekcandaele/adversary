/**
 * Convert a string into a filesystem/branch-safe slug.
 * Lowercase, replaces non-alphanumeric with hyphens, trims edges.
 */
export function slugify(text: string, maxLen = 40): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

/**
 * Extract the first Markdown heading from text.
 */
export function extractPlanTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? (match[1] ?? "").trim() : null;
}

/**
 * Format milliseconds as a human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Get ISO timestamp as YYYYMMDD-HHmmss (compact).
 */
export function timestampCompact(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * Replace template variables in a command string.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
    return key in vars ? (vars[key] as string) : match;
  });
}
