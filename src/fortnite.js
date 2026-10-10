const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const store = require('./store');

const STATE_FILE = process.env.FORTNITE_STATE_FILE || path.join(__dirname, '..', 'fortnite-state.json');
const ACCOUNTS_FILE = process.env.FORTNITE_ACCOUNTS_FILE || path.join(__dirname, '..', 'fortnite-accounts.json');
const POLL_MS = Math.max(60_000, Number(process.env.FORTNITE_POLL_MS) || 60_000);
const SYNC_MS = Math.max(5 * 60_000, Number(process.env.FORTNITE_SYNC_MS) || 15 * 60_000);
const EVENTS_SOURCE = process.env.FORTNITE_EVENTS_SOURCE || 'https://myfortnitestats.com/events';
const OFFICIAL_SCHEDULE_SOURCE = 'https://www.fortnite.com/competitive/schedule?lang=en-US';
const EVENTS_CACHE_SOURCE = process.env.FORTNITE_EVENTS_CACHE_SOURCE || 'https://api.github.com/repos/NewaaDev/bot-discord/contents/public/fortnite-events.json?ref=main';
const LOCAL_EVENTS_CACHE = path.join(__dirname, '..', 'public', 'fortnite-events.json');
const ANNOUNCE_AHEAD_MS = 24 * 60 * 60_000;
let timer = null;
let running = false;
let lastSyncAt = 0;

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

function extractAssignedJson(html, variableName) {
  const marker = `const ${variableName} =`;
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error(`Données ${variableName} introuvables.`);
  const start = html.indexOf('{', markerAt + marker.length);
  if (start < 0) throw new Error(`Données ${variableName} invalides.`);
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error(`Données ${variableName} incomplètes.`);
}

function eventName(event) {
  const raw = String(event.metadata?.webId || event.eventId || 'Cup Fortnite')
    .replace(/^epicgames_/i, '').replace(/_[A-Z]{2,4}$/i, '')
    .replace(/^S\d+_?/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return raw.replace(/\bFncs\b/gi, 'FNCS').replace(/\bZb\b/gi, 'Zero Build').slice(0, 100) || 'Cup Fortnite';
}

function parseAutomaticEvents(html, region = 'EU', now = Date.now()) {
  const data = extractAssignedJson(html, 'ssrEventsData');
  const events = [];
  for (const source of data.events || []) {
    if (!String(source.eventId || '').endsWith(`_${region}`)) continue;
    for (const window of source.eventWindows || []) {
      if (window.visibility && window.visibility !== 'public') continue;
      const begin = new Date(window.beginTime); const end = new Date(window.endTime);
      if (!Number.isFinite(begin.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() <= now) continue;
      events.push({
        id: `auto-${window.eventWindowId}`,
        sourceId: window.eventWindowId,
        name: eventName(source),
        beginTime: begin.toISOString(), endTime: end.toISOString(), region,
        mode: window.metadata?.RoundType ? `Session ${window.round || ''} • ${window.metadata.RoundType}`.trim() : `Session ${window.round || 1}`,
        link: `https://fortnitetracker.com/events/${encodeURIComponent(source.eventId)}`,
        createdAt: new Date().toISOString(), automatic: true,
      });
    }
  }
  return events.sort((a, b) => new Date(a.beginTime) - new Date(b.beginTime));
}

function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&ndash;|&#8211;/g, '–');
}

function parisTimeToIso(day, time) {
  const match = String(time).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  const [year, month, date] = day.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, date, hour, Number(match[2]));
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(wanted)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(wanted + (wanted - shown)).toISOString();
}

function extractOfficialScheduleData(html) {
  const marker = 'streamController.enqueue(';
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return [];
  const quoteAt = html.indexOf('"', markerAt + marker.length);
  if (quoteAt < 0) return [];
  let escaped = false; let end = quoteAt + 1;
  for (; end < html.length; end += 1) {
    if (escaped) escaped = false;
    else if (html[end] === '\\') escaped = true;
    else if (html[end] === '"') break;
  }
  const flat = JSON.parse(JSON.parse(html.slice(quoteAt, end + 1)));
  const values = new Array(flat.length); const seen = new Array(flat.length);
  const hydrate = index => {
    if (index === -5) return undefined;
    if (index < 0) return null;
    if (seen[index]) return values[index];
    const value = flat[index];
    if (value === null || typeof value !== 'object') return (values[index] = value);
    seen[index] = true;
    if (Array.isArray(value)) {
      const result = (values[index] = []);
      for (const entry of value) result.push(hydrate(entry));
      return result;
    }
    const result = (values[index] = {});
    for (const [key, entry] of Object.entries(value)) result[hydrate(Number(key.slice(1)))] = hydrate(entry);
    return result;
  };
  return hydrate(0)?.loaderData?.['routes/competitive.schedule']?.scheduleDays || [];
}

