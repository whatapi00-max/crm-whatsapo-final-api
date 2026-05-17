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

// Helper: suppress AbortError / timeout noise from logs
function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' ||
    (err.message && err.message.toLowerCase().includes('aborted')));
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY environment variables are required!');
  process.exit(1);
}

// ── Supabase Client ─────────────────────────
// Supabase Pro plan — DB is always on, no wake-up delay needed.
// 20s timeout is generous for a live Pro instance; retries handle brief 502/503/504 blips.
const supabaseFetch = async (url, options = {}) => {
  const MAX_RETRIES = 2;
  const RETRY_DELAYS_MS = [2000, 5000]; // Pro: 2s then 5s — blips are brief

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s for Pro (was 55s for free-tier)
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (isAbortError(fetchErr)) throw fetchErr; // never retry timeouts
      if (attempt < MAX_RETRIES) {
        console.warn(`⚠️  Supabase network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s — transient blip`);
        await delay(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    // Detect Supabase/proxy 5xx errors that return raw HTML instead of JSON
    if (!response.ok && response.status >= 500) {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // Retry transient gateway errors before giving up
        if ([502, 503, 504].includes(response.status) && attempt < MAX_RETRIES) {
          console.warn(`⚠️  Supabase HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s — transient blip`);
          await delay(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(`Database unavailable (HTTP ${response.status}) — Supabase transient error, please retry`);
      }
    }
    return response;
  }
  // Fallback — should not be reached but satisfies linters
  throw new Error('Supabase fetch failed after retries');
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    global: { fetch: supabaseFetch },
    // Disable Supabase Auth background timers — we use our own JWT system
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  }
);

// ── Helpers ─────────────────────────────────
function cleanPhone(raw) {
  if (!raw) return '';
  return raw.split('@')[0].replace(/\D/g, '');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cookie options — use Secure+SameSite=None only when request came in over HTTPS
function cookieOpts(req, maxAgeMs) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return { httpOnly: true, secure: isHttps, sameSite: isHttps ? 'none' : 'lax', maxAge: maxAgeMs };
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

// ── Media Binary Cache (keep downloaded media in memory for proxy) ───
// Maps conversationId -> { buffer, contentType, ts }
const mediaBinaryCache = new Map();
const MEDIA_CACHE_TTL = 30 * 60 * 1000; // 30 min

function cacheMediaBinary(convId, buffer, contentType) {
  mediaBinaryCache.set(convId, { buffer, contentType, ts: Date.now() });
}
function getCachedMediaBinary(convId) {
  const entry = mediaBinaryCache.get(convId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MEDIA_CACHE_TTL) { mediaBinaryCache.delete(convId); return null; }
  return entry;
}
// Evict expired cached media every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of mediaBinaryCache) {
    if (now - entry.ts > MEDIA_CACHE_TTL) mediaBinaryCache.delete(id);
  }
}, 600000);

// Background: download media from WhatsApp and cache it (fire-and-forget)
async function cacheIncomingMedia(tenantId, convId, mediaId) {
  try {
    const result = await waManager.downloadMediaBinary(tenantId, mediaId);
    if (result && result.buffer) {
      cacheMediaBinary(convId, result.buffer, result.contentType);
      console.log(`🖼️ Cached media for conv ${convId}: ${result.buffer.length} bytes (${result.contentType})`);
    }
  } catch (err) {
    if (!isAbortError(err)) console.error(`⚠️ Background media cache failed for conv ${convId}:`, err.message);
  }
}

// ── Auto-Reply Rules Cache (avoid DB query on every incoming message) ──
// Maps tenantId -> { rules: [...], ts: number }
const autoReplyCache = new Map();
const AUTO_REPLY_CACHE_TTL = 300000; // 5 min — rules rarely change, avoids DB hit on every message
function getAutoReplyCached(tenantId) {
  const c = autoReplyCache.get(String(tenantId));
  if (c && (Date.now() - c.ts) < AUTO_REPLY_CACHE_TTL) return c.rules;
  return null;
}
function setAutoReplyCache(tenantId, rules) {
  autoReplyCache.set(String(tenantId), { rules, ts: Date.now() });
}
function invalidateAutoReplyCache(tenantId) {
  autoReplyCache.delete(String(tenantId));
  responseCache.delete(`auto_replies_${tenantId}`);
}

// ── Quick-Reply Cache (avoid DB query on every page load) ──
const quickReplyCache = new Map();
const QR_CACHE_TTL = 120000; // 2 min
function getQuickReplyCached(tenantId) {
  const c = quickReplyCache.get(String(tenantId));
  if (c && (Date.now() - c.ts) < QR_CACHE_TTL) return c.data;
  return null;
}
function setQuickReplyCache(tenantId, data) {
  quickReplyCache.set(String(tenantId), { data, ts: Date.now() });
}
function invalidateQuickReplyCache(tenantId) {
  quickReplyCache.delete(String(tenantId));
}

// ── Admin Notifications Store (in-memory) ──
const adminNotifications = [];
let notifIdCounter = 0;
function sanitizeNotifMessage(msg) {
  if (!msg) return 'Unknown error';
  const str = String(msg);
  // Truncate and strip HTML — prevents raw 502 pages flooding notifications
  if (str.trim().startsWith('<') || str.includes('</html>') || str.includes('<!DOCTYPE')) {
    const codeMatch = str.match(/(\d{3}).*Bad [Gg]ateway|HTTP (\d{3})/i);
    const code = (codeMatch && (codeMatch[1] || codeMatch[2])) || '502';
    return `Database unavailable (HTTP ${code}) — Supabase may be paused or restarting. Check https://supabase.com/dashboard`;
  }
  return str.substring(0, 300);
}

