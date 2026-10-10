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
  assert.match(entrypoint, /process\.env\.PORT \|\| process\.env\.SERVER_PORT \|\| 3000/);
});
