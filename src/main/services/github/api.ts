export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface GithubResponse { status: number; data: unknown; }

const USER_AGENT = 'GLKVM';

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Calls api.github.com. Resolves for every HTTP status; rejects only when the request can't be made. */
export async function githubApi(
  fetchFn: FetchLike, token: string, method: string, path: string, body?: unknown,
): Promise<GithubResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(`https://api.github.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

export async function postForm(fetchFn: FetchLike, url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams(fields).toString(),
  });
  return asRecord(await res.json()) ?? {};
}
