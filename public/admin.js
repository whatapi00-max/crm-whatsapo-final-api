// ============================================
// Billy777 WhatsApp CRM - Super Admin Dashboard
// ============================================
let tenants = [];
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
    const res = await fetch('/api/auth/check?role=admin');
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
loadDashboard();
checkNotifBadge();
setInterval(loadTenants, 8000);
setInterval(loadStats, 15000);
setInterval(loadStorageStats, 30000);
setInterval(loadDashboard, 30000);
setInterval(checkNotifBadge, 20000);

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
        <td class="px-5 py-3.5 hide-mobile whitespace-nowrap" id="tenant-stats-${t.id}">
          <span class="text-xs dark:text-gray-600 text-gray-400">-</span>
        </td>
        <td class="px-5 py-3.5">
          <div class="flex justify-end gap-1.5 flex-wrap">
            ${t.wa_status === 'connected'
              ? `<button class="btn-sm btn-edit" onclick="openWAConfigModal(${t.id}, '${escapeHtml(t.name)}')">⚙️ API Config</button>
                 <button class="btn-sm btn-disconnect" onclick="disconnectWA(${t.id})">Disconnect</button>`
              : `<button class="btn-sm btn-connect" onclick="openWAConfigModal(${t.id}, '${escapeHtml(t.name)}')">Configure API</button>`
            }
            <button class="btn-sm btn-edit" onclick="openEditModal(${t.id})">Edit</button>
            <button class="btn-sm" style="background:rgba(239,68,68,0.12);color:#ef4444;border:none;cursor:pointer" onclick="openWarnModal(${t.id}, '${escapeHtml(t.name)}')">⚠️ Warn</button>
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
    case 'not_configured':
    default: return '<span class="badge badge-disconnected"><span class="dot dot-red"></span> Not Configured</span>';
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

// ── WhatsApp Cloud API Config ───────────────

async function openWAConfigModal(id, name) {
  document.getElementById('wa-config-title').textContent = `Configure WhatsApp - ${name}`;
  document.getElementById('wac-tenant-id').value = id;
  document.getElementById('wac-phone-id').value = '';
  document.getElementById('wac-access-token').value = '';
  document.getElementById('wac-waba-id').value = '';
  document.getElementById('wa-config-error').classList.add('hidden');
  const statusEl = document.getElementById('wa-config-status');
  statusEl.classList.add('hidden');

  // Load existing config
  try {
    const config = await api(`/api/admin/tenants/${id}/wa-config`);
    if (config.configured) {
      document.getElementById('wac-phone-id').value = config.phone_number_id || '';
      document.getElementById('wac-waba-id').value = config.waba_id || '';
      statusEl.className = 'mb-4 p-3 rounded-xl text-xs';
      statusEl.style.background = 'rgba(34,197,94,0.08)';
      statusEl.style.border = '1px solid rgba(34,197,94,0.2)';
      statusEl.innerHTML = '<span class="text-green-500 font-bold">✓ Currently configured</span> — Token is saved. Enter a new token to update.';
      statusEl.classList.remove('hidden');
      document.getElementById('wac-access-token').placeholder = '••••••• (saved — enter new to update)';
      document.getElementById('wac-access-token').required = false;
    } else {
      document.getElementById('wac-access-token').placeholder = 'EAAxxxxxxx...';
      document.getElementById('wac-access-token').required = true;
    }
  } catch (e) {
    console.error('Load WA config error:', e);
  }

  document.getElementById('modal-wa-config').classList.remove('hidden');
}

