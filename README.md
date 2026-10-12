# reddit-mcp

An MCP server that lets Claude Code (or any MCP client) browse subreddits, reply to threads, and publish or schedule Reddit posts through **your own** Reddit API app. It's a self-hosted, single-account alternative to hosted connectors like Composio or Postiz: no third-party service holds your token.

- **Publish now:** text (self) and link posts, with flair, NSFW, spoiler and reply settings.
- **Schedule:** posts go into a local queue, and a small launchd job publishes them when they're due. Claude Code doesn't need to be running.
- **Check before posting:** reads a subreddit's rules, post requirements (title/body regex, required flair) and flair ids.
- **Browse and reply:** reads feeds, searches, reads full comment threads and your inbox, and replies now or on a schedule.
- **Follow up:** lists your recent submissions with score, comment count and whether they were removed.

## Two modes

- **Assisted (works without Reddit API access):** Claude drafts the post or reply. A local draft page opens in your browser with the text ready to copy and a button to Reddit's submit page or the thread; the submit page comes prefilled where Reddit allows it. You review it and click Post. Scheduled assisted items show a macOS notification and open the draft at the scheduled time. You do the posting yourself, so nothing automates Reddit's site.
- **API:** once you have an approved Reddit API app and run `npm run auth`, posts and replies publish directly, and the browsing tools work.

Scheduling defaults to API mode once you're authorized and to assisted mode before that. Pass `mode` to override it.

## Tools

| Tool | What it does |
|---|---|
| `reddit_draft_post` | Assisted: opens a draft page and Reddit's prefilled submit page |
| `reddit_draft_reply` | Assisted: opens a draft page with the reply and a link to the thread |
| `reddit_mark_posted` | Marks an assisted draft as posted, optionally with its link |
| `reddit_whoami` | Shows the authorized account and its karma |
| `reddit_subreddit_info` | Gets rules, post requirements, allowed post types and flair ids |
| `reddit_submit_post` | Publishes immediately |
| `reddit_schedule_post` | Queues a post for an ISO 8601 `publish_at` |
| `reddit_list_scheduled` | Lists queued, failed and stuck posts (`include_done` adds history) |
| `reddit_update_scheduled` | Edits a queued or failed post; editing a failed post re-queues it |
| `reddit_cancel_scheduled` | Cancels a queued post |
| `reddit_publish_due` | Publishes everything that's due right now |
| `reddit_recent_posts` | Lists your recent submissions and how they're doing |
| `reddit_list_posts` | Browses a subreddit feed (hot, new, top, rising) |
| `reddit_search` | Searches posts on all of Reddit or in one subreddit |
| `reddit_get_thread` | Reads a post and its comment tree from a URL or id |
| `reddit_inbox` | Lists replies to your posts and comments |
| `reddit_reply` | Replies to a post (`t3_`) or comment (`t1_`) immediately |
| `reddit_schedule_reply` | Queues a reply; the queue tools manage it too |
| `reddit_edit` | Edits your own comment or self post |
| `reddit_delete` | Deletes your own comment or post |

## Requirements

- Node.js 23.6 or later (it runs the TypeScript directly; there's no build step)
- macOS for the bundled launchd scheduler. On Linux, run `node src/worker.ts` from cron every 5 minutes instead.
- A Reddit account and a Reddit API app. Reddit reviews new API apps under its developer terms, so app creation or access may need approval first.

## Setup

For assisted mode only, run `npm install`, then do steps 3 and 4 below. API mode needs all four steps.

```sh
git clone https://github.com/meyerappstudio/reddit-mcp && cd reddit-mcp
npm install
```

1. **Create a Reddit app** at <https://www.reddit.com/prefs/apps>. Choose the **installed app** type and set the redirect URI to `http://localhost:8765/callback`. Reddit doesn't allow app names that contain "reddit". Since late 2025, Reddit has required approval for new API apps, so if the create button fails without an error, request API access from Reddit first.
2. **Authorize:** run `npm run auth`, paste the client ID, then approve in the browser. This saves a refresh token to `~/.reddit-mcp/config.json` (mode 600).
3. **Add it to Claude Code:**
   ```sh
   claude mcp add --scope user reddit -- node "$PWD/src/server.ts"
   ```
4. **Start the scheduler** (macOS): `npm run install-worker`. It runs every 5 minutes; remove it with `npm run uninstall-worker`.

Then ask Claude something like: *"Check r/SideProject's rules, then schedule this launch post for Tuesday 9am Eastern."*

## How scheduling works

- The queue lives at `~/.reddit-mcp/queue.json`, and a lock file keeps the MCP server and the worker from publishing the same post twice.
- A post is marked `publishing` before the API call. If the process dies mid-call, the post stays `publishing` and is **not** retried, because Reddit may already have accepted it. Check `reddit_recent_posts`, then cancel or re-queue it.
- If Reddit rejects a post (rules, rate limit, flair required), it's marked `failed` with Reddit's error. Fix it with `reddit_update_scheduled` and it's queued again.
- The worker log is at `~/.reddit-mcp/worker.log`.
- Assisted drafts are saved in `~/.reddit-mcp/drafts/` as HTML pages.
- Set `REDDIT_MCP_HOME` to keep state somewhere else, and `REDDIT_MCP_NO_OPEN=1` to stop it opening pages or showing notifications (useful for tests).

## Limits

- Image, video and gallery posts aren't supported yet; they need Reddit's media-upload flow.
- One account per state directory.
- Assisted mode can't read Reddit for you. Paste a thread link or its text into the chat so Claude can draft a reply.
- The worker publishes within 5 minutes of `publish_at`, and only while the Mac is awake.

## Posting responsibly

Reddit and most subreddits restrict self-promotion and repetitive cross-posting, and bans happen fast. Always call `reddit_subreddit_info` first, follow each subreddit's rules, and don't schedule the same post across many subreddits. This tool doesn't evade rate limits or spam filters, and it isn't meant to.

## License

MIT
