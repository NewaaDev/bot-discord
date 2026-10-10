const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const store = require('./store');

const STATE_FILE = process.env.FORTNITE_STATE_FILE || path.join(__dirname, '..', 'fortnite-state.json');
const ACCOUNTS_FILE = process.env.FORTNITE_ACCOUNTS_FILE || path.join(__dirname, '..', 'fortnite-accounts.json');
const POLL_MS = Math.max(60_000, Number(process.env.FORTNITE_POLL_MS) || 60_000);
let timer = null;
let running = false;

function readJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }

function cleanUsername(value) {
  const username = String(value || '').trim().replace(/\s+/g, ' ');
  if (username.length < 3 || username.length > 32) throw new Error('Le pseudo Epic doit contenir entre 3 et 32 caractères.');
  if (/[\r\n<>]/.test(username)) throw new Error('Pseudo Epic invalide.');
  return username;
}

const trackerProfileUrl = username => `https://fortnitetracker.com/fortnite/profile/epic/${encodeURIComponent(username)}/overview`;
const trackerEventsUrl = username => `https://fortnitetracker.com/fortnite/profile/epic/${encodeURIComponent(username)}/epic-events/overview`;
const trackerPowerRankingUrl = region => `https://fortnitetracker.com/events/powerrankings?platform=pc&region=${encodeURIComponent(region || 'EU')}&time=current`;

function saveEpicAccount(guildId, discordId, username) {
  const all = readJson(ACCOUNTS_FILE, {});
  all[guildId] ||= {};
  all[guildId][discordId] = { username: cleanUsername(username), linkedAt: new Date().toISOString() };
  writeJson(ACCOUNTS_FILE, all);
  return all[guildId][discordId];
}
function getEpicAccount(guildId, discordId) { return readJson(ACCOUNTS_FILE, {})[guildId]?.[discordId] || null; }
function unlinkEpic(guildId, discordId) {
  const all = readJson(ACCOUNTS_FILE, {});
  if (!all[guildId]?.[discordId]) return false;
  delete all[guildId][discordId]; writeJson(ACCOUNTS_FILE, all); return true;
}

const discordTime = (value, style = 'F') => `<t:${Math.floor(new Date(value).getTime() / 1000)}:${style}>`;
const color = guildId => store.get(guildId).appearance.color || '#5865F2';
function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['fortnitetracker.com', 'www.fortnitetracker.com'].includes(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

function normalizeEvent(body, guildId) {
  const name = String(body.name || '').trim().slice(0, 100);
  const beginTime = new Date(body.beginTime); const endTime = new Date(body.endTime);
  if (name.length < 3) throw new Error('Donne un nom à la cup.');
  if (!Number.isFinite(beginTime.getTime()) || !Number.isFinite(endTime.getTime()) || endTime <= beginTime) throw new Error('Les horaires de la cup sont invalides.');
  const cfg = store.get(guildId).fortnite;
  const requestedLink = String(body.link || '').trim();
  const link = requestedLink ? validUrl(requestedLink) : 'https://fortnitetracker.com/events/';
  if (!link) throw new Error('Utilise un lien https://fortnitetracker.com valide.');
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, beginTime: beginTime.toISOString(), endTime: endTime.toISOString(), region: body.region || cfg.region || 'EU', mode: String(body.mode || '').trim().slice(0, 80), link, createdAt: new Date().toISOString() };
}

async function send(channel, payload) {
  if (!channel?.isTextBased()) return false;
  const permissions = channel.permissionsFor(channel.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return false;
  await channel.send(payload); return true;
}

function trackerButton(url, label = 'Voir sur Fortnite Tracker') { return new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji('🏆').setURL(url)); }
function cupEmbed(guildId, event, reminder = false) {
  return new EmbedBuilder().setColor(color(guildId)).setTitle(`${reminder ? '⏰ La cup commence bientôt' : '🏆 Cup Fortnite'} — ${event.name}`).setURL(event.link)
    .setDescription(event.mode || 'Retrouve les informations et classements sur Fortnite Tracker.')
    .addFields({ name: 'Région', value: event.region, inline: true }, { name: 'Début', value: discordTime(event.beginTime), inline: true }, { name: 'Fin', value: discordTime(event.endTime), inline: true })
    .setFooter({ text: 'FAYZEN • Données gratuites via Fortnite Tracker' });
}

async function announceEvent(guild, event) {
  const cfg = store.get(guild.id).fortnite; const channel = guild.channels.cache.get(cfg.upcomingChannelId);
  const mention = cfg.mentionRoleId ? `<@&${cfg.mentionRoleId}>` : undefined;
  if (!await send(channel, { content: mention, embeds: [cupEmbed(guild.id, event)], components: [trackerButton(event.link)] })) throw new Error('Salon des cups inaccessible.');
}

