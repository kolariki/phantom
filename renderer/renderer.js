/**
 * Phantom — renderer (UI)
 *
 * - Toma capturas del escritorio via phantom.capture.screen() (pasa por el main).
 * - Manda a Claude/GPT con la captura como imagen + chat de seguimiento.
 * - Toda la lógica de IA y la API key viven en el main process.
 */

const $ = (id) => document.getElementById(id);

const card = $('card');
const conversationEl = $('conversation');
const statusEl = $('status');
const chatWrap = $('chat-wrap');
const chatInput = $('chat-input');

const state = {
  busy: false,
  messages: [],
  mode: 'responder'
};

// ─── System prompts ──────────────────────────────────────────────
const LANG_RULE = `IDIOMA: Detectá el idioma del contenido visible en la captura (o de la pregunta del usuario si es seguimiento) y respondé SIEMPRE en ese mismo idioma. No traduzcas.`;

const SECURITY_RULE = `SEGURIDAD: Si detectás phishing, estafa, fraude o engaño, comenzá tu respuesta con el marcador en una línea sola:
[[PHISHING_DETECTED]]
y luego explicá brevemente por qué, qué hacer (no clickear, eliminar, bloquear, reportar) y qué señales lo delatan.`;

const SYS_RESUMEN = `You are an assistant that receives a screenshot of the user's screen and returns a clear, concise summary.
Structure: central topic (1 sentence), key points (3-5 bullets), conclusion if applicable.
Don't make up data.

${LANG_RULE}

${SECURITY_RULE}`;

const SYS_RESPONDER = `You are an expert assistant that receives a screenshot of the user's screen and must answer or solve what is shown.
If there's an explicit question, answer directly.
If there's a problem (exercise, calculation, code, decision), solve it step by step.
If there are multiple-choice options, indicate the correct one and why.
Don't pad. If info is missing to solve, say so.

${LANG_RULE}

${SECURITY_RULE}`;

// ─── Init ────────────────────────────────────────────────────────
(async () => {
  const cfg = await phantom.config.get();

  // Idioma de la UI — aplicar ANTES de leer todos los demás valores
  const uiLang = cfg.uiLanguage || detectDefaultLang();
  setLanguage(uiLang); // función definida en i18n.js (global)
  $('cfg-ui-language').value = uiLang;

  $('cfg-provider').value = cfg.provider || 'anthropic';
  updateApiHelpVisibility(cfg.provider || 'anthropic');
  $('cfg-apikey').value = cfg.apiKey || '';
  $('cfg-model').value = cfg.model || 'claude-haiku-4-5';
  $('cfg-stealth').checked = cfg.stealth !== false;
  if (typeof cfg.windowOpacity === 'number') {
    updateOpacityUI(cfg.windowOpacity);
  }
  $('cfg-translate').checked = !!cfg.translateEnabled;
  $('cfg-openai-key').value = cfg.openaiKey || '';
  $('cfg-translate-from').value = cfg.translateFrom || 'auto';
  $('cfg-translate-to').value = cfg.translateTo || 'es';
  // Interview
  $('cfg-interview').checked = !!cfg.interviewEnabled;
  $('cfg-interview-cv').value = cfg.interviewCV || '';
  $('cfg-interview-context').value = cfg.interviewContext || '';
  $('cfg-interview-style').value = cfg.interviewStyle || 'complete';
  $('cfg-interview-language').value = cfg.interviewLanguage || 'auto';
  applyTranslatePanelVisibility(!!cfg.translateEnabled);
  applyInterviewPanelVisibility(!!cfg.interviewEnabled);
  updateTranslateLangLabel();
  await phantom.window.setContentProtection(cfg.stealth !== false);
  if (!cfg.apiKey) {
    setStatus('Configurá tu API key en ⚙ para empezar.', 'err');
    $('settings-panel').style.display = 'flex';
  }
})();

// ─── Listeners UI ────────────────────────────────────────────────
$('btn-read').addEventListener('click', () => runAction('resumir'));
$('btn-answer').addEventListener('click', () => runAction('responder'));
$('btn-send').addEventListener('click', () => sendChat());
$('btn-clear').addEventListener('click', () => clearChat());
$('hide').addEventListener('click', () => phantom.window.hide());
$('close').addEventListener('click', () => phantom.window.close());

$('settings').addEventListener('click', () => {
  const panel = $('settings-panel');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  $('settings').classList.toggle('active', !open);
});

