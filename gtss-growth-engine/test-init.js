const fs = require('fs');
const files = [
  'app/fetchJson.js',
  'app/toasts.js',
  'app/confirmDialog.js',
  'app/sse.js',
  'app/socket.js',
  'app/shellState.js',
  'app/platforms.js',
  'app/renderHelpers.js',
  'app/initShell.js',
  'app/init.js'
];
let code = files.map(f => fs.readFileSync('public/js/' + f, 'utf8')).join('\n');
// Mock browser globals
code = `
  const window = {};
  const document = { addEventListener: () => {} };
  ${code}
  console.log(Object.keys(window.gtss).length);
`;
try {
  eval(code);
} catch (e) {
  console.error("Error evaluating:", e);
}
