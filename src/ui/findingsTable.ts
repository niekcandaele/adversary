import type { VerifyFinding } from "../types/index.js";

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

/**
 * Render findings as a box-drawing table for terminal display.
 */
export function formatFindingsTable(findings: VerifyFinding[]): string {
  if (findings.length === 0) return "";

  const termWidth = Math.max(60, process.stdout.columns || 100);

  // Calculate column widths
  const numW = Math.max(2, String(findings.length).length);
  const sevW = 8;
  const sourceW = Math.min(
    16,
    Math.max(6, ...findings.map((f) => f.sources.join(", ").length))
  );
  // 5 borders (│) + 4 * 2 padding spaces = 13 fixed chars, + 2 for left indent
  const overhead = 13 + 2;
  const titleW = Math.max(20, termWidth - overhead - numW - sevW - sourceW);

  // Description spans from after # column to end: title + sev + source + their padding/borders
  const descW = titleW + sevW + sourceW + 8; // 8 = 3 borders * 1 + 3 * 2 padding - 1

  // Box-drawing helpers
  const hline = (l: string, m: string, r: string) =>
    `  ${l}${"─".repeat(numW + 2)}${m}${"─".repeat(titleW + 2)}${m}${"─".repeat(sevW + 2)}${m}${"─".repeat(sourceW + 2)}${r}`;

  const dataRow = (num: string, title: string, sev: string, source: string) =>
    `  │ ${pad(num, numW)} │ ${pad(title, titleW)} │ ${pad(sev, sevW)} │ ${pad(source, sourceW)} │`;

  // Description row: # column empty, then text spans the rest
  const descRow = (text: string) =>
    `  │ ${" ".repeat(numW)} │ ${pad(text, descW)} │`;

  const out: string[] = [];
  out.push(hline("┌", "┬", "┐"));
  out.push(dataRow("#", "Title", "Severity", "Source"));
  out.push(hline("├", "┼", "┤"));

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    if (i > 0) out.push(hline("├", "┼", "┤"));

    out.push(dataRow(String(i + 1), truncate(f.title, titleW), String(f.severity), f.sources.join(", ")));
    out.push(descRow(""));
    for (const line of wrapText(f.description.trim(), descW)) {
      out.push(descRow(line));
    }
  }

  out.push(hline("└", "┴", "┘"));
  return out.join("\n");
}

function truncate(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}
