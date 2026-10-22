import test from "node:test";
import assert from "node:assert/strict";
import { validateRuntime, renderProperties, renderLaunchd } from "../preview-service.mjs";

const runtime = () => validateRuntime({ schemaVersion: 1, kkVersion: "5.0.3", javaBin: "/tmp/java/bin/java",
  officeHome: "/tmp/LibreOffice.app/Contents", jarPath: "/tmp/kkFileView-5.0.3.jar", defaultsPath: "/tmp/defaults.properties",
  dataDir: "/tmp/preview data", logsDir: "/tmp/preview logs", bridgeOrigin: "http://127.0.0.1:3211" });

test("preview config overrides shipped defaults and stays on the loopback viewer context", () => {
  const text = renderProperties(runtime(), "server.port=9000\nfile.upload.disable=false\ncache.enabled=false");
  const effective = Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => line.split(/\s*=\s*/, 2)));
  assert.equal(effective["server.address"], "127.0.0.1");
  assert.equal(effective["server.port"], "8012");
  assert.equal(effective["server.servlet.context-path"], "/viewer");
  assert.equal(effective["base.url"], "default");
  assert.equal(effective["trust.host"], "127.0.0.1");
  assert.equal(effective["file.upload.disable"], "true");
  assert.equal(effective["delete.password"], "false");
  assert.equal(effective["kk.addTask"], "false");
  assert.equal(effective["local.preview.dir"], "default");
  assert.equal(effective["cache.enabled"], "true");
  assert.equal(effective["office.type.web"], "image");
  assert.equal(effective["office.preview.type"], "pdf");
  assert.match(effective["server.compression.mime-types"], /text\/javascript/);
});

test("runtime validation rejects remote bridges, credentials, path injection and wrong versions", () => {
  for (const bridgeOrigin of ["https://example.com:3211", "http://localhost:8080", "http://user:pass@localhost:3211", "http://localhost:3211/path"]) {
    assert.throws(() => validateRuntime({ ...runtime(), bridgeOrigin }), /loopback/);
  }
  assert.throws(() => validateRuntime({ ...runtime(), javaBin: "/tmp/java\nunsafe=true" }), /single-line/);
  assert.throws(() => validateRuntime({ ...runtime(), kkVersion: "4.1.0" }), /5.0.3/);
});

test("launchd uses a foreground managed launcher and escapes configured paths", () => {
  const text = renderLaunchd({ ...runtime(), dataDir: "/tmp/data & previews" }, "/tmp/runtime.json", "/usr/local/bin/node");
  assert.match(text, /data &amp; previews/);
  assert.match(text, /<string>run<\/string>/);
  assert.match(text, /<string>--runtime<\/string><string>\/tmp\/runtime.json<\/string>/);
  assert.doesNotMatch(text, /nohup|launchctl|docker/);
});