async function saveWAConfig(e) {
  e.preventDefault();
  const id = document.getElementById('wac-tenant-id').value;
  const phoneId = document.getElementById('wac-phone-id').value.trim();
  const accessToken = document.getElementById('wac-access-token').value.trim();
  const wabaId = document.getElementById('wac-waba-id').value.trim();
  const errEl = document.getElementById('wa-config-error');
  const btn = document.getElementById('wac-submit');

  errEl.classList.add('hidden');

  if (!phoneId) {
    errEl.textContent = 'Phone Number ID is required';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-1"></span> Verifying...';

  try {
    const body = { phone_number_id: phoneId, waba_id: wabaId };
    if (accessToken) body.access_token = accessToken;

    // If no new token but config exists, we need to inform user
    if (!accessToken) {
      const existing = await api(`/api/admin/tenants/${id}/wa-config`);
      if (!existing.configured) {
        errEl.textContent = 'Access Token is required for first-time setup';
        errEl.classList.remove('hidden');
        return;
      }
      // Keep existing token — just update phone_number_id/waba_id
      // Re-read token from server by sending a flag
      body.access_token = '__keep_existing__';
    }

    const result = await api(`/api/admin/tenants/${id}/configure-wa`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    toast(`WhatsApp configured! ${result.verified_name ? '(' + result.verified_name + ')' : ''}`, 'success');
    closeModal('modal-wa-config');
    loadTenants();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg> Save & Verify';
  }
}

async function disconnectWA(id) {
  if (!confirm('Remove WhatsApp Cloud API config for this marketer?')) return;
  try {
    await api(`/api/admin/tenants/${id}/disconnect-wa`, { method: 'POST' });
    toast('WhatsApp API disconnected', 'success');
    loadTenants();
  } catch (err) {
    toast(err.message, 'error');
  }
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
    const waColor = t.wa_status === 'connected' ? 'text-green-500' : 'dark:text-gray-600 text-gray-400';
    const waLabel = t.wa_status === 'connected' ? 'Connected' : 'Not Configured';
    const ramBadge = '<span class="text-[10px] dark:text-gray-600 text-gray-400">-</span>';

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

// ── Tab System ──────────────────────────────
function showTab(name) {
  ['overview', 'marketers', 'notifications'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.add('hidden');
    document.getElementById(`tab-btn-${t}`).classList.remove('tab-active');
  });
  document.getElementById(`tab-${name}`).classList.remove('hidden');
  document.getElementById(`tab-btn-${name}`).classList.add('tab-active');
  if (name === 'overview') loadDashboard();
  if (name === 'notifications') loadNotifications();
}

// ── Dashboard / Overview Tab ─────────────
async function loadDashboard() {
  try {
    const data = await api('/api/admin/marketer-dashboard');
    document.getElementById('dash-msgs-today').textContent = data.total_messages_today;
    document.getElementById('dash-msgs-week').textContent = data.total_messages_week;
    document.getElementById('dash-cp-alerts').textContent = data.copy_paste_alerts;

    const grid = document.getElementById('dash-marketer-grid');
    if (!data.marketers || !data.marketers.length) {
      grid.innerHTML = '<div class="card p-8 text-center" style="grid-column:1/-1"><p class="text-sm dark:text-gray-500 text-gray-400">No marketers yet. Add a marketer to see performance data.</p></div>';
      return;
    }
    grid.innerHTML = data.marketers.map((m, i) => renderMarketerCard(m, i)).join('');
  } catch (err) {
    console.error('Dashboard load error:', err);
    document.getElementById('dash-marketer-grid').innerHTML =
      '<div class="card p-8 text-center" style="grid-column:1/-1"><p class="text-sm text-red-500">Failed to load dashboard. Will retry shortly.</p></div>';
  }
}

function renderMarketerCard(m, idx) {
  const avatarClass = `avatar-grad-${idx % 6}`;
  const waStatusBadge = m.wa_status === 'connected'
    ? '<span class="badge badge-connected"><span class="dot dot-green"></span> Connected</span>'
    : '<span class="badge badge-disconnected"><span class="dot dot-red"></span> Not Set</span>';
  const activeBadge = m.is_active
    ? '<span class="badge badge-active"><span class="dot dot-green"></span> Active</span>'
    : '<span class="badge badge-inactive">Inactive</span>';

  // 7-day bar chart
  const chart = m.stats.weekly_chart || [0, 0, 0, 0, 0, 0, 0];
  const maxVal = Math.max(...chart, 1);
  const dayLabels = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toLocaleDateString('en', { weekday: 'short' });
  });
  const barsHtml = chart.map((val, i) => {
    const h = Math.max(Math.round((val / maxVal) * 44), 3);
    const isToday = i === 6;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px">
      <span style="font-size:8px;color:#6b7280;min-height:10px">${val > 0 ? val : ''}</span>
      <div class="chart-bar${isToday ? ' chart-bar-today' : ''}" style="width:100%;height:${h}px" title="${dayLabels[i]}: ${val} msgs"></div>
      <span style="font-size:8px;color:#6b7280">${dayLabels[i].substring(0, 2)}</span>
    </div>`;
  }).join('');

  const cpWarnHtml = m.copy_paste_warning ? `
    <div style="margin-top:10px;padding:8px 10px;border-radius:10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25)">
      <p style="font-size:11px;color:#f59e0b;font-weight:700">⚠️ Copy-Paste Alert</p>
      <p style="font-size:10px;color:#9ca3af;margin-top:2px">Same message sent to <strong style="color:#fbbf24">${m.copy_paste_max}</strong> different contacts in the last hour.</p>
    </div>` : '';

  return `<div class="card p-4${m.copy_paste_warning ? ' dark:border-amber-500/20 border-amber-300/60' : ''}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="w-10 h-10 rounded-xl ${avatarClass} flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
          ${m.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <p class="text-sm font-bold dark:text-white text-gray-900">${escapeHtml(m.name)}</p>
          <p class="text-[10px] font-mono dark:text-gray-500 text-gray-400">${escapeHtml(m.username)}</p>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">
        ${activeBadge}
        ${waStatusBadge}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:12px">
      <div class="dark:bg-white/[0.03] bg-gray-50 rounded-lg p-1.5 text-center">
        <p class="text-sm font-extrabold dark:text-white text-gray-900">${formatNum(m.stats.total_leads)}</p>
        <p class="text-[9px] dark:text-gray-500 text-gray-400">Leads</p>
      </div>
      <div class="dark:bg-white/[0.03] bg-gray-50 rounded-lg p-1.5 text-center">
        <p class="text-sm font-extrabold text-green-500">${m.stats.messages_today}</p>
        <p class="text-[9px] dark:text-gray-500 text-gray-400">Sent Today</p>
      </div>
      <div class="dark:bg-white/[0.03] bg-gray-50 rounded-lg p-1.5 text-center">
        <p class="text-sm font-extrabold text-blue-500">${m.stats.incoming_today}</p>
        <p class="text-[9px] dark:text-gray-500 text-gray-400">Recv Today</p>
      </div>
      <div class="dark:bg-white/[0.03] bg-gray-50 rounded-lg p-1.5 text-center">
        <p class="text-sm font-extrabold text-purple-500">${m.stats.messages_week}</p>
        <p class="text-[9px] dark:text-gray-500 text-gray-400">This Week</p>
      </div>
    </div>
    <div>
      <p class="text-[9px] font-bold uppercase tracking-widest dark:text-gray-600 text-gray-400 mb-1.5">7-Day Activity</p>
      <div style="display:flex;align-items:flex-end;gap:3px;height:60px">${barsHtml}</div>
    </div>
    ${cpWarnHtml}
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(239,68,68,0.12)">
      <button class="btn-sm btn-disconnect w-full justify-center" style="width:100%;display:flex;align-items:center;gap:5px;" onclick="openWarnModal(${m.id}, '${escapeHtml(m.name).replace(/'/g, "\\'")}')">
        <svg style="width:12px;height:12px;flex-shrink:0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
        Send Warning
      </button>
    </div>
  </div>`;
}

// ── Marketer Warning ─────────────────────
let warnTargetId = null;
const DEFAULT_WARNING = "⚠️ WARNING: Stop spamming immediately. If you continue, your WhatsApp API access will be banned. This is your final warning — act strictly!";

function openWarnModal(id, name) {
  warnTargetId = id;
  document.getElementById('warn-marketer-name').textContent = name;
  document.getElementById('warn-msg-input').value = DEFAULT_WARNING;
  document.getElementById('modal-warn').classList.remove('hidden');
}

async function sendWarning() {
  if (!warnTargetId) return;
  const message = document.getElementById('warn-msg-input').value.trim();
  if (!message) { toast('Warning message cannot be empty', 'error'); return; }
  const btn = document.getElementById('warn-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    await api(`/api/admin/warn-marketer/${warnTargetId}`, {
      method: 'POST',
      body: JSON.stringify({ message })
    });
    toast(`Warning sent — their CRM will freeze for 10 seconds`, 'success');
    closeModal('modal-warn');
    warnTargetId = null;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Warning';
  }
}

// ── Notifications Tab ────────────────────
async function checkNotifBadge() {
  try {
    const data = await api('/api/admin/notifications');
    updateNotifBadge(data.unread);
  } catch (_) {}
}

async function loadNotifications() {
  try {
    const data = await api('/api/admin/notifications');
    updateNotifBadge(data.unread);
    renderNotifications(data.notifications);
    if (data.unread > 0) {
      await api('/api/admin/notifications/read', { method: 'POST', body: JSON.stringify({}) });
      updateNotifBadge(0);
    }
  } catch (err) {
    console.error('Notifications error:', err);
  }
}

function updateNotifBadge(count) {
  const badge = document.getElementById('notif-badge');
  const tabBadge = document.getElementById('notif-tab-badge');
  if (count > 0) {
    const label = count > 99 ? '99+' : String(count);
    badge.textContent = label;
    badge.classList.remove('hidden');
    tabBadge.textContent = label;
    tabBadge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    tabBadge.classList.add('hidden');
  }
}

function renderNotifications(list) {
  const el = document.getElementById('notif-list');
  if (!list || !list.length) {
    el.innerHTML = '<div class="py-12 text-center"><p class="text-sm dark:text-gray-500 text-gray-400">No notifications yet. Alerts will appear here automatically.</p></div>';
    return;
  }
  const iconMap = {
    copy_paste: `<svg class="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>`,
    error: `<svg class="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
    warn: `<svg class="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
    info: `<svg class="w-5 h-5 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  };
  const labelMap = { copy_paste: 'Copy-Paste Detected', error: 'Error', warn: 'Warning', info: 'Info' };
  el.innerHTML = list.map(n => {
    const timeStr = formatNotifTime(new Date(n.timestamp));
    return `<div class="notif-item${n.read ? '' : ' notif-unread'}">
      <div class="notif-dot"></div>
      <div style="width:22px;flex-shrink:0;padding-top:1px">${iconMap[n.type] || iconMap.info}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <p class="text-xs font-bold dark:text-gray-200 text-gray-700">${labelMap[n.type] || n.type}${n.tenant_name ? ` — ${escapeHtml(n.tenant_name)}` : ''}</p>
          <span class="text-[10px] dark:text-gray-600 text-gray-400 flex-shrink-0">${timeStr}</span>
        </div>
        <p class="text-xs dark:text-gray-400 text-gray-600 mt-0.5" style="line-height:1.5">${escapeHtml(n.message)}</p>
      </div>
    </div>`;
  }).join('');
}

function formatNotifTime(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

async function markAllNotifRead() {
  try {
    await api('/api/admin/notifications/read', { method: 'POST', body: JSON.stringify({}) });
    updateNotifBadge(0);
    document.querySelectorAll('.notif-item.notif-unread').forEach(el => el.classList.remove('notif-unread'));
    toast('All notifications marked as read', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function clearAllNotifs() {
  if (!confirm('Clear all notifications?')) return;
  try {
    await api('/api/admin/notifications', { method: 'DELETE' });
    renderNotifications([]);
    updateNotifBadge(0);
    toast('Notifications cleared', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Logout ──────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout?role=admin', { method: 'POST' });
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
