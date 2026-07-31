# Scan2Tally - Automated Handwritten Receipt to Tally Accounting Bridge

> **Scan2Tally** converts physical handwritten paper bill and receipt photos into structured accounting data and generates Excel files (`.xlsx`) formatted specifically for 1-click import into **Tally Prime** / **Tally ERP 9**.

---

## 🎯 Problem & Automated Workflow

### The Problem
Store and office staff write transaction details **by hand on paper receipts**. Accountants then spend hours re-typing every single handwritten bill into Excel line-by-line before importing it into Tally. This manual entry is time-consuming, causes fatigue, and leads to typographical errors.

### The Scan2Tally Solution
1. **Snap / Scan**: Staff snap a photo of the handwritten paper receipt using a mobile phone, tablet, or scanner.
2. **AI Extraction**: Scan2Tally reads the Date, Voucher Type, Debit/Credit Ledgers, Amounts and Narrations, then matches each ledger name against the company's real chart of accounts.
3. **Side-by-Side Verification**: Accountants double-check and edit entries on a clean side-by-side verification screen with automatic Debit == Credit balance checks.
4. **1-Click Tally Import**: Scan2Tally generates a standard Tally Prime importable Excel spreadsheet (`.xlsx`).

---

## 🚀 What Is Built

### Database & Supabase infrastructure
- [`supabase_schema.sql`](./supabase_schema.sql) holds the full PostgreSQL DDL for 7 tables
  (`organizations`, `users`, `scan_batches`, `receipts`, `ledgers`, `transactions`, `exports`).
- **Row Level Security** on every table, with helper functions (`get_auth_user_org_id()`,
  `get_auth_user_role()`) enforcing multi-tenant isolation in the database rather than in the client.
- Migrations live in [`scripts/migrations/`](./scripts/migrations) and are safe to re-run.

### React TypeScript web interface
- React 18 + Vite SPA in strict TypeScript.
- **3-tier roles**:
  - `Super Admin` — platform owner: client organizations and platform-wide figures.
  - `Admin` — the company's books: an organisation overview, the chart of accounts, and staff accounts.
  - `Operator` — data entry: batches, uploads and voucher review.
- **Scan batch hub** with drag-and-drop upload, low-resolution warnings, and archiving.
- **Side-by-side reviewer**: the paper voucher on the left, an editable transaction table on the
  right, with live Dr/Cr totals and a picker backed by the organisation's real ledgers.
- **Tally Excel exporter** with a preview, an unresolved-ledger warning, and a recorded history
  of every file generated.

### Python FastAPI backend
- Multi-pass OpenAI Vision transcription with a **consensus check**: several independent readings
  of the same voucher are compared, and a cell the model cannot read the same way twice is flagged
  rather than presented as fact. Gemini is used as a fallback.
- The voucher's own जम्मा total is read in a **separate** request and used only to reconcile —
  never shown to the transcription pass, which would otherwise back-solve the line items to match it.
- **Server-side background extraction** (below).
- **Ledger matching** against the organisation's chart of accounts (below).

---

## 🧠 Two things worth knowing about the design

### Extraction belongs to a durable, sequential server queue

Reading a voucher takes tens of seconds. If that work lives inside the browser's HTTP request,
closing the tab, refreshing, or shutting a laptop lid abandons it — and the receipt is left saying
"Processing" with nothing in existence able to finish it.

So `POST /api/receipts/{id}/extract` returns `202` immediately and places the receipt in a durable
Supabase Queue. The backend reads the image from private storage, runs OCR, and atomically writes
the rows and final receipt state. The browser watches receipt changes through Supabase Realtime,
with polling as a recovery path, so closing the tab cannot abandon the work.

There is one database-owned worker slot for the whole platform. Even with several backend replicas
and several users uploading together, only one receipt can be in OCR at a time; the next FIFO
message is claimed only after the current one finishes or its lease expires. Every heartbeat and
final write carries a fencing token, so a crashed or delayed old worker cannot overwrite a newer
attempt. Files selected together are also uploaded one at a time in their original order.

This uses the Postgres-native `pgmq` extension already available through Supabase Queues. Redis and
BullMQ are not required for this Python/Supabase deployment.

### A ledger name Tally does not recognise is not a typo

Tally accepts a voucher only if its ledger names already exist in the company. An unrecognised name
is not a cosmetic problem: on import Tally either rejects the voucher or **quietly creates a second
ledger**, splitting one account's balance across two without anyone noticing.

An Admin enters the company's ledgers under **Chart of Accounts** (they can be pasted straight out
of Tally). Every extracted name is then resolved against that list:

