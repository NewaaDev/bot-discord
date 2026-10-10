require('dotenv').config();

// GUILD_ID n'est plus nécessaire : le bot gère tous ses serveurs
const requis = ['TOKEN', 'CLIENT_ID'];
const manquants = requis.filter(k => !process.env[k]?.trim());
if (manquants.length) {
  console.error(`❌ Variables manquantes dans le .env : ${manquants.join(', ')}`);
  process.exit(1);
}

const { client } = require('./src/bot');
const app = require('./src/web');

// OnePanel/Pterodactyl expose le port alloué via SERVER_PORT. PORT reste
// prioritaire pour les hébergements qui le définissent explicitement.
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

client.login(process.env.TOKEN)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Dashboard démarré sur le port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Connexion Discord échouée :', err.message);
    console.error('   → Vérifie le TOKEN dans le .env, et les intents sur le portail dev.');
    process.exit(1);
  });

process.on('unhandledRejection', err => console.error('Erreur non gérée :', err));
