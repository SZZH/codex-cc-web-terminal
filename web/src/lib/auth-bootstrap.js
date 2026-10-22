export async function resolveInitialAuthBootstrap({
  savedToken = "",
  autoLoginTried = false,
  requestAuthSession,
  handleAutoLogin,
  isCurrent = () => true
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
    if (!isCurrent()) return null;
    if (auth?.authenticated) {
      result.isAuthenticated = true;
      result.accessToken = "";
    }
    return result;
  } catch (error) {
    if (!isCurrent()) return null;
    if (error?.code === "READ_TIMEOUT") {
      result.statusText = error.message;
      return result;
    }
    if (normalizedToken && !autoLoginTried) {
      result.autoLoginTried = true;
      const recovered = await handleAutoLogin(normalizedToken);
      if (!isCurrent()) return null;
      result.isAuthenticated = recovered?.isAuthenticated === true;
      result.accessToken = String(recovered?.accessToken || "");
      result.rememberToken = Boolean(recovered?.rememberToken);
    }
    return result;
  }
}
