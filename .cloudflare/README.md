# AFFiNE on Cloudflare

Runs the AFFiNE server on Cloudflare, with Neon as the database.

```
browser / MCP client
        │ HTTPS + WebSocket
        ▼
Cloudflare Worker (src/index.ts)
        │
        ▼
Cloudflare Container: AFFiNE server + local Redis ──► R2 (blobs, avatars, AI files)
        │
        ▼
Neon Postgres (pgvector)
```

| Need             | Service                                                   |
| ---------------- | --------------------------------------------------------- |
| Server process   | Cloudflare Containers (one `standard-1` instance)         |
| HTTPS, domain    | Cloudflare Workers                                        |
| Files            | Cloudflare R2 (AFFiNE's built-in `cloudflare-r2` storage) |
| Database         | Neon Postgres                                             |
| Cache, queues    | Redis inside the container (or any `REDIS_SERVER_URL`)    |
| Email (optional) | Any SMTP provider (`MAILER_*`)                            |

AFFiNE is a long-running Node.js server with a native Rust module, WebSockets
and Postgres, so it runs in a Container. The Worker only forwards requests.

Containers require the Workers Paid plan.

## 1. Neon

1. Create a Neon project in the region closest to your Cloudflare users.
2. Copy the **direct** connection string. Do not use the `-pooler` host,
   because Prisma migrations and the server's prepared statements need a
   session connection:

   ```
   postgresql://USER:PASSWORD@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require
   ```

The `vector` and `pgcrypto` extensions are created by the migrations, and Neon
supports both.

## 2. R2

1. Create three buckets: `affine-blobs`, `affine-avatars`, `affine-copilot`.
   To use other names, edit `vars` in `wrangler.jsonc`.
2. Create an R2 API token with **Object Read & Write** on those buckets. Note
   the Access Key ID, the Secret Access Key and your account ID.

## 3. Secrets

Generate the server key once and keep a copy. The container disk is wiped on
every restart, so the key must come from a secret. Losing it logs everyone out
and makes stored provider keys unreadable.

```sh
openssl ecparam -name prime256v1 -genkey -noout -out affine-private.key
```

Then, from this directory:

```sh
npm ci
npx wrangler login

npx wrangler secret put AFFINE_PRIVATE_KEY < affine-private.key
npx wrangler secret put DATABASE_URL                # Neon direct URL
npx wrangler secret put AFFINE_SERVER_EXTERNAL_URL  # e.g. https://affine.example.com
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Optional secrets:

| Secret                                                                          | Purpose                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `MAILER_HOST`, `MAILER_PORT`, `MAILER_USER`, `MAILER_PASSWORD`, `MAILER_SENDER` | Sign-in links, invitations                                  |
| `REDIS_SERVER_URL`                                                              | External Redis (e.g. `rediss://…`) instead of the local one |
| `R2_JURISDICTION`                                                               | `eu` for EU-jurisdiction buckets                            |
| `AFFINE_COPILOT_ENABLED`                                                        | `false` turns off AI **and** the MCP endpoint               |

`wrangler secret put` creates the Worker on first use if it doesn't exist yet.

## 4. Build the image and deploy

The ticket MCP tools live in this repository's server code, so deploy an image
built from it. The `Deploy to Cloudflare` workflow
(`.github/workflows/deploy-cloudflare.yml`) builds the image, pushes it to
`ghcr.io/<owner>/affine`, and runs `wrangler deploy`.

In your fork, add these repository secrets:

| Secret                  | Value                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | API token with _Workers Scripts: Edit_, _Containers: Edit_ and _Workers Routes: Edit_ (for custom domains) |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID                                                                                            |
| `AFFINE_PRO_PUBLIC_KEY` | The public key below                                                                                       |

Self-hosted servers refuse to start unless AFFiNE's license **public** key is
compiled into `server-native`. This is the key embedded in the official
`ghcr.io/toeverything/affine:stable` image (0.27.4):

```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbGqisyJSiM+dNgXqwb+3M9b6ZkgS
PKgnhqGbbh+56pAYadQViCoMzu7W+x++youSve21GxbjOvZsJWfexy2s+w==
-----END PUBLIC KEY-----
```

Then run **Actions → Deploy to Cloudflare → Run workflow**. To redeploy an
image you already built, pass it as the `image` input. To only build the image
(for example to deploy it yourself with `wrangler deploy`), untick `deploy`;
the Cloudflare secrets are then not needed.

To deploy from your machine instead, set `AFFINE_IMAGE` in `wrangler.jsonc` to
the image and run `npx wrangler deploy` (Docker must be running).
`ghcr.io/toeverything/affine:stable` works for a quick test, but it doesn't
include the ticket tools. The published `canary` image is built without the
license key and won't start in self-hosted mode.

## 5. First start

The first request starts the container. It runs migrations, then boots the
server, so allow a minute or two. Later cold starts take seconds.

1. Open `AFFINE_SERVER_EXTERNAL_URL` and create the admin account at `/admin`.
2. To use your own domain, uncomment `routes` in `wrangler.jsonc`, set
   `AFFINE_SERVER_EXTERNAL_URL` to match, and deploy again.

Logs: `npx wrangler tail`, or the Containers page in the Cloudflare dashboard.

## 6. Ticket MCP

Each workspace has an MCP endpoint (Streamable HTTP, stateless):

```
https://<your-domain>/api/workspaces/<workspace-id>/mcp
```

Create a token in **Workspace Settings → Integrations → MCP Server**. Choose
**Read and write** to let clients change tickets. For example, with Claude Code:

```sh
claude mcp add --transport http affine \
  https://affine.example.com/api/workspaces/<workspace-id>/mcp \
  --header "Authorization: Bearer <token>"
```

A **ticket** is a row of a database block, in either table or kanban view. Its
**status** is the select column named `Status`. If there is none, the first
select column with "status", "state" or "stage" in its name is used, and
failing that the first select column.

To set up a board, add a database to a doc and give it a `Status` select
column with options such as `Todo`, `In Progress` and `Done`. Add any other
columns you need, for example `Priority` (select), `Points` (number) or `Due`
(date).

- **People:** add a `Member` column such as `Assignee` (and optionally a
  `Created By` column). Tickets show people by name, and can be filtered and
  assigned by name or email.
- **Projects:** a ticket's project is its `Project` column if the board has
  one, and otherwise the board's title. Use one board per project, or one board
  with a `Project` select column.

| Tool                                                         | Mode       | What it does                                                                |
| ------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| `list_ticket_boards`                                         | read       | Boards with columns and status options, in one doc or the whole workspace   |
| `list_tickets`                                               | read       | Tickets of one doc or the whole workspace, by user, project, status or text |
| `get_ticket`                                                 | read       | One ticket with all fields, plus `linkedDocId` if its title links a doc     |
| `update_ticket_status`                                       | read-write | Move a ticket to another status                                             |
| `update_ticket`                                              | read-write | Change title, status or fields (by column name)                             |
| `create_ticket`                                              | read-write | Add a ticket to a board                                                     |
| `read_document`, `doc_search`                                | read       | Read a ticket's linked doc, search the workspace                            |
| `create_document`, `update_document`, `update_document_meta` | read-write | Create docs from Markdown, replace a doc's body, rename a doc               |

Field values are matched by column name, case-insensitively. Select and
multi-select fields take option names. Member fields take member names or
emails. Dates take ISO strings. `null` clears a
field. Edits are written as Yjs updates, so open editors see them live.

## Limits

- **Keep the server next to the database.** Each page load runs many
  queries in sequence, so the distance between the container and Postgres
  matters far more than the distance to users. `constraints.regions` in
  `wrangler.jsonc` pins the container to the database's region; update it if
  the database moves. Hyperdrive doesn't help here, because it's a Worker
  binding and the queries come from the container.

- **One instance.** The local Redis and realtime sync assume a single server
  process. To run more instances, set `REDIS_SERVER_URL` to a shared Redis and
  raise `max_instances`.
- **Sleep.** After `AFFINE_SLEEP_AFTER` (default `1h`) without requests the
  container stops and the local Redis is cleared. Queued background jobs, such
  as pending emails, are lost. Data in Neon and R2 is not affected.
- **Upload size.** Uploads pass through the Worker, so Workers request body
  limits apply (100 MB on Free and Pro plans).
