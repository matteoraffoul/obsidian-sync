import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** A lock not renewed for this long is released (client crashed or went offline). */
  lockTtlMs: number;
  maxFileBytes: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8787),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    lockTtlMs: Number(env.LOCK_TTL_SECONDS ?? 90) * 1000,
    maxFileBytes: Number(env.MAX_FILE_MB ?? 100) * 1024 * 1024,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
