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

// ─── System prompts (dinámicos según idioma de la UI) ───────────
const LANG_NAMES = {
  es: 'Spanish', en: 'English', pt: 'Portuguese',
  fr: 'French',  ja: 'Japanese', zh: 'Chinese'
};

const SECURITY_RULE = `SECURITY: If you detect phishing, scam, fraud or deception, begin your reply with the marker on a line by itself:
[[PHISHING_DETECTED]]
then briefly explain why, what to do (don't click, delete, block, report) and the warning signs.`;

function getSystemPrompt(action) {
  // El idioma viene del selector de UI (i18n.js → getLanguage())
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const langName = LANG_NAMES[uiLang] || 'Spanish';

  const langRule = `🌐 LANGUAGE — CRITICAL: Reply ALWAYS in ${langName} (${uiLang}), regardless of what language is shown in the screenshot or the user's previous messages. The user's app interface is set to ${langName}, so they expect responses in ${langName}.`;

  if (action === 'resumir') {
    return `You are an assistant that receives a screenshot of the user's screen and returns a clear, concise summary.
Structure: central topic (1 sentence), key points (3-5 bullets), conclusion if applicable.
Don't make up data.

${langRule}

${SECURITY_RULE}`;
  }
  return `You are an expert assistant that receives a screenshot of the user's screen and must answer or solve what is shown.
If there's an explicit question, answer directly.
If there's a problem (exercise, calculation, code, decision), solve it step by step.
If there are multiple-choice options, indicate the correct one and why.
Don't pad. If info is missing to solve, say so.

${langRule}

${SECURITY_RULE}`;
}

// User prompts (también en el idioma de la UI para no contaminar al modelo con español)
function getUserPrompt(action) {
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const prompts = {
    es: { resumir: 'Resumí lo que se ve en esta captura.', responder: 'Identificá la pregunta o problema visible en esta captura y resolvelo.' },
    en: { resumir: 'Summarize what is shown in this screenshot.', responder: 'Identify the question or problem visible in this screenshot and solve it.' },
    pt: { resumir: 'Resuma o que está visível nesta captura.', responder: 'Identifique a pergunta ou problema visível nesta captura e resolva.' },
    fr: { resumir: "Résumez ce qui est visible dans cette capture d'écran.", responder: "Identifiez la question ou le problème visible dans cette capture d'écran et résolvez-le." },
    ja: { resumir: 'このスクリーンショットに表示されている内容を要約してください。', responder: 'このスクリーンショットに表示されている質問または問題を特定し、解決してください。' },
    zh: { resumir: '总结此截图中显示的内容。', responder: '识别此截图中的问题并解决它。' }
  };
  return (prompts[uiLang] || prompts.es)[action];
}

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
  $('cfg-deepgram-key').value = cfg.deepgramKey || '';
  $('cfg-openai-key').value = cfg.openaiKey || '';
  $('cfg-translate-from').value = cfg.translateFrom || 'auto';
  $('cfg-translate-to').value = cfg.translateTo || 'es';
  // Interview
  $('cfg-interview').checked = !!cfg.interviewEnabled;
  $('cfg-interview-cv').value = cfg.interviewCV || '';
  $('cfg-interview-context').value = cfg.interviewContext || '';
  $('cfg-interview-style').value = cfg.interviewStyle || 'complete';
  $('cfg-interview-language').value = cfg.interviewLanguage || 'auto';
  // Trading
  $('cfg-trading').checked = !!cfg.tradingEnabled;
  $('cfg-trading-model').value = cfg.tradingModel || '';
  $('cfg-exchange-provider').value = cfg.exchangeProvider || '';
  $('cfg-exchange-key').value = cfg.exchangeKey || '';
  $('cfg-exchange-secret').value = cfg.exchangeSecret || '';
  $('cfg-exchange-passphrase').value = cfg.exchangePassphrase || '';
  updateExchangeKeysVisibility(cfg.exchangeProvider || '');
  applyTranslatePanelVisibility(!!cfg.translateEnabled);
  applyInterviewPanelVisibility(!!cfg.interviewEnabled);
  applyTradingPanelVisibility(!!cfg.tradingEnabled);
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
    deepgramKey: $('cfg-deepgram-key').value.trim(),
    openaiKey: $('cfg-openai-key').value.trim(),
    translateEnabled: $('cfg-translate').checked,
    translateFrom: $('cfg-translate-from').value,
    translateTo: $('cfg-translate-to').value,
    interviewEnabled: $('cfg-interview').checked,
    interviewCV: $('cfg-interview-cv').value.trim(),
    interviewContext: $('cfg-interview-context').value.trim(),
    interviewStyle: $('cfg-interview-style').value,
    interviewLanguage: $('cfg-interview-language').value,
    tradingEnabled: $('cfg-trading').checked,
    tradingModel: $('cfg-trading-model').value,
    exchangeProvider: $('cfg-exchange-provider').value,
    exchangeKey: $('cfg-exchange-key').value.trim(),
    exchangeSecret: $('cfg-exchange-secret').value.trim(),
    exchangePassphrase: $('cfg-exchange-passphrase').value.trim()
  };
  await phantom.config.set(cfg);
  await phantom.window.setContentProtection(cfg.stealth);
  applyTranslatePanelVisibility(cfg.translateEnabled);
  applyInterviewPanelVisibility(cfg.interviewEnabled);
  applyTradingPanelVisibility(cfg.tradingEnabled);
  updateTranslateLangLabel();
  setStatus('Configuración guardada.', 'ok');
});

$('cfg-interview').addEventListener('change', (e) => {
  applyInterviewPanelVisibility(e.target.checked);
});

// Cargar CV desde archivo (PDF / DOCX / TXT / MD) via dialog nativo de macOS
$('cfg-upload-cv').addEventListener('click', async () => {
  try {
    setStatus(t('status.parsing_cv'), 'busy');
    const result = await phantom.interview.pickCV();
    if (result && result.canceled) {
      setStatus(t('status.initial'), 'ok');
      return;
    }
    if (!result || !result.text) {
      throw new Error('No se pudo extraer texto del archivo.');
    }
    $('cfg-interview-cv').value = result.text;
    const kb = (result.text.length / 1024).toFixed(1);
    setStatus(`✓ ${result.filename} — ${kb} KB`, 'ok');
  } catch (err) {
    setStatus('⚠ ' + err.message, 'err');
  }
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
    if (e.target.closest('button, select, input, textarea, .interview-controls, .translate-controls, .trading-controls')) return;
    const panel = header.closest('.collapsible-panel');
    const wasOpen = !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    saveCollapsedState();

    // Si se colapsa un panel, limpiar su conversación y resultados
    if (wasOpen) {
      const panelId = panel.id;
      const panelModeMap = {
        'trading-panel': 'trading',
        'interview-panel': 'interview',
        'translate-panel': 'translate'
      };
      const panelMode = panelModeMap[panelId];

      // Limpiar chat si pertenece a este panel
      if (panelMode && state.mode === panelMode) {
        state.messages = [];
        state.mode = null;
        conversationEl.innerHTML = '';
        chatWrap.style.display = 'none';
        setDanger(false);
      }

      // Limpiar resultado interno del panel de trading
      if (panelId === 'trading-panel') {
        const tradingResult = $('trading-result');
        const tradingResultText = $('trading-result-text');
        if (tradingResult) tradingResult.style.display = 'none';
        if (tradingResultText) tradingResultText.innerHTML = '';
      }
    }
  });
});

function saveCollapsedState() {
  const state = {
    interview: document.getElementById('interview-panel')?.classList.contains('collapsed') || false,
    translate: document.getElementById('translate-panel')?.classList.contains('collapsed') || false,
    trading: document.getElementById('trading-panel')?.classList.contains('collapsed') || false
  };
  localStorage.setItem('phantom_collapsed', JSON.stringify(state));
}

