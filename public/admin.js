// ============================================
// Billy777 WhatsApp CRM - Super Admin Dashboard
// ============================================
let tenants = [];
let qrPollInterval = null;
let qrPollTenantId = null;
let pendingDeleteId = null;
let lastCreatedCreds = null;
let bulkCreatedCreds = [];
let toastCounter = 0;

// ── Theme ───────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.classList.toggle('dark');
  localStorage.setItem('admin-theme', isDark ? 'dark' : 'light');
}

// ── Auth Check ──────────────────────────────
(async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (!data.authenticated || data.role !== 'admin') {
      window.location.href = '/login';
      return;
    }
    document.getElementById('admin-name').textContent = data.username || 'Admin';
  } catch {
    window.location.href = '/login';
  }
})();

// ── Initial Load ────────────────────────────
loadTenants();
loadStats();
loadStorageStats();
setInterval(loadTenants, 8000);
setInterval(loadStats, 15000);
setInterval(loadStorageStats, 30000);

// ── API Helpers ─────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Load Tenants ────────────────────────────
async function loadTenants() {
  try {
    tenants = await api('/api/admin/tenants');
    renderTenants();
    updateCountBadge();
  } catch (err) {
    console.error('Failed to load tenants:', err);
  }
}

// ── Load Stats ──────────────────────────────
async function loadStats() {
  try {
    const stats = await api('/api/admin/stats');
    document.getElementById('stat-tenants').textContent = stats.total_tenants;
    document.getElementById('stat-leads').textContent = stats.total_leads;
    document.getElementById('stat-msgs').textContent = stats.messages_today;

    const connected = tenants.filter(t => t.wa_status === 'connected').length;
    const total = tenants.length;
    document.getElementById('stat-connected').textContent = connected;
    document.getElementById('stat-disconnected-info').textContent = `${total - connected} disconnected`;
    document.getElementById('stat-active-info').textContent = `${tenants.filter(t => t.is_active).length} active`;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function updateCountBadge() {
  const el = document.getElementById('tenant-count-badge');
  if (el) el.textContent = `${tenants.length} total`;
}

// ── Search / Filter ─────────────────────────
function filterTenants() {
  const q = (document.getElementById('search-input').value || '').toLowerCase().trim();
  const filtered = q ? tenants.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.username.toLowerCase().includes(q) ||
    (t.unique_key || '').toLowerCase().includes(q)
  ) : tenants;
  renderTenantRows(filtered);
}

// ── Render Tenants ──────────────────────────
function renderTenants() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const filtered = q ? tenants.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.username.toLowerCase().includes(q)
  ) : tenants;
  renderTenantRows(filtered);
}

