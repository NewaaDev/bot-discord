const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
  const response = await fetch(`https://www.fortnite.com/competitive/schedule?lang=en-US&region=EU&t=${Date.now()}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; FAYZEN calendar updater)', accept: 'text/html' },
    signal: AbortSignal.timeout(60_000),
  });
  let html;
  if (response.ok) html = await response.text();
  else {
    const chrome = process.env.CHROME_PATH || 'google-chrome';
    html = execFileSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'https://www.fortnite.com/competitive/schedule?lang=en-US&region=EU'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  }
  const events = parseSchedule(html);
  if (!events.length) throw new Error('Aucune cup future trouvée; conservation du cache existant.');
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'fortnite-events.json'), `${JSON.stringify(events, null, 2)}\n`);
  console.log(`${events.length} cups Fortnite mises en cache.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