// Detecta idioma por defecto del sistema
function detectDefaultLang() {
  const supported = ['es', 'en', 'pt', 'fr', 'ja', 'zh'];
  const lang = (navigator.language || 'es').toLowerCase().split('-')[0];
  return supported.includes(lang) ? lang : 'es';
}

// Cambio de idioma de UI en vivo (sin guardar todavía — eso se hace con Guardar)
$('cfg-ui-language').addEventListener('change', (e) => {
  setLanguage(e.target.value);
});

// Cuando cambia el provider, mostrar el instructivo correcto
$('cfg-provider').addEventListener('change', (e) => {
  updateApiHelpVisibility(e.target.value);
});

function updateApiHelpVisibility(provider) {
  const helpAnthropic = $('api-help-anthropic');
  const helpOpenai = $('api-help-openai');
  if (provider === 'openai') {
    helpAnthropic.style.display = 'none';
    helpOpenai.style.display = '';
  } else {
    helpAnthropic.style.display = '';
    helpOpenai.style.display = 'none';
  }
}

$('cfg-save').addEventListener('click', async () => {
  const cfg = {
    uiLanguage: $('cfg-ui-language').value,
    provider: $('cfg-provider').value,
    apiKey: $('cfg-apikey').value.trim(),
    model: $('cfg-model').value.trim() || 'claude-haiku-4-5',
    stealth: $('cfg-stealth').checked,
    openaiKey: $('cfg-openai-key').value.trim(),
    translateEnabled: $('cfg-translate').checked,
    translateFrom: $('cfg-translate-from').value,
    translateTo: $('cfg-translate-to').value,
    interviewEnabled: $('cfg-interview').checked,
    interviewCV: $('cfg-interview-cv').value.trim(),
    interviewContext: $('cfg-interview-context').value.trim(),
    interviewStyle: $('cfg-interview-style').value,
    interviewLanguage: $('cfg-interview-language').value
  };
  await phantom.config.set(cfg);
  await phantom.window.setContentProtection(cfg.stealth);
  applyTranslatePanelVisibility(cfg.translateEnabled);
  applyInterviewPanelVisibility(cfg.interviewEnabled);
  updateTranslateLangLabel();
  setStatus('Configuración guardada.', 'ok');
});

$('cfg-interview').addEventListener('change', (e) => {
  applyInterviewPanelVisibility(e.target.checked);
});

// Cargar CV desde archivo
$('cfg-upload-cv').addEventListener('click', async () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,text/plain,text/markdown';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      $('cfg-interview-cv').value = text;
      setStatus(`✓ Cargado: ${file.name} (${(text.length / 1024).toFixed(1)} KB)`, 'ok');
    } catch (err) {
      setStatus('⚠ ' + err.message, 'err');
    }
  };
  input.click();
});

$('cfg-translate').addEventListener('change', (e) => {
  applyTranslatePanelVisibility(e.target.checked);
});

['cfg-translate-from', 'cfg-translate-to'].forEach(id => {
  $(id).addEventListener('change', updateTranslateLangLabel);
});