function parseOfficialSchedule(html, region = 'EU', now = Date.now()) {
  const officialDays = extractOfficialScheduleData(html);
  if (officialDays.length) {
    const events = []; const seen = new Set();
    for (const day of officialDays) for (const source of day.events || []) {
      const window = source.eventWindow || {};
      if (!String(source.eventId || '').toUpperCase().endsWith(`_${region.toUpperCase()}`) || window.visibility !== 'public' || seen.has(window.eventWindowId)) continue;
      const end = new Date(window.endTime);
      if (!Number.isFinite(end.getTime()) || end.getTime() <= now) continue;
      seen.add(window.eventWindowId);
      events.push({ id: `auto-${window.eventWindowId}`, sourceId: window.eventWindowId, name: String(source.tournamentName || eventName(source)).slice(0, 100), beginTime: new Date(window.beginTime).toISOString(), endTime: end.toISOString(), region, mode: String(source.roundName || `Session ${window.round || 1}`).slice(0, 80), link: `https://fortnitetracker.com/events/${encodeURIComponent(source.eventId)}`, createdAt: new Date().toISOString(), automatic: true });
    }
    return events.sort((a, b) => new Date(a.beginTime) - new Date(b.beginTime));
  }
  const headings = [...html.matchAll(/<h2\b[^>]*id=["']schedule-label-(\d{4}-\d{2}-\d{2})T[^"']+["'][^>]*>/gi)];
  const events = []; const seen = new Set();
  for (let i = 0; i < headings.length; i += 1) {
    const day = headings[i][1];
    const section = html.slice(headings[i].index, headings[i + 1]?.index || html.length);
    const links = section.matchAll(/<a\b[^>]*aria-label=["']([^"']+)["'][^>]*href=["']([^"']*\/competitive\/events\/([^?"']+)\?round=([^&"']+)[^"']*)["'][^>]*>/gi);
    for (const link of links) {
      const label = decodeHtml(link[1]); const split = label.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s+-\s+(.+?)\s+–\s+(.+)$/i);
      if (!split) continue;
      const sourceId = decodeURIComponent(link[4]);
      if (seen.has(sourceId) || !sourceId.toUpperCase().endsWith(`_${region.toUpperCase()}`)) continue;
      const beginTime = parisTimeToIso(day, split[1]);
      if (!beginTime) continue;
      const begin = new Date(beginTime); const end = new Date(begin.getTime() + 3 * 60 * 60_000);
      if (end.getTime() <= now) continue;
      seen.add(sourceId);
      events.push({ id: `auto-${sourceId}`, sourceId, name: split[2].slice(0, 100), beginTime, endTime: end.toISOString(), region, mode: split[3].slice(0, 80), link: `https://fortnitetracker.com/events/epicgames_${encodeURIComponent(link[3])}_${region}`, createdAt: new Date().toISOString(), automatic: true });
    }
  }
  return events.sort((a, b) => new Date(a.beginTime) - new Date(b.beginTime));
}

function parseCachedEvents(payload, region = 'EU', now = Date.now()) {
  const normalizedRegion = String(region || 'EU').toUpperCase();
  return (Array.isArray(payload) ? payload : []).filter(event => String(event.region || 'EU').toUpperCase() === normalizedRegion && new Date(event.endTime).getTime() > now).map(event => ({
    id: `auto-${event.eventWindowId}`, sourceId: event.eventWindowId, name: event.name, beginTime: event.beginTime, endTime: event.endTime, region: normalizedRegion,
    mode: event.mode, link: `https://fortnitetracker.com/events/${encodeURIComponent(event.eventId)}`, createdAt: new Date().toISOString(), automatic: true,
  })).sort((a, b) => new Date(a.beginTime) - new Date(b.beginTime));
}

function cachedEventsForRegions(payload, regions) {
  const parsed = new Map(regions.map(region => [region, parseCachedEvents(payload, region)]));
  return [...parsed.values()].some(events => events.length) ? parsed : null;
}

