import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import worker, { WaitingRoom, getConfig } from '../index.js'

const COOKIE_NAME_SESSION = '__waiting_room_session'
const COOKIE_NAME_QUEUE = '__waiting_room_queue'
const BASE_TIME_MS = 1_700_000_000_000

class SqlStorageAdapter {
  constructor() {
    this.database = new DatabaseSync(':memory:')
  }

  exec(query, ...bindings) {
    const trimmed = query.trim()

    if (
      bindings.length === 0 &&
      trimmed.includes(';') &&
      !startsWithSelect(trimmed)
    ) {
      this.database.exec(query)
      return []
    }

    const statement = this.database.prepare(query)
    if (startsWithSelect(trimmed)) {
      return statement.all(...bindings)
    }

    statement.run(...bindings)
    return []
  }

  close() {
    this.database.close()
  }
}

class FakeStorage {
  constructor() {
    this.sql = new SqlStorageAdapter()
    this.alarm = null
  }

  async setAlarm(timestamp) {
    this.alarm = timestamp
  }

  async deleteAlarm() {
    this.alarm = null
  }
}

class FakeDurableObjectState {
  constructor() {
    this.storage = new FakeStorage()
    this.initialization = Promise.resolve()
  }

  blockConcurrencyWhile(callback) {
    this.initialization = Promise.resolve().then(callback)
    return this.initialization
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  apply(headers) {
    if (this.cookies.size === 0) {
      return
    }

    headers.set(
      'Cookie',
      [...this.cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    )
  }

  store(response) {
    for (const setCookie of response.headers.getSetCookie()) {
      const [nameValue, ...attributes] = setCookie.split(';')
      const separatorIndex = nameValue.indexOf('=')
      const name = nameValue.slice(0, separatorIndex)
      const value = nameValue.slice(separatorIndex + 1)
      const maxAgeAttribute = attributes.find(attribute =>
        attribute
          .trim()
          .toLowerCase()
          .startsWith('max-age='),
      )

      if (maxAgeAttribute && Number(maxAgeAttribute.split('=')[1]) === 0) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  get(name) {
    return this.cookies.get(name) ?? null
  }
}

function createHarness(envOverrides = {}) {
  const env = {
    SESSION_DURATION_SECONDS: '30',
    WAITING_ROOM_REFRESH_SECONDS: '20',
    OFFER_DURATION_SECONDS: '20',
    QUEUE_INACTIVITY_SECONDS: '120',
    WAITING_ROOM_ADMIN_SECRET: 'admin-secret-123',
    WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
    ...envOverrides,
  }
  const state = new FakeDurableObjectState()
  const room = new WaitingRoom(state, env)
  let durableFetchCount = 0
  const originRequests = []

  env.WAITING_ROOM = {
    idFromName(name) {
      return name
    },
    get() {
      return {
        fetch: async (url, init) => {
          durableFetchCount += 1
          await state.initialization
          return room.fetch(new Request(url, init))
        },
      }
    },
  }

  return {
    env,
    room,
    state,
    originRequests,
    get durableFetchCount() {
      return durableFetchCount
    },
    async request(path, jar, now = BASE_TIME_MS) {
      return this.sendRequest('GET', path, jar, now)
    },
    async postRequest(path, jar, now = BASE_TIME_MS, body = 'payload') {
      return this.sendRequest('POST', path, jar, now, body)
    },
    async sendRequest(method, path, jar, now = BASE_TIME_MS, body) {
      const headers = new Headers()
      jar?.apply(headers)
      if (body !== undefined) {
        headers.set('content-type', 'text/plain;charset=UTF-8')
      }

      const response = await withMockedDate(now, () =>
        withMockedFetch(
          async request => {
            const pathname = new URL(request.url).pathname
            originRequests.push(pathname)
            return new Response(`${request.method}:origin:${pathname}`, {
              status: 200,
              headers: { 'content-type': 'text/plain;charset=UTF-8' },
            })
          },
          () =>
            worker.fetch(
              new Request(`https://example.com${path}`, {
                method,
                headers,
                body,
              }),
              env,
            ),
        ),
      )

      jar?.store(response)
      return response
    },
    async adminRequest(method, path, payload, now = BASE_TIME_MS, headersInit = {}) {
      const headers = new Headers(headersInit)
      const init = {
        method,
        headers,
      }
      if (payload !== undefined) {
        headers.set('content-type', 'application/json')
        init.body = JSON.stringify(payload)
      }

      return withMockedDate(now, () =>
        withMockedFetch(
          async request => {
            const pathname = new URL(request.url).pathname
            originRequests.push(pathname)
            return new Response(`origin:${pathname}`, {
              status: 200,
              headers: { 'content-type': 'text/plain;charset=UTF-8' },
            })
          },
          () =>
            worker.fetch(
              new Request(`https://example.com${path}`, init),
              env,
            ),
        ),
      )
    },
    async runAlarm(now) {
      await withMockedDate(now, () => room.alarm())
    },
    close() {
      state.storage.sql.close()
    },
  }
}

test('worker covers admission, queue advancement, claim, timeout recovery, and expiry', async () => {
  const harness = createHarness({
    OBSERVABILITY_LOG_LEVEL: 'debug',
    OBSERVABILITY_SAMPLE_RATE: '1',
  })
  const clientA = new CookieJar()
  const clientB = new CookieJar()
  const clientC = new CookieJar()
  const logs = []

  try {
    await withCapturedLogs(logs, async () => {
      const firstResponse = await harness.request('/sale', clientA, BASE_TIME_MS)
      assert.equal(await firstResponse.text(), 'GET:origin:/sale')
      assert.equal(harness.originRequests[0], '/sale')
      assert.ok(clientA.get(COOKIE_NAME_SESSION))
      assert.equal(clientA.get(COOKIE_NAME_QUEUE), null)
      assertCookieHasSecurityAttributes(
        firstResponse.headers
          .getSetCookie()
          .find(cookie => cookie.startsWith(`${COOKIE_NAME_SESSION}=`)),
      )

      const refreshedResponse = await harness.request(
        '/sale',
        clientA,
        BASE_TIME_MS + 10_000,
      )
      assert.equal(await refreshedResponse.text(), 'GET:origin:/sale')
      const refreshedSessionCookie = clientA.get(COOKIE_NAME_SESSION)
      assert.ok(refreshedSessionCookie)

      const queuedResponseB = await harness.request(
        '/sale',
        clientB,
        BASE_TIME_MS + 20_000,
      )
      assert.match(await queuedResponseB.text(), /Your current position:<\/b> 1/)
      assert.ok(clientB.get(COOKIE_NAME_QUEUE))
      assert.equal(clientB.get(COOKIE_NAME_SESSION), null)

      const queuedResponseC = await harness.request(
        '/sale',
        clientC,
        BASE_TIME_MS + 21_000,
      )
      assert.match(await queuedResponseC.text(), /Your current position:<\/b> 2/)
      assert.ok(clientC.get(COOKIE_NAME_QUEUE))

      await harness.runAlarm(BASE_TIME_MS + 41_000)
      assert.equal(
        harness.room.allRows(`SELECT COUNT(*) AS count FROM sessions`)[0].count,
        0,
      )
      assert.equal(
        harness.room.allRows(`SELECT COUNT(*) AS count FROM offers`)[0].count,
        1,
      )

      await harness.runAlarm(BASE_TIME_MS + 61_000)
      assert.equal(
        harness.room.allRows(`SELECT COUNT(*) AS count FROM offers`)[0].count,
        1,
      )

      const claimedResponseB = await harness.request(
        '/sale',
        clientB,
        BASE_TIME_MS + 62_000,
      )
      assert.equal(await claimedResponseB.text(), 'GET:origin:/sale')
      assert.ok(clientB.get(COOKIE_NAME_SESSION))
      assert.equal(clientB.get(COOKIE_NAME_QUEUE), null)

      const waitingResponseC = await harness.request(
        '/sale',
        clientC,
        BASE_TIME_MS + 63_000,
      )
      assert.match(await waitingResponseC.text(), /Your current position:<\/b> 1/)

      await harness.runAlarm(BASE_TIME_MS + 93_000)
      assert.equal(
        harness.room.allRows(`SELECT COUNT(*) AS count FROM sessions`)[0].count,
        0,
      )

      const admittedResponseC = await harness.request(
        '/sale',
        clientC,
        BASE_TIME_MS + 94_000,
      )
      assert.equal(await admittedResponseC.text(), 'GET:origin:/sale')
      assert.ok(clientC.get(COOKIE_NAME_SESSION))
      assert.equal(clientC.get(COOKIE_NAME_QUEUE), null)
    })

    assert.ok(
      logs.some(
        entry =>
          entry.event === 'admission_granted' &&
          typeof entry.message === 'string' &&
          entry.message.includes('started') &&
          entry.admissionSource === 'immediate' &&
          entry.counters?.admissions === 1 &&
          entry.metrics.activeSessions === 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'session_refreshed' &&
          entry.message.includes('refreshed') &&
          entry.metrics.activeSessions === 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'queue_entered' &&
          entry.message.includes('entered the waiting room queue') &&
          entry.metrics.queueDepth >= 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'offer_issued' &&
          entry.message.includes('received an admission offer') &&
          entry.counters?.offersIssued === 1 &&
          entry.metrics.activeOffers === 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'offers_expired' &&
          entry.message.includes('expired') &&
          entry.counters?.offerExpirations === 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'sessions_expired' &&
          entry.message.includes('capacity was reclaimed') &&
          entry.counters?.sessionExpirations === 1,
      ),
    )
    assert.ok(
      logs.some(
        entry =>
          entry.event === 'admission_granted' &&
          entry.admissionSource === 'offer_claim' &&
          entry.counters?.admissions === 1,
      ),
    )
  } finally {
    harness.close()
  }
})

test('observability defaults suppress debug refresh logs but keep info logs', async () => {
  const harness = createHarness()
  const client = new CookieJar()
  const logs = []

  try {
    await withCapturedLogs(logs, async () => {
      await harness.request('/sale', client, BASE_TIME_MS)
      await harness.request('/sale', client, BASE_TIME_MS + 10_000)
    })

    assert.ok(logs.some(entry => entry.event === 'admission_granted'))
    assert.ok(logs.every(entry => entry.event !== 'session_refreshed'))
  } finally {
    harness.close()
  }
})

test('debug observability bypasses sampling and logs all events', async () => {
  const harness = createHarness({
    OBSERVABILITY_LOG_LEVEL: 'debug',
    OBSERVABILITY_SAMPLE_RATE: '0',
  })
  const clientA = new CookieJar()
  const clientB = new CookieJar()
  const logs = []

  try {
    await withMockedRandom(0.5, async () => {
      await withCapturedLogs(logs, async () => {
        await harness.request('/sale', clientA, BASE_TIME_MS)
        await harness.request('/sale', clientA, BASE_TIME_MS + 10_000)
        await harness.request('/sale', clientB, BASE_TIME_MS + 20_000)
      })
    })

    assert.ok(logs.some(entry => entry.event === 'admission_granted'))
    assert.ok(logs.some(entry => entry.event === 'session_refreshed'))
    assert.ok(logs.some(entry => entry.event === 'queue_entered'))
  } finally {
    harness.close()
  }
})

test('favicon requests bypass the waiting room durable object', async () => {
  const harness = createHarness()

  try {
    const response = await harness.request('/favicon.ico', null, BASE_TIME_MS)
    assert.equal(await response.text(), 'GET:origin:/favicon.ico')
    assert.equal(harness.durableFetchCount, 0)
    assert.equal(response.headers.getSetCookie().length, 0)
  } finally {
    harness.close()
  }
})

test('post requests bypass queueing and do not create sessions', async () => {
  const harness = createHarness()
  const clientA = new CookieJar()
  const clientB = new CookieJar()

  try {
    const admittedResponse = await harness.request('/sale', clientA, BASE_TIME_MS)
    assert.equal(await admittedResponse.text(), 'GET:origin:/sale')

    const queuedResponse = await harness.request(
      '/sale',
      clientB,
      BASE_TIME_MS + 1_000,
    )
    assert.match(await queuedResponse.text(), /Your current position:<\/b> 1/)

    const sessionCountBeforePost =
      harness.room.allRows(`SELECT COUNT(*) AS count FROM sessions`)[0].count
    const queueCountBeforePost =
      harness.room.allRows(`SELECT COUNT(*) AS count FROM queue_entries`)[0].count

    const postResponse = await harness.postRequest(
      '/checkout',
      clientB,
      BASE_TIME_MS + 2_000,
      'order=1',
    )
    assert.equal(await postResponse.text(), 'POST:origin:/checkout')
    assert.equal(clientB.get(COOKIE_NAME_SESSION), null)
    assert.ok(clientB.get(COOKIE_NAME_QUEUE))
    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM sessions`)[0].count,
      sessionCountBeforePost,
    )
    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM queue_entries`)[0].count,
      queueCountBeforePost,
    )
  } finally {
    harness.close()
  }
})

test('post requests refresh an existing valid session without creating a new one', async () => {
  const harness = createHarness()
  const client = new CookieJar()

  try {
    const admittedResponse = await harness.request('/sale', client, BASE_TIME_MS)
    assert.equal(await admittedResponse.text(), 'GET:origin:/sale')
    const sessionRow = harness.room.allRows(
      `SELECT session_id, expires_at FROM sessions`,
    )[0]

    const postResponse = await harness.postRequest(
      '/checkout',
      client,
      BASE_TIME_MS + 10_000,
      'order=1',
    )
    assert.equal(await postResponse.text(), 'POST:origin:/checkout')

    const refreshedSessionRow = harness.room.allRows(
      `SELECT session_id, expires_at FROM sessions`,
    )[0]
    assert.equal(refreshedSessionRow.session_id, sessionRow.session_id)
    assert.equal(refreshedSessionRow.expires_at, BASE_TIME_MS + 40_000)
    assert.ok(client.get(COOKIE_NAME_SESSION))
    assertCookieHasSecurityAttributes(
      postResponse.headers
        .getSetCookie()
        .find(cookie => cookie.startsWith(`${COOKIE_NAME_SESSION}=`)),
    )
  } finally {
    harness.close()
  }
})

test('admin capacity updates apply without redeploy and preserve queue order', async () => {
  const harness = createHarness()
  const clientA = new CookieJar()
  const clientB = new CookieJar()
  const clientC = new CookieJar()
  const adminHeaders = {
    Authorization: 'Bearer admin-secret-123',
  }

  try {
    const admittedResponse = await harness.request('/sale', clientA, BASE_TIME_MS)
    assert.equal(await admittedResponse.text(), 'GET:origin:/sale')

    const queuedResponseB = await harness.request(
      '/sale',
      clientB,
      BASE_TIME_MS + 1_000,
    )
    assert.match(await queuedResponseB.text(), /Your current position:<\/b> 1/)

    const queuedResponseC = await harness.request(
      '/sale',
      clientC,
      BASE_TIME_MS + 2_000,
    )
    assert.match(await queuedResponseC.text(), /Your current position:<\/b> 2/)

    const updateResponse = await harness.adminRequest(
      'POST',
      '/_waiting-room/admin/capacity',
      { totalActiveUsers: 2 },
      BASE_TIME_MS + 3_000,
      adminHeaders,
    )
    assert.equal(updateResponse.status, 200)
    assert.deepEqual(await updateResponse.json(), {
      totalActiveUsers: 2,
      activeSessions: 1,
      queueDepth: 2,
      activeOffers: 1,
      reservedCapacity: 2,
      nextSessionExpiresAt: BASE_TIME_MS + 30_000,
      nextOfferExpiresAt: BASE_TIME_MS + 23_000,
      nextQueueEntryExpiresAt: BASE_TIME_MS + 121_000,
    })

    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM offers`)[0].count,
      1,
    )

    const claimedResponseB = await harness.request(
      '/sale',
      clientB,
      BASE_TIME_MS + 4_000,
    )
    assert.equal(await claimedResponseB.text(), 'GET:origin:/sale')

    const waitingResponseC = await harness.request(
      '/sale',
      clientC,
      BASE_TIME_MS + 5_000,
    )
    assert.match(await waitingResponseC.text(), /Your current position:<\/b> 1/)

    const capacityResponse = await harness.adminRequest(
      'GET',
      '/_waiting-room/admin/capacity',
      undefined,
      BASE_TIME_MS + 6_000,
      adminHeaders,
    )
    assert.equal(capacityResponse.status, 200)
    assert.deepEqual(await capacityResponse.json(), {
      totalActiveUsers: 2,
      activeSessions: 2,
      queueDepth: 1,
      activeOffers: 0,
      reservedCapacity: 2,
      nextSessionExpiresAt: BASE_TIME_MS + 30_000,
      nextOfferExpiresAt: null,
      nextQueueEntryExpiresAt: BASE_TIME_MS + 125_000,
    })
  } finally {
    harness.close()
  }
})

test('new arrivals claim newly issued offers in the same request when spare capacity exists', async () => {
  const harness = createHarness()
  const clientA = new CookieJar()
  const clientB = new CookieJar()
  const clientC = new CookieJar()
  const adminHeaders = {
    Authorization: 'Bearer admin-secret-123',
  }

  try {
    const admittedResponse = await harness.request('/sale', clientA, BASE_TIME_MS)
    assert.equal(await admittedResponse.text(), 'GET:origin:/sale')

    const queuedResponseB = await harness.request(
      '/sale',
      clientB,
      BASE_TIME_MS + 1_000,
    )
    assert.match(await queuedResponseB.text(), /Your current position:<\/b> 1/)

    const updateResponse = await harness.adminRequest(
      'POST',
      '/_waiting-room/admin/capacity',
      { totalActiveUsers: 3 },
      BASE_TIME_MS + 2_000,
      adminHeaders,
    )
    assert.equal(updateResponse.status, 200)

    const admittedResponseC = await harness.request(
      '/sale',
      clientC,
      BASE_TIME_MS + 3_000,
    )
    assert.equal(await admittedResponseC.text(), 'GET:origin:/sale')
    assert.ok(clientC.get(COOKIE_NAME_SESSION))
    assert.equal(clientC.get(COOKIE_NAME_QUEUE), null)

    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM sessions`)[0].count,
      2,
    )
    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM offers`)[0].count,
      1,
    )
    assert.equal(
      harness.room.allRows(`SELECT COUNT(*) AS count FROM queue_entries`)[0].count,
      1,
    )
  } finally {
    harness.close()
  }
})

test('admin page serves html without invoking the durable object', async () => {
  const harness = createHarness()

  try {
    const response = await harness.request('/_waiting-room/admin', null, BASE_TIME_MS)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('content-type'),
      'text/html;charset=UTF-8',
    )
    assert.match(body, /Waiting Room Admin/)
    assert.match(body, /Enter admin/)
    assert.match(body, /Log out/)
    assert.doesNotMatch(body, /<_waiting-room\/admin>|\/_waiting-room\/admin<\/code>/)
    assert.equal(harness.durableFetchCount, 0)
  } finally {
    harness.close()
  }
})

test('admin capacity endpoint rejects unauthorized requests', async () => {
  const harness = createHarness()

  try {
    const response = await harness.adminRequest(
      'POST',
      '/_waiting-room/admin/capacity',
      { totalActiveUsers: 2 },
      BASE_TIME_MS,
    )
    assert.equal(response.status, 401)
  } finally {
    harness.close()
  }
})

test('config validation rejects invalid ranges before handling traffic', () => {
  assert.throws(
    () =>
      getConfig({
        WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
        WAITING_ROOM_REFRESH_SECONDS: '10',
        OFFER_DURATION_SECONDS: '9',
      }),
    /OFFER_DURATION_SECONDS/,
  )

  assert.throws(
    () =>
      getConfig({
        WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
        WAITING_ROOM_REFRESH_SECONDS: '15',
        QUEUE_INACTIVITY_SECONDS: '20',
      }),
    /QUEUE_INACTIVITY_SECONDS/,
  )

  assert.throws(
    () =>
      getConfig({
        WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
        OBSERVABILITY_LOG_LEVEL: 'verbose',
      }),
    /OBSERVABILITY_LOG_LEVEL/,
  )

  assert.throws(
    () =>
      getConfig({
        WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
        OBSERVABILITY_SAMPLE_RATE: '1.5',
      }),
    /OBSERVABILITY_SAMPLE_RATE/,
  )

  assert.throws(
    () =>
      getConfig({
        WAITING_ROOM_COOKIE_SECRET: '12345678901234567890123456789012',
        WAITING_ROOM_ADMIN_SECRET: 'short-secret',
      }),
    /WAITING_ROOM_ADMIN_SECRET/,
  )
})

function assertCookieHasSecurityAttributes(setCookie) {
  assert.ok(setCookie)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /Secure/)
  assert.match(setCookie, /SameSite=Lax/)
}

function startsWithSelect(query) {
  return /^\s*select\b/i.test(query)
}

async function withMockedDate(now, callback) {
  const originalNow = Date.now
  Date.now = () => now
  try {
    return await callback()
  } finally {
    Date.now = originalNow
  }
}

async function withMockedFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch
  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function withCapturedLogs(target, callback) {
  const originalLog = console.log
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string') {
      try {
        target.push(JSON.parse(args[0]))
        return
      } catch {}
    }

    target.push(args)
  }

  try {
    return await callback()
  } finally {
    console.log = originalLog
  }
}

async function withMockedRandom(value, callback) {
  const originalRandom = Math.random
  Math.random = () => value
  try {
    return await callback()
  } finally {
    Math.random = originalRandom
  }
}
