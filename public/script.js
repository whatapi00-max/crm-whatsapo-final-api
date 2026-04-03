// ============================================
// Billy777 WhatsApp CRM v3.0 - Frontend Logic
// Multi-Tenant Version
// ============================================

const API_BASE = '';
const REFRESH_INTERVAL = 45000; // 45s — fallback polling when SSE is not connected

// ── Realtime SSE state ─────────────────────
let sseSource = null;
let sseConnected = false;
let sseRetryTimer = null;

// ── Extract Tenant ID from URL (/crm/:tid) ──
const TENANT_ID = (() => {
  const m = window.location.pathname.match(/^\/crm\/(\d+)/);
  return m ? m[1] : null;
})();

// Common headers for all API calls
function tenantHeaders(extra = {}) {
  const h = { ...extra };
  if (TENANT_ID) h['X-Tenant-ID'] = TENANT_ID;
  return h;
}

// ── State ──────────────────────────────────
let activeChats = [];
let currentPhone = null;
let currentFilter = 'all';
let currentPage = 'inbox';
let quickReplies = [];
let autoReplies = [];
let broadcasts = [];
let scheduledMsgs = [];
let refreshTimer = null;
let isInfoPanelOpen = false;
let isSending = false;
let currentSearch = '';
let lastChatHash = ''; // Track if chat list actually changed
let lastMsgCount = 0; // Track if messages changed
let pageDataCache = {}; // Cache page data to avoid re-fetching on tab switch
let lastRefreshTime = null; // For incremental updates
let searchDebounceTimer = null;
let messageCache = new Map(); // phone -> { messages: [], timestamp: number }
const MSG_CACHE_TTL = 30000; // 30s cache per chat

// ── Voice Recording State ──────────────────
let mediaRecorder = null;
let audioChunks = [];
let voiceTimerInterval = null;
let voiceStartTime = 0;
let isRecording = false;

// ── DOM Helpers ────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Auth Check & Initialize ────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Redirect to login if no tenant ID in URL
  if (!TENANT_ID) {
    window.location.href = '/login';
    return;
  }
  // Check auth before anything
  try {
    const res = await fetch('/api/auth/check', { headers: tenantHeaders() });
    const data = await res.json();
    if (!data.authenticated || data.role !== 'tenant') {
      window.location.href = '/login';
      return;
    }
    const nameEl = $('#tenant-name');
    if (nameEl) nameEl.textContent = data.name || data.username || 'Marketer';
  } catch {
    window.location.href = '/login';
    return;
  }

  initTheme();
  initNavigation();
  initEventListeners();
  checkConnection();
  loadActiveChats(true); // Full load on page init
  loadQuickReplies();
  startRealtime();   // Supabase Realtime via SSE (replaces polling when connected)
  startAutoRefresh(); // Fallback polling — slows to 2min when SSE is active
  startSessionCheck();
  startWarningPoll();
});

// ── Session Timeout Monitor ────────────────
function startSessionCheck() {
  // Check session validity every 5 minutes (no need to poll frequently)
  setInterval(async () => {
    if (document.hidden) return; // skip if tab is not visible
    try {
      const res = await fetch('/api/auth/check', { headers: tenantHeaders() });
      if (res.status === 401) {
        window.location.href = '/login';
      }
    } catch {}
  }, 300000);
}

// ── Admin Warning Freeze System ─────────────
let _warnActive = false;

async function checkWarnOnce() {
  try {
    const res = await fetch('/api/warn-check', { headers: tenantHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.warned) triggerAdminFreeze(data.message, data.remaining_seconds || 60);
  } catch {}
}

function startWarningPoll() {
  // Check immediately on load – catches active freeze after page refresh
  checkWarnOnce();
  setInterval(async () => {
    if (_warnActive || document.hidden) return; // skip if frozen or tab hidden
    try {
      const res = await fetch('/api/warn-check', { headers: tenantHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (data.warned) triggerAdminFreeze(data.message, data.remaining_seconds || 60);
    } catch {}
  }, 30000); // poll every 30 seconds
}

function triggerAdminFreeze(message, totalSecs) {
  if (_warnActive) return; // prevent double-trigger
  _warnActive = true;
  const secs = Math.max(1, Math.round(totalSecs || 60));
  const overlay = document.getElementById('admin-warning-overlay');
  const msgEl = document.getElementById('admin-warning-msg');
  const countdown = document.getElementById('warn-countdown');
  const bar = document.getElementById('warn-progress-bar');
  if (!overlay) return;

  msgEl.textContent = message;
  overlay.style.display = 'flex';
  countdown.textContent = String(secs);
  bar.style.transition = 'none';
  bar.style.width = '100%';

  let remaining = secs;
  // Start shrink animation after first paint
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = `width ${remaining}s linear`;
      bar.style.width = '0%';
    });
  });

  const tick = setInterval(() => {
    remaining--;
    countdown.textContent = String(remaining);
    if (remaining <= 0) {
      clearInterval(tick);
      overlay.style.display = 'none';
      _warnActive = false;
    }
  }, 1000);
}

// ── Logout ─────────────────────────────────
async function logoutTenant() {
  try { await fetch(`/api/auth/logout?tid=${TENANT_ID}`, { method: 'POST', headers: tenantHeaders() }); } catch {}
  window.location.href = '/login';
}

// ══════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════
function initNavigation() {
  $$('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });
}

function navigateTo(page) {
  currentPage = page;

  // Update nav active states
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  const navBtn = $(`.nav-item[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Hide all pages, show target
  $$('.page-content').forEach(p => p.classList.remove('active'));
  const pageEl = $(`#page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  // Update page title
  const titles = {
    inbox: 'Team Inbox', contacts: 'Contacts', broadcasts: 'Broadcasts',
    automation: 'Automation', analytics: 'Analytics',
    scheduled: 'Scheduled Messages', 'quick-replies': 'Quick Replies', settings: 'Settings',
    guide: 'Feature Guide'
  };
  $('#page-title').textContent = titles[page] || page;

  // Load page data (with cache check for fast tab switching)
  const cacheAge = pageDataCache[page] ? Date.now() - pageDataCache[page] : Infinity;
  const CACHE_TTL = 30000; // 30s cache for page data

  switch (page) {
    case 'contacts': 
      if (cacheAge > CACHE_TTL) { loadContactsPage(); pageDataCache[page] = Date.now(); }
      break;
    case 'broadcasts':
      if (cacheAge > CACHE_TTL) { loadBroadcasts(); pageDataCache[page] = Date.now(); }
      break;
    case 'automation':
      if (cacheAge > CACHE_TTL) { loadAutoReplies(); pageDataCache[page] = Date.now(); }
      break;
    case 'analytics':
      if (cacheAge > CACHE_TTL) { loadAnalytics(); pageDataCache[page] = Date.now(); }
      break;
    case 'scheduled':
      if (cacheAge > CACHE_TTL) { loadScheduled(); pageDataCache[page] = Date.now(); }
      break;
    case 'quick-replies':
      if (cacheAge > CACHE_TTL) { loadQuickRepliesPage(); pageDataCache[page] = Date.now(); }
      break;
    case 'settings': loadSettings(); break;
  }
}

// ══════════════════════════════════════════════
// THEME
// ══════════════════════════════════════════════
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.documentElement.classList.remove('dark');
  } else {
    document.documentElement.classList.add('dark');
  }
}

function toggleTheme() {
  const html = document.documentElement;
  html.classList.toggle('dark');
  localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
}

