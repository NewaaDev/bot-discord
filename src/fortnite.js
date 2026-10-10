const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('./store');

const API = 'https://prod.api-fortnite.com/api';
const STATE_FILE = process.env.FORTNITE_STATE_FILE || path.join(__dirname, '..', 'fortnite-state.json');
const ACCOUNTS_FILE = process.env.FORTNITE_ACCOUNTS_FILE || path.join(__dirname, '..', 'fortnite-accounts.json');
const POLL_MS = Math.max(60_000, Number(process.env.FORTNITE_POLL_MS) || 5 * 60_000);
let timer = null;
let running = false;

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function key() {
  const secret = process.env.FORTNITE_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret) throw new Error('FORTNITE_ENCRYPTION_KEY ou SESSION_SECRET manque');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(value) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}

function apiConfigured() { return Boolean(process.env.FORTNITE_API_KEY?.trim()); }

async function api(pathname, options = {}) {
  if (!apiConfigured()) throw new Error('FORTNITE_API_KEY manque sur OnePanel');
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      'x-api-key': process.env.FORTNITE_API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.detail || body.message || body.error || `API Fortnite ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function discordTime(value, style = 'F') {
  return `<t:${Math.floor(new Date(value).getTime() / 1000)}:${style}>`;
}

function flattenEvents(payload, region) {
  const groups = Array.isArray(payload) ? payload : payload.events || payload.data || [];
  const out = [];
  for (const group of groups) {
    const regionEvents = group.regions?.[region] || group.regions?.[region.toLowerCase()] || [];
    for (const event of regionEvents) {
      for (const window of event.eventWindows || []) {
        out.push({
          groupId: group.id || group.displayDataId,
          eventId: event.eventId,
          windowId: window.eventWindowId,
          name: group.name || group.shortTitle || group.titleLine1 || event.eventId,
          description: group.description || group.detailsDescription || '',
          poster: group.poster || group.loadingScreen || null,
          link: event.link || `https://www.fortnite.com/competitive/events/${encodeURIComponent(group.id || event.eventId)}?region=${region}`,
          region,
          round: window.round,
          beginTime: window.beginTime,
          endTime: window.endTime,
        });
      }
    }
  }
  return out.filter(x => x.eventId && x.windowId && x.beginTime && x.endTime);
}

function color(guildId) { return store.get(guildId).appearance.color || '#5865F2'; }

function upcomingEmbed(guildId, event, reminder = false) {
  const embed = new EmbedBuilder()
    .setColor(color(guildId))
    .setTitle(`${reminder ? '⏰ Ça commence bientôt' : '🏆 Nouvelle cup Fortnite'} — ${event.name}`)
    .setURL(event.link)
    .setDescription(event.description.slice(0, 1200) || 'Une nouvelle session compétitive est programmée.')
    .addFields(
      { name: 'Région', value: event.region, inline: true },
      { name: 'Début', value: discordTime(event.beginTime), inline: true },
      { name: 'Fin', value: discordTime(event.endTime), inline: true },
    )
    .setFooter({ text: 'FAYZEN • Horaires adaptés automatiquement à ton fuseau' });
  if (event.poster) embed.setThumbnail(event.poster);
  return embed;
}

function leaderboardEntries(body) {
  return body.entries || body.results || body.data?.entries || body.data || [];
}

function entryNames(entry) {
  const players = entry.teamAccountNames || entry.displayNames || entry.players || entry.teamAccounts || [];
  if (Array.isArray(players)) return players.map(p => typeof p === 'string' ? p : p.displayName || p.name).filter(Boolean).join(' / ');
  return entry.displayName || entry.teamName || 'Joueur inconnu';
}

function entryPoints(entry) {
  return entry.pointsEarned ?? entry.points ?? entry.score ?? entry.trackedStats?.points ?? entry.trackedStats?.SCORE ?? 0;
}

async function send(channel, payload) {
  if (!channel?.isTextBased()) return false;
  const me = channel.guild.members.me;
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return false;
  await channel.send(payload);
  return true;
}

async function publishResults(guild, event) {
  const cfg = store.get(guild.id).fortnite;
  const channel = guild.channels.cache.get(cfg.resultsChannelId);
  const result = await api(`/v2/events/${encodeURIComponent(event.eventId)}/windows/${encodeURIComponent(event.windowId)}/leaderboard?page=0${event.round ? `&round=${event.round}` : ''}`);
  const rows = leaderboardEntries(result).slice(0, Math.min(25, cfg.topCount || 10));
  if (!rows.length) throw new Error('classement pas encore publié');
  const description = rows.map((row, i) => {
    const rank = row.rank || row.placement || i + 1;
    return `**${rank}.** ${entryNames(row)} — **${entryPoints(row)} pts**`;
  }).join('\n');
  const embed = new EmbedBuilder()
    .setColor(color(guild.id))
    .setTitle(`🏆 Classement final — ${event.name}`)
    .setURL(event.link)
    .setDescription(description)
    .addFields({ name: 'Session terminée', value: discordTime(event.endTime), inline: true }, { name: 'Région', value: event.region, inline: true })
    .setFooter({ text: 'FAYZEN • Résultats compétitifs Fortnite' });
  return send(channel, { embeds: [embed] });
}