function pushAdminNotif(type, message, tenantId, tenantName) {
  adminNotifications.unshift({
    id: ++notifIdCounter,
    type, // 'copy_paste', 'warn', 'error', 'info'
    message: sanitizeNotifMessage(message),
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
  }

  getConfig(tenantId) {
    return this.configs.get(String(tenantId)) || null;
  }

  isReady(tenantId) {
    const cfg = this.getConfig(tenantId);
    return !!(cfg && cfg.phone_number_id && cfg.access_token && !cfg.banned);
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
      if (cfg.banned) return; // already banned — skip redundant DB writes, SSE broadcasts, and admin notifs
      cfg.banned = true;
      cfg.banned_reason = reason || 'Unknown';
      cfg.banned_at = new Date().toISOString();
      console.error(`🚫 [Tenant ${tenantId}] WhatsApp number BANNED: ${reason}`);
      // Immediately bust the admin tenants cache so next poll sees banned state
      responseCache.delete('admin_tenants');
      // Persist to DB (fire-and-forget)
      supabase.from('tenants').update({
        wa_banned: true,
        wa_banned_reason: (reason || 'Unknown').substring(0, 500),
        wa_banned_at: cfg.banned_at,
        updated_at: cfg.banned_at
      }).eq('id', tenantId).then(() => {}).catch(() => {});
      // Push real-time ban notification to any open CRM tabs for this tenant
      try { broadcastToTenant(tenantId, 'wa_banned', { reason: cfg.banned_reason, banned_at: cfg.banned_at }); } catch (_) {}
      // Push real-time ban notification to any open admin tabs (immediate)
      try { broadcastToAdmin('tenant_banned', { tenant_id: Number(tenantId), reason: cfg.banned_reason, banned_at: cfg.banned_at }); } catch (_) {}
    }
  }

  clearBan(tenantId) {
    const cfg = this.getConfig(tenantId);
    if (cfg) {
      delete cfg.banned;
      delete cfg.banned_reason;
      delete cfg.banned_at;
      // Persist to DB (fire-and-forget)
      supabase.from('tenants').update({
        wa_banned: false,
        wa_banned_reason: null,
        wa_banned_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', tenantId).then(() => {}).catch(() => {});
    }
  }

  async loadFromDB(tenantId) {
    const tid = String(tenantId);
    // Try loading with ban columns; fall back if columns don't exist yet (pre-migration)
    let tenant, error;
    ({ data: tenant, error } = await supabase.from('tenants')
      .select('wa_phone_number_id, wa_access_token, wa_waba_id, wa_banned, wa_banned_reason, wa_banned_at')
      .eq('id', tenantId).maybeSingle());
    if (error && (error.code === '42703' || (error.message && error.message.includes('does not exist')))) {
      // Ban columns not yet migrated — load without them
      ({ data: tenant, error } = await supabase.from('tenants')
        .select('wa_phone_number_id, wa_access_token, wa_waba_id')
        .eq('id', tenantId).maybeSingle());
    }

    if (error) throw error;

    if (tenant && tenant.wa_phone_number_id && tenant.wa_access_token) {
      const cfg = {
        phone_number_id: tenant.wa_phone_number_id,
        access_token: tenant.wa_access_token,
        waba_id: tenant.wa_waba_id || null
      };
      // Restore ban state from DB
      if (tenant.wa_banned) {
        cfg.banned = true;
        cfg.banned_reason = tenant.wa_banned_reason || 'Unknown';
        cfg.banned_at = tenant.wa_banned_at || null;
        console.warn(`🚫 [Tenant ${tid}] Loaded as BANNED: ${cfg.banned_reason}`);
      }
      this.configs.set(tid, cfg);
      if (!tenant.wa_banned) {
        console.log(`✅ [Tenant ${tid}] Cloud API config loaded (Phone ID: ${tenant.wa_phone_number_id})`);
      }
      return true;
    }
    return false;
  }

  async saveConfig(tenantId, phoneNumberId, accessToken, wabaId) {
    const tid = String(tenantId);

    // ── FIX: Clear duplicate phone_number_id from other tenants ──
    if (phoneNumberId) {
      // Remove from any other tenant in-memory Map that has the same phone_number_id
      for (const [otherTid, otherCfg] of this.configs) {
        if (otherTid !== tid && otherCfg.phone_number_id === phoneNumberId) {
          console.log(`⚠️  Removing duplicate phone_number_id ${phoneNumberId} from tenant ${otherTid} (now assigned to tenant ${tid})`);
          this.configs.delete(otherTid);
          // Also clear in DB for the old tenant
          await supabase.from('tenants').update({
            wa_phone_number_id: null, wa_access_token: null, wa_waba_id: null,
            updated_at: new Date().toISOString()
          }).eq('wa_phone_number_id', phoneNumberId).neq('id', tenantId);
          break;
        }
      }
      // Also clear any DB rows with this phone_number_id belonging to other tenants
      // (covers cases where config wasn't loaded into memory yet)
      await supabase.from('tenants').update({
        wa_phone_number_id: null, wa_access_token: null, wa_waba_id: null,
        updated_at: new Date().toISOString()
      }).eq('wa_phone_number_id', phoneNumberId).neq('id', tenantId);
    }

    const { error } = await supabase.from('tenants')
      .update({
        wa_phone_number_id: phoneNumberId || null,
        wa_access_token: accessToken || null,
        wa_waba_id: wabaId || null,
        wa_banned: false,
        wa_banned_reason: null,
        wa_banned_at: null,
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
    } else {
      this.removeConfig(tenantId);
    }
  }

  removeConfig(tenantId) {
    const tid = String(tenantId);
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
      if (errCode === 131031 || errCode === 368 || errCode === 131026 || errCode === 131056) {
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

  // ── Download Media Binary from WhatsApp ────
  async downloadMediaBinary(tenantId, mediaId) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.access_token) return null;

    try {
      // Step 1: Resolve media ID to download URL
      const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${cfg.access_token}` }
      });
      const metaData = await metaRes.json();
      if (!metaRes.ok || !metaData.url) return null;

      // Step 2: Download binary
      const mediaRes = await fetch(metaData.url, {
        headers: { 'Authorization': `Bearer ${cfg.access_token}` }
      });
      if (!mediaRes.ok) return null;

      const contentType = mediaRes.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await mediaRes.arrayBuffer());
      return { buffer, contentType };
    } catch (err) {
      console.error(`⚠️ downloadMediaBinary failed for ${mediaId}:`, err.message);
      return null;
    }
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
      if (errCode === 131031 || errCode === 368 || errCode === 131026 || errCode === 131056) {
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
      if (errCode === 131031 || errCode === 368 || errCode === 131026 || errCode === 131056) {
        this.markBanned(tenantId, `Error ${errCode}: ${errMsg}`);
      }
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Upload Image to WhatsApp ───────────────
  async uploadImageMedia(tenantId, imageBuffer, mimeType) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.phone_number_id || !cfg.access_token) {
      throw new Error('WhatsApp Cloud API not configured for this tenant');
    }

    const cleanMime = mimeType.split(';')[0].trim();
    const whatsappImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!whatsappImageTypes.includes(cleanMime)) {
      throw new Error(`Unsupported image type: ${cleanMime}. Use JPEG, PNG, or WebP.`);
    }

    const blob = new Blob([imageBuffer], { type: cleanMime });
    const ext = cleanMime === 'image/png' ? 'png' : cleanMime === 'image/webp' ? 'webp' : 'jpg';
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', cleanMime);
    formData.append('file', blob, `image.${ext}`);

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phone_number_id}/media`;
    console.log(`🖼️ Uploading image: ${cleanMime}, ${imageBuffer.length} bytes`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.access_token}` },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Image upload failed:', data);
      throw new Error(data.error?.message || 'Image upload failed');
    }
    console.log(`🖼️ Image uploaded, ID: ${data.id}`);
    return data.id;
  }

  // ── Send Image by Media ID ────────────────
  async sendImageById(tenantId, to, mediaId, caption) {
    const cfg = this.getConfig(tenantId);
    if (!cfg || !cfg.phone_number_id || !cfg.access_token) {
      throw new Error('WhatsApp Cloud API not configured for this tenant');
    }

    const cleanedTo = String(to).replace(/\D/g, '');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phone_number_id}/messages`;

    const imagePayload = { id: mediaId };
    if (caption) imagePayload.caption = String(caption).substring(0, 1024);

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
        type: 'image',
        image: imagePayload
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const errCode = data.error?.code;
      const errMsg = data.error?.message || data.error?.error_data?.details || JSON.stringify(data.error) || 'Cloud API error';
      if (errCode === 131031 || errCode === 368 || errCode === 131026 || errCode === 131056) {
        this.markBanned(tenantId, `Error ${errCode}: ${errMsg}`);
      }
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Auto-Reply Check ──────────────────────
  async checkAutoReply(tenantId, phone, body, isNew) {
    try {
      // Use cached rules to avoid DB hit on every incoming message
      let rules = getAutoReplyCached(tenantId);
      if (!rules) {
        const { data, error: rulesErr } = await supabase.from('auto_replies')
          .select('*').eq('tenant_id', tenantId).eq('is_active', true)
          .order('priority', { ascending: false });
        if (rulesErr) { console.error('Auto-reply fetch error:', rulesErr.message); return; }
        rules = data || [];
        setAutoReplyCache(tenantId, rules);
      }

      if (rules.length === 0) return;
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
            } catch (e) { console.error('⚠️  Auto-reply send error:', e.message); pushAdminNotif('error', `Auto-reply failed [${phone}]: ${e.message}`, tenantId, null); }
          }, 1500);
          return;
        }
      }
    } catch (err) {
      console.error('⚠️  Auto-reply check error:', err.message);
    }
  }

  destroyAll() {
    this.configs.clear();
  }
}

const waManager = new CloudAPIManager();

// ── SpamGuard: Centralized Anti-Spam Engine (15-min rolling window) ──────────
// Protects WhatsApp numbers from getting banned by detecting & blocking spam patterns.
//
// CTWA-aware: contacts who messaged YOU first (Click-to-WhatsApp leads) are
// warm leads — all 5 rules apply but with HIGHER thresholds so a genuine ad
// burst doesn't false-fire. Cold outbound contacts get STRICT thresholds.
//
// WARM thresholds (CTWA — they messaged you first):
//   1. Same message content sent to 10+ warm contacts in 15 min
//   2. Same message content sent 10+ total times to warm contacts in 15 min
//   3. 50+ unique warm contacts messaged in 15 min
//   4. 80+ total messages to warm contacts in 15 min
//   5. 8+ messages to same contact in 15 min (harassment — same for all)
//
// COLD thresholds (you initiate, they never messaged first):
//   1. Same message content sent to 4+ cold contacts in 15 min
//   2. Same message content sent 4+ total times to cold contacts in 15 min
//   3. 20+ unique cold contacts messaged in 15 min
//   4. 40+ total messages to cold contacts in 15 min
//   5. 8+ messages to same contact in 15 min (harassment — same for all)

const SPAM_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const INBOUND_TTL_MS = 24 * 60 * 60 * 1000; // 24h — WhatsApp conversation window

// Warm (CTWA) thresholds — higher limits, genuine ad leads
const WARM_SAME_MSG_CONTACTS = 10;
const WARM_SAME_MSG_TOTAL    = 10;
const WARM_UNIQUE_CONTACTS   = 50;
const WARM_TOTAL_MESSAGES    = 80;

// Cold (outbound) thresholds — strict
const COLD_SAME_MSG_CONTACTS = 4;
const COLD_SAME_MSG_TOTAL    = 4;
const COLD_UNIQUE_CONTACTS   = 20;
const COLD_TOTAL_MESSAGES    = 40;

// Universal — applies to everyone
const SPAM_SAME_CONTACT = 8; // N messages to same contact in window

// Per-tenant outgoing message log: [{ phone, content, ts, cold }]
const spamGuard = new Map();

// Inbound contact tracker — phone numbers that have messaged YOU first
// tenantId -> Map<phone, lastInboundTimestamp>
const inboundContacts = new Map();

// Called from webhook when an inbound message arrives
function markInbound(tenantId, phone) {
  if (!inboundContacts.has(tenantId)) inboundContacts.set(tenantId, new Map());
  inboundContacts.get(tenantId).set(phone, Date.now());
}

// Returns true if this phone sent you a message in the last 24 hours
function isInboundContact(tenantId, phone) {
  const map = inboundContacts.get(tenantId);
  if (!map) return false;
  const ts = map.get(phone);
  if (!ts) return false;
  if (Date.now() - ts > INBOUND_TTL_MS) { map.delete(phone); return false; }
  return true;
}

function getSpamState(tenantId) {
  if (!spamGuard.has(tenantId)) spamGuard.set(tenantId, { msgs: [] });
  return spamGuard.get(tenantId);
}

function pruneSpamState(state) {
  const cutoff = Date.now() - SPAM_WINDOW_MS;
  state.msgs = state.msgs.filter(m => m.ts > cutoff);
}

function isTenantFrozen(tenantId) {
  const w = marketerWarnings.get(tenantId);
  return !!(w && Date.now() < w.expiresAt);
}

// Check spam rules. Returns { allowed, reason }
// Call BEFORE actually sending the message to WhatsApp.
function spamCheck(tenantId, phone, content) {
  const state = getSpamState(tenantId);
  pruneSpamState(state);

  // If already frozen, block immediately
  if (isTenantFrozen(tenantId)) {
    return { allowed: false, reason: 'Your account is temporarily frozen. Please wait for the cooldown to end.' };
  }

  const now = Date.now();
  const normalContent = (content || '').trim().toLowerCase();
  const warm = isInboundContact(tenantId, phone); // true = CTWA warm lead

  // Pick thresholds based on contact type
  const SAME_MSG_CONTACTS = warm ? WARM_SAME_MSG_CONTACTS : COLD_SAME_MSG_CONTACTS;
  const SAME_MSG_TOTAL    = warm ? WARM_SAME_MSG_TOTAL    : COLD_SAME_MSG_TOTAL;
  const UNIQUE_CONTACTS   = warm ? WARM_UNIQUE_CONTACTS   : COLD_UNIQUE_CONTACTS;
  const TOTAL_MESSAGES    = warm ? WARM_TOTAL_MESSAGES    : COLD_TOTAL_MESSAGES;

  // Segment messages by same type (warm vs cold) for accurate counting
  const segMsgs = state.msgs.filter(m => m.cold === !warm);

  // ── Rule 5: harassment — applies to ALL contacts regardless of type ──
  const sameContactCount = state.msgs.filter(m => m.phone === phone).length + 1;
  if (sameContactCount >= SPAM_SAME_CONTACT) {
    return spamFreeze(tenantId, `Sent ${sameContactCount} messages to same contact in 15 min`);
  }

  // ── Rules 1 & 2: same message content ──
  const sameMsgs = segMsgs.filter(m => m.content === normalContent);
  const samePhones = new Set(sameMsgs.map(m => m.phone));
  samePhones.add(phone);
  if (samePhones.size >= SAME_MSG_CONTACTS) {
    return spamFreeze(tenantId, `Same message sent to ${samePhones.size} different contacts in 15 min`);
  }
  if (sameMsgs.length + 1 >= SAME_MSG_TOTAL) {
    return spamFreeze(tenantId, `Same message sent ${sameMsgs.length + 1} times in 15 min`);
  }

  // ── Rule 3: too many unique contacts of same type ──
  const uniquePhones = new Set(segMsgs.map(m => m.phone));
  uniquePhones.add(phone);
  if (uniquePhones.size >= UNIQUE_CONTACTS) {
    return spamFreeze(tenantId, `Messaged ${uniquePhones.size} ${warm ? 'contacts' : 'new contacts'} in 15 min`);
  }

  // ── Rule 4: total volume of same type ──
  if (segMsgs.length + 1 >= TOTAL_MESSAGES) {
    return spamFreeze(tenantId, `Sent ${segMsgs.length + 1} messages in 15 min`);
  }

  // All checks passed — record the message
  state.msgs.push({ phone, content: normalContent, ts: now, cold: !warm });
  return { allowed: true, reason: null };
}

