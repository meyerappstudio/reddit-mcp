import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.REDDIT_MCP_HOME ?? join(homedir(), ".reddit-mcp");
export const CONFIG_PATH = join(HOME, "config.json");
export const QUEUE_PATH = join(HOME, "queue.json");
export const LOCK_PATH = join(HOME, "queue.lock");
export const LOG_PATH = join(HOME, "worker.log");
export const DRAFTS_DIR = join(HOME, "drafts");
export const REDIRECT_URI = "http://localhost:8765/callback";

export type Config = {
  client_id: string;
  client_secret?: string; // empty for "installed app" type
  username?: string;
  refresh_token?: string;
};

export function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`No config at ${CONFIG_PATH}. Run: npm run auth`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(cfg: Config) {
  ensureHome();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  chmodSync(CONFIG_PATH, 0o600);
}

export function hasApiAuth(): boolean {
  try { return Boolean(loadConfig().refresh_token); } catch { return false; }
}