$('cfg-stealth').addEventListener('change', async (e) => {
  await phantom.window.setContentProtection(e.target.checked);
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Atajos globales (recibidos del main)
phantom.on('shortcut:analyze', () => runAction('resumir'));
phantom.on('shortcut:answer', () => runAction('responder'));

// ─── Translucidez de la ventana ─────────────────────────────────
const opacitySlider = $('cfg-opacity');
const opacityValueEl = $('cfg-opacity-value');
const opacityBtn = $('opacity');

function updateOpacityUI(opacity) {
  const pct = Math.round(opacity * 100);
  opacityValueEl.textContent = pct + '%';
  opacitySlider.value = pct;
}

async function applyOpacity(opacity) {
  const op = Math.max(0.15, Math.min(1, Number(opacity) || 1));
  await phantom.window.setOpacity(op);
  updateOpacityUI(op);
}

// Slider en settings
opacitySlider.addEventListener('input', (e) => {
  const op = Number(e.target.value) / 100;
  applyOpacity(op);
});

// Botón en header: cicla 100% → 75% → 50% → 30% → 100%
opacityBtn.addEventListener('click', () => {
  const current = Number(opacitySlider.value) / 100;
  const steps = [1.0, 0.75, 0.5, 0.3];
  let idx = steps.findIndex(s => Math.abs(s - current) < 0.05);
  idx = (idx + 1) % steps.length;
  applyOpacity(steps[idx]);
});

// El main puede avisarnos si la opacidad cambia via atajo global
phantom.on('opacity:changed', (val) => updateOpacityUI(val));

// ─── Paneles colapsables ────────────────────────────────────────
// Click en el header (chevron + título) colapsa/expande el body.
// Los botones de control dentro del header NO disparan colapso (stopPropagation).
document.querySelectorAll('.collapsible-panel .collapsible-header').forEach((header) => {
  header.addEventListener('click', (e) => {
    // Ignorar clicks sobre botones / selects / inputs / etc
    if (e.target.closest('button, select, input, textarea, .interview-controls, .translate-controls')) return;
    header.closest('.collapsible-panel').classList.toggle('collapsed');
    saveCollapsedState();
  });
});

function saveCollapsedState() {
  const state = {
    interview: document.getElementById('interview-panel')?.classList.contains('collapsed') || false,
    translate: document.getElementById('translate-panel')?.classList.contains('collapsed') || false
  };
  localStorage.setItem('phantom_collapsed', JSON.stringify(state));
}

function restoreCollapsedState() {
  try {
    const state = JSON.parse(localStorage.getItem('phantom_collapsed') || '{}');
    if (state.interview) document.getElementById('interview-panel')?.classList.add('collapsed');
    if (state.translate) document.getElementById('translate-panel')?.classList.add('collapsed');
  } catch {}
}
restoreCollapsedState();

// ─── Acción principal ────────────────────────────────────────────
async function runAction(action) {
  if (state.busy) return;
  state.busy = true;
  state.mode = action;
  state.messages = [];
  conversationEl.innerHTML = '';
  setDanger(false);

  setStatus(action === 'resumir' ? 'Capturando y leyendo pantalla…' : 'Capturando y resolviendo…', 'busy');
  addMessage('user', action === 'resumir' ? '📄 Resumir pantalla' : '💡 Contestar lo que está en pantalla');
  const loading = addMessage('assistant', '', true);

  try {
    const screenshot = await captureScreen();
    if (!screenshot) throw new Error('No se pudo capturar la pantalla');

    const userPrompt = action === 'resumir'
      ? 'Resumí lo que se ve en esta captura.'
      : 'Identificá la pregunta o problema visible en esta captura y resolvelo.';

    const messages = [{
      role: 'user',
      content: await buildContent(userPrompt, screenshot)
    }];

    const system = action === 'resumir' ? SYS_RESUMEN : SYS_RESPONDER;
    const resp = await phantom.ai.call({ messages, system });

    const phishing = detectPhishing(resp.text);
    const reply = stripPhishingMarker(resp.text);
    loading.classList.remove('loading');
    loading.innerHTML = renderMarkdown(reply);

    state.messages.push({ role: 'user', content: userPrompt }); // sin imagen en historial para ahorrar tokens
    state.messages.push({ role: 'assistant', content: reply });

    setDanger(phishing);
    chatWrap.style.display = 'flex';
    setStatus(phishing ? '⚠ Phishing detectado.' : (action === 'resumir' ? 'Resumen listo.' : 'Respuesta lista.'), phishing ? 'err' : 'ok');
  } catch (err) {
    loading.classList.remove('loading');
    loading.innerHTML = '<em style="color:#dc2626">' + escapeHTML(err.message) + '</em>';
    setStatus('⚠ ' + err.message, 'err');
  } finally {
    state.busy = false;
  }
}

async function sendChat() {
  if (state.busy) return;
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = '';
  state.busy = true;

  addMessage('user', q);
  const loading = addMessage('assistant', '', true);
  setStatus('Pensando…', 'busy');

  state.messages.push({ role: 'user', content: q });

  try {
    const screenshot = await captureScreen();

    // Re-inyectar imagen en el último user para que el modelo vea el estado actual
    const messagesForAPI = state.messages.slice(0, -1);
    messagesForAPI.push({
      role: 'user',
      content: await buildContent(q, screenshot)
    });

    const system = state.mode === 'resumir' ? SYS_RESUMEN : SYS_RESPONDER;
    const resp = await phantom.ai.call({ messages: messagesForAPI, system });

    const phishing = detectPhishing(resp.text);
    const reply = stripPhishingMarker(resp.text);
    loading.classList.remove('loading');
    loading.innerHTML = renderMarkdown(reply);
    state.messages.push({ role: 'assistant', content: reply });

    if (phishing) setDanger(true);
    setStatus(phishing ? '⚠ Phishing detectado.' : 'Listo.', phishing ? 'err' : 'ok');
  } catch (err) {
    loading.classList.remove('loading');
    loading.innerHTML = '<em style="color:#dc2626">' + escapeHTML(err.message) + '</em>';
    setStatus('⚠ ' + err.message, 'err');
    state.messages.pop();
  } finally {
    state.busy = false;
  }
}

function clearChat() {
  state.messages = [];
  conversationEl.innerHTML = '';
  chatWrap.style.display = 'none';
  setDanger(false);
  setStatus('Conversación nueva.', 'ok');
}

// Captura: el main process se encarga (Electron desktopCapturer + fallback a /usr/sbin/screencapture)
async function captureScreen() {
  return await phantom.capture.screen();
}

// ─── Helpers ─────────────────────────────────────────────────────
async function buildContent(text, screenshot) {
  const cfg = await phantom.config.get();
  if (!screenshot) return text;

  if (cfg.provider === 'openai') {
    return [
      { type: 'image_url', image_url: { url: screenshot } },
      { type: 'text', text }
    ];
  }
  // Anthropic
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(screenshot);
  if (!m) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
    { type: 'text', text }
  ];
}

function addMessage(role, content, loading = false) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-' + role + (loading ? ' loading' : '');
  if (loading) {
    wrap.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="width:80%"></div>';
  } else {
    wrap.innerHTML = role === 'assistant' ? renderMarkdown(content) : escapeHTML(content);
  }
  conversationEl.appendChild(wrap);
  conversationEl.scrollTop = conversationEl.scrollHeight;
  return wrap;
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  const escaped = escapeHTML(text);
  const html = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  return '<p>' + html + '</p>';
}

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function detectPhishing(text) {
  if (!text) return false;
  if (text.includes('[[PHISHING_DETECTED]]')) return true;
  return /\b(phishing|estafa|fraude|scam|fake (email|site)|sitio falso|correo (falso|sospechoso))\b/i.test(text);
}

