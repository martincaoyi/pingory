# Pingory

Open-source uptime monitoring you can self-host in one command.

Pingory watches your websites, APIs, ports and certificates, and alerts you by email, chat or
webhook when something breaks. It ships with public status pages, 30-second check intervals and
an interface in 8 languages. The whole thing is a single Node.js service and a PostgreSQL
database — there is no build step and no paid dependency required to run it.

- **Hosted service:** <https://pingory.com> — nothing to run, plans from $4/month.
- **Self-hosted:** this repository. Free, AGPL-3.0 licensed, runs on your own machine or server.

Both are the same code. The hosted version exists for people who would rather not run a server;
using it is optional and the self-hosted build is not a demo or a crippled edition.

## Features

### Checks

- **HTTP/HTTPS** — status code, response time, redirects, custom headers
- **Keyword** — fail when a string is missing from (or present in) the response
- **API monitor** — header and JSON assertions against a JSON endpoint
- **TCP port** — is the port accepting connections
- **Ping (ICMP)** — host reachability
- **DNS record** — resolve and compare a record
- **SSL certificate** — expiry and validity warnings before a cert lapses
- **Domain expiry (WHOIS)** — get warned before the domain is up for renewal
- **Heartbeat / cron dead-man switch** — your job pings us; we alert when it goes quiet

### Alert channels

Email, Slack, Webhook, Telegram, Discord, Microsoft Teams and PagerDuty.
Slack, Webhook, Telegram, Discord, Teams and PagerDuty use incoming-webhook URLs, so there is
nothing to register and no API keys to manage. Telegram needs a bot token and chat ID.

Email is sent over SMTP, so you can point it at any provider you already use
(Resend, Postmark, SES, Gmail, your own mail server).

### Also included

- **Public status pages** with a custom slug, optional custom domain and white-labelling
- **Multi-region probes** — delegate checks to additional nodes and require agreement before
  alerting, so a flaky network path on one machine does not page you at night
- **SSL and domain expiry monitoring** with advance warning
- **Monthly uptime reports** by email
- **Email/password accounts plus optional GitHub and Google sign-in**
- **Account-level alert credentials** — configure a Slack or PagerDuty destination once and
  reuse it across every monitor
- **8 languages** — English, 中文, Español, Português, Deutsch, Français, 日本語, 한국어

## Quick start (Docker)

Requires Docker and Docker Compose. Nothing else.

```bash
git clone https://github.com/martincaoyi/pingory.git
cd pingory
cp .env.example .env
```

Open `.env` and set at least two values:

- `SESSION_SECRET` — any long random string
- `STATUS_PAGE_SECRET` — a second, different random string

Then:

```bash
docker compose up -d
```

Open <http://localhost:3000>. The database schema is created automatically on first start, so
there is no migration step.

To create an admin account on first boot, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`
before starting. Otherwise just sign up through the UI.

## Quick start (no Docker)

Requires Node.js 18 or newer and a PostgreSQL database.

```bash
npm ci
cp .env.example .env      # set DATABASE_URL, SESSION_SECRET and STATUS_PAGE_SECRET
node server.js
```

`node server.js` runs the web app, the scheduler and the alerting engine together. That single
process is a complete installation.

## Configuration

Everything is read from environment variables; see `.env.example` for the full annotated list.
The ones that matter most:

- `DATABASE_URL` — PostgreSQL connection string. Leave it unset and the bundled Postgres from
  `docker-compose.yml` is used; set it to point at Neon, Supabase, RDS or any other Postgres.
- `SESSION_SECRET` — signs session cookies. **Change this in production.**
- `STATUS_PAGE_SECRET` — signs private status-page access tokens. Use a different value.
- `APP_URL` — the public base URL of your installation. Used to build links in emails.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — outgoing mail. If you skip
  these, email alerts and sign-up verification are unavailable but every other channel still works.
- `GITHUB_CLIENT_ID` / `GOOGLE_CLIENT_ID` and their secrets — optional social login.
- `PROBE_REGIONS` — optional multi-region probe nodes, described below.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — optional super-admin account created on first boot.

Billing is optional. Pingory's hosted service uses a payment provider, but a self-hosted
installation does not need one: leave the payment variables empty and the app runs normally with
every feature unlocked. Plan gating exists for the hosted product; when you self-host, you can
simply put your account on a paid plan in the database.

## Multi-region probes

A single server cannot tell "the site is down" apart from "my server cannot reach the site",
which is exactly the false positive that wakes people up at 3 a.m.

To add probe nodes, deploy the same code with `node src/worker.js` on machines in other regions,
then list them in `PROBE_REGIONS`:

```bash
PROBE_REGIONS=[{"name":"local","baseUrl":null},{"name":"us-east","baseUrl":"https://probe-us.example.com"}]
```

A `baseUrl` of `null` means "check from this machine". Paid plans require the nodes to agree
before alerting. Set `PROBE_SECRET` on both the main service and the probes to stop the probe
endpoint from being called by strangers. `docker-compose.yml` contains two example probe
services you can adapt.

## Deployment

- `Dockerfile` — production image
- `docker-compose.yml` — app, PostgreSQL and example probe nodes
- `fly.toml` — Fly.io configuration
- `render.yaml` — Render configuration
- `deploy/nginx.conf` and `deploy/pingory.service` — nginx reverse proxy and systemd unit for a
  plain Linux server

See `docs/DEPLOYMENT.md` for the long-form version.

## Project layout

- `server.js` — HTTP API, sessions, billing webhooks, startup sequence
- `src/` — `db.js` schema and queries, `monitors.js` check implementations, `worker.js` probe
  node, `alerts.js` dispatch, `plans.js` plan matrix, `email.js` templates, `auth.js` accounts
- `public/` — the front end: plain HTML, CSS and JavaScript, no bundler
- `public/i18n/` — the 8 language dictionaries
- `docs/` — architecture, API reference, standards, deployment notes
- `tools/` — maintenance scripts, including the project's own consistency gate

## Documentation

- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/API-REFERENCE.md` — every HTTP endpoint
- `docs/DEPLOYMENT.md` — deploying to Fly.io, Render, Docker or bare metal
- `docs/CODE-STANDARDS.md` — conventions this codebase follows

## Contributing

Issues and pull requests are welcome. Before opening a pull request, please run the project's
own gate, which checks the schema, API contract, i18n completeness and UI consistency:

```bash
node tools/dev_gate.js
```

## License

[AGPL-3.0](LICENSE) © Pingory. You may use, modify, self-host and redistribute this code.

The AGPL is a copyleft licence with one clause that matters most here: if you run a modified
version of Pingory as a network service, you must offer that modified source to the people using
it. Self-hosting it unmodified, or for your own internal use, carries no such obligation — run it
however you like.

The licence covers the code. The "Pingory" name, logo and brand assets are not granted with it,
so please give a fork a different name and logo.

Because the code is AGPL and anyone may run it for free, the hosted service at
<https://pingory.com> is what funds continued development. If Pingory is useful to you and you
would rather not run a server, a paid plan is the most direct way to keep it maintained.

## Security

Please do not open a public issue for a security problem. Report it privately via the contact
address in `public/.well-known/security.txt`.
