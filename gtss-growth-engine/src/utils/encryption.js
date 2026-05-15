const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const configuredKey = process.env.ENCRYPTION_KEY;
  if (!configuredKey) {
    throw new Error('ENCRYPTION_KEY is required for cookie encryption');
  }

  return crypto.createHash('sha256').update(configuredKey).digest();
}

function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const input = Buffer.from(payload, 'base64');
  const iv = input.subarray(0, IV_LENGTH);
  const authTag = input.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = input.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString('utf8');
}

module.exports = {
  encrypt,
  decrypt
};
