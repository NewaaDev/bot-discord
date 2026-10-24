const express = require('express');
const session = require('express-session');
const path = require('path');
const { PermissionFlagsBits, ChannelType } = require('discord.js');

const store = require('./store');
const { client, applyPresence, panelMessage, parseTopic, closeTicket, formatUptime } = require('./bot');

const multer = require('multer');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `ticket-${req.params.guildId}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format image non autorisé'));
    }

    cb(null, true);
  },
});

const app = express();

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-moi',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 86400000, httpOnly: true, sameSite: 'lax' },
}));

function redirectUri(req) {
  const configured = process.env.BASE_URL?.trim().replace(/\/$/, '');
  // Une ancienne valeur localhost ne doit jamais renvoyer un visiteur distant
  // vers son propre ordinateur. Dans ce cas, on reprend l'adresse réellement
  // utilisée pour ouvrir le panel.
  const base = configured && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(configured)
    ? configured
    : `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/callback`;
}

// ─────────────────────────────────────────────
//  AUTHENTIFICATION DISCORD (OAuth2)
// ─────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'identify guilds',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?erreur=code_manquant');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(req),
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) return res.redirect('/?erreur=token_refuse');

    const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
    const user = await (await fetch('https://discord.com/api/users/@me', auth)).json();
    const guilds = await (await fetch('https://discord.com/api/users/@me/guilds', auth)).json();
    if (!Array.isArray(guilds)) return res.redirect('/?erreur=serveur');

    // On ne garde que les serveurs où le membre peut gérer le serveur
    // ET où le bot est effectivement présent.
    const accessibles = guilds
      .filter(g => (BigInt(g.permissions) & PermissionFlagsBits.ManageGuild) !== 0n)
      .filter(g => client.guilds.cache.has(g.id))
      .map(g => g.id);

    if (!accessibles.length) return res.redirect('/?erreur=acces_refuse');

    req.session.user = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : 'https://cdn.discordapp.com/embed/avatars/0.png',
    };
    req.session.guilds = accessibles;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth :', err.message);
    res.redirect('/?erreur=serveur');
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ erreur: 'Connexion requise' });
  next();
}

// Vérifie que le serveur demandé fait partie de ceux autorisés pour cette session
function requireGuild(req, res, next) {
  if (!req.session.user) return res.status(401).json({ erreur: 'Connexion requise' });

  const id = req.params.guildId;
  if (!req.session.guilds || !req.session.guilds.includes(id)) {
    return res.status(403).json({ erreur: "Tu n'as pas accès à ce serveur" });
  }

  req.guild = client.guilds.cache.get(id);
  if (!req.guild) return res.status(503).json({ erreur: "Le bot n'est plus sur ce serveur" });
  next();
}

// ─────────────────────────────────────────────
//  SESSION & LISTE DES SERVEURS
// ─────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });

  const guilds = (req.session.guilds || [])
    .map(id => client.guilds.cache.get(id))
    .filter(Boolean)
    .map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 64 }),
      memberCount: g.memberCount,
    }));

  res.json({ user: req.session.user, guilds });
});

// ─────────────────────────────────────────────
//  DONNÉES D'UN SERVEUR
// ─────────────────────────────────────────────
app.get('/api/g/:guildId', requireGuild, (req, res) => {
  const g = req.guild;
  const me = g.members.me;

  res.json({
    id: g.id,
    name: g.name,
    icon: g.iconURL({ size: 128 }),
    memberCount: g.memberCount,
    // Sert à prévenir dans l'interface si le bot est mal placé
    botRolePosition: me.roles.highest.position,
    highestRolePosition: g.roles.cache
      .filter(r => r.id !== g.id && !r.managed)
      .reduce((max, r) => Math.max(max, r.position), 0),
    hasAdmin: me.permissions.has(PermissionFlagsBits.Administrator),
    textChannels: g.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => {
        const permissions = c.permissionsFor(me);
        return { id: c.id, name: c.name, welcomePermissions: {
          viewChannel: permissions?.has(PermissionFlagsBits.ViewChannel) || false,
          sendMessages: permissions?.has(PermissionFlagsBits.SendMessages) || false,
          embedLinks: permissions?.has(PermissionFlagsBits.EmbedLinks) || false,
        }};
      }),
    categories: g.channels.cache
      .filter(c => c.type === ChannelType.GuildCategory)
      .map(c => ({ id: c.id, name: c.name })),
    botPermissions: { manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles) },
    roles: g.roles.cache
      .filter(r => r.id !== g.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position,
        assignable: me.permissions.has(PermissionFlagsBits.ManageRoles) && r.position < me.roles.highest.position })),
  });
});

app.get('/api/g/:guildId/config', requireGuild, (req, res) => res.json(store.get(req.params.guildId)));

app.put('/api/g/:guildId/config', requireGuild, (req, res) => {
  const welcome = req.body?.welcome;
  if (welcome) {
    const channel = welcome.channelId && req.guild.channels.cache.get(welcome.channelId);
    const role = welcome.roleId && req.guild.roles.cache.get(welcome.roleId);
    if (welcome.enabled && !channel?.isTextBased()) return res.status(400).json({ erreur: 'Choisis un salon de bienvenue valide.' });
    if (welcome.roleId && (!role || role.managed)) return res.status(400).json({ erreur: 'Choisis un rôle de bienvenue valide.' });
    if (welcome.embed?.color && !/^#[0-9a-f]{6}$/i.test(welcome.embed.color)) return res.status(400).json({ erreur: "La couleur de l'embed doit être au format #RRGGBB." });
  }
  res.json(store.set(req.params.guildId, req.body));
});

app.post('/api/g/:guildId/config/reset', requireGuild, (req, res) => {
  res.json(store.reset(req.params.guildId));
});

// Copie la configuration d'un serveur vers un autre
app.post('/api/g/:guildId/config/copy', requireGuild, (req, res) => {
  const source = req.body.from;
  if (!req.session.guilds || !req.session.guilds.includes(source)) {
    return res.status(403).json({ erreur: 'Serveur source inaccessible' });
  }

  // Les identifiants de salons et de rôles ne valent que sur leur serveur
  const src = store.get(source);
  const copie = {
    welcome: { ...src.welcome, channelId: null, roleId: null, enabled: false },
    ticket: { ...src.ticket, categoryId: null, staffRoleId: null, logChannelId: null },
    appearance: { ...src.appearance },
    moderation: { ...src.moderation, logChannelId: null },
  };

  res.json(store.set(req.params.guildId, copie));
});

// ─────────────────────────────────────────────
//  PRÉSENCE (réglage global du bot)
// ─────────────────────────────────────────────
app.get('/api/global', requireAuth, (req, res) => res.json(store.getGlobal()));

app.put('/api/global', requireAuth, (req, res) => {
  const config = store.setGlobal(req.body);
  applyPresence();
  res.json(config);
});

// ─────────────────────────────────────────────
//  STATUT
// ─────────────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    online: client.isReady(),
    ping: client.ws.ping,
    uptime: client.uptime,
    uptimeText: formatUptime(client.uptime || 0),
    memory: Math.round(process.memoryUsage().heapUsed / 1048576),
    guildCount: client.guilds.cache.size,
    tag: client.user ? client.user.tag : null,
  });
});

// ─────────────────────────────────────────────
//  TICKETS
// ─────────────────────────────────────────────
app.get('/api/g/:guildId/tickets', requireGuild, (req, res) => {
  const g = req.guild;

  const tickets = [...g.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildText && parseTopic(c.topic))
    .map(c => {
      const t = parseTopic(c.topic);
      const member = g.members.cache.get(t.userId);
      return {
        id: c.id,
        name: c.name,
        type: t.typeId,
        createdAt: c.createdTimestamp,
        claimed: c.name.startsWith('✋'),
        user: member ? member.user.username : t.userId,
        avatar: member ? member.user.displayAvatarURL({ size: 64 }) : null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json(tickets);
});

app.post('/api/g/:guildId/tickets/:id/close', requireGuild, async (req, res) => {
  const channel = req.guild.channels.cache.get(req.params.id);
  if (!channel) return res.status(404).json({ erreur: 'Ticket introuvable' });

  await channel.send('🔒 Ticket fermé depuis le panneau de contrôle.').catch(() => {});
  await closeTicket(channel, { toString: () => req.session.user.username });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  PANNEAU
// ─────────────────────────────────────────────
app.post('/api/g/:guildId/panel/send', requireGuild, async (req, res) => {
  const channel = req.guild.channels.cache.get(req.body.channelId);
  if (!channel) return res.status(404).json({ erreur: 'Salon introuvable' });

  try {
    await channel.send(panelMessage(req.params.guildId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.post(
  '/api/g/:guildId/ticket-image',
  requireGuild,
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erreur: 'Aucune image envoyée' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;

    const config = store.set(req.params.guildId, {
      ticket: {
        panelImage: imageUrl,
      },
    });

    res.json({
      ok: true,
      imageUrl,
      config,
    });
  }
);
module.exports = app;
