# DevOps Task — Two Apps, One Server, Independent CI/CD

Two web applications deployed on a single EC2 instance, each served on its own
subdomain via an Nginx reverse proxy, each backed by an independent PostgreSQL
database on a shared managed RDS instance, each with its own Jenkins pipeline.

- **App 1 (`crud-api`)** — candidate-built Express + Prisma CRUD API → `https://app-mohit.duckdns.org`
- **App 2 (`Multi-Auth`)** — existing Express + Prisma auth service → `https://multiauth-mohit.duckdns.org`
- **Jenkins** — CI/CD, proxied over HTTPS → `https://jenkins-mohit.duckdns.org`

Both apps are live over HTTPS, both have working CI/CD pipelines that
auto-trigger on push, and reviewer read-only access is configured for both AWS
(IAM) and Jenkins.

---

## 1. Architecture Overview

A single EC2 instance (Ubuntu 24.04) runs everything. Only Nginx is exposed to
the internet; both apps and Jenkins bind to `127.0.0.1` and are reached only
through Nginx over HTTPS. The database is a separate managed RDS instance,
reachable only from the EC2 security group.

```
                         Internet (HTTPS)
                                |
                    +-----------v-----------+
                    |   Nginx (80 -> 443)   |   public: 80, 443
                    |   TLS termination     |
                    +--+--------+--------+--+
                       |        |        |   (routes by server_name / Host header)
             app-mohit |        | multiauth        | jenkins
                       v        v                  v
              127.0.0.1:4000  127.0.0.1:5000   127.0.0.1:9090
                 (App1 PM2)     (App2 PM2)       (Jenkins)
                       |        |
                       +---+----+
                           | 5432 (SG-to-SG only, TLS)
                    +------v-------+
                    | RDS Postgres |   Single-AZ, not public
                    |  app1_db     |   (app1_user)
                    |  app2_db     |   (app2_user)
                    +--------------+
```

Verified request path (both apps):
`HTTPS → Nginx (443) → 127.0.0.1:<port> → Express → Prisma → RDS`

---

## 2. Nginx Setup

Nginx is the only public-facing service. Configuration is file-based under
`/etc/nginx/sites-available/`, one file per app, symlinked into
`sites-enabled/` — not applied ad hoc via the command line. The vhost files are
also committed to this repo under `nginx/` for reproducibility.

| vhost              | server_name                     | upstream            |
|--------------------|---------------------------------|---------------------|
| `app-mohit`        | app-mohit.duckdns.org           | 127.0.0.1:4000      |
| `multiauth-mohit`  | multiauth-mohit.duckdns.org     | 127.0.0.1:5000      |
| `jenkins-mohit`    | jenkins-mohit.duckdns.org       | 127.0.0.1:9090      |

Routing: Nginx selects the vhost by the `Host` header (`server_name`). Each app
has its own `server` block, so there are no port conflicts and no cross-app
interference. The Jenkins vhost additionally sets
`proxy_set_header Connection ""` because Jenkins' UI relies on keep-alive /
websocket connections that break under the default proxy connection handling.

TLS: Let's Encrypt via `certbot --nginx`, a single run covering all three
subdomains, with `--redirect` (HTTP 80 → HTTPS 443, 301). The base vhost files
are hand-written and version-controlled; the `listen 443 ssl`, certificate
paths, and redirect blocks are certbot-managed (marked `# managed by Certbot`).
Noted for honesty — the final file is part hand-authored, part tool-generated.

---

## 3. Open Ports — Full List with Justification

EC2 security group inbound rules:

| Port | Source     | Reason |
|------|------------|--------|
| 22   | my IP only | SSH admin access, restricted to a single IP — not open to the world. |
| 80   | 0.0.0.0/0  | HTTP; exists only to 301-redirect to HTTPS and serve Let's Encrypt HTTP-01 challenges. |
| 443  | 0.0.0.0/0  | HTTPS; all real public traffic. |

Deliberately **not** open in the security group:

- **4000, 5000** (App1, App2) — bound to `127.0.0.1`, reachable only via Nginx.
- **9090** (Jenkins) — bound to `127.0.0.1`, reached only via the `jenkins-mohit`
  Nginx vhost over HTTPS. Never exposed directly; keeps the public port list to
  three and removes Jenkins from internet-wide scanning.
- **5432** (Postgres) — not on the EC2 at all; lives on the RDS security group,
  allowed only from the EC2 security group (see §4).

---

## 4. Database Strategy

- **Managed RDS**, not a container on the app server — keeps DB lifecycle,
  backups, and patching off the app host (a task requirement).