function stripPhishingMarker(text) {
  return text.replace(/\[\[PHISHING_DETECTED\]\]\s*/g, '').trim();
}

// ─── Traducción en vivo (audio del sistema → Whisper → Claude/GPT) ──
const translate = {
  active: false,
  stream: null,
  recorder: null,
  cycleTimer: null,
  CHUNK_MS: 2500,         // 2.5s — buen balance latencia/precisión
  pendingPlaceholder: null // div "..." que se reemplaza con la traducción
};

const btnTranslate = $('btn-translate-toggle');
const translatePanel = $('translate-panel');
const translateOutput = $('translate-output');
const translateStatus = $('translate-status');

btnTranslate.addEventListener('click', () => {
  if (translate.active) stopTranslation();
  else startTranslation();
});

function applyTranslatePanelVisibility(on) {
  translatePanel.style.display = on ? 'flex' : 'none';
  document.body.classList.toggle('translating', on);
  // Agrandar la ventana cuando está activa, volver al tamaño normal cuando no
  if (on) {
    phantom.window.resize({ width: 640, height: 780 });
  } else {
    phantom.window.resize({ width: 420, height: 600 });
  }
  if (!on && translate.active) stopTranslation();
}

function updateTranslateLangLabel() {
  const from = $('cfg-translate-from').value.toUpperCase();
  const to = $('cfg-translate-to').value.toUpperCase();
  const fromShort = from === 'AUTO' ? '🌐' : from;
  $('translate-lang-label').textContent = `${fromShort} → ${to}`;
}

function expandPanel(panelId) {
  const p = document.getElementById(panelId);
  if (p && p.classList.contains('collapsed')) {
    p.classList.remove('collapsed');
    saveCollapsedState();
  }
}