| Result | Meaning | What happens to the name |
| :--- | :--- | :--- |
| `Exact` | same ledger, different spacing or case | rewritten to the Tally spelling |
| `Alias` | a spelling the accountant registered | rewritten to the Tally spelling |
| `Suggested` | close to a real ledger, but not the same | **left exactly as written** |
| `Unmatched` | checked, and not in the chart of accounts | left as written, reported |
| `Unchecked` | no chart of accounts to check against | left as written, nothing reported |

Only a certain match rewrites a name. A suggestion is offered to the reviewer to confirm and never
applied on its own — posting money to a merely-probable account would look identical to posting it
to a certain one.

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend Web App** | React 18, Vite, TypeScript (TSX), Vanilla CSS, Lucide Icons, Supabase JS SDK, ExcelJS |
| **Backend API** | Python 3, FastAPI, Uvicorn, httpx, OpenCV, Pillow, OpenAI / Gemini Vision |
| **Database & Cloud** | Supabase (PostgreSQL, Supabase Auth, Cloud Storage Buckets) |
| **Deployment ($0 Cost)** | Vercel (Frontend), Render (Backend API), Supabase Free Tier (Cloud DB) |

---

## ⚙️ Local Setup & Installation Guide

### Prerequisites
- **Node.js**: v18+ and `npm`
- **Python**: v3.10+ and `pip`
- **Git**

---

### 1️⃣ Frontend Setup (React TSX)

```bash
# 1. Navigate to frontend directory
cd frontend

# 2. Install dependencies
npm install

# 3. Create .env file from template
cp .env.example .env

# 4. Start local development server
npm run dev
```

👉 Open **`http://localhost:3000`** in your web browser.

---

### 2️⃣ Backend Setup (Python FastAPI)

On Linux/Ubuntu, ensure Python virtual environment tools are installed first:
```bash
sudo apt update && sudo apt install -y python3-pip python3-venv
```

Then start the FastAPI server:
```bash
# 1. Navigate to backend directory
cd backend

# 2. Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Install requirements
pip install -r requirements.txt

# 4. Create .env file from template
cp .env.example .env

# 5. Launch FastAPI server
python3 main.py
```

👉 API Server will run live at **`http://localhost:8000`** (Interactive Docs at `http://localhost:8000/docs`).

---

### 3️⃣ Supabase Database Setup

