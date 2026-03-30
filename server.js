// ============================================
// Billy777 WhatsApp CRM - Multi-Tenant Server
// WhatsApp Cloud API Edition
// ============================================
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

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

// ── Admin Notifications Store (in-memory) ──
const adminNotifications = [];
let notifIdCounter = 0;
function pushAdminNotif(type, message, tenantId, tenantName) {
  adminNotifications.unshift({
    id: ++notifIdCounter,
    type, // 'copy_paste', 'warn', 'error', 'info'
    message,
    tenant_id: tenantId || null,
    tenant_name: tenantName || null,
    timestamp: new Date().toISOString(),
    read: false,
  });
  if (adminNotifications.length > 200) adminNotifications.length = 200;
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
    if (cfg.banned) return 'banned';
    if (cfg.phone_number_id && cfg.access_token) return 'connected';
    return 'not_configured';
  }

  markBanned(tenantId, reason) {
    const cfg = this.getConfig(tenantId);
    if (cfg) {
      cfg.banned = true;
      cfg.banned_reason = reason || 'Unknown';
      cfg.banned_at = new Date().toISOString();
      console.error(`🚫 [Tenant ${tenantId}] WhatsApp number BANNED: ${reason}`);
    }
  }

  clearBan(tenantId) {
    const cfg = this.getConfig(tenantId);
    if (cfg) {
      delete cfg.banned;
      delete cfg.banned_reason;
      delete cfg.banned_at;
    }
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
      const errCode = data.error?.code;
      const errMsg = data.error?.message || data.error?.error_data?.details || JSON.stringify(data.error) || 'Cloud API error';
      // Check for ban-related errors
      if (errCode === 131031 || errCode === 368 || errCode === 131026) {
        this.markBanned(tenantId, `Error ${errCode}: ${errMsg}`);
      }
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Download Media from WhatsApp ───────────
  async downloadMediaUrl(tenantId, mediaId) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.access_token) throw new Error('Not configured');

    // Step 1: Get the media URL from WhatsApp
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${cfg.access_token}` }
    });
    const metaData = await metaRes.json();
    if (!metaRes.ok || !metaData.url) {
      console.error('Media URL fetch failed:', metaData);
      return null;
    }
    return metaData.url;
  }

  // ── Send Audio Message via Cloud API ───────
  async sendAudioMessage(tenantId, to, audioUrl) {
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
        type: 'audio',
        audio: { link: audioUrl }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const errCode = data.error?.code;
      const errMsg = data.error?.message || data.error?.error_data?.details || JSON.stringify(data.error) || 'Cloud API error';
      // Check for ban-related errors
      if (errCode === 131031 || errCode === 368 || errCode === 131026) {
        this.markBanned(tenantId, `Error ${errCode}: ${errMsg}`);
      }
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Upload Media to WhatsApp ───────────────
  async uploadMedia(tenantId, audioBuffer, mimeType) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.phone_number_id || !cfg.access_token) {
      throw new Error('WhatsApp Cloud API not configured for this tenant');
    }

    const cleanMime = mimeType.split(';')[0].trim();
    const whatsappAudioTypes = ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/opus'];

    let finalBuffer = audioBuffer;
    let finalMime = cleanMime;

    // Convert unsupported formats (like audio/webm) to audio/ogg
    if (!whatsappAudioTypes.includes(cleanMime)) {
      console.log(`🎙️ Converting ${cleanMime} to audio/ogg using ffmpeg...`);
      const tmpDir = os.tmpdir();
      const inputPath = path.join(tmpDir, `wa_input_${Date.now()}.webm`);
      const outputPath = path.join(tmpDir, `wa_output_${Date.now()}.ogg`);
      try {
        fs.writeFileSync(inputPath, audioBuffer);
        await new Promise((resolve, reject) => {
          execFile(ffmpegPath, [
            '-i', inputPath,
            '-c:a', 'libopus',
            '-b:a', '64k',
            '-y',
            outputPath
          ], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`FFmpeg conversion failed: ${err.message}`));
            else resolve();
          });
        });
        finalBuffer = fs.readFileSync(outputPath);
        finalMime = 'audio/ogg';
        console.log(`🎙️ Converted: ${audioBuffer.length} bytes -> ${finalBuffer.length} bytes (ogg)`);
      } finally {
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
      }
    }

    const blob = new Blob([finalBuffer], { type: finalMime });
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', finalMime);
    formData.append('file', blob, finalMime === 'audio/ogg' ? 'voice.ogg' : 'voice.mp4');

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phone_number_id}/media`;
    console.log(`🎙️ Uploading media: ${finalMime}, ${finalBuffer.length} bytes`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.access_token}` },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Media upload failed:', data);
      throw new Error(data.error?.message || 'Media upload failed');
    }
    console.log(`🎙️ Media uploaded, ID: ${data.id}`);
    return data.id;
  }

  // ── Send Audio by Media ID ────────────────
  async sendAudioById(tenantId, to, mediaId) {
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
        type: 'audio',
        audio: { id: mediaId }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const errCode = data.error?.code;
      const errMsg = data.error?.message || data.error?.error_data?.details || JSON.stringify(data.error) || 'Cloud API error';
      if (errCode === 131031 || errCode === 368 || errCode === 131026) {
        this.markBanned(tenantId, `Error ${errCode}: ${errMsg}`);
      }
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
        let incomingMediaId = null;
        if (msg.type === 'text') {
          body = msg.text?.body || '';
        } else if (msg.type === 'image') {
          body = msg.image?.caption || '[Image]';
        } else if (msg.type === 'video') {
          body = msg.video?.caption || '[Video]';
        } else if (msg.type === 'audio' || msg.type === 'ptt') {
          body = '🎤 Voice message';
          incomingMediaId = (msg.audio?.id || msg.ptt?.id) || null;
          console.log(`🎙️ AUDIO/PTT RECEIVED from ${phone}: type=${msg.type}, media_id=${incomingMediaId}`);
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
        const insertData = {
          tenant_id: resolvedTenantId, phone, message: body,
          direction: 'incoming', status: 'received'
        };
        if (incomingMediaId) {
          insertData.media_url = 'wamid:' + incomingMediaId;
          console.log(`\ud83c\udf99\ufe0f Saving with media_url: ${insertData.media_url}`);
        }
        const { data: insertedRows, error: insertErr } = await supabase.from('conversations').insert(insertData).select('id, media_url');
        if (insertErr) {
          console.error(`❌ Insert error for ${phone}:`, insertErr.message, insertErr.details || '', insertErr.hint || '');
          if (insertErr.message && insertErr.message.includes('media_url')) {
            console.error('⚠️  media_url column missing! Run: ALTER TABLE conversations ADD COLUMN IF NOT EXISTS media_url TEXT;');
            delete insertData.media_url;
            await supabase.from('conversations').insert(insertData);
          }
        } else {
          console.log(`✅ Saved conversation id=${insertedRows?.[0]?.id}, media_url=${insertedRows?.[0]?.media_url || 'NULL'}`);
        }

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
          const errCode = status.errors?.[0]?.code;
          const errMsg = status.errors?.[0]?.message || 'Unknown error';
          console.warn(`⚠️  Message ${status.id} failed: ${errMsg} (code: ${errCode})`);

          // Detect ban-related error codes
          // 131031 = Business account restricted/banned
          // 368 = Temporarily blocked for policies violation
          // 131026 = Message undeliverable (often means banned)
          // 131056 = Pair rate limit hit (business account issue)
          const banCodes = [131031, 368, 131026, 131056];
          if (banCodes.includes(errCode)) {
            waManager.markBanned(resolvedTenantId, `Error ${errCode}: ${errMsg}`);
            // Log the ban event
            try {
              await supabase.from('activity_log').insert({
                tenant_id: resolvedTenantId,
                phone: status.recipient_id || 'system',
                action: 'wa_banned',
                details: `WhatsApp number banned/restricted. Error ${errCode}: ${errMsg}`
              });
            } catch (_) {}
          }
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
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 50,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true, legacyHeaders: false
});

const sendLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 60,
  message: { error: 'Sending too fast, please wait a moment' },
  standardHeaders: true, legacyHeaders: false
});

// General API limiter for all tenant endpoints (prevents any single source from overwhelming)
const apiLimiter = rateLimit({
  windowMs: 60000, max: 200,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true, legacyHeaders: false
});

// ── Auth Middleware ──────────────────────────
function verifyToken(req, cookieName = 'crm_token') {
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Find tenant token from tenant-specific cookie using X-Tenant-ID header or scan
function verifyTenantToken(req) {
  // 1. Try X-Tenant-ID header (sent by frontend)
  const headerTid = req.headers['x-tenant-id'];
  if (headerTid) {
    const decoded = verifyToken(req, `crm_token_${headerTid}`);
    if (decoded && decoded.role === 'tenant') return decoded;
  }
  // 2. Fallback: scan all crm_token_* cookies
  for (const [name, value] of Object.entries(req.cookies || {})) {
    if (name.startsWith('crm_token_') && name !== 'crm_token_') {
      try {
        const decoded = jwt.verify(value, JWT_SECRET);
        if (decoded && decoded.role === 'tenant') return decoded;
      } catch {}
    }
  }
  // 3. Legacy fallback: old crm_token cookie
  return verifyToken(req, 'crm_token');
}

// ── Tenant verification cache (avoids DB hit on every API call) ──
const tenantVerifyCache = new Map(); // tenantId -> { active, ts }
const TENANT_CACHE_TTL = 120000; // 120s (2 min) — reduces DB hits for 100+ marketers

function isTenantCachedActive(tenantId) {
  const cached = tenantVerifyCache.get(tenantId);
  if (cached && (Date.now() - cached.ts) < TENANT_CACHE_TTL) return cached.active;
  return null;
}

async function tenantAuth(req, res, next) {
  const decoded = verifyTenantToken(req);
  if (!decoded || decoded.role !== 'tenant') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check cache first to avoid DB query on every request
  const cachedActive = isTenantCachedActive(decoded.tenant_id);
  if (cachedActive === false) {
    res.clearCookie(`crm_token_${decoded.tenant_id}`);
    res.clearCookie('crm_token');
    return res.status(401).json({ error: 'Account deleted or deactivated' });
  }
  if (cachedActive === null) {
    const { data: tenant } = await supabase.from('tenants')
      .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
    const isActive = !!(tenant && tenant.is_active);
    tenantVerifyCache.set(decoded.tenant_id, { active: isActive, ts: Date.now() });
    if (!isActive) {
      res.clearCookie(`crm_token_${decoded.tenant_id}`);
      res.clearCookie('crm_token');
      return res.status(401).json({ error: 'Account deleted or deactivated' });
    }
  }

  req.tenantId = decoded.tenant_id;
  req.tenantName = decoded.name;
  req.tenantUsername = decoded.username;

  const cookieName = `crm_token_${decoded.tenant_id}`;
  const now = Math.floor(Date.now() / 1000);
  const tokenAge = now - (decoded.iat || 0);
  if (tokenAge > 300) {
    const newToken = jwt.sign({
      tenant_id: decoded.tenant_id, username: decoded.username,
      name: decoded.name, role: 'tenant'
    }, JWT_SECRET, { expiresIn: '30m' });
    res.cookie(cookieName, newToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 30 * 60 * 1000
    });
  }

  next();
}

function adminAuth(req, res, next) {
  const decoded = verifyToken(req, 'crm_admin_token');
  if (!decoded || decoded.role !== 'admin') {
    return res.status(401).json({ error: 'Unauthorized - Admin access required' });
  }
  req.adminUsername = decoded.username;
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

    res.cookie(`crm_token_${tenant.id}`, token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
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

    res.cookie('crm_admin_token', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ success: true, role: 'admin', user: { username: ADMIN_USERNAME } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const role = req.query.role;
  if (role === 'admin') {
    res.clearCookie('crm_admin_token');
  } else {
    const tid = req.query.tid || req.headers['x-tenant-id'];
    if (tid) {
      res.clearCookie(`crm_token_${tid}`);
    }
    // Also clear legacy cookie
    res.clearCookie('crm_token');
  }
  res.json({ success: true });
});

app.get('/api/auth/check', async (req, res) => {
  const role = req.query.role;
  let decoded;
  if (role === 'admin') {
    decoded = verifyToken(req, 'crm_admin_token');
  } else {
    decoded = verifyTenantToken(req);
  }
  if (!decoded) return res.status(401).json({ authenticated: false });

  if (decoded.role === 'tenant') {
    const { data: tenant } = await supabase.from('tenants')
      .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
    if (!tenant || !tenant.is_active) {
      res.clearCookie(`crm_token_${decoded.tenant_id}`);
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
        .eq('tenant_id', id).eq('direction', 'outgoing').gte('created_at', new Date(Date.now() - 86400000).toISOString())
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

// ── Marketer Performance Dashboard ─────────
app.get('/api/admin/marketer-dashboard', adminAuth, async (req, res) => {
  try {
    const { data: allTenants, error } = await supabase.from('tenants')
      .select('id, name, username, is_active')
      .order('name', { ascending: true });
    if (error) throw error;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

    const marketers = await Promise.all((allTenants || []).map(async (t) => {
      const [leadsRes, msgsToday, weekData, incomingToday, hourData] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id).eq('direction', 'outgoing').gte('created_at', oneDayAgo),
        supabase.from('conversations').select('created_at')
          .eq('tenant_id', t.id).eq('direction', 'outgoing').gte('created_at', sevenDaysAgo),
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id).eq('direction', 'incoming').gte('created_at', oneDayAgo),
        supabase.from('conversations').select('message, phone')
          .eq('tenant_id', t.id).eq('direction', 'outgoing').gte('created_at', oneHourAgo),
      ]);

      // Build 7-day chart: index 6 = today, index 0 = 6 days ago
      const chart = new Array(7).fill(0);
      const now = new Date();
      (weekData.data || []).forEach(row => {
        const d = Math.floor((now - new Date(row.created_at)) / 86400000);
        if (d >= 0 && d < 7) chart[6 - d]++;
      });

      // Copy-paste: same message body sent to 3+ different phones in last hour
      const byMsg = {};
      (hourData.data || []).forEach(row => {
        const k = (row.message || '').trim();
        if (k.length < 5) return;
        if (!byMsg[k]) byMsg[k] = new Set();
        byMsg[k].add(row.phone);
      });
      const cpSets = Object.values(byMsg).filter(s => s.size >= 3);
      const copyPasteWarn = cpSets.length > 0;
      const copyPasteMax = copyPasteWarn ? Math.max(...cpSets.map(s => s.size)) : 0;

      return {
        id: t.id, name: t.name, username: t.username,
        is_active: t.is_active, wa_status: waManager.getStatus(t.id),
        stats: {
          total_leads: leadsRes.count || 0,
          messages_today: msgsToday.count || 0,
          messages_week: (weekData.data || []).length,
          incoming_today: incomingToday.count || 0,
          weekly_chart: chart,
        },
        copy_paste_warning: copyPasteWarn,
        copy_paste_max: copyPasteMax,
      };
    }));

    res.json({
      marketers,
      total_messages_today: marketers.reduce((s, m) => s + m.stats.messages_today, 0),
      total_messages_week: marketers.reduce((s, m) => s + m.stats.messages_week, 0),
      copy_paste_alerts: marketers.filter(m => m.copy_paste_warning).length,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// ── Admin Notifications ─────────────────────
app.get('/api/admin/notifications', adminAuth, (req, res) => {
  res.json({
    notifications: adminNotifications.slice(0, 100),
    unread: adminNotifications.filter(n => !n.read).length,
  });
});

app.post('/api/admin/notifications/read', adminAuth, (req, res) => {
  const { id } = req.body || {};
  if (id) {
    const n = adminNotifications.find(x => x.id === id);
    if (n) n.read = true;
  } else {
    adminNotifications.forEach(n => { n.read = true; });
  }
  res.json({ success: true });
});

app.delete('/api/admin/notifications', adminAuth, (req, res) => {
  adminNotifications.length = 0;
  res.json({ success: true });
});

// ── Marketer Warning System ─────────────────
const marketerWarnings = new Map(); // tenantId -> { message, expiresAt }

app.post('/api/admin/warn-marketer/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid marketer ID' });
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Warning message is required' });
  marketerWarnings.set(id, { message, expiresAt: Date.now() + 60000 });
  pushAdminNotif('warn', `Admin sent warning to marketer #${id}: "${message.substring(0, 80)}"`, id, null);
  res.json({ success: true });
});

