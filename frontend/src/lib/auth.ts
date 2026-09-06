const KEY = "agent-mesh-auth";

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
}

export function saveAuth(auth: StoredAuth) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(auth));
}

export function loadAuth(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}
