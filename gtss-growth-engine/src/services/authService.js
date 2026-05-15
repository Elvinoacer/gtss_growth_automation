const bcrypt = require('bcryptjs');

function hasConfiguredPassphrase() {
  return Boolean(process.env.PASSPHRASE_HASH);
}

function verifyPassphrase(passphrase) {
  if (!hasConfiguredPassphrase()) {
    return passphrase === 'admin';
  }

  return bcrypt.compareSync(passphrase, process.env.PASSPHRASE_HASH);
}

module.exports = {
  verifyPassphrase,
  hasConfiguredPassphrase
};
