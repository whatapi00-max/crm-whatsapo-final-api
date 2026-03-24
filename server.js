// ============================================
// Billy777 WhatsApp CRM - Multi-Tenant Server
// WhatsApp Cloud API Edition
// ============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'billy777_verify';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const BCRYPT_ROUNDS = 10;

if (!process.env.JWT_SECRET) {
  console.log('⚠️  JWT_SECRET not set in .env — using random secret (sessions won\'t persist across restarts)');
}
if (ADMIN_PASSWORD === 'admin123') {
  console.log('⚠️  Using default admin password! Set ADMIN_PASSWORD in .env for production');
}
if (!process.env.WEBHOOK_VERIFY_TOKEN) {
  console.log('⚠️  WEBHOOK_VERIFY_TOKEN not set in .env — using default "billy777_verify"');
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
  if (s.size > 5000) {
    const arr = [...s];
    arr.slice(0, 2500).forEach(id => s.delete(id));
  }
  return false;
}

// ══════════════════════════════════════════════
// WHATSAPP CLOUD API MANAGER
// ══════════════════════════════════════════════
class CloudAPIManager {
  constructor() {
    this.configs = new Map(); // tenantId -> { phone_number_id, access_token, waba_id }
    this.scheduledIntervals = new Map();
  }

  getConfig(tenantId) {
    return this.configs.get(String(tenantId)) || null;
  }

  isReady(tenantId) {
    const cfg = this.getConfig(tenantId);
    return !!(cfg && cfg.phone_number_id && cfg.access_token);
  }

  getStatus(tenantId) {
    const cfg = this.getConfig(tenantId);
    if (!cfg) return 'not_configured';
    if (cfg.phone_number_id && cfg.access_token) return 'connected';
    return 'not_configured';
  }

  async loadFromDB(tenantId) {
    const tid = String(tenantId);
    const { data: tenant } = await supabase.from('tenants')
      .select('wa_phone_number_id, wa_access_token, wa_waba_id')
      .eq('id', tenantId).maybeSingle();

    if (tenant && tenant.wa_phone_number_id && tenant.wa_access_token) {
      this.configs.set(tid, {
        phone_number_id: tenant.wa_phone_number_id,
        access_token: tenant.wa_access_token,
        waba_id: tenant.wa_waba_id || null
      });
      this.startScheduledChecker(tenantId);
      console.log(`✅ [Tenant ${tid}] Cloud API config loaded (Phone ID: ${tenant.wa_phone_number_id})`);
      return true;
    }
    return false;
  }

  async saveConfig(tenantId, phoneNumberId, accessToken, wabaId) {
    const tid = String(tenantId);

    const { error } = await supabase.from('tenants')
      .update({
        wa_phone_number_id: phoneNumberId || null,
        wa_access_token: accessToken || null,
        wa_waba_id: wabaId || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', tenantId);
    if (error) throw error;

    if (phoneNumberId && accessToken) {
      this.configs.set(tid, {
        phone_number_id: phoneNumberId,
        access_token: accessToken,
        waba_id: wabaId || null
      });
      this.startScheduledChecker(tenantId);
    } else {
      this.removeConfig(tenantId);
    }
  }

  removeConfig(tenantId) {
    const tid = String(tenantId);
    const interval = this.scheduledIntervals.get(tid);
    if (interval) clearInterval(interval);
    this.scheduledIntervals.delete(tid);
    this.configs.delete(tid);
  }

  // Find tenant by phone_number_id (for webhook routing)
  findTenantByPhoneNumberId(phoneNumberId) {
    for (const [tid, cfg] of this.configs) {
      if (cfg.phone_number_id === phoneNumberId) return parseInt(tid);
    }
    return null;
  }

  // ── Send Message via Cloud API ────────────
  async sendMessage(tenantId, to, text) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.phone_number_id || !cfg.access_token) {
      throw new Error('WhatsApp Cloud API not configured for this tenant');
    }

    const cleanedTo = String(to).replace(/\D/g, '');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phone_number_id}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanedTo,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data.error?.message || data.error?.error_data?.details || JSON.stringify(data.error) || 'Cloud API error';
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Auto-Reply Check ──────────────────────
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
              await this.sendMessage(tenantId, phone, rule.reply_message);
              // Store auto-reply in conversations
              await supabase.from('conversations').insert({
                tenant_id: tenantId, phone, message: rule.reply_message,
                direction: 'outgoing', status: 'sent'
              });
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

