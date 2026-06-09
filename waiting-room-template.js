export function renderWaitingRoomHtml(admission) {
  const positionMarkup =
    typeof admission.position === 'number'
      ? `<p><b>Your current position:</b> ${admission.position}</p>`
      : ''

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="${admission.refreshSeconds}" />
    <title>Waiting Room</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{line-height:1.4;font-size:1rem;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:2rem;display:grid;place-items:center;min-height:100vh;background:linear-gradient(180deg,#fff9f2 0%,#f4efe8 100%);color:#1f2933}.container{width:100%;max-width:800px;background:#fff;border:1px solid #e6ded4;border-radius:24px;padding:2rem 2.25rem;box-shadow:0 18px 50px rgba(15,23,42,.08)}h1{font-size:clamp(2rem,4vw,3.5rem);line-height:1.05;margin-bottom:1rem}p{margin-top:.75rem;font-size:1.05rem}.eyebrow{display:inline-block;text-transform:uppercase;letter-spacing:.08em;font-size:.85rem;color:#9a3412;margin-bottom:1rem}</style>
  </head>
  <body>
    <main class="container">
      <div class="eyebrow">Traffic Control</div>
      <h1>You are now in line.</h1>
      <p>We are experiencing a high volume of traffic. Keep this tab open and we will admit you as soon as capacity is available.</p>
      <p><b>This page refreshes automatically every ${admission.refreshSeconds} seconds.</b></p>
      ${positionMarkup}
    </main>
  </body>
</html>`
}