async function syncAutomaticEvents(state, guilds) {
  const sourceUrl = new URL(EVENTS_SOURCE);
  sourceUrl.searchParams.set('_fayzen', String(Date.now()));
  const response = await fetch(sourceUrl, { headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
  }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`calendrier HTTP ${response.status}`);
  const html = await response.text();
  const regions = [...new Set(guilds.map(guild => store.get(guild.id).fortnite).filter(cfg => cfg.enabled).map(cfg => cfg.region || 'EU'))];
  const byRegion = new Map(regions.map(region => [region, parseAutomaticEvents(html, region)]));
  if ([...byRegion.values()].every(events => events.length === 0)) {
    try {
      const cachedUrl = new URL(EVENTS_CACHE_SOURCE); cachedUrl.searchParams.set('_fayzen', String(Date.now()));
      const cached = await fetch(cachedUrl, { headers: { accept: 'application/vnd.github.raw+json', 'user-agent': 'FAYZEN Discord Bot', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) });
      if (cached.ok) {
        const parsed = cachedEventsForRegions(await cached.json(), regions);
        if (parsed) for (const [region, events] of parsed) byRegion.set(region, events);
      } else console.warn(`[Fortnite] Cache distant indisponible (HTTP ${cached.status}).`);
    } catch (error) { console.warn(`[Fortnite] Cache distant indisponible : ${error.message}`); }
  }
  if ([...byRegion.values()].every(events => events.length === 0)) {
    const localPayload = readJson(LOCAL_EVENTS_CACHE, []);
    const parsed = cachedEventsForRegions(localPayload, regions);
    console.log(`[Fortnite] Cache local: ${Array.isArray(localPayload) ? localPayload.length : 0} entrée(s), régions ${regions.join(', ')}, heure ${new Date().toISOString()}.`);
    if (parsed) {
      for (const [region, events] of parsed) byRegion.set(region, events);
      console.log('[Fortnite] Calendrier de secours local chargé.');
    }
  }
  if ([...byRegion.values()].every(events => events.length === 0)) {
    for (const region of regions) {
      const official = await fetch(`${OFFICIAL_SCHEDULE_SOURCE}&region=${encodeURIComponent(region)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; FAYZEN/2.0)', accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
      if (official.ok) byRegion.set(region, parseOfficialSchedule(await official.text(), region));
    }
  }
  let added = 0; let available = 0;
  for (const guild of guilds) {
    const cfg = store.get(guild.id).fortnite;
    if (!cfg.enabled) continue;
    state[guild.id] ||= { events: [] };
    const known = new Set(state[guild.id].events.map(event => event.sourceId || event.id));
    const automaticEvents = byRegion.get(cfg.region || 'EU') || [];
    available += automaticEvents.length;
    for (const event of automaticEvents) {
      if (!known.has(event.sourceId)) { state[guild.id].events.push(event); known.add(event.sourceId); added += 1; }
    }
  }
  console.log(`✅ Calendrier Fortnite synchronisé automatiquement (${added} nouvelle(s), ${available} disponible(s))`);
  return added;
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
    const beginAt = new Date(event.beginTime).getTime();
    if (event.automatic && !event.announcedAt && now >= beginAt - ANNOUNCE_AHEAD_MS && now < beginAt) {
      try { await announceEvent(guild, event); event.announcedAt = new Date().toISOString(); }
      catch (error) { console.error(`[Fortnite] Annonce ${event.name} : ${error.message}`); }
    }
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
  try {
    const guilds = [...client.guilds.cache.values()];
    if (Date.now() - lastSyncAt >= SYNC_MS) {
      lastSyncAt = Date.now();
      await syncAutomaticEvents(state, guilds).catch(err => console.error(`[Fortnite] Synchronisation automatique : ${err.message}`));
    }
    for (const guild of guilds) await pollGuild(guild, state).catch(err => console.error(`[Fortnite] ${guild.name} : ${err.message}`));
    writeJson(STATE_FILE, state);
  }
  finally { running = false; }
}
function start(client) { if (timer) return; poll(client); timer = setInterval(() => poll(client), POLL_MS); timer.unref?.(); console.log('✅ Cups Fortnite automatiques actives (mode gratuit)'); }

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

module.exports = { start, poll, saveEpicAccount, getEpicAccount, unlinkEpic, publishPlayerLinks, addEvent, listEvents, removeEvent, announceEvent, __test: { cleanUsername, normalizeEvent, trackerProfileUrl, trackerEventsUrl, trackerPowerRankingUrl, extractAssignedJson, parseAutomaticEvents, parseOfficialSchedule, parseCachedEvents, eventName } };
