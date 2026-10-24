const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const root = __dirname;
const archive = path.join(root, '.bot-update.tar.gz');
const source = 'https://github.com/NewaaDev/bot-discord/archive/refs/heads/main.tar.gz';

function startBot() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', code => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

function removeLegacyFortniteFiles() {
  for (const relativePath of [
    'fortnite-state.json',
    'fortnite-accounts.json',
    'src/fortnite.js',
    'public/fortnite-events.json',
    'scripts/update-fortnite-events.js',
  ]) {
    fs.rmSync(path.join(root, relativePath), { force: true });
  }
}

(async () => {
  try {
    console.log('🔄 Recherche de la dernière version sur GitHub…');
    const response = await fetch(source, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Téléchargement refusé (${response.status})`);
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
    await execFileAsync('tar', ['-xzf', archive, '--strip-components=1', '-C', root]);
    console.log('✅ Mise à jour GitHub installée');
  } catch (error) {
    console.error(`⚠️ Mise à jour impossible : ${error.message}`);
    console.error('➡️ Démarrage de la version déjà installée');
  } finally {
    fs.rmSync(archive, { force: true });
  }

  removeLegacyFortniteFiles();
  startBot();
})();