async function startTranslation() {
  expandPanel('translate-panel');
  try {
    // Limpiar mensaje vacío
    const empty = translateOutput.querySelector('.translate-empty');
    if (empty) empty.remove();

    setStatus('Pidiendo audio del sistema…', 'busy');
    // getDisplayMedia con audio loopback. macOS 13+.
    translate.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 }, // mínimo posible — solo necesitamos audio
      audio: true
    });

    // Cortar el track de video (no nos sirve, sólo lo pedimos para satisfacer la API)
    const videoTracks = translate.stream.getVideoTracks();
    videoTracks.forEach(t => t.stop());

    if (translate.stream.getAudioTracks().length === 0) {
      throw new Error('No se obtuvo pista de audio. ¿Aceptaste compartir audio del sistema?');
    }

    translate.active = true;
    btnTranslate.textContent = 'Detener';
    translateStatus.classList.add('live');
    setStatus('Escuchando audio del sistema…', 'ok');

    runRecordingCycle();
  } catch (err) {
    console.error('startTranslation:', err);
    setStatus('⚠ ' + err.message, 'err');
    stopTranslation();
  }
}

function stopTranslation() {
  translate.active = false;
  btnTranslate.textContent = 'Iniciar';
  translateStatus.classList.remove('live');

  if (translate.recorder && translate.recorder.state !== 'inactive') {
    try { translate.recorder.stop(); } catch {}
  }
  translate.recorder = null;

  if (translate.cycleTimer) {
    clearTimeout(translate.cycleTimer);
    translate.cycleTimer = null;
  }

  if (translate.stream) {
    translate.stream.getTracks().forEach(t => t.stop());
    translate.stream = null;
  }
  setStatus('Traducción detenida.', 'ok');
}

// Ciclo: graba CHUNK_MS, manda a Whisper + Claude, repite mientras esté activo
async function runRecordingCycle() {
  if (!translate.active || !translate.stream) return;

  const audioStream = new MediaStream(translate.stream.getAudioTracks());
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');

  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(audioStream, { mimeType });
  } catch (e) {
    setStatus('⚠ MediaRecorder no soporta este formato: ' + e.message, 'err');
    stopTranslation();
    return;
  }
  translate.recorder = recorder;

  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = async () => {
    // 🚀 Arrancar INMEDIATAMENTE el próximo ciclo — no esperar la transcripción
    if (translate.active) runRecordingCycle();

    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuf);

    // Crear placeholder visual con "..." mientras se procesa
    const placeholder = addPlaceholder();

    transcribeAndTranslate(base64, mimeType, placeholder).catch(err => {
      console.error('transcribeAndTranslate:', err);
      placeholder.classList.remove('pending');
      placeholder.querySelector('.tr').textContent = '⚠ ' + err.message;
    });
  };

  recorder.start();
  translate.cycleTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
  }, translate.CHUNK_MS);
}

function addPlaceholder() {
  const line = document.createElement('div');
  line.className = 'translate-line pending';
  line.innerHTML = '<div class="src">…</div><div class="tr"><span class="dots"><span></span><span></span><span></span></span></div>';
  translateOutput.appendChild(line);
  translateOutput.scrollTop = translateOutput.scrollHeight;
  return line;
}

async function transcribeAndTranslate(audioBase64, mimeType, placeholder) {
  const cfg = await phantom.config.get();
  const from = cfg.translateFrom || 'auto';
  const to = cfg.translateTo || 'es';

  const t1 = await phantom.translate.transcribe({
    audioBase64,
    mimeType,
    language: from
  });
  const original = (t1.text || '').trim();
  if (!original || original.length < 2) {
    // Silencio / ruido → eliminar placeholder
    if (placeholder) placeholder.remove();
    return;
  }

  // Mostrar la transcripción YA, antes de esperar la traducción (visible 1 paso antes)
  if (placeholder) {
    placeholder.querySelector('.src').textContent = original;
  }

  // Si origen = destino, no traducir (ahorro un round-trip)
  if (from !== 'auto' && from === to) {
    if (placeholder) {
      placeholder.classList.remove('pending');
      placeholder.querySelector('.tr').textContent = original;
    }
    return;
  }

  const t2 = await phantom.translate.text({ text: original, from, to });
  const translated = (t2.text || '').trim();
  if (placeholder) {
    placeholder.classList.remove('pending');
    placeholder.querySelector('.tr').textContent = translated || original;
    translateOutput.scrollTop = translateOutput.scrollHeight;
  }
}

