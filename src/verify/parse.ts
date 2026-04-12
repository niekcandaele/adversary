import type { VerifyReport } from "../types/index.js";
import { readJsonFile } from "../utils/fs.js";

export class VerifyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyParseError";
  }
}

export async function parseVerifyOutput(verifyJsonPath: string): Promise<VerifyReport> {
  let raw: unknown;
  try {
    raw = await readJsonFile(verifyJsonPath);
  } catch (e) {
    throw new VerifyParseError(`Cannot read verify output at ${verifyJsonPath}: ${e}`);
  }

  const report = raw as Record<string, unknown>;
  if (typeof report !== "object" || report === null) {
    throw new VerifyParseError("Verify output is not a JSON object");
  }
  if (report.schemaVersion !== 1) {
    throw new VerifyParseError(`Unexpected schemaVersion: ${report.schemaVersion}`);
  }
  if (!["ok", "blocked", "error", "skipped"].includes(report.status as string)) {
    throw new VerifyParseError(`Invalid status: ${report.status}`);
  }
  if (!Array.isArray(report.findings)) {
    throw new VerifyParseError("findings must be an array");
  }

  for (let i = 0; i < report.findings.length; i++) {
    const f = report.findings[i] as Record<string, unknown>;
    if (typeof f !== "object" || f === null) {
      throw new VerifyParseError(`findings[${i}] is not an object`);
    }
    if (typeof f.title !== "string") {
      throw new VerifyParseError(`findings[${i}].title must be a string`);
    }
    if (typeof f.severity !== "number") {
      throw new VerifyParseError(`findings[${i}].severity must be a number`);
    }
    const sev = f.severity as number;
    if (sev < 1 || sev > 10) {
      process.stderr.write(
        `  Warning: findings[${i}].severity=${sev} is outside expected range 1..10 — proceeding anyway.\n`
      );
    }
    if (typeof f.description !== "string") {
      throw new VerifyParseError(`findings[${i}].description must be a string`);
    }
    if (!Array.isArray(f.sources)) {
      throw new VerifyParseError(`findings[${i}].sources must be an array`);
    }
  }

  return raw as VerifyReport;
}