// ══════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════
function initEventListeners() {
  // Theme toggle
  $('#theme-toggle').addEventListener('click', toggleTheme);

  // Refresh button — force full reload
  $('#refresh-btn').addEventListener('click', () => {
    lastRefreshTime = null; // Force full reload
    lastChatHash = '';
    lastMsgCount = 0;
    pageDataCache = {}; // Clear page cache
    messageCache.clear(); // Clear message cache
    loadActiveChats(true);
    if (currentPhone) loadChat(currentPhone, true);
    showToast('Data refreshed', 'info');
    navigateTo(currentPage);
  });

  // Search in inbox (debounced)
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentSearch = e.target.value.toLowerCase().trim();
      renderLeadsList();
    }, 200);
  });

  // Global search bar (debounced)
  $('#global-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      const query = e.target.value.toLowerCase().trim();
      if (currentPage === 'inbox') {
        currentSearch = query;
        $('#search-input').value = e.target.value;
        renderLeadsList();
      }
    }, 200);
  });

  // Filter buttons
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderLeadsList();
    });
  });

  // Send button
  $('#send-btn').addEventListener('click', sendMessage);

  // Message input
  const msgInput = $('#message-input');
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    $('#char-count').textContent = `${msgInput.value.length} / 4096`;
    $('#send-btn').disabled = !msgInput.value.trim();
  });
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Quick replies toggle
  $('#toggle-quick-replies').addEventListener('click', () => {
    $('#quick-replies-bar').classList.toggle('hidden');
  });

  // Mouse wheel → horizontal scroll on quick replies bar
  const qrBar = $('#quick-replies-bar');
  if (qrBar) {
    qrBar.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        qrBar.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

  // Back button
  $('#back-to-list').addEventListener('click', () => {
    currentPhone = null;
    $('#active-chat-view').style.display = 'none';
    $('#no-chat-view').style.display = 'flex';
  });

  // Info panel toggle
  $('#toggle-info-panel').addEventListener('click', toggleInfoPanel);

  // Lead status change in chat header
  $('#chat-status-select').addEventListener('change', async (e) => {
    if (!currentPhone) return;
    const newStatus = e.target.value;

    // Update local cache immediately for instant UI
    const lead = activeChats.find(c => c.phone === currentPhone);
    if (lead) lead.status = newStatus;
    lastChatHash = ''; // Force re-render
    renderLeadsList();

    try {
      await apiPut(`/api/leads/${encodeURIComponent(currentPhone)}`, { status: newStatus });
    } catch (err) {
      if (err.message && err.message.includes('401')) return;
      console.error('Status update error:', err);
    }
  });

  // Save lead details
  $('#save-lead-btn').addEventListener('click', saveLeadDetails);

  // Delete lead
  $('#delete-lead-btn').addEventListener('click', deleteLead);

  // Resolve phone number
  $('#resolve-phone-btn').addEventListener('click', resolvePhone);

  // Schedule message button
  $('#schedule-msg-btn').addEventListener('click', openScheduleModal);
  $('#confirm-schedule-btn').addEventListener('click', confirmScheduleMessage);

  // ── Contacts page ──
  $('#import-csv-btn').addEventListener('click', () => $('#import-modal').classList.toggle('hidden'));
  $('#cancel-import-btn').addEventListener('click', () => $('#import-modal').classList.add('hidden'));
  $('#process-csv-btn').addEventListener('click', importCSV);
  $('#export-csv-btn').addEventListener('click', exportCSV);

  // ── Broadcasts page ──
  $('#new-broadcast-btn').addEventListener('click', () => $('#broadcast-form').classList.toggle('hidden'));
  $('#cancel-broadcast-btn').addEventListener('click', () => $('#broadcast-form').classList.add('hidden'));
  $('#create-broadcast-btn').addEventListener('click', createBroadcast);

  // ── Automation page ──
  $('#new-auto-reply-btn').addEventListener('click', () => {
    $('#ar-edit-id').value = '';
    $('#ar-name').value = '';
    $('#ar-trigger-type').value = 'contains';
    $('#ar-trigger-value').value = '';
    $('#ar-reply').value = '';
    $('#ar-priority').value = '0';
    $('#ar-form-title').textContent = 'Create Auto-Reply Rule';
    $('#auto-reply-form').classList.remove('hidden');
  });
  $('#cancel-auto-reply-btn').addEventListener('click', () => $('#auto-reply-form').classList.add('hidden'));
  $('#save-auto-reply-btn').addEventListener('click', saveAutoReply);

  // ── Quick Replies page ──
  $('#new-qr-btn').addEventListener('click', () => {
    $('#qr-edit-id').value = '';
    $('#qr-title').value = '';
    $('#qr-category').value = '';
    $('#qr-shortcut').value = '';
    $('#qr-message').value = '';
    $('#qr-form-title').textContent = 'Create Quick Reply';
    $('#qr-form').classList.remove('hidden');
  });
  $('#cancel-qr-btn').addEventListener('click', () => $('#qr-form').classList.add('hidden'));
  $('#save-qr-btn').addEventListener('click', saveQuickReply);

  // ── Settings ──
  const showQrBtn = $('#show-qr-btn');
  if (showQrBtn) showQrBtn.addEventListener('click', () => {
    $('#settings-qr').classList.toggle('hidden');
  });

  // ── Voice Recording ──
  const voiceBtn = $('#voice-btn');
  if (voiceBtn) voiceBtn.addEventListener('click', startVoiceRecording);
  const voiceCancelBtn = $('#voice-cancel-btn');
  if (voiceCancelBtn) voiceCancelBtn.addEventListener('click', cancelVoiceRecording);
  const voiceSendBtn = $('#voice-send-btn');
  if (voiceSendBtn) voiceSendBtn.addEventListener('click', sendVoiceRecording);

  // ── Image Sending ──
  const imageBtn = $('#image-btn');
  const imageFileInput = $('#image-file-input');
  if (imageBtn && imageFileInput) {
    imageBtn.addEventListener('click', () => {
      if (!currentPhone) { showToast('Select a chat first', 'error'); return; }
      imageFileInput.value = '';
      imageFileInput.click();
    });
    imageFileInput.addEventListener('change', handleImageSelected);
  }
  const imageCancelBtn = $('#image-cancel-btn');
  if (imageCancelBtn) imageCancelBtn.addEventListener('click', cancelImageSend);
  const imageSendBtn = $('#image-send-btn');
  if (imageSendBtn) imageSendBtn.addEventListener('click', sendImage);
  const imageCaptionInput = $('#image-caption-input');
  if (imageCaptionInput) imageCaptionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendImage(); }
  });
}

// ══════════════════════════════════════════════
// API CALLS
// ══════════════════════════════════════════════
function handleAuthError(status) {
  if (status === 401 || status === 403) {
    window.location.href = '/login';
    return true;
  }
  return false;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, { headers: tenantHeaders() });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: tenantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: tenantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API_BASE + path, { method: 'DELETE', headers: tenantHeaders() });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ══════════════════════════════════════════════
// CONNECTION STATUS
// ══════════════════════════════════════════════
async function checkConnection() {
  try {
    const data = await apiGet('/api/connection-status');
    const dot = $('#connection-dot');
    const text = $('#connection-text');
    const sDot = $('#settings-conn-dot');
    const sText = $('#settings-conn-text');
    const statusSel = $('#conn-status-select');
    const banAlert = $('#ban-alert');
    const banReason = $('#ban-reason');

    if (data.status === 'banned') {
      dot.className = 'w-3 h-3 rounded-full bg-orange-500 block';
      dot.style.animation = 'pulse-green 2s infinite';
      text.textContent = 'Banned';
      text.className = 'text-[11px] text-orange-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-orange-500'; }
      if (sText) { sText.textContent = 'Number Banned / Restricted'; sText.className = 'text-sm text-orange-500 font-semibold'; }
      if (statusSel) statusSel.value = 'banned';
      if (banAlert) {
        banAlert.classList.remove('hidden');
        if (banReason) banReason.textContent = data.banned_reason || 'Number appears to be banned or restricted';
      }
    } else if (data.ready) {
      dot.className = 'w-3 h-3 rounded-full bg-wa-green block';
      dot.style.animation = 'pulse-green 2s infinite';
      text.textContent = 'Connected';
      text.className = 'text-[11px] text-wa-green opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-wa-green'; }
      if (sText) { sText.textContent = 'Connected via Cloud API'; sText.className = 'text-sm text-wa-green font-semibold'; }
      if (statusSel) statusSel.value = 'connected';
      if (banAlert) banAlert.classList.add('hidden');
    } else {
      dot.className = 'w-3 h-3 rounded-full bg-red-500 block';
      dot.style.animation = '';
      text.textContent = 'Not Configured';
      text.className = 'text-[11px] text-red-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-red-500'; }
      if (sText) { sText.textContent = 'Not Configured'; sText.className = 'text-sm text-red-400'; }
      if (statusSel) statusSel.value = 'connected';
      if (banAlert) banAlert.classList.add('hidden');
    }
  } catch (err) {
    if (err.message && err.message.includes('401')) {
      window.location.href = '/login';
      return;
    }
    $('#connection-dot').className = 'w-3 h-3 rounded-full bg-red-500 animate-pulse block';
    $('#connection-text').textContent = 'Server offline';
  }
}

// ══════════════════════════════════════════════
// ACTIVE CHATS / LEADS LIST (Inbox)
// ══════════════════════════════════════════════
async function loadActiveChats(force) {
  try {
    let url = '/api/active-chats';
    // Incremental updates: only fetch leads changed since last refresh
    if (!force && lastRefreshTime) {
      url += '?since=' + encodeURIComponent(lastRefreshTime);
    }
    const data = await apiGet(url);

    if (!force && lastRefreshTime && data.length > 0) {
      // Merge incremental updates into existing list
      const phoneSet = new Set(data.map(d => d.phone));
      activeChats = activeChats.filter(c => !phoneSet.has(c.phone)).concat(data);
      activeChats.sort((a, b) => {
        const ta = a.last_message_at || a.created_at || '';
        const tb = b.last_message_at || b.created_at || '';
        return tb.localeCompare(ta);
      });
    } else if (force || !lastRefreshTime) {
      activeChats = data;
    }

    lastRefreshTime = new Date().toISOString();
    $('#chat-count').textContent = activeChats.length;

    // Only re-render if data actually changed (compare hash)
    const newHash = activeChats.map(c => c.phone + (c.last_message_at || '') + (c.unread_count || 0) + c.status).join('|');
    if (newHash !== lastChatHash) {
      lastChatHash = newHash;
      renderLeadsList();
    }
  } catch (err) {
    console.error('Load chats error:', err);
  }
}