function addTranslateLine(src, tr) {
  const line = document.createElement('div');
  line.className = 'translate-line';
  if (src) {
    const s = document.createElement('div');
    s.className = 'src';
    s.textContent = src;
    line.appendChild(s);
  }
  const t = document.createElement('div');
  t.className = 'tr';
  t.textContent = tr;
  line.appendChild(t);
  translateOutput.appendChild(line);
  translateOutput.scrollTop = translateOutput.scrollHeight;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── Interview Mode (escuchar al entrevistador + responder como vos) ──
const interview = {
  active: false,
  stream: null,
  recorder: null,
  cycleTimer: null,
  silenceTimer: null,
  CHUNK_MS: 2500,
  buffer: '',                // texto acumulado de transcripciones
  lastTranscriptionAt: 0,
  history: [],               // [{q, a}] — contexto de Q&A previas en la sesión
  pendingAnswer: null,       // promise activa de respuesta (para cancelar si llega nueva)
  lastQuestion: ''
};

const btnInterview = $('btn-interview-toggle');
const btnRegenerate = $('btn-interview-regenerate');
const interviewPanel = $('interview-panel');
const interviewQuestionEl = $('interview-question-text');
const interviewAnswerEl = $('interview-answer-text');
const interviewStatusEl = $('interview-status');
const interviewHistoryWrap = $('interview-history-wrap');
const interviewHistoryEl = $('interview-history');

btnInterview.addEventListener('click', () => {
  if (interview.active) stopInterview();
  else startInterview();
});

btnRegenerate.addEventListener('click', () => {
  if (interview.lastQuestion) {
    answerInterviewQuestion(interview.lastQuestion);
  }
});

function applyInterviewPanelVisibility(on) {
  interviewPanel.style.display = on ? 'flex' : 'none';
  document.body.classList.toggle('interviewing', on);
  if (on) {
    phantom.window.resize({ width: 640, height: 780 });
  } else if (!$('cfg-translate').checked) {
    // Solo achicar si traducción tampoco está activa
    phantom.window.resize({ width: 420, height: 600 });
  }
  if (!on && interview.active) stopInterview();
}

async function startInterview() {
  expandPanel('interview-panel');
  const cfg = await phantom.config.get();
  if (!cfg.openaiKey) {
    setStatus('⚠ Falta OpenAI key en settings (para Whisper).', 'err');
    return;
  }
  if (!cfg.interviewCV || cfg.interviewCV.length < 30) {
    setStatus('⚠ Cargá tu CV en settings antes de empezar.', 'err');
    $('settings-panel').style.display = 'flex';
    return;
  }
  try {
    setStatus('Pidiendo audio del sistema…', 'busy');
    interview.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 },
      audio: true
    });
    interview.stream.getVideoTracks().forEach(t => t.stop());

    if (interview.stream.getAudioTracks().length === 0) {
      throw new Error('No se obtuvo audio. ¿Aceptaste compartir audio?');
    }

    interview.active = true;
    interview.buffer = '';
    interview.history = [];
    interview.lastTranscriptionAt = Date.now();
    btnInterview.textContent = 'Detener';
    interviewStatusEl.classList.add('live');
    interviewQuestionEl.textContent = '🎙️ Escuchando…';
    interviewAnswerEl.textContent = 'Te muestro la respuesta cuando detecte una pregunta.';
    interviewAnswerEl.classList.add('pending');
    btnRegenerate.style.display = 'none';
    setStatus('Modo entrevista activo. Escuchando…', 'ok');

    runInterviewCycle();
  } catch (err) {
    console.error('startInterview:', err);
    setStatus('⚠ ' + err.message, 'err');
    stopInterview();
  }
}

function stopInterview() {
  interview.active = false;
  btnInterview.textContent = 'Iniciar';
  interviewStatusEl.classList.remove('live');

  if (interview.recorder && interview.recorder.state !== 'inactive') {
    try { interview.recorder.stop(); } catch {}
  }
  interview.recorder = null;
  if (interview.cycleTimer) { clearTimeout(interview.cycleTimer); interview.cycleTimer = null; }
  if (interview.silenceTimer) { clearTimeout(interview.silenceTimer); interview.silenceTimer = null; }
  if (interview.stream) {
    interview.stream.getTracks().forEach(t => t.stop());
    interview.stream = null;
  }
}

