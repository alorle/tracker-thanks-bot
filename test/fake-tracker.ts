import { createServer } from "node:http";

export type LoginAttempt = { username: string; ok: boolean };
export type ThanksClick = { torrentId: string; authed: boolean; at: number };
export type TrackerRequest = { method: string; path: string };

export type FakeTracker = {
  baseUrl: string;
  logins: LoginAttempt[];
  clicks: ThanksClick[];
  requests: TrackerRequest[];
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
  rejects = [],
  refusal = "No puedes agradecer este torrent.",
  withoutButton = [],
  answer,
  redirects = 0,
  forgetsSessions = false,
  withoutCsrfToken = false,
}: {
  validCredentials?: { username: string; password: string };
  /** Which Livewire generation the Engine runs. Both are in production use. */
  livewire?: 2 | 3;
  /** Torrents the Site turns down even though it renders the button enabled. */
  rejects?: string[];
  refusal?: string;
  withoutButton?: string[];
  answer?: { status: number; headers?: Record<string, string>; body: string };
  redirects?: number;
  forgetsSessions?: boolean;
  withoutCsrfToken?: boolean;
} = {}): Promise<FakeTracker> {
  const creds = validCredentials ?? { username: "user", password: "pw" };
  const refused = new Set(rejects);
  const sessions = new Set<string>();
  const issuedFormTokens = new Set<string>();
  const thanked = new Set<string>();
  const logins: LoginAttempt[] = [];
  const clicks: ThanksClick[] = [];
  const requests: TrackerRequest[] = [];
  // Livewire signs its component payloads and refuses one that came back
  // altered, so the fake only honours the exact payloads it served.
  const servedPayloads = new Set<string>();

  // Livewire 2 keys the component by `fingerprint`, 3 by `memo`; the bookmark
  // button carries the very same wire:click, so only the name tells them apart.
  // The query string in `path` is what puts an HTML entity inside the payload.
  const component = (name: string, torrentId: string): string => {
    if (livewire === 3) {
      const snapshot = {
        data: { torrent: [[], { key: Number(torrentId) }] },
        memo: {
          id: `${name}-id`,
          name,
          path: `torrents/${torrentId}?from=list&ref=rss`,
          method: "GET",
        },
        checksum: "fake-checksum",
      };
      servedPayloads.add(JSON.stringify(snapshot));
      return `wire:snapshot="${attr(snapshot)}"`;
    }
    const initialData = {
      fingerprint: {
        id: `${name}-id`,
        name,
        locale: "es",
        path: `torrents/${torrentId}?from=list&ref=rss`,
        method: "GET",
      },
      effects: { listeners: [] },
      serverMemo: {
        children: [],
        errors: [],
        htmlHash: "fake&hash",
        data: {},
        checksum: "fake",
      },
    };
    servedPayloads.add(JSON.stringify(initialData.serverMemo));
    return `wire:initial-data="${attr(initialData)}"`;
  };

  // The bookmark button is rendered first on purpose: it carries the very same
  // wire:click, so a client that just takes the first match thanks nothing. It
  // is also rendered disabled, so reading the wrong tag's attributes shows up.
  const torrentPage = (torrentId: string): string => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  ${withoutCsrfToken ? "" : `<meta name="csrf-token" content="${CSRF_TOKEN}">`}
  <title>Torrent ${torrentId}</title>
</head>
<body>
  <h1>Torrent ${torrentId}</h1>
  <button ${component("bookmark-button", torrentId)} wire:click="store(${torrentId})" disabled>Favorito</button>
  ${
    withoutButton.includes(torrentId)
      ? ""
      : `<button ${component("thank-button", torrentId)} wire:click="store(${torrentId})"${
          thanked.has(torrentId) && livewire === 2 ? " disabled" : ""
        }>Agradecer</button>`
  }
</body>
</html>`;

  // Beyond the CSRF token the login form carries honeypot fields whose names
  // and values change on every render, so a client has to read the form before
  // posting it. Production does exactly this.
  const loginFields = ["_token", "_username", "username", "password"];
  const loginPage = (formToken: string, origin: string): string => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="csrf-token" content="${CSRF_TOKEN}"><title>Login</title></head>
<body>
  <form method="get" action="${origin}/search"><input name="q" value="torrent" /></form>
  <form method="post" action="${origin}/login">
    <input type="hidden" name="_token" value="${formToken}" />
    <input type="hidden" name="_username" />
    <input name="username" />
    <input name="password" type="password" />
    <input type="submit" value="Iniciar sesión" />
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
    requests.push({ method: req.method ?? "", path: reqUrl.pathname });
    const cookies = new Map(
      (req.headers.cookie ?? "").split("; ").map((pair) => {
        const separator = pair.indexOf("=");
        return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
      }),
    );
    const sid = cookies.get("SID");
    const isAuthed = sid ? sessions.has(sid) : false;

    const html = (body: string): void => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (reqUrl.pathname === "/login" && req.method === "GET") {
      const formToken = "form-" + Math.random().toString(36).slice(2);
      issuedFormTokens.add(formToken);
      html(loginPage(formToken, `http://${req.headers.host}`));
      return;
    }

    if (reqUrl.pathname === "/login" && req.method === "POST") {
      void readBody(req).then((body) => {
        const isForm = (req.headers["content-type"] ?? "").startsWith(
          "application/x-www-form-urlencoded",
        );
        const params = new URLSearchParams(isForm ? body : "");
        const username = params.get("username") ?? "";
        const password = params.get("password") ?? "";
        // The hidden fields must come back exactly as they were served.
        const formOk =
          issuedFormTokens.has(params.get("_token") ?? "") &&
          params.get("_username") === "" &&
          [...params.keys()].every((name) => loginFields.includes(name));
        const ok = formOk && username === creds.username && password === creds.password;
        logins.push({ username, ok });
        if (ok) {
          const newSid = "sid-" + Math.random().toString(36).slice(2);
          if (!forgetsSessions) sessions.add(newSid);
          // The stray nameless cookie is real-world noise a jar must drop.
          res.writeHead(302, {
            "Set-Cookie": [
              `SID=${newSid}; Path=/; HttpOnly`,
              "XSRF-TOKEN=fake-xsrf; Path=/",
              "=orphan; Path=/",
            ],
            Location: "/",
          });
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
      const hop = Number(reqUrl.searchParams.get("hop") ?? 0);
      if (hop < redirects) {
        res.writeHead(302, { Location: `${reqUrl.pathname}?hop=${hop + 1}` });
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
      // Laravel rejects a Livewire call that arrives without the page's token.
      if (
        req.headers["x-csrf-token"] !== CSRF_TOKEN ||
        req.headers["x-livewire"] !== "true" ||
        req.headers["content-type"] !== "application/json"
      ) {
        res.writeHead(419, { "Content-Type": "text/plain" });
        res.end("Page Expired");
        return;
      }
      void readBody(req).then((body) => {
        if (answer) {
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body);
          return;
        }
        const payload = JSON.parse(body) as {
          fingerprint?: { name?: string };
          serverMemo?: unknown;
          updates?: { type?: string; payload?: { method?: string; params?: number[] } }[];
          components?: {
            snapshot?: string;
            calls?: { method?: string; params?: number[] }[];
          }[];
        };

        let torrentId = "";
        let component = "thank-button";
        let method = "";
        let signed = true;
        if (payload.components) {
          const raw = payload.components[0]?.snapshot ?? "{}";
          const snapshot = JSON.parse(raw) as { memo?: { name?: string } };
          component = snapshot.memo?.name ?? "";
          method = payload.components[0]?.calls?.[0]?.method ?? "";
          torrentId = String(payload.components[0]?.calls?.[0]?.params?.[0]);
          signed = servedPayloads.has(raw);
        } else if (payload.fingerprint) {
          const update = payload.updates?.[0];
          component = payload.fingerprint.name ?? "";
          method = update?.type === "callMethod" ? (update.payload?.method ?? "") : "";
          torrentId = String(update?.payload?.params?.[0]);
          signed = servedPayloads.has(JSON.stringify(payload.serverMemo));
        }

        if (method !== "store") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Unable to call component method");
          return;
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
        if (!signed) {
          res.end(JSON.stringify(dispatch("error", "Component payload was altered!")));
          return;
        }
        if (refused.has(torrentId)) {
          res.end(JSON.stringify(dispatch("error", refusal)));
          return;
        }
        if (thanked.has(torrentId)) {
          res.end(JSON.stringify(dispatch("error", "You have already thanked!")));
          return;
        }
        thanked.add(torrentId);
        clicks.push({ torrentId, authed: isAuthed, at: Date.now() });
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
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