function restoreCollapsedState() {
  try {
    const state = JSON.parse(localStorage.getItem('phantom_collapsed') || '{}');
    if (state.interview) document.getElementById('interview-panel')?.classList.add('collapsed');
    if (state.translate) document.getElementById('translate-panel')?.classList.add('collapsed');
    if (state.trading) document.getElementById('trading-panel')?.classList.add('collapsed');
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

  setStatus(t(action === 'resumir' ? 'status.capturing_summarize' : 'status.capturing_answer'), 'busy');
  addMessage('user', t(action === 'resumir' ? 'msg.user_summarize' : 'msg.user_answer'));
  const loading = addMessage('assistant', '', true);

  try {
    const screenshot = await captureScreen();
    if (!screenshot) throw new Error('No se pudo capturar la pantalla');

    const userPrompt = getUserPrompt(action);

    const messages = [{
      role: 'user',
      content: await buildContent(userPrompt, screenshot)
    }];

    const system = getSystemPrompt(action);
    const resp = await phantom.ai.call({ messages, system });

    const phishing = detectPhishing(resp.text);
    const reply = stripPhishingMarker(resp.text);
    loading.classList.remove('loading');
    loading.innerHTML = renderMarkdown(reply);

    state.messages.push({ role: 'user', content: userPrompt });
    state.messages.push({ role: 'assistant', content: reply });

    setDanger(phishing);
    chatWrap.style.display = 'flex';
    setStatus(
      phishing ? t('status.phishing_detected')
               : t(action === 'resumir' ? 'status.summary_ready' : 'status.answer_ready'),
      phishing ? 'err' : 'ok'
    );
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
  setStatus(t('status.thinking'), 'busy');

  state.messages.push({ role: 'user', content: q });

  try {
    const screenshot = await captureScreen();

    // Re-inyectar imagen en el último user para que el modelo vea el estado actual
    const messagesForAPI = state.messages.slice(0, -1);
    messagesForAPI.push({
      role: 'user',
      content: await buildContent(q, screenshot)
    });

    let exchangeCtx = '';
    if (state.mode === 'trading') {
      const exData = await fetchExchangeData();
      exchangeCtx = formatExchangeDataForPrompt(exData);
    }
    const system = state.mode === 'trading' ? getTradingSystemPrompt(exchangeCtx) : getSystemPrompt(state.mode || 'responder');
    let aiPayload = { messages: messagesForAPI, system };
    if (state.mode === 'trading') {
      const tradingCfg = await phantom.config.get();
      if (tradingCfg.tradingModel) aiPayload.model = tradingCfg.tradingModel;
      aiPayload.maxTokens = 4096;
    }
    const resp = await phantom.ai.call(aiPayload);

    const phishing = detectPhishing(resp.text);
    const reply = stripPhishingMarker(resp.text);
    loading.classList.remove('loading');
    loading.innerHTML = state.mode === 'trading' ? renderTradingMarkdown(reply) : renderMarkdown(reply);
    state.messages.push({ role: 'assistant', content: reply });

    if (phishing) setDanger(true);
    setStatus(phishing ? t('status.phishing_detected') : t('status.done'), phishing ? 'err' : 'ok');
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
  // Scroll the body container to bottom so user sees latest content
  const bodyEl = document.querySelector('.body');
  if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  return wrap;
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  // 1) Extraer bloques de código ```lang\n...\n``` antes de procesar el resto,
  //    así no se les aplica markdown inline ni se escapa mal.
  const codeBlocks = [];
  text = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || 'code').toLowerCase(), code: code.replace(/^\n+|\n+$/g, '') });
    return `__CODE_BLOCK_${idx}__`;
  });
  // También soportar bloques con `` doble (a veces los modelos los devuelven así)
  text = text.replace(/``([\s\S]*?)``/g, (m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: 'code', code: code.replace(/^\n+|\n+$/g, '') });
    return `__CODE_BLOCK_${idx}__`;
  });

  const escaped = escapeHTML(text);
  let html = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  html = '<p>' + html + '</p>';

  // 2) Reinsertar los bloques de código como elementos separados (fuera del <p>)
  html = html.replace(/__CODE_BLOCK_(\d+)__/g, (m, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    const id = 'code-' + Math.random().toString(36).slice(2, 10);
    const copyLabel = (typeof t === 'function') ? t('chat.copy') : 'Copy';
    return `</p><div class="code-block">
        <div class="code-block-header">
          <span class="code-block-lang">${escapeHTML(lang)}</span>
          <button class="code-copy-btn" data-copy-target="${id}">📋 <span class="copy-label">${escapeHTML(copyLabel)}</span></button>
        </div>
        <pre class="code-block-pre" id="${id}">${escapeHTML(code)}</pre>
      </div><p>`;
  });

  // Limpiar <p></p> vacíos que pueden quedar alrededor de los bloques
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

