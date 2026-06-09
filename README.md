# Waiting Room Worker

Waiting room helps you to manage peak traffic and protect your origin servers from being overwhelmed with requests.

You can set a maximum capacity for your web site and when the capacity is full, new users are forwarded to the waiting room page.
When new spots are available, waiting users are allowed to the site. It is similar to Cloudflare Waiting Room but free and open source.

This repository was forked from [upstash/waiting-room](https://github.com/upstash/waiting-room) and adapted to use Cloudflare Durable Objects instead of Upstash Redis for session, queue, and capacity coordination.
It also adds FIFO fairness for waiting users, replacing the original project's random admission behavior, and includes an admin interface for reading and updating live capacity.

## What It Does

- Admitted visitors are forwarded to the origin behind the Worker route.
- Extra visitors receive a waiting-room page and retry automatically (`WAITING_ROOM_REFRESH_SECONDS`).
- Promoted queued visitors have a limited time to claim their slot before the offer expires (`OFFER_DURATION_SECONDS`).
- Inactive queued visitors are removed after they stop refreshing for too long (`QUEUE_INACTIVITY_SECONDS`).
- Active visitors keep their slot while they continue making requests before the session timeout (`SESSION_DURATION_SECONDS`).
- `POST` requests do not create a new admitted session and do not join the waiting-room queue. They pass through to origin unless the visitor already has a valid waiting-room session cookie, in which case the existing session is refreshed (`SESSION_DURATION_SECONDS`).
- Capacity can be changed at runtime without redeploying.

## Prerequisites

- Node.js and npm
- A Cloudflare account
- Wrangler v4

Install dependencies:

```sh
npm install
```

## Configuration

`wrangler.toml` already contains the Worker entrypoint, Durable Object binding, migration, and local dev upstream:

```toml
[dev]
host = "127.0.0.1:8080"
upstream_protocol = "http"
```

Set these Worker variables in `wrangler.toml` or in environment-specific Wrangler config:

- `SESSION_DURATION_SECONDS`: how long an admitted session stays valid without activity.
- `WAITING_ROOM_REFRESH_SECONDS`: how often the waiting-room page refreshes.
- `OFFER_DURATION_SECONDS`: how long a promoted visitor has to claim a slot.
- `QUEUE_INACTIVITY_SECONDS`: when an inactive queued visitor is dropped.
- `OBSERVABILITY_LOG_LEVEL`: `none`, `error`, `info`, or `debug`.
- `OBSERVABILITY_SAMPLE_RATE`: value from `0` to `1`.

Set these secrets with Wrangler:

- `WAITING_ROOM_COOKIE_SECRET`: required, minimum 32 characters.
- `WAITING_ROOM_ADMIN_SECRET`: optional, minimum 16 characters, required only if you want to use the admin capacity endpoints.

The live capacity defaults to `1` the first time the Durable Object is initialized.
After that, change capacity through the admin API instead of redeploying.

To customize the waiting-room page HTML, edit [waiting-room-template.js](./waiting-room-template.js).

## Local Development

Create `.dev.vars`:

```dotenv
WAITING_ROOM_COOKIE_SECRET="replace-with-at-least-32-characters"
WAITING_ROOM_ADMIN_SECRET="replace-with-at-least-16-characters"
```

Set the local origin in the `[dev]` section of `wrangler.toml`, run that origin, then start the Worker:

```sh
npm run dev
```

Open the local Worker URL in two separate browser sessions. One should reach the origin and the other should stay in the waiting room until capacity is available.

## Deploy

Set secrets:

```sh
npx wrangler secret put WAITING_ROOM_COOKIE_SECRET
npx wrangler secret put WAITING_ROOM_ADMIN_SECRET
```

Deploy:

```sh
npm run deploy
```

If you use a named Wrangler environment, add `--env <name>` to both the `secret put` and `deploy` commands.

## Route Traffic Through The Worker

Add one or more `routes` entries in `wrangler.toml` for the hostnames or paths you want the Worker to protect.

Protect an entire hostname:

```toml
routes = [
  { pattern = "example.com/*", zone_name = "example.com" }
]
```

Protect only specific paths:

```toml
routes = [
  { pattern = "example.com/checkout/*", zone_name = "example.com" },
  { pattern = "example.com/launch/*", zone_name = "example.com" }
]
```

After deploy, requests that match those routes will either:

- be forwarded to the origin when the visitor is admitted
- return the waiting-room page when the visitor must wait

All configured routes share the same waiting room. This worker sends every request to the same Durable Object instance, `WAITING_ROOM.idFromName('global')`, so capacity, queue order, and active sessions are global across every route attached to this worker.

If you need separate waiting rooms for different paths or hostnames, you need separate workers or code changes that map requests to different Durable Object names.

For local development, the Worker proxies to whatever origin you configure in the `[dev]` section of `wrangler.toml`.

## Change Capacity At Runtime

The Worker exposes:

- `GET /_waiting-room/admin`: browser admin page
- `GET /_waiting-room/admin/capacity`: current capacity and queue stats, requires `Authorization: Bearer <WAITING_ROOM_ADMIN_SECRET>`
- `POST /_waiting-room/admin/capacity`: update capacity, requires `Authorization: Bearer <WAITING_ROOM_ADMIN_SECRET>`

If `WAITING_ROOM_ADMIN_SECRET` is not set, the admin page still loads, but the capacity API cannot be used.

Open the admin page:

```text
https://your-worker.example.workers.dev/_waiting-room/admin
```

Read current capacity:

```sh
curl https://your-worker.example.workers.dev/_waiting-room/admin/capacity \
  -H 'Authorization: Bearer your-admin-secret'
```

Set capacity to 25 active users:

```sh
curl -X POST https://your-worker.example.workers.dev/_waiting-room/admin/capacity \
  -H 'Authorization: Bearer your-admin-secret' \
  -H 'Content-Type: application/json' \
  -d '{"totalActiveUsers":25}'
```

## Test

Run the test suite with:

```sh
npm test
```
