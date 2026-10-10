const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  welcome: {
    enabled: false, channelId: null, roleId: null,
    message: 'Bienvenue {user} sur **{server}** ! Tu es notre {memberCount}e membre.',
    embed: { enabled: true, title: 'Bienvenue {username} !', description: 'Nous sommes heureux de t’accueillir sur **{server}**.', color: '#E01E37', thumbnail: 'avatar' },
  },
  ticket: {
    categoryId: null,
    staffRoleId: null,
    logChannelId: null,
    panelTitle: '🎫 Support',
    panelDescription: "Choisis une catégorie ci-dessous pour ouvrir un ticket privé avec l'équipe.",
    panelImage: null,
    placeholder: 'Choisir une catégorie...',
    welcomeMessage: "Décris ton problème en détail, l'équipe arrive.",
    transcript: true,
    types: [
      { id: 'support', label: 'Support', emoji: '🛠️', description: 'Un bug, une question technique' },
      { id: 'plainte', label: 'Signalement', emoji: '🚨', description: 'Signaler un membre' },
      { id: 'candidature', label: 'Candidature', emoji: '📋', description: 'Rejoindre la structure' },
    ],
  },
  appearance: {
    color: '#E01E37',
    footer: 'Fayzen',
  },
  moderation: {
    dmOnSanction: true,
    logChannelId: null,
  },
  fortnite: {
    enabled: false,
    region: 'EU',
    upcomingChannelId: null,
    resultsChannelId: null,
    playerChannelId: null,
    mentionRoleId: null,
    reminderMinutes: 15,
    topCount: 10,
  },
  protection: {
    // userId du membre protégé -> liste des userId qu'il a bloqués dans Fayzen
    blocks: {},
  },
};

// La présence est un réglage du bot, pas du serveur : il n'en a qu'une
// pour tous les serveurs où il est présent.
const GLOBAL_DEFAULTS = {
  bot: {
    activityText: 'Fayzen Structure',
    activityType: 1,
    status: 'dnd',
  },
};

const GLOBAL_KEY = '_global';

// Fusion profonde : garantit que les nouvelles clés du code apparaissent
// dans les configs déjà enregistrées, sans écraser les valeurs existantes.
function merge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

let cache = {};

function load() {
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
}

function save() {
  // Écriture atomique : on écrit à côté puis on renomme, pour ne jamais
  // laisser un config.json à moitié écrit si le process meurt.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

load();

module.exports = {
  DEFAULTS,
  GLOBAL_DEFAULTS,

  get(guildId) {
    return merge(DEFAULTS, cache[guildId] || {});
  },

  set(guildId, patch) {
    cache[guildId] = merge(cache[guildId] || {}, patch);
    save();
    return this.get(guildId);
  },

  reset(guildId) {
    delete cache[guildId];
    save();
    return this.get(guildId);
  },

  getGlobal() {
    return merge(GLOBAL_DEFAULTS, cache[GLOBAL_KEY] || {});
  },

  setGlobal(patch) {
    cache[GLOBAL_KEY] = merge(cache[GLOBAL_KEY] || {}, patch);
    save();
    return this.getGlobal();
  },
};

