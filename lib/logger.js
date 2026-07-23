/**
 * Structured JSON logger. One file per day under userData/logs/.
 * Each line is a JSON object with timestamp, level, scope, msg, and arbitrary data.
 *
 * Usage:
 *   const { createLogger } = require('./lib/logger');
 *   const log = createLogger('trade-store');
 *   log.info('logged trade', { id: '...', asset: 'BTC/USDT' });
 *   log.warn('parse failure', { error: err.message });
 *   log.error('email send failed', err);
 */

const fs = require('fs');
const path = require('path');

let logDir = null;

function initLogger(baseDir) {
  logDir = path.join(baseDir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {}
}

function currentLogFile() {
  if (!logDir) return null;
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join(logDir, `phantom-${yyyy}-${mm}-${dd}.jsonl`);
}

function writeLine(level, scope, msg, data) {
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(data && typeof data === 'object' ? sanitize(data) : data !== undefined ? { data } : {})
  };
  const serialized = JSON.stringify(line) + '\n';
  const file = currentLogFile();
  if (file) {
    try { fs.appendFileSync(file, serialized); } catch (_) {}
  }
  // Mirror to console for dev visibility.
  if (level === 'error') console.error('[' + scope + ']', msg, data || '');
  else if (level === 'warn') console.warn('[' + scope + ']', msg, data || '');
  else console.log('[' + scope + ']', msg, data || '');
}

function sanitize(data) {
  // Avoid logging huge base64 images or known secret keys.
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) {
      out[k] = { message: v.message, stack: v.stack };
    } else if (typeof v === 'string' && v.length > 500 && v.startsWith('data:')) {
      out[k] = `<data-url ${v.length} bytes>`;
    } else if (/^(secret|api_?key|password|token|stripe_?secret)$/i.test(k)) {
      out[k] = '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function createLogger(scope) {
  return {
    info: (msg, data) => writeLine('info', scope, msg, data),
    warn: (msg, data) => writeLine('warn', scope, msg, data),
    error: (msg, data) => writeLine('error', scope, msg, data)
  };
}

module.exports = { initLogger, createLogger };