function spamFreeze(tenantId, reason) {
  const freezeMsg = `⚠️ Anti-spam protection — ${reason}. Screen frozen for 60 seconds.`;
  marketerWarnings.set(tenantId, { message: freezeMsg, expiresAt: Date.now() + 60000 });

  // Notify admin (throttle: once per 15 min per tenant)
  setImmediate(async () => {
    try {
      const alreadyNotified = adminNotifications.some(n =>
        n.type === 'copy_paste' && n.tenant_id === tenantId &&
        (Date.now() - new Date(n.timestamp).getTime()) < 900000
      );
      if (!alreadyNotified) {
        const { data: td } = await supabase.from('tenants').select('name').eq('id', tenantId).maybeSingle();
        const tname = td?.name || `Marketer #${tenantId}`;
        pushAdminNotif('copy_paste',
          `"${tname}" AUTO-FROZEN — ${reason}`,
          tenantId, tname
        );
      }
    } catch (_) { /* silent */ }
  });

  console.log(`🛡️ [SpamGuard] Tenant ${tenantId} frozen: ${reason}`);
  return { allowed: false, reason: freezeMsg, frozen: true };
}

// Legacy wrapper — still used by admin dashboard stats
function trackCopyPaste(tenantId, phone, message) {
  const state = getSpamState(tenantId);
  pruneSpamState(state);
  const normalContent = (message || '').trim().toLowerCase();
  const sameMsgs = state.msgs.filter(m => m.content === normalContent);
  const uniquePhones = new Set(sameMsgs.map(m => m.phone)).size;
  return { uniquePhones, totalSends: sameMsgs.length };
}

// ── Global Scheduled Message Checker ─────────────────────────────────────────
// Single interval across all tenants: 1 DB query/min instead of N queries/30s
let schedulerRunning = false;
const globalSchedulerInterval = setInterval(async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const { data: pending, error: pendErr } = await supabase.from('scheduled_messages')
      .select('*').eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true }).limit(20);

    if (pendErr) {
      console.error('⚠️  Scheduler DB error:', pendErr.message);
      // Only notify admin for non-timeout errors (AbortError is usually transient)
      if (!isAbortError(pendErr)) {
        pushAdminNotif('error', `Scheduler DB error: ${pendErr.message}`, null, 'System');
      }
      return;
    }
    if (!pending || pending.length === 0) return;

    for (const sm of pending) {
      if (!waManager.isReady(sm.tenant_id)) continue;
      try {
        const cleanedPhone = sm.phone.replace(/\D/g, '');
        await delay(MESSAGE_DELAY_MS);
        await waManager.sendMessage(sm.tenant_id, cleanedPhone, sm.message);
        await supabase.from('conversations').insert({
          tenant_id: sm.tenant_id, phone: cleanedPhone, message: sm.message,
          direction: 'outgoing', status: 'sent'
        });
        await supabase.from('scheduled_messages')
          .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', sm.id);
        console.log(`⏰ [Tenant ${sm.tenant_id}] Scheduled message sent to ${cleanedPhone}`);
      } catch (e) {
        await supabase.from('scheduled_messages')
          .update({ status: 'failed', error_message: e.message }).eq('id', sm.id);
      }
    }
  } catch (err) {
    console.error('⚠️  Global scheduler error:', err.message);
    pushAdminNotif('error', `Scheduler error: ${err.message}`, null, 'System');
  } finally {
    schedulerRunning = false;
  }
}, 120000); // 120s — check for pending scheduled messages every 2 min

// ── Initialize All Active Tenants ───────────
let _initRunning = false;
async function initAllTenants() {
  if (_initRunning) return; // prevent stacking parallel retries
  _initRunning = true;
  let wait = 15000; // start at 15s
  const maxWait = 300000; // cap at 5 minutes
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const { data: tenants, error: tenantsErr } = await supabase.from('tenants').select('id, name').eq('is_active', true);
      if (tenantsErr) throw tenantsErr;
      if (!tenants || tenants.length === 0) {
        console.log('ℹ️  No active tenants found. Create one via admin dashboard.');
        _initRunning = false;
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
      _initRunning = false;
      return; // success
    } catch (err) {
      const msg = isAbortError(err) ? 'timeout' : err.message;
      console.warn(`⚠️  Supabase not ready (attempt ${attempt}, ${msg}), retrying in ${wait / 1000}s...`);
      await delay(wait);
      wait = Math.min(wait * 2, maxWait); // exponential backoff: 15s, 30s, 60s, 120s, 300s...
    }
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
    if (resolvedTenantId) {
      console.log(`📡 Webhook: phone_number_id=${phoneNumberId} → tenant ${resolvedTenantId} (from memory)`);
    }
    if (!resolvedTenantId) {
      // Try loading from DB in case config was added recently
      const { data: tenant, error: tenantErr } = await supabase.from('tenants')
        .select('id').eq('wa_phone_number_id', phoneNumberId).eq('is_active', true).maybeSingle();
      if (tenantErr) {
        console.error(`⚠️  Webhook DB lookup failed for phone_number_id ${phoneNumberId}:`, tenantErr.message);
        continue;
      }
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
          body = msg.image?.caption ? `📷 ${msg.image.caption}` : '📷 Image';
          incomingMediaId = msg.image?.id || null;
          if (incomingMediaId) {
            console.log(`🖼️ IMAGE RECEIVED from ${phone}: media_id=${incomingMediaId}`);
          }
        } else if (msg.type === 'video') {
          body = msg.video?.caption || '[Video]';
        } else if (msg.type === 'audio' || msg.type === 'ptt') {
          body = '🎤 Voice message';
          incomingMediaId = (msg.audio?.id || msg.ptt?.id) || null;
          if (incomingMediaId) {
            console.log(`🎙️ AUDIO/PTT RECEIVED from ${phone}: type=${msg.type}, media_id=${incomingMediaId}`);
          } else {
            console.warn(`⚠️ AUDIO/PTT from ${phone}: type=${msg.type} — no media ID found in payload`);
            console.warn(`   audio=${JSON.stringify(msg.audio)}, ptt=${JSON.stringify(msg.ptt)}`);
          }
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
          // Bust message cache so marketer's next load sees this incoming message immediately
          responseCache.delete(`msgs_${resolvedTenantId}_${phone}`);
          // Cache incoming media binary in background for fast proxy serving
          if (incomingMediaId && insertedRows?.[0]?.id) {
            cacheIncomingMedia(resolvedTenantId, insertedRows[0].id, incomingMediaId);
          }
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

          // Fire-and-forget: activity_log is non-critical, don't block the hot webhook path
          supabase.from('activity_log').insert({
            tenant_id: resolvedTenantId, phone, action: 'lead_created',
            details: `New lead from ${source}: ${contactName}`
          }).then(() => {}).catch(() => {});
        } else {
          // Fire-and-forget: updating last_message_at doesn't need to block here
          // (webhook already responded 200; we just need it written eventually)
          supabase.from('leads').update({
            last_message_at: new Date().toISOString(), real_phone: phone
          }).eq('tenant_id', resolvedTenantId).eq('phone', phone)
            .then(() => {}).catch(() => {});
        }

        // Mark this phone as a warm inbound contact (CTWA lead)
        markInbound(resolvedTenantId, phone);

        // Check auto-replies
        if (waManager.isReady(resolvedTenantId)) {
          await waManager.checkAutoReply(resolvedTenantId, phone, body, isNew);
        }
      } catch (err) {
        console.error(`❌ Webhook message processing error:`, err.message);
        pushAdminNotif('error', `Webhook message error: ${err.message}`, resolvedTenantId, null);
      }
    }

    // Handle message status updates (sent, delivered, read, failed)
    const statuses = value.statuses || [];
    for (const status of statuses) {
      try {
        if (status.status === 'failed') {
          const errCode = status.errors?.[0]?.code;
          const errMsg = status.errors?.[0]?.message || 'Unknown error';
          const recipientPhone = status.recipient_id ? cleanPhone(status.recipient_id) : null;
          console.warn(`⚠️  [Tenant ${resolvedTenantId}] Message ${status.id} FAILED to ${recipientPhone || '?'}: ${errMsg} (code: ${errCode})`);

          // Update the conversation record to 'failed' so CRM shows the real status
          if (recipientPhone) {
            // SELECT the most recent sent message first, then update ONLY that row by ID
            // (Supabase .limit() on UPDATE may not limit rows — could mark all sent msgs as failed)
            const { data: toUpdate } = await supabase.from('conversations')
              .select('id')
              .eq('tenant_id', resolvedTenantId)
              .eq('phone', recipientPhone)
              .eq('direction', 'outgoing')
              .eq('status', 'sent')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (toUpdate) {
              const { error: updErr } = await supabase.from('conversations')
                .update({ status: 'failed' })
                .eq('id', toUpdate.id);
              if (updErr) console.error(`❌ Failed to update conversation status:`, updErr.message);
            }
          }

          // Push SSE event so the open CRM tab shows the failure immediately
          broadcastToTenant(resolvedTenantId, 'message_failed', {
            phone: recipientPhone,
            error: errMsg,
            error_code: errCode,
            wa_message_id: status.id
          });

          pushAdminNotif('error', `Message to ${recipientPhone || '?'} failed: ${errMsg} (code: ${errCode})`, resolvedTenantId);

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
                phone: recipientPhone || 'system',
                action: 'wa_banned',
                details: `WhatsApp number banned/restricted. Error ${errCode}: ${errMsg}`
              });
            } catch (_) {}
          }
        }
      } catch (statusErr) {
        console.error(`❌ Webhook status processing error:`, statusErr.message);
      }
    }
  }
}

