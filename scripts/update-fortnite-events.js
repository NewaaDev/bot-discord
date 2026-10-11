const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const CACHE_FILE = path.join(__dirname, '..', 'public', 'fortnite-events.json');
const IMAGE_AHEAD_MS = 96 * 60 * 60_000;
const IMAGE_HOSTS = new Set(['trackercdn.com', 'www.trackercdn.com', 'cdn2.unrealengine.com', 'cms-assets.unrealengine.com']);
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');

function validImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null; }
  catch { return null; }
}

function fallbackEventImage(eventId) {
  const images = [
    [/ArenaTestCup/i, 'https://trackercdn.com/unreal/en-fnbr-40-10-comp-arenastestcup-discovertile-1920x1080-1920x1080-99955accbc39.jpg'],
    [/ReloadCashCup/i, 'https://trackercdn.com/unreal/en-fneco-33-00-competitive-discoverytile-cashcup-1920x1080-1920x1080-30d0287241c3.jpg'],
    [/ConsoleVCC/i, 'https://trackercdn.com/unreal/en-fnce-34-40-competitive-discoverytile-consolevictorycup-1920x1080-1920x1080-d9732741987b.jpg'],
    [/FNCSSolo/i, 'https://trackercdn.com/unreal/en-fnce-42-00-solos-discovertile-1920x1080-1920x1080-456d617381ea.jpg'],
    [/PerformanceEvaluation/i, 'https://trackercdn.com/unreal/en-fneco-33-00-competitive-discoverytile-performanceevaluation-1080x1920-1920x1080-0d97208eb6f0.jpg'],
    [/VictoryCup/i, 'https://trackercdn.com/unreal/en-fnce-38-00-competitive-discoverytile-victorycashcup-1980x1020-1920x1080-286ddbb64684.jpg'],
    [/RankedCup/i, 'https://trackercdn.com/unreal/en-fneco-33-00-competitive-discoverytile-rankedcups-1920x1080-1920x1080-a078f4d982b2.jpg'],
  ];
  return images.find(([pattern]) => pattern.test(eventId))?.[1] || null;
}

async function fetchEventImage(eventId) {
  const url = `https://fortnitetracker.com/events/${encodeURIComponent(eventId)}`;
  let html = '';
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; FAYZEN calendar updater)', accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) html = await response.text();
  } catch {}
  let match = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i);
  let imageUrl = validImageUrl(match?.[1]?.replace(/&amp;/g, '&'));
  if (imageUrl) return imageUrl;
  try {
    html = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=12000', '--dump-dom', url], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    match = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i);
    imageUrl = validImageUrl(match?.[1]?.replace(/&amp;/g, '&'));
  } catch {}
  return imageUrl || fallbackEventImage(eventId);
}

function parseSchedule(html) {
  const marker = 'streamController.enqueue(';
  const markerAt = html.indexOf(marker); const quoteAt = html.indexOf('"', markerAt + marker.length);
  if (markerAt < 0 || quoteAt < 0) return [];
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
    if (Array.isArray(value)) { const result = (values[index] = []); for (const entry of value) result.push(hydrate(entry)); return result; }
    const result = (values[index] = {});
    for (const [key, entry] of Object.entries(value)) result[hydrate(Number(key.slice(1)))] = hydrate(entry);
    return result;
  };
  const days = hydrate(0)?.loaderData?.['routes/competitive.schedule']?.scheduleDays || [];
  const now = Date.now();
  return days.flatMap(day => day.events || []).filter(source => source.eventWindow?.visibility === 'public' && new Date(source.eventWindow.endTime).getTime() > now).map(source => ({
    eventId: source.eventId, eventWindowId: source.eventWindow.eventWindowId, name: source.tournamentName,
    beginTime: source.eventWindow.beginTime, endTime: source.eventWindow.endTime, region: 'EU', mode: source.roundName, visibility: 'public',
  }));
}

async function main() {
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  const response = await fetch(`https://www.fortnite.com/competitive/schedule?lang=en-US&region=EU&t=${Date.now()}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; FAYZEN calendar updater)', accept: 'text/html' },
    signal: AbortSignal.timeout(60_000),
  });
  let html;
  if (response.ok) html = await response.text();
  else {
    try {
      html = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=15000', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', '--dump-dom', 'https://www.fortnite.com/competitive/schedule?lang=en-US&region=EU'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      if (!previous.length) throw error;
      console.warn('Calendrier officiel inaccessible; enrichissement du cache existant uniquement.');
    }
  }
  const events = html ? parseSchedule(html) : previous.filter(event => new Date(event.endTime).getTime() > Date.now());
  if (!events.length) throw new Error('Aucune cup future trouvée; conservation du cache existant.');
  const previousImages = new Map(previous.filter(event => validImageUrl(event.imageUrl)).map(event => [event.eventId, event.imageUrl]));
  const upcomingIds = [...new Set(events.filter(event => new Date(event.beginTime).getTime() <= Date.now() + IMAGE_AHEAD_MS).map(event => event.eventId))];
  const fetched = new Map();
  for (const eventId of upcomingIds) fetched.set(eventId, await fetchEventImage(eventId));
  for (const event of events) event.imageUrl = fetched.get(event.eventId) || previousImages.get(event.eventId) || undefined;
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(events, null, 2)}\n`);
  console.log(`${events.length} cups Fortnite mises en cache, ${events.filter(event => event.imageUrl).length} avec illustration.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
