import test from "node:test";
import assert from "node:assert/strict";
import { createAppViewport, measureAppViewport } from "../web/src/lib/app-viewport.js";

function host() {
  const listeners = new Map(), values = new Map([["--app-viewport-height", "old-height"]]), writes = [];
  const target = (prefix, extra = {}) => ({ ...extra,
    addEventListener(name, callback) { listeners.set(`${prefix}${name}`, callback); },
    removeEventListener(name, callback) { if (listeners.get(`${prefix}${name}`) === callback) listeners.delete(`${prefix}${name}`); }
  });
  const viewport = target("visual-", { height: 719.625, offsetTop: 0 });
  const window = target("", { innerHeight: 800, visualViewport: viewport });
  const style = {
    getPropertyValue: (name) => values.get(name) || "", getPropertyPriority: () => "",
    setProperty(name, value) { values.set(name, value); writes.push([name, value]); },
    removeProperty(name) { values.delete(name); }
  };
  return { window, viewport, document: { documentElement: { style } }, listeners, values, writes };
}

test("viewport measurement keeps fractional visible height and accounts for keyboard panning", () => {
  const ui = host();
  assert.deepEqual(measureAppViewport(ui.window), { height: 719.625, offsetTop: 0, keyboardInset: 80.375 });
  ui.viewport.height = 349.375; ui.viewport.offsetTop = 20.25;
  assert.deepEqual(measureAppViewport(ui.window), { height: 349.375, offsetTop: 20.25, keyboardInset: 430.375 });
  ui.viewport.height = NaN;
  assert.equal(measureAppViewport(ui.window).height, 800);
  ui.viewport.height = 0;
  assert.deepEqual(measureAppViewport(ui.window), { height: 800, offsetTop: 0, keyboardInset: 0 });
  assert.deepEqual(measureAppViewport({ innerHeight: Infinity, visualViewport: { height: NaN } }),
    { height: 0, offsetTop: 0, keyboardInset: 0 });
  assert.deepEqual(measureAppViewport(undefined), { height: 0, offsetTop: 0, keyboardInset: 0 });
});

test("one app viewport owner publishes resizes and cleans every listener and prior style", () => {
  const ui = host(), controller = createAppViewport(ui);
  ui.values.set("--app-viewport-top", "7px");
  try {
    controller.start(); controller.start();
    assert.equal(ui.values.get("--app-viewport-height"), "719.625px");
    assert.equal(ui.listeners.size, 3);
    ui.viewport.height = 341.875;
    ui.listeners.get("visual-resize")();
    assert.equal(ui.values.get("--app-viewport-height"), "341.875px");
    ui.viewport.offsetTop = 20.25; ui.listeners.get("visual-scroll")();
    assert.equal(ui.values.get("--app-viewport-top"), "20.25px");
    assert.equal(ui.values.get("--app-viewport-bottom"), "437.875px");
    const escaped = ui.listeners.get("visual-scroll");
    controller.dispose();
    assert.equal(ui.listeners.size, 0);
    assert.equal(ui.values.get("--app-viewport-height"), "old-height");
    assert.equal(ui.values.get("--app-viewport-top"), "7px");
    assert.equal(ui.values.has("--app-viewport-bottom"), false);
    const count = ui.writes.length;
    escaped(); controller.start(); controller.dispose();
    assert.equal(ui.writes.length, count, "old callbacks and repeated disposal cannot republish an unmounted viewport");
  } finally { controller.dispose(); }
});

test("missing visual viewport uses innerHeight and disposing restores an absent custom property", () => {
  const ui = host(); delete ui.window.visualViewport; ui.values.clear();
  const controller = createAppViewport(ui);
  try {
    controller.start(); assert.equal(ui.values.get("--app-viewport-height"), "800px");
    ui.window.innerHeight = 240.5; ui.listeners.get("resize")();
    assert.equal(ui.values.get("--app-viewport-height"), "240.5px");
    ui.window.innerHeight = 0; ui.listeners.get("resize")();
    assert.equal(ui.values.get("--app-viewport-height"), "240.5px", "a transient unusable measurement cannot publish a zero height");
  } finally { controller.dispose(); }
  assert.equal(ui.values.size, 0); assert.equal(ui.listeners.size, 0);
});
