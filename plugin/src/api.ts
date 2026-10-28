import {
  type ErrorBody,
  type FileListResponse,
  type FileMeta,
  type LockInfo,
  type LoginResponse,
} from "@team-sync/shared";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

/** Transport, so the plugin can use Obsidian's `requestUrl` (no CORS) and tests can use `fetch`. Throws only on network failure. */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** The server could not be reached. */
export class OfflineError extends Error {}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.message || `HTTP ${status}`);
  }
}

export interface Download {
  data: ArrayBuffer;
  version: number;
  hash: string;
}

export interface ApiOptions {
  http: Http;
  serverUrl(): string;
  token(): string;
  /** A request taking longer counts as offline, so one hung connection cannot block syncing forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ApiClient {
  constructor(private readonly options: ApiOptions) {}

  login(username: string, password: string): Promise<LoginResponse> {
    return this.json("POST", "/api/auth/login", { username, password });
  }

  logout(): Promise<unknown> {
    return this.json("POST", "/api/auth/logout");
  }

  listFiles(): Promise<FileListResponse> {
    return this.json("GET", "/api/files");
  }

  async download(path: string): Promise<Download> {
    const res = await this.send("GET", `/api/files/content?${new URLSearchParams({ path })}`);
    return {
      data: res.arrayBuffer,
      version: Number(header(res, "x-file-version")),
      hash: header(res, "x-file-hash") ?? "",
    };
  }

  async upload(path: string, data: ArrayBuffer, baseVersion: number): Promise<FileMeta> {
    const query = new URLSearchParams({ path, baseVersion: String(baseVersion) });
    const res = await this.send("PUT", `/api/files/content?${query}`, data, "application/octet-stream");
    return parseJson(res);
  }

  delete(path: string, baseVersion: number): Promise<FileMeta> {
    return this.json("DELETE", `/api/files?${new URLSearchParams({ path, baseVersion: String(baseVersion) })}`);
  }

  rename(from: string, to: string, baseVersion: number): Promise<{ from: FileMeta; file: FileMeta }> {
    return this.json("POST", "/api/files/rename", { from, to, baseVersion });
  }

  acquireLock(path: string): Promise<LockInfo> {
    return this.json("POST", "/api/locks", { path });
  }

  releaseLock(path: string): Promise<unknown> {
    return this.json("DELETE", `/api/locks?${new URLSearchParams({ path })}`);
  }

  forceReleaseLock(path: string): Promise<unknown> {
    return this.json("POST", "/api/locks/force-release", { path });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json");
    return parseJson(res);
  }

  private async send(method: string, path: string, body?: string | ArrayBuffer, contentType?: string): Promise<HttpResponse> {
    const base = this.options.serverUrl().replace(/\/+$/, "");
    if (!base) throw new OfflineError("Server URL not configured");
    const headers: Record<string, string> = {};
    const token = this.options.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined && contentType) headers["content-type"] = contentType;
    let res: HttpResponse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    try {
      res = await Promise.race([this.options.http({ url: base + path, method, headers, body }), timeout]);
    } catch (err) {
      throw new OfflineError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 400) {
      let errorBody: ErrorBody;
      try {
        errorBody = parseJson(res);
      } catch {
        errorBody = { error: "http_error", message: `HTTP ${res.status}` };
      }
      throw new ApiError(res.status, errorBody);
    }
    return res;
  }
}

function header(res: HttpResponse, name: string): string | undefined {
  const key = Object.keys(res.headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : res.headers[key];
}

function parseJson<T>(res: HttpResponse): T {
  return JSON.parse(new TextDecoder().decode(res.arrayBuffer)) as T;
}
