const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.FORTNITE_API_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.FORTNITE_STATE_FILE = path.join(os.tmpdir(), `fayzen-fortnite-state-${process.pid}.json`);
process.env.FORTNITE_ACCOUNTS_FILE = path.join(os.tmpdir(), `fayzen-fortnite-accounts-${process.pid}.json`);

const fortnite = require('../src/fortnite');

test('normalise les sessions EU renvoyées par le fournisseur', () => {
  const payload = [{
    id: 'S40_Test', name: 'Solo Victory Cup', description: 'Test', poster: 'https://example.test/poster.png',
    regions: { EU: [{ eventId: 'epic_test_EU', link: 'https://fortnite.com/test', eventWindows: [{ eventWindowId: 'window_1', round: 1, beginTime: '2026-10-11T17:00:00Z', endTime: '2026-10-11T20:00:00Z' }] }] },
  }];
  const events = fortnite.__test.flattenEvents(payload, 'EU');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    groupId: 'S40_Test', eventId: 'epic_test_EU', windowId: 'window_1', name: 'Solo Victory Cup',
    description: 'Test', poster: 'https://example.test/poster.png', link: 'https://fortnite.com/test',
    region: 'EU', round: 1, beginTime: '2026-10-11T17:00:00Z', endTime: '2026-10-11T20:00:00Z',
  });
});

test('lit les noms et points d’une ligne de classement', () => {
  const row = { teamAccountNames: ['Newaa', 'Mate'], pointsEarned: 287 };
  assert.equal(fortnite.__test.entryNames(row), 'Newaa / Mate');
  assert.equal(fortnite.__test.entryPoints(row), 287);
});

test('tous les éléments Fortnite utilisés par le dashboard existent', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ids = [...js.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]).filter(id => id.startsWith('fn-'));
  const missing = [...new Set(ids)].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});
