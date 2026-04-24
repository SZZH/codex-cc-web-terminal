import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildThreadSnapshotFromFile } from "../src/threads/history.js";

test("thread history snapshot strips IAB wrapper from user message before materializing turn items", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-history-"));
  const filePath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-04-24T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message:
          "\n# In app browser (IAB):\n- The user has the in-app browser (IAB) open.\n- Current URL: http://127.0.0.1:3210/#/chat/history:codex:019daf2c-f5a0-7033-a87c-b5df6ddef277\n\n## My request for Codex:\n执行\n"
      }
    })}\n`,
    "utf8"
  );

  const snapshot = buildThreadSnapshotFromFile(filePath, {
    threadId: "thread-iab-1",
    metadata: {}
  });

  assert.ok(snapshot);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items[0].text, "执行");
});

test("thread history snapshot preserves user images from event_msg payload arrays", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-history-images-"));
  const filePath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-04-24T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "帮我看看这张图",
        images: [
          {
            image_url: "data:image/png;base64,abc",
            alt: "截图"
          }
        ],
        local_images: [
          {
            path: "/tmp/example.png",
            name: "本地图片"
          }
        ]
      }
    })}\n`,
    "utf8"
  );

  const snapshot = buildThreadSnapshotFromFile(filePath, {
    threadId: "thread-images-1",
    metadata: {}
  });

  assert.ok(snapshot);
  assert.equal(snapshot.turns.length, 1);
  const userItem = snapshot.turns[0].items[0];
  assert.equal(userItem.kind, "UserMessage");
  assert.equal(userItem.text, "帮我看看这张图");
  assert.equal(userItem.payload.content.length, 3);
  assert.deepEqual(userItem.payload.images, [{ image_url: "data:image/png;base64,abc", alt: "截图" }]);
  assert.deepEqual(userItem.payload.local_images, [{ path: "/tmp/example.png", name: "本地图片" }]);
  assert.equal(userItem.payload.content[1].type, "input_image");
  assert.equal(userItem.payload.content[1].image_url, "data:image/png;base64,abc");
  assert.equal(userItem.payload.content[2].type, "local_image");
  assert.equal(userItem.payload.content[2].path, "/tmp/example.png");
});

test("thread history snapshot preserves assistant output images from response_item content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-history-assistant-image-"));
  const filePath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-04-24T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "生成一张图"
      }
    })}\n${JSON.stringify({
      timestamp: "2026-04-24T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "图已经生成好了" },
          { type: "output_image", image_url: "/api/local-file-image?path=%2Ftmp%2Fdemo.png", alt: "结果图" }
        ],
        phase: "final_answer"
      }
    })}\n`,
    "utf8"
  );

  const snapshot = buildThreadSnapshotFromFile(filePath, {
    threadId: "thread-assistant-images-1",
    metadata: {}
  });

  assert.ok(snapshot);
  assert.equal(snapshot.turns.length, 1);
  const assistantImage = snapshot.turns[0].items.find((item) => item.kind === "ImageView");
  const assistantText = snapshot.turns[0].items.find((item) => item.kind === "AgentMessage");
  assert.ok(assistantImage);
  assert.equal(assistantImage.payload.url, "/api/local-file-image?path=%2Ftmp%2Fdemo.png");
  assert.equal(assistantImage.payload.alt, "结果图");
  assert.ok(assistantText);
  assert.equal(assistantText.text, "图已经生成好了");
});

test("thread history snapshot materializes images from image_generation_end events", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-history-imagegen-"));
  const filePath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-04-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-imagegen-1"
      }
    })}\n${JSON.stringify({
      timestamp: "2026-04-24T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "生成一张图"
      }
    })}\n${JSON.stringify({
      timestamp: "2026-04-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        turn_id: "turn-imagegen-1",
        call_id: "ig_demo_123",
        status: "completed",
        revised_prompt: "dreamy skyline"
      }
    })}\n`,
    "utf8"
  );

  const snapshot = buildThreadSnapshotFromFile(filePath, {
    threadId: "thread-imagegen-1",
    metadata: {}
  });

  assert.ok(snapshot);
  const assistantImage = snapshot.turns.flatMap((turn) => turn.items || []).find((item) => item.kind === "ImageView");
  assert.ok(assistantImage);
  assert.match(assistantImage.payload.url, /session-imagegen-1\/ig_demo_123\.png$/);
});
