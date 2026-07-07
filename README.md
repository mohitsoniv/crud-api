# DevOps Task — Two Apps, One Server, Independent CI/CD

Two web applications deployed on a single EC2 instance, each served on its own
subdomain via Nginx reverse proxy, each backed by an independent PostgreSQL
database on a shared managed RDS instance, with independent Jenkins pipelines.

- **App 1 (`crud-api`)** — candidate-built Express + Prisma CRUD API → `app-mohit.duckdns.org`
- **App 2 (`Multi-Auth`)** — existing Express + Prisma auth service → `multiauth-mohit.duckdns.org`
- **Jenkins** — CI/CD, proxied over HTTPS → `jenkins-mohit.duckdns.org`

> Status note: App 1 is fully deployed and live. App 2 deployment and both
> Jenkins pipelines are in progress — see the "Incomplete / in progress"
> section at the end. Partial by design; documented honestly.

---

## 1. Architecture Overview

Single EC2 instance (Ubuntu 24.04) runs everything. Only Nginx is exposed to
the internet; both apps and Jenkins bind to `127.0.0.1` and are reached only
through Nginx. Databases live on a separate managed RDS instance, reachable
only from the EC2 security group.

```
                         Internet (HTTPS)
                                |
                    +-----------v-----------+
                    |   Nginx (80 -> 443)   |   public: 80, 443
                    |   TLS termination     |
                    +--+--------+--------+--+
                       |        |        |   (routes by server_name)
             app-mohit |        | multiauth        | jenkins
                       v        v                  v
              127.0.0.1:4000  127.0.0.1:5000   127.0.0.1:9090
                 (App1 PM2)     (App2 PM2)       (Jenkins)
                       |        |
                       +---+----+
                           | 5432 (SG-to-SG only)
                    +------v-------+
                    | RDS Postgres |   Single-AZ, not public
                    |  app1_db     |
                    |  app2_db     |
                    +--------------+
```

Full request path for App 1 (verified working):
`HTTPS → Nginx (443) → 127.0.0.1:4000 → Express → Prisma → RDS app1_db`

---

## 2. Nginx Setup

Nginx is the only public-facing service. Configuration is file-based under
`/etc/nginx/sites-available/`, one file per app, symlinked into
`sites-enabled/` — not applied ad hoc.

- `app-mohit`      → `proxy_pass http://127.0.0.1:4000`
- `multiauth-mohit`→ `proxy_pass http://127.0.0.1:5000`
- `jenkins-mohit`  → `proxy_pass http://127.0.0.1:9090` (adds `proxy_set_header Connection ""` for Jenkins' keep-alive/websocket needs)

Routing: Nginx selects the vhost by the `Host` header (`server_name`). Each
app has its own `server` block, so there are no port conflicts and no
cross-app interference — a request to one subdomain can only ever reach that
app's upstream.

TLS: Let's Encrypt via `certbot --nginx`, single run covering all three
subdomains, with `--redirect` (HTTP 80 → HTTPS 443, 301). The base vhost files
are hand-written and version-controlled; the `listen 443 ssl`, cert paths, and
redirect blocks are certbot-managed (marked `# managed by Certbot`). This is
noted for honesty — the file is part hand-authored, part tool-generated.

---

## 3. Open Ports — Full List with Justification

Security group inbound rules on the EC2 instance:

| Port | Source        | Reason |
|------|---------------|--------|
| 22   | my IP only    | SSH admin access, restricted to a single IP — not open to the world. |
| 80   | 0.0.0.0/0     | HTTP; exists only to 301-redirect to HTTPS and to serve Let's Encrypt HTTP-01 challenges. |
| 443  | 0.0.0.0/0     | HTTPS; all real public traffic. |

Deliberately **not** open in the security group:

- **4000, 5000** (App1, App2) — bound to `127.0.0.1`, reachable only via Nginx.
- **9090** (Jenkins) — bound to `127.0.0.1`, reached only via the `jenkins-mohit`
  Nginx vhost over HTTPS. Never exposed directly; keeps the public port list to
  three and removes Jenkins from internet-wide scanning.
- **5432** (Postgres) — not on the EC2 at all; lives on the RDS security group,
  allowed only from the EC2 security group (see §4).

---

## 4. Database Strategy

- **Managed RDS**, not a container on the app server (required, and correct —
  keeps DB lifecycle/backups/patching off the app host).
- **One RDS instance, two databases** (`app1_db`, `app2_db`), owner `postgres`.
- **Engine:** PostgreSQL 16, `db.t3.micro`, Single-AZ, Public access = No.
- **Isolation:** each app connects only to its own database via its own
  `DATABASE_URL`.
- **Network:** RDS security group allows inbound 5432 **only from the EC2
  security group** (SG-to-SG reference, not an IP) — so only the app server can
  reach the DB, never the public internet, and the rule survives EC2 IP changes.
- **TLS:** connections use SSL (verified working with `sslmode=verify-full` +
  the RDS CA bundle during testing; app runtime uses `sslmode=require` for
  simplicity — a deliberate trade-off, weaker hostname verification but no cert
  path management in the app).

**Trade-off considered:** one instance / two DBs was chosen over two separate
instances for cost and simplicity. Two instances would give stronger isolation
and independent failover, but this task doesn't require HA, and a single
`db.t3.micro` comfortably handles two low-traffic databases. Single-AZ chosen
for the same reason — no failover requirement; production would use Multi-AZ.

---

## 5. Instance Sizing Rationale

- **EC2:** single instance runs Nginx + both apps (PM2) + Jenkins. Jenkins' JVM
  alone reserves ~600MB, and App2's build stage is memory-heavy, so a 1GB box
  would OOM during CI. [FILL: state your actual EC2 type here — t3.medium
  recommended for headroom; if smaller, note swap.] Disk: [FILL: your volume
  size] gp3 — enough for two node_modules trees, Jenkins workspaces/build
  history, and logs.
- **RDS:** `db.t3.micro` (2 vCPU, 1GB) — sufficient for two small databases with
  few connections and no real load. Deliberately not oversized: an `m5.large`
  would be unjustifiable over-provisioning for this workload, which is itself a
  finding.

---

## 6. Reasoning Challenges

> [FILL after pipelines exist — writing these now would describe behaviour that
> isn't built. Answers to draft: (1) reverse proxy design, (2) DB separation
> trade-offs, (3) Prisma migration safety + failure handling, (4) rollback
> trigger logic with exact retry/timeout numbers, (5) secrets across build/
> deploy/runtime for both apps, (6) IAM per-permission justification.]

---

## Incomplete / In Progress

- App 2 (Multi-Auth) deployment: keys, `.env`, `prisma migrate deploy`, added
  `/health` route, PM2 on 5000.
- Jenkins pipelines (both Jenkinsfiles), GitHub webhooks, read-only reviewer
  account.
- IAM read-only user + scoped policy.
- Reasoning challenges §6.

Noting the upstream mismatch: the "MERN" App 2 repo is backend-only (Express +
Prisma + Postgres, no React frontend), so the "npm run build for React" pipeline
step is N/A and documented as such.
