import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import pty from "node-pty";

import { SessionManager } from "../src/sessionManager.js";
import { HistoricalSessionService } from "../src/sessions/history/HistoricalSessionService.js";
import { createBaseConfig, createTempDir } from "./helpers/backendTestUtils.js";

async function withManager(t, overrides, run) {
  const rootDir = createTempDir("cc-provider-spawn-test-");
  const calls = [];
  const shells = [];
  const originalSpawn = pty.spawn;
  const spawnMock = t.mock.method(pty, "spawn", (file, args, options) => {
    const shell = new EventEmitter();
    shell.writes = [];
    shell.killed = false;
    shell.onData = (handler) => shell.on("data", handler);
    shell.onExit = (handler) => shell.on("exit", handler);
    shell.write = (text) => shell.writes.push(text);
    shell.kill = () => {
      shell.killed = true;
      shell.removeAllListeners();
    };
    calls.push({ file, args, options });
    shells.push(shell);
    return shell;
  });
  let manager;
  try {
    const config = createBaseConfig(rootDir, overrides);
    manager = new SessionManager(config);
    await run({ manager, config, rootDir, calls, shells });
  } finally {
    try {
      manager?.shutdown();
      await manager?.codexSidebarService.close();
    } finally {
      for (const shell of shells) shell.kill();
      spawnMock.mock.restore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    assert.equal(manager?.sessions.size ?? 0, 0);
    assert.equal(pty.spawn, originalSpawn);
    assert.equal(fs.existsSync(rootDir), false);
    for (const shell of shells) {
      assert.equal(shell.killed, true);
      assert.deepEqual(shell.eventNames(), []);
      assert.deepEqual(shell.writes, []);
    }
  }
}

const spawnCases = [
  {
    label: "automatic CC name",
    input: { provider: "cc" },
    overrides: {},
    name: "cc-1",
    autoNamed: true,
    model: "sonnet",
    args: ["--model", "sonnet", "--dangerously-skip-permissions"]
  },
  {
    label: "explicit Claude alias name and model",
    input: { provider: "claude", name: "  Claude Demo  ", model: "opus" },
    overrides: { ccFullAccess: false, ccExtraArgs: ["--verbose", "literal value"] },
    name: "Claude Demo",
    autoNamed: false,
    model: "opus",
    args: ["--model", "opus", "--verbose", "literal value"]
  },
  {
    label: "automatic resumed CC name",
    input: { provider: "cc", resumeSessionId: "  saved-cc  " },
    overrides: {},
    name: "cc-1",
    autoNamed: true,
    model: "sonnet",
    args: ["--resume", "saved-cc", "--model", "sonnet", "--dangerously-skip-permissions"]
  },
  {
    label: "explicit resumed Claude alias name and model",
    input: { provider: "claude", resumeSessionId: "saved-cc", name: "Resumed Demo", model: "opus" },
    overrides: { ccExtraArgs: ["--verbose"] },
    name: "Resumed Demo",
    autoNamed: false,
    model: "opus",
    args: ["--resume", "saved-cc", "--model", "opus", "--dangerously-skip-permissions", "--verbose"]
  }
];

for (const scenario of spawnCases) {
  test(`create preserves ${scenario.label} metadata without generated name arguments`, async (t) => {
    await withManager(t, scenario.overrides, ({ manager, rootDir, calls }) => {
      const created = manager.create({ ...scenario.input, cwd: rootDir });
      const live = manager.get(created.id);
      assert.equal(created.provider, "cc");
      assert.equal(created.name, scenario.name);
      assert.equal(created.autoNamed, scenario.autoNamed);
      assert.equal(created.titleSource, scenario.autoNamed ? "auto_generated" : "user_provided");
      assert.equal(created.model, scenario.model);
      assert.equal(created.resumeSessionId, scenario.input.resumeSessionId?.trim() || null);
      assert.equal(live.threadSnapshot.metadata.name, scenario.name);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, "claude");
      assert.deepEqual(calls[0].args, scenario.args);
      assert.equal(calls[0].options.cwd, rootDir);
      assert.equal(calls[0].options.name, "xterm-color");
      assert.equal(calls[0].options.env.TERM, "xterm-256color");
      assert.equal(manager.buildProviderCommand(live), ["claude", ...scenario.args].map((value) => `'${value}'`).join(" "));
    });
  });
}

