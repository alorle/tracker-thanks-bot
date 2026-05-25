import { createServer } from "node:http";

export type LoginAttempt = { username: string; ok: boolean };
export type ThanksClick = { torrentId: string; authed: boolean };

export type FakeTracker = {
  baseUrl: string;
  logins: LoginAttempt[];
  clicks: ThanksClick[];
  close: () => Promise<void>;
};

export function startFakeTracker({
  validCredentials,
}: { validCredentials?: { username: string; password: string } } = {}): Promise<FakeTracker> {
  const creds = validCredentials ?? { username: "user", password: "pw" };
  const sessions = new Set<string>();
  const logins: LoginAttempt[] = [];
  const clicks: ThanksClick[] = [];

  const torrentPage = (torrentId: string): string => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Torrent ${torrentId}</title></head>
<body>
  <h1>Torrent ${torrentId}</h1>
  <button wire:click="store(${torrentId})">Agradecer</button>
  <script>
    window.Livewire = { fake: true };
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.getAttribute('wire:click') === 'store(${torrentId})');
    btn.addEventListener('click', () => {
      fetch('/livewire/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torrentId: ${torrentId} }),
      }).then(() => { btn.disabled = true; });
    });
  </script>
</body>
</html>`;

  const loginPage = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Login</title></head>
<body>
  <form method="post" action="/login">
    <input name="username" />
    <input name="password" type="password" />
    <button type="submit">Iniciar sesión</button>
  </form>
</body>
</html>`;

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const cookieHeader = req.headers.cookie ?? "";
    const sid = cookieHeader.match(/SID=([^;]+)/)?.[1];
    const isAuthed = sid ? sessions.has(sid) : false;

    if (reqUrl.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPage);
      return;
    }

    if (reqUrl.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const username = params.get("username") ?? "";
        const password = params.get("password") ?? "";
        const ok = username === creds.username && password === creds.password;
        logins.push({ username, ok });
        if (ok) {
          const newSid = "sid-" + Math.random().toString(36).slice(2);
          sessions.add(newSid);
          res.writeHead(302, {
            "Set-Cookie": `SID=${newSid}; Path=/; HttpOnly`,
            Location: "/",
          });
          res.end();
        } else {
          res.writeHead(302, { Location: "/login" });
          res.end();
        }
      });
      return;
    }

    const torrentMatch = reqUrl.pathname.match(/^\/torrents\/(\d+)$/);
    if (torrentMatch && req.method === "GET") {
      if (!isAuthed) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      const torrentId = torrentMatch[1]!;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(torrentPage(torrentId));
      return;
    }

    if (reqUrl.pathname === "/livewire/update" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body) as { torrentId: unknown };
          clicks.push({ torrentId: String(data.torrentId), authed: isAuthed });
        } catch {
          // ignore
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (reqUrl.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body>home</body></html>");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        logins,
        clicks,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
