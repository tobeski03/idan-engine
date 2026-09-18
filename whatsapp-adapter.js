const fs = require('fs');
const path = require('path');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (_) { /* optional */ }

function hasWhatsmeowBinary() {
  const configured = process.env.IDAN_WHATSAPP_BINARY;
  const candidates = [
    configured,
    path.join(__dirname, 'bin', `idan-whatsapp-sidecar-${process.platform}-${process.arch}`),
    path.join(__dirname, 'bin', 'idan-whatsapp-sidecar'),
  ].filter(Boolean);
  return candidates.some((file) => fs.existsSync(file));
}

const useWhatsmeow = String(process.env.IDAN_WHATSAPP_PROVIDER || '').toLowerCase() === 'whatsmeow' || hasWhatsmeowBinary();
module.exports = useWhatsmeow ? require('./whatsapp-meow') : require('./whatsapp');