async function pollGuild(guild, state) {
  const cfg = store.get(guild.id).fortnite;
  if (!cfg.enabled || !cfg.upcomingChannelId || !cfg.resultsChannelId) return;
  const events = flattenEvents(await api(`/v1/events/global?lang=fr`), cfg.region || 'EU');
  const guildState = state[guild.id] ||= { windows: {} };
  const upcoming = guild.channels.cache.get(cfg.upcomingChannelId);
  const now = Date.now();

  for (const event of events) {
    const id = `${event.eventId}:${event.windowId}`;
    const item = guildState.windows[id] ||= { event };
    item.event = event;
    const mention = cfg.mentionRoleId ? `<@&${cfg.mentionRoleId}>` : '';
    if (!item.announced && new Date(event.endTime).getTime() > now) {
      if (await send(upcoming, { content: mention || undefined, embeds: [upcomingEmbed(guild.id, event)] })) item.announced = new Date().toISOString();
    }
    const reminderAt = new Date(event.beginTime).getTime() - (cfg.reminderMinutes || 15) * 60_000;
    if (!item.reminded && now >= reminderAt && now < new Date(event.beginTime).getTime()) {
      if (await send(upcoming, { content: mention || undefined, embeds: [upcomingEmbed(guild.id, event, true)] })) item.reminded = new Date().toISOString();
    }
  }

  for (const item of Object.values(guildState.windows)) {
    if (!item.results && now >= new Date(item.event.endTime).getTime() + 5 * 60_000) {
      try { if (await publishResults(guild, item.event)) item.results = new Date().toISOString(); }
      catch (err) { item.lastResultError = err.message; }
    }
  }
}

async function poll(client) {
  if (running || !apiConfigured()) return;
  running = true;
  const state = readJson(STATE_FILE, {});
  try {
    for (const guild of client.guilds.cache.values()) {
      await pollGuild(guild, state).catch(err => console.error(`[Fortnite] ${guild.name} : ${err.message}`));
    }
    writeJson(STATE_FILE, state);
  } finally { running = false; }
}

function start(client) {
  if (timer) return;
  if (!apiConfigured()) return console.warn('⚠️ Fortnite désactivé : FORTNITE_API_KEY manque');
  poll(client);
  timer = setInterval(() => poll(client), POLL_MS);
  timer.unref?.();
  console.log(`✅ Surveillance Fortnite active (${Math.round(POLL_MS / 60000)} min)`);
}

async function beginEpicLink() { return api('/v1/oauth/get-token'); }
async function completeEpicLink(flowId) { return api('/v1/oauth/complete', { method: 'POST', body: JSON.stringify({ flowId }) }); }

function saveEpicAccount(guildId, discordId, response) {
  const token = response.accessToken || response.access_token || response.token;
  const deviceAuth = response.deviceAuth || response.device_auth;
  const accountId = response.accountId || response.account_id || deviceAuth?.accountId;
  const displayName = response.displayName || response.display_name || response.account?.displayName || 'Compte Epic';
  if (!token || !accountId) throw new Error('Réponse Epic incomplète');
  const all = readJson(ACCOUNTS_FILE, {});
  all[guildId] ||= {};
  all[guildId][discordId] = {
    accountId, displayName, linkedAt: new Date().toISOString(),
    secure: encrypt({ token, deviceAuth }),
  };
  writeJson(ACCOUNTS_FILE, all);
  return { accountId, displayName };
}

function getEpicAccount(guildId, discordId) {
  const row = readJson(ACCOUNTS_FILE, {})[guildId]?.[discordId];
  if (!row) return null;
  return { ...row, ...decrypt(row.secure) };
}

function unlinkEpic(guildId, discordId) {
  const all = readJson(ACCOUNTS_FILE, {});
  if (!all[guildId]?.[discordId]) return false;
  delete all[guildId][discordId];
  writeJson(ACCOUNTS_FILE, all);
  return true;
}

async function playerRanking(account) {
  try {
    return await api(`/v1/events/powerrankings/player/${encodeURIComponent(account.accountId)}`, { headers: { 'x-fortnite-token': account.token } });
  } catch (err) {
    if (err.status !== 401 || !account.deviceAuth) throw err;
    const refreshed = await api('/v1/oauth/refresh-device', { method: 'POST', body: JSON.stringify(account.deviceAuth) });
    account.token = refreshed.accessToken || refreshed.access_token || refreshed.token;
    return api(`/v1/events/powerrankings/player/${encodeURIComponent(account.accountId)}`, { headers: { 'x-fortnite-token': account.token } });
  }
}

async function publishPlayerRanking(guild, discordId) {
  const account = getEpicAccount(guild.id, discordId);
  if (!account) throw new Error('Aucun compte Epic lié');
  const ranking = await playerRanking(account);
  const data = ranking.playerEntry || ranking.entry || ranking.data || ranking;
  const rank = data.rank ?? data.placement;
  const score = data.score ?? data.pointsEarned ?? data.trackedStats?.PR ?? 0;
  const channel = guild.channels.cache.get(store.get(guild.id).fortnite.playerChannelId);
  if (!channel) throw new Error('Salon des classements personnels introuvable');
  const embed = new EmbedBuilder().setColor(color(guild.id)).setTitle(`🎯 Classement de ${account.displayName}`)
    .setDescription(rank ? `**Top ${Number(rank).toLocaleString('fr-FR')}** — **${Number(score).toLocaleString('fr-FR')} PR**` : 'Ce compte ne figure pas encore dans le Power Ranking.')
    .addFields({ name: 'Compte Discord', value: `<@${discordId}>`, inline: true }, { name: 'Compte Epic', value: account.displayName, inline: true })
    .setFooter({ text: 'FAYZEN • Power Ranking Fortnite' }).setTimestamp();
  await send(channel, { embeds: [embed] });
  return { rank: rank || null, score, displayName: account.displayName };
}

module.exports = {
  apiConfigured, start, poll, beginEpicLink, completeEpicLink, saveEpicAccount,
  getEpicAccount, unlinkEpic, publishPlayerRanking,
  __test: { flattenEvents, leaderboardEntries, entryNames, entryPoints },
};