async function runInterviewCycle() {
  if (!interview.active || !interview.stream) return;

  const audioStream = new MediaStream(interview.stream.getAudioTracks());
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');

  const chunks = [];
  const recorder = new MediaRecorder(audioStream, { mimeType });
  interview.recorder = recorder;

  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = async () => {
    if (interview.active) runInterviewCycle();
    if (chunks.length === 0) return;

    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuf);

    try {
      const t = await phantom.translate.transcribe({ audioBase64: base64, mimeType, language: 'auto' });
      const piece = (t.text || '').trim();
      if (!piece || piece.length < 2) {
        // Silencio: si había buffer acumulado, considerar fin de pregunta
        checkBufferForQuestion(true);
        return;
      }

      // Acumular al buffer
      interview.buffer = (interview.buffer + ' ' + piece).trim();
      interview.lastTranscriptionAt = Date.now();
      interviewQuestionEl.textContent = '🎙️ ' + interview.buffer.slice(-200);
      checkBufferForQuestion(false);
    } catch (err) {
      console.error('Whisper interview:', err);
    }
  };

  recorder.start();
  interview.cycleTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
  }, interview.CHUNK_MS);
}

// Decide si el buffer parece ser una pregunta completa lista para contestar.
// Se gatilla si:
//  - Termina con "?" o ".!" (oración cerrada)
//  - Hubo silencio (último chunk vacío + buffer no vacío)
//  - El buffer pasa los 25 segundos (timeout duro)
function checkBufferForQuestion(silenceDetected) {
  const buf = interview.buffer.trim();
  if (!buf || buf.length < 5) return;

  const endsWithQ = /[?¿]\s*$/.test(buf);
  const endsWithPunct = /[.!?]\s*$/.test(buf);
  const tooLong = buf.length > 600;

  if (endsWithQ || (silenceDetected && (endsWithPunct || buf.length > 30)) || tooLong) {
    const question = buf;
    interview.buffer = ''; // reset para próxima pregunta
    answerInterviewQuestion(question);
  }
}

async function answerInterviewQuestion(question) {
  interview.lastQuestion = question;
  interviewQuestionEl.textContent = question;
  interviewAnswerEl.classList.add('pending');
  interviewAnswerEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  btnRegenerate.style.display = 'none';

  try {
    const resp = await phantom.interview.answer({
      question,
      conversationContext: interview.history
    });
    const answer = (resp.text || '').trim();

    interviewAnswerEl.classList.remove('pending');
    interviewAnswerEl.textContent = answer || '(sin respuesta)';
    btnRegenerate.style.display = 'inline-block';

    interview.history.push({ q: question, a: answer });
    addInterviewHistoryItem(question, answer);
  } catch (err) {
    interviewAnswerEl.classList.remove('pending');
    interviewAnswerEl.innerHTML = '<span style="color:#dc2626;">⚠ ' + escapeHTML(err.message) + '</span>';
  }
}

function addInterviewHistoryItem(q, a) {
  interviewHistoryWrap.style.display = 'block';
  const item = document.createElement('div');
  item.className = 'ih-item';
  item.innerHTML = `<div class="ih-q">${escapeHTML(q)}</div><div class="ih-a">${escapeHTML(a)}</div>`;
  interviewHistoryEl.insertBefore(item, interviewHistoryEl.firstChild);
}

// ─── Modo Manual de Grabación (grabás vos + pedís respuesta) ──
const manualRec = {
  active: false,
  stream: null,
  recorder: null,
  chunks: [],
  mimeType: '',
  startTime: 0,
  timerInterval: null
};

const btnManualRecord = $('btn-manual-record');
const btnManualAnswer = $('btn-manual-answer');
const btnManualDiscard = $('btn-manual-discard');
const manualRecBar = $('manual-rec-bar');
const manualTranscriptionSection = $('manual-transcription');
const manualTranscriptionText = $('manual-transcription-text');
const recTimerEl = $('rec-timer');

btnManualRecord.addEventListener('click', () => {
  if (manualRec.active) stopManualRecording();
  else startManualRecording();
});

btnManualAnswer.addEventListener('click', () => {
  const q = manualTranscriptionText.value.trim();
  if (!q) {
    setStatus('⚠ La transcripción está vacía.', 'err');
    return;
  }
  manualTranscriptionSection.style.display = 'none';
  answerInterviewQuestion(q);
});

btnManualDiscard.addEventListener('click', () => {
  manualTranscriptionSection.style.display = 'none';
  manualTranscriptionText.value = '';
});

