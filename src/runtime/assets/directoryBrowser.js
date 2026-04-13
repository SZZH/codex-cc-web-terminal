import fs from "node:fs";
import path from "node:path";

const directoryBrowserLimit = 400;

export function installDirectoryBrowserRuntime(runtime) {
  runtime.resolveBrowserPath = (rawPath) => {
    const requested = String(rawPath || "").trim();
    const resolved = path.resolve(requested || runtime.config.defaultCwd);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    return resolved;
  };

  runtime.listDirectoryPayload = (rawPath) => {
    const resolved = runtime.resolveBrowserPath(rawPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    const entries = [];
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const fullPath = path.join(resolved, entry.name);
      try {
        const entryStat = fs.statSync(fullPath);
        let type = "other";
        if (entryStat.isDirectory()) {
          type = "directory";
        } else if (entryStat.isFile()) {
          type = "file";
        }

        entries.push({
          name: entry.name,
          path: fullPath,
          type,
          size: entryStat.isFile() ? entryStat.size : null
        });
      } catch {
        // Ignore entries that cannot be read.
      }
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === "directory") {
          return -1;
        }
        if (right.type === "directory") {
          return 1;
        }
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });

    const rootPath = path.parse(resolved).root;
    return {
      path: resolved,
      parentPath: resolved === rootPath ? null : path.dirname(resolved),
      rootPath,
      entries: entries.slice(0, directoryBrowserLimit),
      totalEntries: entries.length,
      truncated: entries.length > directoryBrowserLimit
    };
  };
}
