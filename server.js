// ============================================
// Billy777 WhatsApp CRM - Multi-Tenant Server
// ============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── Config ──────────────────────────────────
const PORT = process.env.PORT || 3000;
const MESSAGE_DELAY_MS = parseInt(process.env.MESSAGE_DELAY_MS) || 2500;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CHROME_PATH = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const BCRYPT_ROUNDS = 10;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET) {
  console.log('⚠️  JWT_SECRET not set in .env — using random secret (sessions won\'t persist across restarts)');
}
if (ADMIN_PASSWORD === 'admin123') {
  console.log('⚠️  Using default admin password! Set ADMIN_PASSWORD in .env for production');
}

// ── Supabase Client ─────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Helpers ─────────────────────────────────
function cleanPhone(raw) {
  if (!raw) return '';
  return raw.split('@')[0].replace(/\D/g, '');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const processedMsgIds = new Map(); // tenantId -> Set
function isDuplicate(tenantId, msgId) {
  if (!msgId) return false;
  if (!processedMsgIds.has(tenantId)) processedMsgIds.set(tenantId, new Set());
  const s = processedMsgIds.get(tenantId);
  if (s.has(msgId)) return true;
  s.add(msgId);
  if (s.size > 1000) {
    const arr = [...s];
    arr.slice(0, 500).forEach(id => s.delete(id));
  }
  return false;
}

// ══════════════════════════════════════════════
// TENANT WA CLIENT MANAGER
// ══════════════════════════════════════════════
class TenantWAManager {
  constructor() {
    this.clients = new Map(); // tenantId -> { client, ready, qrCode, manualStatus, scheduledInterval, initializing }
  }

  getState(tenantId) {
    return this.clients.get(String(tenantId)) || null;
  }

  isReady(tenantId) {
    const s = this.getState(tenantId);
    return s ? s.ready : false;
  }

  getQR(tenantId) {
    const s = this.getState(tenantId);
    return s ? s.qrCode : null;
  }

  getClient(tenantId) {
    const s = this.getState(tenantId);
    return s ? s.client : null;
  }

  getStatus(tenantId) {
    const s = this.getState(tenantId);
    if (!s) return 'not_initialized';
    if (s.manualStatus === 'banned') return 'banned';
    if (s.ready) return 'connected';
    if (s.qrCode) return 'waiting_qr';
    if (s.initializing) return 'initializing';
    return 'disconnected';
  }

  async initClient(tenantId) {
    const tid = String(tenantId);

    // Prevent concurrent init for the same tenant
    if (this._initLocks && this._initLocks.has(tid)) {
      console.log(`⚠️  [Tenant ${tid}] Init already in progress, skipping`);
      return this.getState(tid);
    }
    if (!this._initLocks) this._initLocks = new Set();
    this._initLocks.add(tid);

    try {
      return await this._doInitClient(tenantId);
    } finally {
      this._initLocks.delete(tid);
    }
  }

  async _doInitClient(tenantId) {
    const tid = String(tenantId);
    if (this.clients.has(tid) && this.clients.get(tid).client) {
      console.log(`⚠️  Client for tenant ${tid} already exists, destroying first...`);
      await this.destroyClient(tenantId);
    }

    // Remove stale browser lock files before starting
    this._removeBrowserLockSync(tid);

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth', clientId: `tenant_${tid}` }),
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        executablePath: CHROME_PATH,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--disable-gpu',
          '--disable-extensions', '--disable-background-networking', '--disable-default-apps',
          '--disable-sync', '--disable-translate', '--hide-scrollbars',
          '--metrics-recording-only', '--mute-audio', '--no-default-browser-check',
          '--safebrowsing-disable-auto-update',
          '--no-zygote',
          '--disable-software-rasterizer', '--disable-features=site-per-process',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-print-preview',
          '--disable-speech-api',
          '--disk-cache-size=0',
          '--media-cache-size=0',
          '--js-flags=--max-old-space-size=64 --lite-mode --optimize-for-size --gc-interval=100'
        ],
        timeout: 60000
      }
    });

    const state = { client, ready: false, qrCode: null, manualStatus: null, scheduledInterval: null, initializing: true, browserPid: null };
    this.clients.set(tid, state);

    client.on('qr', (qr) => {
      state.qrCode = qr;
      state.initializing = false;
      console.log(`📱 [Tenant ${tid}] QR code generated`);
      qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
      state.ready = true;
      state.qrCode = null;
      state.initializing = false;
      console.log(`✅ [Tenant ${tid}] WhatsApp client READY`);
      this.startScheduledChecker(tenantId);
      // Skip bulkResolveRealPhones to save memory on 512MB instances
    });

    client.on('auth_failure', (msg) => {
      console.error(`❌ [Tenant ${tid}] Auth failure:`, msg);
      state.ready = false;
      state.initializing = false;
      const msgStr = String(msg || '').toUpperCase();
      if (msgStr.includes('401') || msgStr.includes('CONFLICT') || msgStr.includes('BANNED')) {
        state.manualStatus = 'banned';
      } else {
        // Try reconnecting with existing session first (no QR), only wipe session if 2nd attempt also fails
        const attempt = (this._authFailCounts?.get(tid) || 0) + 1;
        if (!this._authFailCounts) this._authFailCounts = new Map();
        this._authFailCounts.set(tid, attempt);
        if (attempt <= 2) {
          console.log(`🔄 [Tenant ${tid}] Auth failure (attempt ${attempt}/2), retrying with saved session in 10s...`);
          setTimeout(async () => {
            try {
              await this.destroyClient(tenantId);
              await this.initClient(tenantId);
            } catch (e) {
              console.error(`❌ [Tenant ${tid}] Reconnect failed:`, e.message);
            }
          }, 10000);
        } else {
          // Session truly corrupted — wipe and re-init (will show QR)
          this._authFailCounts.delete(tid);
          console.log(`🔄 [Tenant ${tid}] Session corrupted after 2 attempts, wiping and re-scanning QR...`);
          setTimeout(async () => {
            try {
              await this.destroyClient(tenantId);
              await this.cleanupSessionFiles(tenantId);
              await this.initClient(tenantId);
            } catch (e) {
              console.error(`❌ [Tenant ${tid}] Session wipe retry failed:`, e.message);
            }
          }, 10000);
        }
      }
    });

    client.on('authenticated', () => {
      // Reset auth fail counter on successful auth
      if (this._authFailCounts) this._authFailCounts.delete(tid);
      state.initializing = false;
      console.log(`🔐 [Tenant ${tid}] WhatsApp authenticated`);
      // Capture browser PID for safe cleanup later
      try {
        const proc = client.pupBrowser?.process();
        if (proc) state.browserPid = proc.pid;
      } catch (_) {}
    });

    client.on('disconnected', (reason) => {
      console.log(`⚠️  [Tenant ${tid}] Disconnected:`, reason);
      state.ready = false;
      state.qrCode = null;
      state.initializing = false;
      const reasonStr = String(reason || '').toUpperCase();
      if (reasonStr.includes('CONFLICT') || reasonStr.includes('BANNED') || reasonStr === '401') {
        state.manualStatus = 'banned';
      } else {
        // Auto-reconnect for ALL reasons including LOGOUT — session files are preserved so no QR needed
        const delayMs = reasonStr === 'LOGOUT' ? 5000 : 15000;
        console.log(`🔄 [Tenant ${tid}] Reconnecting in ${delayMs / 1000}s using saved session (no QR needed)...`);
        setTimeout(() => {
          this.destroyClient(tenantId)
            .then(() => this.initClient(tenantId))
            .catch(e => console.error(`❌ [Tenant ${tid}] Reconnect failed:`, e.message));
        }, delayMs);
      }
    });

    // Message handlers
    this.setupMessageHandlers(tenantId, client);

    console.log(`⏳ [Tenant ${tid}] Initializing WhatsApp client...`);

    // Track retry count to avoid infinite loops
    if (!this._retryCounts) this._retryCounts = new Map();
    const retryCount = this._retryCounts.get(tid) || 0;
    const MAX_RETRIES = 3;

    // Initialize with timeout so it doesn't hang forever
    const INIT_TIMEOUT_MS = 120000;
    await Promise.race([
      client.initialize(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Client init timed out')), INIT_TIMEOUT_MS)
      )
    ]).then(() => {
      // Success — reset retry counter and capture browser PID
      this._retryCounts.delete(tid);
      try {
        const proc = client.pupBrowser?.process();
        if (proc) state.browserPid = proc.pid;
      } catch (_) {}
    }).catch(async (err) => {
      console.error(`❌ [Tenant ${tid}] Init error (attempt ${retryCount + 1}/${MAX_RETRIES}): ${err.message}`);
      state.initializing = false;

      // Fully destroy the failed client and its browser
      await this.destroyClient(tenantId);

      if (retryCount < MAX_RETRIES && !state.qrCode && !state.ready) {
        this._retryCounts.set(tid, retryCount + 1);
        const delayMs = 15000 + (retryCount * 10000); // 15s, 25s, 35s
        console.log(`🔄 [Tenant ${tid}] Will retry init in ${delayMs / 1000}s...`);
        setTimeout(() => {
          this.initClient(tenantId).catch(() => {});
        }, delayMs);
      } else if (retryCount >= MAX_RETRIES) {
        console.error(`🚫 [Tenant ${tid}] Max retries reached. Use admin panel to reconnect manually.`);
        this._retryCounts.delete(tid);
      }
    });

    return state;
  }

  setupMessageHandlers(tenantId, client) {
    const tid = String(tenantId);

    client.on('message', async (msg) => {
      try {
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;
        let phone = cleanPhone(msg.from);
        const body = msg.body || '';
        if (!phone) return;

        const msgId = msg.id?._serialized;
        if (isDuplicate(tid, msgId)) return;
        
        const waJid = msg.from;
        console.log(`📩 [Tenant ${tid}] Incoming from ${phone}: ${body.substring(0, 50)}`);

        await supabase.from('conversations').insert({
          tenant_id: tenantId, phone, message: body,
          direction: 'incoming', status: 'received'
        });

        const { data: existingLead } = await supabase.from('leads')
          .select('id, phone').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle();

        // Use phone from JID directly (skip getContact to save memory)
        const realPhone = phone;

        const isNew = !existingLead;
        if (!existingLead) {
          let source = 'organic';
          const lowerBody = body.toLowerCase();
          if (lowerBody.includes('tips') || lowerBody.includes('ad')) source = 'meta_ads';

          const leadData = {
            tenant_id: tenantId, phone, wa_jid: waJid,
            name: msg._data?.notifyName || 'Unknown',
            source, status: 'new', last_message_at: new Date().toISOString()
          };
          if (realPhone) leadData.real_phone = realPhone;

          await supabase.from('leads').insert(leadData);

          try {
            await supabase.from('activity_log').insert({
              tenant_id: tenantId, phone, action: 'lead_created',
              details: `New lead from ${source}: ${msg._data?.notifyName || 'Unknown'}`
            });
          } catch (_) {}
        } else {
          const updateData = {
            last_message_at: new Date().toISOString(), wa_jid: waJid
          };
          if (realPhone) updateData.real_phone = realPhone;

          await supabase.from('leads').update(updateData)
            .eq('tenant_id', tenantId).eq('phone', phone);
        }

        if (this.isReady(tenantId)) {
          await this.checkAutoReply(tenantId, phone, body, isNew);
        }
      } catch (err) {
        console.error(`❌ [Tenant ${tid}] Incoming message error:`, err.message);
      }
    });

    client.on('message_create', async (msg) => {
      if (!msg.fromMe) return;
      try {
        if (msg.to.includes('@g.us') || msg.to === 'status@broadcast') return;
        const phone = cleanPhone(msg.to);
        if (!phone) return;
        const msgId = msg.id?._serialized;
        if (isDuplicate(tid, msgId)) return;

        await supabase.from('conversations').insert({
          tenant_id: tenantId, phone, message: msg.body || '',
          direction: 'outgoing', status: 'sent'
        });
      } catch (err) {
        console.error(`❌ [Tenant ${tid}] Outgoing message error:`, err.message);
      }
    });
  }

  async checkAutoReply(tenantId, phone, body, isNew) {
    try {
      const { data: rules } = await supabase.from('auto_replies')
        .select('*').eq('tenant_id', tenantId).eq('is_active', true)
        .order('priority', { ascending: false });

      if (!rules || rules.length === 0) return;
      const lowerBody = body.toLowerCase();

      for (const rule of rules) {
        let matched = false;
        if (rule.trigger_type === 'first_message' && isNew) matched = true;
        else if (rule.trigger_type === 'keyword') {
          matched = rule.trigger_value.toLowerCase().split(',').map(k => k.trim()).some(kw => lowerBody === kw);
        } else if (rule.trigger_type === 'contains') {
          matched = rule.trigger_value.toLowerCase().split(',').map(k => k.trim()).some(kw => lowerBody.includes(kw));
        } else if (rule.trigger_type === 'regex') {
          try { matched = new RegExp(rule.trigger_value, 'i').test(body); } catch (_) {}
        }

        if (matched) {
          await supabase.from('auto_replies').update({ usage_count: (rule.usage_count || 0) + 1 }).eq('id', rule.id);
          setTimeout(async () => {
            try {
              const { data: lead } = await supabase.from('leads').select('wa_jid')
                .eq('tenant_id', tenantId).eq('phone', phone).maybeSingle();
              const chatId = lead?.wa_jid || phone + '@c.us';
              const client = this.getClient(tenantId);
              if (client) await client.sendMessage(chatId, rule.reply_message);
              console.log(`🤖 [Tenant ${tenantId}] Auto-reply sent to ${phone}`);
            } catch (e) { console.error('⚠️  Auto-reply send error:', e.message); }
          }, 1500);
          return;
        }
      }
    } catch (err) {
      console.error('⚠️  Auto-reply check error:', err.message);
    }
  }

  async bulkResolveRealPhones(tenantId) {
    const tid = String(tenantId);
    const client = this.getClient(tenantId);
    if (!client) return;

    const { data: leads } = await supabase.from('leads')
      .select('id, phone, wa_jid, real_phone')
      .eq('tenant_id', tenantId)
      .or('real_phone.is.null,real_phone.eq.')
      .limit(10);

    if (!leads || leads.length === 0) return;
    console.log(`🔍 [Tenant ${tid}] Bulk resolving real phones for ${leads.length} leads...`);

    let resolved = 0;
    for (const lead of leads) {
      if (!this.isReady(tenantId)) break;
      try {
        const jid = lead.wa_jid || lead.phone + '@c.us';
        const contact = await client.getContactById(jid);
        if (contact?.number) {
          const num = contact.number.replace(/\D/g, '');
          if (num) {
            await supabase.from('leads').update({ real_phone: num }).eq('id', lead.id);
            resolved++;
          } else {
            // fallback: use JID phone so field is never blank
            await supabase.from('leads').update({ real_phone: lead.phone }).eq('id', lead.id);
          }
        } else {
          // fallback: use JID phone so field is never blank
          await supabase.from('leads').update({ real_phone: lead.phone }).eq('id', lead.id);
        }
      } catch (_) {
        // fallback: use JID phone so field is never blank
        try { await supabase.from('leads').update({ real_phone: lead.phone }).eq('id', lead.id); } catch (_2) {}
      }
      await delay(2000);
    }
    console.log(`✅ [Tenant ${tid}] Bulk resolved ${resolved}/${leads.length} phone numbers`);
  }

  startScheduledChecker(tenantId) {
    const tid = String(tenantId);
    const state = this.clients.get(tid);
    if (!state) return;
    if (state.scheduledInterval) clearInterval(state.scheduledInterval);

    state.scheduledInterval = setInterval(async () => {
      try {
        if (!state.ready) return;
        const { data: pending } = await supabase.from('scheduled_messages')
          .select('*').eq('tenant_id', tenantId).eq('status', 'pending')
          .lte('scheduled_at', new Date().toISOString())
          .order('scheduled_at', { ascending: true }).limit(10);

        if (!pending || pending.length === 0) return;

        for (const sm of pending) {
          try {
            const cleanedPhone = sm.phone.replace(/\D/g, '');
            const { data: lead } = await supabase.from('leads').select('wa_jid')
              .eq('tenant_id', tenantId).eq('phone', cleanedPhone).maybeSingle();
            const chatId = lead?.wa_jid || cleanedPhone + '@c.us';

            await delay(MESSAGE_DELAY_MS);
            await state.client.sendMessage(chatId, sm.message);
            await supabase.from('scheduled_messages')
              .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', sm.id);
            console.log(`⏰ [Tenant ${tid}] Scheduled message sent to ${cleanedPhone}`);
          } catch (e) {
            await supabase.from('scheduled_messages')
              .update({ status: 'failed', error_message: e.message }).eq('id', sm.id);
          }
        }
      } catch (err) {
        console.error(`⚠️  [Tenant ${tid}] Scheduled checker error:`, err.message);
      }
    }, 30000);
  }

  async destroyClient(tenantId) {
    const tid = String(tenantId);
    const state = this.clients.get(tid);
    if (!state) {
      this._removeBrowserLockSync(tid);
      return;
    }
    if (state.scheduledInterval) clearInterval(state.scheduledInterval);

    // 1. Try graceful destroy (with timeout — don't let it hang)
    try {
      await Promise.race([
        state.client.destroy(),
        new Promise(r => setTimeout(r, 8000))
      ]);
    } catch (e) {
      console.log(`⚠️  [Tenant ${tid}] Graceful destroy failed: ${e.message}`);
    }

    // 2. Force-kill the specific browser process by PID (safe — only kills THIS tenant's browser)
    try {
      const browser = state.client?.pupBrowser;
      if (browser) {
        const proc = browser.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }
    } catch (_) {}
    if (state.browserPid) {
      try { process.kill(state.browserPid, 'SIGKILL'); } catch (_) {}
    }

    this.clients.delete(tid);

    // 3. Wait for process to fully die
    await new Promise(r => setTimeout(r, 2000));

    // 4. Remove stale browser lock files
    this._removeBrowserLockSync(tid);

    console.log(`🛑 [Tenant ${tid}] Client destroyed (RAM cleared)`);
  }

  _removeBrowserLockSync(tenantId) {
    const tid = String(tenantId);
    // Check both the symlink path and the real data path (Docker: /app/.wwebjs_auth -> /data/.wwebjs_auth)
    const sessionPaths = [
      path.join(__dirname, '.wwebjs_auth', `session-tenant_${tid}`),
      path.resolve('/data/.wwebjs_auth', `session-tenant_${tid}`)
    ];
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const sessionDir of sessionPaths) {
      for (const lockFile of lockFiles) {
        try { fs.unlinkSync(path.join(sessionDir, lockFile)); } catch (_) {}
      }
      // Also check inside Default profile dir
      for (const lockFile of lockFiles) {
        try { fs.unlinkSync(path.join(sessionDir, 'Default', lockFile)); } catch (_) {}
      }
    }
  }

  async cleanupSessionFiles(tenantId) {
    const tid = String(tenantId);
    const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-tenant_${tid}`);

    // Retry up to 5 times — Windows holds file locks briefly after Chromium exits
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
        console.log(`🧹 [Tenant ${tid}] Session files deleted: ${sessionDir}`);
        return;
      } catch (e) {
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOTEMPTY') {
          if (attempt < 5) {
            await new Promise(r => setTimeout(r, attempt * 1500)); // 1.5s, 3s, 4.5s, 6s
          } else {
            console.warn(`⚠️  [Tenant ${tid}] Session dir partially locked, skipping: ${e.message}`);
          }
        } else {
          console.warn(`⚠️  [Tenant ${tid}] Could not delete session dir: ${e.message}`);
          return;
        }
      }
    }
  }

  async destroyAll() {
    for (const [tid] of this.clients) {
      await this.destroyClient(tid);
    }
  }
}

const waManager = new TenantWAManager();

// ── Initialize All Active Tenants ───────────
async function initAllTenants() {
  try {
    const { data: tenants } = await supabase.from('tenants').select('id, name').eq('is_active', true);
    if (!tenants || tenants.length === 0) {
      console.log('ℹ️  No active tenants found. Create one via admin dashboard.');
      return;
    }
    console.log(`🚀 Initializing ${tenants.length} tenant WA clients...`);
    for (const tenant of tenants) {
      try {
        await waManager.initClient(tenant.id);
      } catch (err) {
        console.error(`❌ Failed to init tenant ${tenant.id} (${tenant.name}):`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Failed to load tenants:', err.message);
  }
}

// ══════════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════════
const app = express();

// Trust Render's reverse proxy for secure cookies & rate limiting
if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many login attempts, please try again later' }
});

const sendLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  message: { error: 'Sending too fast, please wait a moment' }
});

// ── Auth Middleware ──────────────────────────
function verifyToken(req) {
  const token = req.cookies?.crm_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function tenantAuth(req, res, next) {
  const decoded = verifyToken(req);
  if (!decoded || decoded.role !== 'tenant') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Verify tenant still exists and is active in DB
  const { data: tenant } = await supabase.from('tenants')
    .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
  if (!tenant || !tenant.is_active) {
    res.clearCookie('crm_token');
    return res.status(401).json({ error: 'Account deleted or deactivated' });
  }

  req.tenantId = decoded.tenant_id;
  req.tenantName = decoded.name;
  req.tenantUsername = decoded.username;

  // Refresh token on activity (sliding 30-min window)
  const now = Math.floor(Date.now() / 1000);
  const tokenAge = now - (decoded.iat || 0);
  if (tokenAge > 300) { // Refresh if token is older than 5 min
    const newToken = jwt.sign({
      tenant_id: decoded.tenant_id, username: decoded.username,
      name: decoded.name, role: 'tenant'
    }, JWT_SECRET, { expiresIn: '30m' });
    res.cookie('crm_token', newToken, {
      httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax',
      maxAge: 30 * 60 * 1000
    });
  }

  next();
}

function adminAuth(req, res, next) {
  const decoded = verifyToken(req);
  if (!decoded || decoded.role !== 'admin') {
    return res.status(401).json({ error: 'Unauthorized - Admin access required' });
  }
  req.adminUsername = decoded.username;
  next();
}

function anyAuth(req, res, next) {
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  req.userRole = decoded.role;
  if (decoded.role === 'tenant') {
    req.tenantId = decoded.tenant_id;
    req.tenantName = decoded.name;
  }
  next();
}

// ══════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, unique_key } = req.body;
    if (!username || !password || !unique_key) {
      return res.status(400).json({ error: 'Username, password, and unique key are required' });
    }

    const { data: tenant } = await supabase.from('tenants')
      .select('*').eq('username', String(username).trim().toLowerCase())
      .eq('unique_key', String(unique_key).trim())
      .eq('is_active', true).maybeSingle();

    if (!tenant) return res.status(401).json({ error: 'Invalid credentials' });

    const passwordValid = await bcrypt.compare(String(password), tenant.password_hash);
    if (!passwordValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({
      tenant_id: tenant.id, username: tenant.username,
      name: tenant.name, role: 'tenant'
    }, JWT_SECRET, { expiresIn: '30m' });

    res.cookie('crm_token', token, {
      httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax',
      maxAge: 30 * 60 * 1000
    });

    res.json({
      success: true, role: 'tenant',
      user: { id: tenant.id, name: tenant.name, username: tenant.username }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/admin-login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (String(username).trim() !== ADMIN_USERNAME || String(password) !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const token = jwt.sign({ role: 'admin', username: ADMIN_USERNAME }, JWT_SECRET, { expiresIn: '24h' });

    res.cookie('crm_token', token, {
      httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ success: true, role: 'admin', user: { username: ADMIN_USERNAME } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('crm_token');
  res.json({ success: true });
});

app.get('/api/auth/check', async (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ authenticated: false });

  // For tenants, also verify they still exist in DB
  if (decoded.role === 'tenant') {
    const { data: tenant } = await supabase.from('tenants')
      .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
    if (!tenant || !tenant.is_active) {
      res.clearCookie('crm_token');
      return res.status(401).json({ authenticated: false, reason: 'deleted' });
    }
  }

  res.json({
    authenticated: true,
    role: decoded.role,
    username: decoded.username,
    name: decoded.name || decoded.username,
    tenant_id: decoded.tenant_id || null
  });
});

// ══════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════

// ── List Tenants ────────────────────────────
app.get('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tenants')
      .select('id, username, unique_key, name, is_active, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const tenants = (data || []).map(t => ({
      ...t,
      wa_status: waManager.getStatus(t.id)
    }));

    res.json(tenants);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// ── Create Tenant ───────────────────────────
app.post('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Username, password, and name are required' });
    }

    const cleanUsername = String(username).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (cleanUsername.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters (letters, numbers, underscore)' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: existing } = await supabase.from('tenants')
      .select('id').eq('username', cleanUsername).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

    const { data, error } = await supabase.from('tenants').insert({
      username: cleanUsername,
      password_hash,
      name: String(name).substring(0, 100)
    }).select('id, username, unique_key, name, is_active, created_at').single();

    if (error) throw error;

    console.log(`✅ Tenant created: ${data.username} (ID: ${data.id})`);
    res.json({ ...data, password_plain: String(password), wa_status: 'not_initialized' });
  } catch (err) {
    console.error('Create tenant error:', err.message);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// ── Update Tenant ───────────────────────────
app.put('/api/admin/tenants/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, password, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (name !== undefined) updates.name = String(name).substring(0, 100);
    if (is_active !== undefined) updates.is_active = Boolean(is_active);
    if (password && String(password).length >= 6) {
      updates.password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    }

    const { data, error } = await supabase.from('tenants')
      .update(updates).eq('id', id)
      .select('id, username, unique_key, name, is_active, created_at, updated_at').single();
    if (error) throw error;

    res.json({ ...data, wa_status: waManager.getStatus(id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

// ── Delete Tenant ───────────────────────────
app.delete('/api/admin/tenants/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // 1. Kill the in-memory WA client (RAM)
    await waManager.destroyClient(id);

    // 2. Wipe the disk session so the number can be re-linked fresh
    await waManager.cleanupSessionFiles(id);

    // 3. Cascade-delete all DB records for this tenant
    //    (conversations, leads, quick_replies, auto_replies, broadcasts,
    //     broadcast_recipients, scheduled_messages, activity_log, message_templates
    //     are all ON DELETE CASCADE from the tenants FK)
    const { error } = await supabase.from('tenants').delete().eq('id', id);
    if (error) throw error;

    console.log(`🗑️  Tenant ${id} fully purged (RAM + disk + database)`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete tenant error:', err.message);
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

// ── Connect WhatsApp for Tenant ─────────────
app.post('/api/admin/tenants/:id/connect-wa', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: tenant } = await supabase.from('tenants')
      .select('id, name, is_active').eq('id', id).maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.is_active) return res.status(400).json({ error: 'Tenant is deactivated' });

    const existing = waManager.getState(id);
    if (existing && existing.ready) {
      return res.json({ success: true, status: 'already_connected' });
    }

    // If there's a stale/stuck client, destroy it first
    if (existing && !existing.ready) {
      await waManager.destroyClient(id);
    }

    waManager.initClient(id).catch(err => {
      console.error(`❌ WA init error for tenant ${id}:`, err.message);
    });

    res.json({ success: true, status: 'initializing' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to connect WhatsApp' });
  }
});

// ── Disconnect WhatsApp for Tenant ──────────
app.post('/api/admin/tenants/:id/disconnect-wa', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Only destroy the browser process — do NOT call client.logout() which wipes the session
    // This preserves the saved session so reconnect works without QR
    await waManager.destroyClient(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect WhatsApp' });
  }
});

// ── Get QR for Tenant ───────────────────────
app.get('/api/admin/tenants/:id/qr', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const status = waManager.getStatus(id);
    const qrData = waManager.getQR(id);

    if (status === 'connected') return res.json({ ready: true, image: null, status });
    if (!qrData) return res.json({ ready: false, image: null, status });

    const dataUrl = await QRCode.toDataURL(qrData, {
      width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({ ready: false, image: dataUrl, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get QR' });
  }
});

// ── Admin Stats ─────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [tenantsRes, leadsRes, msgsRes] = await Promise.all([
      supabase.from('tenants').select('id', { count: 'exact', head: true }),
      supabase.from('leads').select('id', { count: 'exact', head: true }),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);

    res.json({
      total_tenants: tenantsRes.count || 0,
      total_leads: leadsRes.count || 0,
      messages_today: msgsRes.count || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// ── Tenant Stats for Admin ──────────────────
app.get('/api/admin/tenants/:id/stats', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [leadsRes, msgsRes] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', id),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', id).gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);
    res.json({ leads: leadsRes.count || 0, messages_today: msgsRes.count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tenant stats' });
  }
});

// ── Storage Stats (Admin) ───────────────────
async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirSize(fullPath);
      } else {
        const stat = await fs.promises.stat(fullPath);
        totalSize += stat.size;
      }
    }
  } catch {}
  return totalSize;
}

async function getTenantDiskUsage(tenantId) {
  const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-tenant_${tenantId}`);
  return getDirSize(sessionDir);
}