// ══════════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════════
const app = express();

// Trust the first proxy hop (required when running behind Render, nginx, etc.)
app.set('trust proxy', 1);

// Detect if we're behind a reverse proxy / on HTTPS so we can safely set
// upgrade-insecure-requests and HSTS.  On plain HTTP localhost these headers
// break the browser (all fetch calls get silently upgraded to https:// which
// doesn't exist).
const FORCE_HTTPS_HEADERS = process.env.FORCE_HTTPS === 'true' ||
  process.env.RENDER === 'true';

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.tailwindcss.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "blob:", "data:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "https://cdn.tailwindcss.com"],
      frameSrc: ["'none'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      ...(FORCE_HTTPS_HEADERS ? { upgradeInsecureRequests: [] } : {}),
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: FORCE_HTTPS_HEADERS ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Security: prevent clickjacking, sniffing, and leaking server info
app.disable('x-powered-by');

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

// General API limiter — raised to 600/min per IP so 100 marketers behind a single NAT
// (office/datacenter) don't trip each other's limits (each polls ~3–4 req/30s)
const apiLimiter = rateLimit({
  windowMs: 60000, max: 600,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => !!req.tenantId // skip if already tenant-auth'd (auth already a gate)
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
  const legacy = verifyToken(req, 'crm_token');
  return (legacy && legacy.role === 'tenant') ? legacy : null;
}

// ── Tenant verification cache (avoids DB hit on every API call) ──
const tenantVerifyCache = new Map(); // tenantId -> { active, ts }
const TENANT_CACHE_TTL = 120000; // 120s (2 min)

function isTenantCachedActive(tenantId) {
  const cached = tenantVerifyCache.get(tenantId);
  if (cached && (Date.now() - cached.ts) < TENANT_CACHE_TTL) return cached.active;
  return null;
}

// Invalidate all caches for a tenant (call on update/delete/deactivate)
function invalidateTenantCache(tenantId) {
  tenantVerifyCache.delete(tenantId);
  responseCache.delete(`auth_check_${tenantId}`);
  responseCache.delete(`active_chats_${tenantId}`);
  responseCache.delete(`stats_${tenantId}`);
  responseCache.delete('admin_tenants');
  invalidateLeadsCache(tenantId);
}

// Bust all leads_<tid>_* cache entries for a tenant
function invalidateLeadsCache(tenantId) {
  const prefix = `leads_${tenantId}_`;
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}

// Evict expired tenantVerifyCache entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tenantVerifyCache) {
    if (now - entry.ts >= TENANT_CACHE_TTL) tenantVerifyCache.delete(id);
  }
}, 300000);

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

  // Lazy-load WA config if not in memory (e.g. after startup timeout)
  if (!waManager.getConfig(decoded.tenant_id)) {
    try { await waManager.loadFromDB(decoded.tenant_id); } catch (_) {}
  }

  const cookieName = `crm_token_${decoded.tenant_id}`;
  // Refresh only when token has < 5 min remaining (not on every request after 5 min)
  const timeToExpiry = (decoded.exp || 0) - Math.floor(Date.now() / 1000);
  if (timeToExpiry > 0 && timeToExpiry < 300) {
    const newToken = jwt.sign({
      tenant_id: decoded.tenant_id, username: decoded.username,
      name: decoded.name, role: 'tenant'
    }, JWT_SECRET, { expiresIn: '30m' });
    res.cookie(cookieName, newToken, cookieOpts(req, 30 * 60 * 1000));
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
// PUBLIC HEALTH CHECK (no auth — for Render / load balancers)
// ══════════════════════════════════════════════
app.get('/health', async (req, res) => {
  // Cache the DB check for 30s to avoid hammering Supabase
  let dbOk = true;
  const cached = getCachedResponse('_health_db');
  if (cached !== null) {
    dbOk = cached;
  } else {
    try {
      const { error } = await supabase.from('tenants').select('id', { count: 'exact', head: true }).limit(1);
      if (error) dbOk = false;
    } catch (_) { dbOk = false; }
    setCachedResponse('_health_db', dbOk, 30000);
  }

  const mem = process.memoryUsage();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    ts: Date.now(),
    db: dbOk ? 'connected' : 'unreachable',
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    active_tenants: waManager.configs.size
  });
});

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
    pushAdminNotif('error', `Webhook processing error: ${err.message}`, null, 'System');
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

    res.cookie(`crm_token_${tenant.id}`, token, cookieOpts(req, 30 * 60 * 1000));

    res.json({
      success: true, role: 'tenant',
      user: { id: tenant.id, name: tenant.name, username: tenant.username }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    pushAdminNotif('error', `Tenant login failed: ${err.message}`, null, 'Auth');
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

    res.cookie('crm_admin_token', token, cookieOpts(req, 24 * 60 * 60 * 1000));

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
    // Cache tenant active-check for 60s to avoid repeated DB hits
    const cacheKey = `auth_check_${decoded.tenant_id}`;
    const cached = getCachedResponse(cacheKey);
    if (!cached) {
      const { data: tenant } = await supabase.from('tenants')
        .select('id, is_active').eq('id', decoded.tenant_id).maybeSingle();
      if (!tenant || !tenant.is_active) {
        res.clearCookie(`crm_token_${decoded.tenant_id}`);
        res.clearCookie('crm_token');
        return res.status(401).json({ authenticated: false, reason: 'deleted' });
      }
      setCachedResponse(cacheKey, true, 60000);
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
    const cacheKey = 'admin_tenants';
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const { data, error } = await supabase.from('tenants')
      .select('id, username, unique_key, name, is_active, created_at, updated_at, wa_phone_number_id, wa_banned')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const tenants = (data || []).map(t => {
      let wa_status = waManager.getStatus(t.id);
      // Fallback: if in-memory says not_configured but DB has config, use DB state
      if (wa_status === 'not_configured' && t.wa_phone_number_id) {
        wa_status = t.wa_banned ? 'banned' : 'connected';
        // Also try to lazy-load into memory for future requests
        waManager.loadFromDB(t.id).catch(() => {});
      }
      return { ...t, wa_status, wa_configured: !!(t.wa_phone_number_id) };
    });

    setCachedResponse(cacheKey, tenants, 60000);
    res.json(tenants);
  } catch (err) {
    console.error('Failed to fetch tenants:', err.message);
    // Only notify admin for non-timeout errors (AbortError is usually transient)
    if (!isAbortError(err)) {
      pushAdminNotif('error', `Load marketers failed: ${err.message}`, null, 'Admin');
    }
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
    responseCache.delete('admin_tenants'); // Bust cache so admin sees new tenant immediately
    res.json({ ...data, password_plain: String(password), wa_status: 'not_configured' });
  } catch (err) {
    console.error('Create tenant error:', err.message);
    pushAdminNotif('error', `Create marketer failed: ${err.message}`, null, 'Admin');
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

    invalidateTenantCache(id); // Force re-check on next request (handles deactivation)
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
    invalidateTenantCache(id); // Immediately revoke all auth caches

    const { error } = await supabase.from('tenants').delete().eq('id', id);
    if (error) throw error;

    console.log(`🗑️  Tenant ${id} fully purged`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete tenant error:', err.message);
    pushAdminNotif('error', `Delete marketer #${req.params.id} failed: ${err.message}`, null, 'Admin');
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

// ── Configure WhatsApp Cloud API for Tenant ─
app.post('/api/admin/tenants/:id/configure-wa', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    let { phone_number_id, access_token, waba_id } = req.body;

    if (!phone_number_id) {
      return res.status(400).json({ error: 'Phone Number ID is required' });
    }

    const { data: tenant } = await supabase.from('tenants')
      .select('id, name, is_active, wa_access_token').eq('id', id).maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.is_active) return res.status(400).json({ error: 'Tenant is deactivated' });

    // Handle __keep_existing__ sentinel — reuse stored token
    if (access_token === '__keep_existing__') {
      if (!tenant.wa_access_token) {
        return res.status(400).json({ error: 'No existing token found. Please provide an Access Token.' });
      }
      access_token = tenant.wa_access_token;
    }

    if (!access_token) {
      return res.status(400).json({ error: 'Access Token is required' });
    }

    // Check if another tenant already uses this phone_number_id
    const { data: duplicate } = await supabase.from('tenants')
      .select('id, name').eq('wa_phone_number_id', phone_number_id).neq('id', id).maybeSingle();
    if (duplicate) {
      console.log(`⚠️  Phone Number ID ${phone_number_id} was assigned to tenant ${duplicate.id} (${duplicate.name}), will be reassigned to tenant ${id}`);
    }

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
    if (duplicate) {
      console.log(`   ↳ Disconnected from tenant ${duplicate.id} (${duplicate.name})`);
    }
    res.json({
      success: true, status: 'connected',
      phone_display: testData.display_phone_number || phone_number_id,
      verified_name: testData.verified_name || null,
      reassigned_from: duplicate ? { id: duplicate.id, name: duplicate.name } : null
    });
  } catch (err) {
    console.error(`❌ Configure WA error for tenant ${req.params.id}:`, err.message);
    pushAdminNotif('error', `WhatsApp config failed for marketer #${req.params.id}: ${err.message}`, parseInt(req.params.id), null);
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

// ── Debug: Show all WA config mappings ──────
app.get('/api/admin/wa-config-map', adminAuth, async (req, res) => {
  try {
    // In-memory state
    const memoryMap = [];
    for (const [tid, cfg] of waManager.configs) {
      memoryMap.push({
        tenant_id: tid,
        phone_number_id: cfg.phone_number_id,
        waba_id: cfg.waba_id || null,
        banned: cfg.banned || false
      });
    }
    // DB state
    const { data: dbTenants, error } = await supabase.from('tenants')
      .select('id, name, username, wa_phone_number_id, wa_waba_id, is_active')
      .not('wa_phone_number_id', 'is', null)
      .order('id', { ascending: true });
    if (error) throw error;

    // Check for duplicates
    const phoneIdCounts = {};
    for (const t of (dbTenants || [])) {
      const pid = t.wa_phone_number_id;
      if (!phoneIdCounts[pid]) phoneIdCounts[pid] = [];
      phoneIdCounts[pid].push({ id: t.id, name: t.name, username: t.username });
    }
    const duplicates = Object.entries(phoneIdCounts)
      .filter(([, tenants]) => tenants.length > 1)
      .map(([phone_number_id, tenants]) => ({ phone_number_id, tenants }));

    res.json({
      memory_configs: memoryMap,
      db_configs: (dbTenants || []).map(t => ({
        tenant_id: t.id, name: t.name, username: t.username,
        phone_number_id: t.wa_phone_number_id, is_active: t.is_active
      })),
      duplicates,
      has_issues: duplicates.length > 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get config map' });
  }
});

// ── Admin Stats ─────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const cacheKey = 'admin_stats';
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const [tenantsRes, leadsRes, msgsRes] = await Promise.all([
      supabase.from('tenants').select('id', { count: 'exact', head: true }),
      supabase.from('leads').select('id', { count: 'exact', head: true }),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);

    if (tenantsRes.error) throw tenantsRes.error;

    const result = {
      total_tenants: tenantsRes.count || 0,
      total_leads: leadsRes.count || 0,
      messages_today: msgsRes.count || 0
    };
    setCachedResponse(cacheKey, result, 300000); // 5 min — count queries are expensive at scale
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// ── Tenant Stats for Admin ──────────────────
app.get('/api/admin/tenants/:id/stats', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cacheKey = `admin_tenant_stats_${id}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);
    const [leadsRes, msgsRes] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', id),
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', id).eq('direction', 'outgoing').gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);
    const result = { leads: leadsRes.count || 0, messages_today: msgsRes.count || 0 };
    setCachedResponse(cacheKey, result, 180000); // 3 min cache
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tenant stats' });
  }
});

// ── Storage Stats (Admin) ───────────────────
app.get('/api/admin/storage', adminAuth, async (req, res) => {
  try {
    const cacheKey = 'admin_storage';
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);
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

    const storageResult = {
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
    };
    setCachedResponse('admin_storage', storageResult, 300000); // 5 min
    res.json(storageResult);
  } catch (err) {
    console.error('Storage stats error:', err.message);
    pushAdminNotif('error', `Storage stats failed: ${err.message}`, null, 'Admin');
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// ── Per-Tenant Storage Breakdown ────────────
app.get('/api/admin/storage/tenants', adminAuth, async (req, res) => {
  try {
    const cacheKey = 'admin_storage_tenants';
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const { data: allTenants } = await supabase.from('tenants').select('id, name, username, wa_phone_number_id, wa_banned');
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
      let waStatus = waManager.getStatus(t.id);
      if (waStatus === 'not_configured' && t.wa_phone_number_id) {
        waStatus = t.wa_banned ? 'banned' : 'connected';
        waManager.loadFromDB(t.id).catch(() => {});
      }

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
    setCachedResponse(cacheKey, breakdown, 900000); // 15 min — storage doesn't change rapidly
    res.json(breakdown);
  } catch (err) {
    console.error('Tenant storage breakdown error:', err.message);
    pushAdminNotif('error', `Tenant storage breakdown failed: ${err.message}`, null, 'Admin');
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
    pushAdminNotif('error', `Storage cleanup failed: ${err.message}`, null, 'Admin');
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
    const cacheKey = 'admin_dashboard';
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const { data: allTenants, error } = await supabase.from('tenants')
      .select('id, name, username, is_active, wa_phone_number_id, wa_banned')
      .order('name', { ascending: true });
    if (error) throw error;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();

    // Run all tenant queries in parallel but only 4 queries each (removed hourData — uses in-memory cpTracker)
    const marketers = await Promise.all((allTenants || []).map(async (t) => {
      try {
      const [leadsRes, msgsToday, weekData, incomingToday] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id).eq('direction', 'outgoing').gte('created_at', oneDayAgo),
        supabase.from('conversations').select('created_at')
          .eq('tenant_id', t.id).eq('direction', 'outgoing').gte('created_at', sevenDaysAgo).limit(700),
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id).eq('direction', 'incoming').gte('created_at', oneDayAgo),
      ]);

      // Build 7-day chart: index 6 = today, index 0 = 6 days ago
      const chart = new Array(7).fill(0); 
      const now = new Date();
      (weekData.data || []).forEach(row => {
        const d = Math.floor((now - new Date(row.created_at)) / 86400000);
        if (d >= 0 && d < 7) chart[6 - d]++;
      });

      // Spam detection from SpamGuard (zero DB cost) — cold sends only
      const sgState = spamGuard.get(t.id);
      let copyPasteMax = 0;
      if (sgState) {
        const cutoff = Date.now() - SPAM_WINDOW_MS;
        const recent = sgState.msgs.filter(m => m.ts > cutoff && m.cold);
        const contentCounts = new Map();
        for (const m of recent) {
          contentCounts.set(m.content, (contentCounts.get(m.content) || 0) + 1);
        }
        for (const c of contentCounts.values()) {
          if (c > copyPasteMax) copyPasteMax = c;
        }
      }
      const copyPasteWarn = copyPasteMax >= COLD_SAME_MSG_TOTAL || isTenantFrozen(t.id);

      let wa_status = waManager.getStatus(t.id);
      if (wa_status === 'not_configured' && t.wa_phone_number_id) {
        wa_status = t.wa_banned ? 'banned' : 'connected';
        waManager.loadFromDB(t.id).catch(() => {});
      }

      return {
        id: t.id, name: t.name, username: t.username,
        is_active: t.is_active, wa_status,
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
      } catch (tErr) {
        console.error(`⚠️  Dashboard stats failed for tenant ${t.id}:`, tErr.message);
        let wa_status_err = waManager.getStatus(t.id);
        if (wa_status_err === 'not_configured' && t.wa_phone_number_id) {
          wa_status_err = t.wa_banned ? 'banned' : 'connected';
        }
        return {
          id: t.id, name: t.name, username: t.username,
          is_active: t.is_active, wa_status: wa_status_err,
          stats: { total_leads: 0, messages_today: 0, messages_week: 0, incoming_today: 0, weekly_chart: new Array(7).fill(0) },
          copy_paste_warning: false, copy_paste_max: 0, error: true,
        };
      }
    }));

    const result = {
      marketers,
      total_messages_today: marketers.reduce((s, m) => s + m.stats.messages_today, 0),
      total_messages_week: marketers.reduce((s, m) => s + m.stats.messages_week, 0),
      copy_paste_alerts: marketers.filter(m => m.copy_paste_warning).length,
    };
    setCachedResponse(cacheKey, result, 600000); // 10 min — expensive query, cache longer to reduce DB load
    res.json(result);
  } catch (err) {
    if (!isAbortError(err)) console.error('Dashboard error:', err.message);
    // Return last cached value if available, otherwise empty shell
    const stale = getCachedResponse ? responseCache.get('admin_dashboard') : null;
    if (stale) return res.json(stale.data);
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

// ── Client-side Error Reporting (from marketer CRM) ──
const _reportedErrors = new Map(); // throttle: key -> timestamp
app.post('/api/report-error', tenantAuth, (req, res) => {
  const { error: errMsg, context, api_path } = req.body || {};
  if (!errMsg) return res.status(400).json({ error: 'Missing error' });
  // Throttle: same error from same tenant max once per 5 minutes
  const key = `${req.tenantId}_${errMsg.substring(0, 80)}`;
  const now = Date.now();
  if (_reportedErrors.get(key) && (now - _reportedErrors.get(key)) < 300000) {
    return res.json({ success: true, throttled: true });
  }
  _reportedErrors.set(key, now);
  // Clean old entries every 100 reports
  if (_reportedErrors.size > 500) {
    for (const [k, v] of _reportedErrors) { if (now - v > 600000) _reportedErrors.delete(k); }
  }
  const details = [
    errMsg.substring(0, 200),
    api_path ? `API: ${api_path}` : '',
    context ? `Context: ${context}` : ''
  ].filter(Boolean).join(' | ');
  pushAdminNotif('error', details, req.tenantId, req.tenantName);
  res.json({ success: true });
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
  // No caching — status changes (especially bans) must be visible immediately
  res.set('Cache-Control', 'no-store');
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

    if (waManager.getStatus(req.tenantId) === 'banned') {
      const cfg = waManager.getConfig(req.tenantId);
      return res.status(403).json({ error: '\ud83d\udeab WhatsApp number is banned/restricted. ' + (cfg?.banned_reason || 'Contact admin.'), banned: true });
    }
    if (!waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured. Contact admin.' });
    }

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // 🛡️ SpamGuard: check BEFORE sending to WhatsApp
    const spam = spamCheck(req.tenantId, cleanedPhone, message);
    if (!spam.allowed) {
      return res.status(429).json({ error: spam.reason, spam_frozen: true });
    }

    await waManager.sendMessage(req.tenantId, cleanedPhone, message);

    const now = new Date().toISOString();
    await Promise.all([
      supabase.from('conversations').insert({
        tenant_id: req.tenantId, phone: cleanedPhone, message,
        direction: 'outgoing', status: 'sent'
      }),
      supabase.from('leads')
        .update({ last_message_at: now })
        .eq('tenant_id', req.tenantId).eq('phone', cleanedPhone)
    ]);
    // Bust message cache so next load fetches the new message
    responseCache.delete(`msgs_${req.tenantId}_${cleanedPhone}`);

    res.json({ success: true, phone: cleanedPhone, timestamp: now, spam_frozen: false });
  } catch (err) {
    pushAdminNotif('error', `Send message failed [${req.body.phone || '?'}]: ${err.message}`, req.tenantId, req.tenantName);
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

    if (waManager.getStatus(req.tenantId) === 'banned') {
      const cfg = waManager.getConfig(req.tenantId);
      return res.status(403).json({ error: '\ud83d\udeab WhatsApp number is banned/restricted. ' + (cfg?.banned_reason || 'Contact admin.'), banned: true });
    }
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

    res.json({ success: true, phone: cleanedPhone, timestamp: now, media_url: 'wamid:' + mediaId, spam_frozen: false });
  } catch (err) {
    pushAdminNotif('error', `Send voice failed [${req.body?.phone || '?'}]: ${err.message}`, req.tenantId, req.tenantName);
    res.status(500).json({ error: err.message || 'Failed to send voice message' });
  }
});

// ── Send Image ──────────────────────────────
app.post('/api/send-image', tenantAuth, sendLimiter, upload.single('image'), async (req, res) => {
  try {
    const phone = req.body.phone;
    const caption = req.body.caption || '';
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });

    if (waManager.getStatus(req.tenantId) === 'banned') {
      const cfg = waManager.getConfig(req.tenantId);
      return res.status(403).json({ error: '\ud83d\udeab WhatsApp number is banned/restricted. ' + (cfg?.banned_reason || 'Contact admin.'), banned: true });
    }
    if (!waManager.isReady(req.tenantId)) {
      return res.status(503).json({ error: 'WhatsApp Cloud API not configured. Contact admin.' });
    }

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Validate image type
    const mimeType = req.file.mimetype || 'image/jpeg';
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(mimeType.split(';')[0].trim())) {
      return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are supported' });
    }

    // Validate file size (WhatsApp limit: 5MB for images)
    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large. Max 5MB.' });
    }

    // 🛡️ SpamGuard: check BEFORE sending to WhatsApp
    const imgContent = caption ? `📷 ${caption}` : '📷 Image';
    const spam = spamCheck(req.tenantId, cleanedPhone, imgContent);
    if (!spam.allowed) {
      return res.status(429).json({ error: spam.reason, spam_frozen: true });
    }

    // Upload image to WhatsApp Media API
    const mediaId = await waManager.uploadImageMedia(req.tenantId, req.file.buffer, mimeType);

    // Send image message
    await waManager.sendImageById(req.tenantId, cleanedPhone, mediaId, caption);

    const now = new Date().toISOString();
    const msgText = caption ? `📷 ${caption}` : '📷 Image';

    await Promise.all([
      supabase.from('conversations').insert({
        tenant_id: req.tenantId, phone: cleanedPhone,
        message: msgText,
        direction: 'outgoing', status: 'sent',
        media_url: 'wamid:' + mediaId
      }),
      supabase.from('leads')
        .update({ last_message_at: now })
        .eq('tenant_id', req.tenantId).eq('phone', cleanedPhone)
    ]);

    res.json({ success: true, phone: cleanedPhone, timestamp: now, media_url: 'wamid:' + mediaId, spam_frozen: false });
  } catch (err) {
    console.error('Send image error:', err.message);
    pushAdminNotif('error', `Send image failed [${req.body?.phone || '?'}]: ${err.message}`, req.tenantId, req.tenantName);
    res.status(500).json({ error: err.message || 'Failed to send image' });
  }
});

// ── Media Proxy (stream WhatsApp media with auth) ────
// Handles both audio and image media
app.get('/api/media-proxy/:conversationId', tenantAuth, async (req, res) => {
  try {
    const convId = parseInt(req.params.conversationId);
    if (!convId) return res.status(400).json({ error: 'Invalid conversation ID' });

    // Check in-memory cache first (populated by cacheIncomingMedia on webhook)
    const cached = getCachedMediaBinary(convId);
    if (cached) {
      let ct = cached.contentType;
      // WhatsApp CDN sometimes caches with generic content-type for voice messages
      if (!ct.startsWith('audio/')) {
        const { data: c } = await supabase.from('conversations')
          .select('message').eq('id', convId).eq('tenant_id', req.tenantId).maybeSingle();
        if (c?.message && (c.message.includes('\ud83c\udfa4') || c.message === '[Audio]')) {
          ct = 'audio/ogg; codecs=opus';
        }
      }
      res.set('Content-Type', ct);
      res.set('Content-Length', cached.buffer.length);
      res.set('Cache-Control', 'private, max-age=3600');
      if (ct.startsWith('audio/')) res.set('Accept-Ranges', 'bytes');
      return res.send(cached.buffer);
    }

    const { data: conv } = await supabase.from('conversations')
      .select('media_url, message')
      .eq('id', convId).eq('tenant_id', req.tenantId).maybeSingle();

    if (!conv || !conv.media_url) {
      return res.status(404).json({ error: 'Media not found' });
    }

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

    // Download the media binary from WhatsApp CDN
    const mediaRes = await fetch(mediaUrl, {
      headers: { 'Authorization': `Bearer ${cfg.access_token}` }
    });

    if (!mediaRes.ok) {
      return res.status(502).json({ error: 'Failed to download media' });
    }

    let contentType = mediaRes.headers.get('content-type') || 'application/octet-stream';
    const arrayBuf = await mediaRes.arrayBuffer();
    const mediaBuf = Buffer.from(arrayBuf);

    // WhatsApp CDN sometimes returns application/octet-stream for voice messages.
    // Force correct audio MIME so browsers can decode the blob.
    const isVoiceMsg = conv.message && (conv.message.includes('🎤') || conv.message === '[Audio]');
    if (isVoiceMsg && !contentType.startsWith('audio/')) {
      contentType = 'audio/ogg; codecs=opus';
    }

    res.set('Content-Type', contentType);
    res.set('Content-Length', mediaBuf.length);
    res.set('Cache-Control', 'private, max-age=3600');
    if (contentType.startsWith('audio/')) {
      res.set('Accept-Ranges', 'bytes');
    }
    res.send(mediaBuf);
  } catch (err) {
    console.error('Media proxy error:', err.message);
    pushAdminNotif('error', `Media proxy error [conv #${req.params.conversationId}]: ${err.message}`, req.tenantId, req.tenantName);
    res.status(500).json({ error: 'Failed to proxy media' });
  }
});

// ── Legacy audio-proxy route (backwards compatibility) ─
app.get('/api/audio-proxy/:conversationId', tenantAuth, (req, res) => {
  // Redirect to unified media proxy
  const url = `/api/media-proxy/${req.params.conversationId}`;
  res.redirect(307, url);
});

// ── Messages ────────────────────────────────
app.get('/api/messages/:phone', tenantAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const cacheKey = `msgs_${req.tenantId}_${phone}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) { res.set('Cache-Control', 'private, max-age=5'); return res.json(cached); }
    const { data, error } = await supabase.from('conversations')
      .select('id, phone, message, direction, status, created_at, media_url')
      .eq('tenant_id', req.tenantId).eq('phone', phone)
      .order('created_at', { ascending: true }).limit(200);
    if (error) throw error;
    const result = data || [];
    setCachedResponse(cacheKey, result, 10000); // 10s cache — SSE handles live updates
    res.set('Cache-Control', 'private, max-age=5');
    res.json(result);
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
    const cacheKey = `leads_${req.tenantId}_${status || 'all'}_${source || 'all'}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) { res.set('Cache-Control', 'private, max-age=10'); return res.json(cached); }
    let query = supabase.from('leads').select('*')
      .eq('tenant_id', req.tenantId)
      .order('last_message_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    const { data, error } = await query;
    if (error) throw error;
    const result = data || [];
    setCachedResponse(cacheKey, result, 15000); // 15s cache
    res.json(result);
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
    pushAdminNotif('error', `Lead update failed [${req.params.phone}]: ${err.message || err}`, req.tenantId, req.tenantName);
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
const RESP_CACHE_TTL = 45000; // 45s for stats
const RESP_CACHE_TTL_LONG = 90000; // 90s for analytics

// Separate stale-fallback store: keeps last-known-good data for up to 5 min.
// Used to serve marketers cached results when Supabase is briefly unavailable.
const staleCache = new Map(); // key -> { data, ts }
const STALE_CACHE_TTL = 300000; // 5 minutes

function getCachedResponse(key) {
  const cached = responseCache.get(key);
  if (cached && (Date.now() - cached.ts) < cached.ttl) return cached.data;
  return null;
}

function setStaleCachedResponse(key, data) {
  staleCache.set(key, { data, ts: Date.now() });
}

function getStaleCachedResponse(key) {
  const entry = staleCache.get(key);
  if (entry && (Date.now() - entry.ts) < STALE_CACHE_TTL) return entry.data;
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
    if (cached) { res.set('Cache-Control', 'private, max-age=30'); return res.json(cached); }

    // Use count queries instead of pulling all rows — saves massive bandwidth
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const [
      totalLeads, newLeads, soldLeads, interestedLeads, contactedLeads, lostLeads,
      revenueData, msgsToday, incomingToday, outgoingToday
    ] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'new'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'sold'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'interested'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'contacted'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'lost'),
      supabase.from('leads').select('revenue').eq('tenant_id', tid).gt('revenue', 0).limit(500), // capped — avoids unbounded row fetch
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).gte('created_at', since24h),
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('direction', 'incoming').gte('created_at', since24h),
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('direction', 'outgoing').gte('created_at', since24h),
    ]);

    const result = {
      total_leads: totalLeads.count || 0,
      new_leads: newLeads.count || 0,
      sold_leads: soldLeads.count || 0,
      interested_leads: interestedLeads.count || 0,
      contacted_leads: contactedLeads.count || 0,
      lost_leads: lostLeads.count || 0,
      total_revenue: (revenueData.data || []).reduce((sum, l) => sum + (parseFloat(l.revenue) || 0), 0),
      messages_today: msgsToday.count || 0,
      incoming_today: incomingToday.count || 0,
      outgoing_today: outgoingToday.count || 0
    };
    setCachedResponse(cacheKey, result, 120000); // 2 min — reduce DB load under heavy concurrency
    res.set('Cache-Control', 'private, max-age=30');
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
    const cached = getQuickReplyCached(req.tenantId);
    if (cached) return res.json(cached);
    const { data, error } = await supabase.from('quick_replies')
      .select('*').eq('tenant_id', req.tenantId).order('id');
    if (error) throw error;
    const seen = new Set();
    const unique = (data || []).filter(r => {
      if (seen.has(r.title)) return false;
      seen.add(r.title); return true;
    });
    setQuickReplyCache(req.tenantId, unique);
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
    invalidateQuickReplyCache(req.tenantId);
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
    invalidateQuickReplyCache(req.tenantId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quick reply' });
  }
});

app.delete('/api/quick-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('quick_replies').delete().eq('id', id).eq('tenant_id', req.tenantId);
    invalidateQuickReplyCache(req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quick reply' });
  }
});

// ── Auto-Replies CRUD ───────────────────────
app.get('/api/auto-replies', tenantAuth, async (req, res) => {
  try {
    const cacheKey = `auto_replies_${req.tenantId}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);
    const { data, error } = await supabase.from('auto_replies')
      .select('*').eq('tenant_id', req.tenantId).order('priority', { ascending: false });
    if (error) throw error;
    const result = data || [];
    setCachedResponse(cacheKey, result, 60000); // 60s cache
    res.json(result);
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
    invalidateAutoReplyCache(req.tenantId);
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
    invalidateAutoReplyCache(req.tenantId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update auto-reply' });
  }
});

app.delete('/api/auto-replies/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await supabase.from('auto_replies').delete().eq('id', id).eq('tenant_id', req.tenantId);
    invalidateAutoReplyCache(req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete auto-reply' });
  }
});

// ── Broadcasts ──────────────────────────────
app.get('/api/broadcasts', tenantAuth, async (req, res) => {
  try {
    const cacheKey = `broadcasts_${req.tenantId}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);
    const { data, error } = await supabase.from('broadcasts')
      .select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
    if (error) throw error;
    const result = data || [];
    setCachedResponse(cacheKey, result, 30000); // 30s cache
    res.json(result);
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
    if (waManager.getStatus(req.tenantId) === 'banned') {
      const cfg = waManager.getConfig(req.tenantId);
      return res.status(403).json({ error: '\ud83d\udeab WhatsApp number is banned/restricted. ' + (cfg?.banned_reason || 'Contact admin.'), banned: true });
    }
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
    const { data: recipients, error: recipErr } = await supabase.from('broadcast_recipients')
      .select('*').eq('broadcast_id', broadcastId).eq('status', 'pending');
    if (recipErr) {
      console.error('❌ Broadcast recipients fetch error:', recipErr.message);
      await supabase.from('broadcasts').update({ status: 'cancelled' }).eq('id', broadcastId);
      return;
    }

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
        // Check if tenant got banned mid-broadcast — abort remaining
        if (waManager.getStatus(tenantId) === 'banned') {
          const remainingIds = recipients.slice(i).map(r => r.id);
          if (remainingIds.length > 0) {
            await supabase.from('broadcast_recipients')
              .update({ status: 'failed', error_message: 'WhatsApp number banned/restricted' })
              .in('id', remainingIds);
            failedCount += remainingIds.length;
          }
          await supabase.from('broadcasts').update({
            status: 'cancelled', sent_count: sentCount, failed_count: failedCount,
            completed_at: new Date().toISOString()
          }).eq('id', broadcastId);
          console.log(`\ud83d\udeab Broadcast ${broadcastId} aborted — tenant ${tenantId} banned. Sent: ${sentCount}, Failed: ${failedCount}`);
          pushAdminNotif('error', `Broadcast ${broadcastId} aborted: WhatsApp number banned`, tenantId);
          return;
        }
        if (!waManager.isReady(tenantId)) {
          await supabase.from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'WhatsApp not configured' }).eq('id', recipient.id);
          failedCount++; continue;
        }

        const cleanedPhone = recipient.phone.replace(/\D/g, '');

        // 🛡️ SpamGuard: record each broadcast send in the spam tracker
        const spam = spamCheck(tenantId, cleanedPhone, message);
        if (!spam.allowed) {
          // Spam limit hit mid-broadcast — pause remaining recipients
          const remainingIds = recipients.slice(i).map(r => r.id);
          if (remainingIds.length > 0) {
            await supabase.from('broadcast_recipients')
              .update({ status: 'failed', error_message: 'SpamGuard: sending paused — anti-spam limit reached' })
              .in('id', remainingIds);
            failedCount += remainingIds.length;
          }
          await supabase.from('broadcasts').update({
            status: 'cancelled', sent_count: sentCount, failed_count: failedCount,
            completed_at: new Date().toISOString()
          }).eq('id', broadcastId);
          console.log(`🛡️ [SpamGuard] Broadcast ${broadcastId} paused at ${sentCount} sends — anti-spam limit`);
          return;
        }

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
    pushAdminNotif('error', `Broadcast #${broadcastId} failed: ${err.message}`, tenantId, null);
    await supabase.from('broadcasts').update({ status: 'cancelled' }).eq('id', broadcastId);
  }
}

