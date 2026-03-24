# WhatsApp CRM Pro

Multi-tenant WhatsApp CRM powered by the **official WhatsApp Cloud API** with Supabase backend and modern UI.

---

## Features

- **WhatsApp Cloud API** — official Meta API, no browser/phone dependency
- **Multi-Tenant** — admin creates tenants, each with their own WA number
- **Supabase PostgreSQL** — free cloud database, real-time sync
- **Modern UI** — TailwindCSS, dark/light mode, glassmorphism, responsive
- **Live Chat** — auto-refresh, chat bubbles, typing indicator
- **Lead Management** — status pipeline (New → Contacted → Interested → Sold)
- **Revenue Tracking** — per-lead revenue, pipeline chart
- **Quick Replies** — pre-saved message templates
- **Auto Replies** — keyword-based automatic responses
- **Scheduled Messages** — send messages at a specific time
- **Broadcast** — bulk messaging with configurable delays
- **Rate Limiting** — express-rate-limit for API protection

---

## Requirements

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Supabase account** (free tier — [supabase.com](https://supabase.com))
- **Meta Developer Account** with WhatsApp Cloud API access

---

## Setup Guide

### Step 1: Install Node.js

1. Download Node.js 18+ LTS from https://nodejs.org/
2. Run installer → check "Add to PATH"

### Step 2: Create Supabase Project

1. Go to https://supabase.com and sign up (free)
2. Click **"New Project"**
3. Go to **Settings → API** and copy your **Project URL** and **anon key**

### Step 3: Create Database Tables

1. In Supabase Dashboard → **SQL Editor** → **New Query**
2. Paste the contents of `supabase.sql`, then run
3. If upgrading, also run `migrate-cloud-api.sql`

### Step 4: Configure Environment

Edit `.env` with your values:
```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=your-anon-key
JWT_SECRET=your-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=yourpassword
WEBHOOK_VERIFY_TOKEN=your-verify-token
GRAPH_API_VERSION=v21.0
PORT=3000
```

### Step 5: Install & Run

```bash
npm install
node server.js
```

### Step 6: Configure WhatsApp Cloud API

1. Go to [Meta Developer Dashboard](https://developers.facebook.com/)
2. Create an app → Add **WhatsApp** product
3. Get your **Phone Number ID**, **Access Token**, and **WABA ID**
4. In the admin panel, click **Configure API** on a tenant and enter these credentials
5. Set your webhook URL to `https://your-server.com/webhook` with your verify token

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check + WhatsApp status |
| GET | `/api/connection-status` | Cloud API connection status |
| POST | `/api/send-reply` | Send message via Cloud API |
| GET | `/api/messages` | Get all messages |
| GET | `/api/leads` | Get all leads |
| GET | `/api/active-chats` | Get active conversations |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/webhook` | Webhook verification (Meta) |
| POST | `/webhook` | Incoming messages from Meta |

---

## Production Deployment

### Auto-Restart with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

### Docker

```bash
docker compose up -d
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Supabase errors | Check `.env` values. Ensure tables exist (run `supabase.sql`). |
| Messages not syncing | Check webhook is configured in Meta Dashboard. |
| Webhook not verifying | Ensure `WEBHOOK_VERIFY_TOKEN` matches in `.env` and Meta Dashboard. |
| Port in use | Change `PORT` in `.env` or kill the process using that port. |

---

## License

MIT
