# WhatsApp CRM Pro

PC-Only WhatsApp CRM with Supabase backend, modern UI, and Meta Ads integration.

**Zero phone dependency** after first QR scan (WhatsApp multi-device).

---

## Features

- **WhatsApp Web.js** with LocalAuth — session persists forever after one QR scan
- **Supabase PostgreSQL** — free cloud database, real-time sync
- **Modern UI** — TailwindCSS, dark/light mode, glassmorphism, responsive
- **Live Chat** — 5-second auto-refresh, chat bubbles, typing indicator
- **Lead Management** — status pipeline (New → Contacted → Interested → Sold)
- **Revenue Tracking** — per-lead revenue, pipeline chart
- **Quick Replies** — pre-saved message templates
- **Meta Ads Integration** — auto-captures "Click-to-WhatsApp" leads
- **Anti-Ban** — configurable message delays (default 2.5s)
- **Rate Limiting** — express-rate-limit for API protection

---

## Requirements

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Google Chrome** or Chromium (for Puppeteer)
- **Supabase account** (free tier — [supabase.com](https://supabase.com))

---

## Setup Guide (Windows)

### Step 1: Install Node.js

1. Download Node.js 18+ LTS from https://nodejs.org/
2. Run installer → check "Add to PATH"
3. Verify: open PowerShell → `node --version` → should show v18+

### Step 2: Create Supabase Project

1. Go to https://supabase.com and sign up (free)
2. Click **"New Project"**
3. Choose a name, set database password, select region
4. Wait for project to provision (~2 minutes)
5. Go to **Settings → API**:
   - Copy **Project URL** → this is your `SUPABASE_URL`
   - Copy **anon/public key** → this is your `SUPABASE_KEY`

### Step 3: Create Database Tables

1. In Supabase Dashboard → **SQL Editor** → **New Query**
2. Paste the entire contents of `supabase.sql`
3. Click **Run** — all tables, indexes, and seed data will be created

### Step 4: Configure Environment

```bash
cd whatsapp-crm-pro
copy .env.example .env
```

Edit `.env` with your values:
```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIs...your-key-here
PORT=3000
MESSAGE_DELAY_MS=2500
```

### Step 5: Install & Run

```bash
npm install
npm run dev
```

### Step 6: Scan QR Code

1. A QR code appears in the terminal
2. Open **WhatsApp** on your phone → **Settings** → **Linked Devices** → **Link a Device**
3. Scan the QR code
4. Done! Session is saved permanently. Phone can go offline after this.

### Step 7: Open Dashboard

Open browser → http://localhost:3000

---

## Meta Ads "Click-to-WhatsApp" Setup

### Configure Meta Business Suite

1. Go to **Meta Business Suite** → **Ads Manager**
2. Create a new campaign → Choose **Messages** objective
3. Select **Click to WhatsApp** as destination
4. Set your WhatsApp Business number
5. In ad creative, set the greeting message to include a keyword like `"TIPS"`:
   - Example: *"Reply TIPS to get our exclusive guide!"*

### How It Works

```
User clicks Meta Ad → WhatsApp opens → User sends "TIPS"
→ Your PC captures the message automatically
→ Saved to Supabase with source = "meta_ads"
→ CRM Dashboard shows instantly with Meta Ad badge
→ You reply manually from CRM → WhatsApp delivers instantly
→ Full conversation history tracked
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check + WhatsApp status |
| GET | `/api/qr-status` | QR code status for initial setup |
| POST | `/api/send-reply` | Send message from CRM → WhatsApp |
| GET | `/api/messages` | Get all messages (with optional `?phone=` filter) |
| GET | `/api/messages/:phone` | Get chat history for a specific contact |
| POST | `/api/messages/:phone/read` | Mark messages as read |
| GET | `/api/leads` | Get all leads (with optional `?status=` filter) |
| PUT | `/api/leads/:phone` | Update lead details |
| DELETE | `/api/leads/:phone` | Delete lead and all messages |
| GET | `/api/active-chats` | Get leads with last message + unread count |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/stats/revenue-by-status` | Revenue grouped by pipeline status |
| GET | `/api/quick-replies` | Get quick reply templates |

### Send a Message (cURL)

```bash
curl -X POST http://localhost:3000/api/send-reply ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\":\"919876543210\",\"message\":\"Hello from CRM!\"}"
```

---

## Production Deployment (Windows)

### Auto-Restart with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

PM2 will auto-restart the server if it crashes and can start on Windows boot.

### View Logs

```bash
pm2 logs whatsapp-crm
```

### Monitor

```bash
pm2 monit
```

---

## File Structure

```
whatsapp-crm-pro/
├── package.json          # Dependencies & scripts
├── server.js             # Express API + WhatsApp client + Supabase
├── supabase.sql          # Database schema (run in Supabase SQL Editor)
├── ecosystem.config.js   # PM2 configuration
├── .env.example          # Environment template
├── .env                  # Your actual config (not in git)
├── public/
│   ├── index.html        # CRM Dashboard (TailwindCSS)
│   ├── style.css         # Custom styles + animations
│   └── script.js         # Frontend logic + auto-refresh
├── docker-compose.yml    # Optional Docker setup
└── README.md             # This file
```

---

## Anti-Ban Best Practices

- **Message delay**: Default 2.5s between sends (configurable via `MESSAGE_DELAY_MS`)
- **Rate limiting**: API calls limited to 30/minute by default
- **No bulk sending**: This CRM is for manual, 1-to-1 conversations
- **Use a dedicated number**: Don't use your personal WhatsApp
- **Avoid links in first message**: WhatsApp flags link-heavy first contacts
- **Warm up gradually**: Start with 10-20 replies/day, increase over weeks

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| QR not appearing | Ensure Chrome/Chromium is installed. Delete `.wwebjs_auth` folder and restart. |
| Session lost | Delete `.wwebjs_auth` folder → restart → re-scan QR |
| Puppeteer crash | Run `npm install` again. On Windows, ensure Visual C++ Build Tools are installed. |
| Supabase errors | Check `.env` values. Ensure tables exist (run `supabase.sql`). |
| Messages not syncing | Check server logs. Ensure WhatsApp shows "Connected" in dashboard. |
| Port in use | Change `PORT` in `.env` or kill the process using that port. |

---

## License

MIT
