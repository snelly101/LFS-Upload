export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS = { 'X-Requested-With': 'snelson' };

async function parse(r: Response): Promise<unknown> {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined && method === 'GET' ? BASE_HEADERS : { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await parse(r)) as Record<string, unknown>;
  if (!r.ok) throw new ApiError(r.status, String(data.error ?? 'error'), String(data.message ?? `Request failed (${r.status})`), data);
  return data as T;
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const patch = <T>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const del = <T>(url: string) => api<T>('DELETE', url, {});

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = e.body.issues as { path: string; message: string }[] | undefined;
    if (issues?.length) return issues.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join('; ');
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