// Tenant-side: poll for active warning (called from marketer's CRM every 5s)
app.get('/api/warn-check', tenantAuth, (req, res) => {
  const w = marketerWarnings.get(req.tenantId);
  if (w && Date.now() < w.expiresAt) {
    const remaining_seconds = Math.ceil((w.expiresAt - Date.now()) / 1000);
    return res.json({ warned: true, message: w.message, remaining_seconds });
  }
  // Clean up expired entry
  if (w) marketerWarnings.delete(req.tenantId);
  res.json({ warned: false });
});

// ══════════════════════════════════════════════
// TENANT API ROUTES (all scoped by tenant_id)
// ══════════════════════════════════════════════

// ── Health / Status ─────────────────────────
app.get('/api/health', apiLimiter, tenantAuth, (req, res) => {
  const status = waManager.getStatus(req.tenantId);
  res.set('Cache-Control', 'private, max-age=5');
  res.json({
    status: 'ok', whatsapp: status,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/connection-status', tenantAuth, (req, res) => {
  const status = waManager.getStatus(req.tenantId);
  const ready = status === 'connected';
  const cfg = waManager.getConfig(req.tenantId);
  const result = { ready, status };
  if (status === 'banned' && cfg) {
    result.banned_reason = cfg.banned_reason || 'Unknown';
    result.banned_at = cfg.banned_at || null;
  }
  res.set('Cache-Control', 'private, max-age=10');
  res.json(result);
});

// ── Manual Ban/Unban Status ─────────────────
app.post('/api/connection-status', tenantAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (status === 'banned') {
      waManager.markBanned(req.tenantId, 'Manually set to banned by user');
    } else {
      waManager.clearBan(req.tenantId);
    }
    res.json({ success: true, status: waManager.getStatus(req.tenantId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    // Send immediately for replies (no delay needed for user-initiated messages)
    await waManager.sendMessage(req.tenantId, cleanedPhone, message);

    const now = new Date().toISOString();
    // Store outgoing message + update lead timestamp in parallel
    await Promise.all([
      supabase.from('conversations').insert({
        tenant_id: req.tenantId, phone: cleanedPhone, message,
        direction: 'outgoing', status: 'sent'
      }),
      supabase.from('leads')
        .update({ last_message_at: now })
        .eq('tenant_id', req.tenantId).eq('phone', cleanedPhone)
    ]);

    // Non-blocking copy-paste detection
    setImmediate(async () => {
      try {
        const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
        const { data: sameMsg } = await supabase.from('conversations')
          .select('phone').eq('tenant_id', req.tenantId).eq('direction', 'outgoing')
          .eq('message', message).gte('created_at', oneHourAgo);
        const uniquePhones = new Set((sameMsg || []).map(r => r.phone));
        if (uniquePhones.size >= 3) {
          const alreadyNotified = adminNotifications.some(n =>
            n.type === 'copy_paste' && n.tenant_id === req.tenantId &&
            (Date.now() - new Date(n.timestamp).getTime()) < 900000
          );
          if (!alreadyNotified) {
            const { data: td } = await supabase.from('tenants').select('name').eq('id', req.tenantId).maybeSingle();
            const tname = td?.name || `Marketer #${req.tenantId}`;
            pushAdminNotif('copy_paste',
              `"${tname}" sent identical message to ${uniquePhones.size} different contacts in the last hour. Message: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`,
              req.tenantId, tname
            );
          }
        }
      } catch (_) { /* silent */ }
    });

    res.json({ success: true, phone: cleanedPhone, timestamp: now });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

// ── Send Voice Message ──────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

app.post('/api/send-voice', tenantAuth, sendLimiter, upload.single('audio'), async (req, res) => {
  try {
    const phone = req.body.phone;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    if (!req.file) return res.status(400).json({ error: 'Audio file is required' });

    if (!waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured. Contact admin.' });
    }

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Upload audio to WhatsApp Media API
    const mimeType = req.file.mimetype || 'audio/ogg';
    const mediaId = await waManager.uploadMedia(req.tenantId, req.file.buffer, mimeType);

    // Send audio message using the uploaded media ID
    await waManager.sendAudioById(req.tenantId, cleanedPhone, mediaId);

    const now = new Date().toISOString();
    // Store outgoing voice message + update lead timestamp
    await Promise.all([
      supabase.from('conversations').insert({
        tenant_id: req.tenantId, phone: cleanedPhone,
        message: '\ud83c\udfa4 Voice message',
        direction: 'outgoing', status: 'sent',
        media_url: 'wamid:' + mediaId
      }),
      supabase.from('leads')
        .update({ last_message_at: now })
        .eq('tenant_id', req.tenantId).eq('phone', cleanedPhone)
    ]);

    res.json({ success: true, phone: cleanedPhone, timestamp: now, media_url: 'wamid:' + mediaId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send voice message' });
  }
});

// ── Audio Proxy (stream WhatsApp media with auth) ────
app.get('/api/audio-proxy/:conversationId', tenantAuth, async (req, res) => {
  try {
    const convId = parseInt(req.params.conversationId);
    console.log(`🔊 Audio proxy request for conversation ${convId}, tenant ${req.tenantId}`);
    if (!convId) return res.status(400).json({ error: 'Invalid conversation ID' });

    // Fetch the conversation to get media_url
    const { data: conv } = await supabase.from('conversations')
      .select('media_url')
      .eq('id', convId).eq('tenant_id', req.tenantId).maybeSingle();

    if (!conv || !conv.media_url) {
      console.log(`🔊 No media_url found for conversation ${convId}`);
      return res.status(404).json({ error: 'Audio not found' });
    }
    console.log(`🔊 media_url: ${conv.media_url}`);

    const cfg = waManager.getConfig(req.tenantId);
    if (!cfg || !cfg.access_token) {
      return res.status(503).json({ error: 'WhatsApp not configured' });
    }

    let mediaUrl = conv.media_url;

    // If stored as wamid:XXXX, resolve to actual download URL first
    if (mediaUrl.startsWith('wamid:')) {
      const mediaId = mediaUrl.replace('wamid:', '');
      const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${cfg.access_token}` }
      });
      const metaData = await metaRes.json();
      if (!metaRes.ok || !metaData.url) {
        console.error('Media URL resolve failed:', metaData);
        return res.status(502).json({ error: 'Failed to resolve media URL' });
      }
      mediaUrl = metaData.url;
    }

    // Download the actual audio binary from WhatsApp CDN
    const audioRes = await fetch(mediaUrl, {
      headers: { 'Authorization': `Bearer ${cfg.access_token}` }
    });

    if (!audioRes.ok) {
      return res.status(502).json({ error: 'Failed to download audio' });
    }

    // Stream the audio to the client
    const contentType = audioRes.headers.get('content-type') || 'audio/ogg';
    const arrayBuf = await audioRes.arrayBuffer();
    const audioBuf = Buffer.from(arrayBuf);
    console.log(`🔊 Proxying ${audioBuf.length} bytes, type: ${contentType}`);
    res.set('Content-Type', contentType);
    res.set('Content-Length', audioBuf.length);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(audioBuf);
  } catch (err) {
    console.error('Audio proxy error:', err.message);
    res.status(500).json({ error: 'Failed to proxy audio' });
  }
});

// ── Messages ────────────────────────────────
app.get('/api/messages/:phone', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const { data, error } = await supabase.from('conversations')
      .select('id, phone, message, direction, status, created_at, media_url')
      .eq('tenant_id', req.tenantId).eq('phone', phone)
      .order('created_at', { ascending: true }).limit(200);
    if (error) throw error;
    res.set('Cache-Control', 'private, max-age=5');
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

    const result = await supabase.from('leads')
      .update(updates).eq('tenant_id', req.tenantId).eq('phone', phone);
    if (result.error) {
      console.error('❌ Supabase lead update error:', JSON.stringify(result.error));
      throw result.error;
    }

    supabase.from('activity_log').insert({
      tenant_id: req.tenantId, phone, action: 'lead_updated',
      details: `Updated: ${Object.keys(updates).join(', ')}`
    }).then(() => {}).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Lead update error:', err.message || err);
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

// ── In-memory response cache for heavy read endpoints ──
const responseCache = new Map(); // key -> { data, ts }
const RESP_CACHE_TTL = 10000; // 10s for stats
const RESP_CACHE_TTL_LONG = 30000; // 30s for analytics

function getCachedResponse(key) {
  const cached = responseCache.get(key);
  if (cached && (Date.now() - cached.ts) < cached.ttl) return cached.data;
  return null;
}

function setCachedResponse(key, data, ttl = RESP_CACHE_TTL) {
  responseCache.set(key, { data, ts: Date.now(), ttl });
  // Evict old entries periodically
  if (responseCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.ts > v.ttl) responseCache.delete(k);
    }
  }
}

// ── Stats ───────────────────────────────────
app.get('/api/stats', tenantAuth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const cacheKey = `stats_${tid}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) { res.set('Cache-Control', 'private, max-age=10'); return res.json(cached); }
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

    const result = {
      total_leads: leadsRes.count || 0, new_leads: newRes.count || 0,
      sold_leads: soldRes.count || 0, interested_leads: intRes.count || 0,
      contacted_leads: contRes.count || 0, total_revenue: totalRevenue,
      messages_today: msgsRes.count || 0, incoming_today: inRes.count || 0,
      outgoing_today: outRes.count || 0
    };
    setCachedResponse(cacheKey, result);
    res.set('Cache-Control', 'private, max-age=10');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/stats/trends', tenantAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cacheKey = `trends_${req.tenantId}_${days}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) { res.set('Cache-Control', 'private, max-age=30'); return res.json(cached); }

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
    setCachedResponse(cacheKey, trends, RESP_CACHE_TTL_LONG);
    res.set('Cache-Control', 'private, max-age=30');
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

// ── Cancel a sending broadcast ──────────────
const cancelledBroadcasts = new Set();

app.post('/api/broadcasts/:id/cancel', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: broadcast } = await supabase.from('broadcasts')
      .select('status').eq('id', id).eq('tenant_id', req.tenantId).maybeSingle();
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    if (broadcast.status !== 'sending') return res.status(400).json({ error: 'Broadcast is not currently sending' });

    cancelledBroadcasts.add(id);
    res.json({ success: true, message: 'Cancel signal sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel broadcast' });
  }
});

async function sendBroadcastAsync(tenantId, broadcastId, message) {
  try {
    const { data: recipients } = await supabase.from('broadcast_recipients')
      .select('*').eq('broadcast_id', broadcastId).eq('status', 'pending');

    let sentCount = 0, failedCount = 0;
    for (let i = 0; i < (recipients || []).length; i++) {
      const recipient = recipients[i];
      // Check if broadcast was cancelled
      if (cancelledBroadcasts.has(broadcastId)) {
        cancelledBroadcasts.delete(broadcastId);
        // Mark remaining pending recipients as cancelled in DB
        const remainingIds = recipients.slice(i).map(r => r.id);
        if (remainingIds.length > 0) {
          await supabase.from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'Broadcast cancelled' })
            .in('id', remainingIds);
          failedCount += remainingIds.length;
        }
        await supabase.from('broadcasts').update({
          status: 'cancelled', sent_count: sentCount, failed_count: failedCount,
          completed_at: new Date().toISOString()
        }).eq('id', broadcastId);
        console.log(`⛔ Broadcast ${broadcastId} cancelled by user. Sent: ${sentCount}, Skipped: ${remainingIds.length}`);
        return;
      }

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

// ── Active Chats (OPTIMIZED: 3 queries instead of N*2+1) ────
app.get('/api/active-chats', tenantAuth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const since = req.query.since || null; // ISO timestamp for incremental updates

    // If client sends 'since', return only leads updated after that time
    let leadsQuery = supabase.from('leads')
      .select('id, phone, real_phone, name, email, company, source, status, tags, notes, revenue, assigned_to, created_at, last_message_at')
      .eq('tenant_id', tid);
    if (since) {
      leadsQuery = leadsQuery.gte('last_message_at', since);
    }
    leadsQuery = leadsQuery.order('last_message_at', { ascending: false }).limit(200);

    const { data: leads, error } = await leadsQuery;
    if (error) throw error;
    if (!leads || leads.length === 0) return res.json([]);

    const phones = leads.map(l => l.phone);

    // Batch: get last message for all leads in ONE query using RPC or multiple-filter
    // We'll get recent conversations and group by phone in JS
    const { data: recentMsgs } = await supabase.from('conversations')
      .select('phone, message, direction, created_at')
      .eq('tenant_id', tid)
      .in('phone', phones)
      .order('created_at', { ascending: false })
      .limit(phones.length * 2); // 2x to ensure at least 1 per phone

    // Batch: get unread counts for all phones in ONE query
    const { data: unreadRows } = await supabase.from('conversations')
      .select('phone')
      .eq('tenant_id', tid)
      .in('phone', phones)
      .eq('direction', 'incoming')
      .eq('status', 'received');

    // Build lookup maps
    const lastMsgMap = new Map();
    for (const msg of (recentMsgs || [])) {
      if (!lastMsgMap.has(msg.phone)) {
        lastMsgMap.set(msg.phone, { message: msg.message, direction: msg.direction, created_at: msg.created_at });
      }
    }

    const unreadMap = new Map();
    for (const row of (unreadRows || [])) {
      unreadMap.set(row.phone, (unreadMap.get(row.phone) || 0) + 1);
    }

    const chats = leads.map(lead => ({
      ...lead,
      last_message: lastMsgMap.get(lead.phone) || null,
      unread_count: unreadMap.get(lead.phone) || 0
    }));

    res.json(chats);
  } catch (err) {
    console.error('Active chats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch active chats' });
  }
});

// ══════════════════════════════════════════════
// PAGE ROUTES
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true
}));

app.get('/', (req, res) => {
  const decoded = verifyTenantToken(req);
  if (decoded && decoded.role === 'tenant') return res.redirect(`/crm/${decoded.tenant_id}`);
  const adminDecoded = verifyToken(req, 'crm_admin_token');
  if (adminDecoded && adminDecoded.role === 'admin') return res.redirect('/admin');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  const decoded = verifyTenantToken(req);
  if (decoded) {
    if (decoded.role === 'admin') return res.redirect('/admin');
    return res.redirect(`/crm/${decoded.tenant_id}`);
  }
  const adminDecoded = verifyToken(req, 'crm_admin_token');
  if (adminDecoded && adminDecoded.role === 'admin') return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
  const decoded = verifyToken(req, 'crm_admin_token');
  if (!decoded || decoded.role !== 'admin') return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Support both /crm and /crm/:tid for backward compat
app.get('/crm', async (req, res) => {
  const decoded = verifyTenantToken(req);
  if (!decoded || decoded.role !== 'tenant') return res.redirect('/login');
  return res.redirect(`/crm/${decoded.tenant_id}`);
});

app.get('/crm/:tid', async (req, res) => {
  const tid = parseInt(req.params.tid);
  if (!tid || isNaN(tid)) return res.redirect('/login');

  const decoded = verifyToken(req, `crm_token_${tid}`);
  // Fallback to legacy cookie or scan
  const fallback = !decoded ? verifyTenantToken(req) : null;
  const authDecoded = decoded || fallback;

  if (!authDecoded || authDecoded.role !== 'tenant' || authDecoded.tenant_id !== tid) {
    return res.redirect('/login');
  }

  const { data: tenant } = await supabase.from('tenants')
    .select('id, is_active').eq('id', tid).maybeSingle();
  if (!tenant || !tenant.is_active) {
    res.clearCookie(`crm_token_${tid}`);
    return res.redirect('/login');
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  // Don't redirect API calls or static asset requests
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
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