function renderLeadsList() {
  const container = $('#leads-list');
  let filtered = activeChats;

  if (currentFilter === 'unread') {
    filtered = filtered.filter(c => (c.unread_count || 0) > 0);
  } else if (currentFilter !== 'all') {
    filtered = filtered.filter(c => c.status === currentFilter);
  }

  if (currentSearch) {
    filtered = filtered.filter(c => {
      const name = (c.name || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      const realPhone = (c.real_phone || '').toLowerCase();
      const lastMsg = ((c.last_message && c.last_message.message) || '').toLowerCase();
      return name.includes(currentSearch) || phone.includes(currentSearch) || realPhone.includes(currentSearch) || lastMsg.includes(currentSearch);
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-gray-600">
        <svg class="w-10 h-10 mx-auto mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
        <p class="text-xs">No ${currentFilter === 'all' ? '' : currentFilter + ' '}chats found</p>
      </div>`;
    return;
  }

  // Build a map of phones we need to show
  const filteredPhones = new Set(filtered.map(c => c.phone));
  const existingItems = new Map();
  container.querySelectorAll('.lead-item').forEach(el => {
    existingItems.set(el.dataset.phone, el);
  });

  // Remove items not in filtered list
  for (const [phone, el] of existingItems) {
    if (!filteredPhones.has(phone)) el.remove();
  }

  // Build/update items in order using a document fragment
  const frag = document.createDocumentFragment();
  for (const chat of filtered) {
    const existing = existingItems.get(chat.phone);
    if (existing) {
      // Update in-place: only touch changed parts
      updateLeadItem(existing, chat);
      frag.appendChild(existing);
    } else {
      frag.appendChild(createLeadItem(chat));
    }
  }
  container.innerHTML = '';
  container.appendChild(frag);
}

function createLeadItem(chat) {
  const div = document.createElement('div');
  div.className = 'lead-item' + (chat.phone === currentPhone ? ' active' : '');
  div.dataset.phone = chat.phone;
  div.onclick = () => selectChat(chat.phone);
  fillLeadItem(div, chat);
  return div;
}

function formatPreviewText(msg) {
  if (!msg) return 'No messages yet';
  const prefix = msg.direction === 'outgoing' ? '↗ ' : '';
  const txt = msg.message || '';
  if (txt === '[Image]' || txt.startsWith('📷')) return prefix + '📷 Photo';
  if (txt === '[Video]' || txt.startsWith('🎥')) return prefix + '[Video]';
  if (txt === '[Audio]' || txt.startsWith('🎤')) return prefix + '🎤 Voice message';
  if (txt === '[Document]' || txt.startsWith('📄')) return prefix + '📄 Document';
  if (txt === '[Sticker]') return prefix + '🏷️ Sticker';
  return prefix + truncate(txt, 40);
}

function fillLeadItem(div, chat) {
  const initials = getInitials(chat.name || chat.phone);
  const avatarColor = getAvatarColor(chat.phone);
  const lastMsg = chat.last_message;
  const lastMsgText = formatPreviewText(lastMsg);
  const timeStr = lastMsg ? formatTime(lastMsg.created_at) : '';
  const displayPhone = chat.real_phone ? '+' + chat.real_phone : '+' + chat.phone;

  div.innerHTML = `
    <div class="lead-avatar" style="background: ${avatarColor}">${escapeHtml(initials)}</div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center justify-between">
        <span class="font-medium text-sm truncate" data-field="name">${escapeHtml(chat.name || displayPhone)}</span>
        <span class="text-[0.65rem] text-gray-500 ml-2 flex-shrink-0" data-field="time">${escapeHtml(timeStr)}</span>
      </div>
      <div class="flex items-center justify-between mt-0.5">
        <p class="text-xs text-gray-500 truncate" data-field="preview">${escapeHtml(displayPhone)} · ${escapeHtml(lastMsgText)}</p>
        <div class="flex items-center gap-1 ml-2 flex-shrink-0" data-field="badges">
          ${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ''}
          <span class="status-badge status-${escapeAttr(chat.status)}">${escapeHtml(chat.status)}</span>
        </div>
      </div>
    </div>`;
}

function updateLeadItem(div, chat) {
  div.classList.toggle('active', chat.phone === currentPhone);
  const lastMsg = chat.last_message;
  const lastMsgText = formatPreviewText(lastMsg);
  const timeStr = lastMsg ? formatTime(lastMsg.created_at) : '';
  const displayPhone = chat.real_phone ? '+' + chat.real_phone : '+' + chat.phone;

  const nameEl = div.querySelector('[data-field="name"]');
  const timeEl = div.querySelector('[data-field="time"]');
  const previewEl = div.querySelector('[data-field="preview"]');
  const badgesEl = div.querySelector('[data-field="badges"]');

  if (nameEl) nameEl.textContent = chat.name || displayPhone;
  if (timeEl) timeEl.textContent = timeStr;
  if (previewEl) previewEl.textContent = displayPhone + ' · ' + lastMsgText;
  if (badgesEl) {
    badgesEl.innerHTML = `${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ''}<span class="status-badge status-${escapeAttr(chat.status)}">${escapeHtml(chat.status)}</span>`;
  }
}

// ══════════════════════════════════════════════
// CHAT VIEW
// ══════════════════════════════════════════════
async function selectChat(phone) {
  currentPhone = phone;
  $('#no-chat-view').style.display = 'none';
  $('#active-chat-view').style.display = 'flex';

  const lead = activeChats.find(c => c.phone === phone);
  if (lead) {
    const initials = getInitials(lead.name || lead.phone);
    $('#chat-avatar').textContent = initials;
    $('#chat-avatar').style.background = getAvatarColor(phone);
    const displayReal = lead.real_phone || lead.phone;
    $('#chat-name').textContent = lead.name || ('+' + displayReal);
    $('#chat-phone').textContent = '+' + displayReal;
    if (displayReal !== phone) {
      $('#chat-phone').textContent += ' (WA ID: ' + phone + ')';
    }
    $('#chat-status-select').value = lead.status || 'new';

    // Info panel
    $('#info-avatar').textContent = initials;
    $('#info-avatar').style.background = getAvatarColor(phone);
    $('#info-name').value = lead.name || '';
    $('#info-phone').textContent = 'WA ID: ' + phone;
    const phoneVal = lead.real_phone || lead.phone || '';
    $('#info-real-phone').value = phoneVal ? (phoneVal.startsWith('+') ? phoneVal : '+' + phoneVal) : '';
    if (!lead.real_phone) setTimeout(() => resolvePhone(), 1000);
    $('#info-email').value = lead.email || '';
    $('#info-company').value = lead.company || '';
    $('#info-source').value = lead.source || 'organic';
    $('#info-notes').value = lead.notes || '';
    $('#info-tags').value = (lead.tags || []).join(', ');

    $('#info-created').textContent = formatDate(lead.created_at);
    $('#info-last-active').textContent = formatTime(lead.last_message_at);
  }

  // Update active state without rebuilding entire list
  $$('.lead-item').forEach(el => {
    el.classList.toggle('active', el.dataset.phone === phone);
  });

  // Immediately clear unread badge from local data and UI
  const chatData = activeChats.find(c => c.phone === phone);
  if (chatData && chatData.unread_count > 0) {
    chatData.unread_count = 0;
    const chatEl = document.querySelector(`.lead-item[data-phone="${phone}"]`);
    if (chatEl) {
      const badgesEl = chatEl.querySelector('[data-field="badges"]');
      if (badgesEl) {
        const unreadBadge = badgesEl.querySelector('.unread-badge');
        if (unreadBadge) unreadBadge.remove();
      }
    }
  }

  // Show cached messages instantly if available
  const cached = messageCache.get(phone);
  if (cached) {
    lastMsgCount = cached.messages.length;
    renderMessages(cached.messages);
  } else {
    lastMsgCount = 0;
    const chatMsgs = $('#chat-messages');
    chatMsgs.innerHTML = '<div class="text-center text-gray-500 py-8"><p class="text-sm">Loading messages...</p></div>';
  }

  // Load fresh chat and mark as read in parallel
  await Promise.all([
    loadChat(phone, !cached), // force render if no cache
    apiPost(`/api/messages/${encodeURIComponent(phone)}/read`, {}).catch(() => {})
  ]);

  $('#message-input').focus();
}

async function loadChat(phone, forceRender) {
  try {
    const messages = await apiGet(`/api/messages/${encodeURIComponent(phone)}`);
    // Update cache
    messageCache.set(phone, { messages, timestamp: Date.now() });
    // Render if message count changed or forced
    if (forceRender || messages.length !== lastMsgCount) {
      lastMsgCount = messages.length;
      if (currentPhone === phone) renderMessages(messages);
    }
  } catch (err) {
    console.error('Load chat error:', err);
    if (!messageCache.has(phone)) {
      $('#chat-messages').innerHTML = `
        <div class="text-center py-8">
          <p class="text-sm text-red-400">Failed to load messages</p>
          <button onclick="loadChat('${escapeAttr(phone)}', true)" class="mt-3 px-4 py-1.5 text-xs bg-white/10 rounded-lg hover:bg-white/20 transition-colors">Retry</button>
        </div>`;
    }
  }
}

function renderMessages(messages) {
  const container = $('#chat-messages');

  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="text-center text-gray-500 py-8"><p class="text-sm">No messages yet</p><p class="text-xs mt-1">Send a message to start the conversation</p></div>`;
    return;
  }

  let lastDate = '';
  container.innerHTML = messages.map(msg => {
    const msgDate = new Date(msg.created_at).toLocaleDateString();
    let dateSeparator = '';
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      dateSeparator = `<div class="text-center my-3"><span class="text-[0.65rem] px-3 py-1 rounded-full bg-gray-200/80 dark:bg-white/5 text-gray-500">${escapeHtml(formatDateLabel(msg.created_at))}</span></div>`;
    }

    const isOutgoing = msg.direction === 'outgoing';
    const bubbleClass = isOutgoing ? 'msg-outgoing' : 'msg-incoming';
    const alignClass = isOutgoing ? 'flex justify-end' : 'flex justify-start';

    // Check if this is a voice message
    const isVoice = msg.message && (msg.message.includes('🎤') || msg.message === '[Audio]');
    // Check if this is an image message (with or without media)
    const isImageMsg = msg.message && (msg.message.includes('📷') || msg.message === '[Image]');
    const hasImageMedia = isImageMsg && msg.media_url;
    let contentHtml;
    if (hasImageMedia) {
      const mediaSrc = API_BASE + '/api/media-proxy/' + msg.id;
      const captionText = msg.message.replace(/^📷\s*/, '').replace(/^\[Image\]$/, '').trim();
      contentHtml = `<div class="img-msg-bubble">
        <div class="img-load-wrap">
          <img class="msg-image-thumb" data-src="${escapeAttr(mediaSrc)}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Image" onclick="openImageFullscreen(this)" style="cursor:zoom-in">
          <div class="img-loading-spinner"><svg class="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity=".25"/><path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></div>
        </div>
        ${captionText && captionText !== 'Image' ? `<div class="text-xs mt-1 opacity-80 whitespace-pre-wrap">${escapeHtml(captionText)}</div>` : ''}
      </div>`;
    } else if (isImageMsg) {
      const captionText = msg.message.replace(/^📷\s*/, '').replace(/^\[Image\]$/, '').trim();
      contentHtml = `<div class="media-placeholder-bubble">
        <div class="media-placeholder">
          <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          <span>Photo</span>
        </div>
        ${captionText && captionText !== 'Image' ? `<div class="text-xs mt-1 opacity-80 whitespace-pre-wrap">${escapeHtml(captionText)}</div>` : ''}
      </div>`;
    } else if (isVoice) {
      // Always render a play button for voice messages.
      // If media_url is null (old message or capture issue) the audio proxy
      // will return 404 and the existing error-toast handler will inform the user.
      const audioSrc = API_BASE + '/api/audio-proxy/' + msg.id;
      const hasAudio = !!msg.media_url;
      contentHtml = `<div class="voice-msg-player${hasAudio ? '' : ' voice-no-audio'}" data-audio-src="${escapeAttr(audioSrc)}">
        <div class="flex items-center gap-3 min-w-[200px]">
          <button class="voice-play-btn w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition-colors flex-shrink-0${hasAudio ? '' : ' opacity-50'}" onclick="toggleVoicePlay(this)" title="${hasAudio ? 'Play voice message' : 'Voice message (audio may not be available)'}">
            <svg class="w-5 h-5 play-icon" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="flex-1 min-w-0">
            <div class="voice-progress-wrap h-1.5 rounded-full bg-white/15 overflow-hidden cursor-pointer" onclick="seekVoice(event, this)">
              <div class="voice-progress h-full rounded-full transition-all" style="width:0%; background: currentColor; opacity: 0.7"></div>
            </div>
          </div>
          <span class="text-[10px] opacity-60 voice-duration flex-shrink-0">0:00</span>
        </div>
        <audio preload="none" data-src="${escapeAttr(audioSrc)}"></audio>
      </div>`;
    } else {
      contentHtml = `<div class="whitespace-pre-wrap">${escapeHtml(msg.message)}</div>`;
    }

    return `
      ${dateSeparator}
      <div class="${alignClass}">
        <div class="msg-bubble ${bubbleClass}">
          ${contentHtml}
          <div class="msg-time ${isOutgoing ? 'text-right' : ''}">${formatTime(msg.created_at)}${isOutgoing ? ' ✓✓' : ''}</div>
        </div>
      </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;

  // Lazy-load any image thumbnails in the chat
  lazyLoadChatImages();
}

// ══════════════════════════════════════════════
// SEND MESSAGE
// ══════════════════════════════════════════════
async function sendMessage() {
  if (isSending) return;
  const input = $('#message-input');
  const message = input.value.trim();
  if (!message || !currentPhone) return;

  isSending = true;
  const sendBtn = $('#send-btn');
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';

  // Clear input immediately for responsiveness
  input.value = '';
  input.style.height = 'auto';
  $('#char-count').textContent = '0 / 4096';

  // Optimistic UI: Add message bubble immediately without waiting for server
  const container = $('#chat-messages');
  const noMsgEl = container.querySelector('.text-center');
  if (noMsgEl) container.innerHTML = '';
  const now = new Date();
  const tempBubble = document.createElement('div');
  tempBubble.className = 'flex justify-end';
  tempBubble.innerHTML = `<div class="msg-bubble msg-outgoing"><div class="whitespace-pre-wrap">${escapeHtml(message)}</div><div class="msg-time text-right">${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} ⏳</div></div>`;
  container.appendChild(tempBubble);
  container.scrollTop = container.scrollHeight;

  try {
    await apiPost('/api/send-reply', { phone: currentPhone, message });
    // Update the pending indicator to sent
    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '✓✓');
    lastMsgCount++; // Track the new message
    // Update message cache with the new message
    const cached = messageCache.get(currentPhone);
    if (cached) {
      cached.messages.push({ message, direction: 'outgoing', status: 'sent', created_at: now.toISOString() });
      cached.timestamp = Date.now();
    }
    showToast('Message sent!', 'success');
    // Refresh chat list in background (don't await)
    loadActiveChats(true);
  } catch (err) {
    // Mark as failed
    tempBubble.querySelector('.msg-bubble').style.borderColor = 'rgba(239,68,68,0.4)';
    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '❌');
    showToast(err.message || 'Failed to send', 'error');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg><span class="hidden sm:inline">Send</span>';
  }
}

// ══════════════════════════════════════════════
// VOICE PLAYBACK (for received/sent voice messages)
// ══════════════════════════════════════════════
let currentlyPlayingAudio = null;

async function toggleVoicePlay(btn) {
  const player = btn.closest('.voice-msg-player');
  const audio = player.querySelector('audio');
  if (!audio) return;
  const playIcon = player.querySelector('.play-icon');
  const durationEl = player.querySelector('.voice-duration');
  const progressEl = player.querySelector('.voice-progress');

  // If already loading, ignore clicks
  if (btn.dataset.loading === 'true') return;

  // Lazy-load: fetch audio via authenticated request, create blob URL
  if (!audio.src || audio.src === window.location.href) {
    const audioUrl = audio.dataset.src || player.dataset.audioSrc;
    if (!audioUrl) {
      showToast('No audio source available', 'error');
      return;
    }
    btn.dataset.loading = 'true';
    durationEl.textContent = 'Loading...';
    btn.classList.add('loading');
    try {
      const res = await fetch(audioUrl, { headers: tenantHeaders() });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error || `HTTP ${res.status}`;
        throw new Error(res.status === 404 ? 'Audio not available for this message' : errMsg);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      audio.src = blobUrl;
      // Wait for audio to be ready
      await new Promise((resolve, reject) => {
        audio.onloadedmetadata = resolve;
        audio.onerror = () => reject(new Error('Audio format not supported'));
        audio.load();
      });
      if (audio.duration && isFinite(audio.duration)) {
        const m = Math.floor(audio.duration / 60);
        const s = Math.floor(audio.duration % 60);
        durationEl.textContent = m + ':' + String(s).padStart(2, '0');
      }
    } catch (err) {
      console.error('Audio load error:', err);
      durationEl.textContent = 'Error';
      btn.classList.remove('loading');
      btn.dataset.loading = 'false';
      showToast('Failed to load audio: ' + err.message, 'error');
      return;
    }
    btn.classList.remove('loading');
    btn.dataset.loading = 'false';
  }

  if (audio.paused || audio.ended) {
    // Stop any other playing audio
    if (currentlyPlayingAudio && currentlyPlayingAudio !== audio) {
      currentlyPlayingAudio.pause();
      currentlyPlayingAudio.currentTime = 0;
      const otherPlayer = currentlyPlayingAudio.closest('.voice-msg-player');
      if (otherPlayer) {
        const otherBtn = otherPlayer.querySelector('.voice-play-btn');
        if (otherBtn) otherBtn.classList.remove('playing');
        otherPlayer.querySelector('.play-icon').innerHTML = '<path d="M8 5v14l11-7z"/>';
        const otherProgress = otherPlayer.querySelector('.voice-progress');
        if (otherProgress) otherProgress.style.width = '0%';
      }
    }

    currentlyPlayingAudio = audio;
    btn.classList.add('playing');
    playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

    audio.ontimeupdate = () => {
      if (audio.duration && isFinite(audio.duration)) {
        const pct = (audio.currentTime / audio.duration) * 100;
        if (progressEl) progressEl.style.width = pct + '%';
        const remaining = audio.duration - audio.currentTime;
        const m = Math.floor(remaining / 60);
        const s = Math.floor(remaining % 60);
        durationEl.textContent = m + ':' + String(s).padStart(2, '0');
      }
    };

    audio.onended = () => {
      btn.classList.remove('playing');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      if (progressEl) progressEl.style.width = '0%';
      currentlyPlayingAudio = null;
      if (audio.duration && isFinite(audio.duration)) {
        const m = Math.floor(audio.duration / 60);
        const s = Math.floor(audio.duration % 60);
        durationEl.textContent = m + ':' + String(s).padStart(2, '0');
      }
    };

    audio.onerror = () => {
      btn.classList.remove('playing');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      durationEl.textContent = 'Error';
      currentlyPlayingAudio = null;
      showToast('Failed to play audio', 'error');
    };

    audio.play().catch(err => {
      console.error('Audio play error:', err);
      btn.classList.remove('playing');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      durationEl.textContent = 'Error';
      currentlyPlayingAudio = null;
      showToast('Failed to play audio', 'error');
    });
  } else {
    audio.pause();
    btn.classList.remove('playing');
    playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  }
}

function seekVoice(event, progressWrap) {
  const player = progressWrap.closest('.voice-msg-player');
  const audio = player.querySelector('audio');
  if (!audio.duration || !isFinite(audio.duration)) return;
  const rect = progressWrap.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// ══════════════════════════════════════════════
// IMAGE DISPLAY (lazy load + fullscreen)
// ══════════════════════════════════════════════
function lazyLoadChatImages() {
  const images = document.querySelectorAll('.msg-image-thumb[data-src]');
  images.forEach(img => {
    // Skip if already loaded or already being observed
    if (img.dataset.loaded || img.dataset.observing) return;
    const src = img.dataset.src;
    if (!src) return;
    img.dataset.observing = '1';
    // Use IntersectionObserver for lazy loading
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            loadChatImage(img, src);
            obs.unobserve(img);
          }
        });
      }, { rootMargin: '200px' });
      obs.observe(img);
      // Fallback: if observer hasn't triggered within 1.5s, load eagerly
      setTimeout(() => {
        if (!img.dataset.loaded) {
          obs.unobserve(img);
          loadChatImage(img, src);
        }
      }, 1500);
    } else {
      loadChatImage(img, src);
    }
  });
}

async function loadChatImage(img, src, retryCount) {
  if (img.dataset.loaded === '1') return; // Already loaded
  retryCount = retryCount || 0;
  try {
    img.style.minHeight = '80px';
    img.style.background = 'rgba(128,128,128,0.15)';
    const res = await fetch(src, { headers: tenantHeaders() });
    if (!res.ok) throw new Error('Failed to load');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      img.style.minHeight = '';
      img.style.background = '';
      img.dataset.loaded = '1';
      // Hide spinner
      const spinner = img.parentElement?.querySelector('.img-loading-spinner');
      if (spinner) spinner.style.display = 'none';
    };
    img.src = url;
  } catch (err) {
    // Retry up to 2 times with brief delay
    if (retryCount < 2) {
      setTimeout(() => loadChatImage(img, src, retryCount + 1), 2000);
      return;
    }
    img.style.minHeight = '60px';
    img.style.background = 'rgba(128,128,128,0.1)';
    img.alt = 'Image unavailable';
    img.title = 'Could not load image — click to retry';
    img.dataset.loaded = 'err';
    // Hide spinner, show error
    const spinner = img.parentElement?.querySelector('.img-loading-spinner');
    if (spinner) spinner.innerHTML = '<svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z"/></svg>';
    // Click to retry
    img.style.cursor = 'pointer';
    const retryHandler = () => {
      img.removeEventListener('click', retryHandler);
      img.dataset.loaded = '';
      img.style.cursor = 'zoom-in';
      if (spinner) { spinner.innerHTML = '<svg class="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity=".25"/><path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>'; spinner.style.display = ''; }
      loadChatImage(img, img.dataset.src, 0);
    };
    img.addEventListener('click', retryHandler);
  }
}

function openImageFullscreen(img) {
  const imgSrc = img.src || '';
  // Block if image is still a placeholder or errored
  if (!imgSrc || imgSrc.startsWith('data:image/gif') || !img.dataset.loaded) {
    if (img.dataset.loaded === 'err') {
      showToast('Image could not be loaded — click thumbnail to retry', 'error');
    } else {
      showToast('Image is still loading…', 'info');
    }
    return;
  }
  if (img.dataset.loaded === 'err') {
    showToast('Image could not be loaded', 'error');
    return;
  }

  // Zoom / pan state
  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0;
  let lastPinchDist = 0;

  const overlay = document.createElement('div');
  overlay.className = 'image-fullscreen-overlay';
  overlay.innerHTML = `
    <div class="image-fullscreen-wrap">
      <img src="${escapeAttr(imgSrc)}" class="image-fullscreen-img" alt="Image" draggable="false">
      <button class="image-fullscreen-close" title="Close (Esc)">&times;</button>
      <div class="image-zoom-controls">
        <button class="image-zoom-btn" data-action="zoomout" title="Zoom out">−</button>
        <span class="image-zoom-level">100%</span>
        <button class="image-zoom-btn" data-action="zoomin" title="Zoom in">+</button>
      </div>
    </div>`;

  const fImg = overlay.querySelector('.image-fullscreen-img');
  const wrap = overlay.querySelector('.image-fullscreen-wrap');
  const zoomLabel = overlay.querySelector('.image-zoom-level');

  function setTransform() {
    fImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
    overlay.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default';
    fImg.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
  }

  function zoom(newScale, cx, cy) {
    const prev = scale;
    scale = Math.max(0.5, Math.min(8, newScale));
    if (cx !== undefined && cy !== undefined) {
      const r = fImg.getBoundingClientRect();
      const mx = r.left + r.width / 2, my = r.top + r.height / 2;
      tx += (cx - mx) * (1 - scale / prev);
      ty += (cy - my) * (1 - scale / prev);
    }
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; }
    setTransform();
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  // Keyboard
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoom(scale * 1.25);
    else if (e.key === '-') zoom(scale * 0.8);
    else if (e.key === '0') { scale = 1; tx = 0; ty = 0; setTransform(); }
  };
  document.addEventListener('keydown', onKey);

  // Mouse drag
  const onMouseMove = (e) => {
    if (!dragging) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    setTransform();
  };
  const onMouseUp = () => { dragging = false; setTransform(); };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Close
  overlay.querySelector('.image-fullscreen-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target === wrap) close();
  });

  // Mouse wheel zoom
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(scale * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX, e.clientY);
  }, { passive: false });

  // Double-click toggle zoom
  fImg.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (scale > 1.05) { scale = 1; tx = 0; ty = 0; setTransform(); }
    else zoom(2.5, e.clientX, e.clientY);
  });

  // Mouse drag pan
  fImg.addEventListener('mousedown', (e) => {
    if (scale <= 1) return;
    dragging = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    e.preventDefault();
  });

  // Touch: pinch zoom + drag pan
  fImg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    } else if (e.touches.length === 1 && scale > 1) {
      dragging = true;
      startX = e.touches[0].clientX - tx;
      startY = e.touches[0].clientY - ty;
    }
  }, { passive: true });
  fImg.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      zoom(scale * (d / lastPinchDist), cx, cy);
      lastPinchDist = d;
    } else if (dragging && e.touches.length === 1) {
      e.preventDefault();
      tx = e.touches[0].clientX - startX;
      ty = e.touches[0].clientY - startY;
      setTransform();
    }
  }, { passive: false });
  fImg.addEventListener('touchend', () => { dragging = false; lastPinchDist = 0; });

  // Zoom control buttons
  overlay.querySelectorAll('.image-zoom-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.action === 'zoomin') zoom(scale * 1.4);
      else if (btn.dataset.action === 'zoomout') zoom(scale * 0.7);
    });
  });

  document.body.appendChild(overlay);
  setTransform();
}

// ══════════════════════════════════════════════
// VOICE RECORDING
// ══════════════════════════════════════════════
async function startVoiceRecording() {
  if (!currentPhone) {
    showToast('Select a chat first', 'error');
    return;
  }
  if (isRecording) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    isRecording = true;

    // Use audio/webm for better browser support, server accepts any audio
    const mimeType = MediaRecorder.isTypeSupported('audio/ogg; codecs=opus')
      ? 'audio/ogg; codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm; codecs=opus')
        ? 'audio/webm; codecs=opus'
        : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(250); // Collect data every 250ms

    // Show recording UI
    $('#voice-recording-bar').classList.remove('hidden');
    $('#voice-btn').classList.add('text-red-500');
    voiceStartTime = Date.now();
    voiceTimerInterval = setInterval(updateVoiceTimer, 100);

  } catch (err) {
    console.error('Mic access error:', err);
    showToast('Microphone access denied. Please allow microphone access.', 'error');
  }
}

function updateVoiceTimer() {
  const elapsed = Math.floor((Date.now() - voiceStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timerEl = $('#voice-timer');
  if (timerEl) timerEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  // Simple level animation
  const levelEl = $('#voice-level');
  if (levelEl) {
    const width = 20 + Math.random() * 60;
    levelEl.style.width = width + '%';
  }

  // Auto-stop after 2 minutes
  if (elapsed >= 120) {
    sendVoiceRecording();
  }
}

function cancelVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  cleanupVoiceRecording();
  showToast('Recording cancelled', 'info');
}

function cleanupVoiceRecording() {
  isRecording = false;
  audioChunks = [];
  mediaRecorder = null;
  if (voiceTimerInterval) {
    clearInterval(voiceTimerInterval);
    voiceTimerInterval = null;
  }
  $('#voice-recording-bar').classList.add('hidden');
  $('#voice-btn').classList.remove('text-red-500');
  const timerEl = $('#voice-timer');
  if (timerEl) timerEl.textContent = '0:00';
  const levelEl = $('#voice-level');
  if (levelEl) levelEl.style.width = '0%';
}

async function sendVoiceRecording() {
  if (!mediaRecorder || !currentPhone) return;
  if (isSending) return;

  // Stop recording and wait for final data
  if (mediaRecorder.state !== 'inactive') {
    await new Promise(resolve => {
      mediaRecorder.onstop = () => {
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
        resolve();
      };
      mediaRecorder.stop();
    });
  }

  if (audioChunks.length === 0) {
    cleanupVoiceRecording();
    showToast('No audio recorded', 'error');
    return;
  }

  isSending = true;
  const sendBtn = $('#voice-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Build audio blob
  const mimeType = audioChunks[0]?.type || 'audio/ogg';
  const audioBlob = new Blob(audioChunks, { type: mimeType });

  cleanupVoiceRecording();

  // Optimistic UI: Add voice bubble immediately
  const container = $('#chat-messages');
  const noMsgEl = container.querySelector('.text-center');
  if (noMsgEl) container.innerHTML = '';
  const now = new Date();
  const tempBubble = document.createElement('div');
  tempBubble.className = 'flex justify-end';
  tempBubble.innerHTML = `<div class="msg-bubble msg-outgoing"><div class="flex items-center gap-2"><svg class="w-4 h-4 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z"/></svg><span class="opacity-60">🎤 Voice message</span></div><div class="msg-time text-right">${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} ⏳</div></div>`;
  container.appendChild(tempBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const formData = new FormData();
    formData.append('phone', currentPhone);
    formData.append('audio', audioBlob, 'voice.ogg');

    const res = await fetch(API_BASE + '/api/send-voice', {
      method: 'POST',
      headers: tenantHeaders(), // Don't set Content-Type, let browser set multipart boundary
      body: formData
    });

    if (handleAuthError(res.status)) throw new Error('401');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `API error: ${res.status}`);
    }

    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '✓✓');
    showToast('Voice message sent!', 'success');
    // Reload messages from DB so play button appears with real media_url
    await loadChat(currentPhone, true);
    loadActiveChats(true);
  } catch (err) {
    tempBubble.querySelector('.msg-bubble').style.borderColor = 'rgba(239,68,68,0.4)';
    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '❌');
    showToast(err.message || 'Failed to send voice message', 'error');
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════
// IMAGE SENDING
// ══════════════════════════════════════════════
let pendingImageFile = null;

function handleImageSelected() {
  const fileInput = $('#image-file-input');
  const file = fileInput.files?.[0];
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    showToast('Only JPEG, PNG, and WebP images are supported', 'error');
    fileInput.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Image too large. Max 5MB.', 'error');
    fileInput.value = '';
    return;
  }

  pendingImageFile = file;

  // Show preview
  const previewBar = $('#image-preview-bar');
  const thumb = $('#image-preview-thumb');
  const nameEl = $('#image-preview-name');
  const sizeEl = $('#image-preview-size');
  const captionInput = $('#image-caption-input');

  const reader = new FileReader();
  reader.onload = (e) => { thumb.src = e.target.result; };
  reader.readAsDataURL(file);

  nameEl.textContent = file.name;
  const sizeKB = Math.round(file.size / 1024);
  sizeEl.textContent = sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + ' MB' : sizeKB + ' KB';
  captionInput.value = '';
  previewBar.classList.remove('hidden');
}

function cancelImageSend() {
  pendingImageFile = null;
  const previewBar = $('#image-preview-bar');
  if (previewBar) previewBar.classList.add('hidden');
  const fileInput = $('#image-file-input');
  if (fileInput) fileInput.value = '';
  const thumb = $('#image-preview-thumb');
  if (thumb) thumb.src = '';
}

async function sendImage() {
  if (!pendingImageFile || !currentPhone || isSending) return;

  isSending = true;
  const sendBtn = $('#image-send-btn');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></span>'; }

  const caption = ($('#image-caption-input')?.value || '').trim();
  const msgText = caption ? `📷 ${caption}` : '📷 Image';

  // Optimistic UI
  const container = $('#chat-messages');
  const noMsgEl = container.querySelector('.text-center');
  if (noMsgEl) container.innerHTML = '';
  const now = new Date();
  const tempBubble = document.createElement('div');
  tempBubble.className = 'flex justify-end';

  // Show thumbnail in bubble
  const thumbUrl = URL.createObjectURL(pendingImageFile);
  tempBubble.innerHTML = `<div class="msg-bubble msg-outgoing"><div class="img-msg-bubble"><img src="${thumbUrl}" class="msg-image-thumb" alt="Image"><div class="text-xs mt-1 opacity-80">${caption ? escapeHtml(caption) : ''}</div></div><div class="msg-time text-right">${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} ⏳</div></div>`;
  container.appendChild(tempBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const formData = new FormData();
    formData.append('phone', currentPhone);
    formData.append('image', pendingImageFile);
    if (caption) formData.append('caption', caption);

    const res = await fetch(API_BASE + '/api/send-image', {
      method: 'POST',
      headers: tenantHeaders(),
      body: formData
    });

    if (handleAuthError(res.status)) throw new Error('401');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `API error: ${res.status}`);
    }

    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '✓✓');
    showToast('Image sent!', 'success');
    await loadChat(currentPhone, true);
    loadActiveChats(true);
  } catch (err) {
    tempBubble.querySelector('.msg-bubble').style.borderColor = 'rgba(239,68,68,0.4)';
    const timeEl = tempBubble.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = timeEl.textContent.replace('⏳', '❌');
    showToast(err.message || 'Failed to send image', 'error');
  } finally {
    isSending = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Send'; }
    URL.revokeObjectURL(thumbUrl);
    cancelImageSend();
  }
}

// ══════════════════════════════════════════════
// QUICK REPLIES (Inbox bar)
// ══════════════════════════════════════════════
async function loadQuickReplies() {
  try {
    quickReplies = await apiGet('/api/quick-replies');
    renderQuickRepliesBar();
  } catch (err) {
    console.error('Quick replies error:', err);
  }
}

function renderQuickRepliesBar() {
  const container = $('#quick-replies-container');
  if (!container) return;
  container.innerHTML = quickReplies.map(qr =>
    `<button class="quick-reply-btn" onclick="useQuickReply('${escapeAttr(qr.id)}')" title="${escapeAttr(qr.message)}">⚡ ${escapeHtml(qr.title)}</button>`
  ).join('');
}

function useQuickReply(id) {
  const qr = quickReplies.find(q => String(q.id) === String(id));
  if (qr) {
    $('#message-input').value = qr.message;
    $('#message-input').dispatchEvent(new Event('input'));
    $('#quick-replies-bar').classList.add('hidden');
  }
}

// ══════════════════════════════════════════════
// LEAD MANAGEMENT
// ══════════════════════════════════════════════
async function updateLead(phone, data) {
  try {
    await apiPut(`/api/leads/${encodeURIComponent(phone)}`, data);
    // Update local cache
    const lead = activeChats.find(c => c.phone === phone);
    if (lead) Object.assign(lead, data);
    showToast('Lead updated', 'success');
  } catch (err) {
    if (err.message && err.message.includes('401')) return;
    showToast('Update failed', 'error');
  }
}

function toggleInfoPanel() {
  isInfoPanelOpen = !isInfoPanelOpen;
  $('#info-panel').classList.toggle('hidden', !isInfoPanelOpen);
}

async function saveLeadDetails() {
  if (!currentPhone) return;
  const tagsStr = $('#info-tags').value;
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

  const updates = {
    name: $('#info-name').value,
    real_phone: $('#info-real-phone').value.trim(),
    email: $('#info-email').value.trim(),
    company: $('#info-company').value.trim(),
    source: $('#info-source').value,
    notes: $('#info-notes').value,
    tags
  };

  await updateLead(currentPhone, updates);
  // Re-render chat header name if it changed
  const lead = activeChats.find(c => c.phone === currentPhone);
  if (lead && lead.name) {
    $('#chat-name').textContent = lead.name;
  }
  lastChatHash = '';
  renderLeadsList();
}

async function resolvePhone() {
  if (!currentPhone) return;
  const btn = $('#resolve-phone-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await apiPost(`/api/leads/${encodeURIComponent(currentPhone)}/resolve`, {});
    if (result.success && result.real_phone) {
      const rp = result.real_phone.startsWith('+') ? result.real_phone : '+' + result.real_phone;
      $('#info-real-phone').value = rp;
      $('#chat-phone').textContent = rp;
      showToast(`Phone: ${rp}`, 'success');
      loadActiveChats();
    } else {
      showToast(result.message || 'Could not detect phone', 'info');
    }
  } catch {
    showToast('Detection failed', 'error');
  }
  btn.disabled = false;
  btn.textContent = 'Detect';
}

async function deleteLead() {
  if (!currentPhone) return;
  if (!confirm(`Delete lead +${currentPhone} and all messages?`)) return;
  try {
    await apiDelete(`/api/leads/${encodeURIComponent(currentPhone)}`);
    currentPhone = null;
    $('#active-chat-view').style.display = 'none';
    $('#no-chat-view').style.display = 'flex';
    $('#info-panel').classList.add('hidden');
    isInfoPanelOpen = false;
    loadActiveChats();
    showToast('Lead deleted', 'success');
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ══════════════════════════════════════════════
// CONTACTS PAGE
// ══════════════════════════════════════════════
async function loadContactsPage() {
  try {
    // Always use cached activeChats — no extra API call
    if (!activeChats.length) await loadActiveChats(true);
    const chats = activeChats;
    const stats = { total: 0, new: 0, contacted: 0, interested: 0 };

    chats.forEach(c => {
      stats.total++;
      if (c.status === 'new') stats.new++;
      if (c.status === 'contacted') stats.contacted++;
      if (c.status === 'interested') stats.interested++;
    });

    $('#c-total').textContent = stats.total;
    $('#c-new').textContent = stats.new;
    $('#c-contacted').textContent = stats.contacted;
    $('#c-interested').textContent = stats.interested;

    const tbody = $('#contacts-table-body');
    if (chats.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-12 text-center text-gray-600 text-sm">No contacts yet</td></tr>';
      return;
    }

    tbody.innerHTML = chats.map(c => `
      <tr onclick="navigateTo('inbox');setTimeout(()=>selectChat('${escapeAttr(c.phone)}'),100)">
        <td class="px-4 py-3">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style="background:${getAvatarColor(c.phone)}">${escapeHtml(getInitials(c.name || c.phone))}</div>
            <span class="font-medium text-sm">${escapeHtml(c.name || 'Unknown')}</span>
          </div>
        </td>
        <td class="px-4 py-3 text-xs text-gray-400">${escapeHtml(c.real_phone ? '+' + c.real_phone : '+' + c.phone)}</td>
        <td class="px-4 py-3"><span class="status-badge status-${escapeAttr(c.status)}">${escapeHtml(c.status)}</span></td>
        <td class="px-4 py-3 text-xs text-gray-500">${escapeHtml(c.source || 'organic')}</td>
        <td class="px-4 py-3 text-xs text-gray-500">${(c.tags || []).map(t => `<span class="inline-block px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 mr-1">${escapeHtml(t)}</span>`).join('')}</td>
        <td class="px-4 py-3 text-xs text-gray-500">${formatTime(c.last_message_at)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Contacts page error:', err);
  }
}

async function importCSV() {
  const csvText = $('#csv-input').value.trim();
  if (!csvText) return showToast('Paste CSV data first', 'error');

  const contacts = csvText.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(',').map(p => p.trim());
      return { name: parts[0] || '', phone: parts[1] || '' };
    })
    .filter(c => c.phone);

  if (contacts.length === 0) return showToast('No valid rows found', 'error');

  try {
    const result = await apiPost('/api/leads/import', { contacts });
    showToast(`Imported ${result.imported || 0} contacts`, 'success');
    $('#csv-input').value = '';
    $('#import-modal').classList.add('hidden');
    loadActiveChats();
    loadContactsPage();
  } catch (err) {
    showToast(err.message || 'Import failed', 'error');
  }
}

async function exportCSV() {
  try {
    const leads = await apiGet('/api/leads/export');
    const rows = [['Name', 'Phone'], ...leads.map(l => [
      (l.name || '').replace(/,/g, ' '),
      (l.real_phone || l.phone || '')
    ])];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts_export.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Export downloaded', 'success');
  } catch {
    showToast('Export failed', 'error');
  }
}

// ══════════════════════════════════════════════
// BROADCASTS PAGE
// ══════════════════════════════════════════════
async function loadBroadcasts() {
  try {
    broadcasts = await apiGet('/api/broadcasts');
    renderBroadcasts();
  } catch (err) {
    console.error('Broadcasts error:', err);
  }
}

function renderBroadcasts() {
  const container = $('#broadcasts-list');
  if (broadcasts.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-600 py-12"><p class="text-sm">No broadcasts yet</p><p class="text-xs mt-1 text-gray-700">Create your first campaign above</p></div>';
    return;
  }

  container.innerHTML = broadcasts.map(bc => `
    <div class="broadcast-card">
      <div class="flex items-center justify-between mb-2">
        <h4 class="font-semibold text-sm">${escapeHtml(bc.name)}</h4>
        <span class="broadcast-status ${escapeAttr(bc.status)}">${escapeHtml(bc.status)}</span>
      </div>
      <p class="text-xs text-gray-500 mb-3 line-clamp-2">${escapeHtml(truncate(bc.message, 100))}</p>
      <div class="flex items-center justify-between">
        <div class="flex gap-4 text-[11px] text-gray-500">
          <span>Recipients: <strong class="text-gray-800 dark:text-gray-300">${bc.total_recipients || 0}</strong></span>
          <span>Sent: <strong class="text-wa-green">${bc.sent_count || 0}</strong></span>
          <span>Failed: <strong class="text-red-400">${bc.failed_count || 0}</strong></span>
        </div>
        <div class="flex gap-2">
          ${bc.status === 'draft' ? `<button class="btn-primary text-xs py-1.5 px-3" onclick="sendBroadcast('${bc.id}')">Send Now</button>` : ''}
          ${bc.status === 'sending' ? `<button class="text-xs px-3 py-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 border border-amber-500/20 font-medium" onclick="cancelBroadcast('${bc.id}')">Cancel</button>` : ''}
          <button class="text-xs px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10 border border-red-500/15" onclick="deleteBroadcast('${bc.id}')">Delete</button>
        </div>
      </div>
      <div class="text-[10px] text-gray-600 mt-2">${formatDate(bc.created_at)}</div>
    </div>
  `).join('');
}

async function createBroadcast() {
  const name = $('#bc-name').value.trim();
  const message = $('#bc-message').value.trim();
  const filterStatus = $('#bc-filter-status').value;
  if (!name || !message) return showToast('Name and message required', 'error');

  try {
    await apiPost('/api/broadcasts', { name, message, filter_status: filterStatus || null });
    showToast('Broadcast created!', 'success');
    $('#broadcast-form').classList.add('hidden');
    $('#bc-name').value = '';
    $('#bc-message').value = '';
    loadBroadcasts();
  } catch (err) {
    showToast(err.message || 'Failed to create broadcast', 'error');
  }
}

async function sendBroadcast(id) {
  if (!confirm('Send this broadcast to all recipients now?')) return;
  try {
    const result = await apiPost(`/api/broadcasts/${id}/send`, {});
    showToast('Broadcast sending started in background!', 'success');
    // Poll broadcast status periodically
    const pollInterval = setInterval(async () => {
      try {
        const updated = await apiGet('/api/broadcasts');
        broadcasts = updated;
        renderBroadcasts();
        const bc = updated.find(b => String(b.id) === String(id));
        if (bc && (bc.status === 'completed' || bc.status === 'failed' || bc.status === 'cancelled')) {
          clearInterval(pollInterval);
          const bcType = bc.status === 'completed' ? 'success' : bc.status === 'cancelled' ? 'info' : 'error';
          showToast(`Broadcast ${bc.status}: ${bc.sent_count || 0} sent, ${bc.failed_count || 0} failed`, bcType);
        }
      } catch { clearInterval(pollInterval); }
    }, 5000);
  } catch (err) {
    showToast(err.message || 'Failed to send', 'error');
  }
}

async function cancelBroadcast(id) {
  if (!confirm('Cancel this broadcast? Messages already sent cannot be undone.')) return;
  try {
    await apiPost(`/api/broadcasts/${id}/cancel`, {});
    showToast('Broadcast cancelling...', 'info');
    loadBroadcasts();
  } catch (err) {
    showToast(err.message || 'Failed to cancel', 'error');
  }
}

async function deleteBroadcast(id) {
  if (!confirm('Delete this broadcast?')) return;
  try {
    await apiDelete(`/api/broadcasts/${id}`);
    showToast('Broadcast deleted', 'success');
    loadBroadcasts();
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ══════════════════════════════════════════════
// AUTOMATION (Auto-Replies) PAGE
// ══════════════════════════════════════════════
async function loadAutoReplies() {
  try {
    autoReplies = await apiGet('/api/auto-replies');
    renderAutoReplies();
  } catch (err) {
    console.error('Auto-replies error:', err);
  }
}

function renderAutoReplies() {
  const container = $('#auto-replies-list');
  if (autoReplies.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-600 py-12"><p class="text-sm">No automation rules yet</p></div>';
    return;
  }

  container.innerHTML = autoReplies.map(ar => `
    <div class="auto-reply-card">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-3">
          <h4 class="font-semibold text-sm">${escapeHtml(ar.name)}</h4>
          <span class="text-[10px] px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan font-medium">${escapeHtml(ar.trigger_type)}</span>
        </div>
        <div class="flex items-center gap-3">
          <button class="toggle-switch ${ar.is_active ? 'on' : ''}" onclick="toggleAutoReply('${ar.id}', ${!ar.is_active})"></button>
          <button class="text-xs text-gray-500 hover:text-gray-300" onclick="editAutoReply('${ar.id}')">Edit</button>
          <button class="text-xs text-red-400 hover:text-red-300" onclick="deleteAutoReply('${ar.id}')">Delete</button>
        </div>
      </div>
      <div class="text-xs text-gray-500">
        <span class="text-gray-400">Trigger:</span> ${escapeHtml(ar.trigger_value)} &nbsp;&bull;&nbsp;
        <span class="text-gray-400">Priority:</span> ${ar.priority || 0}
      </div>
      <p class="text-xs text-gray-600 mt-1 line-clamp-2">${escapeHtml(truncate(ar.reply_message, 120))}</p>
    </div>
  `).join('');
}

function editAutoReply(id) {
  const ar = autoReplies.find(a => String(a.id) === String(id));
  if (!ar) return;
  $('#ar-edit-id').value = ar.id;
  $('#ar-name').value = ar.name;
  $('#ar-trigger-type').value = ar.trigger_type;
  $('#ar-trigger-value').value = ar.trigger_value;
  $('#ar-reply').value = ar.reply_message;
  $('#ar-priority').value = ar.priority || 0;
  $('#ar-form-title').textContent = 'Edit Auto-Reply Rule';
  $('#auto-reply-form').classList.remove('hidden');
}

async function saveAutoReply() {
  const id = $('#ar-edit-id').value;
  const name = $('#ar-name').value.trim();
  const trigger_type = $('#ar-trigger-type').value;
  const trigger_value = $('#ar-trigger-value').value.trim();
  const reply_message = $('#ar-reply').value.trim();
  const priority = parseInt($('#ar-priority').value) || 0;
  if (!name || !reply_message) return showToast('Name and reply required', 'error');

  try {
    if (id) {
      await apiPut(`/api/auto-replies/${id}`, { name, trigger_type, trigger_value, reply_message, priority });
    } else {
      await apiPost('/api/auto-replies', { name, trigger_type, trigger_value, reply_message, priority });
    }
    showToast('Rule saved!', 'success');
    $('#auto-reply-form').classList.add('hidden');
    loadAutoReplies();
  } catch (err) {
    showToast(err.message || 'Save failed', 'error');
  }
}

async function toggleAutoReply(id, active) {
  try {
    await apiPut(`/api/auto-replies/${id}`, { is_active: active });
    showToast(active ? 'Rule enabled' : 'Rule disabled', 'success');
    loadAutoReplies();
  } catch {
    showToast('Toggle failed', 'error');
  }
}

async function deleteAutoReply(id) {
  if (!confirm('Delete this automation rule?')) return;
  try {
    await apiDelete(`/api/auto-replies/${id}`);
    showToast('Rule deleted', 'success');
    loadAutoReplies();
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ══════════════════════════════════════════════
// ANALYTICS PAGE
// ══════════════════════════════════════════════
async function loadAnalytics() {
  try {
    const [stats, trends] = await Promise.all([
      apiGet('/api/stats'),
      apiGet('/api/stats/trends').catch(() => ({ trends: [] }))
    ]);

    // Stat cards
    $('#a-total').textContent = stats.total_leads || 0;
    $('#a-new').textContent = stats.new_leads || 0;
    $('#a-sold').textContent = stats.sold_leads || 0;
    $('#a-msgs').textContent = stats.messages_today || 0;
    $('#a-incoming').textContent = stats.incoming_today || 0;
    $('#a-revenue').textContent = '$' + formatNumber(parseFloat(stats.total_revenue || 0));

    // Pipeline chart
    const pipeline = [
      { label: 'New', count: stats.new_leads || 0, color: '#3b82f6' },
      { label: 'Contacted', count: stats.contacted_leads || 0, color: '#f59e0b' },
      { label: 'Interested', count: stats.interested_leads || 0, color: '#8b5cf6' },
      { label: 'Sold', count: stats.sold_leads || 0, color: '#22c55e' },
      { label: 'Lost', count: stats.lost_leads || 0, color: '#ef4444' },
    ];
    const maxCount = Math.max(...pipeline.map(p => p.count), 1);
    const pipelineEl = $('#pipeline-chart');
    pipelineEl.innerHTML = pipeline.map(p => `
      <div class="pipeline-row">
        <span class="pipeline-label">${p.label}</span>
        <div class="pipeline-bar-bg">
          <div class="pipeline-bar-fill" style="width:${(p.count / maxCount * 100).toFixed(1)}%;background:${p.color}">${p.count > 0 ? p.count : ''}</div>
        </div>
        <span class="pipeline-count" style="color:${p.color}">${p.count}</span>
      </div>
    `).join('');

    // Trends chart
    const trendsData = trends.trends || [];
    const trendsEl = $('#trends-chart');
    if (trendsData.length === 0) {
      trendsEl.innerHTML = '<p class="text-xs text-gray-600 m-auto">No trend data yet</p>';
    } else {
      const maxMsgs = Math.max(...trendsData.map(t => parseInt(t.total) || 0), 1);
      trendsEl.innerHTML = trendsData.map(t => {
        const h = Math.max(((parseInt(t.total) || 0) / maxMsgs) * 100, 4);
        const day = new Date(t.date).toLocaleDateString([], { weekday: 'short' });
        return `
          <div class="flex flex-col items-center flex-1 gap-1">
            <div class="trend-bar w-full bg-gradient-to-t from-wa-green/60 to-wa-green/20" style="height:${h}%">
              <span class="trend-tooltip">${t.total} msgs</span>
            </div>
            <span class="text-[10px] text-gray-600">${day}</span>
          </div>`;
      }).join('');
    }
  } catch (err) {
    console.error('Analytics error:', err);
  }
}

// ══════════════════════════════════════════════
// SCHEDULED MESSAGES PAGE
// ══════════════════════════════════════════════
async function loadScheduled() {
  try {
    scheduledMsgs = await apiGet('/api/scheduled');
    renderScheduled();
  } catch (err) {
    console.error('Scheduled error:', err);
  }
}

function renderScheduled() {
  const container = $('#scheduled-list');
  if (scheduledMsgs.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-600 py-12"><p class="text-sm">No scheduled messages</p></div>';
    return;
  }

  container.innerHTML = scheduledMsgs.map(s => `
    <div class="scheduled-card">
      <div class="flex-1">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-medium text-sm">${escapeHtml(s.phone)}</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full ${s.status === 'pending' ? 'bg-amber-500/15 text-amber-400' : s.status === 'sent' ? 'bg-wa-green/15 text-wa-green' : 'bg-red-500/15 text-red-400'} font-medium">${escapeHtml(s.status)}</span>
        </div>
        <p class="text-xs text-gray-500">${escapeHtml(truncate(s.message, 80))}</p>
        <p class="text-[10px] text-gray-600 mt-1">Scheduled: ${new Date(s.send_at).toLocaleString()}</p>
      </div>
      ${s.status === 'pending' ? `<button class="text-xs text-red-400 hover:text-red-300 flex-shrink-0" onclick="deleteScheduled('${s.id}')">Cancel</button>` : ''}
    </div>
  `).join('');
}

function openScheduleModal() {
  if (!currentPhone) return showToast('Select a chat first', 'error');
  $('#sched-message').value = '';
  $('#sched-datetime').value = '';
  $('#schedule-modal').classList.remove('hidden');
}

function closeScheduleModal() {
  $('#schedule-modal').classList.add('hidden');
}

async function confirmScheduleMessage() {
  const message = $('#sched-message').value.trim();
  const sendAt = $('#sched-datetime').value;
  if (!message || !sendAt) return showToast('Message and time required', 'error');
  if (!currentPhone) return;

  try {
    await apiPost('/api/scheduled', { phone: currentPhone, message, scheduled_at: new Date(sendAt).toISOString() });
    showToast('Message scheduled!', 'success');
    closeScheduleModal();
  } catch (err) {
    showToast(err.message || 'Scheduling failed', 'error');
  }
}

async function deleteScheduled(id) {
  if (!confirm('Cancel this scheduled message?')) return;
  try {
    await apiDelete(`/api/scheduled/${id}`);
    showToast('Scheduled message cancelled', 'success');
    loadScheduled();
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ══════════════════════════════════════════════
// QUICK REPLIES PAGE
// ══════════════════════════════════════════════
async function loadQuickRepliesPage() {
  await loadQuickReplies();
  renderQuickRepliesGrid();
}

function renderQuickRepliesGrid() {
  const container = $('#qr-grid');
  if (quickReplies.length === 0) {
    container.innerHTML = '<div class="col-span-full text-center text-gray-600 py-12"><p class="text-sm">No quick replies yet</p></div>';
    return;
  }

  container.innerHTML = quickReplies.map(qr => `
    <div class="qr-card" onclick="editQR('${qr.id}')">
      <div class="flex items-center justify-between mb-2">
        <h4 class="font-semibold text-sm">${escapeHtml(qr.title)}</h4>
        ${qr.shortcut ? `<span class="text-[10px] px-2 py-0.5 rounded bg-wa-green/10 text-wa-green font-mono">${escapeHtml(qr.shortcut)}</span>` : ''}
      </div>
      <p class="text-xs text-gray-500 line-clamp-3">${escapeHtml(qr.message)}</p>
      <div class="flex items-center justify-between mt-3 pt-2 border-t border-gray-200 dark:border-white/5">
        <span class="text-[10px] text-gray-600">${escapeHtml(qr.category || 'general')}</span>
        <button class="text-xs text-red-400 hover:text-red-300" onclick="event.stopPropagation();deleteQR('${qr.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function editQR(id) {
  const qr = quickReplies.find(q => String(q.id) === String(id));
  if (!qr) return;
  $('#qr-edit-id').value = qr.id;
  $('#qr-title').value = qr.title;
  $('#qr-category').value = qr.category || '';
  $('#qr-shortcut').value = qr.shortcut || '';
  $('#qr-message').value = qr.message;
  $('#qr-form-title').textContent = 'Edit Quick Reply';
  $('#qr-form').classList.remove('hidden');
}

async function saveQuickReply() {
  const id = $('#qr-edit-id').value;
  const title = $('#qr-title').value.trim();
  const message = $('#qr-message').value.trim();
  const category = $('#qr-category').value.trim();
  const shortcut = $('#qr-shortcut').value.trim();
  if (!title || !message) return showToast('Title and message required', 'error');

  try {
    if (id) {
      await apiPut(`/api/quick-replies/${id}`, { title, message, category, shortcut });
    } else {
      await apiPost('/api/quick-replies', { title, message, category, shortcut });
    }
    showToast('Quick reply saved!', 'success');
    $('#qr-form').classList.add('hidden');
    loadQuickRepliesPage();
    loadQuickReplies(); // Refresh inbox bar too
  } catch (err) {
    showToast(err.message || 'Save failed', 'error');
  }
}

async function deleteQR(id) {
  if (!confirm('Delete this quick reply?')) return;
  try {
    await apiDelete(`/api/quick-replies/${id}`);
    showToast('Quick reply deleted', 'success');
    loadQuickRepliesPage();
    loadQuickReplies();
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ══════════════════════════════════════════════
// SETTINGS PAGE
// ══════════════════════════════════════════════
function loadSettings() {
  checkConnection();
  // Connection status dropdown handler
  const sel = $('#conn-status-select');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', async () => {
      try {
        await apiPost('/api/connection-status', { status: sel.value });
        showToast(sel.value === 'banned' ? 'Status set to Banned' : 'Status reset to auto-detect', 'info');
        checkConnection();
      } catch(e) { showToast('Failed to update status', 'error'); }
    });
  }
}

// ══════════════════════════════════════════════
// REALTIME — SSE push from server
// ══════════════════════════════════════════════
function startRealtime() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }

  const url = API_BASE + '/api/events';
  // EventSource doesn't support custom headers, so we rely on the cookie
  // which is sent automatically by the browser (same-origin).
  const es = new EventSource(url);
  sseSource = es;

  es.addEventListener('connected', () => {
    sseConnected = true;
    console.log('⚡ Realtime SSE connected');
  });

  // New message arrived in a conversation
  es.addEventListener('new_message', (e) => {
    try {
      const data = JSON.parse(e.data);
      const phone = data.phone;

      // If this chat is currently open, reload it immediately
      if (currentPhone === phone && currentPage === 'inbox') {
        // Invalidate cache so loadChat fetches fresh data
        messageCache.delete(phone);
        loadChat(phone, true);
      } else {
        // Invalidate cache so next open fetches fresh
        messageCache.delete(phone);
      }
    } catch (_) {}
  });

  // Chat list needs updating (new message from any contact)
  es.addEventListener('chat_updated', () => {
    // Force-reload the sidebar chat list
    lastChatHash = '';
    loadActiveChats(true);
  });

  es.onerror = () => {
    sseConnected = false;
    es.close();
    sseSource = null;
    console.warn('⚡ Realtime SSE disconnected — retrying in 10s');
    sseRetryTimer = setTimeout(startRealtime, 10000);
  };
}

// ══════════════════════════════════════════════
// AUTO-REFRESH (fallback polling — runs slower when SSE is active)
// ══════════════════════════════════════════════
function startAutoRefresh() {
  refreshTimer = setInterval(async () => {
    // Only refresh if tab is visible (don't waste resources on hidden tabs)
    if (document.hidden) return;

    // When SSE is connected, polling is just a safety net — run every 2 min
    if (sseConnected) return;

    // Run connection check and chat list refresh in parallel
    const promises = [checkConnection(), loadActiveChats()];
    // Only refresh current chat if on inbox page AND cache is stale
    if (currentPhone && currentPage === 'inbox') {
      const cached = messageCache.get(currentPhone);
      const isStale = !cached || (Date.now() - cached.timestamp) > MSG_CACHE_TTL;
      if (isStale) {
        promises.push(loadChat(currentPhone));
      }
    }
    await Promise.all(promises);
  }, REFRESH_INTERVAL);
}

// ══════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════════════
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  // Limit to 5 stacked toasts — remove oldest if over
  const existing = container.querySelectorAll('.toast');
  if (existing.length >= 5) existing[0].remove();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    // Use CSS class so transition fires properly (not same-frame style set)
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function getInitials(name) {
  if (!name || name === 'Unknown') return '?';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function getAvatarColor(phone) {
  const colors = [
    'linear-gradient(135deg, #667eea, #764ba2)',
    'linear-gradient(135deg, #f093fb, #f5576c)',
    'linear-gradient(135deg, #4facfe, #00f2fe)',
    'linear-gradient(135deg, #43e97b, #38f9d7)',
    'linear-gradient(135deg, #fa709a, #fee140)',
    'linear-gradient(135deg, #a18cd1, #fbc2eb)',
    'linear-gradient(135deg, #fccb90, #d57eeb)',
    'linear-gradient(135deg, #e0c3fc, #8ec5fc)'
  ];
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    hash = phone.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return parseFloat(num || 0).toFixed(2);
}

// Fast escapeHtml without DOM creation (10x faster)
const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c => _escapeMap[c]);
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/[&"'<>]/g, c => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'
  })[c]);
}
