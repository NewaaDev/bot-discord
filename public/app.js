// ─────────────────────────────────────────────
//  ÉTAT
// ─────────────────────────────────────────────
let guildId = null;   // serveur sélectionné
let guilds = [];      // serveurs accessibles
let guild = null;     // détails du serveur sélectionné
let config = null;    // config enregistrée (serveur)
let draft = null;     // config en cours d'édition (serveur)
let global = null;    // présence du bot (enregistrée)
let globalDraft = null;
const pings = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const clone = (o) => JSON.parse(JSON.stringify(o));

const get = (obj, path) => path.split('.').reduce((a, k) => (a ? a[k] : undefined), obj);
const set = (obj, path, val) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => (a[k] = a[k] || {}), obj)[last] = val;
};

// Les chemins commençant par "bot." visent la présence, qui est globale
const isGlobal = (path) => path.startsWith('bot.');
const target = (path) => (isGlobal(path) ? globalDraft : draft);

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.erreur || `Erreur ${res.status}`);
  }
  return res.json();
}

const g = (suffix = '') => `/api/g/${guildId}${suffix}`;

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ─────────────────────────────────────────────
//  DÉMARRAGE
// ─────────────────────────────────────────────
const ERREURS = {
  acces_refuse: "Aucun serveur accessible. Il faut la permission « Gérer le serveur » sur un serveur où le bot est présent.",
  token_refuse: 'Discord a refusé la connexion. Vérifie le CLIENT_SECRET.',
  code_manquant: 'Connexion interrompue. Réessaye.',
  serveur: 'Le serveur a rencontré une erreur.',
};

(async function init() {
  const erreur = new URLSearchParams(location.search).get('erreur');
  const me = await api('/api/me');

  if (!me.user) {
    $('#login').classList.remove('hidden');
    if (erreur) {
      $('#login-error').textContent = ERREURS[erreur] || 'Connexion impossible.';
      $('#login-error').classList.remove('hidden');
    }
    return;
  }

  history.replaceState({}, '', '/');
  $('#app').classList.remove('hidden');
  $('#me-avatar').src = me.user.avatar;
  $('#me-name').textContent = me.user.username;

  guilds = me.guilds;
  guildId = localStorage.getItem('guildId');
  if (!guilds.some(x => x.id === guildId)) guildId = guilds[0].id;

  // Le sélecteur ne sert à rien s'il n'y a qu'un serveur
  if (guilds.length > 1) {
    $('#switcher').classList.remove('hidden');
    $('#guild-select').innerHTML = guilds
      .map(x => `<option value="${x.id}">${x.name}</option>`).join('');
    $('#guild-select').value = guildId;
    $('#guild-select').addEventListener('change', (e) => switchGuild(e.target.value));

    $('#copy-card').classList.remove('hidden');
  }

  globalDraft = clone(global = await api('/api/global'));
  await loadGuild();

  tick();
  setInterval(tick, 3000);
  setInterval(loadTickets, 15000);
})();

async function switchGuild(id) {
  if (dirty()) {
    if (!confirm('Des modifications ne sont pas enregistrées. Changer de serveur les perdra.')) {
      $('#guild-select').value = guildId;
      return;
    }
  }
  guildId = id;
  localStorage.setItem('guildId', id);
  await loadGuild();
  toast(`Serveur : ${guild.name}`);
}

async function loadGuild() {
  [guild, config] = await Promise.all([api(g()), api(g('/config'))]);
  draft = clone(config);

  $('#guild-name').textContent = guild.name;
  $('#guild-members').textContent = `${guild.memberCount} membres`;

  // Prévient si le bot ne pourra pas sanctionner
  $('#hierarchy-alert').classList.toggle(
    'hidden', guild.botRolePosition > guild.highestRolePosition,
  );

  if (guilds.length > 1) {
    $('#copy-from').innerHTML = '<option value="">Choisir un serveur…</option>' +
      guilds.filter(x => x.id !== guildId)
        .map(x => `<option value="${x.id}">${x.name}</option>`).join('');
  }

  fillSelects();
  bindFields();
  renderTypes();
  renderPreview();
  markDirty();
  loadTickets();
}

// ─────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
  $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== btn.dataset.view));
}));