- **One RDS instance, two databases** (`app1_db`, `app2_db`), each with its own
  least-privilege role (`app1_user`, `app2_user`); each app connects only to its
  own database via its own `DATABASE_URL`.
- **Engine:** PostgreSQL 16, `db.t3.micro`, Single-AZ, Public access = No.
- **Network:** RDS security group allows inbound 5432 **only from the EC2
  security group** (SG-to-SG reference, not an IP) — only the app server can
  reach the DB, never the public internet, and the rule survives EC2 IP changes.
- **TLS:** connections use SSL with certificate verification against the RDS CA
  bundle (`sslmode=verify-full` + `sslrootcert=global-bundle.pem`). The CA bundle
  is a deploy-time file dependency on the server, not committed to git.

**Trade-off considered:** one instance / two DBs was chosen over two separate
instances for cost and simplicity — two low-traffic databases fit comfortably on
one micro instance. Two instances would give stronger blast-radius isolation and
independent failover; this is partly mitigated with per-DB users so a leaked App1
credential cannot touch App2's database. Single-AZ chosen because the task has no
HA requirement; production would use Multi-AZ for automatic AZ-failover.

---

## 5. Instance Sizing Rationale

- **EC2:** a single `t2.medium` (2 vCPU, 4GB) instance runs Nginx + both apps
  (PM2) + Jenkins. Jenkins' JVM alone reserves ~600MB, so a 1GB box would be
  tight during CI builds; 4GB gives headroom for the JVM plus two Node processes
  plus build steps. Disk: 29GB gp3 — enough for two `node_modules` trees, Jenkins
  workspaces and build history, and logs.
- **RDS:** `db.t3.micro` (2 vCPU, 1GB) — sufficient for two small databases with
  few connections and no real load. Deliberately not oversized: an `m5.large`
  would be unjustifiable over-provisioning for this workload, which is itself a
  finding.

---

## 6. Reasoning Challenges

### 6.1 Reverse Proxy Design — how Nginx routes requests

Nginx decides which app receives a request using the `Host` header, matched
against each vhost's `server_name`. Three separate `server` blocks, one file per
app under `sites-available/`, symlinked into `sites-enabled/`:

- `app-mohit.duckdns.org`       → `proxy_pass http://127.0.0.1:4000`
- `multiauth-mohit.duckdns.org` → `proxy_pass http://127.0.0.1:5000`
- `jenkins-mohit.duckdns.org`   → `proxy_pass http://127.0.0.1:9090`

Both apps bind to `127.0.0.1` on distinct ports, so there is no port conflict and
neither app is reachable except through Nginx. The two apps cannot interfere
because each request resolves to exactly one `server_name` and therefore one
upstream — there is no shared location or default route between them. The Jenkins
vhost sets `proxy_set_header Connection ""` because Jenkins' UI relies on
keep-alive / websocket connections that break under default proxy handling.

### 6.2 Database Separation Strategy — trade-offs

Chosen: one `db.t3.micro` RDS instance, Single-AZ, two databases with a separate
least-privilege role each; each app connects only to its own DB.

Trade-offs:
- **Cost / simplicity** (why one instance): two separate instances double cost
  and management for no benefit at this scale.
- **Isolation** (cost of sharing): separate instances give stronger blast-radius
  isolation; mitigated here with per-DB users, so a leaked App1 credential cannot
  read or drop App2's database.
- **Connection limits:** `t3.micro` has a modest max-connections ceiling; with two
  small pooled apps this is not a constraint, but a larger workload would argue
  for separate instances.
- **Failover:** Single-AZ has no standby. Acceptable — no HA requirement;
  production would use Multi-AZ.

### 6.3 Prisma Migration Safety (App2)

The App2 pipeline uses `prisma migrate deploy` (not `migrate dev`) — it only
applies committed migrations and never generates or resets, so it is safe for
production. It is gated: the pipeline runs a git diff between the last-deployed
commit and HEAD and only runs `migrate deploy` when files under
`prisma/migrations/` actually changed (implemented in the Migrate stage of the
Jenkinsfile). On a build with no migration changes, the stage prints "No
migration changes — skipping migrate deploy."

Ordering is the key safety property: migrations run BEFORE the app is restarted
onto the new code. If `migrate deploy` exits non-zero, the deploy aborts, the old
version keeps running, and the new version is never started against a
half-migrated schema. On Postgres each migration runs in a transaction, so a
failed migration rolls itself back rather than leaving a partial state.

### 6.4 Rollback Trigger Logic

A deploy is considered failed if, after restart, the health check does not return
healthy within a bounded retry window (implemented in the Health Check stage):