function addEvent(guildId, body) {
  const state = readJson(STATE_FILE, {}); state[guildId] ||= { events: [] };
  const event = normalizeEvent(body, guildId); state[guildId].events.push(event); writeJson(STATE_FILE, state); return event;
}
function listEvents(guildId) { return (readJson(STATE_FILE, {})[guildId]?.events || []).sort((a, b) => new Date(a.beginTime) - new Date(b.beginTime)); }
function removeEvent(guildId, eventId) {
  const state = readJson(STATE_FILE, {}); const events = state[guildId]?.events || []; const next = events.filter(event => event.id !== eventId);
  if (next.length === events.length) return false; state[guildId].events = next; writeJson(STATE_FILE, state); return true;
}

async function pollGuild(guild, state) {
  const cfg = store.get(guild.id).fortnite; if (!cfg.enabled) return;
  const events = state[guild.id]?.events || []; const now = Date.now();
  for (const event of events) {
    const reminderAt = new Date(event.beginTime).getTime() - (cfg.reminderMinutes || 15) * 60_000;
    if (!event.remindedAt && now >= reminderAt && now < new Date(event.beginTime).getTime()) {
      const channel = guild.channels.cache.get(cfg.upcomingChannelId); const mention = cfg.mentionRoleId ? `<@&${cfg.mentionRoleId}>` : undefined;
      if (await send(channel, { content: mention, embeds: [cupEmbed(guild.id, event, true)], components: [trackerButton(event.link)] })) event.remindedAt = new Date().toISOString();
    }
    if (!event.finishedAt && now >= new Date(event.endTime).getTime()) {
      const channel = guild.channels.cache.get(cfg.resultsChannelId);
      const embed = new EmbedBuilder().setColor(color(guild.id)).setTitle(`🏆 Résultats disponibles — ${event.name}`).setURL(event.link)
        .setDescription('La session est terminée. Ouvre Fortnite Tracker pour consulter le classement complet et rechercher ton pseudo.')
        .addFields({ name: 'Région', value: event.region, inline: true }, { name: 'Fin', value: discordTime(event.endTime), inline: true }).setFooter({ text: 'FAYZEN • Résultats Fortnite Tracker' });
      if (await send(channel, { embeds: [embed], components: [trackerButton(event.link, 'Voir le classement')] })) event.finishedAt = new Date().toISOString();
    }
  }
}

async function poll(client) {
  if (running) return; running = true; const state = readJson(STATE_FILE, {});
  try { for (const guild of client.guilds.cache.values()) await pollGuild(guild, state).catch(err => console.error(`[Fortnite] ${guild.name} : ${err.message}`)); writeJson(STATE_FILE, state); }
  finally { running = false; }
}
function start(client) { if (timer) return; poll(client); timer = setInterval(() => poll(client), POLL_MS); timer.unref?.(); console.log('✅ Rappels Fortnite Tracker actifs (mode gratuit)'); }

async function publishPlayerLinks(guild, discordId) {
  const account = getEpicAccount(guild.id, discordId); if (!account) throw new Error('Enregistre d’abord ton pseudo Epic.');
  const cfg = store.get(guild.id).fortnite; const channel = guild.channels.cache.get(cfg.playerChannelId); if (!channel) throw new Error('Salon des classements personnels introuvable.');
  const embed = new EmbedBuilder().setColor(color(guild.id)).setTitle(`🎯 Profil compétitif de ${account.username}`).setURL(trackerEventsUrl(account.username))
    .setDescription('Consulte le Power Ranking, les cups jouées, les placements et les points de ce joueur sur Fortnite Tracker.')
    .addFields({ name: 'Compte Discord', value: `<@${discordId}>`, inline: true }, { name: 'Pseudo Epic', value: account.username, inline: true }).setFooter({ text: 'FAYZEN • Liens gratuits Fortnite Tracker' }).setTimestamp();
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Résultats du joueur').setURL(trackerEventsUrl(account.username)),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Profil Tracker').setURL(trackerProfileUrl(account.username)),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Power Ranking').setURL(trackerPowerRankingUrl(cfg.region)),
  )];
  await send(channel, { embeds: [embed], components }); return { username: account.username };
}

module.exports = { start, poll, saveEpicAccount, getEpicAccount, unlinkEpic, publishPlayerLinks, addEvent, listEvents, removeEvent, announceEvent, __test: { cleanUsername, normalizeEvent, trackerProfileUrl, trackerEventsUrl, trackerPowerRankingUrl } };