app.delete('/api/broadcasts/:id', tenantAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Parallel delete — no dependency between recipients and broadcast row
    await Promise.all([
      supabase.from('broadcast_recipients').delete().eq('broadcast_id', id),
      supabase.from('broadcasts').delete().eq('id', id).eq('tenant_id', req.tenantId)
    ]);
    responseCache.delete(`broadcasts_${req.tenantId}`); // bust list cache
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// ── Scheduled Messages ──────────────────────
app.get('/api/scheduled', tenantAuth, async (req, res) => {
  try {
    const cacheKey = `scheduled_${req.tenantId}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);
    const { data, error } = await supabase.from('scheduled_messages')
      .select('*').eq('tenant_id', req.tenantId).order('scheduled_at', { ascending: true });
    if (error) throw error;
    const result = data || [];
    setCachedResponse(cacheKey, result, 30000); // 30s cache
    res.json(result);
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
    responseCache.delete(`scheduled_${req.tenantId}`); // bust list cache
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
    responseCache.delete(`scheduled_${req.tenantId}`); // bust list cache
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

    // Build deduplicated candidate list from input (in-memory, zero DB cost)
    const phonesSeen = new Set();
    const candidates = [];
    for (const c of contacts.slice(0, 500)) {
      const phone = String(c.phone || '').replace(/\D/g, '');
      if (!phone || phone.length < 7 || phonesSeen.has(phone)) continue;
      phonesSeen.add(phone);
      candidates.push({
        phone,
        real_phone: String(c.phone || '').trim(),
        name: String(c.name || 'Unknown').substring(0, 100)
      });
    }

    let imported = 0;
    let skipped = contacts.length - candidates.length; // invalid / duplicate entries

    if (candidates.length > 0) {
      // ONE query to find all already-existing phones (replaces N individual checks)
      const { data: existing } = await supabase.from('leads')
        .select('phone').eq('tenant_id', req.tenantId)
        .in('phone', candidates.map(c => c.phone));
      const existingSet = new Set((existing || []).map(e => e.phone));

      const toInsert = candidates
        .filter(c => !existingSet.has(c.phone))
        .map(c => ({
          tenant_id: req.tenantId, phone: c.phone, real_phone: c.real_phone,
          name: c.name, source: 'import', status: 'new', tags: []
        }));
      skipped += candidates.length - toInsert.length;

      // Batch insert in chunks of 100 (Supabase row limit per request)
      for (let i = 0; i < toInsert.length; i += 100) {
        const chunk = toInsert.slice(i, i + 100);
        const { error } = await supabase.from('leads').insert(chunk);
        if (!error) imported += chunk.length;
        else skipped += chunk.length;
      }
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

// ══════════════════════════════════════════════
// REALTIME — Supabase subscription → SSE push
// ══════════════════════════════════════════════

// Map of tenantId -> Set of SSE response objects (one per open browser tab)
const sseClients = new Map(); // tenantId -> Set<res>

function addSseClient(tenantId, res) {
  if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
  sseClients.get(tenantId).add(res);
}

function removeSseClient(tenantId, res) {
  const s = sseClients.get(tenantId);
  if (s) { s.delete(res); if (s.size === 0) sseClients.delete(tenantId); }
}

function broadcastToTenant(tenantId, event, data) {
  const clients = sseClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { removeSseClient(tenantId, res); }
  }
}

// ── Admin SSE (real-time push to all open admin tabs) ────────────────────────
const adminSseClients = new Set(); // Set<res>

function broadcastToAdmin(event, data) {
  if (adminSseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...adminSseClients]) {
    try { res.write(payload); } catch (_) { adminSseClients.delete(res); }
  }
}

// Single global Supabase realtime channel for all tenants
let realtimeChannel = null;

function startRealtimeSubscription() {
  if (realtimeChannel) return; // already running

  realtimeChannel = supabase
    .channel('crm-conversations')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'conversations' },
      (payload) => {
        const row = payload.new;
        if (!row || !row.tenant_id) return;
        const tenantId = row.tenant_id;

        // Only push if someone is connected for this tenant
        if (!sseClients.has(tenantId)) return;

        console.log(`⚡ Realtime: new message for tenant ${tenantId} from ${row.phone}`);

        // Push two events:
        // 1. 'new_message'  → frontend reloads the chat window if it matches
        // 2. 'chat_updated' → frontend refreshes the chat list
        broadcastToTenant(tenantId, 'new_message', {
          phone: row.phone,
          direction: row.direction,
          message: row.message,
          media_url: row.media_url || null,
          created_at: row.created_at,
          id: row.id
        });
        broadcastToTenant(tenantId, 'chat_updated', { phone: row.phone });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Supabase Realtime subscription active');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`⚠️  Supabase Realtime: ${status} — will retry`);
        realtimeChannel = null;
        // Retry after 10 seconds
        setTimeout(startRealtimeSubscription, 10000);
      }
    });
}

// ── SSE Endpoint ─────────────────────────────
app.get('/api/events', tenantAuth, (req, res) => {
  const tenantId = req.tenantId;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // disable nginx buffering
  });
  res.flushHeaders();

  // Send a heartbeat immediately so browser knows the connection is alive
  res.write('event: connected\ndata: {}\n\n');

  addSseClient(tenantId, res);

  // Send heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(tenantId, res);
  });

  // Ensure Realtime subscription is running
  startRealtimeSubscription();
});

// ── Admin SSE Endpoint (real-time push to admin dashboard) ──
app.get('/api/admin/events', adminAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  adminSseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    adminSseClients.delete(res);
  });
});

// ── Proactive Ban Checker ────────────────────────────────────
// Periodically pings WhatsApp API for ALL configured APIs and marks ban
// immediately — no need to wait for a failed message send.
async function proactiveBanCheck() {
  if (waManager.configs.size === 0) return;
  for (const [tenantId, cfg] of waManager.configs) {
    if (cfg.banned) continue; // already known
    if (!cfg.phone_number_id || !cfg.access_token) continue;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phone_number_id}?fields=id,status,quality_rating`,
        { headers: { 'Authorization': `Bearer ${cfg.access_token}` }, signal: controller.signal }
      );
      clearTimeout(tid);
      const data = await resp.json();
      if (!resp.ok) {
        const errCode = data.error?.code;
        // 131031 = account locked, 368 = policy block, 190 = invalid/expired token
        if (errCode === 131031 || errCode === 368) {
          waManager.markBanned(tenantId, `Auto-detected (code ${errCode}): ${data.error?.message || 'Account blocked'}`);
        } else if (errCode === 190) {
          // Access token invalid/expired — push admin notice only, don't mark banned
          pushAdminNotif('warn', `API ${tenantId}: Access token expired or invalid (code 190). Please reconfigure.`, tenantId, null);
          broadcastToAdmin('api_token_expired', { tenant_id: Number(tenantId) });
        }
      } else {
        // Check if phone number status is explicitly BANNED, RESTRICTED etc.
        const phStatus = (data.status || '').toUpperCase();
        if (phStatus === 'BANNED' || phStatus === 'BLOCKED') {
          waManager.markBanned(tenantId, `Auto-detected: Phone number status is ${phStatus}`);
        } else if (phStatus === 'FLAGGED' || phStatus === 'RESTRICTED') {
          // Not banned yet but at risk — push a warning to admin
          pushAdminNotif('warn', `API ${tenantId}: Phone number status is ${phStatus} — risk of ban`, tenantId, null);
          broadcastToAdmin('api_flagged', { tenant_id: Number(tenantId), status: phStatus });
        }
      }
    } catch (err) {
      if (!isAbortError(err)) {
        console.warn(`⚠️  Proactive ban check failed for tenant ${tenantId}:`, err.message);
      }
    }
  }
}

