#!/usr/bin/env node

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { upsertEnvValue } = require('./envWriter');

async function main() {
  const passphrase = process.argv[2];

  if (!passphrase) {
    console.error('Usage: node src/utils/setupPassphrase.js "mypassphrase"');
    process.exit(1);
  }

  const hash = await bcrypt.hash(passphrase, 10);
  upsertEnvValue('PASSPHRASE_HASH', hash);
  console.log('Passphrase set. You can now start the server.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
