/**
 * Phantom — Electron main process
 *
 * Características clave:
 *   • Ventana flotante always-on-top, sin marco, transparente.
 *   • setContentProtection(true) → INVISIBLE para screen capture en macOS.
 *   • Captura el escritorio (no la app) usando desktopCapturer.
 *   • Atajos globales: Cmd+Shift+H ocultar/mostrar, Cmd+Shift+R analizar.
 *   • Configuración persistida en archivo JSON simple.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, shell, nativeImage, systemPreferences, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

// ─── Persistencia de configuración (JSON simple) ────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      uiLanguage: '',          // '' = detectar del sistema; sino: es | en | pt | fr | ja | zh
      provider: 'anthropic',
      apiKey: '',
      model: 'claude-haiku-4-5',
      stealth: true,
      hidden: false,
      openaiKey: '',           // separada — para Whisper (transcripción)
      translateEnabled: false,
      translateFrom: 'auto',   // auto | en | es | pt | fr | etc
      translateTo: 'es',       // por default español
      windowOpacity: 1.0,        // 0.3 - 1.0 (1 = opaca normal, 0.3 = casi transparente)
      // ── Interview Mode ──
      interviewEnabled: false,
      interviewCV: '',         // texto del CV / experiencia
      interviewContext: '',    // info extra: empresa, puesto, carta de presentación, etc
      interviewStyle: 'complete', // concise | detailed | complete (default = respuesta completa)
      interviewLanguage: 'auto'   // idioma en que responder (auto = mismo que la pregunta)
    };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudo guardar config:', e);
  }
}

let mainWindow = null;
let tray = null;
let hidNoticeShown = false;

// 🥷 Ocultar del Dock lo más temprano posible (antes incluso de whenReady).
// En el .dmg real esto está reforzado con LSUIElement:true en Info.plist
// (ver package.json → build.mac.extendInfo) y no aparece en Dock ni en Cmd+Tab.
if (process.platform === 'darwin' && app.dock) {
  try { app.dock.hide(); } catch {}
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 600;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 320,
    minHeight: 280,
    skipTaskbar: false,
    hasShadow: true,
    vibrancy: null,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 🔑 INVISIBLE A SCREEN CAPTURE (macOS / Windows)
  // En macOS usa CGSetWindowSharingType(NSWindowSharingNone)
  mainWindow.setContentProtection(true);

  // Aplicar opacidad guardada
  const savedCfg = loadConfig();
  if (savedCfg.windowOpacity && savedCfg.windowOpacity !== 1) {
    mainWindow.setOpacity(Math.max(0.15, Math.min(1, savedCfg.windowOpacity)));
  }

  // Que la ventana flote por encima incluso de fullscreen
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');


  // Para que el renderer pueda usar getDisplayMedia con audio del sistema (loopback)
  // — ScreenCaptureKit lo soporta en macOS 13+. Pasamos sólo audio (sin video).
  try {
    mainWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 }
        });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: 'loopback' });
      } catch (e) {
        console.error('[Phantom] setDisplayMediaRequestHandler:', e);
        callback({});
      }
    });
  } catch (e) {
    console.warn('[Phantom] setDisplayMediaRequestHandler no disponible:', e.message);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Prevenir que se abra DevTools en producción
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Links externos en el navegador
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── IPC Handlers ────────────────────────────────────────────────
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, cfg) => { saveConfig(cfg); return true; });

ipcMain.handle('window:hide', () => {
  if (!mainWindow) return;
  mainWindow.hide();
  // Mostrar aviso la primera vez en la sesión para que el usuario sepa cómo volverla a abrir
  if (!hidNoticeShown && Notification.isSupported()) {
    hidNoticeShown = true;
    const n = new Notification({
      title: 'Phantom oculto',
      body: 'Click en el icono de la barra de menú o usá ⌘+Shift+H para mostrarla.',
      silent: true
    });
    n.on('click', () => ensureVisible());
    n.show();
  }
});
ipcMain.handle('window:show', () => { if (mainWindow) mainWindow.show(); });
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });

ipcMain.handle('window:set-content-protection', (_e, on) => {
  if (mainWindow) mainWindow.setContentProtection(!!on);
});

ipcMain.handle('window:set-opacity', (_e, value) => {
  if (!mainWindow) return;
  // Clamp entre 0.15 (mínimo legible) y 1.0
  const op = Math.max(0.15, Math.min(1.0, Number(value) || 1.0));
  mainWindow.setOpacity(op);
  // Persistir en config
  const cfg = loadConfig();
  cfg.windowOpacity = op;
  saveConfig(cfg);
  return op;
});

// Cambiar el tamaño de la ventana on-the-fly (para el modo traducción)
ipcMain.handle('window:resize', (_e, { width, height }) => {
  if (!mainWindow) return;
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(width || 420, workArea.width - 40);
  const h = Math.min(height || 600, workArea.height - 40);
  const [curX] = mainWindow.getPosition();
  const newX = Math.min(curX, workArea.x + workArea.width - w - 20);
  mainWindow.setBounds({
    x: Math.max(workArea.x + 20, newX),
    y: mainWindow.getPosition()[1],
    width: w,
    height: h
  }, true);
});

// Comprime una imagen para que entre en el límite de Anthropic (5 MB base64).
// - Redimensiona a max 1600px del lado más largo
// - Convierte a JPEG con calidad adaptativa
// Recibe y devuelve dataURL.
function compressImageDataURL(dataUrl, maxBytesBase64 = 4_500_000) {
  // Hint: 4.5 MB en bytes raw da ~6 MB en base64. Apuntamos abajo del límite.
  let img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return dataUrl;

  // Redimensionar si es muy grande
  const size = img.getSize();
  const MAX_DIM = 1600;
  if (size.width > MAX_DIM || size.height > MAX_DIM) {
    const scale = Math.min(MAX_DIM / size.width, MAX_DIM / size.height);
    img = img.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      quality: 'best'
    });
  }

  // Probar varias calidades de JPEG hasta caer bajo el límite
  for (const quality of [85, 75, 65, 55, 45]) {
    const buf = img.toJPEG(quality);
    // base64 size = ceil(buf.length / 3) * 4
    const b64Size = Math.ceil(buf.length / 3) * 4;
    if (b64Size <= maxBytesBase64) {
      console.log(`[Phantom] Imagen comprimida: q=${quality}, ${(b64Size / 1024 / 1024).toFixed(2)} MB`);
      return 'data:image/jpeg;base64,' + buf.toString('base64');
    }
  }

  // Fallback: redimensionar más agresivamente
  img = img.resize({ width: 1200, quality: 'best' });
  const buf = img.toJPEG(60);
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

// Captura usando el comando shell `screencapture` de macOS — funciona aún
// cuando el permiso de Electron está raro, porque pasa por el binario
// /usr/sbin/screencapture (que tiene su propio permiso de TCC).
function captureViaShell() {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `phantom-${Date.now()}.png`);
    // -x: sin sonido. -t png: formato. -C: capturar cursor (no). El path final.
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', tmpFile], (err) => {
      if (err) return reject(new Error('screencapture falló: ' + err.message));
      try {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        if (buf.length < 1000) {
          return reject(new Error('Captura vacía (¿pantalla bloqueada?)'));
        }
        const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
        resolve(compressImageDataURL(dataUrl));
      } catch (e) { reject(e); }
    });
  });
}

// Captura el escritorio. Prueba dos métodos en orden y devuelve el que funcione.
ipcMain.handle('capture:screen', async () => {
  // En macOS, si el permiso no está, NO fallamos: macOS devuelve un screenshot
  // sólo con el wallpaper (sin ventanas de otras apps). Detectamos eso y avisamos.
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      throw new Error(
        `⚠ FALTAN PERMISOS DE GRABACIÓN DE PANTALLA\n\n` +
        `Estado actual: ${status}\n\n` +
        `Sin esto, macOS sólo me deja ver el fondo de pantalla — no tus apps abiertas.\n\n` +
        `Cómo arreglarlo:\n` +
        `1) En System Settings → Privacy & Security → Screen Recording\n` +
        `2) Activá el toggle de "Phantom"\n` +
        `3) Cerrá Phantom completamente (Cmd+Q)\n` +
        `4) Volvé a abrir y probar\n\n` +
        `Te abrí el panel de Settings.`
      );
    }
  }

  const wasVisible = mainWindow && mainWindow.isVisible();
  if (wasVisible) mainWindow.hide();
  await new Promise(r => setTimeout(r, 120));

  let lastError;

  // ── Método 1: desktopCapturer (Electron) ──
  try {
    const status = process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('screen')
      : 'granted';
    console.log('[Phantom] Screen recording permission:', status);

    if (status === 'granted') {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });
      if (sources.length && sources[0].thumbnail) {
        const dataUrl = sources[0].thumbnail.toDataURL();
        if (dataUrl && dataUrl.length > 1000) {
          if (wasVisible) mainWindow.show();
          return compressImageDataURL(dataUrl);
        }
      }
      lastError = new Error('desktopCapturer devolvió captura vacía');
    } else {
      lastError = new Error(`Permiso "screen" en estado: ${status}`);
    }
  } catch (e) {
    lastError = e;
    console.warn('[capture] Método 1 falló:', e.message);
  }

  // ── Método 2: comando shell `screencapture` ──
  try {
    const dataUrl = await captureViaShell();
    if (wasVisible) mainWindow.show();
    return dataUrl;
  } catch (e) {
    console.warn('[capture] Método 2 falló:', e.message);
    if (wasVisible) mainWindow.show();
    // Si los dos fallan, abrir settings y dar mensaje claro
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    throw new Error(
      `No pude capturar la pantalla.\n` +
      `Método 1 (Electron): ${lastError?.message || 'falló'}\n` +
      `Método 2 (screencapture): ${e.message}\n\n` +
      `Solución:\n` +
      `1) System Settings → Privacy & Security → Screen Recording\n` +
      `2) Sacá cualquier entrada vieja de Electron con "—"\n` +
      `3) Reiniciá el Mac (TCC se queda colgado a veces en macOS 15)\n` +
      `4) Volvé a correr la app y aceptá el prompt cuando aparezca.`
    );
  }
});

// ─── TRANSCRIPCIÓN (Whisper de OpenAI) ──────────────────────────
// Recibe un audio base64 (webm/opus normalmente) y devuelve el texto.
// Modelo de transcripción rápido — fallback a whisper-1 si no está disponible
let _whisperModel = 'gpt-4o-mini-transcribe';

ipcMain.handle('whisper:transcribe', async (_e, { audioBase64, mimeType, language }) => {
  const cfg = loadConfig();
  const apiKey = cfg.openaiKey;
  if (!apiKey) throw new Error('Falta configurar OpenAI key (settings → Translation).');

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  if (audioBuffer.length < 3000) {
    return { text: '' }; // chunks vacíos / silencio
  }

  const callWhisper = async (model) => {
    const boundary = '----PhantomBoundary' + Date.now() + Math.random().toString(36).slice(2);
    const ext = mimeType && mimeType.includes('webm') ? 'webm' : (mimeType?.includes('mp4') ? 'mp4' : 'webm');
    const filename = `audio.${ext}`;
    const ct = mimeType || 'audio/webm';
    const parts = [];
    const append = (s) => parts.push(Buffer.from(s, 'utf8'));
    append(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${ct}\r\n\r\n`);
    parts.push(audioBuffer);
    append(`\r\n`);
    append(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`);
    if (language && language !== 'auto') {
      append(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);
    }
    append(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`);
    append(`--${boundary}--\r\n`);
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Whisper ${res.statusCode}: ${text.slice(0, 250)}`));
          }
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  try {
    const json = await callWhisper(_whisperModel);
    return { text: (json.text || '').trim() };
  } catch (e) {
    // Si gpt-4o-mini-transcribe no existe en la cuenta, fallback a whisper-1
    if (_whisperModel !== 'whisper-1' && /model|invalid|not.+found/i.test(e.message)) {
      console.log('[Phantom] Fallback a whisper-1');
      _whisperModel = 'whisper-1';
      const json = await callWhisper('whisper-1');
      return { text: (json.text || '').trim() };
    }
    throw e;
  }
});

// ─── TRADUCCIÓN RÁPIDA ──────────────────────────────────────────
// Usa el provider del usuario (Claude o GPT) para traducir un texto corto.
ipcMain.handle('translate:text', async (_e, { text, from, to }) => {
  if (!text || !text.trim()) return { text: '' };
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('Falta API key del proveedor principal.');

  const fromLabel = from && from !== 'auto' ? from : 'auto-detect';
  const system = `You are a professional simultaneous interpreter. Translate from ${fromLabel} to ${to}. Reply with ONLY the translation, no preamble/quotes/explanation. If text is already in ${to}, repeat as-is.`;
  const messages = [{ role: 'user', content: text }];

  // Usar SIEMPRE el modelo más chico/rápido para traducción (no el general del usuario)
  if (cfg.provider === 'openai') {
    return callOpenAI(cfg.apiKey, 'gpt-4o-mini', system, messages, 200);
  }
  return callAnthropic(cfg.apiKey, 'claude-haiku-4-5', system, messages, 200);
});

// ─── DEEPGRAM STREAMING (real-time transcription) ──────────────
let dgSocket = null;

ipcMain.handle('deepgram:start', async (_e, { language, sampleRate }) => {
  const cfg = loadConfig();
  const apiKey = cfg.deepgramKey;
  if (!apiKey) throw new Error('Falta configurar Deepgram API key en settings.');

  // Cerrar conexión anterior si existe
  if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
    try { dgSocket.send(JSON.stringify({ type: 'CloseStream' })); dgSocket.close(); } catch {}
  }

  const lang = (language && language !== 'auto') ? `&language=${language}` : '&detect_language=true';
  const rate = sampleRate || 16000;
  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${rate}&channels=1&model=nova-2&interim_results=true&punctuate=true&endpointing=300${lang}`;

  return new Promise((resolve, reject) => {
    dgSocket = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` }
    });

    const timeout = setTimeout(() => {
      reject(new Error('Deepgram connection timeout (10s)'));
      if (dgSocket) { try { dgSocket.close(); } catch {} dgSocket = null; }
    }, 10000);

    dgSocket.on('open', () => {
      clearTimeout(timeout);
      console.log('[Phantom] Deepgram WebSocket connected');
      resolve({ connected: true });
    });

    dgSocket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'Results') return;
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;
        const transcript = alt.transcript || '';
        if (!transcript) return;

        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;

        if (msg.is_final) {
          win.webContents.send('deepgram:final', transcript, msg.speech_final || false);
        } else {
          win.webContents.send('deepgram:interim', transcript);
        }
      } catch (err) {
        console.error('[Phantom] Deepgram parse error:', err);
      }
    });

    dgSocket.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[Phantom] Deepgram WS error:', err.message);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('deepgram:error', err.message);
    });

    dgSocket.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log('[Phantom] Deepgram WS closed:', code, reason?.toString());
      dgSocket = null;
    });
  });
});

ipcMain.on('deepgram:audio', (_e, int16Buffer) => {
  if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
    dgSocket.send(Buffer.from(int16Buffer));
  }
});

ipcMain.handle('deepgram:stop', async () => {
  if (dgSocket) {
    try {
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      dgSocket.close();
    } catch {}
    dgSocket = null;
  }
  return { stopped: true };
});

// ─── EXCHANGE APIs (KuCoin / Binance) ─────────────────────────
// Helpers para firmar requests y hacer llamadas HTTPS

function httpsJSON(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// KuCoin signature: HMAC-SHA256(timestamp + method + path + body, secret) → base64
function kucoinSign(secret, timestamp, method, path, body) {
  const what = timestamp + method.toUpperCase() + path + (body || '');
  return crypto.createHmac('sha256', secret).update(what).digest('base64');
}

function kucoinHeaders(cfg, method, path, body) {
  const timestamp = Date.now().toString();
  const sign = kucoinSign(cfg.exchangeSecret, timestamp, method, path, body || '');
  const passphrase = crypto.createHmac('sha256', cfg.exchangeSecret)
    .update(cfg.exchangePassphrase || '').digest('base64');
  return {
    'KC-API-KEY': cfg.exchangeKey,
    'KC-API-SIGN': sign,
    'KC-API-TIMESTAMP': timestamp,
    'KC-API-PASSPHRASE': passphrase,
    'KC-API-KEY-VERSION': '2',
    'Content-Type': 'application/json'
  };
}

// Binance signature: HMAC-SHA256(querystring, secret) → hex
function binanceSign(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

ipcMain.handle('exchange:fetch', async (_e, { type }) => {
  const cfg = loadConfig();
  const exchange = cfg.exchangeProvider || 'kucoin';

  if (!cfg.exchangeKey || !cfg.exchangeSecret) {
    throw new Error('Falta configurar API key del exchange en settings.');
  }

  if (exchange === 'kucoin') {
    return fetchKuCoin(cfg, type);
  } else if (exchange === 'binance') {
    return fetchBinance(cfg, type);
  }
  throw new Error('Exchange no soportado: ' + exchange);
});

async function fetchKuCoin(cfg, type) {
  const results = {};
  const asset = cfg.tradingAsset || '';
  const symbol = asset.replace('/', '-').toUpperCase(); // BTC/USDT → BTC-USDT

  try {
    if (type === 'all' || type === 'ticker') {
      if (symbol) {
        // Intentar futures primero, luego spot
        try {
          const futures = await httpsJSON('api-futures.kucoin.com', `/api/v1/ticker?symbol=${symbol}M`);
          results.ticker = futures.data;
          results.tickerSource = 'futures';
        } catch {
          const spot = await httpsJSON('api.kucoin.com', `/api/v1/market/orderbook/level1?symbol=${symbol}`);
          results.ticker = spot.data;
          results.tickerSource = 'spot';
        }
      }
    }

    if (type === 'all' || type === 'positions') {
      const path = '/api/v1/positions';
      const headers = kucoinHeaders(cfg, 'GET', path);
      const pos = await httpsJSON('api-futures.kucoin.com', path, headers);
      results.positions = (pos.data || []).filter(p => p.isOpen);
    }

    if (type === 'all' || type === 'orders') {
      const path = '/api/v1/orders?status=active';
      const headers = kucoinHeaders(cfg, 'GET', path);
      // Intentar futures
      try {
        const orders = await httpsJSON('api-futures.kucoin.com', path, headers);
        results.orders = orders.data?.items || [];
        results.ordersSource = 'futures';
      } catch {
        const spotPath = '/api/v1/orders?status=active';
        const spotHeaders = kucoinHeaders(cfg, 'GET', spotPath);
        const orders = await httpsJSON('api.kucoin.com', spotPath, spotHeaders);
        results.orders = orders.data?.items || [];
        results.ordersSource = 'spot';
      }
    }

    if (type === 'all' || type === 'balance') {
      const path = '/api/v1/account-overview';
      const headers = kucoinHeaders(cfg, 'GET', path);
      try {
        const bal = await httpsJSON('api-futures.kucoin.com', path, headers);
        results.balance = bal.data;
        results.balanceSource = 'futures';
      } catch {
        const spotPath = '/api/v1/accounts';
        const spotHeaders = kucoinHeaders(cfg, 'GET', spotPath);
        const bal = await httpsJSON('api.kucoin.com', spotPath, spotHeaders);
        results.balance = bal.data;
        results.balanceSource = 'spot';
      }
    }
  } catch (err) {
    results.error = err.message;
  }

  return results;
}

async function fetchBinance(cfg, type) {
  const results = {};
  const asset = cfg.tradingAsset || '';
  const symbol = asset.replace('/', '').toUpperCase(); // BTC/USDT → BTCUSDT

  try {
    if (type === 'all' || type === 'ticker') {
      if (symbol) {
        try {
          const ticker = await httpsJSON('fapi.binance.com', `/fapi/v1/ticker/price?symbol=${symbol}`);
          results.ticker = ticker;
          results.tickerSource = 'futures';
        } catch {
          const ticker = await httpsJSON('api.binance.com', `/api/v3/ticker/price?symbol=${symbol}`);
          results.ticker = ticker;
          results.tickerSource = 'spot';
        }
      }
    }

    if (type === 'all' || type === 'positions') {
      const ts = Date.now().toString();
      const qs = `timestamp=${ts}`;
      const sig = binanceSign(cfg.exchangeSecret, qs);
      const path = `/fapi/v2/positionRisk?${qs}&signature=${sig}`;
      const pos = await httpsJSON('fapi.binance.com', path, { 'X-MBX-APIKEY': cfg.exchangeKey });
      results.positions = (pos || []).filter(p => parseFloat(p.positionAmt) !== 0);
    }

    if (type === 'all' || type === 'orders') {
      const ts = Date.now().toString();
      const qs = symbol ? `symbol=${symbol}&timestamp=${ts}` : `timestamp=${ts}`;
      const sig = binanceSign(cfg.exchangeSecret, qs);
      const path = `/fapi/v1/openOrders?${qs}&signature=${sig}`;
      const orders = await httpsJSON('fapi.binance.com', path, { 'X-MBX-APIKEY': cfg.exchangeKey });
      results.orders = orders || [];
    }

    if (type === 'all' || type === 'balance') {
      const ts = Date.now().toString();
      const qs = `timestamp=${ts}`;
      const sig = binanceSign(cfg.exchangeSecret, qs);
      const path = `/fapi/v2/balance?${qs}&signature=${sig}`;
      const bal = await httpsJSON('fapi.binance.com', path, { 'X-MBX-APIKEY': cfg.exchangeKey });
      results.balance = (bal || []).filter(b => parseFloat(b.balance) > 0);
    }
  } catch (err) {
    results.error = err.message;
  }

  return results;
}

// ─── INTERVIEW MODE: contestar como el usuario ──────────────────
// Recibe la pregunta detectada y devuelve la respuesta como si fuera el usuario,
// usando el CV/contexto guardados en la config.
ipcMain.handle('interview:answer', async (_e, { question, conversationContext }) => {
  if (!question || !question.trim()) return { text: '' };
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('Falta API key del proveedor principal.');

  const cv = (cfg.interviewCV || '').trim();
  const extra = (cfg.interviewContext || '').trim();

  // Estilos: concise (corto), detailed (medio), complete (completo de entrevista)
  const styleMap = {
    concise:  'CONCISE: 1-2 sentences max. Direct and punchy.',
    detailed: 'DETAILED: 3-5 sentences. Cover the main point with one supporting detail.',
    complete: 'COMPLETE: 4-8 sentences forming 1-2 well-structured paragraphs. Give a full interview-quality answer that covers: the direct answer, a concrete example or experience from the CV, and the impact or learning. Sound thoughtful but natural.'
  };
  const styleKey = styleMap[cfg.interviewStyle] ? cfg.interviewStyle : 'complete';
  const style = styleMap[styleKey];

  // Idioma — reglas mucho más explícitas para que el modelo no defaultee a español
  const lang = cfg.interviewLanguage || 'auto';
  const langRule = lang === 'auto'
    ? `🌐 LANGUAGE — CRITICAL RULE:
You MUST detect the language of the question and answer IN THE EXACT SAME LANGUAGE.
- If the question is in English → answer in English.
- If the question is in Spanish → answer in Spanish.
- If the question is in Portuguese → answer in Portuguese.
- If the question is in French/Italian/German → answer in that language.
DO NOT translate. DO NOT default to Spanish. Match the question's language exactly.

Examples:
  Q: "Tell me about yourself" → answer in English.
  Q: "Contame sobre vos" → answer in Spanish.
  Q: "Fale sobre você" → answer in Portuguese.`
    : `🌐 LANGUAGE — CRITICAL: Always reply in ${lang.toUpperCase()}, regardless of the question's language.`;

  const system = `You are answering an INTERVIEW QUESTION on behalf of the candidate. Respond in FIRST PERSON ("I", "my") as if you were the candidate. Be natural, confident, conversational — like a real person speaking, NOT a robot reading a script.

📏 STYLE — ${style}

Sound human. Avoid corporate buzzwords ("synergy", "leverage", "ecosystem"). Don't list bullet points — speak in flowing sentences. Show personality.

${langRule}

🎯 ANSWER GUIDELINES:
- If the question is ambiguous, pick the most likely interpretation and answer.
- NEVER say "I don't have enough information" — make a reasonable inference from the CV.
- Use CONCRETE details from the CV (specific projects, companies, years, technologies). Don't be generic.
- If the question is small talk / filler / greeting, reply with a short natural human response.

=== CANDIDATE CV / BACKGROUND ===
${cv || '(no CV provided)'}

=== ADDITIONAL CONTEXT (company, position, etc) ===
${extra || '(none)'}`;

  const messages = [];
  if (conversationContext && conversationContext.length > 0) {
    // Mantener contexto de Q&A previas en la misma entrevista
    for (const item of conversationContext.slice(-6)) {
      messages.push({ role: 'user', content: `Question: ${item.q}` });
      messages.push({ role: 'assistant', content: item.a });
    }
  }
  messages.push({ role: 'user', content: `Question: ${question}\n\nReply now, in the SAME language as this question.` });

  // Tokens según el estilo elegido
  const maxTokens = styleKey === 'complete' ? 700 : (styleKey === 'detailed' ? 450 : 250);

  // Modelo rápido para que la respuesta esté lista en segundos
  if (cfg.provider === 'openai') {
    return callOpenAI(cfg.apiKey, 'gpt-4o-mini', system, messages, maxTokens);
  }
  return callAnthropic(cfg.apiKey, 'claude-haiku-4-5', system, messages, maxTokens);
});

// Lee un archivo de texto/markdown plano para subir como CV/contexto
ipcMain.handle('file:read-text', async (_e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > 200_000) throw new Error('Archivo demasiado grande (>200 KB)');
    return { text: buf.toString('utf8') };
  } catch (e) {
    throw new Error(e.message);
  }
});

// Picker NATIVO de macOS + extracción de texto (PDF / DOCX / TXT / MD)
ipcMain.handle('file:pick-and-extract-cv', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Cargar CV',
    properties: ['openFile'],
    filters: [
      { name: 'CV / Resume', extensions: ['pdf', 'docx', 'txt', 'md'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Word', extensions: ['docx'] },
      { name: 'Texto', extensions: ['txt', 'md'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (buf.length > 10 * 1024 * 1024) {
    throw new Error('Archivo demasiado grande (>10 MB)');
  }

  try {
    if (ext === '.txt' || ext === '.md') {
      return { filename, text: buf.toString('utf8') };
    }

    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      return { filename, text: (data.text || '').trim() };
    }

    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const data = await mammoth.extractRawText({ buffer: buf });
      return { filename, text: (data.value || '').trim() };
    }

    if (ext === '.doc') {
      throw new Error('El formato .doc legacy no es soportado. Guardá como .docx y reintentá.');
    }

    throw new Error('Tipo de archivo no soportado: ' + ext);
  } catch (err) {
    console.error('[file:pick-and-extract-cv]', err);
    throw new Error('No pude leer el archivo: ' + err.message);
  }
});

// Helper para que el renderer pueda consultar el estado del permiso
ipcMain.handle('permissions:screen', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

ipcMain.handle('permissions:open-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});

// Llamada a la IA (proxy desde main para evitar exponer la key al renderer)
ipcMain.handle('ai:call', async (_e, payload) => {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('Falta configurar la API key.');

  const { messages, system, model: overrideModel, maxTokens } = payload;
  const tokens = maxTokens || 1500;
  if (cfg.provider === 'openai') {
    const m = overrideModel || cfg.model || 'gpt-4o-mini';
    return callOpenAI(cfg.apiKey, m, system, messages, tokens);
  }
  const m = overrideModel || cfg.model || 'claude-haiku-4-5';
  return callAnthropic(cfg.apiKey, m, system, messages, tokens);
});

function httpsJSON(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 250)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('Respuesta no JSON: ' + text.slice(0, 250))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function callAnthropic(apiKey, model, system, messages, maxTokens = 1500) {
  const body = JSON.stringify({ model, max_tokens: maxTokens, system, messages });
  const json = await httpsJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(body)
    }
  }, body);
  const text = (json.content || []).map(c => c.text || '').join('\n').trim();
  return { text };
}

async function callOpenAI(apiKey, model, system, messages, maxTokens) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.3,
    ...(maxTokens ? { max_tokens: maxTokens } : {})
  });
  const json = await httpsJSON('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      'content-length': Buffer.byteLength(body)
    }
  }, body);
  const text = json.choices?.[0]?.message?.content?.trim() || '';
  return { text };
}

// ─── Tray (icono en la barra de menú de macOS) ──────────────────
function createTray() {
  // Cargar el icono y redimensionarlo a 22x22 (tamaño estándar de menubar)
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (!trayIcon.isEmpty()) {
      trayIcon = trayIcon.resize({ width: 22, height: 22 });
      // Marcar como "template" para que se adapte automáticamente al modo claro/oscuro
      trayIcon.setTemplateImage(false);
    }
  } catch (e) {
    console.warn('No se pudo cargar icono del tray:', e.message);
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Phantom — click para mostrar/ocultar');

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? 'Ocultar Phantom' : 'Mostrar Phantom',
      accelerator: 'CmdOrCtrl+Shift+H',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: 'Analizar pantalla',
      accelerator: 'CmdOrCtrl+Shift+R',
      click: () => {
        ensureVisible();
        mainWindow?.webContents.send('shortcut:analyze');
      }
    },
    {
      label: 'Contestar pregunta visible',
      accelerator: 'CmdOrCtrl+Shift+A',
      click: () => {
        ensureVisible();
        mainWindow?.webContents.send('shortcut:answer');
      }
    },
    { type: 'separator' },
    {
      label: 'Salir de Phantom',
      accelerator: 'CmdOrCtrl+Q',
      click: () => { app.isQuitting = true; app.quit(); }
    }
  ]);

  tray.setContextMenu(buildMenu());

  // Click izquierdo → toggle (NO abrir menú)
  tray.on('click', () => toggleWindow());

  // Mantener el menú actualizado cuando cambia la visibilidad
  if (mainWindow) {
    mainWindow.on('show', () => tray.setContextMenu(buildMenu()));
    mainWindow.on('hide', () => tray.setContextMenu(buildMenu()));
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else ensureVisible();
}

function ensureVisible() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

// ─── Atajos globales ─────────────────────────────────────────────
function registerShortcuts() {
  // Cmd+Shift+H → ocultar/mostrar
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleWindow());

  // Cmd+Shift+R → trigger "analizar pantalla" desde main
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.webContents.send('shortcut:analyze');
    }
  });

  // Cmd+Shift+A → trigger "responder pregunta visible"
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.webContents.send('shortcut:answer');
    }
  });

  // Cmd+Shift+O → ciclar opacidad (100% → 75% → 50% → 30% → 100%)
  globalShortcut.register('CommandOrControl+Shift+O', () => {
    if (!mainWindow) return;
    const current = mainWindow.getOpacity();
    const steps = [1.0, 0.75, 0.5, 0.3];
    // Encontrar el siguiente en el ciclo
    let idx = steps.findIndex(s => Math.abs(s - current) < 0.05);
    idx = (idx + 1) % steps.length;
    const next = steps[idx];
    mainWindow.setOpacity(next);
    const cfg = loadConfig();
    cfg.windowOpacity = next;
    saveConfig(cfg);
    // Avisar al renderer para que actualice el slider
    mainWindow.webContents.send('opacity:changed', next);
  });
}

// ─── App lifecycle ───────────────────────────────────────────────
// Single-instance lock: si ya hay una corriendo y querés "reabrirla" desde
// Spotlight/Finder, no levanta otra — trae la existente al frente.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) ensureVisible();
  });
}

app.whenReady().then(() => {
  // Re-asegurar dock hide por si la primera llamada (antes de whenReady) no tomó
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.hide(); } catch {}
  }

  createWindow();
  // createTray();  // ← desactivado: querés stealth total. La traés con ⌘+Shift+H.
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else ensureVisible();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// En macOS, dejar la app corriendo aunque cierren la ventana
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
