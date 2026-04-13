export function installRequestBodyRuntime(runtime) {
  runtime.readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) {
          reject(new Error("Request body too large."));
        }
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });

  runtime.readBodyBuffer = (req, limitBytes = 2_000_000) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;

      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        req.off("close", onClose);
      };

      const finishResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const onData = (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limitBytes) {
          finishReject(new Error("Request body too large."));
          try {
            req.destroy();
          } catch {
            // no-op
          }
          return;
        }
        chunks.push(buffer);
      };

      const onEnd = () => finishResolve(Buffer.concat(chunks));
      const onError = (err) => finishReject(err);
      const onAborted = () => finishReject(new Error("Request body aborted by client."));
      const onClose = () => {
        if (!settled) {
          finishReject(new Error("Request body stream closed before end."));
        }
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      req.on("close", onClose);
    });
}
