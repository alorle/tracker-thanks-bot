# tracker-thanks-bot

A self-hosted bot that automatically clicks the "thanks" button on private
torrent trackers after a torrent is grabbed by Radarr/Sonarr.

## Language

**Site**:
A private tracker installation that the **Operator** has an account on, identified
by a single operator-chosen `id` (a stable slug used as cache directory name,
metrics label, log prefix, and credential env var prefix).
_Avoid_: tracker (ambiguous — see below), instance, host

**Tracker**:
The general category of website the bot interacts with. Used in product copy
("private trackers") but never as a code identifier — prefer **Site** in code,
schemas, and logs.

**Engine**:
The family of tracker software a **Site** runs on (today: Livewire-based with
Spanish "Agradecer" copy). Engine assumptions are baked into the code; they
identify a *family*, not any single Site, so they do not leak which Sites the
Operator uses.

**Operator**:
The single person who deploys and configures their own instance of the bot.
The bot is single-tenant — there is no notion of multiple end-users sharing
one deployment.

**Thanks**:
The action of clicking the per-torrent "Agradecer" button on a Site. Always
performed for a specific torrent on a specific Site.
_Avoid_: like, upvote, ack

## Flagged ambiguities

- **"Site identifier"**: historically there were three names per Site (map key,
  envPrefix, name). Consolidated to a single `id` field — if you see code or
  docs still referring to `envPrefix` or `name`, treat it as legacy.

## Example dialogue

> **Dev**: When a Radarr Grab webhook comes in, how do we know which Site to
> thank on?
>
> **Operator**: The torrent's comment in qBittorrent contains the Site's URL
> and a torrent ID. We match the URL against each configured Site's `base_url`
> and use that Site's `id` to look up credentials and route to the per-Site
> browser context.
>
> **Dev**: So the Engine isn't part of the routing decision?
>
> **Operator**: Right. Every Site I run uses the same Engine, so the Thanks
> flow is hardcoded against it. The Site config only carries what differs
> between installs of that Engine.