async function startManualRecording() {
  expandPanel('interview-panel');
  const cfg = await phantom.config.get();
  if (!cfg.openaiKey) {
    setStatus('⚠ Falta OpenAI key en settings (para Whisper).', 'err');
    return;
  }
  if (!cfg.interviewCV || cfg.interviewCV.length < 30) {
    setStatus('⚠ Cargá tu CV en settings antes de empezar.', 'err');
    $('settings-panel').style.display = 'flex';
    return;
  }
  // Si el modo auto está corriendo, detenerlo para no competir por el audio
  if (interview.active) stopInterview();

  try {
    manualRec.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 },
      audio: true
    });
    manualRec.stream.getVideoTracks().forEach(t => t.stop());

    if (manualRec.stream.getAudioTracks().length === 0) {
      throw new Error('No se obtuvo audio. ¿Aceptaste compartir audio?');
    }

    const audioStream = new MediaStream(manualRec.stream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');
    manualRec.mimeType = mimeType;
    manualRec.chunks = [];

    const recorder = new MediaRecorder(audioStream, { mimeType });
    manualRec.recorder = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size > 0) manualRec.chunks.push(e.data); };
    recorder.onstop = () => processManualRecording();
    recorder.start();

    manualRec.active = true;
    manualRec.startTime = Date.now();
    btnManualRecord.classList.add('recording');
    btnManualRecord.textContent = '⏹ Detener';
    manualRecBar.style.display = 'flex';
    manualTranscriptionSection.style.display = 'none';

    // Timer
    updateRecTimer();
    manualRec.timerInterval = setInterval(updateRecTimer, 250);
    setStatus('🔴 Grabando…', 'busy');
  } catch (err) {
    console.error('startManualRecording:', err);
    setStatus('⚠ ' + err.message, 'err');
    cleanupManualRecording();
  }
}

function updateRecTimer() {
  const sec = Math.floor((Date.now() - manualRec.startTime) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  recTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function stopManualRecording() {
  if (!manualRec.recorder || manualRec.recorder.state === 'inactive') return;
  try { manualRec.recorder.stop(); } catch {}
}

function cleanupManualRecording() {
  manualRec.active = false;
  btnManualRecord.classList.remove('recording');
  btnManualRecord.textContent = '🔴 Grabar';
  manualRecBar.style.display = 'none';
  if (manualRec.timerInterval) { clearInterval(manualRec.timerInterval); manualRec.timerInterval = null; }
  if (manualRec.stream) {
    manualRec.stream.getTracks().forEach(t => t.stop());
    manualRec.stream = null;
  }
  manualRec.recorder = null;
}

async function processManualRecording() {
  const chunks = manualRec.chunks;
  const mimeType = manualRec.mimeType;
  const duration = (Date.now() - manualRec.startTime) / 1000;
  cleanupManualRecording();

  if (chunks.length === 0 || duration < 1) {
    setStatus('⚠ Grabación muy corta.', 'err');
    return;
  }

  // Mostrar la sección con "transcribiendo…"
  manualTranscriptionSection.style.display = 'flex';
  manualTranscriptionText.value = '';
  manualTranscriptionText.placeholder = '⏳ Transcribiendo…';
  btnManualAnswer.disabled = true;
  setStatus('Transcribiendo grabación…', 'busy');

  try {
    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuf);

    const t = await phantom.translate.transcribe({
      audioBase64: base64,
      mimeType,
      language: 'auto'
    });
    const text = (t.text || '').trim();

    manualTranscriptionText.value = text || '';
    manualTranscriptionText.placeholder = text ? '' : '(no se detectó habla)';
    btnManualAnswer.disabled = !text;
    setStatus(text ? '✓ Transcripción lista — editá si querés y dale a "Contestar".' : '⚠ Sin texto detectado.', text ? 'ok' : 'err');
  } catch (err) {
    console.error('Transcribe manual:', err);
    manualTranscriptionText.placeholder = '⚠ ' + err.message;
    btnManualAnswer.disabled = false;
    setStatus('⚠ ' + err.message, 'err');
  }
}

function setDanger(on) {
  card.classList.toggle('danger', on);
  let banner = document.querySelector('.danger-banner');
  if (on && !banner) {
    banner = document.createElement('div');
    banner.className = 'danger-banner';
    banner.innerHTML = `<b>⚠ ALERTA DE PHISHING / ESTAFA</b><br/>NO clickees enlaces, NO ingreses datos. Eliminá el correo y bloqueá al remitente.`;
    const body = document.querySelector('.body');
    body.insertBefore(banner, body.firstChild);
  } else if (!on && banner) {
    banner.remove();
  }
}
