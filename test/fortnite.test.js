const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.FORTNITE_STATE_FILE = path.join(os.tmpdir(), `fayzen-fortnite-state-${process.pid}.json`);
process.env.FORTNITE_ACCOUNTS_FILE = path.join(os.tmpdir(), `fayzen-fortnite-accounts-${process.pid}.json`);

const fortnite = require('../src/fortnite');

test('valide et enregistre uniquement un pseudo Epic sûr', () => {
  assert.equal(fortnite.__test.cleanUsername('  Newaa   FN  '), 'Newaa FN');
  assert.throws(() => fortnite.__test.cleanUsername('<script>'), /invalide/);
});

test('génère les liens publics Fortnite Tracker', () => {
  assert.equal(fortnite.__test.trackerEventsUrl('Newaa FN'), 'https://fortnitetracker.com/fortnite/profile/epic/Newaa%20FN/epic-events/overview');
  assert.equal(fortnite.__test.trackerProfileUrl('Newaa FN'), 'https://fortnitetracker.com/fortnite/profile/epic/Newaa%20FN/overview');
  assert.match(fortnite.__test.trackerPowerRankingUrl('EU'), /region=EU/);
});

test('récupère uniquement les visuels publics sûrs des cups', () => {
  const image = 'https://trackercdn.com/unreal/fncs-solos-1920x1080.jpg';
  assert.equal(fortnite.__test.extractSocialImage(`<meta property="og:image" content="${image}">`), image);
  assert.equal(fortnite.__test.extractSocialImage('<meta property="og:image" content="https://example.com/piege.jpg">'), null);
  const embed = fortnite.__test.cupEmbed('test-guild', { name: 'FNCS Solos', region: 'EU', mode: 'Solo', beginTime: '2099-10-12T17:00:00Z', endTime: '2099-10-12T20:00:00Z', link: 'https://fortnitetracker.com/events/test', imageUrl: image });
  assert.equal(embed.toJSON().image.url, image);
  assert.equal(embed.toJSON().fields[1].name, 'Début (heure de Paris)');
  assert.match(embed.toJSON().fields[1].value, /12 octobre 2099 à 19:00/);
});

test('affiche toujours les horaires Fortnite dans le fuseau de Paris', () => {
  assert.equal(fortnite.__test.parisDateTime('2026-10-12T17:00:00Z'), 'Lundi 12 octobre 2026 à 19:00');
});

test('valide les dates et le lien d’une cup manuelle', () => {
  const event = fortnite.__test.normalizeEvent({ name: 'Solo Victory Cup', beginTime: '2026-10-12T17:00:00Z', endTime: '2026-10-12T20:00:00Z', link: 'https://fortnitetracker.com/events/test', region: 'EU' }, 'test-guild');
  assert.equal(event.name, 'Solo Victory Cup');
  assert.equal(event.region, 'EU');
  assert.match(event.link, /^https:\/\/fortnitetracker\.com/);
  assert.throws(() => fortnite.__test.normalizeEvent({ name: 'Cup', beginTime: '2026-10-12T20:00:00Z', endTime: '2026-10-12T17:00:00Z' }, 'test-guild'), /horaires/);
});

test('tous les éléments Fortnite utilisés par le dashboard existent', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ids = [...js.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]).filter(id => id.startsWith('fn-'));
  const missing = [...new Set(ids)].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('le dashboard utilise le port alloué par OnePanel', () => {
  const entrypoint = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(entrypoint, /process\.env\.PORT \|\| process\.env\.SERVER_PORT \|\| 2810/);
});

test('importe automatiquement les prochaines sessions Fortnite de la région choisie', () => {
  const payload = { events: [{ eventId: 'epicgames_S42_SoloVictoryCup_EU', metadata: { webId: 'S42_SoloVictoryCup' }, eventWindows: [
    { eventWindowId: 'S42_SoloVictoryCup_Event1_EU', beginTime: '2099-10-12T17:00:00Z', endTime: '2099-10-12T20:00:00Z', visibility: 'public', round: 1 },
  ] }] };
  const html = `<script>const ssrEventsData = ${JSON.stringify(payload)}; const autre = {"ok":true};</script>`;
  const events = fortnite.__test.parseAutomaticEvents(html, 'EU', Date.parse('2099-10-01T00:00:00Z'));
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'auto-S42_SoloVictoryCup_Event1_EU');
  assert.equal(events[0].name, 'Solo Victory Cup');
  assert.match(events[0].link, /fortnitetracker\.com\/events/);
});

test('utilise le calendrier officiel Fortnite si la première source est vide', () => {
  const html = '<h2 id="schedule-label-2099-10-12T00:00:00.000Z">October 12, 2099</h2><ul><li><a aria-label="7:00 PM - Solo Ranked Cup (Battle Royale) – Session 1 - Round 7" href="/competitive/events/S42_RankedCupSolo?round=S42_RankedCupSolo_Event7_EU">Solo Ranked Cup</a></li></ul>';
  const events = fortnite.__test.parseOfficialSchedule(html, 'EU', Date.parse('2099-10-01T00:00:00Z'));
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceId, 'S42_RankedCupSolo_Event7_EU');
  assert.equal(events[0].beginTime, '2099-10-12T17:00:00.000Z');
  assert.match(events[0].link, /epicgames_S42_RankedCupSolo_EU/);
});