// ── Manual: Admin triggers check-all-apis ───────────────────
app.post('/api/admin/check-all-apis', adminAuth, async (req, res) => {
  // Run the check immediately in background; respond right away so UI isn't blocked
  proactiveBanCheck().catch(() => {});
  res.json({ ok: true, message: `Checking ${waManager.configs.size} API(s) in background. Results appear instantly via real-time events.` });
});

// ── Active Chats (OPTIMIZED: 3 queries instead of N*2+1) ────
app.get('/api/active-chats', tenantAuth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const since = req.query.since || null; // ISO timestamp for incremental updates

    // Cache full loads (no 'since') for 10s to prevent rapid re-fetches
    if (!since) {
      const cacheKey = `active_chats_${tid}`;
      const cached = getCachedResponse(cacheKey);
      if (cached) { res.set('Cache-Control', 'private, max-age=5'); return res.json(cached); }
    } else {
      // Cache incremental (since) queries per tenant for 8s — prevents 33 marketers hammering DB every 45s
      const incKey = `active_chats_inc_${tid}`;
      const incCached = getCachedResponse(incKey);
      if (incCached) { res.set('Cache-Control', 'private, max-age=5'); return res.json(incCached); }
    }

    // If client sends 'since', return only leads updated after that time
    let leadsQuery = supabase.from('leads')
      .select('id, phone, real_phone, name, email, company, source, status, tags, notes, revenue, assigned_to, created_at, last_message_at')
      .eq('tenant_id', tid);
    if (since) {
      leadsQuery = leadsQuery.gte('last_message_at', since);
    }
    leadsQuery = leadsQuery.order('last_message_at', { ascending: false }).limit(500);

    const { data: leads, error } = await leadsQuery;
    if (error) throw error;
    if (!leads || leads.length === 0) return res.json([]);

    const phones = leads.map(l => l.phone);

    // Batch: get last message for all leads in ONE query — group by phone in JS
    // Use 5× lead count (min 600) so busy chats don't push out quieter ones
    const { data: recentMsgs, error: msgErr } = await supabase.from('conversations')
      .select('phone, message, direction, created_at')
      .eq('tenant_id', tid)
      .in('phone', phones)
      .order('created_at', { ascending: false })
      .limit(Math.max(phones.length * 5, 600));
    if (msgErr) console.error('⚠️  Active chats recentMsgs error:', msgErr.message);

    // Batch: get unread counts — skip on incremental (since) requests to save 1 DB query per poll
    // Limit to 2000 to prevent runaway scans on tenants with large unread backlogs
    let unreadRows = [];
    if (!since) {
      const { data: unreadData, error: unreadErr } = await supabase.from('conversations')
        .select('phone')
        .eq('tenant_id', tid)
        .in('phone', phones)
        .eq('direction', 'incoming')
        .eq('status', 'received')
        .limit(2000);
      if (unreadErr) console.error('⚠️  Active chats unreadRows error:', unreadErr.message);
      unreadRows = unreadData || [];
    }

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

    if (!since) {
      setCachedResponse(`active_chats_${tid}`, chats, 10000);
      // Always update stale fallback so marketers get last-known-good data during outages
      setStaleCachedResponse(`active_chats_stale_${tid}`, chats);
    } else {
      // Cache incremental result so other tabs of same tenant skip the DB for 8s
      setCachedResponse(`active_chats_inc_${tid}`, chats, 8000);
    }
    res.json(chats);
  } catch (err) {
    console.error('Active chats error:', err.message);

    // If DB is temporarily unavailable, serve stale cached data so marketers are unaffected
    const isDbTransient = err.message && (
      err.message.includes('Database unavailable') ||
      err.message.includes('502') || err.message.includes('503') || err.message.includes('504')
    );
    if (isDbTransient) {
      const stale = getStaleCachedResponse(`active_chats_stale_${req.tenantId}`);
      if (stale) {
        console.warn(`⚠️  Serving stale active-chats for tenant ${req.tenantId} (DB transient error)`);
        res.set('X-Stale-Data', 'true');
        return res.json(stale);
      }
    }

    // Only push admin notification if not a repeated transient flutter (throttled to once per 2 min per tenant)
    const notifKey = `active_chats_err_${req.tenantId}`;
    if (!getCachedResponse(notifKey)) {
      pushAdminNotif('error', `Active chats load failed: ${err.message}`, req.tenantId, req.tenantName);
      setCachedResponse(notifKey, true, 120000); // suppress duplicate notifs for 2 min
    }
    res.status(500).json({ error: 'Failed to fetch active chats' });
  }
});

