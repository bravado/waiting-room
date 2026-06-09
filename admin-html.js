function formatTimestamp(date) {
  if (!date) {
    return 'n/a'
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(date))
}

export function renderAdminHtml({ adminCapacityPath }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Waiting Room Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: rgba(255, 255, 255, 0.9);
        --border: #d8c5a4;
        --text: #1f2937;
        --muted: #5b6472;
        --accent: #9a3412;
        --accent-strong: #7c2d12;
        --ok: #166534;
        --error: #b91c1c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        background:
          radial-gradient(circle at top left, #fff8e8 0%, transparent 35%),
          linear-gradient(160deg, #f3eadc 0%, #efe6d7 45%, #e4d4bb 100%);
        color: var(--text);
      }
      main {
        width: min(920px, calc(100vw - 2rem));
        margin: 2rem auto;
        padding: 1.5rem;
        border: 1px solid var(--border);
        border-radius: 28px;
        background: var(--panel);
        box-shadow: 0 18px 48px rgba(60, 34, 12, 0.12);
        backdrop-filter: blur(8px);
      }
      h1 {
        margin: 0;
        font-size: 1.1rem;
        line-height: 1.1;
      }
      p {
        color: var(--muted);
      }
      .navbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding-bottom: 1rem;
        margin-bottom: 1.5rem;
        border-bottom: 1px solid rgba(216, 197, 164, 0.8);
      }
      .panel-stack {
        display: grid;
        gap: 1.5rem;
      }
      .hidden {
        display: none !important;
      }
      .grid {
        display: grid;
        gap: 1rem;
        margin-top: 1.5rem;
      }
      @media (min-width: 760px) {
        .grid {
          grid-template-columns: 1.1fr 0.9fr;
        }
      }
      .card {
        padding: 1.25rem;
        border-radius: 22px;
        border: 1px solid rgba(216, 197, 164, 0.8);
        background: rgba(255, 251, 245, 0.85);
      }
      h2 {
        margin: 0 0 1rem;
        font-size: 1.25rem;
      }
      form {
        display: grid;
        gap: 0.85rem;
      }
      label {
        display: grid;
        gap: 0.35rem;
        font-size: 0.95rem;
        color: var(--muted);
      }
      input {
        width: 100%;
        padding: 0.85rem 0.95rem;
        border: 1px solid #ccb58d;
        border-radius: 14px;
        font: inherit;
        color: var(--text);
        background: #fffdf9;
      }
      .actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        margin-bottom: 1rem;
      }
      .topbar p {
        margin: 0;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 0.8rem 1.2rem;
        font: inherit;
        cursor: pointer;
        background: var(--accent);
        color: white;
      }
      button.secondary {
        background: #ead9bd;
        color: #4b3821;
      }
      .status {
        min-height: 1.5rem;
        font-size: 0.95rem;
      }
      .status.ok {
        color: var(--ok);
      }
      .status.error {
        color: var(--error);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.85rem;
      }
      .stat {
        padding: 0.95rem;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.9);
        border: 1px solid rgba(216, 197, 164, 0.8);
      }
      .stat span {
        display: block;
        color: var(--muted);
        font-size: 0.88rem;
      }
      .stat strong {
        display: block;
        margin-top: 0.35rem;
        font-size: 1.8rem;
      }
      .meta {
        display: grid;
        gap: 0.65rem;
        margin-top: 1rem;
      }
      .meta-row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        padding-bottom: 0.55rem;
        border-bottom: 1px dashed rgba(204, 181, 141, 0.9);
        font-size: 0.95rem;
      }
      .meta-row span {
        color: var(--muted);
      }
      .meta-row strong {
        text-align: right;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="navbar">
        <h1>Waiting Room Admin</h1>
        <button type="button" class="secondary hidden" id="logout">Log out</button>
      </section>

      <section class="panel-stack">
        <article class="card" id="login-panel">
          <h2>Login</h2>
          <form id="credentials-form">
            <label>
              Admin secret
              <input id="admin-secret" name="adminSecret" type="password" autocomplete="current-password" required />
            </label>
            <div class="actions">
              <button type="submit">Enter admin</button>
            </div>
          </form>
          <p id="login-status" class="status"></p>
        </article>

        <section id="dashboard-panel" class="hidden">
          <div class="topbar">
            <p>Use this page to read live waiting room stats and update runtime capacity without a deploy.</p>
          </div>

          <section class="grid">
            <article class="card">
              <h2>Update Capacity</h2>
              <form id="capacity-form">
                <label>
                  Total active users
                  <input id="total-active-users" name="totalActiveUsers" type="number" min="0" step="1" required />
                </label>
                <div class="actions">
                  <button type="submit">Save capacity</button>
                  <button type="button" class="secondary" id="refresh-stats">Refresh</button>
                </div>
              </form>

              <p id="dashboard-status" class="status"></p>
            </article>

            <article class="card">
              <h2>Live Stats</h2>
              <div class="stats">
                <div class="stat"><span>Capacity</span><strong id="stat-capacity">-</strong></div>
                <div class="stat"><span>Reserved</span><strong id="stat-reserved">-</strong></div>
                <div class="stat"><span>Active Sessions</span><strong id="stat-sessions">-</strong></div>
                <div class="stat"><span>Active Offers</span><strong id="stat-offers">-</strong></div>
                <div class="stat"><span>Queue Depth</span><strong id="stat-queue">-</strong></div>
                <div class="stat"><span>Available Slots</span><strong id="stat-available">-</strong></div>
              </div>

              <div class="meta">
                <div class="meta-row"><span>Next session expiry</span><strong id="meta-session-expiry">-</strong></div>
                <div class="meta-row"><span>Next offer expiry</span><strong id="meta-offer-expiry">-</strong></div>
                <div class="meta-row"><span>Next queue expiry</span><strong id="meta-queue-expiry">-</strong></div>
                <div class="meta-row"><span>Last updated</span><strong id="meta-last-updated">-</strong></div>
              </div>
            </article>
          </section>
        </section>
      </section>
    </main>

    <script>
      const adminCapacityPath = ${JSON.stringify(adminCapacityPath)}
      const loginPanel = document.getElementById('login-panel')
      const dashboardPanel = document.getElementById('dashboard-panel')
      const loginStatusElement = document.getElementById('login-status')
      const dashboardStatusElement = document.getElementById('dashboard-status')
      const logoutButton = document.getElementById('logout')
      const secretInput = document.getElementById('admin-secret')
      const totalActiveUsersInput = document.getElementById('total-active-users')
      const storageKey = 'waiting-room-admin-secret'

      function setStatus(element, message, tone) {
        element.textContent = message
        element.className = 'status' + (tone ? ' ' + tone : '')
      }

      function getStoredSecret() {
        return window.sessionStorage.getItem(storageKey) || ''
      }

      function storeSecret(secret) {
        window.sessionStorage.setItem(storageKey, secret)
      }

      function clearSecret() {
        window.sessionStorage.removeItem(storageKey)
      }

      function showLogin(message, tone) {
        loginPanel.classList.remove('hidden')
        dashboardPanel.classList.add('hidden')
        logoutButton.classList.add('hidden')
        secretInput.value = ''
        setStatus(loginStatusElement, message || '', tone || '')
        setStatus(dashboardStatusElement, '', '')
      }

      function showDashboard(message, tone) {
        loginPanel.classList.add('hidden')
        dashboardPanel.classList.remove('hidden')
        logoutButton.classList.remove('hidden')
        setStatus(loginStatusElement, '', '')
        setStatus(dashboardStatusElement, message || '', tone || '')
      }

      function getAuthorizationHeader() {
        const secret = getStoredSecret()
        if (!secret) {
          throw new Error('Enter the admin secret first.')
        }
        return 'Bearer ' + secret
      }

      function updateStats(stats) {
        document.getElementById('stat-capacity').textContent = String(stats.totalActiveUsers)
        document.getElementById('stat-reserved').textContent = String(stats.reservedCapacity)
        document.getElementById('stat-sessions').textContent = String(stats.activeSessions)
        document.getElementById('stat-offers').textContent = String(stats.activeOffers)
        document.getElementById('stat-queue').textContent = String(stats.queueDepth)
        document.getElementById('stat-available').textContent = String(Math.max(stats.totalActiveUsers - stats.reservedCapacity, 0))
        document.getElementById('meta-session-expiry').textContent = ${formatTimestamp.toString()}(stats.nextSessionExpiresAt)
        document.getElementById('meta-offer-expiry').textContent = ${formatTimestamp.toString()}(stats.nextOfferExpiresAt)
        document.getElementById('meta-queue-expiry').textContent = ${formatTimestamp.toString()}(stats.nextQueueEntryExpiresAt)
        document.getElementById('meta-last-updated').textContent = ${formatTimestamp.toString()}(Date.now())
        totalActiveUsersInput.value = String(stats.totalActiveUsers)
      }

      async function loadStats() {
        const response = await fetch(adminCapacityPath, {
          headers: {
            Authorization: getAuthorizationHeader(),
          },
        })

        if (!response.ok) {
          throw new Error(await response.text() || 'Failed to load stats.')
        }

        const stats = await response.json()
        updateStats(stats)
        showDashboard('Stats loaded.', 'ok')
      }

      document.getElementById('credentials-form').addEventListener('submit', async event => {
        event.preventDefault()
        const secret = secretInput.value.trim()
        if (!secret) {
          setStatus(loginStatusElement, 'Enter the admin secret first.', 'error')
          return
        }

        storeSecret(secret)
        setStatus(loginStatusElement, 'Loading stats...', '')
        try {
          await loadStats()
        } catch (error) {
          clearSecret()
          showLogin(error.message, 'error')
        }
      })

      document.getElementById('refresh-stats').addEventListener('click', async () => {
        setStatus(dashboardStatusElement, 'Refreshing stats...', '')
        try {
          await loadStats()
        } catch (error) {
          if (/Unauthorized/i.test(error.message)) {
            clearSecret()
            showLogin('Session expired. Enter the admin secret again.', 'error')
            return
          }
          setStatus(dashboardStatusElement, error.message, 'error')
        }
      })

      document.getElementById('capacity-form').addEventListener('submit', async event => {
        event.preventDefault()
        setStatus(dashboardStatusElement, 'Saving capacity...', '')

        try {
          const response = await fetch(adminCapacityPath, {
            method: 'POST',
            headers: {
              Authorization: getAuthorizationHeader(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              totalActiveUsers: Number(totalActiveUsersInput.value),
            }),
          })

          if (!response.ok) {
            throw new Error(await response.text() || 'Failed to update capacity.')
          }

          const stats = await response.json()
          updateStats(stats)
          setStatus(dashboardStatusElement, 'Capacity updated.', 'ok')
        } catch (error) {
          if (/Unauthorized/i.test(error.message)) {
            clearSecret()
            showLogin('Session expired. Enter the admin secret again.', 'error')
            return
          }
          setStatus(dashboardStatusElement, error.message, 'error')
        }
      })

      logoutButton.addEventListener('click', () => {
        clearSecret()
        showLogin('Logged out.', 'ok')
      })

      if (getStoredSecret()) {
        showDashboard('Restoring session...', '')
        loadStats().catch(error => {
          clearSecret()
          showLogin(error.message, 'error')
        })
      } else {
        showLogin('', '')
      }
    </script>
  </body>
</html>`
}
