const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fortnite = require('../src/fortnite');

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
  const events = fortnite.__test.parseOfficialSchedule(html, 'EU').map(event => ({
    eventId: decodeURIComponent(event.link.split('/').pop()), eventWindowId: event.sourceId, name: event.name,
    beginTime: event.beginTime, endTime: event.endTime, region: event.region, mode: event.mode, visibility: 'public',
  }));
  if (!events.length) throw new Error('Aucune cup future trouvée; conservation du cache existant.');
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'fortnite-events.json'), `${JSON.stringify(events, null, 2)}\n`);
  console.log(`${events.length} cups Fortnite mises en cache.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