- Endpoint: `GET /health` (App1 → `{"status":"healthy","db":"connected"}`;
  App2 → `{"status":true,"message":"healthy","data":{"db":"connected"}}`).
- Healthy = HTTP 200 AND a healthy body. Anything else — non-200, connection
  refused, or 200 with an unhealthy body — is a failure.
- Retries: 5 attempts, 10s apart (≈50s total), 5s per-request timeout. Rationale:
  a cold Node start plus Prisma connecting to RDS typically completes well under
  30s; 50s gives margin without hanging the pipeline; 5s timeout because `/health`
  does a real DB round-trip, not a static response. (Observed in practice: App2's
  first post-restart curl returns connection-refused for ~1–2s while PM2 rebinds
  the port, then passes on the retry — the retry loop exists precisely for this.)
- On failure (`post { failure }` block): roll back to the last known-good commit
  captured BEFORE the pull, re-install, and restart — so no manual SSH is needed
  after a failed deploy.

### 6.5 Secrets Across Stages

- **Build time:** no secrets needed. App2 is backend-only (no React frontend), so
  nothing secret is baked into any bundle or image layer.
- **Deploy time:** the app reads secrets from a server-side `.env` (outside the
  repo, restricted permissions). JWT signing keys are stored as files
  (`keys/private.key` chmod 600, `keys/public.key`) — the app was changed to read
  keys from these files rather than from env vars, avoiding fragile PEM-in-env
  encoding and keeping private keys out of `.env` entirely.
- **Runtime:** the app reads `DATABASE_URL`, key file paths, and app secrets from
  the server-side `.env` / files.
- **Never in git:** `.env`, `keys/`, and `*.pem` are gitignored in both repos;
  only `.env.example` (placeholders) is committed. Verified with
  `git ls-files | grep env` returning only `.env.example`.

### 6.6 IAM Scoping

The reviewer IAM user has a hand-written policy granting only:
- `ec2:DescribeInstances / DescribeSecurityGroups / DescribeVolumes / DescribeAddresses`
  — verify the instance, its sizing, SG rules, volume, and Elastic IP.
- `rds:DescribeDBInstances` — verify DB engine, Single-AZ, and that it is not public.
- `cloudwatch:GetMetricData / ListMetrics` and `logs:Describe* / GetLogEvents`
  — view metrics and application logs.

Every action is a read (`Describe`/`Get`/`List`); no write, delete, or admin
actions. The broad AWS-managed `ReadOnlyAccess` policy was deliberately NOT
attached — it grants read to S3 object contents, IAM, and Secrets Manager metadata
far beyond what verifying this task requires. Least privilege.

Verified live: as the reviewer user, `aws ec2 describe-instances` succeeds, while
`aws s3 ls` and `aws ec2 create-tags` both return AccessDenied /
UnauthorizedOperation — confirming read works and write is impossible.

---

## 7. CI/CD Pipelines

Both pipelines are defined as a `Jenkinsfile` committed to their respective repos
(not configured in the Jenkins UI), and auto-trigger on push via a GitHub webhook.

**App1 (`crud-api-pipeline`, branch `master`)**: Capture current version → Build
(fetch/reset/npm install) → Test (health smoke test) → Deploy (pm2 restart) →
Health Check (5×10s retries) → rollback on failure.

**App2 (`multi-auth-pipeline`, branch `main`)**: Capture → Build → Migrate
(conditional `prisma migrate deploy`, only if `prisma/migrations/` changed) →
Deploy → Health Check → rollback on failure.

Deploy mechanism: Jenkins runs as the `jenkins` user; deploy commands run as the
`ubuntu` user (who owns the app dirs and PM2) via a tightly-scoped sudoers entry
allowing only `pm2`, `git`, `npm`, `npx`. This is a deliberate privilege bridge
for a single-box setup; a production setup would use a dedicated deploy agent.

A read-only Jenkins account (`reviewer`) is configured via matrix-based security
with Overall/Job/Run/View: Read only — it can inspect jobs and console output but
cannot build, configure, or administer.

---

## 8. Notes

- **Upstream mismatch:** the "MERN" App 2 repo is backend-only (Express + Prisma +
  Postgres, no React frontend), so the pipeline's "npm run build for React" step
  is N/A. The app was also modified to load JWT keys from files rather than
  environment variables (see §6.5). App2's npm audit reports vulnerabilities
  inherited from the upstream dependencies, left as-is.
- **Credentials:** reviewer IAM access key + Jenkins reviewer login are sent in the
  submission email, never committed to any repo (verified clean).
