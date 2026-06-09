# Durable Object Architecture

## Worker to Durable Object Interface

The edge worker talks to a single `WaitingRoom` Durable Object instance named `global`.
Every non-favicon request is normalized into one atomic `admit` operation.
Before the worker forwards `sessionId` or `queueId`, it validates the signed cookie token and drops any value with an invalid signature, wrong token type, or expired embedded session deadline.
An authenticated admin route can also read or update the live capacity through the same Durable Object.

### Request

`POST /admit`

```json
{
  "sessionId": "optional active-session id from cookie",
  "queueId": "optional waiting-entry id from cookie",
  "path": "/requested/path",
  "now": 1735689600000
}
```

### Response

```json
{
  "decision": "admit" | "wait",
  "sessionId": "active-session id to persist when admitted",
  "queueId": "stable waiting-entry id to persist when waiting",
  "position": 1,
  "refreshSeconds": 20,
  "sessionExpiresAt": 1735689660000,
  "offerExpiresAt": 1735689620000
}
```

### Operation Semantics

- Session lookup: validate whether `sessionId` still maps to an active admitted session.
- Session refresh: extend the active session expiry when the existing session remains valid.
- Queue entry creation: create a stable waiting entry when capacity is unavailable and the caller does not already have one.
- Queue status read: return the caller's current position when they remain queued.
- Head-of-line offer claim: when the caller owns the active reservation offer, convert that reservation into an active session in the same serialized operation.
- Queue advancement: issue reservation offers in FIFO order whenever capacity becomes available.

### Admin Capacity Interface

`GET /_waiting-room/admin/capacity`

Response:

```json
{
  "totalActiveUsers": 25,
  "activeSessions": 12,
  "queueDepth": 37,
  "activeOffers": 3,
  "reservedCapacity": 15,
  "nextSessionExpiresAt": 1700000030000,
  "nextOfferExpiresAt": 1700000023000,
  "nextQueueEntryExpiresAt": 1700000121000
}
```

`POST /_waiting-room/admin/capacity`

```json
{
  "totalActiveUsers": 25,
  "activeSessions": 12,
  "queueDepth": 37,
  "activeOffers": 3,
  "reservedCapacity": 15,
  "nextSessionExpiresAt": 1700000030000,
  "nextOfferExpiresAt": 1700000023000,
  "nextQueueEntryExpiresAt": 1700000121000
}
```

`GET /_waiting-room/admin` returns a small HTML admin page. The JSON route is authenticated with `Authorization: Bearer <WAITING_ROOM_ADMIN_SECRET>` and is forwarded to the same Durable Object that owns queue state.

## Durable Object State Model

All state is owned by one SQLite-backed Durable Object database.

### Tables

`meta`

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
)
```

Current keys:

- `next_ticket`: next monotonic queue ticket to assign
- `capacity`: current live admission capacity, initialized to `1` when the Durable Object database is first created

`sessions`

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)
```

`queue_entries`

```sql
CREATE TABLE queue_entries (
  queue_id TEXT PRIMARY KEY,
  ticket INTEGER NOT NULL UNIQUE,
  enqueued_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
)
```

`offers`

```sql
CREATE TABLE offers (
  queue_id TEXT PRIMARY KEY,
  ticket INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)
```

### Indexes

- `sessions(expires_at)`
- `queue_entries(ticket)`
- `queue_entries(last_seen_at)`
- `offers(expires_at)`

## Invariants

- Queue order is the ascending order of `queue_entries.ticket`.
- `meta.next_ticket` increases monotonically and is never reused.
- `meta.capacity` is the single source of truth for live admission capacity after initialization.
- Direct admission is allowed only when `queue_entries` is empty, `offers` is empty, and active capacity remains.
- Reserved capacity is `COUNT(sessions) + COUNT(offers)`.
- At most one active offer may exist for a given `queue_id`.
- Claiming an offer deletes both the `offers` row and the `queue_entries` row and creates exactly one `sessions` row.

## State Transitions

- New visitor with free capacity and no queue backlog:
  insert into `sessions`, return `admit`.
- New visitor with no free capacity or with any queue backlog:
  insert or reuse `queue_entries`, return `wait`.
- Session refresh:
  update `sessions.expires_at`.
- Capacity opens:
  select the next `queue_entries` row without an offer by `ORDER BY ticket LIMIT 1`, then insert into `offers`.
- Admin capacity update:
  update `meta.capacity`, then immediately try to advance the queue under the new limit.
- Offer claimed:
  delete `offers` row, delete `queue_entries` row, insert `sessions` row.
- Session expiry:
  delete expired `sessions` rows, then advance the queue.
- Offer expiry:
  delete expired `offers` rows, then advance the queue.
- Queue expiry:
  delete stale `queue_entries` rows and any associated `offers` rows.

## Scaling Notes

This implementation avoids full key-prefix scans on normal requests. The hot-path operations are all bounded by indexed SQL queries:

- session refresh by `session_id`
- queue lookup by `queue_id`
- next waiting user by `ORDER BY ticket LIMIT 1`
- queue position by `COUNT(*) WHERE ticket <= ?`
- alarm scheduling by `MIN(expires_at)` and `MIN(last_seen_at)`

That keeps the per-request query shape stable even when the queue grows to thousands of users.

## Cookie Contract

- `__waiting_room_session`: signed worker-issued token containing `type=session`, the durable-object `sessionId`, and the current session expiry.
- `__waiting_room_queue`: signed worker-issued token containing `type=queue` and the durable-object `queueId`.
- Both cookies are issued with `Path=/`, `HttpOnly`, `Secure`, and `SameSite=Lax`.
