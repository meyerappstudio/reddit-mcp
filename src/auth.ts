// One-time OAuth setup: stores a permanent refresh token in ~/.reddit-mcp/config.json.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { CONFIG_PATH, REDIRECT_URI, loadConfig, saveConfig, type Config } from "./config.ts";
import { exchangeToken } from "./reddit.ts";

const SCOPES = "identity submit read flair history edit privatemessages";

const rl = createInterface({ input: process.stdin, output: process.stdout });
let cfg: Config = existsSync(CONFIG_PATH) ? loadConfig() : { client_id: "" };

console.log(`Create a Reddit app at https://www.reddit.com/prefs/apps
  type: "installed app" (or "web app")
  redirect uri: ${REDIRECT_URI}\n`);

const id = (await rl.question(`Client ID${cfg.client_id ? ` [${cfg.client_id}]` : ""}: `)).trim();
if (id) cfg.client_id = id;
const secret = (await rl.question("Client secret (blank for installed app): ")).trim();
if (secret) cfg.client_secret = secret;
rl.close();
if (!cfg.client_id) throw new Error("Client ID is required");

const state = randomBytes(16).toString("hex");
const authUrl = "https://www.reddit.com/api/v1/authorize?" + new URLSearchParams({
  client_id: cfg.client_id,
  response_type: "code",
  state,
  redirect_uri: REDIRECT_URI,
  duration: "permanent",
  scope: SCOPES,
});

const code: string = await new Promise((resolve, reject) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? "/", REDIRECT_URI);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const err = u.searchParams.get("error");
    const c = u.searchParams.get("code");
    if (err || u.searchParams.get("state") !== state || !c) {
      res.writeHead(400).end(`Authorization failed: ${err ?? "state mismatch"}`);
      srv.close();
      reject(new Error(err ?? "state mismatch"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("reddit-mcp authorized. You can close this tab.");
    srv.close();
    resolve(c);
  }).listen(8765, () => {
    console.log(`\nOpening browser to authorize...\n${authUrl}\n`);
    if (process.platform === "darwin") execFile("open", [authUrl]);
  });
});

const t = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, cfg.client_id, cfg.client_secret);
if (!t.refresh_token) throw new Error("No refresh token returned");
cfg.refresh_token = t.refresh_token;

const meRes = await fetch("https://oauth.reddit.com/api/v1/me", {
  headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": `${process.platform}:reddit-mcp:v0.1.0` },
});
cfg.username = ((await meRes.json()) as any).name;
saveConfig(cfg);
console.log(`Authorized as u/${cfg.username}. Saved to ${CONFIG_PATH}`);
