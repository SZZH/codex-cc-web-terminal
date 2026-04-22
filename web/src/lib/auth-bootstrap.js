export async function resolveInitialAuthBootstrap({
  savedToken = "",
  autoLoginTried = false,
  requestAuthSession,
  bootstrapWorkspace,
  handleAutoLogin,
  routeName = ""
} = {}) {
  const normalizedToken = String(savedToken || "").trim();
  const result = {
    accessToken: normalizedToken,
    rememberToken: Boolean(normalizedToken),
    isAuthenticated: false,
    ready: true,
    autoLoginTried
  };

  try {
    const auth = await requestAuthSession();
    if (auth?.authenticated) {
      await bootstrapWorkspace({ includeSessions: routeName !== "chat" });
      result.isAuthenticated = true;
    }
    return result;
  } catch {
    if (normalizedToken && !autoLoginTried) {
      result.autoLoginTried = true;
      await handleAutoLogin(normalizedToken);
    }
    return result;
  }
}