function renderTenantRows(list) {
  const body = document.getElementById('tenants-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" class="px-5 py-16 text-center">
      <div class="flex flex-col items-center gap-3">
        <div class="w-12 h-12 rounded-2xl dark:bg-white/5 bg-gray-100 flex items-center justify-center">
          <svg class="w-6 h-6 dark:text-gray-600 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/></svg>
        </div>
        <p class="dark:text-gray-500 text-gray-400 text-sm">${tenants.length === 0 ? 'No marketers yet. Click "Add Marketer" to get started.' : 'No results match your search.'}</p>
      </div>
    </td></tr>`;
    return;
  }

  body.innerHTML = list.map((t, i) => {
    const waStatus = getWABadge(t.wa_status);
    const statusBadge = t.is_active
      ? '<span class="badge badge-active"><span class="dot dot-green"></span> Active</span>'
      : '<span class="badge badge-inactive">Inactive</span>';
    const avatarClass = `avatar-grad-${i % 6}`;

    return `
      <tr class="tenant-row border-b dark:border-white/[0.03] border-gray-100/80">
        <td class="px-5 py-3.5">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg ${avatarClass} flex items-center justify-center text-xs font-bold text-white shadow-sm">
              ${t.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <p class="text-sm font-semibold dark:text-white text-gray-900">${escapeHtml(t.name)}</p>
              <p class="text-[10px] dark:text-gray-600 text-gray-400">ID: ${t.id}</p>
            </div>
          </div>
        </td>
        <td class="px-5 py-3.5 text-sm dark:text-gray-300 text-gray-600 font-mono">${escapeHtml(t.username)}</td>
        <td class="px-5 py-3.5 hide-mobile">
          <div class="flex items-center gap-1.5">
            <code class="text-[11px] dark:text-gray-500 text-gray-400 font-mono">${t.unique_key.substring(0, 8)}...</code>
            <button class="btn-sm btn-copy text-[10px] px-1.5 py-0.5" onclick="copyText('${escapeHtml(t.unique_key)}', 'Unique key copied!')">Copy</button>
          </div>
        </td>
        <td class="px-5 py-3.5">${statusBadge}</td>
        <td class="px-5 py-3.5">${waStatus}</td>
        <td class="px-5 py-3.5 hide-mobile" id="tenant-stats-${t.id}">
          <span class="text-xs dark:text-gray-600 text-gray-400">-</span>
        </td>
        <td class="px-5 py-3.5">
          <div class="flex justify-end gap-1.5 flex-wrap">
            ${t.wa_status === 'connected'
              ? `<button class="btn-sm btn-disconnect" onclick="disconnectWA(${t.id})">Disconnect</button>`
              : `<button class="btn-sm btn-connect" onclick="connectWA(${t.id}, '${escapeHtml(t.name)}')">Connect WA</button>`
            }
            <button class="btn-sm btn-edit" onclick="openEditModal(${t.id})">Edit</button>
            <button class="btn-sm btn-delete" onclick="openDeleteModal(${t.id}, '${escapeHtml(t.name)}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  list.forEach(t => loadTenantStats(t.id));
}

function getWABadge(status) {
  switch (status) {
    case 'connected': return '<span class="badge badge-connected"><span class="dot dot-green"></span> Connected</span>';
    case 'waiting_qr': return '<span class="badge badge-qr"><span class="dot dot-yellow"></span> QR Ready</span>';
    case 'initializing': return '<span class="badge badge-qr"><span class="dot dot-yellow"></span> Starting...</span>';
    case 'disconnected': return '<span class="badge badge-disconnected"><span class="dot dot-red"></span> Disconnected</span>';
    case 'banned': return '<span class="badge badge-disconnected">Banned</span>';
    default: return '<span class="badge badge-init">Not Init</span>';
  }
}

async function loadTenantStats(id) {
  try {
    const stats = await api(`/api/admin/tenants/${id}/stats`);
    const el = document.getElementById(`tenant-stats-${id}`);
    if (el) {
      el.innerHTML = `<span class="text-xs dark:text-gray-400 text-gray-500">${stats.leads} leads &bull; ${stats.messages_today} msgs</span>`;
    }
  } catch {}
}

// ── Create / Edit Tenant ────────────────────
function openCreateModal() {
  document.getElementById('modal-title').textContent = 'Add Marketer';
  document.getElementById('modal-subtitle').textContent = 'Create a new marketer account';
  document.getElementById('tf-id').value = '';
  document.getElementById('tf-name').value = '';
  document.getElementById('tf-username').value = '';
  document.getElementById('tf-password').value = '';
  document.getElementById('tf-password').required = true;
  document.getElementById('tf-password').placeholder = 'Minimum 6 characters';
  document.getElementById('tf-username').disabled = false;
  document.getElementById('tf-submit').textContent = 'Create';
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-tenant').classList.remove('hidden');
}

function openEditModal(id) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  document.getElementById('modal-title').textContent = 'Edit Marketer';
  document.getElementById('modal-subtitle').textContent = `Editing ${t.name}`;
  document.getElementById('tf-id').value = id;
  document.getElementById('tf-name').value = t.name;
  document.getElementById('tf-username').value = t.username;
  document.getElementById('tf-username').disabled = true;
  document.getElementById('tf-password').value = '';
  document.getElementById('tf-password').required = false;
  document.getElementById('tf-password').placeholder = 'Leave blank to keep current';
  document.getElementById('tf-submit').textContent = 'Save Changes';
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-tenant').classList.remove('hidden');
}

async function saveTenant(e) {
  e.preventDefault();
  const id = document.getElementById('tf-id').value;
  const name = document.getElementById('tf-name').value.trim();
  const username = document.getElementById('tf-username').value.trim();
  const password = document.getElementById('tf-password').value;
  const errEl = document.getElementById('modal-error');
  const btn = document.getElementById('tf-submit');

  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = id ? 'Saving...' : 'Creating...';

  try {
    if (id) {
      const body = { name };
      if (password) body.password = password;
      await api(`/api/admin/tenants/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Marketer updated successfully', 'success');
    } else {
      if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
      const data = await api('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify({ name, username, password })
      });
      lastCreatedCreds = { name: data.name, username: data.username, password: data.password_plain, unique_key: data.unique_key };
      showCredsModal(lastCreatedCreds);
      toast('Marketer created successfully', 'success');
    }
    closeModal('modal-tenant');
    loadTenants();
    loadStats();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Save Changes' : 'Create';
  }
}

function showCredsModal(creds) {
  document.getElementById('creds-content').innerHTML = `
    <div class="creds-row"><span class="creds-label">Name:</span><span class="creds-value">${escapeHtml(creds.name)}</span></div>
    <div class="creds-row"><span class="creds-label">Username:</span><span class="creds-value">${escapeHtml(creds.username)}</span></div>
    <div class="creds-row"><span class="creds-label">Password:</span><span class="creds-value">${escapeHtml(creds.password)}</span></div>
    <div class="creds-row"><span class="creds-label">Unique Key:</span><span class="creds-value text-[11px]">${escapeHtml(creds.unique_key)}</span></div>
  `;
  document.getElementById('modal-creds').classList.remove('hidden');
}

function copyCreds() {
  if (!lastCreatedCreds) return;
  const text = `Billy777 WhatsApp CRM - Login Credentials\n\nName: ${lastCreatedCreds.name}\nUsername: ${lastCreatedCreds.username}\nPassword: ${lastCreatedCreds.password}\nUnique Key: ${lastCreatedCreds.unique_key}\n\nLogin URL: ${window.location.origin}/login`;
  navigator.clipboard.writeText(text).then(() => toast('Credentials copied!', 'success'));
}

// ── Bulk Add ────────────────────────────────
function openBulkModal() {
  document.getElementById('bulk-input').value = '';
  document.getElementById('bulk-error').classList.add('hidden');
  document.getElementById('bulk-progress').classList.add('hidden');
  document.getElementById('bulk-results').classList.add('hidden');
  document.getElementById('bulk-results').innerHTML = '';
  document.getElementById('bulk-submit-btn').disabled = false;
  document.getElementById('bulk-submit-btn').innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Create All';
  document.getElementById('modal-bulk').classList.remove('hidden');
}

async function startBulkAdd() {
  const raw = document.getElementById('bulk-input').value.trim();
  const errEl = document.getElementById('bulk-error');
  const submitBtn = document.getElementById('bulk-submit-btn');
  errEl.classList.add('hidden');

  if (!raw) {
    errEl.textContent = 'Please enter at least one marketer.';
    errEl.classList.remove('hidden');
    return;
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length > 30) {
    errEl.textContent = 'Maximum 30 marketers at a time. You entered ' + lines.length + '.';
    errEl.classList.remove('hidden');
    return;
  }

  // Parse lines
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts.length < 3) {
      errEl.textContent = `Line ${i + 1}: Need 3 values (name, username, password). Got ${parts.length}.`;
      errEl.classList.remove('hidden');
      return;
    }
    const [name, username, password] = parts;
    if (!name || !username || !password) {
      errEl.textContent = `Line ${i + 1}: Name, username, and password cannot be empty.`;
      errEl.classList.remove('hidden');
      return;
    }
    if (password.length < 6) {
      errEl.textContent = `Line ${i + 1}: Password for "${username}" must be at least 6 characters.`;
      errEl.classList.remove('hidden');
      return;
    }
    entries.push({ name, username, password });
  }

  // Start creating
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Creating...';
  document.getElementById('bulk-progress').classList.remove('hidden');
  document.getElementById('bulk-results').classList.remove('hidden');
  document.getElementById('bulk-results').innerHTML = '';

  bulkCreatedCreds = [];
  let successCount = 0;
  let failCount = 0;
  const total = entries.length;
  const resultsEl = document.getElementById('bulk-results');

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    document.getElementById('bulk-progress-text').textContent = `Creating ${e.name}...`;
    document.getElementById('bulk-progress-count').textContent = `${i + 1}/${total}`;
    document.getElementById('bulk-progress-fill').style.width = `${((i + 1) / total) * 100}%`;

    try {
      const data = await api('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify({ name: e.name, username: e.username, password: e.password })
      });
      bulkCreatedCreds.push({ name: data.name, username: data.username, password: data.password_plain, unique_key: data.unique_key });
      successCount++;
      resultsEl.innerHTML += `<div class="text-xs flex items-center gap-2 dark:text-green-400 text-green-600"><svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg> ${escapeHtml(e.name)} (${escapeHtml(e.username)}) - Created</div>`;
    } catch (err) {
      failCount++;
      resultsEl.innerHTML += `<div class="text-xs flex items-center gap-2 dark:text-red-400 text-red-600"><svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg> ${escapeHtml(e.name)} - ${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById('bulk-progress-text').textContent = 'Done!';
  submitBtn.innerHTML = 'Done';

  loadTenants();
  loadStats();

  if (bulkCreatedCreds.length > 0) {
    // Show bulk creds modal after a short delay so user can see results
    setTimeout(() => {
      closeModal('modal-bulk');
      showBulkCredsModal(successCount, failCount);
    }, 1500);
  }

  toast(`Bulk add complete: ${successCount} created, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
}

function showBulkCredsModal(success, failed) {
  document.getElementById('bulk-creds-subtitle').textContent =
    failed > 0 ? `${success} created, ${failed} failed` : `All ${success} marketers created successfully`;

  const container = document.getElementById('bulk-creds-content');
  container.innerHTML = bulkCreatedCreds.map((c, i) => `
    <div class="creds-box" style="margin-top:0;">
      <div class="text-xs font-bold dark:text-white text-gray-900 mb-1">${i + 1}. ${escapeHtml(c.name)}</div>
      <div class="creds-row"><span class="creds-label">Username:</span><span class="creds-value">${escapeHtml(c.username)}</span></div>
      <div class="creds-row"><span class="creds-label">Password:</span><span class="creds-value">${escapeHtml(c.password)}</span></div>
      <div class="creds-row"><span class="creds-label">Key:</span><span class="creds-value text-[10px]">${escapeHtml(c.unique_key)}</span></div>
    </div>
  `).join('');

  document.getElementById('modal-bulk-creds').classList.remove('hidden');
}

function copyBulkCreds() {
  if (!bulkCreatedCreds.length) return;
  const text = `Billy777 WhatsApp CRM - Bulk Credentials\n${'='.repeat(45)}\n\n` +
    bulkCreatedCreds.map((c, i) =>
      `${i + 1}. ${c.name}\n   Username: ${c.username}\n   Password: ${c.password}\n   Unique Key: ${c.unique_key}`
    ).join('\n\n') +
    `\n\nLogin URL: ${window.location.origin}/login`;
  navigator.clipboard.writeText(text).then(() => toast('All credentials copied!', 'success'));
}

// ── WhatsApp Connect ────────────────────────
async function connectWA(id, name) {
  try {
    await api(`/api/admin/tenants/${id}/connect-wa`, { method: 'POST' });
    openQrModal(id, name);
    loadTenants();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function disconnectWA(id) {
  try {
    await api(`/api/admin/tenants/${id}/disconnect-wa`, { method: 'POST' });
    toast('WhatsApp disconnected', 'success');
    loadTenants();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openQrModal(id, name) {
  document.getElementById('qr-title').textContent = `Connect WhatsApp - ${name}`;
  document.getElementById('qr-container').innerHTML = '<div class="dark:text-gray-500 text-gray-400 text-sm py-8"><div class="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-2"></div><br>Starting WhatsApp engine...<br><span class="text-xs opacity-60">This may take 30–60 seconds on first connect</span></div>';
  document.getElementById('modal-qr').classList.remove('hidden');

  qrPollTenantId = id;
  pollQR();
  qrPollInterval = setInterval(pollQR, 2000);
}

async function pollQR() {
  if (!qrPollTenantId) return;
  try {
    const data = await api(`/api/admin/tenants/${qrPollTenantId}/qr`);
    const container = document.getElementById('qr-container');

    if (data.ready) {
      container.innerHTML = `
        <div class="py-6">
          <div class="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-3">
            <svg class="w-8 h-8 text-green-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
          </div>
          <p class="text-green-500 font-semibold">Connected Successfully!</p>
          <p class="text-xs dark:text-gray-500 text-gray-400 mt-1">WhatsApp is now linked</p>
        </div>
      `;
      clearInterval(qrPollInterval);
      qrPollInterval = null;
      loadTenants();
    } else if (data.image) {
      container.innerHTML = `<img src="${data.image}" alt="QR Code" class="mx-auto rounded-xl" style="width:260px;height:260px;">
        <p class="text-[11px] dark:text-gray-500 text-gray-400 mt-3">Open WhatsApp &gt; Linked Devices &gt; Link a Device</p>`;
    } else if (data.status === 'initializing') {
      container.innerHTML = '<div class="dark:text-gray-500 text-gray-400 text-sm py-8"><div class="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-2"></div><br>Starting WhatsApp engine...<br><span class="text-xs opacity-60">Launching browser, please wait...</span></div>';
    } else {
      container.innerHTML = '<div class="dark:text-gray-500 text-gray-400 text-sm py-8">Waiting for QR code...</div>';
    }
  } catch (err) {
    console.error('QR poll error:', err);
  }
}

function closeQrModal() {
  clearInterval(qrPollInterval);
  qrPollInterval = null;
  qrPollTenantId = null;
  closeModal('modal-qr');
}

// ── Delete ──────────────────────────────────
function openDeleteModal(id, name) {
  pendingDeleteId = id;
  document.getElementById('delete-msg').textContent = `Are you sure you want to delete "${name}"? All data including leads, messages, and WhatsApp session will be permanently removed.`;
  document.getElementById('modal-delete').classList.remove('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const btn = document.getElementById('delete-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    await api(`/api/admin/tenants/${pendingDeleteId}`, { method: 'DELETE' });
    toast('Marketer deleted', 'success');
    closeModal('modal-delete');
    loadTenants();
    loadStats();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete Forever';
    pendingDeleteId = null;
  }
}

// ══════════════════════════════════════════════
// STORAGE MANAGEMENT
// ══════════════════════════════════════════════

function getBarClass(percent) {
  if (percent >= 90) return 'progress-fill-danger';
  if (percent >= 70) return 'progress-fill-warn';
  return '';
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

async function loadStorageStats() {
  try {
    const [storage, tenantStorage] = await Promise.all([
      api('/api/admin/storage'),
      api('/api/admin/storage/tenants'),
    ]);

    // RAM
    const ramBar = document.getElementById('ram-bar');
    ramBar.style.width = storage.ram.percent + '%';
    ramBar.className = 'progress-fill ' + getBarClass(storage.ram.percent);
    document.getElementById('ram-percent').textContent = storage.ram.percent + '%';
    document.getElementById('ram-used').textContent = storage.ram.rss_mb + ' MB';
    document.getElementById('ram-limit').textContent = '/ ' + storage.ram.limit_mb + ' MB';
    document.getElementById('ram-clients').textContent = storage.ram.active_clients + ' active WA client' + (storage.ram.active_clients !== 1 ? 's' : '');

    // Disk
    const diskBar = document.getElementById('disk-bar');
    diskBar.style.width = storage.disk.percent + '%';
    diskBar.className = 'progress-fill ' + getBarClass(storage.disk.percent);
    document.getElementById('disk-percent').textContent = storage.disk.percent + '%';
    document.getElementById('disk-used').textContent = storage.disk.used_mb + ' MB';
    document.getElementById('disk-limit').textContent = '/ ' + storage.disk.limit_mb + ' MB';

    // Database
    const dbBar = document.getElementById('db-bar');
    dbBar.style.width = storage.database.percent + '%';
    dbBar.className = 'progress-fill ' + getBarClass(storage.database.percent);
    document.getElementById('db-percent').textContent = storage.database.percent + '%';
    document.getElementById('db-used').textContent = '~' + storage.database.estimated_mb + ' MB';
    document.getElementById('db-limit').textContent = '/ ' + storage.database.limit_mb + ' MB';
    document.getElementById('db-rows').textContent = formatNum(storage.database.total_rows) + ' total rows';

    // DB Breakdown
    document.getElementById('db-conv').textContent = formatNum(storage.database.rows.conversations);
    document.getElementById('db-leads').textContent = formatNum(storage.database.rows.leads);
    document.getElementById('db-broadcasts').textContent = formatNum(storage.database.rows.broadcasts);
    const otherRows = (storage.database.rows.scheduled_messages || 0) + (storage.database.rows.activity_log || 0)
      + (storage.database.rows.auto_replies || 0) + (storage.database.rows.quick_replies || 0) + (storage.database.rows.message_templates || 0);
    document.getElementById('db-other').textContent = formatNum(otherRows);

    // Uptime & Heap
    document.getElementById('server-uptime').textContent = formatUptime(storage.uptime_seconds);
    document.getElementById('server-heap').textContent = storage.ram.heap_used_mb + ' / ' + storage.ram.heap_total_mb + ' MB';

    // Per-Tenant Storage Table
    renderTenantStorage(tenantStorage);

    // Alerts
    renderStorageAlerts(storage);

  } catch (err) {
    console.error('Failed to load storage stats:', err);
  }
}

function renderTenantStorage(list) {
  const body = document.getElementById('storage-tenants-body');
  if (!list || !list.length) {
    body.innerHTML = '<tr><td colspan="6" class="px-3 py-6 text-center text-xs dark:text-gray-600 text-gray-400">No marketers</td></tr>';
    return;
  }

  body.innerHTML = list.map(t => {
    const waColor = t.wa_status === 'connected' ? 'text-green-500' :
                    t.wa_status === 'waiting_qr' ? 'text-amber-500' : 'dark:text-gray-600 text-gray-400';
    const waLabel = t.wa_status === 'connected' ? 'Connected' :
                    t.wa_status === 'waiting_qr' ? 'QR Ready' :
                    t.wa_status === 'banned' ? 'Banned' :
                    t.wa_status === 'disconnected' ? 'Disconnected' : 'Not Init';
    const ramBadge = t.using_ram
      ? '<span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-500/15 text-blue-500">~150 MB</span>'
      : '<span class="text-[10px] dark:text-gray-600 text-gray-400">-</span>';

    return `
      <tr class="border-b dark:border-white/[0.03] border-gray-100/80 text-xs">
        <td class="px-3 py-2.5">
          <p class="font-semibold dark:text-white text-gray-900 text-xs">${escapeHtml(t.name)}</p>
          <p class="text-[9px] dark:text-gray-600 text-gray-400">${escapeHtml(t.username)}</p>
        </td>
        <td class="px-3 py-2.5"><span class="text-[10px] font-bold ${waColor}">${waLabel}</span></td>
        <td class="px-3 py-2.5">${ramBadge}</td>
        <td class="px-3 py-2.5">
          <span class="font-mono text-[11px] dark:text-gray-300 text-gray-600">${t.disk_mb} MB</span>
        </td>
        <td class="px-3 py-2.5">
          <span class="font-mono text-[11px] dark:text-gray-300 text-gray-600">${formatNum(t.total_rows)}</span>
          <span class="text-[9px] dark:text-gray-600 text-gray-400 ml-1">(${formatNum(t.db_rows.conversations)} msgs)</span>
        </td>
        <td class="px-3 py-2.5">
          <span class="font-mono text-[11px] dark:text-gray-300 text-gray-600">~${t.estimated_db_mb} MB</span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderStorageAlerts(storage) {
  const alertsEl = document.getElementById('storage-alerts');
  const alerts = [];

  // RAM warnings
  if (storage.ram.percent >= 90) {
    alerts.push({
      type: 'danger',
      icon: '🚨',
      title: 'RAM Critical!',
      msg: `Server is using ${storage.ram.rss_mb} MB of ${storage.ram.limit_mb} MB (${storage.ram.percent}%). Disconnect idle marketers or upgrade your plan to increase RAM.`,
      action: 'Upgrade RAM',
      actionTip: 'Consider upgrading to a higher plan with more memory.'
    });
  } else if (storage.ram.percent >= 70) {
    alerts.push({
      type: 'warn',
      icon: '⚠️',
      title: 'RAM Usage High',
      msg: `Server RAM at ${storage.ram.percent}% (${storage.ram.rss_mb} / ${storage.ram.limit_mb} MB). You may need to upgrade soon if you add more marketers.`,
    });
  }

  // Disk warnings
  if (storage.disk.percent >= 90) {
    alerts.push({
      type: 'danger',
      icon: '🚨',
      title: 'Disk Storage Critical!',
      msg: `Disk at ${storage.disk.used_mb} MB of ${storage.disk.limit_mb} MB (${storage.disk.percent}%). Clean orphaned sessions or increase disk size.`,
      action: 'Clean Orphans',
      onclick: 'cleanupOrphans()'
    });
  } else if (storage.disk.percent >= 70) {
    alerts.push({
      type: 'warn',
      icon: '⚠️',
      title: 'Disk Storage High',
      msg: `Disk usage at ${storage.disk.percent}% (${storage.disk.used_mb} / ${storage.disk.limit_mb} MB). Consider cleaning up orphaned sessions.`,
    });
  }

  // Database warnings
  if (storage.database.percent >= 90) {
    alerts.push({
      type: 'danger',
      icon: '🚨',
      title: 'Database Storage Critical!',
      msg: `Database at ~${storage.database.estimated_mb} MB of ${storage.database.limit_mb} MB (${storage.database.percent}%). Purge old messages now to avoid reaching the limit. Upgrade your Supabase plan for more storage.`,
      action: 'Purge Now',
      onclick: 'openCleanupModal()'
    });
  } else if (storage.database.percent >= 70) {
    alerts.push({
      type: 'warn',
      icon: '⚠️',
      title: 'Database Storage Growing',
      msg: `Database at ~${storage.database.estimated_mb} MB of ${storage.database.limit_mb} MB (${storage.database.percent}%). Consider purging old conversations to free space.`,
    });
  }

  if (!alerts.length) {
    alertsEl.innerHTML = '';
    return;
  }

  alertsEl.innerHTML = alerts.map(a => {
    const borderColor = a.type === 'danger' ? 'border-red-500/30 dark:bg-red-500/5 bg-red-50' : 'border-amber-500/30 dark:bg-amber-500/5 bg-amber-50';
    const textColor = a.type === 'danger' ? 'text-red-500' : 'text-amber-500';
    const actionBtn = a.onclick
      ? `<button class="btn-sm ${a.type === 'danger' ? 'btn-disconnect' : 'btn-edit'} mt-2 text-[10px]" onclick="${a.onclick}">${a.action}</button>`
      : (a.action ? `<p class="text-[10px] ${textColor} font-bold mt-1">${a.action}</p>` : '');
    return `
      <div class="p-4 rounded-xl border ${borderColor} flex items-start gap-3">
        <span class="text-lg flex-shrink-0">${a.icon}</span>
        <div class="flex-1">
          <p class="text-sm font-bold ${textColor}">${a.title}</p>
          <p class="text-xs dark:text-gray-400 text-gray-500 mt-0.5">${a.msg}</p>
          ${actionBtn}
        </div>
      </div>
    `;
  }).join('');
}

function openCleanupModal() {
  document.getElementById('cleanup-days').value = 90;
  document.getElementById('modal-cleanup').classList.remove('hidden');
}

async function confirmCleanup() {
  const days = parseInt(document.getElementById('cleanup-days').value) || 90;
  if (days < 7) { toast('Minimum 7 days', 'error'); return; }
  const btn = document.getElementById('cleanup-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Purging...';
  try {
    const result = await api('/api/admin/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ days })
    });
    toast(`Purged ${result.deleted} messages older than ${result.days} days`, 'success');
    closeModal('modal-cleanup');
    loadStorageStats();
    loadStats();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Purge Messages';
  }
}

async function cleanupOrphans() {
  if (!confirm('Remove session files for deleted marketers?')) return;
  try {
    const result = await api('/api/admin/storage/cleanup-orphans', { method: 'POST' });
    if (result.cleaned > 0) {
      toast(`Cleaned ${result.cleaned} orphaned session(s), freed ${result.freed_mb} MB`, 'success');
    } else {
      toast('No orphaned sessions found', 'info');
    }
    loadStorageStats();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Logout ──────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ── Utils ───────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg || 'Copied!', 'success'));
}

function toast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const id = ++toastCounter;
  const item = document.createElement('div');
  item.className = `toast-item toast-${type}`;
  item.id = `toast-${id}`;
  item.innerHTML = msg;
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, 3500);
}
