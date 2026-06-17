import { renderWaitingRoomHtml } from './waiting-room-template.js'
import {
  ADMIN_CAPACITY_PATH,
  handleAdminRequest,
  isAdminRequestPath,
} from './admin.js'

const COOKIE_NAME_SESSION = '__waiting_room_session'
const COOKIE_NAME_QUEUE = '__waiting_room_queue'
const COOKIE_TOKEN_VERSION = 'v1'
const COOKIE_TOKEN_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' }
const COOKIE_ATTRIBUTES = ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const signingKeyCache = new Map()
const configCache = new WeakMap()
const OBSERVABILITY_COMPONENT = 'waiting_room'
const OBSERVABILITY_LEVELS = Object.freeze({
  none: 0,
  error: 1,
  info: 2,
  debug: 3,
})
const OBSERVABILITY_EVENT_CONFIG = Object.freeze({
  admission_granted: { level: 'info', sampleable: false },
  session_refreshed: { level: 'debug', sampleable: true },
  queue_entered: { level: 'info', sampleable: true },
  offer_issued: { level: 'info', sampleable: false },
  sessions_expired: { level: 'info', sampleable: false },
  offers_expired: { level: 'info', sampleable: false },
  queue_entries_expired: { level: 'info', sampleable: false },
})
const DEFAULT_CONFIG = Object.freeze({
  sessionDurationSeconds: 30,
  waitingRoomRefreshSeconds: 20,
  queuePositionCacheSecondsMultiplier: 2,
})
const DEFAULT_TOTAL_ACTIVE_USERS = 1