test("create preserves user-supplied CC name arguments in extraArgs", async (t) => {
  const extraArgs = ["--name", "user extra name", "--verbose"];
  await withManager(t, { ccExtraArgs: extraArgs }, ({ manager, calls }) => {
    const created = manager.create({ provider: "cc", name: "Web metadata name" });
    assert.equal(created.name, "Web metadata name");
    assert.equal(created.autoNamed, false);
    assert.equal(created.titleSource, "user_provided");
    assert.deepEqual(calls[0].args, ["--model", "sonnet", "--dangerously-skip-permissions", ...extraArgs]);
    assert.deepEqual(extraArgs, ["--name", "user extra name", "--verbose"]);
    assert.equal(manager.buildProviderCommand(manager.get(created.id)), "'claude' '--model' 'sonnet' '--dangerously-skip-permissions' '--name' 'user extra name' '--verbose'");
  });
});

test("create leaves an unconfigured CC model to the CLI", async (t) => {
  await withManager(t, { ccModel: "", ccModels: [], ccFullAccess: false }, ({ manager, calls }) => {
    const created = manager.create({ provider: "claude" });
    assert.equal(created.model, "");
    assert.equal(created.name, "cc-1");
    assert.deepEqual(calls[0].args, []);
    assert.equal(manager.buildProviderCommand(manager.get(created.id)), "'claude'");
  });
});

test("fresh explicit CC names persist through matching history and reload", async (t) => {
  await withManager(t, {}, ({ manager, config, rootDir, calls, shells }) => {
    const created = manager.create({ provider: "cc", name: "Persistent web name" });
    const live = manager.get(created.id);
    assert.equal(created.name, "Persistent web name");
    assert.equal(created.autoNamed, false);
    assert.equal(created.titleSource, "user_provided");
    const historyDir = path.join(config.ccSessionsDir, "owned-project");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, "owned-cc.jsonl"), `${JSON.stringify({
      type: "user",
      sessionId: "owned-cc",
      cwd: rootDir,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Owned fixture input" }
    })}\n`);

    shells[0].emit("exit", { exitCode: 0 });
    assert.equal(live.status, "exited");
    assert.equal(manager.getCustomName("cc", "owned-cc"), "Persistent web name");
    assert.equal(new HistoricalSessionService(config).getCustomName("cc", "owned-cc"), "Persistent web name");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.dataDir, "session-names.json"), "utf8")), {
      "cc:owned-cc": "Persistent web name"
    });
    const metadata = JSON.parse(fs.readFileSync(path.join(config.dataDir, "session-name-meta.json"), "utf8"));
    assert.equal(metadata["cc:owned-cc"].source, "manual");
    assert.ok(metadata["cc:owned-cc"].updatedAt);
    assert.doesNotMatch(manager.buildProviderCommand(live), /--name|Persistent web name/);
    assert.equal(calls[0].args.includes("--name"), false);
  });
});

test("resumed explicit CC names retain the customName persistence contract", async (t) => {
  await withManager(t, {}, ({ manager, config, shells }) => {
    const created = manager.create({ provider: "claude", resumeSessionId: "owned-resume", name: "Resumed web name" });
    shells[0].emit("exit", { exitCode: 0 });
    assert.equal(created.provider, "cc");
    assert.equal(created.name, "Resumed web name");
    assert.equal(created.autoNamed, false);
    assert.equal(created.titleSource, "user_provided");
    assert.equal(manager.getCustomName("cc", "owned-resume"), "Resumed web name");
    assert.equal(new HistoricalSessionService(config).getCustomName("cc", "owned-resume"), "Resumed web name");
  });
});

test("Codex create keeps its arguments and never starts a CC PTY", async (t) => {
  await withManager(t, { codexProfile: "qa-profile", codexExtraArgs: ["--verbose"] }, ({ manager, calls }) => {
    const created = manager.create({
      provider: "codex",
      resumeSessionId: "owned-codex",
      name: "Codex web name",
      model: "gpt-5-mini",
      permissionMode: "full-access"
    });
    assert.equal(created.provider, "codex");
    assert.equal(created.name, "Codex web name");
    assert.equal(created.autoNamed, false);
    assert.equal(created.titleSource, "user_provided");
    assert.equal(created.model, "gpt-5-mini");
    assert.equal(calls.length, 0);
    assert.deepEqual(manager.getProvider("codex").buildSpawnSpec(created), {
      file: "codex",
      args: ["resume", "--all", "owned-codex", "--model", "gpt-5-mini", "--profile", "qa-profile", "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox", "-c", 'approvals_reviewer="user"', "--verbose"]
    });
    assert.equal(manager.buildProviderCommand(manager.get(created.id)),
      "'codex' 'resume' '--all' 'owned-codex' '--model' 'gpt-5-mini' '--profile' 'qa-profile' '--no-alt-screen' '--dangerously-bypass-approvals-and-sandbox' '-c' 'approvals_reviewer=\"user\"' '--verbose'");
  });
});
