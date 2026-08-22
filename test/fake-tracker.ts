import { createServer } from "node:http";

export type LoginAttempt = { username: string; ok: boolean };
export type ThanksClick = { torrentId: string; authed: boolean };

export type FakeTracker = {
  baseUrl: string;
  logins: LoginAttempt[];
  clicks: ThanksClick[];
  close: () => Promise<void>;
};

const CSRF_TOKEN = "fake-csrf-token";

/** Livewire ships its component payloads HTML-entity encoded in an attribute. */
function attr(value: unknown): string {
  return JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function startFakeTracker({
  validCredentials,
  livewire = 3,
}: {
  validCredentials?: { username: string; password: string };
  /** Which Livewire generation the Engine runs. Both are in production use. */
  livewire?: 2 | 3;
} = {}): Promise<FakeTracker> {
  const creds = validCredentials ?? { username: "user", password: "pw" };
  const sessions = new Set<string>();
  const issuedFormTokens = new Set<string>();
  const thanked = new Set<string>();
  const logins: LoginAttempt[] = [];
  const clicks: ThanksClick[] = [];

  // Livewire 2 keys the component by `fingerprint`, 3 by `memo`; the bookmark
  // button carries the very same wire:click, so only the name tells them apart.
  const component = (name: string, torrentId: string): string =>
    livewire === 3
      ? `wire:snapshot="${attr({
          data: { torrent: [[], { key: Number(torrentId) }] },
          memo: { id: `${name}-id`, name, path: `torrents/${torrentId}`, method: "GET" },
          checksum: "fake-checksum",
        })}"`
      : `wire:initial-data="${attr({
          fingerprint: {
            id: `${name}-id`,
            name,
            locale: "es",
            path: `torrents/${torrentId}`,
            method: "GET",
          },
          effects: { listeners: [] },
          serverMemo: { children: [], errors: [], htmlHash: "fake", data: {}, checksum: "fake" },
        })}"`;

  const torrentPage = (torrentId: string): string => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="csrf-token" content="${CSRF_TOKEN}">
  <title>Torrent ${torrentId}</title>
</head>
<body>
  <h1>Torrent ${torrentId}</h1>
  <button ${component("thank-button", torrentId)} wire:click="store(${torrentId})"${
    thanked.has(torrentId) && livewire === 2 ? " disabled" : ""
  }>Agradecer</button>
  <button ${component("bookmark-button", torrentId)} wire:click="store(${torrentId})">Favorito</button>
  <script>
    window.Livewire = { fake: true };
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.includes('Agradecer'));
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

  // Beyond the CSRF token the login form carries honeypot fields whose names
  // and values change on every render, so a client has to read the form before
  // posting it. Production does exactly this.
  const loginPage = (formToken: string): string => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="csrf-token" content="${CSRF_TOKEN}"><title>Login</title></head>
<body>
  <form method="post" action="/login">
    <input type="hidden" name="_token" value="${formToken}" />
    <input type="hidden" name="_username" value="" />
    <input name="username" />
    <input name="password" type="password" />
    <button type="submit">Iniciar sesión</button>
  </form>
</body>
</html>`;

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
    });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const cookieHeader = req.headers.cookie ?? "";
    const sid = /SID=([^;]+)/.exec(cookieHeader)?.[1];
    const isAuthed = sid ? sessions.has(sid) : false;

    const html = (body: string): void => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (reqUrl.pathname === "/login" && req.method === "GET") {
      const formToken = "form-" + Math.random().toString(36).slice(2);
      issuedFormTokens.add(formToken);
      html(loginPage(formToken));
      return;
    }

    if (reqUrl.pathname === "/login" && req.method === "POST") {
      void readBody(req).then((body) => {
        const params = new URLSearchParams(body);
        const username = params.get("username") ?? "";
        const password = params.get("password") ?? "";
        // The hidden fields must come back exactly as they were served.
        const formOk =
          issuedFormTokens.has(params.get("_token") ?? "") && params.get("_username") === "";
        const ok = formOk && username === creds.username && password === creds.password;
        logins.push({ username, ok });
        if (ok) {
          const newSid = "sid-" + Math.random().toString(36).slice(2);
          sessions.add(newSid);
          res.writeHead(302, { "Set-Cookie": `SID=${newSid}; Path=/; HttpOnly`, Location: "/" });
        } else {
          res.writeHead(302, { Location: "/login" });
        }
        res.end();
      });
      return;
    }

    const torrentMatch = /^\/torrents\/(\d+)$/.exec(reqUrl.pathname);
    if (torrentMatch && req.method === "GET") {
      if (!isAuthed) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      html(torrentPage(torrentMatch[1]!));
      return;
    }

    const isLivewire =
      (reqUrl.pathname === "/livewire/update" ||
        reqUrl.pathname === "/livewire/message/thank-button") &&
      req.method === "POST";

    if (isLivewire) {
      void readBody(req).then((body) => {
        const payload = JSON.parse(body) as {
          torrentId?: number; // the browser engine's own click handler
          fingerprint?: { name?: string };
          updates?: { payload?: { params?: number[] } }[];
          components?: { snapshot?: string; calls?: { params?: number[] }[] }[];
        };

        let torrentId: string;
        let component = "thank-button";
        if (payload.components) {
          const snapshot = JSON.parse(payload.components[0]?.snapshot ?? "{}") as {
            memo?: { name?: string };
          };
          component = snapshot.memo?.name ?? "";
          torrentId = String(payload.components[0]?.calls?.[0]?.params?.[0]);
        } else if (payload.fingerprint) {
          component = payload.fingerprint.name ?? "";
          torrentId = String(payload.updates?.[0]?.payload?.params?.[0]);
        } else {
          torrentId = String(payload.torrentId);
        }

        // A real Site answers 200 whatever happens; the outcome is dispatched.
        const dispatch = (name: string, message: string): unknown =>
          livewire === 3
            ? { components: [{ effects: { dispatches: [{ name, params: { message } }] } }] }
            : { effects: { dispatches: [{ event: name, data: { message } }] } };

        res.writeHead(200, { "Content-Type": "application/json" });
        if (component !== "thank-button") {
          res.end(JSON.stringify(dispatch("error", "Wrong component!")));
          return;
        }
        if (thanked.has(torrentId)) {
          res.end(JSON.stringify(dispatch("error", "You have already thanked!")));
          return;
        }
        thanked.add(torrentId);
        clicks.push({ torrentId, authed: isAuthed });
        res.end(JSON.stringify(dispatch("success", "¡Gracias!")));
      });
      return;
    }

    if (reqUrl.pathname === "/" && req.method === "GET") {
      html("<!DOCTYPE html><html><body>home</body></html>");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        logins,
        clicks,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