  // ── Scheduled Message Checker ─────────────
  startScheduledChecker(tenantId) {
    const tid = String(tenantId);
    const existing = this.scheduledIntervals.get(tid);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      try {
        if (!this.isReady(tenantId)) return;
        const { data: pending } = await supabase.from('scheduled_messages')
          .select('*').eq('tenant_id', tenantId).eq('status', 'pending')
          .lte('scheduled_at', new Date().toISOString())
          .order('scheduled_at', { ascending: true }).limit(10);

        if (!pending || pending.length === 0) return;

        for (const sm of pending) {
          try {
            const cleanedPhone = sm.phone.replace(/\D/g, '');
            await delay(MESSAGE_DELAY_MS);
            await this.sendMessage(tenantId, cleanedPhone, sm.message);
            // Store in conversations
            await supabase.from('conversations').insert({
              tenant_id: tenantId, phone: cleanedPhone, message: sm.message,
              direction: 'outgoing', status: 'sent'
            });
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

    this.scheduledIntervals.set(tid, interval);
  }

  destroyAll() {
    for (const [tid, interval] of this.scheduledIntervals) {
      clearInterval(interval);
    }
    this.scheduledIntervals.clear();
    this.configs.clear();
  }
}

const waManager = new CloudAPIManager();

// ── Initialize All Active Tenants ───────────
async function initAllTenants() {
  try {
    const { data: tenants } = await supabase.from('tenants').select('id, name').eq('is_active', true);
    if (!tenants || tenants.length === 0) {
      console.log('ℹ️  No active tenants found. Create one via admin dashboard.');
      return;
    }
    console.log(`🚀 Loading Cloud API configs for ${tenants.length} tenants...`);
    for (const tenant of tenants) {
      try {
        await waManager.loadFromDB(tenant.id);
      } catch (err) {
        console.error(`❌ Failed to load config for tenant ${tenant.id} (${tenant.name}):`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Failed to load tenants:', err.message);
  }
}

// ══════════════════════════════════════════════
// WEBHOOK - Receive Messages from WhatsApp Cloud API
// ══════════════════════════════════════════════
async function handleIncomingWebhook(entry) {
  for (const change of (entry.changes || [])) {
    if (change.field !== 'messages') continue;
    const value = change.value;
    if (!value) continue;

    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId) continue;

    // Find the tenant that owns this phone_number_id
    let resolvedTenantId = waManager.findTenantByPhoneNumberId(phoneNumberId);
    if (!resolvedTenantId) {
      // Try loading from DB in case config was added recently
      const { data: tenant } = await supabase.from('tenants')
        .select('id').eq('wa_phone_number_id', phoneNumberId).eq('is_active', true).maybeSingle();
      if (tenant) {
        await waManager.loadFromDB(tenant.id);
        resolvedTenantId = tenant.id;
      } else {
        console.warn(`⚠️  Webhook received for unknown phone_number_id: ${phoneNumberId}`);
        continue;
      }
    }

    // Handle incoming messages
    const messages = value.messages || [];
    const contacts = value.contacts || [];

    for (const msg of messages) {
      try {
        const phone = cleanPhone(msg.from);
        if (!phone) continue;

        const msgId = msg.id;
        if (isDuplicate(resolvedTenantId, msgId)) continue;

        // Extract message text based on type
        let body = '';
        if (msg.type === 'text') {
          body = msg.text?.body || '';
        } else if (msg.type === 'image') {
          body = msg.image?.caption || '[Image]';
        } else if (msg.type === 'video') {
          body = msg.video?.caption || '[Video]';
        } else if (msg.type === 'audio') {
          body = '[Audio]';
        } else if (msg.type === 'document') {
          body = msg.document?.caption || `[Document: ${msg.document?.filename || 'file'}]`;
        } else if (msg.type === 'location') {
          body = '[Location]';
        } else if (msg.type === 'contacts') {
          body = '[Contact]';
        } else if (msg.type === 'sticker') {
          body = '[Sticker]';
        } else if (msg.type === 'reaction') {
          continue; // Skip reactions
        } else if (msg.type === 'interactive') {
          body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interactive]';
        } else {
          body = `[${msg.type || 'Unknown'}]`;
        }

        console.log(`📩 [Tenant ${resolvedTenantId}] Incoming from ${phone}: ${body.substring(0, 50)}`);

        // Save conversation
        await supabase.from('conversations').insert({
          tenant_id: resolvedTenantId, phone, message: body,
          direction: 'incoming', status: 'received'
        });

        // Get contact name from webhook payload
        const contactName = contacts.find(c => c.wa_id === msg.from)?.profile?.name || 'Unknown';

        // Check if lead exists
        const { data: existingLead } = await supabase.from('leads')
          .select('id, phone').eq('tenant_id', resolvedTenantId).eq('phone', phone).maybeSingle();

        const isNew = !existingLead;
        if (!existingLead) {
          let source = 'organic';
          const lowerBody = body.toLowerCase();
          if (lowerBody.includes('tips') || lowerBody.includes('ad')) source = 'meta_ads';

          await supabase.from('leads').insert({
            tenant_id: resolvedTenantId, phone, real_phone: phone,
            name: contactName, source, status: 'new',
            last_message_at: new Date().toISOString()
          });

          try {
            await supabase.from('activity_log').insert({
              tenant_id: resolvedTenantId, phone, action: 'lead_created',
              details: `New lead from ${source}: ${contactName}`
            });
          } catch (_) {}
        } else {
          await supabase.from('leads').update({
            last_message_at: new Date().toISOString(), real_phone: phone
          }).eq('tenant_id', resolvedTenantId).eq('phone', phone);
        }

        // Check auto-replies
        if (waManager.isReady(resolvedTenantId)) {
          await waManager.checkAutoReply(resolvedTenantId, phone, body, isNew);
        }
      } catch (err) {
        console.error(`❌ Webhook message processing error:`, err.message);
      }
    }

    // Handle message status updates (sent, delivered, read, failed)
    const statuses = value.statuses || [];
    for (const status of statuses) {
      try {
        if (status.status === 'failed') {
          console.warn(`⚠️  Message ${status.id} failed:`, status.errors?.[0]?.message);
        }
      } catch (_) {}
    }
  }
}

// ══════════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════════
const app = express();

// Trust the first proxy hop (required when running behind Render, nginx, etc.)
app.set('trust proxy', 1);

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

  const { data: tenant } = await supabase.from('tenants')
    .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
  if (!tenant || !tenant.is_active) {
    res.clearCookie('crm_token');
    return res.status(401).json({ error: 'Account deleted or deactivated' });
  }

  req.tenantId = decoded.tenant_id;
  req.tenantName = decoded.name;
  req.tenantUsername = decoded.username;

  const now = Math.floor(Date.now() / 1000);
  const tokenAge = now - (decoded.iat || 0);
  if (tokenAge > 300) {
    const newToken = jwt.sign({
      tenant_id: decoded.tenant_id, username: decoded.username,
      name: decoded.name, role: 'tenant'
    }, JWT_SECRET, { expiresIn: '30m' });
    res.cookie('crm_token', newToken, {
      httpOnly: true, secure: false, sameSite: 'lax',
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
// WEBHOOK ROUTES (must be before auth - no cookies)
// ══════════════════════════════════════════════

// Webhook verification (Meta sends GET to verify)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️  Webhook verification failed');
  res.sendStatus(403);
});

// Webhook for incoming messages
app.post('/webhook', async (req, res) => {
  // Always respond 200 quickly to avoid retries
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      await handleIncomingWebhook(entry);
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

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
      httpOnly: true, secure: false, sameSite: 'lax',
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
      httpOnly: true, secure: false, sameSite: 'lax',
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
      .select('id, username, unique_key, name, is_active, created_at, updated_at, wa_phone_number_id')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const tenants = (data || []).map(t => ({
      ...t,
      wa_status: waManager.getStatus(t.id),
      wa_configured: !!(t.wa_phone_number_id)
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
    res.json({ ...data, password_plain: String(password), wa_status: 'not_configured' });
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
    waManager.removeConfig(id);

    const { error } = await supabase.from('tenants').delete().eq('id', id);
    if (error) throw error;

    console.log(`🗑️  Tenant ${id} fully purged`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete tenant error:', err.message);
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

// ── Configure WhatsApp Cloud API for Tenant ─
app.post('/api/admin/tenants/:id/configure-wa', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { phone_number_id, access_token, waba_id } = req.body;

    if (!phone_number_id || !access_token) {
      return res.status(400).json({ error: 'Phone Number ID and Access Token are required' });
    }

    const { data: tenant } = await supabase.from('tenants')
      .select('id, name, is_active').eq('id', id).maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.is_active) return res.status(400).json({ error: 'Tenant is deactivated' });

    // Verify the credentials work by calling the Graph API
    const testUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phone_number_id}`;
    const testRes = await fetch(testUrl, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });
    const testData = await testRes.json();
    if (!testRes.ok) {
      return res.status(400).json({
        error: `Invalid API credentials: ${testData.error?.message || 'Verification failed'}`
      });
    }

    await waManager.saveConfig(id, phone_number_id, access_token, waba_id || null);

    console.log(`✅ [Tenant ${id}] Cloud API configured (Phone ID: ${phone_number_id})`);
    res.json({
      success: true, status: 'connected',
      phone_display: testData.display_phone_number || phone_number_id,
      verified_name: testData.verified_name || null
    });
  } catch (err) {
    console.error(`❌ Configure WA error for tenant ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to configure WhatsApp' });
  }
});

// ── Get WhatsApp Config for Tenant ──────────
app.get('/api/admin/tenants/:id/wa-config', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: tenant } = await supabase.from('tenants')
      .select('wa_phone_number_id, wa_waba_id')
      .eq('id', id).maybeSingle();

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    res.json({
      configured: !!(tenant.wa_phone_number_id),
      phone_number_id: tenant.wa_phone_number_id || '',
      waba_id: tenant.wa_waba_id || '',
      has_token: !!(tenant.wa_phone_number_id),
      status: waManager.getStatus(id)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get WA config' });
  }
});

// ── Disconnect WhatsApp for Tenant ──────────
app.post('/api/admin/tenants/:id/disconnect-wa', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await waManager.saveConfig(id, null, null, null);
    console.log(`🛑 [Tenant ${id}] Cloud API disconnected`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect WhatsApp' });
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
app.get('/api/admin/storage', adminAuth, async (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const ramUsedMB = Math.round(memUsage.rss / 1024 / 1024);
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const activeClients = waManager.configs.size;

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
    const estimatedDbSizeMB = Math.round((totalRows * 512) / (1024 * 1024) * 100) / 100;

    const ramLimitMB = parseInt(process.env.RAM_LIMIT_MB) || Math.round(os.totalmem() / (1024 * 1024));
    const dbLimitMB = parseInt(process.env.DB_LIMIT_MB) || 500;

    res.json({
      disk: { used_bytes: 0, used_mb: 0, limit_mb: 0, percent: 0 },
      ram: {
        rss_mb: ramUsedMB, heap_used_mb: heapUsedMB, heap_total_mb: heapTotalMB,
        limit_mb: ramLimitMB,
        percent: Math.min(100, Math.round((ramUsedMB / ramLimitMB) * 100)),
        active_clients: activeClients,
      },
      database: {
        rows: dbRows, total_rows: totalRows,
        estimated_mb: estimatedDbSizeMB, limit_mb: dbLimitMB,
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
      const [convRes, leadsRes, broadcastsRes] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('broadcasts').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
      ]);

      const convCount = convRes.count || 0;
      const leadsCount = leadsRes.count || 0;
      const broadcastsCount = broadcastsRes.count || 0;
      const totalRows = convCount + leadsCount + broadcastsCount;
      const waStatus = waManager.getStatus(t.id);

      return {
        id: t.id, name: t.name, username: t.username,
        disk_bytes: 0, disk_mb: 0,
        db_rows: { conversations: convCount, leads: leadsCount, broadcasts: broadcastsCount },
        total_rows: totalRows,
        estimated_db_mb: Math.round((totalRows * 512) / (1024 * 1024) * 100) / 100,
        wa_status: waStatus, using_ram: false,
      };
    }));

    breakdown.sort((a, b) => b.total_rows - a.total_rows);
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
  res.json({ cleaned: 0, freed_bytes: 0, freed_mb: 0 });
});

// ══════════════════════════════════════════════
// TENANT API ROUTES (all scoped by tenant_id)
// ══════════════════════════════════════════════

// ── Health / Status ─────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/connection-status', tenantAuth, (req, res) => {
  const status = waManager.getStatus(req.tenantId);
  const ready = status === 'connected';
  res.json({ ready, status });
});

// ── Send Reply ──────────────────────────────
app.post('/api/send-reply', tenantAuth, sendLimiter, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message are required' });

    if (!waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured. Contact admin.' });
    }

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    await delay(MESSAGE_DELAY_MS);
    await waManager.sendMessage(req.tenantId, cleanedPhone, message);

    // Store outgoing message
    await supabase.from('conversations').insert({
      tenant_id: req.tenantId, phone: cleanedPhone, message,
      direction: 'outgoing', status: 'sent'
    });

    await supabase.from('leads')
      .update({ last_message_at: new Date().toISOString() })
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
  const phone = req.params.phone.replace(/\D/g, '');
  res.json({ success: true, real_phone: phone });
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
    if (!waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured' });
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
        if (!waManager.isReady(tenantId)) {
          await supabase.from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'WhatsApp not configured' }).eq('id', recipient.id);
          failedCount++; continue;
        }

        const cleanedPhone = recipient.phone.replace(/\D/g, '');
        await delay(MESSAGE_DELAY_MS + Math.random() * 2000);
        await waManager.sendMessage(tenantId, cleanedPhone, message);

        // Store outgoing message
        await supabase.from('conversations').insert({
          tenant_id: tenantId, phone: cleanedPhone, message,
          direction: 'outgoing', status: 'sent'
        });

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

        return { ...lead, last_message: msgs?.[0] || null, unread_count: unreadRes.count || 0 };
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
  const decoded = verifyToken(req);
  if (decoded) {
    if (decoded.role === 'admin') return res.redirect('/admin');
    return res.redirect('/crm');
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
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Billy777 WhatsApp CRM - Cloud API Edition      ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   🌐 Dashboard:  http://localhost:${PORT}             ║`);
  console.log(`║   👤 Admin:      ${ADMIN_USERNAME}                             ║`);
  console.log(`║   📡 Webhook:    /webhook                         ║`);
  console.log(`║   🔑 Verify:     ${WEBHOOK_VERIFY_TOKEN}               ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  initAllTenants();
});

// ── Graceful Shutdown ───────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  waManager.destroyAll();
  process.exit(0);
});
