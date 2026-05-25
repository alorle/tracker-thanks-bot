# Security Policy

## Reporting a Vulnerability

If you find a security issue, please **do not open a public issue**. Instead,
use GitHub's private vulnerability reporting:

1. Go to the [Security tab](../../security/advisories/new) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, ideally with reproduction steps and impact.

You can expect an initial reply within a few days. This is a small,
personally-maintained project — there is no SLA, but reasonable effort will
be made to triage and patch issues promptly.

## Scope

In-scope:
- Bugs in the webhook server, scanner, or qBittorrent client that allow
  unauthenticated actions, credential leaks, or remote code execution.
- Cryptographic weaknesses in the shared-secret check.
- Supply-chain concerns in the published Docker image.

Out of scope:
- The bot performing actions on third-party tracker sites — those are
  driven by user-provided credentials and explicit configuration.
- Issues that require an attacker to already control the host or the
  qBittorrent instance.
