import { deriveSessionTitle, extractImagePartsFromMarkdown, filterLiveOutputChunk, nowIso, sanitizeTitleFragment, stripTerminalControlSequences } from "../shared/text.js";

export function pushSessionBuffer(session, text = "", config) {
  const value = String(text || "");
  if (!value) {
    return;
  }
  session.buffer += value;
  if (session.buffer.length > config.sessionBufferLimit) {
    session.buffer = session.buffer.slice(-config.sessionBufferLimit);
  }
}

export function broadcast(session, payload) {
  for (const client of session.clients) {
    try {
      client.send(JSON.stringify(payload));
    } catch {
      // Ignore transient ws send failures.
    }
  }
}

export function attachClient(manager, id, ws) {
  const session = manager.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }

  session.clients.add(ws);
  ws.send(
    JSON.stringify({
      type: "snapshot",
      session: manager.serialize(session),
      buffer: session.buffer
    })
  );

  ws.on("close", () => {
    session.clients.delete(ws);
  });
}

export function registerPtySessionHandlers(manager, session, shell) {
  shell.onData((chunk) => {
    session.status = "running";
    session.updatedAt = nowIso();
    maybeAutoAdvanceClaudeStartup(manager, session);

    const visibleChunk = filterLiveOutputChunk(session, chunk);
    if (!visibleChunk) {
      return;
    }

    const { text: textChunk, images } = extractImagePartsFromMarkdown(visibleChunk);
    if (!textChunk && images.length === 0) {
      return;
    }

    if (textChunk) {
      session.buffer += textChunk;
    }
    for (const image of images) {
      session.buffer += `\n![${image.alt || "image"}](${image.url})\n`;
    }
    if (session.buffer.length > manager.config.sessionBufferLimit) {
      session.buffer = session.buffer.slice(-manager.config.sessionBufferLimit);
    }

    for (const client of session.clients) {
      if (textChunk) {
        client.send(
          JSON.stringify({
            type: "message_part",
            role: "assistant",
            part: {
              type: "text",
              text: textChunk,
              format: "terminal_raw"
            },
            phase: "streaming",
            timestamp: nowIso()
          })
        );
      }
      for (const image of images) {
        client.send(
          JSON.stringify({
            type: "message_part",
            role: "assistant",
            part: image,
            timestamp: nowIso()
          })
        );
      }
    }
  });

  shell.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.status = "exited";
    session.updatedAt = nowIso();
    if (!manager.persistSessionName(session)) {
      manager.scheduleDeferredNamePersistence(session);
    }
    for (const client of session.clients) {
      client.send(JSON.stringify({ type: "exit", exitCode }));
    }
  });
}

export function maybeAutoRename(manager, session, chunk) {
  if (!session.autoNamed) {
    return;
  }

  const text = String(chunk || "");
  if (!text) {
    return;
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const segment of normalized.split("\n")) {
    const candidate = sanitizeTitleFragment(segment);
    if (!candidate) {
      continue;
    }

    const lowerCandidate = candidate.toLowerCase();
    if (!session.sawBootstrapCommand && session.bootstrapNames.includes(lowerCandidate)) {
      session.sawBootstrapCommand = true;
      continue;
    }

    session.inputPreview = candidate;
    session.name = deriveSessionTitle(candidate, session.fallbackName);
    session.titleSource = "first_user_input";
    session.autoNamed = false;
    session.updatedAt = nowIso();
    manager.persistSessionName(session);
    return;
  }
}

export function maybeAutoAdvanceClaudeStartup(manager, session) {
  if (!session || session.provider !== "cc" || session.claudeStartupStage >= 2) {
    return;
  }

  const text = stripTerminalControlSequences(session.buffer.slice(-6000));
  if (session.claudeStartupStage < 1 && text.includes("Yes, I trust this folder") && text.includes("No, exit")) {
    session.claudeStartupStage = 1;
    session.shell.write("\r");
    session.updatedAt = nowIso();
    return;
  }

  if (
    session.claudeStartupStage < 2 &&
    text.includes("WARNING: Claude Code running in Bypass Permissions mode") &&
    text.includes("Yes, I accept")
  ) {
    session.claudeStartupStage = 2;
    session.shell.write("\u001b[B");
    setTimeout(() => {
      if (!manager.sessions.has(session.id) || session.status === "exited") {
        return;
      }
      session.shell.write("\r");
    }, 150).unref?.();
    session.updatedAt = nowIso();
  }
}
