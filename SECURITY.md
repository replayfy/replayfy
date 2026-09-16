# Security Policy

We take the security of Replayfy seriously — session replay handles sensitive
user data, so we appreciate careful, responsible disclosure.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, pull
requests, or discussions.**

Instead, email **security@replayfy.app** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected version / commit and deployment type (self-hosted or hosted),
- any suggested remediation.

We will acknowledge your report within **3 business days**, keep you updated as
we investigate, and let you know when a fix ships. Please give us a reasonable
window to remediate before any public disclosure. We're happy to credit you in
the release notes unless you'd prefer to remain anonymous.

## Scope

In scope: the code in this repository (`server/`, `dashboard/`) and the default
`docker-compose.yml` deployment. Out of scope: issues that require a
non-default, insecure configuration you introduced (e.g. exposing a datastore
to the internet with default credentials), and denial of service from
unrealistic load.

## Hardening your deployment

Before exposing a self-hosted instance:

- Set a strong, unique `JWT_SECRET` (`openssl rand -hex 32`).
- Change every default credential in `.env` (Postgres, MinIO, etc.).
- Set `CORS_ORIGINS` to your exact dashboard origin(s).
- Put the API and dashboard behind HTTPS, and set `TRUST_PROXY` to the number
  of proxy hops in front of the API.
- Do not expose the datastores or the MinIO console to the public internet.
