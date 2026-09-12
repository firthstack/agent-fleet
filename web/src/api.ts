export interface Me {
  user: { id: string; email: string; name: string | null };
  tenant: { slug: string; displayName: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The console API. Cookies ride along; nothing here handles a token. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export const getMe = () => api<Me>("/api/me");
