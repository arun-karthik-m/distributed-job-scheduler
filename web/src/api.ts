// Typed client for the scheduler API. All calls go to /api/* (Vite proxies to the backend).
const TOKEN_KEY = 'sched.token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, json?.error?.message ?? res.statusText);
  }
  return json as T;
}

export interface Queue { id: number; name: string; priority: number; concurrency_limit: number; status: string; }
export interface Job { id: number; type: string; status: string; priority: number; attempts: number; run_at: string; created_at: string; }
export interface Worker { id: number; name: string; status: string; started_at: string; last_seen: string; live: boolean; }

export const api = {
  register: (email: string, password: string) => req<{ token: string }>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) => req<{ token: string }>('POST', '/auth/login', { email, password }),

  projects: () => req<{ data: { id: number; name: string; created_at: string }[] }>('GET', '/projects'),
  createProject: (name: string) => req<{ id: number }>('POST', '/projects', { name }),

  queues: (projectId: number) => req<{ data: Queue[] }>('GET', `/projects/${projectId}/queues`),
  createQueue: (projectId: number, b: { name: string; priority?: number; concurrency_limit?: number }) =>
    req<Queue>('POST', `/projects/${projectId}/queues`, b),
  queue: (id: number) => req<Queue>('GET', `/queues/${id}`),
  patchQueue: (id: number, b: Partial<{ priority: number; concurrency_limit: number; status: string }>) =>
    req<Queue>('PATCH', `/queues/${id}`, b),
  queueStats: (id: number) => req<{ queueId: number; stats: Record<string, number> }>('GET', `/queues/${id}/stats`),

  jobs: (queueId: number, q: { status?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.limit) p.set('limit', String(q.limit));
    if (q.offset) p.set('offset', String(q.offset));
    return req<{ data: Job[]; limit: number; offset: number }>('GET', `/queues/${queueId}/jobs?${p}`);
  },
  createJob: (queueId: number, b: Record<string, unknown>) => req('POST', `/queues/${queueId}/jobs`, b),
  job: (id: number) => req<any>('GET', `/jobs/${id}`),
  retryJob: (id: number) => req('POST', `/jobs/${id}/retry`),
  dlq: (queueId: number) => req<{ data: { id: number; job_id: number; reason: string; attempts: number; failed_at: string }[] }>('GET', `/queues/${queueId}/dlq`),

  workers: () => req<{ data: Worker[] }>('GET', '/workers'),
  metrics: () => req<{ jobs: Record<string, number>; workersAlive: number }>('GET', '/metrics'),
  throughput: () => req<{ data: { t: string; n: number }[] }>('GET', '/metrics/throughput'),
};
