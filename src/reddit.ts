import { loadConfig } from "./config.ts";

const VERSION = "0.1.0";

let cached: { token: string; expires: number } | null = null;

function userAgent(username?: string) {
  return `${process.platform}:reddit-mcp:v${VERSION} (by /u/${username ?? "unknown"})`;
}

function basicAuth(clientId: string, secret = "") {
  return "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64");
}

export async function exchangeToken(params: Record<string, string>, clientId: string, secret?: string) {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(clientId, secret),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams(params),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Token request failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
}

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expires - 60_000) return cached.token;
  const cfg = loadConfig();
  if (!cfg.refresh_token) throw new Error("Not authorized yet. Run: npm run auth");
  const t = await exchangeToken(
    { grant_type: "refresh_token", refresh_token: cfg.refresh_token },
    cfg.client_id,
    cfg.client_secret,
  );
  cached = { token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
  return cached.token;
}

export async function api(path: string, init: { method?: string; form?: Record<string, string> } = {}) {
  const cfg = loadConfig();
  const token = await accessToken();
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent(cfg.username),
      ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.form ? new URLSearchParams(init.form) : undefined,
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(`Reddit ${res.status} on ${path}${remaining ? ` (ratelimit remaining ${remaining})` : ""}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
  }
  return body;
}

export type PostInput = {
  subreddit: string;
  title: string;
  kind?: "self" | "link";
  text?: string;
  url?: string;
  flair_id?: string;
  flair_text?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  send_replies?: boolean;
};

export function normalizeSub(s: string) {
  return s.replace(/^\/?r\//i, "").trim();
}

export async function submitPost(p: PostInput): Promise<{ id: string; name: string; url: string }> {
  const form: Record<string, string> = {
    api_type: "json",
    sr: normalizeSub(p.subreddit),
    kind: p.kind ?? "self",
    title: p.title,
    sendreplies: String(p.send_replies ?? true),
    nsfw: String(p.nsfw ?? false),
    spoiler: String(p.spoiler ?? false),
    resubmit: "true",
  };
  if (form.kind === "self") form.text = p.text ?? "";
  if (form.kind === "link") {
    if (!p.url) throw new Error("kind=link requires url");
    form.url = p.url;
  }
  if (p.flair_id) form.flair_id = p.flair_id;
  if (p.flair_text) form.flair_text = p.flair_text;

  const body = await api("/api/submit", { form });
  const errors = body?.json?.errors ?? [];
  if (errors.length) throw new Error(`Reddit rejected the post: ${JSON.stringify(errors)}`);
  const d = body?.json?.data;
  if (!d?.url) throw new Error(`Unexpected submit response: ${JSON.stringify(body).slice(0, 500)}`);
  return { id: d.id, name: d.name, url: d.url };
}

export async function subredditInfo(subreddit: string) {
  const sr = normalizeSub(subreddit);
  const settle = async <T>(p: Promise<T>) => p.catch((e: Error) => ({ unavailable: e.message }));
  const [about, rules, requirements, flairs] = await Promise.all([
    settle(api(`/r/${sr}/about`)),
    settle(api(`/r/${sr}/about/rules`)),
    settle(api(`/api/v1/${sr}/post_requirements`)),
    settle(api(`/r/${sr}/api/link_flair_v2`)),
  ]);
  const a: any = (about as any)?.data ?? about;
  return {
    subreddit: sr,
    about: a?.unavailable ? a : {
      title: a.title,
      subscribers: a.subscribers,
      submission_type: a.submission_type, // any | link | self
      allow_images: a.allow_images,
      over18: a.over18,
      user_is_banned: a.user_is_banned,
      submit_text: a.submit_text,
    },
    rules: (rules as any)?.rules?.map((r: any) => ({ name: r.short_name, description: r.description, applies_to: r.kind })) ?? rules,
    post_requirements: requirements,
    flairs: Array.isArray(flairs) ? flairs.map((f: any) => ({ id: f.id, text: f.text, text_editable: f.text_editable })) : flairs,
  };
}

export async function me() {
  const m = await api("/api/v1/me");
  return { name: m.name, link_karma: m.link_karma, comment_karma: m.comment_karma, created_utc: m.created_utc };
}

export async function recentPosts(limit = 10) {
  const cfg = loadConfig();
  const m = cfg.username ?? (await me()).name;
  const listing = await api(`/user/${m}/submitted?limit=${limit}&raw_json=1`);
  return listing.data.children.map((c: any) => ({
    subreddit: c.data.subreddit,
    title: c.data.title,
    url: `https://www.reddit.com${c.data.permalink}`,
    score: c.data.score,
    num_comments: c.data.num_comments,
    removed: Boolean(c.data.removed_by_category),
    created: new Date(c.data.created_utc * 1000).toISOString(),
  }));
}
