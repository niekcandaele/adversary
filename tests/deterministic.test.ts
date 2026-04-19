import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { buildCommandSpecs, runDeterministicCommands } from "../src/verify/deterministic.js";
import type { AdversaryConfig, ToolchainDiscovery } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

const BASE_CONFIG: AdversaryConfig = {
  ...DEFAULT_CONFIG,
  testTimeoutMs: 30000,
  verifyTimeoutMs: 30000,
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

describe("buildCommandSpecs", () => {
  test("uses discovered-* names for fallback commands", () => {
    const specs = buildCommandSpecs({
      testCommand: "bun test",
      buildCommand: "bun build src/index.ts",
      lintCommands: ["bun run lint", "bunx prettier --check ."],
      typeCheckCommands: ["bun run typecheck"],
      startCommand: null,
      stopCommand: null,
      browserDeps: [],
    }, BASE_CONFIG);

    expect(specs.map((spec) => spec.name)).toEqual([
      "discovered-test",
      "discovered-build",
      "discovered-lint-0",
      "discovered-lint-1",
      "discovered-typecheck",
    ]);
  });

  test("configured deterministic steps override discovered fallback for their kind", () => {
    const specs = buildCommandSpecs({
      testCommand: "bun test",
      buildCommand: "bun build src/index.ts",
      lintCommands: ["bun run lint"],
      typeCheckCommands: ["bun run typecheck"],
      startCommand: null,
      stopCommand: null,
      browserDeps: [],
    }, {
      ...BASE_CONFIG,
      customVerificationSteps: [
        { name: "custom-tests", phase: "deterministic", kind: "test", commandTemplate: "bun test packages/core" },
        { name: "custom-lint", phase: "deterministic", kind: "lint", commandTemplate: "bun run lint:strict" },
      ],
    });

    expect(specs.map((spec) => spec.name)).toEqual([
      "custom-tests",
      "discovered-build",
      "custom-lint",
      "discovered-typecheck",
    ]);
  });

  test("preserves fixed kind order and configured order within a kind", () => {
    const specs = buildCommandSpecs(EMPTY_DISCOVERY, {
      ...BASE_CONFIG,
      customVerificationSteps: [
        { name: "test-a", phase: "deterministic", kind: "test", commandTemplate: "echo test-a" },
        { name: "test-b", phase: "deterministic", kind: "test", commandTemplate: "echo test-b" },
        { name: "lint-a", phase: "deterministic", kind: "lint", commandTemplate: "echo lint-a" },
        { name: "build-a", phase: "deterministic", kind: "build", commandTemplate: "echo build-a" },
      ],
    });

    expect(specs.map((spec) => spec.name)).toEqual(["test-a", "test-b", "build-a", "lint-a"]);
  });
});

describe("runDeterministicCommands", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-det-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deterministicOptions(discovery: ToolchainDiscovery, config: AdversaryConfig = BASE_CONFIG) {
    return {
      discovery,
      cwd: tmpDir,
      verifyDir: join(tmpDir, "verify"),
      config,
      branchContextFile: join(tmpDir, "verify", "branch-context.txt"),
      planFile: join(tmpDir, "verify", "plan.txt"),
      planContent: "# Plan",
    };
  }

  test("returns empty array when no commands exist", async () => {
    const results = await runDeterministicCommands(deterministicOptions(EMPTY_DISCOVERY));
    expect(results).toEqual([]);
  });

  test("runs deterministic steps sequentially in kind order", async () => {
    const orderFile = join(tmpDir, "order.log");
    const makeScript = (name: string) => {
      const path = join(tmpDir, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\necho ${name} >> "${orderFile}"\nexit 0\n`, { mode: 0o755 });
      return path;
    };

    const config: AdversaryConfig = {
      ...BASE_CONFIG,
      customVerificationSteps: [
        { name: "custom-test", phase: "deterministic", kind: "test", commandTemplate: makeScript("test") },
        { name: "custom-build", phase: "deterministic", kind: "build", commandTemplate: makeScript("build") },
        { name: "custom-lint", phase: "deterministic", kind: "lint", commandTemplate: makeScript("lint") },
        { name: "custom-typecheck", phase: "deterministic", kind: "typecheck", commandTemplate: makeScript("typecheck") },
      ],
    };

    const results = await runDeterministicCommands(deterministicOptions(EMPTY_DISCOVERY, config));
    expect(results.map((result) => result.skill)).toEqual([
      "custom-test",
      "custom-build",
      "custom-lint",
      "custom-typecheck",
    ]);

    const order = (await Bun.file(orderFile).text()).trim().split("\n");
    expect(order).toEqual(["test", "build", "lint", "typecheck"]);
  });

  test("exit 0 writes per-step artifacts under verify/steps/<name>", async () => {
    const passScript = join(tmpDir, "pass.sh");
    writeFileSync(passScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const results = await runDeterministicCommands(deterministicOptions({
      ...EMPTY_DISCOVERY,
      testCommand: passScript,
    }));

    expect(results).toHaveLength(1);
    expect(results[0]?.skill).toBe("discovered-test");
    expect(results[0]?.findings).toHaveLength(0);
    expect(existsSync(join(tmpDir, "verify", "steps", "discovered-test", "output.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "verify", "steps", "discovered-test", "stdout.truncated.log"))).toBe(true);
  });

  test("configured deterministic step suppresses discovered fallback for same kind", async () => {
    const config: AdversaryConfig = {
      ...BASE_CONFIG,
      customVerificationSteps: [
        { name: "custom-test", phase: "deterministic", kind: "test", commandTemplate: "true" },
      ],
    };

    const results = await runDeterministicCommands(deterministicOptions({
      ...EMPTY_DISCOVERY,
      testCommand: "false",
      buildCommand: "true",
    }, config));

    expect(results.map((result) => result.skill)).toEqual(["custom-test", "discovered-build"]);
  });

  test("non-zero exit is analyzed and findings use the step name as source", async () => {
    const failScript = join(tmpDir, "fail.sh");
    writeFileSync(failScript, "#!/bin/sh\necho 'FAIL: assertion'\nexit 1\n", { mode: 0o755 });

    const analyzerHarness = join(tmpDir, "analyzer.sh");
    writeFileSync(
      analyzerHarness,
      "#!/bin/sh\necho '{\"status\":\"completed\",\"findings\":[{\"title\":\"Test failure\",\"severity\":5,\"description\":\"Assertion failed\",\"sources\":[\"wrong-source\"]}]}'\n",
      { mode: 0o755 }
    );

    const results = await runDeterministicCommands(deterministicOptions({
      ...EMPTY_DISCOVERY,
      testCommand: failScript,
    }, {
      ...BASE_CONFIG,
      verifyCommandTemplate: `${analyzerHarness} @{promptFile}`,
    }));

    expect(results).toHaveLength(1);
    expect(results[0]?.findings[0]?.severity).toBe(8);
    expect(results[0]?.findings[0]?.sources).toEqual(["discovered-test"]);
    expect(existsSync(join(tmpDir, "verify", "steps", "discovered-test", "analysis.prompt.md"))).toBe(true);
  });

  test("timeout produces a severity-8 finding", async () => {
    const results = await runDeterministicCommands(deterministicOptions({
      ...EMPTY_DISCOVERY,
      testCommand: "sleep 5",
    }, {
      ...BASE_CONFIG,
      testTimeoutMs: 50,
    }));

    expect(results[0]?.status).toBe("timeout");
    expect(results[0]?.findings[0]?.severity).toBe(8);
  }, 60000);

  test("analyzer failure falls back to a severity-8 meta-finding", async () => {
    const failScript = join(tmpDir, "fail-meta.sh");
    writeFileSync(failScript, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const badHarness = join(tmpDir, "bad-analyzer.sh");
    writeFileSync(badHarness, "#!/bin/sh\necho not-json\nexit 0\n", { mode: 0o755 });

    const results = await runDeterministicCommands(deterministicOptions({
      ...EMPTY_DISCOVERY,
      lintCommands: [failScript],
    }, {
      ...BASE_CONFIG,
      verifyCommandTemplate: `${badHarness} @{promptFile}`,
    }));

    expect(results[0]?.findings).toHaveLength(1);
    expect(results[0]?.findings[0]?.severity).toBe(8);
  });
});
