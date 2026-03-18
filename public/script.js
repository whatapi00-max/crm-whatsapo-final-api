// ============================================
// Billy777 WhatsApp CRM v3.0 - Frontend Logic
// Multi-Tenant Version
// ============================================

const API_BASE = '';
const REFRESH_INTERVAL = 5000;

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

// ── DOM Helpers ────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Auth Check & Initialize ────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Check auth before anything
  try {
    const res = await fetch('/api/auth/check');
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
  loadActiveChats();
  loadQuickReplies();
  startAutoRefresh();
  startSessionCheck();
});

// ── Session Timeout Monitor ────────────────
function startSessionCheck() {
  // Check session validity every 60 seconds
  setInterval(async () => {
    try {
      const res = await fetch('/api/auth/check');
      if (res.status === 401) {
        window.location.href = '/login';
      }
    } catch {}
  }, 60000);
}

// ── Logout ─────────────────────────────────
async function logoutTenant() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
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

  // Load page data
  switch (page) {
    case 'contacts': loadContactsPage(); break;
    case 'broadcasts': loadBroadcasts(); break;
    case 'automation': loadAutoReplies(); break;
    case 'analytics': loadAnalytics(); break;
    case 'scheduled': loadScheduled(); break;
    case 'quick-replies': loadQuickRepliesPage(); break;
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

  // Refresh button
  $('#refresh-btn').addEventListener('click', () => {
    loadActiveChats();
    if (currentPhone) loadChat(currentPhone);
    showToast('Data refreshed', 'info');
    // Reload current page data
    navigateTo(currentPage);
  });

  // Search in inbox
  $('#search-input').addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderLeadsList();
  });

  // Global search bar
  $('#global-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (currentPage === 'inbox') {
      currentSearch = query;
      $('#search-input').value = e.target.value;
      renderLeadsList();
    }
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
    await updateLead(currentPhone, { status: e.target.value });
    loadActiveChats();
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
  const res = await fetch(API_BASE + path);
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API_BASE + path, { method: 'DELETE' });
  if (handleAuthError(res.status)) throw new Error('401');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ══════════════════════════════════════════════
