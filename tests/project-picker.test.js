import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectChoices } from "../web/src/lib/project-picker.js";

const project = (id, overrides = {}) => ({
  id: `project:${id}`, projectId: id, name: "Shared project", cwd: "/work/shared",
  sessions: [{ id: `${id}-session` }], catalogPage: { total: 42 }, createdAt: "2026-10-20T10:00:00Z",
  ...overrides
});

test("same-named projects in one directory retain every original identity without mutating the groups", () => {
  const groups = [project("first"), project("second"), project("third")];
  const before = structuredClone(groups);
  const choices = buildProjectChoices(groups);
  assert.equal(choices.length, 3);
  choices.forEach((choice, index) => assert.equal(choice.group, groups[index]));
  assert.deepEqual(choices.map(({ group }) => group.projectId), ["first", "second", "third"]);
  assert.deepEqual(groups, before);
});

test("duplicate project labels show authoritative catalog totals and creation dates instead of loaded row counts", () => {
  const groups = [
    project("first", { catalogPage: { total: 120 }, createdAt: "2026-10-01T12:00:00Z" }),
    project("second", { catalogPage: { total: 0 }, sessions: [], createdAt: "2026-10-02T12:00:00Z" })
  ];
  const choices = buildProjectChoices(groups);
  assert.deepEqual(choices.map(({ detail }) => detail), [
    "120 个会话 · 2026-10-01 创建", "0 个会话 · 2026-10-02 创建"
  ]);
  assert.notEqual(groups[0].catalogPage.total, groups[0].sessions.length);
});

test("a unique project or projects distinguishable by name and directory need no extra detail", () => {
  assert.deepEqual(buildProjectChoices([]), []);
  assert.equal(buildProjectChoices([project("only")])[0].detail, "");
  const choices = buildProjectChoices([
    project("first", { cwd: "/work/first" }),
    project("second", { cwd: "/work/second" }),
    project("third", { name: "Different project", cwd: "/work/first" })
  ]);
  assert.deepEqual(choices.map(({ detail }) => detail), ["", "", ""]);
});

test("identical project descriptions use their real project identity suffix rather than a shared wrapper ID", () => {
  const groups = [
    project("saved-project-a1234567", { id: "shared-wrapper" }),
    project("saved-project-b1234567", { id: "shared-wrapper" })
  ];
  const choices = buildProjectChoices(groups);
  assert.match(choices[0].detail, /^42 个会话 · 2026-10-20 创建 · 项目 a1234567$/);
  assert.match(choices[1].detail, /^42 个会话 · 2026-10-20 创建 · 项目 b1234567$/);
  assert.equal(choices[0].group, groups[0]);
  assert.equal(choices[1].group, groups[1]);
});

test("colliding identity suffixes extend far enough to distinguish every otherwise identical choice", () => {
  const groups = [project("saved-project-aX00000000"), project("saved-project-bX00000000"), project("saved-project-cX00000000")];
  const choices = buildProjectChoices(groups);
  const suffixes = choices.map(({ detail }) => detail.match(/ · 项目 (.+)$/)?.[1]);
  assert.equal(new Set(choices.map(({ detail }) => detail)).size, groups.length);
  suffixes.forEach((suffix, index) => {
    assert.ok(suffix.length > 8, "a colliding short suffix cannot identify the project");
    assert.ok(groups[index].projectId.endsWith(suffix));
    assert.ok(suffix.length < groups[index].projectId.length, "the display keeps the distinguishing tail compact");
  });
});

test("missing totals and invalid dates do not invent metadata from loaded sessions, and group IDs still distinguish choices", () => {
  const groups = [
    project("first", { projectId: undefined, catalogPage: undefined, createdAt: "invalid" }),
    project("second", { projectId: undefined, catalogPage: undefined, createdAt: undefined })
  ];
  const choices = buildProjectChoices(groups);
  assert.equal(new Set(choices.map(({ detail }) => detail)).size, 2);
  choices.forEach(({ group, detail }) => {
    assert.doesNotMatch(detail, /个会话|创建|Invalid/);
    const suffix = detail.match(/^项目 (.+)$/)?.[1];
    assert.ok(suffix);
    assert.ok(group.id.endsWith(suffix));
  });
});
