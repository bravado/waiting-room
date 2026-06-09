import { renderAdminHtml } from './admin-html.js'

const ADMIN_AUTH_SCHEME = 'Bearer'

export const ADMIN_PAGE_PATH = '/_waiting-room/admin'
export const ADMIN_CAPACITY_PATH = `${ADMIN_PAGE_PATH}/capacity`

export function isAdminRequestPath(pathname) {
  return pathname === ADMIN_PAGE_PATH || pathname === ADMIN_CAPACITY_PATH
}

export async function handleAdminRequest(request, env, deps) {
  const pathname = new URL(request.url).pathname

  if (pathname === ADMIN_PAGE_PATH) {
    return handleAdminPageRequest(request, deps)
  }

  if (pathname === ADMIN_CAPACITY_PATH) {
    return handleCapacityAdminRequest(request, env, deps)
  }

  return new Response('Not Found', { status: 404 })
}

function handleAdminPageRequest(request, deps) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'GET',
      },
    })
  }

  const response = new Response(
    renderAdminHtml({
      adminCapacityPath: ADMIN_CAPACITY_PATH,
    }),
    {
      headers: {
        'content-type': 'text/html;charset=UTF-8',
      },
    },
  )
  deps.applyNoStoreHeaders(response)
  return response
}

async function handleCapacityAdminRequest(request, env, deps) {
  if (!isAuthorizedAdminRequest(request, env, deps)) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (request.method === 'GET') {
    return callWaitingRoomAdmin(env, request.method)
  }

  if (request.method === 'POST') {
    let payload
    try {
      payload = await request.json()
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    try {
      deps.parseIntegerSetting(payload?.totalActiveUsers, null, {
        name: 'totalActiveUsers',
        min: 0,
        integerOnly: true,
      })
    } catch (error) {
      return new Response(error.message, { status: 400 })
    }

    return callWaitingRoomAdmin(env, request.method, payload)
  }

  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      Allow: 'GET, POST',
    },
  })
}

function isAuthorizedAdminRequest(request, env, deps) {
  const { adminSecret } = deps.getConfig(env)
  if (!adminSecret) {
    return false
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization) {
    return false
  }

  const [scheme, token] = authorization.split(/\s+/, 2)
  if (scheme !== ADMIN_AUTH_SCHEME || !token) {
    return false
  }

  return deps.timingSafeEqual(token, adminSecret)
}

async function callWaitingRoomAdmin(env, method, payload = null) {
  const id = env.WAITING_ROOM.idFromName('global')
  const stub = env.WAITING_ROOM.get(id)
  const init = { method }
  if (payload !== null) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(payload)
  }

  const response = await stub.fetch(
    `https://waiting-room.internal${ADMIN_CAPACITY_PATH}`,
    init,
  )
  if (!response.ok) {
    throw new Error(`Durable Object returned ${response.status}`)
  }
  return response
}