// ══════════════════════════════════════════════
// PAGE ROUTES
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '4h',
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
  const adminDecoded = verifyToken(req, 'crm_admin_token');
  if (adminDecoded && adminDecoded.role === 'admin') return res.redirect('/admin');
  const decoded = verifyTenantToken(req);
  if (decoded && decoded.role === 'tenant') return res.redirect(`/crm/${decoded.tenant_id}`);
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

  try {
    // Use tenantVerifyCache to avoid a DB hit on every page load
    let isActive = isTenantCachedActive(tid);
    if (isActive === null) {
      const { data: tenant, error: tErr } = await supabase.from('tenants')
        .select('id, is_active').eq('id', tid).maybeSingle();
      if (tErr) {
        console.error('⚠️  /crm/:tid DB error:', tErr.message);
        return res.redirect('/login');
      }
      isActive = !!(tenant && tenant.is_active);
      tenantVerifyCache.set(tid, { active: isActive, ts: Date.now() });
    }
    if (!isActive) {
      res.clearCookie(`crm_token_${tid}`);
      return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (err) {
    console.error('⚠️  /crm/:tid error:', err.message);
    return res.redirect('/login');
  }
});

app.get('*', (req, res) => {
  // Don't redirect API calls or static asset requests
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.redirect('/');
});