export default {
  async fetch(request, env) {
    try {
      getConfig(env)
      return await handleRequest(request, env)
    } catch (error) {
      console.error('waiting-room request failed', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  },
}

export class WaitingRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.config = getConfig(env)
    this.storage = state.storage
    this.sql = state.storage.sql
    this.nextCapacityExpiresAt = undefined
    this.currentAlarmAt = undefined

    state.blockConcurrencyWhile(async () => {
      this.initializeSchema()
    })
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/admit') {
      const payload = await request.json()
      const response =
        payload?.mode === 'refresh'
          ? await this.handleSessionRefresh(payload)
          : await this.handleAdmission(payload)
      return json(response)
    }
    if (url.pathname === ADMIN_CAPACITY_PATH) {
      if (request.method === 'GET') {
        return json(this.getAdminStats())
      }
      if (request.method === 'POST') {
        const payload = await request.json()
        const response = await this.handleCapacityUpdate(payload)
        return json(response)
      }
    }

    return new Response('Not Found', { status: 404 })
  }

  async alarm() {
    const now = Date.now()
    this.cleanupExpired(now)
    this.advanceQueue(now)
    await this.scheduleNextAlarm(now, { force: true })
  }

  async handleAdmission(payload) {
    const now = Number(payload.now) || Date.now()
    const sessionTtlMs = this.getSessionDurationMs()

    const sessionId = payload.sessionId || null
    const queueId = payload.queueId || null
    const activeSession = sessionId ? this.getSession(sessionId) : null

    if (activeSession && activeSession.expiresAt > now) {
      this.sql.exec(
        `UPDATE sessions SET expires_at = ? WHERE session_id = ?`,
        now + sessionTtlMs,
        sessionId,
      )
      this.logEvent('session_refreshed', {
        now,
        sessionId,
        sessionExpiresAt: now + sessionTtlMs,
      })
      await this.scheduleNextAlarm(now, { force: true })
      return {
        decision: 'admit',
        sessionId,
        sessionExpiresAt: now + sessionTtlMs,
        refreshSeconds: this.getRefreshSeconds(),
      }
    }

    if (activeSession) {
      this.expireCurrentSession(activeSession, now)
    }

    let stateChanged = Boolean(activeSession)
    stateChanged =
      this.advanceQueueIfCapacityAvailable(now) || stateChanged

    let queueEntry = queueId ? this.getQueueEntry(queueId) : null
    if (queueEntry && this.isQueueEntryInactive(queueEntry, now)) {
      this.expireCurrentQueueEntry(queueEntry, now)
      stateChanged = true
      queueEntry = null
    }

    let activeOffer = queueEntry ? this.getOffer(queueEntry.queueId) : null
    if (activeOffer && activeOffer.expiresAt <= now) {
      this.expireCurrentOffer(activeOffer, now)
      stateChanged = true
      activeOffer = null
    }

    if (queueEntry && activeOffer && activeOffer.expiresAt > now) {
      return this.claimOffer(queueEntry, activeOffer, now, sessionTtlMs)
    }

    let counts = this.getAdmissionCounts()
    if (
      counts.queueDepth === 0 &&
      (counts.offerCount > 0 ||
        counts.activeSessionCount >= this.getCapacity())
    ) {
      this.cleanupExpiredCapacity(now)
      counts = this.getAdmissionCounts()
    }

    if (
      counts.queueDepth === 0 &&
      counts.offerCount === 0 &&
      counts.activeSessionCount < this.getCapacity()
    ) {
      const admittedSessionId = crypto.randomUUID()
      this.withTransaction(() => {
        this.sql.exec(
          `INSERT INTO sessions (session_id, created_at, expires_at) VALUES (?, ?, ?)`,
          admittedSessionId,
          now,
          now + sessionTtlMs,
        )
        this.incrementMetaCounter('active_sessions', 1)
      })
      this.logEvent('admission_granted', {
        now,
        admissionSource: 'immediate',
        sessionId: admittedSessionId,
        sessionExpiresAt: now + sessionTtlMs,
        counters: {
          admissions: 1,
        },
      })
      await this.scheduleNextAlarm(now, { force: true })

      return {
        decision: 'admit',
        sessionId: admittedSessionId,
        sessionExpiresAt: now + sessionTtlMs,
        refreshSeconds: this.getRefreshSeconds(),
      }
    }

    const createdQueueEntry = !queueEntry
    const waitingEntry = queueEntry || this.createQueueEntry(queueId, now)
    if (createdQueueEntry) {
      stateChanged = true
    }
    if (!queueEntry) {
      this.logEvent('queue_entered', {
        now,
        queueId: waitingEntry.queueId,
        ticket: waitingEntry.ticket,
      })
    }
    if (queueEntry && this.shouldWriteQueueHeartbeat(queueEntry, now)) {
      this.sql.exec(
        `UPDATE queue_entries SET last_seen_at = ? WHERE queue_id = ?`,
        now,
        waitingEntry.queueId,
      )
      stateChanged = true
    }

    if (stateChanged) {
      stateChanged =
        this.advanceQueueIfCapacityAvailable(now) || stateChanged
    }

    const refreshedOffer = this.getOffer(waitingEntry.queueId)
    if (refreshedOffer && refreshedOffer.expiresAt > now) {
      return this.claimOffer(waitingEntry, refreshedOffer, now, sessionTtlMs)
    }

    const position = this.getQueuePosition(
      waitingEntry.queueId,
      waitingEntry.ticket,
      now,
    )

    if (stateChanged) {
      await this.scheduleNextAlarm(now, { force: true })
    }

    return {
      decision: 'wait',
      queueId: waitingEntry.queueId,
      position,
      refreshSeconds: this.getRefreshSeconds(),
      offerExpiresAt: refreshedOffer?.expiresAt ?? null,
    }
  }

  async claimOffer(queueEntry, activeOffer, now, sessionTtlMs) {
    const admittedSessionId = crypto.randomUUID()
    this.withTransaction(() => {
      this.sql.exec(
        `INSERT INTO sessions (session_id, created_at, expires_at) VALUES (?, ?, ?)`,
        admittedSessionId,
        now,
        now + sessionTtlMs,
      )
      this.incrementMetaCounter('active_sessions', 1)
      this.sql.exec(`DELETE FROM offers WHERE queue_id = ?`, queueEntry.queueId)
      this.decrementMetaCounter('active_offers', 1)
      this.sql.exec(
        `DELETE FROM queue_entries WHERE queue_id = ?`,
        queueEntry.queueId,
      )
      this.decrementMetaCounter('queue_depth', 1)
      this.invalidateQueuePositionCache()
    })

    this.logEvent('admission_granted', {
      now,
      admissionSource: 'offer_claim',
      queueId: queueEntry.queueId,
      ticket: queueEntry.ticket,
      sessionId: admittedSessionId,
      sessionExpiresAt: now + sessionTtlMs,
      offerExpiresAt: activeOffer.expiresAt,
      counters: {
        admissions: 1,
      },
    })

    this.advanceQueue(now)
    await this.scheduleNextAlarm(now, { force: true })

    return {
      decision: 'admit',
      sessionId: admittedSessionId,
      sessionExpiresAt: now + sessionTtlMs,
      refreshSeconds: this.getRefreshSeconds(),
    }
  }

  async handleSessionRefresh(payload) {
    const now = Number(payload.now) || Date.now()
    const sessionTtlMs = this.getSessionDurationMs()
    const sessionId = payload.sessionId || null

    if (!sessionId) {
      const stateChanged = this.advanceQueueIfCapacityAvailable(now)
      if (stateChanged) {
        await this.scheduleNextAlarm(now, { force: true })
      }
      return {
        decision: 'pass',
      }
    }

    const activeSession = this.getSession(sessionId)
    if (!activeSession || activeSession.expiresAt <= now) {
      if (activeSession) {
        this.expireCurrentSession(activeSession, now)
      }
      let stateChanged = Boolean(activeSession)
      stateChanged =
        this.advanceQueueIfCapacityAvailable(now) || stateChanged
      if (stateChanged) {
        await this.scheduleNextAlarm(now, { force: true })
      }
      return {
        decision: 'pass',
      }
    }

    this.sql.exec(
      `UPDATE sessions SET expires_at = ? WHERE session_id = ?`,
      now + sessionTtlMs,
      sessionId,
    )
    this.logEvent('session_refreshed', {
      now,
      sessionId,
      sessionExpiresAt: now + sessionTtlMs,
    })
    await this.scheduleNextAlarm(now, { force: true })
    return {
      decision: 'refresh',
      sessionId,
      sessionExpiresAt: now + sessionTtlMs,
    }
  }

  createQueueEntry(existingQueueId, now) {
    return this.withTransaction(() => {
      const nextTicket = this.reserveNextTicket()
      const entry = {
        queueId: existingQueueId || crypto.randomUUID(),
        ticket: nextTicket,
        enqueuedAt: now,
        lastSeenAt: now,
      }

      this.sql.exec(
        `INSERT INTO queue_entries (queue_id, ticket, enqueued_at, last_seen_at)
         VALUES (?, ?, ?, ?)`,
        entry.queueId,
        entry.ticket,
        entry.enqueuedAt,
        entry.lastSeenAt,
      )
      this.incrementMetaCounter('queue_depth', 1)

      return entry
    })
  }

  async handleCapacityUpdate(payload) {
    const totalActiveUsers = parseIntegerSetting(payload?.totalActiveUsers, null, {
      name: 'totalActiveUsers',
      min: 0,
      integerOnly: true,
    })

    const now = Date.now()
    this.withTransaction(() => {
      this.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('capacity', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        totalActiveUsers,
      )
      this.advanceQueue(now)
    })
    await this.scheduleNextAlarm(now, { force: true })

    return this.getAdminStats()
  }

  cleanupExpired(now) {
    const capacityChanged = this.cleanupExpiredCapacity(now)
    const queueChanged = this.cleanupStaleQueueEntries(now)
    return capacityChanged || queueChanged
  }

  cleanupExpiredCapacity(now) {
    let stateChanged = false
    const expiredSessionIds = this.allRows(
      `SELECT session_id FROM sessions WHERE expires_at <= ?`,
      now,
    ).map(row => row.session_id)
    if (expiredSessionIds.length > 0) {
      this.withTransaction(() => {
        this.sql.exec(`DELETE FROM sessions WHERE expires_at <= ?`, now)
        this.decrementMetaCounter('active_sessions', expiredSessionIds.length)
      })
      this.logEvent('sessions_expired', {
        now,
        expiredSessionCount: expiredSessionIds.length,
        counters: {
          sessionExpirations: expiredSessionIds.length,
        },
      })
      stateChanged = true
    }

    const expiredOffers = this.allRows(
      `SELECT queue_id, ticket FROM offers WHERE expires_at <= ?`,
      now,
    )
    if (expiredOffers.length > 0) {
      this.withTransaction(() => {
        this.sql.exec(`DELETE FROM offers WHERE expires_at <= ?`, now)
        this.decrementMetaCounter('active_offers', expiredOffers.length)
      })
      this.logEvent('offers_expired', {
        now,
        expiredOfferCount: expiredOffers.length,
        counters: {
          offerExpirations: expiredOffers.length,
        },
      })
      stateChanged = true
    }

    if (stateChanged) {
      this.nextCapacityExpiresAt = undefined
    }
    return stateChanged
  }

  cleanupStaleQueueEntries(now) {
    const staleBefore = now - this.getQueueInactivityMs()
    const staleQueueIds = this.allRows(
      `SELECT queue_id FROM queue_entries WHERE last_seen_at <= ?`,
      staleBefore,
    )

    if (staleQueueIds.length > 0) {
      const staleOfferCount = this.getScalar(
        `SELECT COUNT(*) AS count
         FROM offers
         WHERE queue_id IN (
           SELECT queue_id FROM queue_entries WHERE last_seen_at <= ?
         )`,
        'count',
        staleBefore,
      )
      this.withTransaction(() => {
        this.sql.exec(
          `DELETE FROM offers
           WHERE queue_id IN (
             SELECT queue_id FROM queue_entries WHERE last_seen_at <= ?
           )`,
          staleBefore,
        )
        this.sql.exec(
          `DELETE FROM queue_entries WHERE last_seen_at <= ?`,
          staleBefore,
        )
        this.decrementMetaCounter('active_offers', staleOfferCount)
        this.decrementMetaCounter('queue_depth', staleQueueIds.length)
        this.invalidateQueuePositionCache()
      })
      this.logEvent('queue_entries_expired', {
        now,
        expiredQueueEntryCount: staleQueueIds.length,
        counters: {
          queueExpirations: staleQueueIds.length,
        },
      })
      return true
    }
    return false
  }

  expireCurrentSession(session, now) {
    this.withTransaction(() => {
      this.sql.exec(`DELETE FROM sessions WHERE session_id = ?`, session.sessionId)
      this.decrementMetaCounter('active_sessions', 1)
    })
    this.logEvent('sessions_expired', {
      now,
      expiredSessionCount: 1,
      counters: {
        sessionExpirations: 1,
      },
    })
  }

  expireCurrentOffer(offer, now) {
    this.withTransaction(() => {
      this.sql.exec(`DELETE FROM offers WHERE queue_id = ?`, offer.queueId)
      this.decrementMetaCounter('active_offers', 1)
    })
    this.logEvent('offers_expired', {
      now,
      expiredOfferCount: 1,
      counters: {
        offerExpirations: 1,
      },
    })
  }

  expireCurrentQueueEntry(queueEntry, now) {
    const activeOffer = this.getOffer(queueEntry.queueId)
    this.withTransaction(() => {
      this.sql.exec(`DELETE FROM offers WHERE queue_id = ?`, queueEntry.queueId)
      if (activeOffer) {
        this.decrementMetaCounter('active_offers', 1)
      }
      this.sql.exec(
        `DELETE FROM queue_entries WHERE queue_id = ?`,
        queueEntry.queueId,
      )
      this.decrementMetaCounter('queue_depth', 1)
      this.invalidateQueuePositionCache()
    })
    this.logEvent('queue_entries_expired', {
      now,
      expiredQueueEntryCount: 1,
      counters: {
        queueExpirations: 1,
      },
    })
  }

  advanceQueue(now) {
    const capacity = this.getCapacity()
    const offerDurationMs = this.getOfferDurationMs()
    let reservedCapacity = this.getReservedCapacity()
    let offersIssued = 0

    while (reservedCapacity < capacity) {
      const nextEntry = this.firstRow(`
        SELECT q.queue_id, q.ticket
        FROM queue_entries q
        LEFT JOIN offers o ON o.queue_id = q.queue_id
        WHERE o.queue_id IS NULL
        ORDER BY q.ticket
        LIMIT 1
      `)

      if (!nextEntry) {
        return offersIssued
      }

      this.sql.exec(
        `INSERT INTO offers (queue_id, ticket, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        nextEntry.queue_id,
        nextEntry.ticket,
        now,
        now + offerDurationMs,
      )
      this.incrementMetaCounter('active_offers', 1)
      reservedCapacity += 1
      offersIssued += 1
      this.logEvent('offer_issued', {
        now,
        queueId: nextEntry.queue_id,
        ticket: nextEntry.ticket,
        offerExpiresAt: now + offerDurationMs,
        counters: {
          offersIssued: 1,
        },
      })
    }
    return offersIssued
  }

  advanceQueueIfCapacityAvailable(now) {
    const queueDepth = this.getMetaValue('queue_depth', 0)
    if (queueDepth === 0) {
      return false
    }

    let stateChanged = false
    if (this.getReservedCapacity() >= this.getCapacity()) {
      const nextCapacityExpiresAt = this.getNextCapacityExpiresAt()
      if (nextCapacityExpiresAt === null || nextCapacityExpiresAt > now) {
        return false
      }
      stateChanged = this.cleanupExpiredCapacity(now)
      if (!stateChanged) {
        this.nextCapacityExpiresAt = this.computeNextCapacityExpiresAt()
      }
    }

    if (this.getReservedCapacity() >= this.getCapacity()) {
      return stateChanged
    }

    return this.advanceQueue(now) > 0 || stateChanged
  }

  getAdmissionCounts() {
    return {
      queueDepth: this.getMetaValue('queue_depth', 0),
      offerCount: this.getMetaValue('active_offers', 0),
      activeSessionCount: this.getMetaValue('active_sessions', 0),
    }
  }

  isQueueEntryInactive(queueEntry, now) {
    return queueEntry.lastSeenAt <= now - this.getQueueInactivityMs()
  }

  shouldWriteQueueHeartbeat(queueEntry, now) {
    return now - queueEntry.lastSeenAt >= this.getQueueHeartbeatWriteMs()
  }

  getQueuePosition(queueId, ticket, now) {
    const cachedPosition = this.getCachedQueuePosition(queueId, now)
    if (cachedPosition !== null) {
      return cachedPosition
    }

    const position = this.getScalar(
      `SELECT COUNT(*) AS count FROM queue_entries WHERE ticket <= ?`,
      'count',
      ticket,
    )
    const safePosition = Math.max(position, 1)

    this.sql.exec(
      `INSERT INTO queue_position_cache (queue_id, position, computed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(queue_id) DO UPDATE SET
         position = excluded.position,
         computed_at = excluded.computed_at`,
      queueId,
      safePosition,
      now,
    )

    return safePosition
  }

  getCachedQueuePosition(queueId, now) {
    const cached = this.firstRow(
      `SELECT position, computed_at
       FROM queue_position_cache
       WHERE queue_id = ?`,
      queueId,
    )

    if (
      !cached ||
      now - cached.computed_at >= this.getQueuePositionCacheMs()
    ) {
      return null
    }

    return Math.max(cached.position, 1)
  }

  invalidateQueuePositionCache() {
    this.sql.exec(`DELETE FROM queue_position_cache`)
  }

  async scheduleNextAlarm(now, options = {}) {
    const deadlines = []
    const nextSessionExpiry = this.getScalar(
      `SELECT MIN(expires_at) AS value FROM sessions`,
      'value',
    )
    const nextOfferExpiry = this.getScalar(
      `SELECT MIN(expires_at) AS value FROM offers`,
      'value',
    )
    const nextQueueExpiryBase = this.getScalar(
      `SELECT MIN(last_seen_at) AS value FROM queue_entries`,
      'value',
    )

    if (nextSessionExpiry) {
      deadlines.push(nextSessionExpiry)
    }
    if (nextOfferExpiry) {
      deadlines.push(nextOfferExpiry)
    }
    this.nextCapacityExpiresAt = this.getEarliestDeadline([
      nextSessionExpiry,
      nextOfferExpiry,
    ])
    if (nextQueueExpiryBase) {
      deadlines.push(nextQueueExpiryBase + this.getQueueInactivityMs())
    }

    const nextAlarm = this.getEarliestDeadline(
      deadlines.filter(deadline => deadline > now),
    )

    if (!options.force && this.currentAlarmAt === nextAlarm) {
      return
    }

    if (nextAlarm) {
      await this.storage.setAlarm(nextAlarm)
    } else {
      await this.storage.deleteAlarm()
    }
    this.currentAlarmAt = nextAlarm
  }

  initializeSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queue_entries (
        queue_id TEXT PRIMARY KEY,
        ticket INTEGER NOT NULL UNIQUE,
        enqueued_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS offers (
        queue_id TEXT PRIMARY KEY,
        ticket INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queue_position_cache (
        queue_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        computed_at INTEGER NOT NULL
      );
    `)
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)`,
    )
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_queue_entries_ticket ON queue_entries (ticket)`,
    )
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_queue_entries_last_seen_at ON queue_entries (last_seen_at)`,
    )
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_offers_expires_at ON offers (expires_at)`,
    )
    this.sql.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ticket', 1)`,
    )
    this.sql.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('capacity', ?)`,
      DEFAULT_TOTAL_ACTIVE_USERS,
    )
    this.initializeMetaCounter(
      'active_sessions',
      `SELECT COUNT(*) AS count FROM sessions`,
    )
    this.initializeMetaCounter(
      'active_offers',
      `SELECT COUNT(*) AS count FROM offers`,
    )
    this.initializeMetaCounter(
      'queue_depth',
      `SELECT COUNT(*) AS count FROM queue_entries`,
    )
  }

  reserveNextTicket() {
    const current = this.getMetaValue('next_ticket', 1)
    this.sql.exec(
      `UPDATE meta SET value = ? WHERE key = 'next_ticket'`,
      current + 1,
    )
    return current
  }

  getMetaValue(key, fallback) {
    const row = this.firstRow(`SELECT value FROM meta WHERE key = ?`, key)
    return row ? row.value : fallback
  }

  initializeMetaCounter(key, countQuery) {
    const value = this.getScalar(countQuery, 'count')
    this.sql.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`,
      key,
      value,
    )
  }

  incrementMetaCounter(key, amount) {
    this.adjustMetaCounter(key, amount)
  }

  decrementMetaCounter(key, amount) {
    this.adjustMetaCounter(key, -amount)
  }

  adjustMetaCounter(key, amount) {
    if (amount === 0) {
      return
    }
    this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, 0)`, key)
    this.sql.exec(
      `UPDATE meta SET value = max(value + ?, 0) WHERE key = ?`,
      amount,
      key,
    )
  }

  withTransaction(callback) {
    if (typeof this.storage.transactionSync === 'function') {
      return this.storage.transactionSync(callback)
    }

    return callback()
  }

  getReservedCapacity() {
    return (
      this.getMetaValue('active_sessions', 0) +
      this.getMetaValue('active_offers', 0)
    )
  }

  getSession(sessionId) {
    const row = this.firstRow(
      `SELECT session_id, created_at, expires_at FROM sessions WHERE session_id = ?`,
      sessionId,
    )
    if (!row) {
      return null
    }

    return {
      sessionId: row.session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  getQueueEntry(queueId) {
    const row = this.firstRow(
      `SELECT queue_id, ticket, enqueued_at, last_seen_at
       FROM queue_entries
       WHERE queue_id = ?`,
      queueId,
    )
    if (!row) {
      return null
    }

    return {
      queueId: row.queue_id,
      ticket: row.ticket,
      enqueuedAt: row.enqueued_at,
      lastSeenAt: row.last_seen_at,
    }
  }

  getOffer(queueId) {
    const row = this.firstRow(
      `SELECT queue_id, ticket, created_at, expires_at
       FROM offers
       WHERE queue_id = ?`,
      queueId,
    )
    if (!row) {
      return null
    }

    return {
      queueId: row.queue_id,
      ticket: row.ticket,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  firstRow(query, ...bindings) {
    return this.allRows(query, ...bindings)[0] || null
  }

  allRows(query, ...bindings) {
    return [...this.sql.exec(query, ...bindings)]
  }

  getScalar(query, column, ...bindings) {
    const row = this.firstRow(query, ...bindings)
    return row?.[column] ?? null
  }

  getCapacity() {
    return this.getMetaValue('capacity', DEFAULT_TOTAL_ACTIVE_USERS)
  }

  getSessionDurationMs() {
    return this.config.sessionDurationSeconds * 1000
  }

  getRefreshSeconds() {
    return this.config.waitingRoomRefreshSeconds
  }

  getOfferDurationMs() {
    return this.config.offerDurationSeconds * 1000
  }

  getQueueInactivityMs() {
    return this.config.queueInactivitySeconds * 1000
  }

  getQueuePositionCacheMs() {
    return this.config.queuePositionCacheSeconds * 1000
  }

  getQueueHeartbeatWriteMs() {
    return this.config.queueHeartbeatWriteSeconds * 1000
  }

  getNextCapacityExpiresAt() {
    if (this.nextCapacityExpiresAt !== undefined) {
      return this.nextCapacityExpiresAt
    }

    return this.computeNextCapacityExpiresAt()
  }

  computeNextCapacityExpiresAt() {
    this.nextCapacityExpiresAt = this.getEarliestDeadline([
      this.getScalar(`SELECT MIN(expires_at) AS value FROM sessions`, 'value'),
      this.getScalar(`SELECT MIN(expires_at) AS value FROM offers`, 'value'),
    ])
    return this.nextCapacityExpiresAt
  }

  getEarliestDeadline(deadlines) {
    return deadlines
      .filter(deadline => typeof deadline === 'number')
      .sort((a, b) => a - b)[0] ?? null
  }

  getObservabilitySnapshot() {
    const activeSessions = this.getMetaValue('active_sessions', 0)
    const queueDepth = this.getMetaValue('queue_depth', 0)
    const activeOffers = this.getMetaValue('active_offers', 0)

    return {
      activeSessions,
      queueDepth,
      activeOffers,
      reservedCapacity: activeSessions + activeOffers,
      capacity: this.getCapacity(),
    }
  }

  getAdminStats() {
    const snapshot = this.getObservabilitySnapshot()
    const nextQueueExpiryBase = this.getScalar(
      `SELECT MIN(last_seen_at) AS value FROM queue_entries`,
      'value',
    )

    return {
      totalActiveUsers: snapshot.capacity,
      activeSessions: snapshot.activeSessions,
      queueDepth: snapshot.queueDepth,
      activeOffers: snapshot.activeOffers,
      reservedCapacity: snapshot.reservedCapacity,
      nextSessionExpiresAt: this.getScalar(
        `SELECT MIN(expires_at) AS value FROM sessions`,
        'value',
      ),
      nextOfferExpiresAt: this.getScalar(
        `SELECT MIN(expires_at) AS value FROM offers`,
        'value',
      ),
      nextQueueEntryExpiresAt: nextQueueExpiryBase
        ? nextQueueExpiryBase + this.getQueueInactivityMs()
        : null,
    }
  }

  logEvent(event, fields = {}) {
    const eventConfig = OBSERVABILITY_EVENT_CONFIG[event]
    if (!eventConfig || !this.shouldLogLevel(eventConfig.level)) {
      return
    }
    if (eventConfig.sampleable && !this.shouldSampleEvent()) {
      return
    }

    console.log(
      JSON.stringify({
        component: OBSERVABILITY_COMPONENT,
        event,
        level: eventConfig.level,
        message: this.getEventMessage(event, fields),
        ...fields,
        metrics: this.getObservabilitySnapshot(),
      }),
    )
  }

  shouldLogLevel(level) {
    return (
      OBSERVABILITY_LEVELS[this.config.observabilityLogLevel] >=
      OBSERVABILITY_LEVELS[level]
    )
  }

  shouldSampleEvent() {
    if (this.config.observabilityLogLevel === 'debug') {
      return true
    }

    return Math.random() < this.config.observabilitySampleRate
  }

  getEventMessage(event, fields) {
    switch (event) {
      case 'admission_granted':
        if (fields.admissionSource === 'offer_claim') {
          return `Queued user ${fields.queueId} claimed an offer and started session ${fields.sessionId}.`
        }
        return `New session ${fields.sessionId} started immediately.`
      case 'session_refreshed':
        return `Session ${fields.sessionId} refreshed its admission window.`
      case 'queue_entered':
        return `New user ${fields.queueId} entered the waiting room queue at ticket ${fields.ticket}.`
      case 'offer_issued':
        return `Queue entry ${fields.queueId} received an admission offer at ticket ${fields.ticket}.`
      case 'sessions_expired':
        return `${fields.expiredSessionCount} active session(s) expired and capacity was reclaimed.`
      case 'offers_expired':
        return `${fields.expiredOfferCount} unclaimed offer(s) expired and were returned to the queue.`
      case 'queue_entries_expired':
        return `${fields.expiredQueueEntryCount} inactive queue entr${fields.expiredQueueEntryCount === 1 ? 'y' : 'ies'} expired.`
      default:
        return `Waiting room event: ${event}.`
    }
  }
}

async function handleRequest(request, env) {
  const { pathname } = new URL(request.url)
  const config = getConfig(env)
  if (pathname.startsWith('/favicon')) {
    return fetch(request)
  }
  if (isAdminRequestPath(pathname)) {
    return handleAdminRequest(request, env, {
      applyNoStoreHeaders,
      getConfig,
      parseIntegerSetting,
      timingSafeEqual,
    })
  }

  const cookie = parseCookieHeader(request.headers.get('Cookie'))
  const now = Date.now()
  const [sessionToken, queueToken] = await Promise.all([
    verifyCookieTokenPayload(cookie[COOKIE_NAME_SESSION] || null, 'session', env),
    verifyCookieTokenPayload(cookie[COOKIE_NAME_QUEUE] || null, 'queue', env),
  ])
  const sessionId = sessionToken?.value ?? null
  const queueId = queueToken?.value ?? null

  if (request.method === 'POST') {
    return handlePostRequest(request, env, sessionToken, now)
  }

  if (
    sessionToken &&
    !shouldRefreshSessionToken(sessionToken, config, now)
  ) {
    return getExistingSessionResponse(request, env)
  }

  let admission
  try {
    admission = await callWaitingRoom(env, {
      sessionId,
      queueId,
      path: pathname,
      now,
    })
  } catch (error) {
    if (isDurableObjectOverloadedError(error)) {
      if (sessionToken) {
        return getExistingSessionResponse(request, env)
      }
      if (queueToken) {
        return getWaitingRoomResponse(
          {
            decision: 'wait',
            queueId,
            refreshSeconds: config.waitingRoomRefreshSeconds,
          },
          env,
        )
      }
    }

    throw error
  }

  if (admission.decision === 'admit') {
    return getDefaultResponse(request, env, admission)
  }

  return getWaitingRoomResponse(admission, env)
}

async function handlePostRequest(request, env, sessionToken, now) {
  if (!sessionToken) {
    return fetchOriginResponse(request, env)
  }
  if (!shouldRefreshSessionToken(sessionToken, getConfig(env), now)) {
    return getExistingSessionResponse(request, env)
  }

  let refresh
  try {
    refresh = await callWaitingRoom(env, {
      mode: 'refresh',
      sessionId: sessionToken.value,
      now,
    })
  } catch (error) {
    if (isDurableObjectOverloadedError(error)) {
      return getExistingSessionResponse(request, env)
    }

    throw error
  }
  const response = await fetchOriginResponse(request, env)

  if (refresh.decision !== 'refresh') {
    return response
  }

  const newResponse = new Response(response.body, response)
  applyNoStoreHeaders(newResponse)
  await appendCookie(
    newResponse,
    COOKIE_NAME_SESSION,
    refresh.sessionId,
    refresh.sessionExpiresAt,
    'session',
    env,
  )

  return newResponse
}

function shouldRefreshSessionToken(sessionToken, config, now) {
  if (typeof sessionToken.expiresAt !== 'number') {
    return true
  }

  return sessionToken.expiresAt - now <= getSessionRefreshThresholdMs(config)
}

function getSessionRefreshThresholdMs(config) {
  return Math.max(1000, Math.floor((config.sessionDurationSeconds * 1000) / 3))
}

function isDurableObjectOverloadedError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Durable Object is overloaded') ||
    message.includes('Requests queued for too long')
  )
}

async function callWaitingRoom(env, payload) {
  const id = env.WAITING_ROOM.idFromName('global')
  const stub = env.WAITING_ROOM.get(id)
  const response = await stub.fetch('https://waiting-room.internal/admit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Durable Object returned ${response.status}`)
  }

  return response.json()
}

