import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeTorrent = { name: string; comment: string };

export type FakeQBittorrent = {
  baseUrl: string;
  torrents: Map<string, FakeTorrent>;
  requests: string[];
  close: () => Promise<void>;
};

export function startFakeQBittorrent({
  torrents,
  forbidden,
  apiKey,
  emptyCommentAttempts = 0,
  loginStatus = 200,
  withoutSid = false,
}: {
  torrents?: Map<string, FakeTorrent>;
  /** Reject data requests with 403: "once" recovers after a re-login, "always" never does. */
  forbidden?: "always" | "once";
  /** When set, the only accepted credential is this key as a Bearer token. */
  apiKey?: string;
  /** Serve an empty comment this many times first, as qBittorrent does while it still lacks the metadata. */
  emptyCommentAttempts?: number;
  loginStatus?: number;
  withoutSid?: boolean;
} = {}): Promise<FakeQBittorrent> {
  // torrents: Map<hash, { name, comment }>
  const store = torrents ?? new Map<string, FakeTorrent>();
  const requests: string[] = [];
  const commentReads = new Map<string, number>();
  let forbidNext = forbidden !== undefined;

  // qBittorrent authenticates every data request, so the fake does too: without
  // this the client could send no credential at all and still be served.
  const isAuthed = (req: IncomingMessage): boolean =>
    apiKey === undefined
      ? /(?:^|;\s*)SID=fakesid(?:;|$)/.test(req.headers.cookie ?? "")
      : req.headers.authorization === `Bearer ${apiKey}`;

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(reqUrl.pathname);

    if (reqUrl.pathname === "/api/v2/auth/login" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const accepted =
        req.headers["content-type"] === "application/x-www-form-urlencoded" &&
        form.get("username") === "qbit-user" &&
        form.get("password") === "qbit-pw";
      if (loginStatus !== 200) {
        res.writeHead(loginStatus, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain",
        ...(accepted && !withoutSid && { "Set-Cookie": "SID=fakesid; Path=/; HttpOnly" }),
      });
      res.end(accepted ? "Ok." : "Fails.");
      return;
    }

    if (forbidNext || !isAuthed(req)) {
      if (forbidden === "once") forbidNext = false;
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (reqUrl.pathname === "/api/v2/torrents/properties" && req.method === "GET") {
      // Hashes are matched exactly: qBittorrent's own API is case sensitive, so
      // a client that forwards Radarr's uppercase downloadId finds nothing.
      const hash = reqUrl.searchParams.get("hash") ?? "";
      const torrent = store.get(hash);
      if (!torrent) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("no such torrent");
        return;
      }
      const read = (commentReads.get(hash) ?? 0) + 1;
      commentReads.set(hash, read);
      const comment = read <= emptyCommentAttempts ? "" : torrent.comment;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ comment }));
      return;
    }

    if (reqUrl.pathname === "/api/v2/torrents/info" && req.method === "GET") {
      const list = [...store.entries()].map(([hash, t]) => ({ hash, name: t.name }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };

  const server = createServer((req, res) => void respond(req, res));

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        torrents: store,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
