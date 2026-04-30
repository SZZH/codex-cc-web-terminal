import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  mapCodexDesktopAgentModeToPermissionMode,
  readCodexDesktopDefaults,
  writeCodexDesktopPermissionMode
} from "../src/sessions/shared/codexDesktopConfig.js";
import { createTempDir } from "./helpers/backendTestUtils.js";

test("mapCodexDesktopAgentModeToPermissionMode recognizes auto-review aliases", () => {
  assert.equal(mapCodexDesktopAgentModeToPermissionMode("auto"), "auto-review");
  assert.equal(mapCodexDesktopAgentModeToPermissionMode("guardian-approvals"), "auto-review");
  assert.equal(mapCodexDesktopAgentModeToPermissionMode("auto-review"), "auto-review");
  assert.equal(mapCodexDesktopAgentModeToPermissionMode("full-access"), "full-access");
  assert.equal(mapCodexDesktopAgentModeToPermissionMode("default"), "default");
});

test("readCodexDesktopDefaults reads guardian approvals from global state", () => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const codexConfigPath = path.join(codexDir, "config.toml");
  const codexGlobalStatePath = path.join(codexDir, ".codex-global-state.json");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(codexConfigPath, 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', "utf8");
  fs.writeFileSync(
    codexGlobalStatePath,
    JSON.stringify({
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: "guardian-approvals" }
      }
    }),
    "utf8"
  );

  assert.deepEqual(
    readCodexDesktopDefaults({
      codexConfigPath,
      codexGlobalStatePath
    }),
    {
      model: "gpt-5.4",
      reasoningEffort: "high",
      permissionMode: "auto-review"
    }
  );
});

test("writeCodexDesktopPermissionMode persists desktop agent-mode aliases", () => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const codexGlobalStatePath = path.join(codexDir, ".codex-global-state.json");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    codexGlobalStatePath,
    JSON.stringify({
      "electron-persisted-atom-state": {
        "agent-mode": "full-access"
      }
    }),
    "utf8"
  );

  writeCodexDesktopPermissionMode({ codexGlobalStatePath }, "auto-review");
  let payload = JSON.parse(fs.readFileSync(codexGlobalStatePath, "utf8"));
  assert.equal(payload["electron-persisted-atom-state"]["agent-mode-by-host-id"].local, "auto");
  assert.equal(
    payload["electron-persisted-atom-state"]["preferred-non-full-access-agent-mode-by-host-id"].local,
    "auto"
  );

  writeCodexDesktopPermissionMode({ codexGlobalStatePath }, "full-access");
  payload = JSON.parse(fs.readFileSync(codexGlobalStatePath, "utf8"));
  assert.equal(payload["electron-persisted-atom-state"]["agent-mode-by-host-id"].local, "full-access");
  assert.equal(payload["electron-persisted-atom-state"]["agent-mode"], "full-access");
});