async function getDefaultResponse(request, env, admission) {
  const response = await fetchOriginResponse(request, env)
  const newResponse = new Response(response.body, response)

  applyNoStoreHeaders(newResponse)
  await appendCookie(
    newResponse,
    COOKIE_NAME_SESSION,
    admission.sessionId,
    admission.sessionExpiresAt,
    'session',
    env,
  )
  clearCookie(newResponse, COOKIE_NAME_QUEUE)

  return newResponse
}

async function getExistingSessionResponse(request, env) {
  const response = await fetchOriginResponse(request, env)
  const newResponse = new Response(response.body, response)
  applyNoStoreHeaders(newResponse)
  return newResponse
}

async function fetchOriginResponse(request, env) {
  return fetch(request)
}

async function getWaitingRoomResponse(admission, env) {
  const response = new Response(renderWaitingRoomHtml(admission), {
    headers: {
      'content-type': 'text/html;charset=UTF-8',
    },
  })

  applyNoStoreHeaders(response)
  await appendCookie(
    response,
    COOKIE_NAME_QUEUE,
    admission.queueId,
    null,
    'queue',
    env,
  )
  clearCookie(response, COOKIE_NAME_SESSION)

  return response
}

function applyNoStoreHeaders(response) {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, must-revalidate',
  )
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
}