// ── Startup DB Migrations ─────────────────────
async function runStartupMigrations() {
  // ── 1. Ensure media_url column exists ──────
  try {
    const { error } = await supabase.from('conversations').select('media_url').limit(0);
    if (error) {
      const isMissing = error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('media_url'));
      if (isMissing) {
        console.warn('⚠️  conversations.media_url column missing — auto-migrating...');
        const { error: rpcErr } = await supabase.rpc('exec_sql', {
          sql: 'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS media_url TEXT;'
        });
        if (!rpcErr) {
          console.log('✅ Migration: media_url column added.');
        } else {
          console.error('❌ Auto-migration failed. Run in Supabase SQL Editor:');
          console.error('   ALTER TABLE conversations ADD COLUMN IF NOT EXISTS media_url TEXT;');
        }
      }
    }
  } catch (err) {
    if (!isAbortError(err)) console.warn('⚠️  Could not verify DB schema (media_url):', err.message);
  }

  // ── 2. Enable Realtime on conversations table ──
  try {
    const { error: rtErr } = await supabase.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          -- Add conversations to supabase_realtime publication if not already present
          IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'conversations'
          ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
            RAISE NOTICE 'conversations added to supabase_realtime';
          END IF;
        END$$;
      `
    });
    if (!rtErr) {
      console.log('✅ Realtime publication: conversations table enabled.');
    } else {
      // Non-fatal — realtime just won't push; polling fallback still works
      console.warn('⚠️  Could not auto-enable Realtime publication:', rtErr.message);
      console.warn('   To fix manually: run in Supabase SQL Editor:');
      console.warn('   ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;');
    }
  } catch (err) {
    if (!isAbortError(err)) console.warn('⚠️  Could not verify Realtime publication:', err.message);
  }

  // ── 3. Ensure wa_banned columns exist on tenants ──
  try {
    const { error } = await supabase.from('tenants').select('wa_banned').limit(0);
    if (error) {
      const isMissing = error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('wa_banned'));
      if (isMissing) {
        console.warn('⚠️  tenants.wa_banned columns missing — auto-migrating...');
        const { error: rpcErr } = await supabase.rpc('exec_sql', {
          sql: `
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned BOOLEAN DEFAULT false;
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_reason TEXT;
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_at TIMESTAMPTZ;
          `
        });
        if (!rpcErr) {
          console.log('✅ Migration: wa_banned columns added to tenants.');
        } else {
          console.error('❌ Auto-migration failed for wa_banned. Run in Supabase SQL Editor:');
          console.error('   ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned BOOLEAN DEFAULT false;');
          console.error('   ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_reason TEXT;');
          console.error('   ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_at TIMESTAMPTZ;');
        }
      }
    }
  } catch (err) {
    if (!isAbortError(err)) console.warn('⚠️  Could not verify DB schema (wa_banned):', err.message);
  }
}

// ══════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════
const server = app.listen(PORT, () => {
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

  runStartupMigrations().catch(() => {}).then(() => {
    initAllTenants().then(() => {
      // After all tenant configs are loaded, immediately check all APIs for ban status
      // Then run every 3 minutes in background
      setTimeout(() => proactiveBanCheck().catch(() => {}), 5000);
      setInterval(() => proactiveBanCheck().catch(() => {}), 3 * 60 * 1000);
    });
    // Start Supabase Realtime subscription at boot so incoming messages
    // are tracked even before any CRM tab connects via SSE
    startRealtimeSubscription();
  });
});

// Critical for 100+ concurrent users on Render/nginx:
// Node.js default keep-alive is 5s but Render LB timeout is 75s — mismatch causes
// ECONNRESET errors under load. Set keep-alive > LB timeout so LB always closes first.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ── Process-Level Error Handlers ────────────
process.on('uncaughtException', (err) => {
  console.error('🔥 FATAL: Uncaught Exception:', err);
  // Let the process manager (Render/PM2) restart us
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection:', reason);
  // Don't crash — log and continue for rejected promises
});

// ── Graceful Shutdown ───────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  clearInterval(globalSchedulerInterval);
  server.close(() => {
    waManager.destroyAll();
    process.exit(0);
  });
  // Force-exit if still open after 10s
  setTimeout(() => process.exit(0), 10000).unref();
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down...');
  clearInterval(globalSchedulerInterval);
  server.close(() => {
    waManager.destroyAll();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
});
