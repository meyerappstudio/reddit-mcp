import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { QUEUE_PATH, LOCK_PATH, LOG_PATH, ensureHome } from "./config.ts";
import { submitPost, type PostInput } from "./reddit.ts";

export type Status = "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type QueuedPost = PostInput & {
  id: string;
  publish_at: string; // ISO UTC
  status: Status;
  created_at: string;
  published_url?: string;
  error?: string;
  attempted_at?: string;
};

function read(): QueuedPost[] {
  if (!existsSync(QUEUE_PATH)) return [];
  return JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
}

function write(q: QueuedPost[]) {
  ensureHome();
  const tmp = QUEUE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, QUEUE_PATH);
}

// Cross-process lock so the MCP server and the launchd worker never publish the same post twice.
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureHome();
  for (let i = 0; i < 50; i++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      closeSync(fd);
      try { return await fn(); } finally { unlinkSync(LOCK_PATH); }
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Break a stale lock left by a crashed process.
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > 5 * 60_000) unlinkSync(LOCK_PATH);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Queue is locked by another process; try again shortly.");
}

export function log(msg: string) {
  ensureHome();
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

export async function schedule(p: PostInput, publishAt: Date): Promise<QueuedPost> {
  return withLock(async () => {
    const q = read();
    const item: QueuedPost = {
      ...p,
      id: randomUUID().slice(0, 8),
      publish_at: publishAt.toISOString(),
      status: "scheduled",
      created_at: new Date().toISOString(),
    };
    q.push(item);
    write(q);
    return item;
  });
}

export function list(includeDone = false): QueuedPost[] {
  return read()
    .filter((p) => includeDone || p.status === "scheduled" || p.status === "failed" || p.status === "publishing")
    .sort((a, b) => a.publish_at.localeCompare(b.publish_at));
}

export async function update(id: string, patch: Partial<PostInput> & { publish_at?: string }) {
  return withLock(async () => {
    const q = read();
    const item = q.find((p) => p.id === id);
    if (!item) throw new Error(`No queued post ${id}`);
    if (item.status !== "scheduled" && item.status !== "failed") throw new Error(`Post ${id} is ${item.status}; only scheduled/failed posts can be edited.`);
    Object.assign(item, patch, { status: "scheduled", error: undefined });
    write(q);
    return item;
  });
}

export async function cancel(id: string) {
  return withLock(async () => {
    const q = read();
    const item = q.find((p) => p.id === id);
    if (!item) throw new Error(`No queued post ${id}`);
    if (item.status === "published") throw new Error(`Post ${id} is already published: ${item.published_url}`);
    item.status = "cancelled";
    write(q);
    return item;
  });
}

// Publishes every scheduled post whose time has come. A post is marked "publishing" before the
// API call; if the process dies mid-call it stays "publishing" and is NOT retried automatically,
// because Reddit may have accepted it and a retry would double-post.
export async function publishDue(now = new Date()) {
  return withLock(async () => {
    const q = read();
    const due = q.filter((p) => p.status === "scheduled" && new Date(p.publish_at) <= now);
    const results: QueuedPost[] = [];
    for (const item of due) {
      item.status = "publishing";
      item.attempted_at = new Date().toISOString();
      write(q);
      try {
        const r = await submitPost(item);
        item.status = "published";
        item.published_url = r.url;
        log(`published ${item.id} r/${item.subreddit} ${r.url}`);
      } catch (e: any) {
        item.status = "failed";
        item.error = e.message;
        log(`failed ${item.id} r/${item.subreddit}: ${e.message}`);
      }
      write(q);
      results.push(item);
    }
    return results;
  });
}
