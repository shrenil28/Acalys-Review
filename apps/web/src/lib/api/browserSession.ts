/** Browser-only session helpers. Kept at the transport boundary. */
export function browserAuthorization(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const token = window.sessionStorage.getItem("acalys.session.token")?.trim();
    return token ? `Bearer ${token}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A fresh idempotency key for a user mutation.
 *
 * It is generated at the point the user starts an operation and then reused by
 * that operation's retries. Callers must not regenerate it inside a retry loop.
 */
export function newIdempotencyKey(prefix: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`.slice(0, 200);
}

export function storeBrowserSession(token: string): boolean {
  if (typeof window === "undefined" || token.trim().length === 0) return false;
  try { window.sessionStorage.setItem("acalys.session.token", token.trim()); return true; } catch { return false; }
}

export function clearBrowserSession(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem("acalys.session.token"); } catch { /* unavailable storage is already effectively logged out */ }
}