// ─────────────────────────────────────────────
//  LISTES DÉROULANTES
// ─────────────────────────────────────────────
function options(select, items, vide) {
  select.innerHTML = `<option value="">${vide}</option>` +
    items.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
}

function fillSelects() {
  options($('#w-channel'), guild.textChannels, 'Choisir un salon…');
  options($('#w-role'), guild.roles, 'Ne pas attribuer de rôle');
  options($('#t-category'), guild.categories, 'Aucune (racine du serveur)');
  options($('#t-staff'), guild.roles, 'Aucun rôle');
  options($('#t-log'), guild.textChannels, 'Ne rien enregistrer');
  options($('#m-log'), guild.textChannels, 'Ne rien enregistrer');
  options($('#panel-channel'), guild.textChannels, 'Choisir un salon…');
}

// ─────────────────────────────────────────────
//  LIAISON CHAMPS ↔ BROUILLON
// ─────────────────────────────────────────────
function bindFields() {
  $$('[data-path]').forEach(el => {
    const path = el.dataset.path;
    const val = get(target(path), path);

    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val === null || val === undefined ? '' : val;

    if (el._bound) return;
    el._bound = true;

    el.addEventListener('input', () => {
      const p = el.dataset.path;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.tagName === 'SELECT' && v === '') v = null;
      if (p === 'bot.activityType') v = Number(v);
      set(target(p), p, v);

      if (p === 'appearance.color') $('#a-color-hex').value = v;
      renderPreview();
      markDirty();
    });
  });

  $('#a-color-hex').value = draft.appearance.color;
}

$('#a-color-hex').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    $('#a-color').value = v;
    draft.appearance.color = v;
    renderPreview();
    markDirty();
  }
});

const dirty = () =>
  JSON.stringify(draft) !== JSON.stringify(config) ||
  JSON.stringify(globalDraft) !== JSON.stringify(global);

function markDirty() {
  $('#savebar').classList.toggle('hidden', !dirty());
}

// ─────────────────────────────────────────────
//  CATÉGORIES DE TICKETS
// ─────────────────────────────────────────────
function renderTypes() {
  const box = $('#types');
  box.innerHTML = '';

  draft.ticket.types.forEach((type, i) => {
    const row = document.createElement('div');
    row.className = 'type-row';
    row.innerHTML = `
      <input value="${type.emoji || ''}" placeholder="🎫" aria-label="Emoji">
      <input value="${type.label || ''}" placeholder="Nom" aria-label="Nom">
      <input value="${type.description || ''}" placeholder="Description" aria-label="Description">
      <button class="type-del" title="Supprimer">×</button>`;

    const [emoji, label, desc] = row.querySelectorAll('input');
    emoji.addEventListener('input', () => { type.emoji = emoji.value; markDirty(); });
    desc.addEventListener('input', () => { type.description = desc.value; markDirty(); });
    label.addEventListener('input', () => {
      type.label = label.value;
      // L'identifiant sert au nom du salon : on le dérive du libellé
      type.id = label.value.toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '').slice(0, 20) || `type-${i}`;
      markDirty();
    });

    row.querySelector('.type-del').addEventListener('click', () => {
      if (draft.ticket.types.length === 1) return toast('Il faut au moins une catégorie.', true);
      draft.ticket.types.splice(i, 1);
      renderTypes(); markDirty();
    });

    box.appendChild(row);
  });
}

$('#add-type').addEventListener('click', () => {
  if (draft.ticket.types.length >= 25) return toast('Discord limite le menu à 25 choix.', true);
  draft.ticket.types.push({ id: `type-${Date.now()}`, label: 'Nouvelle catégorie', emoji: '🎫', description: '' });
  renderTypes(); markDirty();
});

// ─────────────────────────────────────────────
//  IMAGE DU PANNEAU
// ─────────────────────────────────────────────
const imageDrop = $('#ticket-image-drop');
const imageInput = $('#ticket-image-input');
const imagePreviewWrap = $('#ticket-image-preview-wrap');
const imagePreview = $('#ticket-image-preview');
const imageRemove = $('#ticket-image-remove');

imageDrop.addEventListener('click', () => {
  imageInput.click();
});

imageDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  imageDrop.classList.add('dragover');
});

imageDrop.addEventListener('dragleave', () => {
  imageDrop.classList.remove('dragover');
});

imageDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  imageDrop.classList.remove('dragover');

  const file = e.dataTransfer.files[0];
  if (file) uploadTicketImage(file);
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (file) uploadTicketImage(file);
});

async function uploadTicketImage(file) {
  if (!file.type.startsWith('image/')) {
    return toast('Le fichier doit être une image.', true);
  }

  if (file.size > 5 * 1024 * 1024) {
    return toast('Image trop lourde. Maximum 5 Mo.', true);
  }

  const form = new FormData();
  form.append('image', file);

  try {
    const res = await fetch(g('/ticket-image'), {
      method: 'POST',
      body: form,
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.erreur || `Erreur ${res.status}`);
    }

    draft.ticket.panelImage = data.imageUrl;
    config.ticket.panelImage = data.imageUrl;

    imagePreview.src = data.imageUrl;
    imagePreviewWrap.classList.remove('hidden');

    renderPreview();
    toast('Image envoyée');
  } catch (e) {
    toast(e.message, true);
  }

  imageInput.value = '';
}

imageRemove.addEventListener('click', () => {
  draft.ticket.panelImage = null;

  imagePreview.src = '';
  imagePreviewWrap.classList.add('hidden');

  renderPreview();
  markDirty();
});

// ─────────────────────────────────────────────
//  APERÇU
// ─────────────────────────────────────────────
function renderPreview() {
  $('#pv-embed').style.borderLeftColor = draft.appearance.color;
  $('#pv-title').textContent = draft.ticket.panelTitle || '—';
  $('#pv-desc').textContent = draft.ticket.panelDescription || '—';
  $('#pv-footer').textContent = draft.appearance.footer || '';
  $('#pv-select').textContent = draft.ticket.placeholder || '—';

  const sample = (text) => String(text || '').replace(/\{(user|username|server|memberCount)\}/g, (_, key) => ({
    user: '@Nouveau membre', username: 'Nouveau membre', server: guild.name,
    memberCount: String(guild.memberCount + 1),
  })[key]);
  $('#w-pv-message').textContent = sample(draft.welcome.message);
  $('#w-pv-embed').classList.toggle('hidden', !draft.welcome.embed.enabled);
  $('#w-pv-embed').style.borderLeftColor = draft.welcome.embed.color;
  $('#w-pv-title').textContent = sample(draft.welcome.embed.title);
  $('#w-pv-desc').textContent = sample(draft.welcome.embed.description);
  $('#w-pv-avatar').classList.toggle('hidden', draft.welcome.embed.thumbnail !== 'avatar');

  const role = guild.roles.find(r => r.id === draft.welcome.roleId);
  const channel = guild.textChannels.find(c => c.id === draft.welcome.channelId);
  const warnings = [];
  if (draft.welcome.enabled && !draft.welcome.channelId) warnings.push('Choisis un salon de bienvenue.');
  if (channel && (!channel.welcomePermissions.viewChannel || !channel.welcomePermissions.sendMessages)) warnings.push('Le bot doit pouvoir voir ce salon et y envoyer des messages.');
  if (channel && draft.welcome.embed.enabled && !channel.welcomePermissions.embedLinks) warnings.push('La permission Intégrer des liens manque dans ce salon.');
  if (role && !role.assignable) warnings.push('Ce rôle est trop haut : place le rôle du bot au-dessus.');
  if (!guild.botPermissions.manageRoles && draft.welcome.roleId) warnings.push('La permission Gérer les rôles manque au bot.');
  $('#welcome-alert').textContent = warnings.join(' ');
  $('#welcome-alert').classList.toggle('hidden', !warnings.length);

  let pvImage = $('#pv-image');

  if (!pvImage) {
    pvImage = document.createElement('img');
    pvImage.id = 'pv-image';
    pvImage.style.width = '100%';
    pvImage.style.marginTop = '10px';
    pvImage.style.borderRadius = '6px';
    $('#pv-desc').after(pvImage);
  }

  if (draft.ticket.panelImage) {
    pvImage.src = draft.ticket.panelImage;
    pvImage.classList.remove('hidden');

    imagePreview.src = draft.ticket.panelImage;
    imagePreviewWrap.classList.remove('hidden');
  } else {
    pvImage.src = '';
    pvImage.classList.add('hidden');
    imagePreviewWrap.classList.add('hidden');
  }
}
// ─────────────────────────────────────────────
//  ENREGISTREMENT
// ─────────────────────────────────────────────
$('#save').addEventListener('click', async () => {
  try {
    if (JSON.stringify(draft) !== JSON.stringify(config)) {
      config = await api(g('/config'), { method: 'PUT', body: JSON.stringify(draft) });
      draft = clone(config);
    }
    if (JSON.stringify(globalDraft) !== JSON.stringify(global)) {
      global = await api('/api/global', { method: 'PUT', body: JSON.stringify(globalDraft) });
      globalDraft = clone(global);
    }
    markDirty();
    toast('Modifications enregistrées');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#discard').addEventListener('click', () => {
  draft = clone(config);
  globalDraft = clone(global);
  bindFields(); renderTypes(); renderPreview(); markDirty();
});

$('#copy-btn').addEventListener('click', async () => {
  const from = $('#copy-from').value;
  if (!from) return toast('Choisis un serveur source.', true);
  try {
    config = await api(g('/config/copy'), { method: 'POST', body: JSON.stringify({ from }) });
    draft = clone(config);
    bindFields(); renderTypes(); renderPreview(); markDirty();
    toast('Configuration copiée. Reste à choisir la catégorie et le rôle.');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#send-panel').addEventListener('click', async () => {
  const channelId = $('#panel-channel').value;
  if (!channelId) return toast('Choisis un salon.', true);
  try {
    await api(g('/panel/send'), { method: 'POST', body: JSON.stringify({ channelId }) });
    toast('Panneau envoyé');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.reload();
});

// ─────────────────────────────────────────────
//  TICKETS OUVERTS
// ─────────────────────────────────────────────
async function loadTickets() {
  if (!guildId) return;
  let tickets = [];
  try { tickets = await api(g('/tickets')); } catch { return; }

  const box = $('#tickets-list');
  if (!tickets.length) {
    box.innerHTML = `<div class="empty">Aucun ticket ouvert.<br>Publie le panneau pour que les membres puissent en créer un.</div>`;
    return;
  }

  box.innerHTML = '';
  tickets.forEach(t => {
    const el = document.createElement('div');
    el.className = 'ticket';
    el.innerHTML = `
      <img src="${t.avatar || ''}" alt="">
      <div class="ticket-body">
        <div class="ticket-name">${t.user}</div>
        <div class="ticket-meta">#${t.name} · ouvert ${ago(t.createdAt)}</div>
      </div>
      <span class="tag ${t.claimed ? 'claimed' : ''}">${t.claimed ? 'pris en charge' : t.type}</span>
      <button class="btn btn-ghost">Fermer</button>`;

    el.querySelector('button').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api(g(`/tickets/${t.id}/close`), { method: 'POST' });
        toast('Ticket fermé');
        setTimeout(loadTickets, 6000);
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    });

    box.appendChild(el);
  });
}

function ago(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

// ─────────────────────────────────────────────
//  TÉLÉMÉTRIE
// ─────────────────────────────────────────────
async function tick() {
  let s;
  try {
    s = await api('/api/status');
  } catch {
    $('#dot').className = 'dot down';
    $('#tele-state').textContent = 'Hors ligne';
    return;
  }

  $('#dot').className = `dot ${s.online ? 'live' : 'down'}`;
  $('#tele-state').textContent = s.online
    ? `En ligne · ${s.guildCount} serveur${s.guildCount > 1 ? 's' : ''}`
    : 'Hors ligne';
  $('#tele-ping').textContent = s.ping < 0 ? '—' : s.ping;
  $('#tele-uptime').textContent = s.uptimeText;
  $('#tele-ram').textContent = s.memory;

  pings.push(Math.max(0, s.ping));
  if (pings.length > 60) pings.shift();
  drawSpark();
}

function drawSpark() {
  const canvas = $('#spark');
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;

  canvas.width = w * ratio;
  canvas.height = h * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (pings.length < 2) return;

  const max = Math.max(...pings, 100);
  const x = i => (i / (pings.length - 1)) * w;
  const y = v => h - 3 - (v / max) * (h - 8);

  ctx.beginPath();
  ctx.moveTo(0, h);
  pings.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(224,30,55,.28)');
  grad.addColorStop(1, 'rgba(224,30,55,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pings.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#E01E37';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
