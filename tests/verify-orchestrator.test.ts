import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { runVerification } from "../src/verify/index.js";
import type { AdversaryConfig, VerifyScope, ToolchainDiscovery } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adversary-orch-test-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-b", "main");
  await run("git", "config", "user.email", "test@test.com");
  await run("git", "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "# Test");
  const proc = Bun.spawn(["sh", "-c", "git add -A && git commit -m init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return dir;
}

function writeFakeHarness(
  dir: string,
  name: string,
  opts: { synthesisFindings?: unknown[]; skillFindings?: unknown[]; synthesisStatus?: "ok" | "error" } = {}
): string {
  const { synthesisFindings = [], skillFindings = [], synthesisStatus = "ok" } = opts;
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q 'schemaVersion'; then
  echo '{"schemaVersion":1,"status":"${synthesisStatus}","findings":${JSON.stringify(synthesisFindings)}}'
  exit 0
fi

if echo "$CONTENT" | grep -q 'Branch Verification Context'; then
  echo '{"status":"completed","findings":${JSON.stringify(skillFindings)}}'
  exit 0
fi

if echo "$CONTENT" | grep -q 'tool-output-analyzer\|deterministic verification failure analyzer'; then
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

echo '{"status":"completed","findings":${JSON.stringify(skillFindings)}}'
exit 0
`,
    { mode: 0o755 }
  );
  return path;
}

const EMPTY_SCOPE: VerifyScope = {
  baseBranch: "main",
  mergeBase: "deadbeef",
  files: [{ path: "src/test.ts", status: "added" }],
  diffCommand: "git diff --name-status deadbeef...HEAD",
  diffStat: "1 file changed",
};

const EMPTY_DISCOVERY: ToolchainDiscovery = {
  testCommand: null,
  buildCommand: null,
  lintCommands: [],
  typeCheckCommands: [],
  startCommand: null,
  stopCommand: null,
  browserDeps: [],
};

describe("runVerification orchestrator", () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-orch-tmp-"));
    cwd = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  test("creates branch-wide verify artifact layout", async () => {
    const turnDir = join(tmpDir, "turn-1");
    const harness = writeFakeHarness(tmpDir, "fake-harness.sh");

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config: { ...DEFAULT_CONFIG, verifyCommandTemplate: `${harness} @{promptFile}` },
      repoGuidance: "",
    });

    expect(report.status).toBe("ok");
    expect(existsSync(join(turnDir, "verify", "branch-context.txt"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "reviewer", "prompt.md"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "qa", "output.json"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "exerciser", "output.json"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "synthesis", "prompt.md"))).toBe(true);
    expect(existsSync(join(turnDir, "verify.json"))).toBe(true);
  }, 120000);

  test("built-in prompts include branch-wide plan context", async () => {
    const turnDir = join(tmpDir, "turn-2");
    const harness = writeFakeHarness(tmpDir, "fake-harness-prompt.sh");

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# My Special Plan",
      config: { ...DEFAULT_CONFIG, verifyCommandTemplate: `${harness} @{promptFile}` },
      repoGuidance: "## Project Skills\n\nSome skill info\n\n---\n\n## Repo Docs\n\nUse the repo guide.",
    });

    const reviewerPrompt = await Bun.file(join(turnDir, "verify", "steps", "reviewer", "prompt.md")).text();
    expect(reviewerPrompt).toContain("src/test.ts");
    expect(reviewerPrompt).toContain("Some skill info");
    const branchContext = await Bun.file(join(turnDir, "verify", "branch-context.txt")).text();
    expect(branchContext).toContain("Use the repo guide.");

    const planPrompt = await Bun.file(join(turnDir, "verify", "steps", "plan-completeness", "prompt.md")).text();
    expect(planPrompt).toContain("My Special Plan");
  }, 120000);

  test("parallel-review custom steps run and store per-step artifacts", async () => {
    const turnDir = join(tmpDir, "turn-custom-parallel");
    const harness = writeFakeHarness(tmpDir, "fake-harness-custom.sh");
    const customStep = join(tmpDir, "custom-step.sh");
    writeFileSync(customStep, "#!/bin/sh\necho 'plain text issue output'\n", { mode: 0o755 });

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config: {
        ...DEFAULT_CONFIG,
        verifyCommandTemplate: `${harness} @{promptFile}`,
        customVerificationSteps: [
          { name: "codex-review", commandTemplate: customStep, phase: "parallel-review" },
        ],
      },
      repoGuidance: "",
    });

    expect(existsSync(join(turnDir, "verify", "steps", "codex-review", "stdout.log"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "codex-review", "analysis.prompt.md"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "codex-review", "output.json"))).toBe(true);
  }, 120000);

  test("configured deterministic steps override discovered fallback and run before exerciser", async () => {
    const turnDir = join(tmpDir, "turn-deterministic");
    const harness = writeFakeHarness(tmpDir, "fake-harness-det.sh");
    const orderFile = join(tmpDir, "order.log");
    const deterministicStep = join(tmpDir, "det-step.sh");
    const discoveredTest = join(tmpDir, "discovered-test.sh");
    writeFileSync(deterministicStep, `#!/bin/sh\necho custom-test >> "${orderFile}"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(discoveredTest, `#!/bin/sh\necho discovered-test >> "${orderFile}"\nexit 0\n`, { mode: 0o755 });

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: { ...EMPTY_DISCOVERY, testCommand: discoveredTest },
      planContent: "# Test Plan",
      config: {
        ...DEFAULT_CONFIG,
        verifyCommandTemplate: `${harness} @{promptFile}`,
        customVerificationSteps: [
          { name: "custom-test", phase: "deterministic", kind: "test", commandTemplate: deterministicStep },
        ],
      },
      repoGuidance: "",
    });

    expect(existsSync(join(turnDir, "verify", "steps", "custom-test", "output.json"))).toBe(true);
    expect(existsSync(join(turnDir, "verify", "steps", "discovered-test", "output.json"))).toBe(false);

    const order = (await Bun.file(orderFile).text()).trim().split("\n");
    expect(order).toEqual(["custom-test"]);
  }, 120000);

  test("malformed built-in output becomes a severity-8 finding instead of terminal verify error", async () => {
    const turnDir = join(tmpDir, "turn-malformed");
    const badHarness = join(tmpDir, "bad-harness.sh");
    writeFileSync(badHarness, "#!/bin/sh\necho 'not json'\n", { mode: 0o755 });

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config: { ...DEFAULT_CONFIG, verifyCommandTemplate: `${badHarness} @{promptFile}` },
      repoGuidance: "",
    });

    expect(report.status).toBe("ok");
    expect(report.findings.some((finding) => finding.severity === 8)).toBe(true);
  }, 120000);

  test("synthesis status error is normalized to ok when findings are valid", async () => {
    const turnDir = join(tmpDir, "turn-synthesis-status-error");
    const harness = writeFakeHarness(tmpDir, "fake-harness-synthesis-error.sh", {
      synthesisStatus: "error",
      synthesisFindings: [
        {
          title: "Real product issue",
          severity: 8,
          description: "The branch still has a defect that should feed the next turn.",
          sources: ["reviewer"],
          location: { path: "src/test.ts", line: 1 },
        },
      ],
    });

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config: { ...DEFAULT_CONFIG, verifyCommandTemplate: `${harness} @{promptFile}` },
      repoGuidance: "",
    });

    expect(report.status).toBe("ok");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("Real product issue");
  }, 120000);

  // VI-3 regression / VI-28: Deterministic findings from out-of-scope files must NOT be filtered.
  // The build pipeline or test suite can break in a consumer file that was NOT directly edited —
  // those regressions must appear in the final report even if location.path is outside scope.
  test("(VI-3/VI-28) deterministic finding with out-of-scope path is preserved in final report", async () => {
    const turnDir = join(tmpDir, "turn-vi28");

    // Harness returns a deterministic-style finding whose location.path is outside EMPTY_SCOPE
    // (EMPTY_SCOPE only contains "src/test.ts"; this finding targets "src/consumer.ts").
    // The finding comes from the synthesis output (the deterministic runner is mocked via the
    // harness: any skill prompt that doesn't contain "schemaVersion" returns an out-of-scope finding).
    const harness = writeFakeHarness(tmpDir, "fake-harness-vi28.sh", {
      synthesisFindings: [
        {
          title: "Out-of-scope deterministic regression",
          severity: 7,
          description: "A build/test error in a consumer file not directly edited on this branch.",
          sources: ["deterministic"],
          location: { path: "src/consumer.ts", line: 5 },
        },
      ],
      skillFindings: [],
    });

    const report = await runVerification({
      cwd,
      turnDir,
      // Scope only covers "src/test.ts" — "src/consumer.ts" is intentionally out of scope
      scope: {
        baseBranch: "main",
        mergeBase: "deadbeef",
        files: [{ path: "src/test.ts", status: "added" }],
        diffCommand: "git diff --name-status deadbeef...HEAD",
        diffStat: "1 file changed",
      },
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config: { ...DEFAULT_CONFIG, verifyCommandTemplate: `${harness} @{promptFile}` },
      repoGuidance: "",
    });

    // The out-of-scope finding from synthesis must appear in the final report.
    // Previously, the double-filter at line 183 would drop it.
    const outOfScopeFindings = report.findings.filter(
      (f) => f.location?.path === "src/consumer.ts"
    );
    expect(outOfScopeFindings).toHaveLength(1);
    expect(outOfScopeFindings[0]?.title).toBe("Out-of-scope deterministic regression");
  }, 120000);
});
