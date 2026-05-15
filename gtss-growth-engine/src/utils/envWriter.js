const fs = require('fs');
const path = require('path');

function getEnvPath() {
  return path.join(__dirname, '..', '..', '.env');
}

function upsertEnvValue(key, value) {
  const envPath = getEnvPath();
  const line = `${key}=${value}`;
  let content = '';

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }

  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}=`);
  let updated = false;

  const nextLines = lines
    .filter((existingLine, index) => existingLine !== '' || index < lines.length - 1)
    .map((existingLine) => {
      if (keyPattern.test(existingLine)) {
        updated = true;
        return line;
      }

      return existingLine;
    });

  if (!updated) {
    nextLines.push(line);
  }

  fs.writeFileSync(envPath, `${nextLines.join('\n')}\n`);
}

module.exports = {
  getEnvPath,
  upsertEnvValue
};
