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
  opts: { synthesisFindings?: unknown[]; skillFindings?: unknown[] } = {}
): string {
  const { synthesisFindings = [], skillFindings = [] } = opts;
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
  echo '{"schemaVersion":1,"status":"ok","findings":${JSON.stringify(synthesisFindings)}}'
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
      projectSkills: "",
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
      projectSkills: "## Project Skills\n\nSome skill info",
    });

    const reviewerPrompt = await Bun.file(join(turnDir, "verify", "steps", "reviewer", "prompt.md")).text();
    expect(reviewerPrompt).toContain("src/test.ts");
    expect(reviewerPrompt).toContain("Some skill info");

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
      projectSkills: "",
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
      projectSkills: "",
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
      projectSkills: "",
    });

    expect(report.status).toBe("ok");
    expect(report.findings.some((finding) => finding.severity === 8)).toBe(true);
  }, 120000);
});