// CONNECTION STATUS
// ══════════════════════════════════════════════
async function checkConnection() {
  try {
    const data = await apiGet('/api/qr-status');
    const dot = $('#connection-dot');
    const text = $('#connection-text');
    const sDot = $('#settings-conn-dot');
    const sText = $('#settings-conn-text');
    const statusSel = $('#conn-status-select');

    if (data.banned) {
      dot.className = 'w-3 h-3 rounded-full bg-red-600 block';
      dot.style.animation = '';
      text.textContent = 'Banned';
      text.className = 'text-[11px] text-red-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-red-600'; }
      if (sText) { sText.textContent = 'Number Banned'; sText.className = 'text-sm text-red-500 font-semibold'; }
      if (statusSel) statusSel.value = 'banned';
      $('#qr-overlay').classList.remove('hidden');
    } else if (data.ready) {
      dot.className = 'w-3 h-3 rounded-full bg-wa-green block';
      dot.style.animation = 'pulse-green 2s infinite';
      text.textContent = 'Connected';
      text.className = 'text-[11px] text-wa-green opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-wa-green'; }
      if (sText) { sText.textContent = 'Connected'; sText.className = 'text-sm text-wa-green font-semibold'; }
      if (statusSel) statusSel.value = 'connected';
      $('#qr-overlay').classList.add('hidden');
      const qrSection = $('#qr-section');
      if (qrSection) qrSection.classList.add('hidden');
    } else {
      // Not connected - show "contact admin" overlay
      dot.className = 'w-3 h-3 rounded-full bg-red-500 animate-pulse block';
      text.textContent = 'Not Connected';
      if (sDot) { sDot.className = 'w-3 h-3 rounded-full bg-red-500'; }
      if (sText) { sText.textContent = 'Not Connected'; sText.className = 'text-sm text-red-400'; }
      if (statusSel) statusSel.value = 'connected';
      $('#qr-overlay').classList.remove('hidden');
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

// QR codes are now managed by admin - no self-service QR display

// ══════════════════════════════════════════════
// ACTIVE CHATS / LEADS LIST (Inbox)
// ══════════════════════════════════════════════
async function loadActiveChats() {
  try {
    activeChats = await apiGet('/api/active-chats');
    $('#chat-count').textContent = activeChats.length;
    renderLeadsList();
  } catch (err) {
    console.error('Load chats error:', err);
  }
}

function renderLeadsList() {
  const container = $('#leads-list');
  let filtered = activeChats;

  if (currentFilter !== 'all') {
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
        <p class="text-xs">No ${currentFilter === 'all' ? '' : currentFilter + ' '}leads found</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(chat => {
    const initials = getInitials(chat.name || chat.phone);
    const avatarColor = getAvatarColor(chat.phone);
    const lastMsg = chat.last_message;
    const lastMsgText = lastMsg
      ? (lastMsg.direction === 'outgoing' ? '↗ ' : '') + truncate(lastMsg.message, 40)
      : 'No messages yet';
    const timeStr = lastMsg ? formatTime(lastMsg.created_at) : '';
    const isActive = chat.phone === currentPhone;

    const displayPhone = chat.real_phone ? '+' + chat.real_phone : '+' + chat.phone;

    return `
      <div class="lead-item ${isActive ? 'active' : ''}" data-phone="${escapeAttr(chat.phone)}" onclick="selectChat('${escapeAttr(chat.phone)}')">
        <div class="lead-avatar" style="background: ${avatarColor}">${escapeHtml(initials)}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <span class="font-medium text-sm truncate">${escapeHtml(chat.name || displayPhone)}</span>
            <span class="text-[0.65rem] text-gray-500 ml-2 flex-shrink-0">${escapeHtml(timeStr)}</span>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <p class="text-xs text-gray-500 truncate">${escapeHtml(displayPhone)} · ${escapeHtml(lastMsgText)}</p>
            <div class="flex items-center gap-1 ml-2 flex-shrink-0">
              ${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ''}
              <span class="status-badge status-${escapeAttr(chat.status)}">${escapeHtml(chat.status)}</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function filterLeadsList(query) {
  currentSearch = query;
  renderLeadsList();
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
    $('#chat-name').textContent = lead.name || (lead.real_phone ? '+' + lead.real_phone : '+' + lead.phone);
    $('#chat-phone').textContent = lead.real_phone ? '+' + lead.real_phone : '+' + phone;
    if (lead.real_phone && lead.real_phone !== phone) {
      $('#chat-phone').textContent += ' (WA ID: ' + phone + ')';
    }
    $('#chat-status-select').value = lead.status || 'new';

    // Info panel
    $('#info-avatar').textContent = initials;
    $('#info-avatar').style.background = getAvatarColor(phone);
    $('#info-name').value = lead.name || '';
    $('#info-phone').textContent = 'WA ID: ' + phone;
    $('#info-real-phone').value = lead.real_phone || '';
    $('#info-email').value = lead.email || '';
    $('#info-company').value = lead.company || '';
    $('#info-source').value = lead.source || 'organic';
    $('#info-notes').value = lead.notes || '';
    $('#info-tags').value = (lead.tags || []).join(', ');

    $('#info-created').textContent = formatDate(lead.created_at);
    $('#info-last-active').textContent = formatTime(lead.last_message_at);
  }

  $$('.lead-item').forEach(el => {
    el.classList.toggle('active', el.dataset.phone === phone);
  });

  $('#chat-messages').innerHTML = '<div class="text-center text-gray-500 py-8"><p class="text-sm">Loading messages...</p></div>';

  await loadChat(phone);

  try {
    await apiPost(`/api/messages/${encodeURIComponent(phone)}/read`, {});
  } catch { /* ignore */ }

  $('#message-input').focus();
}

async function loadChat(phone) {
  try {
    const messages = await apiGet(`/api/messages/${encodeURIComponent(phone)}`);
    renderMessages(messages);
  } catch (err) {
    console.error('Load chat error:', err);
    $('#chat-messages').innerHTML = `
      <div class="text-center py-8">
        <p class="text-sm text-red-400">Failed to load messages</p>
        <button onclick="loadChat('${escapeAttr(phone)}')" class="mt-3 px-4 py-1.5 text-xs bg-white/10 rounded-lg hover:bg-white/20 transition-colors">Retry</button>
      </div>`;
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

    return `
      ${dateSeparator}
      <div class="${alignClass}">
        <div class="msg-bubble ${bubbleClass}">
          <div class="whitespace-pre-wrap">${escapeHtml(msg.message)}</div>
          <div class="msg-time ${isOutgoing ? 'text-right' : ''}">${formatTime(msg.created_at)}${isOutgoing ? ' ✓✓' : ''}</div>
        </div>
      </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
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

  try {
    await apiPost('/api/send-reply', { phone: currentPhone, message });
    input.value = '';
    input.style.height = 'auto';
    $('#char-count').textContent = '0 / 4096';
    sendBtn.disabled = true;

    $('#typing-indicator').classList.remove('hidden');
    setTimeout(() => $('#typing-indicator').classList.add('hidden'), 1500);

    await Promise.all([loadChat(currentPhone), loadActiveChats()]);
    showToast('Message sent!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to send', 'error');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg><span class="hidden sm:inline">Send</span>';
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
    showToast('Lead updated', 'success');
  } catch (err) {
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

  await updateLead(currentPhone, {
    name: $('#info-name').value,
    real_phone: $('#info-real-phone').value.trim(),
    email: $('#info-email').value.trim(),
    company: $('#info-company').value.trim(),
    source: $('#info-source').value,
    notes: $('#info-notes').value,

    tags
  });

  loadActiveChats();
}

async function resolvePhone() {
  if (!currentPhone) return;
  const btn = $('#resolve-phone-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await apiPost(`/api/leads/${encodeURIComponent(currentPhone)}/resolve`, {});
    if (result.success && result.real_phone) {
      $('#info-real-phone').value = result.real_phone;
      $('#chat-phone').textContent = result.real_phone;
      showToast(`Phone detected: ${result.real_phone}`, 'success');
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
    const chats = activeChats.length ? activeChats : await apiGet('/api/active-chats');
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
        <td class="px-4 py-3 text-xs text-gray-400">${escapeHtml(c.real_phone || '+' + c.phone)}</td>
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
    await apiPost(`/api/broadcasts/${id}/send`, {});
    showToast('Broadcast sending started!', 'success');
    loadBroadcasts();
  } catch (err) {
    showToast(err.message || 'Failed to send', 'error');
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
    showToast('Cancelled', 'success');
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
    showToast('Deleted', 'success');
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
// AUTO-REFRESH
// ══════════════════════════════════════════════
function startAutoRefresh() {
  refreshTimer = setInterval(async () => {
    await checkConnection();
    await loadActiveChats();
    if (currentPhone && currentPage === 'inbox') {
      await loadChat(currentPhone);
    }
  }, REFRESH_INTERVAL);
}

// ══════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════════════
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
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

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/[&"'<>]/g, c => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'
  })[c]);
}
