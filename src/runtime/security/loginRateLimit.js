export function installLoginRateLimitRuntime(runtime) {
  runtime.pruneLoginAttempts = () => {
    const current = runtime.nowMs();
    for (const [key, state] of runtime.loginAttempts) {
      const windowExpired = state.windowStartedAt + runtime.config.authRateLimitWindowMs <= current;
      const blockExpired = state.blockUntil <= current;
      if (windowExpired && blockExpired) {
        runtime.loginAttempts.delete(key);
      }
    }
  };

  runtime.getLoginAttemptState = (req) => {
    runtime.pruneLoginAttempts();
    const key = runtime.getClientAddress(req);
    const current = runtime.nowMs();
    const existing = runtime.loginAttempts.get(key);
    if (!existing) {
      return {
        key,
        state: {
          windowStartedAt: current,
          failedAttempts: 0,
          blockUntil: 0
        }
      };
    }

    if (existing.windowStartedAt + runtime.config.authRateLimitWindowMs <= current) {
      existing.windowStartedAt = current;
      existing.failedAttempts = 0;
      existing.blockUntil = 0;
    }

    return { key, state: existing };
  };

  runtime.isLoginBlocked = (req) => runtime.getLoginAttemptState(req).state.blockUntil > runtime.nowMs();

  runtime.recordFailedLogin = (req) => {
    const { key, state } = runtime.getLoginAttemptState(req);
    state.failedAttempts += 1;
    if (state.failedAttempts >= runtime.config.authRateLimitMaxAttempts) {
      state.blockUntil = runtime.nowMs() + runtime.config.authRateLimitBlockMs;
    }
    runtime.loginAttempts.set(key, state);
  };

  runtime.clearFailedLogins = (req) => {
    runtime.loginAttempts.delete(runtime.getClientAddress(req));
  };
}