1. Create a free project at [Supabase.com](https://supabase.com/).
2. Open the **SQL Editor** in your Supabase dashboard.
3. Paste and run the contents of [`supabase_schema.sql`](./supabase_schema.sql).
   This also creates the private `receipts` storage bucket and its access
   policies — there is no bucket to create by hand.
4. From **Project Settings → API**, copy the project URL and the **anon** key
   into `frontend/.env` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

### Upgrading a database that already has data

`supabase_schema.sql` is the schema for a **new** project. An existing database is brought up to
date by running the files in [`scripts/migrations/`](./scripts/migrations) in order, in the SQL
Editor. They are additive and safe to run more than once.

| Migration | What it adds |
| :--- | :--- |
| `001_restrict_user_directory.sql` | limits the organisation-wide user directory to Admins |
| `002_ledgers_claiming_audit.sql` | the `ledgers` chart of accounts, job claiming, and a stored copy of what the model returned |
| `003_export_file_storage.sql` | private storage and policies for generated Excel files |
| `004_platform_capacity_usage.sql` | service-role-only Storage and database capacity metrics |
| `005_platform_database_cluster_usage.sql` | corrects database usage to include the entire Postgres cluster |
| `006_capacity_alerts_realtime.sql` | persisted, role-safe capacity warnings delivered through Supabase Realtime |
| `007_sequential_extraction_queue.sql` | durable PGMQ extraction jobs, a global one-worker lease, fenced atomic completion, and receipt Realtime updates |

**Run `002` before deploying this version of the web app** — it reads the ledger columns the
migration adds, and will show a load error without them.

**Run `007` before relying on sequential processing in production.** Stop the old backend, run the
migration in the Supabase SQL Editor, then start the new backend. The migration enables `pgmq`,
creates the private `receipt_extraction` queue, and safely moves receipts stranded in the old
`Processing` state into it. It is safe to run again. Without `007`, the backend deliberately falls
back to one local worker for rollout compatibility, but that fallback cannot coordinate separate
backend machines.

`007` requires `002`. If `007` was previously run out of order, stop the backend, apply `002`, rerun
the idempotent `007`, and then restart the backend. This repairs the existing queue functions and
lets `007` repeat its safe interrupted-receipt backfill.

**Run `004`, `005`, and `006` to enable the complete capacity monitor.** The backend measures the
project on one configurable schedule and writes only sanitized storage/database severity
transitions to `platform_capacity_alerts`. Admin and Operator sessions load any existing warning
at sign-in, then receive later changes over an authenticated Supabase Realtime connection; their
browsers never call `/api/platform-usage`. The exact live byte counts and bucket breakdown remain
available only to the Super Admin through that protected endpoint.

The app must be open for a warning to appear instantly. Because the current alert is persisted,
someone who signs in later still sees it immediately without opening a monitoring page. The
backend process must remain running to perform measurements; set
`SUPABASE_CAPACITY_ALERT_INTERVAL_SECONDS` to tune the detection interval (30 seconds by default).

The in-app monitor reports **current live bytes**. Supabase's organization-level Free plan usage
card reports billing-cycle averages, so its Storage number can legitimately lag behind or differ
from this live snapshot. Migration `005` makes the live database number use the same all-databases
cluster query documented for Supabase's project database report. Displayed MB/GB and quota
percentages use decimal units, matching the Supabase plan card rather than binary MiB/GiB.

The *backend* is deliberately tolerant of the gap: it detects the missing columns at start-up,
prints a warning, and carries on extracting vouchers with ledger matching switched off, so an
extraction already running during an upgrade is not lost. Only one backend process may run safely
in that state, because job claiming is one of the things `002` adds.

The bucket is deliberately **private**: receipt images are served through
short-lived signed URLs, so one organization cannot read another's scans by
guessing a path.

Capacity monitoring compares this project's live usage with the operational
limits configured on the backend. The defaults in `backend/.env.example` match
the Supabase Free plan. For Pro, Team, Enterprise, or a deliberately smaller
project budget, set `SUPABASE_STORAGE_QUOTA_GB` and
`SUPABASE_DATABASE_QUOTA_MB` to the limits you want the app to warn against.
Storage billing quotas are organisation-wide in Supabase, so an organisation
with several Supabase projects should assign this project an appropriate share
rather than assuming the entire organisation quota belongs to it.

---

### 4️⃣ Create the first login

Accounts are created by an administrator; there is no public signup. Use the
service role key (Project Settings → API → **service_role**) — keep it off the
frontend and out of version control.

```bash
node scripts/create-user.mjs \
  --url https://<your-project>.supabase.co \
  --service-key <service_role key> \
  --email admin@yourcompany.com \
  --password 'a strong password' \
  --name 'Your Name' \
  --role Admin \
  --org 'Your Company Pvt Ltd'
```

`--role` is `Super Admin`, `Admin` or `Operator`. A Super Admin belongs to no
organization, so `--org` is only needed for the other two. The organization is
created automatically the first time you name it.

---

### 5️⃣ Working against a local database (optional)

To develop without touching the cloud project, run the whole Supabase stack
locally with Docker:

```bash
npx supabase init      # once
npx supabase start     # prints the local URL and keys

# apply the schema to the local database
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase_schema.sql
```

Put the printed local URL and anon key in `frontend/.env.local`, which Vite
prefers over `.env` and which git ignores, so local credentials never end up in
a commit.

---

## 🧪 Tests

```bash
cd backend
source venv/bin/activate
pip install -r requirements-dev.txt
python3 -m pytest tests/ -q
```

They run offline: no database, no vision API, no network. What they cover is the logic that decides
where money ends up — ledger matching, which side of a voucher an amount lands on, reconciliation
against the printed total, and the consensus check across transcription runs.

One of them, `test_match_key_agreement.py`, exists for a specific hazard. The rule that decides
whether two spellings are the same ledger is written three times — as a generated column in
Postgres, in `backend/ledger_matching.py`, and in `frontend/src/lib/ledgers.ts` — because all three
layers need it independently. Three copies is three chances to change one of them, and the symptom
would not be an error: a name would simply match in one part of the system and not another. That
test runs the real TypeScript (via the esbuild Vite already depends on) and compares it against the
Python. To include the Postgres copy as well, point it at a throwaway database:

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" python3 -m pytest tests/ -q
```

---

## 📋 Next Roadmap Steps

- **Deployment**: Vercel (frontend) and Render (backend API). Note that running more than one
  backend instance requires migration `002` — job claiming is what keeps two of them from
  extracting the same voucher.
- **Ledger matching from real usage**: the similarity threshold in `backend/ledger_matching.py`
  was chosen against representative names, not measured against a real chart of accounts. It is
  worth revisiting once there are real vouchers to tune it on.