async function appendCookie(response, name, value, expiresAt, tokenType, env) {
  const token = await createCookieToken(tokenType, value, expiresAt, env)
  let cookie = `${name}=${encodeURIComponent(token)}; ${COOKIE_ATTRIBUTES.join(
    '; ',
  )}`
  if (expiresAt) {
    cookie += `; Max-Age=${Math.max(
      0,
      Math.floor((expiresAt - Date.now()) / 1000),
    )}`
  }
  response.headers.append('Set-Cookie', cookie)
}

function clearCookie(response, name) {
  response.headers.append(
    'Set-Cookie',
    `${name}=; ${COOKIE_ATTRIBUTES.join(
      '; ',
    )}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  )
}

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  })
}

function parseCookieHeader(header) {
  if (!header) {
    return {}
  }

  const cookies = {}
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!key) {
      continue
    }

    try {
      cookies[key] = decodeURIComponent(value)
    } catch {
      cookies[key] = value
    }
  }

  return cookies
}

async function createCookieToken(type, value, expiresAt, env) {
  const payload = {
    type,
    value,
    expiresAt: expiresAt ?? null,
  }
  const encodedPayload = encodeBase64Url(
    textEncoder.encode(JSON.stringify(payload)),
  )
  const signature = await signCookieToken(
    `${COOKIE_TOKEN_VERSION}.${encodedPayload}`,
    env,
  )
  return `${COOKIE_TOKEN_VERSION}.${encodedPayload}.${signature}`
}

async function verifyCookieToken(token, expectedType, env) {
  const payload = await verifyCookieTokenPayload(token, expectedType, env)
  return payload?.value ?? null
}

async function verifyCookieTokenPayload(token, expectedType, env) {
  if (!token) {
    return null
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }

  const [version, encodedPayload, providedSignature] = parts
  if (
    version !== COOKIE_TOKEN_VERSION ||
    !encodedPayload ||
    !providedSignature
  ) {
    return null
  }

  const expectedSignature = await signCookieToken(
    `${version}.${encodedPayload}`,
    env,
  )
  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    return null
  }

  let payload
  try {
    payload = JSON.parse(decodeBase64UrlToText(encodedPayload))
  } catch {
    return null
  }

  if (
    payload?.type !== expectedType ||
    typeof payload?.value !== 'string' ||
    !payload.value
  ) {
    return null
  }
  if (payload.expiresAt !== null && !Number.isFinite(payload.expiresAt)) {
    return null
  }
  if (
    typeof payload.expiresAt === 'number' &&
    payload.expiresAt <= Date.now()
  ) {
    return null
  }

  return {
    value: payload.value,
    expiresAt: payload.expiresAt,
  }
}

async function signCookieToken(message, env) {
  const key = await getCookieSigningKey(env)
  const signature = await crypto.subtle.sign(
    COOKIE_TOKEN_ALGORITHM.name,
    key,
    textEncoder.encode(message),
  )
  return encodeBase64Url(new Uint8Array(signature))
}

async function getCookieSigningKey(env) {
  const { cookieSecret: secret } = getConfig(env)

  let keyPromise = signingKeyCache.get(secret)
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      COOKIE_TOKEN_ALGORITHM,
      false,
      ['sign'],
    )
    signingKeyCache.set(secret, keyPromise)
  }

  return keyPromise
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeBase64UrlToText(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '=',
  )
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return textDecoder.decode(bytes)
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) {
    return false
  }

  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return result === 0
}

export function getConfig(env) {
  let config = configCache.get(env)
  if (!config) {
    config = Object.freeze(parseConfig(env))
    configCache.set(env, config)
  }
  return config
}

function parseConfig(env) {
  const cookieSecret = env.WAITING_ROOM_COOKIE_SECRET
  if (typeof cookieSecret !== 'string' || cookieSecret.length < 32) {
    throw new Error(
      'WAITING_ROOM_COOKIE_SECRET must be set to at least 32 characters',
    )
  }

  const waitingRoomRefreshSeconds = parseIntegerSetting(
    env.WAITING_ROOM_REFRESH_SECONDS,
    DEFAULT_CONFIG.waitingRoomRefreshSeconds,
    {
      name: 'WAITING_ROOM_REFRESH_SECONDS',
      min: 1,
      integerOnly: true,
    },
  )
  const offerDurationSeconds = parseIntegerSetting(
    env.OFFER_DURATION_SECONDS,
    waitingRoomRefreshSeconds,
    {
      name: 'OFFER_DURATION_SECONDS',
      min: waitingRoomRefreshSeconds,
      integerOnly: true,
      minimumHint: `must be greater than or equal to WAITING_ROOM_REFRESH_SECONDS (${waitingRoomRefreshSeconds})`,
    },
  )
  const queueInactivitySeconds = parseIntegerSetting(
    env.QUEUE_INACTIVITY_SECONDS,
    Math.max(waitingRoomRefreshSeconds * 3, 60),
    {
      name: 'QUEUE_INACTIVITY_SECONDS',
      min: waitingRoomRefreshSeconds * 2,
      integerOnly: true,
      minimumHint: `must be at least 2x WAITING_ROOM_REFRESH_SECONDS (${waitingRoomRefreshSeconds *
      2})`,
    },
  )
  const queuePositionCacheSeconds = parseIntegerSetting(
    env.QUEUE_POSITION_CACHE_SECONDS,
    waitingRoomRefreshSeconds * DEFAULT_CONFIG.queuePositionCacheSecondsMultiplier,
    {
      name: 'QUEUE_POSITION_CACHE_SECONDS',
      min: 1,
      integerOnly: true,
    },
  )
  const queueHeartbeatWriteSeconds = parseIntegerSetting(
    env.QUEUE_HEARTBEAT_WRITE_SECONDS,
    waitingRoomRefreshSeconds,
    {
      name: 'QUEUE_HEARTBEAT_WRITE_SECONDS',
      min: 1,
      integerOnly: true,
    },
  )
  if (queueHeartbeatWriteSeconds >= queueInactivitySeconds) {
    throw new Error(
      'QUEUE_HEARTBEAT_WRITE_SECONDS must be less than QUEUE_INACTIVITY_SECONDS',
    )
  }
  const observabilityLogLevel = parseLogLevelSetting(
    env.OBSERVABILITY_LOG_LEVEL,
    'info',
  )
  const observabilitySampleRate = parseSampleRateSetting(
    env.OBSERVABILITY_SAMPLE_RATE,
    1,
  )
  const adminSecret = parseAdminSecret(env.WAITING_ROOM_ADMIN_SECRET)

  return {
    adminSecret,
    cookieSecret,
    sessionDurationSeconds: parseIntegerSetting(
      env.SESSION_DURATION_SECONDS,
      DEFAULT_CONFIG.sessionDurationSeconds,
      {
        name: 'SESSION_DURATION_SECONDS',
        min: 1,
        integerOnly: true,
      },
    ),
    waitingRoomRefreshSeconds,
    offerDurationSeconds,
    queueInactivitySeconds,
    queuePositionCacheSeconds,
    queueHeartbeatWriteSeconds,
    observabilityLogLevel,
    observabilitySampleRate,
  }
}

function parseAdminSecret(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error(
      'WAITING_ROOM_ADMIN_SECRET must be at least 16 characters when set',
    )
  }
  return value
}

function parseIntegerSetting(value, fallback, options) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) {
    throw new Error(`${options.name} must be an integer`)
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${options.name} must be an integer`)
  }
  if (parsed < options.min) {
    throw new Error(
      options.minimumHint
        ? `${options.name} ${options.minimumHint}`
        : `${options.name} must be >= ${options.min}`,
    )
  }

  return parsed
}

function parseLogLevelSetting(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const normalized = String(value).trim().toLowerCase()
  if (!(normalized in OBSERVABILITY_LEVELS)) {
    throw new Error(
      'OBSERVABILITY_LOG_LEVEL must be one of: none, error, info, debug',
    )
  }

  return normalized
}

function parseSampleRateSetting(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('OBSERVABILITY_SAMPLE_RATE must be a number between 0 and 1')
  }

  return parsed
}