app.get('/api/admin/storage', adminAuth, async (req, res) => {
  try {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    const totalDisk = await getDirSize(authDir);

    // RAM usage
    const memUsage = process.memoryUsage();
    const ramUsedMB = Math.round(memUsage.rss / 1024 / 1024);
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

    // Active WA clients
    const activeClients = waManager.clients.size;

    // DB row counts
    const [convRes, leadsRes, broadcastRes, schedRes, activityRes, autoRes, qrRes, templateRes] = await Promise.all([
      supabase.from('conversations').select('id', { count: 'exact', head: true }),
      supabase.from('leads').select('id', { count: 'exact', head: true }),
      supabase.from('broadcasts').select('id', { count: 'exact', head: true }),
      supabase.from('scheduled_messages').select('id', { count: 'exact', head: true }),
      supabase.from('activity_log').select('id', { count: 'exact', head: true }),
      supabase.from('auto_replies').select('id', { count: 'exact', head: true }),
      supabase.from('quick_replies').select('id', { count: 'exact', head: true }),
      supabase.from('message_templates').select('id', { count: 'exact', head: true }),
    ]);

    const dbRows = {
      conversations: convRes.count || 0,
      leads: leadsRes.count || 0,
      broadcasts: broadcastRes.count || 0,
      scheduled_messages: schedRes.count || 0,
      activity_log: activityRes.count || 0,
      auto_replies: autoRes.count || 0,
      quick_replies: qrRes.count || 0,
      message_templates: templateRes.count || 0,
    };
    const totalRows = Object.values(dbRows).reduce((a, b) => a + b, 0);

    // Estimated DB size: ~0.5KB per row average
    const estimatedDbSizeMB = Math.round((totalRows * 512) / (1024 * 1024) * 100) / 100;

    // Configurable limits (from env or auto-detect)
    const diskLimitMB = parseInt(process.env.DISK_LIMIT_MB) || 1024;   // 1GB default
    const ramLimitMB = parseInt(process.env.RAM_LIMIT_MB) || Math.round(os.totalmem() / (1024 * 1024)); // Auto-detect system RAM
    const dbLimitMB = parseInt(process.env.DB_LIMIT_MB) || 500;        // 500MB Supabase free tier

    res.json({
      disk: {
        used_bytes: totalDisk,
        used_mb: Math.round(totalDisk / (1024 * 1024) * 100) / 100,
        limit_mb: diskLimitMB,
        percent: Math.min(100, Math.round((totalDisk / (diskLimitMB * 1024 * 1024)) * 100)),
      },
      ram: {
        rss_mb: ramUsedMB,
        heap_used_mb: heapUsedMB,
        heap_total_mb: heapTotalMB,
        limit_mb: ramLimitMB,
        percent: Math.min(100, Math.round((ramUsedMB / ramLimitMB) * 100)),
        active_clients: activeClients,
      },
      database: {
        rows: dbRows,
        total_rows: totalRows,
        estimated_mb: estimatedDbSizeMB,
        limit_mb: dbLimitMB,
        percent: Math.min(100, Math.round((estimatedDbSizeMB / dbLimitMB) * 100)),
      },
      uptime_seconds: Math.floor(process.uptime()),
    });
  } catch (err) {
    console.error('Storage stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// ── Per-Tenant Storage Breakdown ────────────
app.get('/api/admin/storage/tenants', adminAuth, async (req, res) => {
  try {
    const { data: allTenants } = await supabase.from('tenants').select('id, name, username');
    if (!allTenants) return res.json([]);

    const breakdown = await Promise.all(allTenants.map(async (t) => {
      const [diskBytes, convRes, leadsRes, broadcastsRes] = await Promise.all([
        getTenantDiskUsage(t.id),
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('broadcasts').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
      ]);

      const convCount = convRes.count || 0;
      const leadsCount = leadsRes.count || 0;
      const broadcastsCount = broadcastsRes.count || 0;
      const totalRows = convCount + leadsCount + broadcastsCount;
      const waStatus = waManager.getStatus(t.id);
      const isUsingRam = waManager.clients.has(String(t.id));

      return {
        id: t.id,
        name: t.name,
        username: t.username,
        disk_bytes: diskBytes,
        disk_mb: Math.round(diskBytes / (1024 * 1024) * 100) / 100,
        db_rows: { conversations: convCount, leads: leadsCount, broadcasts: broadcastsCount },
        total_rows: totalRows,
        estimated_db_mb: Math.round((totalRows * 512) / (1024 * 1024) * 100) / 100,
        wa_status: waStatus,
        using_ram: isUsingRam,
      };
    }));

    // Sort by total usage descending
    breakdown.sort((a, b) => (b.disk_bytes + b.total_rows) - (a.disk_bytes + a.total_rows));
    res.json(breakdown);
  } catch (err) {
    console.error('Tenant storage breakdown error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tenant storage breakdown' });
  }
});

// ── Cleanup Old Conversations ───────────────
app.post('/api/admin/storage/cleanup', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 90;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const { count } = await supabase.from('conversations')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff);
    console.log(`🧹 Cleanup: Deleted ${count || 0} conversations older than ${days} days`);
    res.json({ deleted: count || 0, days });
  } catch (err) {
    console.error('Cleanup error:', err.message);
    res.status(500).json({ error: 'Failed to cleanup' });
  }
});

