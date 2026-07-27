# Scan2Tally - Automated Handwritten Receipt to Tally Accounting Bridge

> **Scan2Tally** converts physical handwritten paper bill and receipt photos into structured accounting data and generates Excel files (`.xlsx`) formatted specifically for 1-click import into **Tally Prime** / **Tally ERP 9**.

---

## 🎯 Problem & Automated Workflow

### The Problem
Store and office staff write transaction details **by hand on paper receipts**. Accountants then spend hours re-typing every single handwritten bill into Excel line-by-line before importing it into Tally. This manual entry is time-consuming, causes fatigue, and leads to typographical errors.

### The Scan2Tally Solution
1. **Snap / Scan**: Staff snap a photo of the handwritten paper receipt using a mobile phone, tablet, or scanner.
2. **AI Extraction**: Scan2Tally sharpens the image and extracts the Date, Voucher Type, Debit/Credit Ledgers, Amounts, and Narrations automatically.
3. **Side-by-Side Verification**: Accountants double-check and edit entries on a clean side-by-side verification screen with automatic Debit == Credit balance checks.
4. **1-Click Tally Import**: Scan2Tally generates a standard Tally Prime importable Excel spreadsheet (`.xlsx`).

---

## 🚀 Accomplishments So Far

### ✅ Phase 1: Database & Supabase Infrastructure (Complete)
- Created [`supabase_schema.sql`](./supabase_schema.sql) containing full PostgreSQL DDL for 6 core tables (`organizations`, `users`, `scan_batches`, `receipts`, `transactions`, `exports`).
- Implemented **Row Level Security (RLS)** with helper functions (`get_auth_user_org_id()`, `get_auth_user_role()`) to guarantee strict multi-tenant client data isolation.

### ✅ Phase 2: React TypeScript (TSX) Web Interface (Complete)
- Built a modern, fast React 18 + Vite SPA using **Strict TypeScript (TSX)** and modern CSS design tokens.
- **3-Tier Role Permission System**:
  - `Super Admin`: Platform owner panel for managing client organizations and global cloud storage.
  - `Admin`: Client company manager overview.
  - `Operator`: Data entry staff workspace for managing batches and uploading receipts.
- **Scan Batch Hub**: Batch creation, renaming, and drag-and-drop receipt file upload.
- **Side-by-Side Reviewer**: Original paper receipt image on the left, editable Tally transaction table on the right with live total calculation.
- **Tally Excel Exporter**: Preview and 1-click download of Tally Prime `.xlsx` spreadsheets.

### ✅ Phase 3 Foundation: Python FastAPI Backend (Complete)
- Built FastAPI API server (`backend/main.py`) with CORS middleware, image preprocessing hooks, and openpyxl Tally Excel builder.

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend Web App** | React 18, Vite, TypeScript (TSX), Vanilla CSS, Lucide Icons, Supabase JS SDK |
| **Backend API** | Python 3, FastAPI, Uvicorn, OpenCV, Pillow, OpenPyXL, Pandas |
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

The bucket is deliberately **private**: receipt images are served through
short-lived signed URLs, so one organization cannot read another's scans by
guessing a path.

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

## 📋 Next Roadmap Steps

- **Phase 3 (In Progress)**: Connect live Gemini Vision AI API to `backend/main.py` for parsing real uploaded handwritten receipt photos.
- **Phase 4**: Full multi-tenant client signup and custom ledger auto-complete rules per organization.
- **Phase 5**: Production deployment to Vercel and Render.