// ─── Chart Pattern SVG Illustrations ────────────────────────────
const PATTERN_SVGS = {
  bull_flag: {
    name: 'Bull Flag',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,85 40,60 50,65 80,25" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round"/>
      <rect x="78" y="22" width="50" height="30" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4,3" rx="2" opacity="0.5"/>
      <polyline points="80,25 90,35 95,30 100,38 110,33 115,37 125,32 128,35" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round"/>
      <polyline points="128,35 155,15 165,20 190,5" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="100" y="65" font-size="9" fill="#22c55e" font-weight="600" text-anchor="middle" opacity="0.7">BREAKOUT ↗</text>
      <polygon points="188,3 192,0 190,7" fill="#22c55e"/>
    </svg>`
  },
  bear_flag: {
    name: 'Bear Flag',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,15 40,40 50,35 80,75" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round"/>
      <rect x="78" y="50" width="50" height="30" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3" rx="2" opacity="0.5"/>
      <polyline points="80,75 90,65 95,70 100,62 110,67 115,63 125,68 128,65" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round"/>
      <polyline points="128,65 155,85 165,80 190,95" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="100" y="95" font-size="9" fill="#ef4444" font-weight="600" text-anchor="middle" opacity="0.7">BREAKDOWN ↘</text>
      <polygon points="188,97 192,100 190,93" fill="#ef4444"/>
    </svg>`
  },
  ascending_triangle: {
    name: 'Ascending Triangle',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="25" x2="180" y2="25" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="10,90 45,60 55,70 85,45 95,55 125,35 135,42 165,28 175,25" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <polyline points="175,25 190,10" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <polygon points="188,8 192,5 190,13" fill="#22c55e"/>
      <text x="120" y="18" font-size="9" fill="#94a3b8" font-weight="600">RESISTANCE</text>
      <text x="50" y="85" font-size="9" fill="#22c55e" font-weight="600" opacity="0.7">HIGHER LOWS</text>
    </svg>`
  },
  descending_triangle: {
    name: 'Descending Triangle',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="75" x2="180" y2="75" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="10,10 45,40 55,30 85,55 95,45 125,65 135,58 165,72 175,75" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <polyline points="175,75 190,90" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <polygon points="188,92 192,95 190,87" fill="#ef4444"/>
      <text x="120" y="90" font-size="9" fill="#94a3b8" font-weight="600">SUPPORT</text>
      <text x="50" y="22" font-size="9" fill="#ef4444" font-weight="600" opacity="0.7">LOWER HIGHS</text>
    </svg>`
  },
  double_top: {
    name: 'Double Top',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,80 35,50 55,15 75,45 95,50 115,15 135,50 160,80" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <line x1="55" y1="15" x2="115" y2="15" stroke="#ef4444" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
      <line x1="35" y1="50" x2="160" y2="50" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="160,80 175,90 190,95" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="85" y="10" font-size="8" fill="#ef4444" font-weight="700" text-anchor="middle">M</text>
      <text x="100" y="62" font-size="8" fill="#94a3b8" font-weight="600" text-anchor="middle">NECKLINE</text>
    </svg>`
  },
  double_bottom: {
    name: 'Double Bottom',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,20 35,50 55,85 75,55 95,50 115,85 135,50 160,20" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <line x1="55" y1="85" x2="115" y2="85" stroke="#22c55e" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
      <line x1="35" y1="50" x2="160" y2="50" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="160,20 175,10 190,5" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="85" y="98" font-size="8" fill="#22c55e" font-weight="700" text-anchor="middle">W</text>
      <text x="100" y="45" font-size="8" fill="#94a3b8" font-weight="600" text-anchor="middle">NECKLINE</text>
    </svg>`
  },
  head_shoulders: {
    name: 'Head & Shoulders',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,75 30,55 45,30 60,55 80,50 100,10 120,50 140,55 155,30 170,55 190,75" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <line x1="30" y1="55" x2="170" y2="55" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <text x="45" y="25" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">LS</text>
      <text x="100" y="7" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">HEAD</text>
      <text x="155" y="25" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">RS</text>
      <text x="100" y="68" font-size="8" fill="#94a3b8" font-weight="600" text-anchor="middle">NECKLINE</text>
    </svg>`
  },
  inv_head_shoulders: {
    name: 'Inverse H&S',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,25 30,45 45,70 60,45 80,50 100,90 120,50 140,45 155,70 170,45 190,25" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <line x1="30" y1="45" x2="170" y2="45" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <text x="45" y="82" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">LS</text>
      <text x="100" y="99" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">HEAD</text>
      <text x="155" y="82" font-size="7" fill="#64748b" font-weight="600" text-anchor="middle">RS</text>
      <text x="100" y="38" font-size="8" fill="#94a3b8" font-weight="600" text-anchor="middle">NECKLINE</text>
    </svg>`
  },
  rising_wedge: {
    name: 'Rising Wedge',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="90" x2="170" y2="20" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <line x1="10" y1="60" x2="170" y2="25" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="10,85 35,55 50,70 75,40 90,55 115,30 130,42 155,25 170,22" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <polyline points="170,22 180,50 190,85" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="100" y="95" font-size="9" fill="#ef4444" font-weight="600" text-anchor="middle" opacity="0.7">BEARISH ↘</text>
    </svg>`
  },
  falling_wedge: {
    name: 'Falling Wedge',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="10" x2="170" y2="80" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <line x1="10" y1="40" x2="170" y2="75" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="10,15 35,45 50,30 75,60 90,50 115,70 130,62 155,75 170,78" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <polyline points="170,78 180,50 190,15" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="100" y="95" font-size="9" fill="#22c55e" font-weight="600" text-anchor="middle" opacity="0.7">BULLISH ↗</text>
    </svg>`
  },
  cup_handle: {
    name: 'Cup & Handle',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <path d="M10,20 Q15,20 25,45 Q50,90 100,90 Q150,90 175,45 Q180,30 180,20" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M180,20 Q182,25 183,32 Q185,38 186,32 Q188,25 188,22" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round"/>
      <line x1="10" y1="20" x2="195" y2="20" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="188,22 192,10 196,5" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="6,3"/>
      <text x="100" y="80" font-size="9" fill="#22c55e" font-weight="600" text-anchor="middle" opacity="0.7">CUP</text>
      <text x="184" y="45" font-size="7" fill="#22c55e" font-weight="600" text-anchor="middle" opacity="0.7">H</text>
    </svg>`
  },
  channel_up: {
    name: 'Ascending Channel',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 110" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="85" x2="185" y2="30" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.5"/>
      <line x1="10" y1="60" x2="185" y2="8" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.5"/>
      <polyline points="10,82 30,58 50,75 70,50 90,65 110,42 130,55 150,35 170,48 185,30" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <text x="100" y="105" font-size="9" fill="#22c55e" font-weight="600" text-anchor="middle" opacity="0.7">UPTREND CHANNEL</text>
    </svg>`
  },
  channel_down: {
    name: 'Descending Channel',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 110" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="15" x2="180" y2="65" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.5"/>
      <line x1="10" y1="40" x2="180" y2="88" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.5"/>
      <polyline points="10,18 30,42 50,25 70,50 90,35 110,58 130,45 150,62 170,52 180,67" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <text x="100" y="105" font-size="9" fill="#ef4444" font-weight="600" text-anchor="middle" opacity="0.7">DOWNTREND CHANNEL</text>
    </svg>`
  },
  symmetrical_triangle: {
    name: 'Symmetrical Triangle',
    color: '#d97706',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="10" y1="15" x2="165" y2="48" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <line x1="10" y1="85" x2="165" y2="52" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/>
      <polyline points="10,18 30,78 50,25 75,70 95,35 120,62 140,42 160,52" stroke="#d97706" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <polyline points="160,52 175,30 190,10" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="5,3"/>
      <polyline points="160,52 175,70 190,90" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="5,3"/>
      <text x="185" y="8" font-size="7" fill="#22c55e" font-weight="700">↗</text>
      <text x="185" y="98" font-size="7" fill="#ef4444" font-weight="700">↘</text>
      <text x="85" y="98" font-size="8" fill="#d97706" font-weight="600" text-anchor="middle" opacity="0.7">BREAKOUT PENDING</text>
    </svg>`
  },
  engulfing_bull: {
    name: 'Bullish Engulfing',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="70" y1="20" x2="70" y2="90" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" opacity="0.3"/>
      <rect x="55" y="35" width="12" height="35" fill="#ef4444" rx="1" stroke="#b91c1c" stroke-width="1"/>
      <line x1="61" y1="25" x2="61" y2="35" stroke="#ef4444" stroke-width="1.5"/>
      <line x1="61" y1="70" x2="61" y2="80" stroke="#ef4444" stroke-width="1.5"/>
      <rect x="75" y="25" width="18" height="50" fill="#22c55e" rx="1" stroke="#16a34a" stroke-width="1"/>
      <line x1="84" y1="15" x2="84" y2="25" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="84" y1="75" x2="84" y2="85" stroke="#22c55e" stroke-width="1.5"/>
      <polyline points="105,50 125,35 145,25 165,15" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="5,3"/>
      <polygon points="163,13 168,10 165,18" fill="#22c55e"/>
      <text x="140" y="45" font-size="8" fill="#22c55e" font-weight="600" opacity="0.7">REVERSAL ↗</text>
    </svg>`
  },
  engulfing_bear: {
    name: 'Bearish Engulfing',
    color: '#ef4444',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <line x1="70" y1="10" x2="70" y2="90" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" opacity="0.3"/>
      <rect x="55" y="30" width="12" height="35" fill="#22c55e" rx="1" stroke="#16a34a" stroke-width="1"/>
      <line x1="61" y1="20" x2="61" y2="30" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="61" y1="65" x2="61" y2="75" stroke="#22c55e" stroke-width="1.5"/>
      <rect x="75" y="20" width="18" height="50" fill="#ef4444" rx="1" stroke="#b91c1c" stroke-width="1"/>
      <line x1="84" y1="12" x2="84" y2="20" stroke="#ef4444" stroke-width="1.5"/>
      <line x1="84" y1="70" x2="84" y2="80" stroke="#ef4444" stroke-width="1.5"/>
      <polyline points="105,50 125,65 145,75 165,85" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="5,3"/>
      <polygon points="163,87 168,90 165,82" fill="#ef4444"/>
      <text x="140" y="60" font-size="8" fill="#ef4444" font-weight="600" opacity="0.7">REVERSAL ↘</text>
    </svg>`
  },
  hammer: {
    name: 'Hammer (Bullish)',
    color: '#22c55e',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="20,20 50,40 70,35 90,50" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round"/>
      <line x1="100" y1="30" x2="100" y2="42" stroke="#22c55e" stroke-width="1.5"/>
      <rect x="93" y="42" width="14" height="12" fill="#22c55e" rx="1" stroke="#16a34a" stroke-width="1"/>
      <line x1="100" y1="54" x2="100" y2="85" stroke="#22c55e" stroke-width="1.5"/>
      <polyline points="110,48 130,35 150,25 170,15" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="5,3"/>
      <polygon points="168,13 173,10 170,18" fill="#22c55e"/>
      <text x="100" y="97" font-size="8" fill="#22c55e" font-weight="700" text-anchor="middle">HAMMER</text>
    </svg>`
  },
  doji: {
    name: 'Doji (Indecision)',
    color: '#d97706',
    svg: `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <polyline points="20,30 50,45 70,40 85,48" stroke="#64748b" stroke-width="2" fill="none" stroke-linecap="round"/>
      <line x1="100" y1="20" x2="100" y2="48" stroke="#d97706" stroke-width="1.5"/>
      <rect x="94" y="48" width="12" height="3" fill="#d97706" rx="0.5" stroke="#b45309" stroke-width="1"/>
      <line x1="100" y1="51" x2="100" y2="80" stroke="#d97706" stroke-width="1.5"/>
      <polyline points="115,42 135,30 155,20" stroke="#22c55e" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-dasharray="4,3" opacity="0.6"/>
      <polyline points="115,55 135,65 155,78" stroke="#ef4444" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-dasharray="4,3" opacity="0.6"/>
      <text x="165" y="18" font-size="7" fill="#22c55e" font-weight="600">?</text>
      <text x="165" y="82" font-size="7" fill="#ef4444" font-weight="600">?</text>
      <text x="100" y="97" font-size="8" fill="#d97706" font-weight="700" text-anchor="middle">DOJI</text>
    </svg>`
  }
};

function buildPatternCard(patternId, caption) {
  const p = PATTERN_SVGS[patternId];
  if (!p) return '';
  const safeCaption = caption ? escapeHTML(caption) : '';
  return `<div class="pattern-card" style="border-color:${p.color}20">
    <div class="pattern-card-header" style="background:${p.color}12;color:${p.color}">
      📐 ${escapeHTML(p.name)}
    </div>
    <div class="pattern-card-svg">${p.svg}</div>
    ${safeCaption ? `<div class="pattern-card-caption">${safeCaption}</div>` : ''}
  </div>`;
}

// ─── Trading-specific markdown with generative UI (colors, bars, cards) ──
function renderTradingMarkdown(text) {
  // 1. Extract special trading blocks BEFORE markdown processing
  const tradingBlocks = [];

  // Extract BIAS_BAR
  text = text.replace(/\[BIAS_BAR\]\s*([\s\S]*?)\s*\[\/BIAS_BAR\]/gi, (m, content) => {
    const longMatch = content.match(/LONG:\s*(\d+)%/i);
    const shortMatch = content.match(/SHORT:\s*(\d+)%/i);
    const longPct = longMatch ? parseInt(longMatch[1]) : 50;
    const shortPct = shortMatch ? parseInt(shortMatch[1]) : 50;
    const idx = tradingBlocks.length;
    tradingBlocks.push(`<div class="trade-bias-bar">
      <div class="bias-label-wrap">
        <span class="bias-label long-label">🟢 LONG ${longPct}%</span>
        <span class="bias-label short-label">🔴 SHORT ${shortPct}%</span>
      </div>
      <div class="bias-track">
        <div class="bias-fill bias-long" style="width:${longPct}%"></div>
        <div class="bias-fill bias-short" style="width:${shortPct}%"></div>
      </div>
    </div>`);
    return `__TRADE_BLOCK_${idx}__`;
  });

  // Extract TRADE_LONG
  text = text.replace(/\[TRADE_LONG\]\s*([\s\S]*?)\s*\[\/TRADE_LONG\]/gi, (m, content) => {
    const idx = tradingBlocks.length;
    tradingBlocks.push(buildTradeCard(content, 'long'));
    return `__TRADE_BLOCK_${idx}__`;
  });

  // Extract TRADE_SHORT
  text = text.replace(/\[TRADE_SHORT\]\s*([\s\S]*?)\s*\[\/TRADE_SHORT\]/gi, (m, content) => {
    const idx = tradingBlocks.length;
    tradingBlocks.push(buildTradeCard(content, 'short'));
    return `__TRADE_BLOCK_${idx}__`;
  });

  // Extract PATTERN tags: [PATTERN:bull_flag] or [PATTERN:bull_flag "optional caption"]
  text = text.replace(/\[PATTERN:(\w+)(?:\s+"([^"]*)")?\]/gi, (m, id, caption) => {
    const card = buildPatternCard(id, caption || '');
    if (!card) return m; // unknown pattern, leave as text
    const idx = tradingBlocks.length;
    tradingBlocks.push(card);
    return `__TRADE_BLOCK_${idx}__`;
  });

  // 2. Render normal markdown
  let html = renderMarkdown(text);

  // 3. Colorize trading keywords BEFORE re-inserting blocks
  //    (doing it after would break HTML attributes inside trade cards/bias bars)
  //    Only colorize text content, not inside HTML tags
  function colorizeOutsideTags(h) {
    // Split HTML into tags and text segments, only colorize text segments
    return h.replace(/([^<]+)|(<[^>]+>)/g, (match, textPart, tagPart) => {
      if (tagPart) return tagPart; // leave HTML tags untouched
      if (!textPart) return match;
      let t = textPart;
      // LONG, BULLISH, BUY → green
      t = t.replace(/\b(LONG|BULLISH|BUY|COMPRA|ALCISTA|HOLD|MANTENER|MANTÉN)\b/gi,
        '<span class="t-green">$1</span>');
      // SHORT, BEARISH, SELL → red
      t = t.replace(/\b(SHORT|BEARISH|SELL|VENTA|BAJISTA|CERRAR|CORTAR|SALIR)\b/gi,
        '<span class="t-red">$1</span>');
      // TP → green
      t = t.replace(/\b(TP\d?)\b/gi, '<span class="t-green">$1</span>');
      // SL → red
      t = t.replace(/\b(SL|Stop Loss|Stop-Loss)\b/gi, '<span class="t-red">$1</span>');
      // Positive PnL → green
      t = t.replace(/(\+\$[\d,\.]+)/g, '<span class="t-green">$1</span>');
      t = t.replace(/(\+[\d\.]+%)/g, '<span class="t-green">$1</span>');
      // Negative PnL → red
      t = t.replace(/(\-\$[\d,\.]+)/g, '<span class="t-red">$1</span>');
      t = t.replace(/(\-[\d\.]+%)/g, '<span class="t-red">$1</span>');
      // R:R → gold
      t = t.replace(/(R:R\s*\d+:\d+[\.\d]*)/gi, '<span class="t-gold">$1</span>');
      t = t.replace(/(\d+:\d+[\.\d]*\s*R:R)/gi, '<span class="t-gold">$1</span>');
      return t;
    });
  }
  html = colorizeOutsideTags(html);

  // 4. Re-insert trading blocks AFTER colorization (so their HTML stays intact)
  html = html.replace(/__TRADE_BLOCK_(\d+)__/g, (m, idx) => {
    return '</p>' + tradingBlocks[Number(idx)] + '<p>';
  });

  // Clean empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

function buildTradeCard(content, side) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const isLong = side === 'long';
  const icon = isLong ? '🟢' : '🔴';
  const title = isLong ? 'LONG SETUP' : 'SHORT SETUP';
  const cls = isLong ? 'trade-card-long' : 'trade-card-short';

  let rows = '';
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const label = escapeHTML(parts[0].trim());
    const value = escapeHTML(parts.slice(1).join(':').trim());

    let rowCls = '';
    if (/^(ENTRY|ENTRADA)/i.test(label)) rowCls = 'entry-row';
    else if (/^(SL|STOP)/i.test(label)) rowCls = 'sl-row';
    else if (/^TP/i.test(label)) rowCls = 'tp-row';
    else if (/^(SIZE|TAMAÑO)/i.test(label)) rowCls = 'size-row';

    rows += `<div class="trade-card-row ${rowCls}">
      <span class="trade-card-label">${label}</span>
      <span class="trade-card-value">${value}</span>
    </div>`;
  }

  return `<div class="trade-card ${cls}">
    <div class="trade-card-header">${icon} ${title}</div>
    ${rows}
  </div>`;
}

// ─── Handler global para el botón "Copy" de los bloques de código ──
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-copy-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = btn.dataset.copyTarget;
  const pre = document.getElementById(id);
  if (!pre) return;

  navigator.clipboard.writeText(pre.textContent).then(() => {
    const label = btn.querySelector('.copy-label');
    const original = label.textContent;
    const copiedText = (typeof t === 'function') ? t('chat.copied') : 'Copied!';
    label.textContent = copiedText;
    btn.classList.add('copied');
    setTimeout(() => {
      label.textContent = original;
      btn.classList.remove('copied');
    }, 1800);
  }).catch(err => {
    console.error('Copy failed:', err);
  });
});

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

// ─── Traducción en vivo (Deepgram streaming + Claude/GPT translation) ──
const translate = {
  active: false,
  stream: null,        // MediaStream del sistema
  audioCtx: null,      // AudioContext para procesar PCM
  sourceNode: null,    // MediaStreamSource
  processorNode: null, // ScriptProcessorNode (captura Float32 → Int16)
  currentLine: null,   // Línea actual de subtítulo (interim updates)
  pendingTranslation: null, // Promise de traducción en curso
  useDeepgram: true    // true = Deepgram streaming, false = Whisper chunks (fallback)
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
  if (on) {
    phantom.window.resize({ width: 640, height: 780 });
  } else {
    // Limpiar conversación de traducción al desactivar
    if (state.mode === 'translate') {
      state.messages = [];
      state.mode = null;
      conversationEl.innerHTML = '';
      chatWrap.style.display = 'none';
      setDanger(false);
    }
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
  const cfg = await phantom.config.get();

  // Decidir: Deepgram (streaming) o Whisper (chunks)
  translate.useDeepgram = !!cfg.deepgramKey;

  if (!translate.useDeepgram && !cfg.openaiKey) {
    setStatus('⚠ Falta API key de Deepgram o OpenAI en settings.', 'err');
    return;
  }

  try {
    const empty = translateOutput.querySelector('.translate-empty');
    if (empty) empty.remove();

    setStatus('Pidiendo audio del sistema…', 'busy');
    translate.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 },
      audio: true
    });
    translate.stream.getVideoTracks().forEach(t => t.stop());

    if (translate.stream.getAudioTracks().length === 0) {
      throw new Error('No se obtuvo pista de audio. ¿Aceptaste compartir audio del sistema?');
    }

    translate.active = true;
    btnTranslate.textContent = t('translate.stop');
    translateStatus.classList.add('live');

    if (translate.useDeepgram) {
      await startDeepgramStream(cfg);
    } else {
      // Fallback: Whisper chunk-based (sistema anterior)
      setStatus('Escuchando audio del sistema (Whisper)…', 'ok');
      runWhisperCycle();
    }
  } catch (err) {
    console.error('startTranslation:', err);
    setStatus('⚠ ' + err.message, 'err');
    stopTranslation();
  }
}

// ─── DEEPGRAM STREAMING ──────────────────────────────────────────
async function startDeepgramStream(cfg) {
  setStatus('Conectando a Deepgram…', 'busy');
  const from = cfg.translateFrom || 'auto';

  // AudioContext para capturar PCM desde el MediaStream
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  translate.audioCtx = audioCtx;

  const source = audioCtx.createMediaStreamSource(
    new MediaStream(translate.stream.getAudioTracks())
  );
  translate.sourceNode = source;

  // ScriptProcessor: captura Float32 → convierte a Int16 → envía al main
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  translate.processorNode = processor;

  processor.onaudioprocess = (ev) => {
    if (!translate.active) return;
    const float32 = ev.inputBuffer.getChannelData(0);
    // Float32 → Int16 PCM
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    phantom.deepgram.sendAudio(int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination); // necesario para que funcione

  // Conectar Deepgram WebSocket via main process
  try {
    await phantom.deepgram.start({ language: from, sampleRate: 16000 });
    setStatus('🎙️ Streaming en vivo (Deepgram)…', 'ok');
  } catch (err) {
    console.error('Deepgram start error:', err);
    setStatus('⚠ ' + err.message, 'err');
    stopTranslation();
  }
}

// Deepgram interim: actualiza la línea actual en tiempo real
phantom.on('deepgram:interim', (transcript) => {
  if (!translate.active) return;
  if (!translate.currentLine) {
    translate.currentLine = createTranslateLine();
  }
  const srcEl = translate.currentLine.querySelector('.src');
  if (srcEl) srcEl.textContent = transcript;
  translateOutput.scrollTop = translateOutput.scrollHeight;
});

// Deepgram final: marca la línea como final y traduce
phantom.on('deepgram:final', async (transcript, speechFinal) => {
  if (!translate.active) return;
  if (!transcript || transcript.trim().length < 2) return;

  if (!translate.currentLine) {
    translate.currentLine = createTranslateLine();
  }
  const line = translate.currentLine;
  const srcEl = line.querySelector('.src');
  const trEl = line.querySelector('.tr');
  if (srcEl) srcEl.textContent = transcript;

  // Si es speech_final (pausa detectada), finalizar la línea y traducir
  if (speechFinal) {
    translate.currentLine = null; // Próximo texto va en nueva línea

    const cfg = await phantom.config.get();
    const from = cfg.translateFrom || 'auto';
    const to = cfg.translateTo || 'es';

    // Si mismo idioma, no traducir
    if (from !== 'auto' && from === to) {
      line.classList.remove('pending');
      if (trEl) trEl.textContent = transcript;
      return;
    }

    // Traducir con Claude/GPT
    try {
      const t2 = await phantom.translate.text({ text: transcript, from, to });
      const translated = (t2.text || '').trim();
      line.classList.remove('pending');
      if (trEl) trEl.textContent = translated || transcript;
      translateOutput.scrollTop = translateOutput.scrollHeight;
    } catch (err) {
      line.classList.remove('pending');
      if (trEl) trEl.textContent = '⚠ ' + err.message;
    }
  }
});

phantom.on('deepgram:error', (msg) => {
  console.error('Deepgram error:', msg);
  if (translate.active) {
    setStatus('⚠ Deepgram: ' + msg, 'err');
  }
});

function createTranslateLine() {
  const line = document.createElement('div');
  line.className = 'translate-line pending';
  line.innerHTML = '<div class="src">…</div><div class="tr"><span class="dots"><span></span><span></span><span></span></span></div>';
  translateOutput.appendChild(line);
  translateOutput.scrollTop = translateOutput.scrollHeight;
  return line;
}

function stopTranslation() {
  translate.active = false;
  btnTranslate.textContent = t('translate.start');
  translateStatus.classList.remove('live');
  translate.currentLine = null;

  // Cerrar Deepgram
  if (translate.useDeepgram) {
    phantom.deepgram.stop().catch(() => {});
  }

  // Cerrar AudioContext + processor
  if (translate.processorNode) {
    try { translate.processorNode.disconnect(); } catch {}
    translate.processorNode = null;
  }
  if (translate.sourceNode) {
    try { translate.sourceNode.disconnect(); } catch {}
    translate.sourceNode = null;
  }
  if (translate.audioCtx) {
    try { translate.audioCtx.close(); } catch {}
    translate.audioCtx = null;
  }

  // Cerrar MediaStream
  if (translate.stream) {
    translate.stream.getTracks().forEach(t => t.stop());
    translate.stream = null;
  }

  setStatus('Traducción detenida.', 'ok');
}

// ─── FALLBACK: Whisper chunk-based (sistema anterior) ────────────
function runWhisperCycle() {
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
    setStatus('⚠ MediaRecorder error: ' + e.message, 'err');
    stopTranslation();
    return;
  }

  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = async () => {
    if (translate.active) runWhisperCycle();
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuf);
    const placeholder = createTranslateLine();
    whisperTranscribeAndTranslate(base64, mimeType, placeholder).catch(err => {
      placeholder.classList.remove('pending');
      placeholder.querySelector('.tr').textContent = '⚠ ' + err.message;
    });
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
  }, 2500);
}

async function whisperTranscribeAndTranslate(audioBase64, mimeType, placeholder) {
  const cfg = await phantom.config.get();
  const from = cfg.translateFrom || 'auto';
  const to = cfg.translateTo || 'es';

  const t1 = await phantom.translate.transcribe({ audioBase64, mimeType, language: from });
  const original = (t1.text || '').trim();
  if (!original || original.length < 2) { placeholder.remove(); return; }

  placeholder.querySelector('.src').textContent = original;
  if (from !== 'auto' && from === to) {
    placeholder.classList.remove('pending');
    placeholder.querySelector('.tr').textContent = original;
    return;
  }

  const t2 = await phantom.translate.text({ text: original, from, to });
  placeholder.classList.remove('pending');
  placeholder.querySelector('.tr').textContent = (t2.text || '').trim() || original;
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
  } else {
    // Limpiar conversación de entrevista al desactivar
    if (state.mode === 'interview') {
      state.messages = [];
      state.mode = null;
      conversationEl.innerHTML = '';
      chatWrap.style.display = 'none';
      setDanger(false);
    }
    if (!$('cfg-translate').checked) {
      phantom.window.resize({ width: 420, height: 600 });
    }
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
      const transcription = await phantom.translate.transcribe({ audioBase64: base64, mimeType, language: 'auto' });
      const piece = (transcription.text || '').trim();
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
    setStatus(t('status.recording'), 'busy');
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
    setStatus(t('status.recording_too_short'), 'err');
    return;
  }

  // Mostrar la sección con "transcribiendo…"
  manualTranscriptionSection.style.display = 'flex';
  manualTranscriptionText.value = '';
  manualTranscriptionText.placeholder = '⏳ ' + t('status.transcribing');
  btnManualAnswer.disabled = true;
  setStatus(t('status.transcribing'), 'busy');

  try {
    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuf);

    // Ojo: NO usar 'const t' aquí porque 't()' es nuestra función de i18n.
    const transcription = await phantom.translate.transcribe({
      audioBase64: base64,
      mimeType,
      language: 'auto'
    });
    const text = (transcription.text || '').trim();

    manualTranscriptionText.value = text || '';
    manualTranscriptionText.placeholder = text ? '' : '(no speech detected)';
    btnManualAnswer.disabled = !text;
    setStatus(text ? t('status.transcription_ready') : t('status.transcription_empty'), text ? 'ok' : 'err');
  } catch (err) {
    console.error('Transcribe manual:', err);
    manualTranscriptionText.placeholder = '⚠ ' + err.message;
    btnManualAnswer.disabled = false;
    setStatus('⚠ ' + err.message, 'err');
  }
}

// ─── Trading ────────────────────────────────────────────────────
const TRADING_INDICATORS = [
  { id: 'rsi',        name: 'RSI',               desc: 'Relative Strength Index (14)' },
  { id: 'macd',       name: 'MACD',              desc: 'Moving Average Convergence Divergence (12, 26, 9)' },
  { id: 'bollinger',  name: 'Bollinger Bands',   desc: 'Bollinger Bands (20, 2)' },
  { id: 'ema20',      name: 'EMA 20',            desc: 'Exponential Moving Average 20' },
  { id: 'ema50',      name: 'EMA 50',            desc: 'Exponential Moving Average 50' },
  { id: 'ema200',     name: 'EMA 200',           desc: 'Exponential Moving Average 200' },
  { id: 'sma50',      name: 'SMA 50',            desc: 'Simple Moving Average 50' },
  { id: 'sma200',     name: 'SMA 200',           desc: 'Simple Moving Average 200' },
  { id: 'vwap',       name: 'VWAP',              desc: 'Volume Weighted Average Price' },
  { id: 'stoch',      name: 'Stochastic',        desc: 'Stochastic Oscillator (14, 3, 3)' },
  { id: 'atr',        name: 'ATR',               desc: 'Average True Range (14)' },
  { id: 'adx',        name: 'ADX',               desc: 'Average Directional Index (14)' },
  { id: 'ichimoku',   name: 'Ichimoku',          desc: 'Ichimoku Cloud (9, 26, 52)' },
  { id: 'fibonacci',  name: 'Fibonacci',         desc: 'Fibonacci Retracement levels' },
  { id: 'volume',     name: 'Volume',             desc: 'Volume bars & volume profile' },
  { id: 'obv',        name: 'OBV',               desc: 'On-Balance Volume' },
  { id: 'cci',        name: 'CCI',               desc: 'Commodity Channel Index (20)' },
  { id: 'williams',   name: 'Williams %R',       desc: 'Williams Percent Range (14)' },
  { id: 'pivot',      name: 'Pivot Points',      desc: 'Pivot Points (Standard)' },
  { id: 'supertrend', name: 'Supertrend',        desc: 'Supertrend (10, 3)' },
  { id: 'mfi',        name: 'MFI',               desc: 'Money Flow Index (14)' },
  { id: 'parabolic',  name: 'Parabolic SAR',     desc: 'Parabolic Stop and Reverse' },
  { id: 'donchian',   name: 'Donchian',          desc: 'Donchian Channels (20)' },
  { id: 'keltner',    name: 'Keltner',           desc: 'Keltner Channels (20, 1.5)' },
  { id: 'cmf',        name: 'CMF',               desc: 'Chaikin Money Flow (20)' },
  { id: 'roc',        name: 'ROC',               desc: 'Rate of Change (12)' },
  { id: 'dmi',        name: 'DMI',               desc: 'Directional Movement Index' },
  { id: 'trix',       name: 'TRIX',              desc: 'Triple Exponential Average' },
  { id: 'vr',         name: 'Vol Ratio',         desc: 'Volume Ratio' },
  { id: 'ma_cross',   name: 'MA Cross',          desc: 'Moving Average Crossover signals' }
];

const tradingPanel = $('trading-panel');
const tradingChips = $('trading-chips');
const tradingPicker = $('trading-picker');
const tradingResult = $('trading-result');
const tradingResultText = $('trading-result-text');
const tradingAssetInput = $('trading-asset-input');
const btnTradingAnalyze = $('btn-trading-analyze');

let tradingActiveIndicators = new Set(['rsi', 'macd', 'ema20', 'ema50', 'bollinger', 'volume']);

function renderTradingChips() {
  tradingChips.innerHTML = '';
  tradingActiveIndicators.forEach(id => {
    const ind = TRADING_INDICATORS.find(i => i.id === id);
    if (!ind) return;
    const chip = document.createElement('span');
    chip.className = 'ti-chip';
    chip.innerHTML = `${escapeHTML(ind.name)}<span class="chip-remove" data-id="${id}">×</span>`;
    tradingChips.appendChild(chip);
  });
  tradingChips.querySelectorAll('.chip-remove').forEach(el => {
    el.addEventListener('click', () => {
      tradingActiveIndicators.delete(el.dataset.id);
      renderTradingChips();
      renderTradingPicker();
      saveTradingIndicators();
    });
  });
}

function renderTradingPicker() {
  tradingPicker.innerHTML = '';
  TRADING_INDICATORS.forEach(ind => {
    const btn = document.createElement('button');
    btn.className = 'ti-pick' + (tradingActiveIndicators.has(ind.id) ? ' active' : '');
    btn.textContent = ind.name;
    btn.title = ind.desc;
    btn.addEventListener('click', () => {
      if (tradingActiveIndicators.has(ind.id)) {
        tradingActiveIndicators.delete(ind.id);
      } else {
        tradingActiveIndicators.add(ind.id);
      }
      renderTradingChips();
      renderTradingPicker();
      saveTradingIndicators();
    });
    tradingPicker.appendChild(btn);
  });
}

function saveTradingIndicators() {
  localStorage.setItem('phantom_trading_indicators', JSON.stringify([...tradingActiveIndicators]));
}

function loadTradingIndicators() {
  try {
    const saved = JSON.parse(localStorage.getItem('phantom_trading_indicators'));
    if (Array.isArray(saved) && saved.length > 0) {
      tradingActiveIndicators = new Set(saved);
    }
  } catch {}
}

loadTradingIndicators();
renderTradingChips();
renderTradingPicker();

function getTradingSystemPrompt(exchangeContext) {
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const langName = LANG_NAMES[uiLang] || 'Spanish';

  const activeInds = [...tradingActiveIndicators]
    .map(id => TRADING_INDICATORS.find(i => i.id === id))
    .filter(Boolean)
    .map(i => `- ${i.name}: ${i.desc}`)
    .join('\n');

  const asset = tradingAssetInput.value.trim();
  const assetLine = asset ? `The user is analyzing: ${asset}` : 'The user has not specified an asset — infer it from the chart if possible.';

  const exchangeSection = exchangeContext ? `

LIVE EXCHANGE DATA:
The user has connected their exchange account. You have access to their REAL positions, open orders, and account balance.
Use this data to:
- Evaluate their current position (entry price, unrealized PnL, liquidation risk)
- Suggest whether to hold, add to position, take profit, or cut losses
- Consider their open orders (take profits, stop losses) in your analysis
- Factor their available margin/balance into risk management
- Be specific: "Your long from $80,074 is currently +$X, consider taking partial profit at..."
` : '';

  return `You are a senior professional trader and institutional-grade technical analyst with 15+ years of experience across crypto, equities, forex, and commodities markets. You have managed 8-figure portfolios and specialized in multi-timeframe analysis, order flow, and risk-adjusted position sizing.

YOUR TRADING PHILOSOPHY:
- Capital preservation ALWAYS comes first. Never recommend entries without clear invalidation levels.
- You think in probabilities, not certainties. Every setup has a win rate and expected value.
- You size positions based on account risk (1-2% max per trade) and volatility (ATR-based).
- You understand market microstructure: liquidity pools, stop hunts, institutional order blocks.
- You read price action in context — a hammer at support after a flush means something different than one mid-range.

${assetLine}

INDICATORS IN YOUR TOOLKIT (apply deep knowledge even if not all visible on chart):
${activeInds}
${exchangeSection}

DELIVER YOUR ANALYSIS IN THIS EXACT STRUCTURE AND ORDER:
${exchangeContext ? `
===========================================================
**SECTION 0 — 💼 YOUR OPEN POSITION** (MUST BE FIRST — THIS IS THE MOST IMPORTANT SECTION)
===========================================================
This section MUST appear FIRST, before ANY technical analysis. The user connected their exchange — they want to know about THEIR money immediately.

Analyze their current open position(s) in detail:
- **Position Summary**: Side (LONG/SHORT), size, entry price, current price, unrealized PnL, margin used, liquidation price
- **Position Health**: Is it in danger? How far from liquidation? Is the margin adequate?
- **Verdict on Position**: HOLD / ADD / REDUCE / CLOSE — be decisive, explain why
- **Immediate Actions**: Specific advice like "Move SL to $X", "Take 50% profit NOW at $X", "Your liquidation at $X is dangerously close"
- **Open Orders Review**: Are their TP/SL orders well placed? Suggest adjustments with exact prices

If they have NO open positions, say "No open positions detected" and suggest whether NOW is a good time to enter.
` : ''}
---

**SECTION 1 — ⏱ Market Context**
Timeframe, trend phase (accumulation/markup/distribution/markdown per Wyckoff), current structure (HH/HL or LH/LL), and where we are relative to the daily/weekly bias.

**SECTION 2 — 🔑 Critical Levels**
Key S/R with reasoning. Identify institutional levels, liquidity zones, order blocks and FVGs.

**SECTION 3 — 📊 Indicator Confluence**
For each active indicator, give a TRADER'S reading with context, not just numbers. Identify confirmations, contradictions, and divergences.

**SECTION 4 — 📈 Volume & Order Flow**
Volume profile interpretation, buying vs selling pressure, what it tells about institutional participation.

**SECTION 5 — 🔍 Pattern & Structure**
Chart patterns with measured move targets. Candlestick patterns at key levels.

**SECTION 6 — ⚠️ Risk Factors**
What could go wrong: upcoming events, funding rates, OI shifts, correlation risks.

===========================================================
**SECTION 7 — 📊 PROBABILITY & BIAS** (MANDATORY — use this EXACT format)
===========================================================
You MUST end with a probability assessment using this EXACT format (the app will parse and render this as a visual bar):

[BIAS_BAR]
LONG: XX% | SHORT: YY%
[/BIAS_BAR]

Where XX + YY = 100. Be honest with your assessment.

===========================================================
**SECTION 8 — 🎯 TRADE SETUPS** (MANDATORY — use these EXACT formats)
===========================================================
Provide BOTH long and short setups with exact prices. Use these EXACT tags so the app renders them as visual cards:

[TRADE_LONG]
ENTRY: $XXXXX - $XXXXX
SL: $XXXXX
TP1: $XXXXX (R:R X:X)
TP2: $XXXXX (R:R X:X)
TP3: $XXXXX (R:R X:X)
SIZE: X% of capital
[/TRADE_LONG]

[TRADE_SHORT]
ENTRY: $XXXXX - $XXXXX
SL: $XXXXX
TP1: $XXXXX (R:R X:X)
TP2: $XXXXX (R:R X:X)
TP3: $XXXXX (R:R X:X)
SIZE: X% of capital
[/TRADE_SHORT]

===========================================================
**SECTION 9 — 📐 CHART PATTERNS** (use when you identify a pattern)
===========================================================
When you identify a chart pattern, insert the corresponding tag INLINE in your analysis. The app will render a beautiful SVG illustration.

Available pattern tags (use the EXACT tag):
[PATTERN:bull_flag] [PATTERN:bear_flag]
[PATTERN:ascending_triangle] [PATTERN:descending_triangle] [PATTERN:symmetrical_triangle]
[PATTERN:double_top] [PATTERN:double_bottom]
[PATTERN:head_shoulders] [PATTERN:inv_head_shoulders]
[PATTERN:rising_wedge] [PATTERN:falling_wedge]
[PATTERN:cup_handle]
[PATTERN:channel_up] [PATTERN:channel_down]
[PATTERN:engulfing_bull] [PATTERN:engulfing_bear]
[PATTERN:hammer] [PATTERN:doji]

You can add a caption: [PATTERN:bull_flag "Forming on 4H since May 10"]
Use 1-3 patterns per analysis — only the ones you actually see on the chart. Don't force patterns that aren't there.

STYLE RULES:
- Be decisive. Give your actual bias, don't hedge with "it could go either way."
- Use exact prices and percentages — always with $ sign for prices.
- If the setup isn't there, say "NO TRADE" — the best trade is sometimes no trade.
- Think like a prop trader: what's the edge, what's the risk, what's the plan?
- Reference multi-timeframe context when relevant.
- When mentioning LONG positions, profits, bullish signals, TPs hit → these are POSITIVE (green).
- When mentioning SHORT positions, losses, bearish signals, SL hit → these are NEGATIVE (red).
- Always use $ before prices so the UI can colorize them.

⚠️ DISCLAIMER: Educational analysis only. Not financial advice.

🌐 LANGUAGE — Reply ALWAYS in ${langName} (${uiLang}).`;
}

// Fetch exchange data (positions, orders, balance, ticker) if configured
async function fetchExchangeData() {
  const cfg = await phantom.config.get();
  console.log('[Trading] Exchange config:', cfg.exchangeProvider, '| key:', cfg.exchangeKey ? 'SET' : 'EMPTY', '| secret:', cfg.exchangeSecret ? 'SET' : 'EMPTY');
  if (!cfg.exchangeProvider || !cfg.exchangeKey || !cfg.exchangeSecret) {
    console.log('[Trading] No exchange configured, skipping data fetch');
    return null;
  }
  try {
    // Guardar el asset actual en config para que main.js lo use
    const asset = tradingAssetInput.value.trim();
    await phantom.config.set({ ...cfg, tradingAsset: asset });
    console.log('[Trading] Fetching exchange data for:', asset || '(no asset)');
    const data = await phantom.exchange.fetch({ type: 'all' });
    console.log('[Trading] Exchange data received:', JSON.stringify(data).slice(0, 500));
    return data;
  } catch (err) {
    console.error('[Trading] Exchange fetch error:', err);
    return { error: err.message };
  }
}

function formatExchangeDataForPrompt(data) {
  if (!data || data.error) return '';
  const parts = [];

  if (data.ticker) {
    parts.push(`📊 REAL-TIME TICKER (${data.tickerSource || 'exchange'}):`);
    if (data.ticker.price) parts.push(`  Price: ${data.ticker.price}`);
    if (data.ticker.bestBid) parts.push(`  Best Bid: ${data.ticker.bestBid}`);
    if (data.ticker.bestAsk) parts.push(`  Best Ask: ${data.ticker.bestAsk}`);
    if (data.ticker.size) parts.push(`  Volume: ${data.ticker.size}`);
  }

  if (data.positions && data.positions.length > 0) {
    parts.push(`\n📋 OPEN POSITIONS:`);
    data.positions.forEach(p => {
      // KuCoin format
      if (p.symbol) {
        const side = p.currentQty > 0 ? 'LONG' : 'SHORT';
        parts.push(`  ${p.symbol} | ${side} | Qty: ${Math.abs(p.currentQty || p.positionAmt || 0)} | Entry: ${p.avgEntryPrice || p.entryPrice || '?'} | Mark: ${p.markPrice || '?'} | PnL: ${p.unrealisedPnl || p.unRealizedProfit || '?'} | Margin: ${p.posCost || p.initialMargin || '?'} | Liq: ${p.liquidationPrice || '?'}`);
      }
    });
  }

  if (data.orders && data.orders.length > 0) {
    parts.push(`\n📝 OPEN ORDERS:`);
    data.orders.forEach(o => {
      parts.push(`  ${o.symbol || '?'} | ${o.side || o.type || '?'} | Price: ${o.price || '?'} | Size: ${o.size || o.origQty || '?'} | Type: ${o.type || o.orderType || '?'} | Stop: ${o.stopPrice || o.stop || '-'}`);
    });
  }

  if (data.balance) {
    parts.push(`\n💰 ACCOUNT BALANCE:`);
    if (Array.isArray(data.balance)) {
      // Binance
      data.balance.forEach(b => {
        parts.push(`  ${b.asset}: ${b.balance} (available: ${b.availableBalance || b.free || '?'})`);
      });
    } else {
      // KuCoin
      parts.push(`  Available: ${data.balance.availableBalance || data.balance.marginBalance || '?'}`);
      parts.push(`  Unrealized PnL: ${data.balance.unrealisedPNL || '?'}`);
      if (data.balance.currency) parts.push(`  Currency: ${data.balance.currency}`);
    }
  }

  return parts.length > 0 ? '\n\n--- LIVE EXCHANGE DATA ---\n' + parts.join('\n') : '';
}

btnTradingAnalyze.addEventListener('click', async () => {
  if (state.busy) return;
  if (tradingActiveIndicators.size === 0) {
    setStatus(t('trading.no_indicators'), 'err');
    return;
  }

  state.busy = true;
  expandPanel('trading-panel');
  tradingResult.style.display = 'block';
  tradingResultText.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="width:80%"></div>';
  setStatus(t('trading.analyzing'), 'busy');

  try {
    // Fetch screenshot + exchange data in parallel
    const [screenshot, exchangeData] = await Promise.all([
      captureScreen(),
      fetchExchangeData()
    ]);
    if (!screenshot) throw new Error('No se pudo capturar la pantalla');

    const exchangeContext = formatExchangeDataForPrompt(exchangeData);
    const system = getTradingSystemPrompt(exchangeContext);
    const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
    const userTexts = {
      es: 'Analizá este gráfico de trading con los indicadores seleccionados. Dame tu análisis técnico completo.',
      en: 'Analyze this trading chart with the selected indicators. Give me your complete technical analysis.',
      pt: 'Analise este gráfico de trading com os indicadores selecionados. Dê-me sua análise técnica completa.',
      fr: 'Analysez ce graphique de trading avec les indicateurs sélectionnés. Donnez-moi votre analyse technique complète.',
      ja: '選択したインジケーターでこのトレーディングチャートを分析してください。完全なテクニカル分析をお願いします。',
      zh: '使用选定的指标分析此交易图表。给我完整的技术分析。'
    };
    let userPrompt = userTexts[uiLang] || userTexts.es;
    if (exchangeContext) {
      userPrompt += '\n\n' + exchangeContext;
    }

    const messages = [{
      role: 'user',
      content: await buildContent(userPrompt, screenshot)
    }];

    // Use dedicated trading model if configured
    const tradingCfg = await phantom.config.get();
    const tradingModel = tradingCfg.tradingModel || null;
    const resp = await phantom.ai.call({ messages, system, model: tradingModel, maxTokens: 4096 });
    tradingResultText.innerHTML = renderTradingMarkdown(resp.text);
    setStatus(t('trading.analysis_ready'), 'ok');

    const bodyEl = document.querySelector('.body');
    if (bodyEl) tradingResult.scrollIntoView({ behavior: 'smooth', block: 'start' });

    state.messages = [
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: resp.text }
    ];
    state.mode = 'trading';
    chatWrap.style.display = 'flex';
  } catch (err) {
    tradingResultText.innerHTML = '<em style="color:#dc2626">' + escapeHTML(err.message) + '</em>';
    setStatus('⚠ ' + err.message, 'err');
  } finally {
    state.busy = false;
  }
});

function applyTradingPanelVisibility(on) {
  tradingPanel.style.display = on ? 'flex' : 'none';
  if (on) {
    phantom.window.resize({ width: 680, height: 900 });
  } else {
    // Limpiar conversación y resultado de trading al desactivar
    if (state.mode === 'trading') {
      state.messages = [];
      state.mode = null;
      conversationEl.innerHTML = '';
      chatWrap.style.display = 'none';
      setDanger(false);
    }
    const tr = $('trading-result');
    const trt = $('trading-result-text');
    if (tr) tr.style.display = 'none';
    if (trt) trt.innerHTML = '';
    if (!$('cfg-translate').checked && !$('cfg-interview').checked) {
      phantom.window.resize({ width: 420, height: 600 });
    }
  }
}

$('cfg-trading').addEventListener('change', (e) => {
  applyTradingPanelVisibility(e.target.checked);
});

// Exchange keys visibility
$('cfg-exchange-provider').addEventListener('change', (e) => {
  updateExchangeKeysVisibility(e.target.value);
});

function updateExchangeKeysVisibility(provider) {
  const keysGroup = $('exchange-keys-group');
  const passphraseGroup = $('exchange-passphrase-group');
  keysGroup.style.display = provider ? 'block' : 'none';
  // Solo KuCoin necesita passphrase
  if (passphraseGroup) passphraseGroup.style.display = provider === 'kucoin' ? 'block' : 'none';
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