// ── Cleanup Orphaned Session Folders ────────
app.post('/api/admin/storage/cleanup-orphans', adminAuth, async (req, res) => {
  try {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    const { data: allTenants } = await supabase.from('tenants').select('id');
    const validIds = new Set((allTenants || []).map(t => String(t.id)));

    let cleaned = 0;
    let freedBytes = 0;
    try {
      const entries = await fs.promises.readdir(authDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('session-tenant_')) continue;
        const tid = entry.name.replace('session-tenant_', '');
        if (!validIds.has(tid)) {
          const dirPath = path.join(authDir, entry.name);
          const size = await getDirSize(dirPath);
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          freedBytes += size;
          cleaned++;
          console.log(`🧹 Removed orphaned session: ${entry.name} (${Math.round(size / 1024)}KB)`);
        }
      }
    } catch {}
    res.json({ cleaned, freed_bytes: freedBytes, freed_mb: Math.round(freedBytes / (1024 * 1024) * 100) / 100 });
  } catch (err) {
    console.error('Orphan cleanup error:', err.message);
    res.status(500).json({ error: 'Failed to cleanup orphans' });
  }
});

// ══════════════════════════════════════════════
// TENANT API ROUTES (all scoped by tenant_id)
// ══════════════════════════════════════════════

// ── Health / Status ─────────────────────────
// Public health check (used by Render to verify the service is alive)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Tenant-specific health (requires auth)
app.get('/api/tenant-health', tenantAuth, (req, res) => {
  const status = waManager.getStatus(req.tenantId);
  res.json({
    status: 'ok', whatsapp: status,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/qr-status', tenantAuth, (req, res) => {
  const status = waManager.getStatus(req.tenantId);
  const qr = waManager.getQR(req.tenantId);
  res.json({
    ready: status === 'connected',
    qr,
    banned: status === 'banned',
    initializing: status === 'initializing',
    status
  });
});

app.get('/api/qr-image', tenantAuth, async (req, res) => {
  const ready = waManager.isReady(req.tenantId);
  if (ready) return res.json({ ready: true, image: null });
  const qrData = waManager.getQR(req.tenantId);
  if (!qrData) return res.json({ ready: false, image: null });
  try {
    const dataUrl = await QRCode.toDataURL(qrData, {
      width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({ ready: false, image: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── Send Reply ──────────────────────────────
app.post('/api/send-reply', tenantAuth, sendLimiter, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message are required' });

    const client = waManager.getClient(req.tenantId);
    if (!client || !waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    let chatId;
    const { data: lead } = await supabase.from('leads')
      .select('wa_jid').eq('tenant_id', req.tenantId).eq('phone', cleanedPhone).maybeSingle();

    if (lead?.wa_jid) {
      chatId = lead.wa_jid;
    } else {
      try {
        const numberId = await client.getNumberId(cleanedPhone);
        if (numberId) chatId = numberId._serialized;
      } catch (_) {}
      if (!chatId) chatId = cleanedPhone + '@c.us';
    }

    await delay(MESSAGE_DELAY_MS);
    if (!waManager.isReady(req.tenantId)) return res.status(503).json({ error: 'WhatsApp disconnected' });

    await client.sendMessage(chatId, message);

    // Try to resolve real phone if not already set
    const updateData = { last_message_at: new Date().toISOString() };
    try {
      const { data: leadCheck } = await supabase.from('leads')
        .select('real_phone').eq('tenant_id', req.tenantId).eq('phone', cleanedPhone).maybeSingle();
      if (leadCheck && !leadCheck.real_phone) {
        const contact = await client.getContactById(chatId);
        if (contact?.number) {
          const num = contact.number.replace(/\D/g, '');
          if (num) updateData.real_phone = num;
        }
      }
    } catch (_) {}

    await supabase.from('leads')
      .update(updateData)
      .eq('tenant_id', req.tenantId).eq('phone', cleanedPhone);

    res.json({ success: true, phone: cleanedPhone });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

// ── Messages ────────────────────────────────
app.get('/api/messages', tenantAuth, async (req, res) => {
  try {
    const { phone, limit = 50 } = req.query;
    let query = supabase.from('conversations').select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false }).limit(parseInt(limit));
    if (phone) query = query.eq('phone', phone);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/messages/:phone', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const { data, error } = await supabase.from('conversations')
      .select('*').eq('tenant_id', req.tenantId).eq('phone', phone)
      .order('created_at', { ascending: true }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

app.post('/api/messages/:phone/read', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    await supabase.from('conversations')
      .update({ status: 'read' })
      .eq('tenant_id', req.tenantId).eq('phone', phone)
      .eq('direction', 'incoming').eq('status', 'received');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ── Leads ───────────────────────────────────
app.get('/api/leads', tenantAuth, async (req, res) => {
  try {
    const { status, source } = req.query;
    let query = supabase.from('leads').select('*')
      .eq('tenant_id', req.tenantId)
      .order('last_message_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

app.put('/api/leads/:phone', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const { name, status, revenue, tags, notes, source, email, company, assigned_to, real_phone } = req.body;
    const updates = {};

    if (name !== undefined) updates.name = String(name).substring(0, 100);
    if (real_phone !== undefined) updates.real_phone = String(real_phone).substring(0, 30);
    if (email !== undefined) updates.email = String(email).substring(0, 150);
    if (company !== undefined) updates.company = String(company).substring(0, 150);
    if (assigned_to !== undefined) updates.assigned_to = String(assigned_to).substring(0, 100);
    if (status !== undefined) {
      const valid = ['new', 'contacted', 'interested', 'negotiation', 'sold', 'lost'];
      if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      updates.status = status;
    }
    if (revenue !== undefined) updates.revenue = parseFloat(revenue) || 0;
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];
    if (notes !== undefined) updates.notes = String(notes).substring(0, 5000);
    if (source !== undefined) updates.source = String(source).substring(0, 50);

    const { data, error } = await supabase.from('leads')
      .update(updates).eq('tenant_id', req.tenantId).eq('phone', phone).select().single();
    if (error) throw error;

    await supabase.from('activity_log').insert({
      tenant_id: req.tenantId, phone, action: 'lead_updated',
      details: `Updated: ${Object.keys(updates).join(', ')}`
    }).catch(() => {});

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

app.delete('/api/leads/:phone', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    await supabase.from('conversations').delete().eq('tenant_id', req.tenantId).eq('phone', phone);
    await supabase.from('leads').delete().eq('tenant_id', req.tenantId).eq('phone', phone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

app.post('/api/leads/:phone/resolve', tenantAuth, async (req, res) => {
  try {
    const client = waManager.getClient(req.tenantId);
    if (!client || !waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    const phone = req.params.phone.replace(/\D/g, '');
    const { data: lead } = await supabase.from('leads')
      .select('id, wa_jid, real_phone').eq('tenant_id', req.tenantId).eq('phone', phone).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const jid = lead.wa_jid || phone + '@c.us';
    let resolved = null;
    try {
      const contact = await client.getContactById(jid);
      if (contact?.number) {
        const num = contact.number.replace(/\D/g, '');
        if (num) resolved = num;
      }
    } catch (e) {}

    // Always save — fallback to JID phone if getContactById returned nothing
    if (!resolved) resolved = phone;
    await supabase.from('leads').update({ real_phone: resolved }).eq('id', lead.id);
    res.json({ success: true, real_phone: resolved });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve phone' });
  }
});

// ── Stats ───────────────────────────────────
app.get('/api/stats', tenantAuth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const [leadsRes, soldRes, newRes, intRes, contRes, revenueRes, msgsRes, inRes, outRes] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'sold'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'new'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'interested'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'contacted'),
      supabase.from('leads').select('revenue').eq('tenant_id', tid),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tid).gte('created_at', new Date(Date.now() - 86400000).toISOString()),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tid).eq('direction', 'incoming').gte('created_at', new Date(Date.now() - 86400000).toISOString()),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tid).eq('direction', 'outgoing').gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);

    const totalRevenue = (revenueRes.data || []).reduce((sum, l) => sum + (parseFloat(l.revenue) || 0), 0);

    res.json({
      total_leads: leadsRes.count || 0, new_leads: newRes.count || 0,
      sold_leads: soldRes.count || 0, interested_leads: intRes.count || 0,
      contacted_leads: contRes.count || 0, total_revenue: totalRevenue,
      messages_today: msgsRes.count || 0, incoming_today: inRes.count || 0,
      outgoing_today: outRes.count || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/stats/trends', tenantAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabase.from('conversations')
      .select('direction, created_at').eq('tenant_id', req.tenantId)
      .gte('created_at', since).order('created_at', { ascending: true });
    if (error) throw error;

    const trends = {};
    (data || []).forEach(msg => {
      const day = new Date(msg.created_at).toISOString().split('T')[0];
      if (!trends[day]) trends[day] = { incoming: 0, outgoing: 0 };
      trends[day][msg.direction]++;
    });
    res.json(trends);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// ── Quick Replies CRUD ──────────────────────
app.get('/api/quick-replies', tenantAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('quick_replies')
      .select('*').eq('tenant_id', req.tenantId).order('id');
    if (error) throw error;
    const seen = new Set();
    const unique = (data || []).filter(r => {
      if (seen.has(r.title)) return false;
      seen.add(r.title); return true;
    });
    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quick replies' });
  }
});

app.post('/api/quick-replies', tenantAuth, async (req, res) => {
  try {
    const { title, message, category, shortcut } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    const { data, error } = await supabase.from('quick_replies').insert({
      tenant_id: req.tenantId,
      title: String(title).substring(0, 100),
      message: String(message).substring(0, 2000),
      category: String(category || 'general').substring(0, 50),
      shortcut: shortcut ? String(shortcut).substring(0, 30) : null
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create quick reply' });
  }
});

app.put('/api/quick-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, message, category, shortcut } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = String(title).substring(0, 100);
    if (message !== undefined) updates.message = String(message).substring(0, 2000);
    if (category !== undefined) updates.category = String(category).substring(0, 50);
    if (shortcut !== undefined) updates.shortcut = shortcut ? String(shortcut).substring(0, 30) : null;
    const { data, error } = await supabase.from('quick_replies')
      .update(updates).eq('id', id).eq('tenant_id', req.tenantId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quick reply' });
  }
});

app.delete('/api/quick-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('quick_replies').delete().eq('id', id).eq('tenant_id', req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quick reply' });
  }
});

// ── Auto-Replies CRUD ───────────────────────
app.get('/api/auto-replies', tenantAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('auto_replies')
      .select('*').eq('tenant_id', req.tenantId).order('priority', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch auto-replies' });
  }
});

app.post('/api/auto-replies', tenantAuth, async (req, res) => {
  try {
    const { name, trigger_type, trigger_value, reply_message, is_active, priority } = req.body;
    if (!name || !trigger_value || !reply_message) {
      return res.status(400).json({ error: 'Name, trigger value, and reply message required' });
    }
    const validTypes = ['keyword', 'contains', 'regex', 'first_message'];
    const { data, error } = await supabase.from('auto_replies').insert({
      tenant_id: req.tenantId,
      name: String(name).substring(0, 100),
      trigger_type: validTypes.includes(trigger_type) ? trigger_type : 'keyword',
      trigger_value: String(trigger_value).substring(0, 500),
      reply_message: String(reply_message).substring(0, 2000),
      is_active: is_active !== false,
      priority: parseInt(priority) || 0
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create auto-reply' });
  }
});

app.put('/api/auto-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, trigger_type, trigger_value, reply_message, is_active, priority } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = String(name).substring(0, 100);
    if (trigger_type !== undefined) updates.trigger_type = trigger_type;
    if (trigger_value !== undefined) updates.trigger_value = String(trigger_value).substring(0, 500);
    if (reply_message !== undefined) updates.reply_message = String(reply_message).substring(0, 2000);
    if (is_active !== undefined) updates.is_active = Boolean(is_active);
    if (priority !== undefined) updates.priority = parseInt(priority) || 0;
    const { data, error } = await supabase.from('auto_replies')
      .update(updates).eq('id', id).eq('tenant_id', req.tenantId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update auto-reply' });
  }
});

app.delete('/api/auto-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('auto_replies').delete().eq('id', id).eq('tenant_id', req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete auto-reply' });
  }
});

// ── Broadcasts ──────────────────────────────
app.get('/api/broadcasts', tenantAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('broadcasts')
      .select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

app.post('/api/broadcasts', tenantAuth, async (req, res) => {
  try {
    const { name, message, filter_status } = req.body;
    if (!name || !message) return res.status(400).json({ error: 'Name and message required' });

    let query = supabase.from('leads').select('phone').eq('tenant_id', req.tenantId);
    if (filter_status) query = query.eq('status', filter_status);
    const { data: targets } = await query;
    const targetCount = (targets || []).length;

    const { data, error } = await supabase.from('broadcasts').insert({
      tenant_id: req.tenantId,
      name: String(name).substring(0, 150),
      message: String(message).substring(0, 4096),
      target_filter: filter_status ? { status: filter_status } : {},
      target_count: targetCount, status: 'draft'
    }).select().single();
    if (error) throw error;

    if (targets && targets.length > 0) {
      const recipients = targets.map(t => ({
        broadcast_id: data.id, phone: t.phone, status: 'pending'
      }));
      await supabase.from('broadcast_recipients').insert(recipients);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

app.post('/api/broadcasts/:id/send', tenantAuth, async (req, res) => {
  try {
    const client = waManager.getClient(req.tenantId);
    if (!client || !waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const id = parseInt(req.params.id);
    const { data: broadcast } = await supabase.from('broadcasts')
      .select('*').eq('id', id).eq('tenant_id', req.tenantId).single();
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    if (broadcast.status === 'sending') return res.status(400).json({ error: 'Already sending' });
    if (broadcast.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    await supabase.from('broadcasts')
      .update({ status: 'sending', started_at: new Date().toISOString() }).eq('id', id);

    sendBroadcastAsync(req.tenantId, id, broadcast.message);
    res.json({ success: true, message: 'Broadcast started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start broadcast' });
  }
});

async function sendBroadcastAsync(tenantId, broadcastId, message) {
  try {
    const { data: recipients } = await supabase.from('broadcast_recipients')
      .select('*').eq('broadcast_id', broadcastId).eq('status', 'pending');

    let sentCount = 0, failedCount = 0;
    for (const recipient of (recipients || [])) {
      try {
        const client = waManager.getClient(tenantId);
        if (!client || !waManager.isReady(tenantId)) {
          await supabase.from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'WhatsApp disconnected' }).eq('id', recipient.id);
          failedCount++; continue;
        }

        const cleanedPhone = recipient.phone.replace(/\D/g, '');
        const { data: lead } = await supabase.from('leads').select('wa_jid')
          .eq('tenant_id', tenantId).eq('phone', cleanedPhone).maybeSingle();
        const chatId = lead?.wa_jid || cleanedPhone + '@c.us';

        await delay(MESSAGE_DELAY_MS + Math.random() * 2000);
        await client.sendMessage(chatId, message);
        await supabase.from('broadcast_recipients')
          .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', recipient.id);
        sentCount++;
      } catch (e) {
        await supabase.from('broadcast_recipients')
          .update({ status: 'failed', error_message: e.message }).eq('id', recipient.id);
        failedCount++;
      }
    }

    await supabase.from('broadcasts').update({
      status: 'completed', sent_count: sentCount, failed_count: failedCount,
      completed_at: new Date().toISOString()
    }).eq('id', broadcastId);
  } catch (err) {
    console.error('❌ Broadcast error:', err.message);
    await supabase.from('broadcasts').update({ status: 'cancelled' }).eq('id', broadcastId);
  }
}

app.delete('/api/broadcasts/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('broadcast_recipients').delete().eq('broadcast_id', id);
    await supabase.from('broadcasts').delete().eq('id', id).eq('tenant_id', req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// ── Scheduled Messages ──────────────────────
app.get('/api/scheduled', tenantAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('scheduled_messages')
      .select('*').eq('tenant_id', req.tenantId).order('scheduled_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scheduled messages' });
  }
});

app.post('/api/scheduled', tenantAuth, async (req, res) => {
  try {
    const { phone, message, scheduled_at } = req.body;
    if (!phone || !message || !scheduled_at) {
      return res.status(400).json({ error: 'Phone, message, and scheduled_at required' });
    }
    const cleanedPhone = phone.replace(/\D/g, '');
    const { data, error } = await supabase.from('scheduled_messages').insert({
      tenant_id: req.tenantId, phone: cleanedPhone,
      message: String(message).substring(0, 4096),
      scheduled_at: new Date(scheduled_at).toISOString(), status: 'pending'
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to schedule message' });
  }
});

app.delete('/api/scheduled/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('scheduled_messages')
      .update({ status: 'cancelled' }).eq('id', id)
      .eq('tenant_id', req.tenantId).eq('status', 'pending');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel scheduled message' });
  }
});

// ── Import / Export ─────────────────────────
app.post('/api/leads/import', tenantAuth, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }

    let imported = 0, skipped = 0;
    for (const contact of contacts.slice(0, 500)) {
      try {
        const phone = String(contact.phone || '').replace(/\D/g, '');
        if (!phone || phone.length < 7) { skipped++; continue; }

        const { data: existing } = await supabase.from('leads')
          .select('id').eq('tenant_id', req.tenantId).eq('phone', phone).maybeSingle();
        if (existing) { skipped++; continue; }

        await supabase.from('leads').insert({
          tenant_id: req.tenantId, phone,
          real_phone: String(contact.phone || '').trim(),
          name: String(contact.name || 'Unknown').substring(0, 100),
          source: 'import', status: 'new', tags: []
        });
        imported++;
      } catch (e) { skipped++; }
    }

    res.json({ success: true, imported, skipped, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

app.get('/api/leads/export', tenantAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('leads')
      .select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export leads' });
  }
});

// ── Active Chats ────────────────────────────
app.get('/api/active-chats', tenantAuth, async (req, res) => {
  try {
    const { data: leads, error } = await supabase.from('leads')
      .select('*').eq('tenant_id', req.tenantId)
      .order('last_message_at', { ascending: false }).limit(100);
    if (error) throw error;

    const chats = await Promise.all(
      (leads || []).map(async (lead) => {
        const { data: msgs } = await supabase.from('conversations')
          .select('message, direction, created_at')
          .eq('tenant_id', req.tenantId).eq('phone', lead.phone)
          .order('created_at', { ascending: false }).limit(1);

        const unreadRes = await supabase.from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', req.tenantId).eq('phone', lead.phone)
          .eq('direction', 'incoming').eq('status', 'received');

        return { ...lead, real_phone: lead.real_phone || lead.phone, last_message: msgs?.[0] || null, unread_count: unreadRes.count || 0 };
      })
    );

    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch active chats' });
  }
});

// ══════════════════════════════════════════════
// PAGE ROUTES
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded) return res.redirect('/login');
  if (decoded.role === 'admin') return res.redirect('/admin');
  return res.redirect('/crm');
});

app.get('/login', (req, res) => {
  // Only redirect admins back to admin panel; never redirect tenants (they might be stuck on overlay)
  const decoded = verifyToken(req);
  if (decoded && decoded.role === 'admin') {
    return res.redirect('/admin');
  }
  // Clear tenant cookie so they can re-login
  if (decoded && decoded.role === 'tenant') {
    res.clearCookie('crm_token');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded || decoded.role !== 'admin') return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/crm', async (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded || decoded.role !== 'tenant') return res.redirect('/login');

  // Verify tenant still exists
  const { data: tenant } = await supabase.from('tenants')
    .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
  if (!tenant || !tenant.is_active) {
    res.clearCookie('crm_token');
    return res.redirect('/login');
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.redirect('/');
});

// ══════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Billy777 WhatsApp CRM - Multi-Tenant        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   🌐 Dashboard: http://localhost:${PORT}          ║`);
  console.log(`║   👤 Admin:     ${ADMIN_USERNAME}                          ║`);
  console.log('║   📡 API: /api/health                        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  initAllTenants();
});

// ── Graceful Shutdown ───────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await waManager.destroyAll();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  // Suppress Windows file-lock errors from Chromium session cleanup
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')) return;
  console.error('Unhandled rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  // Don't exit — keep the server alive
});
