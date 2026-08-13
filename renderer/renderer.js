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
  mode: 'responder',
  // Multi-captura: array de dataURLs y flag de modo activo
  multiCaptures: [],
  multiMode: false,
  // Knowledge base (docs adjuntos por el user)
  knowledgeDocs: []
};

// ─── System prompts (dinámicos según idioma de la UI) ───────────
const LANG_NAMES = {
  es: 'Spanish', en: 'English', pt: 'Portuguese',
  fr: 'French',  ja: 'Japanese', zh: 'Chinese'
};

/**
 * User-facing chart-analysis instruction, localized per UI language.
 * Used by manual analyze button AND auto-analysis to keep them consistent.
 */
const CHART_ANALYSIS_PROMPTS = {
  es: 'Analizá estos gráficos de trading. La PRIMERA imagen es el gráfico de 15m, la SEGUNDA es el de 1H y la TERCERA es el de 4H. Usá los tres timeframes para tu análisis multi-timeframe completo. RESPONDÉ EN ESPAÑOL.',
  en: 'Analyze these trading charts. The FIRST image is the 15m chart, the SECOND is the 1H chart and the THIRD is the 4H chart. Use all three timeframes for your complete multi-timeframe analysis. RESPOND IN ENGLISH.',
  pt: 'Analise estes gráficos de trading. A PRIMEIRA imagem é o gráfico de 15m, a SEGUNDA é o de 1H e a TERCEIRA é o de 4H. Use os três timeframes para sua análise multi-timeframe completa. RESPONDA EM PORTUGUÊS.',
  fr: 'Analysez ces graphiques de trading. La PREMIÈRE image est le graphique 15m, la DEUXIÈME le 1H et la TROISIÈME le 4H. Utilisez les trois timeframes pour votre analyse multi-timeframe complète. RÉPONDEZ EN FRANÇAIS.',
  ja: 'これらのトレーディングチャートを分析してください。最初の画像は15分足、2番目は1時間足、3番目は4時間足です。3つの時間枠すべてを使用して、完全なマルチタイムフレーム分析を行ってください。日本語で回答してください。',
  zh: '分析这些交易图表。第一张图片是15分钟图表，第二张是1小时图表，第三张是4小时图表。使用所有三个时间框架进行完整的多时间框架分析。请用中文回答。'
};
function chartAnalysisPrompt(lang) {
  return CHART_ANALYSIS_PROMPTS[lang] || CHART_ANALYSIS_PROMPTS.es;
}

const SECURITY_RULE = `SECURITY: If you detect phishing, scam, fraud or deception, begin your reply with the marker on a line by itself:
[[PHISHING_DETECTED]]
then briefly explain why, what to do (don't click, delete, block, report) and the warning signs.`;

/**
 * Devuelve un bloque de texto con todos los docs de la knowledge base,
 * formateados para inyectar en el system prompt. Si no hay docs, ''.
 *
 * Diseñado para ser leído por el modelo como "info personal del user que
 * debe usar si la pregunta visible la cubre". Búsqueda en tiempo real:
 * el modelo lee todo y aplica relevancia internamente — sin embeddings
 * ni preprocesado, gracias a la ventana de Haiku/Sonnet.
 */
function getKnowledgeBaseBlock() {
  const docs = (Array.isArray(state?.knowledgeDocs) ? state.knowledgeDocs : []);
  if (!docs.length) return '';
  const parts = [
    '📚 KNOWLEDGE BASE — Documentos personales que adjuntó el usuario.',
    'Si la pregunta o problema visible en la captura está cubierto por algún',
    'documento de abajo, usá esa información para construir la respuesta en',
    'PRIMERA PERSONA, como si fuera conocimiento propio del usuario.',
    'NO menciones "según el documento" ni "en mi CV dice" — incorporá la info',
    'naturalmente. Si nada es relevante, ignorá este bloque y respondé normal.',
    '',
  ];
  for (const d of docs) {
    parts.push(`──── DOC: ${d.filename} ────`);
    parts.push(d.text);
    parts.push('');
  }
  return parts.join('\n');
}

function getSystemPrompt(action) {
  // El idioma viene del selector de UI (i18n.js → getLanguage())
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const langName = LANG_NAMES[uiLang] || 'Spanish';

  // Default a la UI, pero respetar override explícito del usuario en el chat
  // (ej: "answer in English", "responde en portugués"). Esto era un bug: la
  // regla anterior decía "regardless of user's previous messages" y bloqueaba
  // que el modelo cambiara de idioma cuando el user lo pedía a mano.
  const langRule = `🌐 LANGUAGE: Default to ${langName} (${uiLang}) — the user's app is set to that language. EXCEPTION: if the user explicitly asks in the conversation to switch language (e.g. "answer in English", "responde en portugués", "in French please"), respect that instruction and reply in the requested language for that turn onwards.`;

  if (action === 'resumir') {
    return `You are an assistant that receives a screenshot of the user's screen and returns a clear, concise summary.
Structure: central topic (1 sentence), key points (3-5 bullets), conclusion if applicable.
Don't make up data.

${langRule}

${SECURITY_RULE}`;
  }

  if (action === 'challenge') {
    return `You are a live-interview CHALLENGE COPILOT. The screenshot shows a technical challenge the user must solve RIGHT NOW in front of an interviewer (coding exercise, SQL scenario, system design, algorithm, or QA scenario). The user will type the solution THEMSELVES while thinking aloud — your job is to hand them everything on a silver platter, structured so they can glance and act.

Reply with EXACTLY this structure (keep the emoji headers):

🎯 **THE ASK** — one sentence: what they're really testing (the underlying concept, not the surface task).

🧭 **APPROACH** — 2-3 sentences: the strategy to take and WHY it beats the alternatives. Interviewers grade the "why" — give the user the justification to say out loud.

📝 **PLAN** — numbered steps in build order (what to write first, second…). Short lines. This is the user's roadmap while typing.

💻 **SOLUTION** — the complete, clean, working code in the language visible on screen (or the obvious one for the stack). Good naming, brief comments on the non-obvious lines only. If SQL: the full query + one line on what each clause does. If system design: the component list + data flow in text-diagram form instead of code.

🗣️ **SAY WHILE CODING** — 3-4 short first-person English lines the user can say naturally while typing ("I'll start with the edge cases so the happy path stays clean…", "I'm choosing a map here for O(1) lookups…"). These make the user sound senior.

⚠️ **WATCH OUT** — edge cases, the complexity (big-O) if relevant, and the ONE follow-up question the interviewer will most likely ask next, with a one-line answer.

Rules:
- Optimize for SPEED OF READING: the user is on camera and shares their screen elsewhere — short lines, scannable.
- Working code over clever code. No over-engineering: solve exactly what's asked, mention extensions only in WATCH OUT.
- If the challenge statement is partially visible/cut off, solve what's visible and add one line noting what to confirm with the interviewer.
- If the user adds constraints in the follow-up chat ("in Python", "they want it recursive", "now optimize it"), obey them and regenerate only what changes.

${langRule}

${SECURITY_RULE}`;
  }
  const kb = getKnowledgeBaseBlock();
  return `You are answering the question or solving the problem visible in the screenshot, AS IF YOU WERE THE USER.
Give the direct answer/response — NOT instructions about the UI or "click here, then there".

How to behave:
- If the screenshot shows a question (survey, exam, form, interview, quiz): write the actual answer the user would give. Speak in first person ("Yes, I have…", "I would say…"). Do NOT describe buttons, do NOT say "click Answer now then select Yes". The user already sees the buttons; they want the CONTENT of the answer.
- If it's a multiple-choice question: pick the right option and explain in 1-2 sentences why.
- If it's a coding/math problem: solve it, show the answer.
- If it's a decision (which one is better, what should I do): give your recommendation directly.
- Only describe the UI if the user EXPLICITLY asks "what's on screen" / "describe the page".
- If the user gives a constraint in chat ("answer yes", "say no", "respond in English", "be brief"): obey that constraint, overriding any default behavior.
- Keep responses concise. No padding, no preambles like "Sure! Here's the answer:".
- If info on screen is genuinely missing to answer, say what's missing in one line.

🔤 NUMBERS AS WORDS — CRITICAL FOR READING ALOUD:
The user reads your answer out loud. They cannot smoothly pronounce digits like "250,000" or "$2.5M" while speaking — they trip. So write ALL numbers as words in the answer's language.
- "250,000 SKU" → "doscientos cincuenta mil SKU" / "two hundred fifty thousand SKU"
- "$2.5M" → "dos millones y medio de dólares" / "two and a half million dollars"
- "30%" → "treinta por ciento" / "thirty percent"
- "2024" → "dos mil veinticuatro" / "twenty twenty-four"
- "15 años" → "quince años"
- Version numbers, ports, decimals → as words ("versión dos punto cero", "puerto cuatro mil quinientos", "cero coma cinco segundos")
- ONLY exception: if the user explicitly asks for the figure ("dame el número exacto"), use digits.

📐 PARAGRAPH STRUCTURE — CRITICAL:
The user is going to READ YOUR ANSWER OUT LOUD in real time. They need to see where to pause and breathe.
- For ANY answer longer than ~2 sentences: SPLIT it into 2-4 paragraphs separated by ONE BLANK LINE between them (literal double newline in your output).
- Each paragraph = one self-contained idea (2-4 sentences).
- The blank line IS the breath cue. Without it, the user gets lost mid-sentence trying to find the next pause.
- Single-paragraph replies are only OK for ultra-short answers (multiple choice pick + 1-line reason, yes/no with 1-line justification).
- NO bullet points, NO numbered lists, NO markdown headers, NO code blocks (unless the question literally asks for code). Pure flowing prose split into breathable paragraphs.

${langRule}

${kb}

${SECURITY_RULE}`;
}

// User prompts (también en el idioma de la UI para no contaminar al modelo con español)
function getUserPrompt(action) {
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const prompts = {
    es: {
      resumir: 'Resumí lo que se ve en esta captura.',
      responder: 'Mirá la pantalla y dame la respuesta a la pregunta visible (o resolución del problema), como si fueras yo respondiendo. No describas botones ni cómo navegar.'
    },
    en: {
      resumir: 'Summarize what is shown in this screenshot.',
      responder: 'Look at the screen and give me the answer to the visible question (or solve the visible problem), as if you were me answering it. Do not describe buttons or how to navigate.'
    },
    pt: {
      resumir: 'Resuma o que está visível nesta captura.',
      responder: 'Olhe a tela e me dê a resposta para a pergunta visível (ou a solução do problema), como se você fosse eu respondendo. Não descreva botões ou como navegar.'
    },
    fr: {
      resumir: "Résumez ce qui est visible dans cette capture d'écran.",
      responder: "Regardez l'écran et donnez-moi la réponse à la question visible (ou la solution du problème), comme si vous étiez moi en train de répondre. Ne décrivez pas les boutons ni la navigation."
    },
    ja: {
      resumir: 'このスクリーンショットに表示されている内容を要約してください。',
      responder: '画面を見て、表示されている質問への回答（または問題の解決策）を、私が答えるかのように直接教えてください。ボタンや操作方法の説明は不要です。'
    },
    zh: {
      resumir: '总结此截图中显示的内容。',
      responder: '查看屏幕，直接给我可见问题的答案（或问题的解决方案），就像你是我在回答一样。不要描述按钮或如何导航。'
    }
  };
  // 'challenge' aplica a todos los idiomas — la estructura de la respuesta la
  // fija el system prompt; acá solo va la instrucción base (con fallback a es).
  if (action === 'challenge') {
    const challengePrompts = {
      es: 'En pantalla hay un challenge técnico de entrevista en vivo. Resolvelo completo y dame la guía estructurada para escribirlo yo mismo.',
      en: 'The screen shows a live technical interview challenge. Solve it fully and give me the structured guide to write it myself.'
    };
    return challengePrompts[uiLang] || challengePrompts.en;
  }
  return (prompts[uiLang] || prompts.es)[action] || (prompts.es[action] || prompts.es.responder);
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
  // Knowledge base — restaurar del config persistido
  state.knowledgeDocs = Array.isArray(cfg.knowledgeDocs) ? cfg.knowledgeDocs : [];
  // El render del listado se hace después de que el DOM esté listo (ver más abajo)
  setTimeout(() => { try { renderKnowledgeList(); } catch (_) {} }, 0);
  // Trading
  $('cfg-trading').checked = !!cfg.tradingEnabled;
  $('cfg-trading-model').value = cfg.tradingModel || 'claude-opus-4-7';
  $('cfg-exchange-provider').value = cfg.exchangeProvider || '';
  $('cfg-exchange-key').value = cfg.exchangeKey || '';
  $('cfg-exchange-secret').value = cfg.exchangeSecret || '';
  $('cfg-exchange-passphrase').value = cfg.exchangePassphrase || '';
  if ($('cfg-x-enabled')) $('cfg-x-enabled').checked = !!cfg.xEnabled;
  // Feature visibility toggles — separate from "enabled" config flags so the
  // user can turn the UI on/off independently. Default ALL on for first run.
  const featureDefaults = {
    featureTrading:  cfg.featureTrading  !== false,
    featureScreen:   cfg.featureScreen   !== false,
    featureInterview:cfg.featureInterview!== false,
    featureTranslate:cfg.featureTranslate!== false
  };
  if ($('cfg-feature-trading'))   $('cfg-feature-trading').checked   = featureDefaults.featureTrading;
  if ($('cfg-feature-screen'))    $('cfg-feature-screen').checked    = featureDefaults.featureScreen;
  if ($('cfg-feature-interview')) $('cfg-feature-interview').checked = featureDefaults.featureInterview;
  if ($('cfg-feature-translate')) $('cfg-feature-translate').checked = featureDefaults.featureTranslate;
  updateExchangeKeysVisibility(cfg.exchangeProvider || '');
  refreshXAuthStatus().catch(() => {});
  applyFeatureVisibility(featureDefaults);
  applyTranslatePanelVisibility(!!cfg.translateEnabled && featureDefaults.featureTranslate);
  applyInterviewPanelVisibility(!!cfg.interviewEnabled && featureDefaults.featureInterview);
  applyTradingPanelVisibility(!!cfg.tradingEnabled && featureDefaults.featureTrading);
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
$('btn-challenge').addEventListener('click', () => runAction('challenge'));
// El traductor vive en su propia ventana: se mira a la vez que el
// teleprompter, no en lugar de él.
const btnOpenXlate = document.getElementById('btn-open-translator');
if (btnOpenXlate) {
  btnOpenXlate.addEventListener('click', () => phantom.window.openTranslator());
}

// ─── 📸 Modo Multi-captura ───────────────────────────────────────────
// Permite tomar varias screenshots (mientras el user scrollea o cambia de
// vista) y enviarlas todas juntas para que el modelo tenga el contexto
// completo. Las imágenes se acumulan en state.multiCaptures y se envían
// en UN solo request al darle "Enviar".
const mcPanel  = document.getElementById('multi-capture-panel');
const mcThumbs = document.getElementById('mc-thumbs');
const mcCounter = document.getElementById('mc-counter');
const mcBtnAdd  = document.getElementById('btn-mc-add');
const mcBtnSend = document.getElementById('btn-mc-send');
const mcBtnCancel = document.getElementById('btn-mc-cancel');
const mcBtnStart = document.getElementById('btn-multi-capture');

function mcRender() {
  const n = state.multiCaptures.length;
  mcCounter.textContent = `${n} captura${n === 1 ? '' : 's'}`;
  mcBtnSend.textContent = `Enviar (${n})`;
  mcBtnSend.disabled = n === 0 || state.busy;
  const mcCh = document.getElementById('btn-mc-send-challenge');
  if (mcCh) mcCh.disabled = n === 0 || state.busy;
  mcThumbs.innerHTML = '';
  state.multiCaptures.forEach((dataUrl, i) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:64px;height:48px;border-radius:6px;overflow:hidden;border:1px solid #fbbf24;background:#fff;';
    wrap.innerHTML = `
      <img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;" />
      <span style="position:absolute;top:1px;left:3px;font-size:10px;font-weight:700;background:#000;color:#fff;border-radius:3px;padding:0 4px;">${i + 1}</span>
      <button data-idx="${i}" class="mc-del" style="position:absolute;top:1px;right:1px;width:18px;height:18px;background:#dc2626;color:#fff;border:0;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;padding:0;">×</button>
    `;
    mcThumbs.appendChild(wrap);
  });
  mcThumbs.querySelectorAll('.mc-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      state.multiCaptures.splice(idx, 1);
      mcRender();
    });
  });
}

function mcStart() {
  if (state.busy) return;
  state.multiCaptures = [];
  state.multiMode = true;
  mcPanel.style.display = 'block';
  mcRender();
  setStatus('Modo captura múltiple — sumá capturas y enviá cuando termines', 'busy');
}

function mcCancel() {
  state.multiCaptures = [];
  state.multiMode = false;
  mcPanel.style.display = 'none';
  setStatus(t('status.initial') || 'Listo.', 'ok');
}

async function mcAddOne() {
  if (state.busy) return;
  // Pequeño feedback: ocultar la app un instante para no contaminar la captura
  const wasVisible = mcPanel.style.display !== 'none';
  try {
    setStatus('Capturando…', 'busy');
    await phantom.window.hide?.();
    // Pausa para que macOS termine de ocultar la ventana antes del screenshot
    await new Promise(r => setTimeout(r, 200));
    const shot = await captureScreen();
    if (shot) state.multiCaptures.push(shot);
    await phantom.window.show?.();
    setStatus(`Captura ${state.multiCaptures.length} agregada`, 'ok');
  } catch (err) {
    setStatus('⚠ ' + err.message, 'err');
    try { await phantom.window.show?.(); } catch (_) {}
  }
  if (wasVisible) mcPanel.style.display = 'block';
  mcRender();
}

async function mcSend(mode) {
  if (state.busy || state.multiCaptures.length === 0) return;
  // 'responder' (default) o 'challenge' — el botón 🧩 del panel manda challenge
  const action = mode === 'challenge' ? 'challenge' : 'responder';
  state.busy = true;
  mcRender();

  // Limpiar conversación previa para mostrar la nueva sesión
  state.mode = action;
  state.messages = [];
  conversationEl.innerHTML = '';
  setDanger(false);

  const n = state.multiCaptures.length;
  setStatus(`Enviando ${n} captura${n === 1 ? '' : 's'}…`, 'busy');
  addMessage('user', (action === 'challenge' ? '🧩 Challenge' : t('msg.user_answer')) + ` (${n} capturas)`);
  const loading = addMessage('assistant', '', true);

  try {
    const cfg = await phantom.config.get();
    const userPrompt = getUserPrompt(action);
    const system = getSystemPrompt(action);

    // Construir content[] con TODAS las imágenes + el texto del prompt al final
    const content = [];
    for (const shot of state.multiCaptures) {
      if (cfg.provider === 'openai') {
        content.push({ type: 'image_url', image_url: { url: shot } });
      } else {
        const m = /^data:(image\/\w+);base64,(.+)$/.exec(shot);
        if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
    }
    content.push({
      type: 'text',
      text: action === 'challenge'
        ? `${userPrompt}\n\nNOTE: I'm sending ${n} screenshots in order (1 → ${n}). ` +
          `They can be different parts of the same challenge: the scrolled statement, ` +
          `different files of the codebase, the terminal, or the existing code to modify. ` +
          `Treat them as ONE challenge context and solve it end to end.`
        : `${userPrompt}\n\nNOTA: te mando ${n} capturas de pantalla en orden (1 → ${n}) ` +
          `porque el contenido tenía scroll y no entraba en una sola imagen. ` +
          `Considerá todas las imágenes como una sola página/vista cuando respondas.`
    });

    const messages = [{ role: 'user', content }];
    const resp = await phantom.ai.call({ messages, system });

    const phishing = detectPhishing(resp.text);
    const reply = stripPhishingMarker(resp.text);
    loading.classList.remove('loading');
    loading.innerHTML = renderMarkdown(reply);

    state.messages.push({ role: 'user', content: userPrompt + ` (${n} screenshots)` });
    state.messages.push({ role: 'assistant', content: reply });

    setDanger(phishing);
    chatWrap.style.display = 'flex';
    setStatus(phishing ? t('status.phishing_detected') : t('status.answer_ready'), phishing ? 'err' : 'ok');

    // Salir del modo multi-captura tras enviar
    state.multiCaptures = [];
    state.multiMode = false;
    mcPanel.style.display = 'none';
  } catch (err) {
    loading.classList.remove('loading');
    loading.innerHTML = '<em style="color:#dc2626">' + escapeHTML(err.message) + '</em>';
    setStatus('⚠ ' + err.message, 'err');
  } finally {
    state.busy = false;
    mcRender();
  }
}

mcBtnStart.addEventListener('click', mcStart);
mcBtnAdd.addEventListener('click', mcAddOne);
mcBtnSend.addEventListener('click', () => mcSend('responder'));
mcBtnCancel.addEventListener('click', mcCancel);
const mcBtnSendChallenge = document.getElementById('btn-mc-send-challenge');
if (mcBtnSendChallenge) mcBtnSendChallenge.addEventListener('click', () => mcSend('challenge'));
// Shortcut: Cmd+Shift+M agrega una captura al modo activo
phantom.on('shortcut:multi-capture-add', () => {
  if (!state.multiMode) mcStart();
  else mcAddOne();
});
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
    exchangePassphrase: $('cfg-exchange-passphrase').value.trim(),
    xEnabled: $('cfg-x-enabled') ? $('cfg-x-enabled').checked : false,
    featureTrading:  $('cfg-feature-trading')   ? $('cfg-feature-trading').checked   : true,
    featureScreen:   $('cfg-feature-screen')    ? $('cfg-feature-screen').checked    : true,
    featureInterview:$('cfg-feature-interview') ? $('cfg-feature-interview').checked : true,
    featureTranslate:$('cfg-feature-translate') ? $('cfg-feature-translate').checked : true,
    // Knowledge base — array de docs persistidos
    knowledgeDocs: getKnowledgeDocs()
  };
  await phantom.config.set(cfg);
  await phantom.window.setContentProtection(cfg.stealth);
  applyFeatureVisibility({
    featureTrading:  cfg.featureTrading,
    featureScreen:   cfg.featureScreen,
    featureInterview:cfg.featureInterview,
    featureTranslate:cfg.featureTranslate
  });
  applyTranslatePanelVisibility(cfg.translateEnabled && cfg.featureTranslate);
  applyInterviewPanelVisibility(cfg.interviewEnabled && cfg.featureInterview);
  applyTradingPanelVisibility(cfg.tradingEnabled && cfg.featureTrading);
  updateTranslateLangLabel();
  setStatus('Configuración guardada.', 'ok');
});

$('cfg-interview').addEventListener('change', (e) => {
  applyInterviewPanelVisibility(e.target.checked);
});

// ─── 📚 Base de conocimiento ────────────────────────────────────────
// state.knowledgeDocs = [{ filename, text, addedAt }, ...]
// Persistido en cfg.knowledgeDocs. Inyectado en el system prompt cuando
// se usa "Contestar pregunta visible" para que el modelo busque ahí primero.
const KB_TOTAL_CHAR_LIMIT = 120_000; // ~30K tokens — Haiku procesa rápido

function getKnowledgeDocs() {
  return Array.isArray(state.knowledgeDocs) ? state.knowledgeDocs : [];
}
function setKnowledgeDocs(docs) {
  state.knowledgeDocs = docs;
  renderKnowledgeList();
}
function renderKnowledgeList() {
  const el = document.getElementById('knowledge-docs-list');
  const metaEl = document.getElementById('knowledge-total-meta');
  if (!el) return;
  const docs = getKnowledgeDocs();
  el.innerHTML = '';
  if (docs.length === 0) {
    el.innerHTML = '<div style="font-size:11px;color:#94a3b8;font-style:italic;">Sin documentos cargados.</div>';
  } else {
    docs.forEach((d, i) => {
      const kb = (d.text.length / 1024).toFixed(1);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f1f5f9;border-radius:6px;font-size:12px;';
      row.innerHTML = `
        <span style="flex:1;color:#1a3a5c;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${escapeHTML(d.filename)}</span>
        <span style="color:#64748b;font-size:11px;">${kb} KB</span>
        <button data-idx="${i}" class="kb-remove-btn" style="background:#fee2e2;color:#b91c1c;border:0;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">×</button>
      `;
      el.appendChild(row);
    });
    el.querySelectorAll('.kb-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const next = getKnowledgeDocs().filter((_, i) => i !== idx);
        setKnowledgeDocs(next);
      });
    });
  }
  const total = docs.reduce((acc, d) => acc + d.text.length, 0);
  if (metaEl) {
    metaEl.textContent = docs.length ? `${docs.length} doc${docs.length === 1 ? '' : 's'} · ${(total / 1024).toFixed(1)} KB total` : '';
  }
}

const addKnowledgeBtn = document.getElementById('cfg-add-knowledge-doc');
if (addKnowledgeBtn) {
  addKnowledgeBtn.addEventListener('click', async () => {
    try {
      setStatus('Procesando documentos…', 'busy');
      const r = await phantom.knowledge.pickDocs();
      if (r?.canceled) { setStatus(t('status.initial'), 'ok'); return; }
      const incoming = r?.docs || [];
      const existing = getKnowledgeDocs();
      // Reemplazar por filename si ya existía (re-upload)
      const merged = [...existing];
      for (const newDoc of incoming) {
        const idx = merged.findIndex((d) => d.filename === newDoc.filename);
        if (idx >= 0) merged[idx] = newDoc; else merged.push(newDoc);
      }
      // Aplicar límite total — si pasa, recortar los más viejos
      let total = merged.reduce((a, d) => a + d.text.length, 0);
      while (total > KB_TOTAL_CHAR_LIMIT && merged.length > 0) {
        const removed = merged.shift();
        total -= removed.text.length;
      }
      setKnowledgeDocs(merged);
      const errMsg = r.errors?.length ? ` (${r.errors.length} con error)` : '';
      setStatus(`✓ ${incoming.length} doc(s) agregados${errMsg}`, 'ok');
      if (r.errors?.length) console.warn('[knowledge] errores:', r.errors);
    } catch (err) {
      setStatus('⚠ ' + err.message, 'err');
    }
  });
}

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

// Hands-free toggles for the two interview-style mic actions. We click the
// real buttons (rather than re-invoking the start/stop functions directly)
// so all the UI side effects — pulsing the button, opening panels, syncing
// state — happen the same way as a manual click.
phantom.on('shortcut:interview-toggle', () => {
  const b = document.getElementById('btn-interview-toggle');
  if (b) {
    // If the interview panel is collapsed/hidden, make sure it's expanded
    // first so the user can see what's going on.
    const panel = document.getElementById('interview-panel');
    if (panel && (panel.style.display === 'none' || panel.classList.contains('collapsed'))) {
      panel.style.display = 'flex';
      panel.classList.remove('collapsed');
    }
    b.click();
  }
});
phantom.on('shortcut:manual-record-toggle', () => {
  const b = document.getElementById('btn-manual-record');
  if (b) {
    const panel = document.getElementById('interview-panel');
    if (panel && (panel.style.display === 'none' || panel.classList.contains('collapsed'))) {
      panel.style.display = 'flex';
      panel.classList.remove('collapsed');
    }
    b.click();
  }
});

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

/**
 * Inline news summarizer — was a separate script (lib/news-summary.js) but
 * CSP `script-src 'self'` was silently blocking it under file:// origin in
 * some Electron builds. Inlining guarantees the news block reaches the prompt.
 */
function inlineSummarizeNewsForPrompt(newsData) {
  if (!newsData) return '';
  const hasRecent   = !!(newsData.recent   && newsData.recent.length);
  const hasUpcoming = !!(newsData.upcoming && newsData.upcoming.length);
  if (!hasRecent && !hasUpcoming) return '';
  const lines = [];
  lines.push('NEWS CONTEXT (real headlines fetched from public feeds — these ARE specific news items, you MUST cite them):');
  if (hasRecent) {
    lines.push('\nRecent headlines:');
    for (const item of newsData.recent.slice(0, 10)) {
      const age = item.hoursAgo !== null && item.hoursAgo !== undefined
        ? `${item.hoursAgo}h ago` : 'recent';
      const votes = item.votes
        ? ` [+${item.votes.positive}/-${item.votes.negative}]` : '';
      lines.push(`  - [${item.source} · ${age}]${votes} ${item.title}`);
    }
  }
  if (hasUpcoming) {
    lines.push('\nUpcoming scheduled events:');
    for (const item of newsData.upcoming) {
      const when = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : '';
      lines.push(`  - [${when}] ${item.title}`);
    }
  }
  lines.push('\nNews interpretation rules:');
  lines.push('- Bullish news + bearish chart = potential bull trap, demand confirmation.');
  lines.push('- Bearish news + bullish chart = capitulation signal, check volume for reversal.');
  lines.push('- Upcoming event within 7 days = elevated volatility risk; size down or wait.');
  lines.push('- Weight the chart MORE than headlines, but flag news as a risk factor in your reasoning.');
  lines.push('- You MUST cite at least 2 specific headlines above by quoting a fragment in SECTION 2.6.');
  return lines.join('\n');
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
    let exchangeCtx = '';
    if (state.mode === 'trading') {
      const exData = await fetchExchangeData();
      exchangeCtx = formatExchangeDataForPrompt(exData);
    }

    const messagesForAPI = state.messages.slice(0, -1);
    let chartDataForPrompt = null;

    if (state.mode === 'trading') {
      const asset = tradingAssetInput.value.trim();
      const chartData = asset
        ? await phantom.trading.captureCharts({ asset, timeframes: ['15', '60', '240'], indicators: Array.from(tradingActiveIndicators) })
        : null;
      chartDataForPrompt = chartData;
      const chart1H = chartData?.['60'];
      const chart4H = chartData?.['240'];

      if (chart1H || chart4H) {
        const cfg = await phantom.config.get();
        const content = [];
        const addImg = (dataUrl) => {
          if (!dataUrl) return;
          if (cfg.provider === 'openai') {
            content.push({ type: 'image_url', image_url: { url: dataUrl } });
          } else {
            const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
            if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          }
        };
        if (chart1H) addImg(chart1H);
        if (chart4H) addImg(chart4H);
        content.push({ type: 'text', text: q + (exchangeCtx ? '\n\n' + exchangeCtx : '') });
        messagesForAPI.push({ role: 'user', content });
      } else {
        const screenshot = await captureScreen();
        messagesForAPI.push({ role: 'user', content: await buildContent(q, screenshot) });
      }
    } else {
      const screenshot = await captureScreen();
      messagesForAPI.push({ role: 'user', content: await buildContent(q, screenshot) });
    }

    const system = state.mode === 'trading' ? getTradingSystemPrompt(exchangeCtx, chartDataForPrompt?._renderedIndicators) : getSystemPrompt(state.mode || 'responder');
    let aiPayload = { messages: messagesForAPI, system };
    if (state.mode === 'trading') {
      const tradingCfg = await phantom.config.get();
      aiPayload.model = tradingCfg.tradingModel || 'claude-opus-4-7';
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

  // Extract DECISION card (ENTER NOW or DO NOT ENTER)
  text = text.replace(/🟢\s*\*{0,2}ENTER NOW\s*[—–-]\s*LONG\*{0,2}/gi, (m) => {
    const idx = tradingBlocks.length;
    tradingBlocks.push(`<div class="trade-decision decision-long">
      <div class="decision-icon">🟢</div>
      <div class="decision-text"><strong>ENTER NOW — LONG</strong></div>
    </div>`);
    return `__TRADE_BLOCK_${idx}__`;
  });
  text = text.replace(/🔴\s*\*{0,2}ENTER NOW\s*[—–-]\s*SHORT\*{0,2}/gi, (m) => {
    const idx = tradingBlocks.length;
    tradingBlocks.push(`<div class="trade-decision decision-short">
      <div class="decision-icon">🔴</div>
      <div class="decision-text"><strong>ENTER NOW — SHORT</strong></div>
    </div>`);
    return `__TRADE_BLOCK_${idx}__`;
  });
  text = text.replace(/🟡\s*\*{0,2}DO NOT ENTER\s*[—–-]\s*WAIT\*{0,2}/gi, (m) => {
    const idx = tradingBlocks.length;
    tradingBlocks.push(`<div class="trade-decision decision-wait">
      <div class="decision-icon">🟡</div>
      <div class="decision-text"><strong>DO NOT ENTER — WAIT</strong></div>
    </div>`);
    return `__TRADE_BLOCK_${idx}__`;
  });

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

  // 2. Remove ugly === separator lines
  text = text.replace(/^={3,}\s*$/gm, '');

  // 2.1 Convert --- horizontal rules (but not inside tables)
  text = text.replace(/^-{3,}\s*$/gm, '___HR___');

  // 2.2 Parse markdown tables into HTML before renderMarkdown
  const tableBlocks = [];
  text = text.replace(/((?:^\|.+\|[ \t]*$\n?){2,})/gm, (tableText) => {
    const rows = tableText.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableText;
    // Check if 2nd row is separator (|---|---|)
    const isSep = /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(rows[1]);
    let html = '<table class="trading-table"><thead><tr>';
    const headerCells = rows[0].split('|').filter(c => c.trim() !== '');
    headerCells.forEach(c => { html += `<th>${c.trim()}</th>`; });
    html += '</tr></thead><tbody>';
    const startRow = isSep ? 2 : 1;
    for (let i = startRow; i < rows.length; i++) {
      const cells = rows[i].split('|').filter(c => c.trim() !== '');
      html += '<tr>';
      cells.forEach(c => { html += `<td>${c.trim()}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    const idx = tableBlocks.length;
    tableBlocks.push(html);
    return `__TABLE_BLOCK_${idx}__`;
  });

  // 2.3 Render normal markdown
  let html = renderMarkdown(text);

  // 2.4 Re-insert tables
  html = html.replace(/__TABLE_BLOCK_(\d+)__/g, (m, idx) => {
    return '</p>' + tableBlocks[Number(idx)] + '<p>';
  });

  // 2.5 Convert HR placeholders
  html = html.replace(/___HR___/g, '</p><hr class="trading-hr"/><p>');

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

// ═════════════════════════════════════════════════════════════════
// VOICE INPUT — el usuario pregunta por VOZ y la respuesta entra al
// chat. Reusa la infra de Deepgram pero captura el MICRÓFONO en vez
// del audio del sistema (que es lo que usa translate/interview).
// Fallback: si no hay Deepgram key, graba con MediaRecorder y manda
// a Whisper en una sola tanda al finalizar.
//
// Flujo: click 🎤 → escucha → click otra vez (o silencio largo) →
// transcripción al input → sendChat() automático.
// ═════════════════════════════════════════════════════════════════
const voiceInput = {
  active: false,
  stream: null,
  audioCtx: null,
  sourceNode: null,
  processorNode: null,
  recorder: null,          // MediaRecorder (modo Whisper fallback)
  recorderChunks: [],
  transcript: '',          // texto acumulado de la sesión actual
  useDeepgram: true,
  autoSend: true           // mandar al chat automático al parar
};

// ═════════════════════════════════════════════════════════════════
// CHEAT SHEET — quick-access interview answers, pre-written in spoken
// English. The user clicks ❓ Preguntas → sees a grid of topics → clicks
// one → the full script appears in a large, readable area. Designed to
// be read out loud verbatim during an interview.
// ═════════════════════════════════════════════════════════════════
(function setupCheatSheet() {
  const btnOpen = document.getElementById('btn-cheatsheet');
  const panel   = document.getElementById('cheatsheet-panel');
  if (!btnOpen || !panel) return;
  const btnClose= document.getElementById('cs-close');
  const search  = document.getElementById('cs-search');
  const grid    = document.getElementById('cs-grid');
  const scriptWrap  = document.getElementById('cs-script-wrap');
  const scriptTitle = document.getElementById('cs-script-title');
  const scriptBody  = document.getElementById('cs-script-body');
  const btnBack = document.getElementById('cs-script-back');

  const BUILT_IN = window.CHEATSHEET_TOPICS || [];
  const USER_STORAGE_KEY = 'phantom_cheatsheet_user_topics_v1';

  // ─── User-added topics (persisted in localStorage so survives restarts) ──
  function loadUserTopics() {
    try {
      const raw = localStorage.getItem(USER_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function saveUserTopics(arr) {
    try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(arr)); }
    catch (_) {}
  }
  function getAllTopics() {
    return [...BUILT_IN, ...loadUserTopics()];
  }

  function renderGrid(filter) {
    const q = (filter || '').trim().toLowerCase();
    grid.innerHTML = '';
    const TOPICS = getAllTopics();
    const matched = TOPICS.filter(tt => {
      if (!q) return true;
      if (tt.title.toLowerCase().includes(q)) return true;
      if (tt.category && tt.category.toLowerCase().includes(q)) return true;
      if (Array.isArray(tt.keywords) && tt.keywords.some(k => k.toLowerCase().includes(q))) return true;
      return false;
    });
    if (matched.length === 0) {
      grid.innerHTML = '<div class="cs-empty">No topics match that filter.</div>';
      return;
    }
    // Group by category for visual structure, but order within category matches the data file.
    const byCat = new Map();
    for (const tt of matched) {
      const cat = tt.category || 'Other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(tt);
    }
    for (const [cat, items] of byCat) {
      const catEl = document.createElement('div');
      catEl.className = 'cs-cat';
      catEl.innerHTML = `<div class="cs-cat-label">${cat}</div><div class="cs-cat-row"></div>`;
      const row = catEl.querySelector('.cs-cat-row');
      for (const tt of items) {
        const b = document.createElement('button');
        b.className = 'cs-pill' + (tt._userAdded ? ' cs-pill-user' : '');
        b.dataset.id = tt.id;
        const userMark = tt._userAdded ? '<span class="cs-pill-mark" title="Added by you">●</span>' : '';
        b.innerHTML = `<span class="cs-pill-icon">${tt.icon || '•'}</span><span class="cs-pill-title">${escapeHTML(tt.title)}</span>${userMark}`;
        b.addEventListener('click', () => openScript(tt.id));
        row.appendChild(b);
      }
      grid.appendChild(catEl);
    }
  }

  function openScript(id) {
    const tt = getAllTopics().find(x => x.id === id);
    if (!tt) return;
    scriptTitle.textContent = (tt.icon ? tt.icon + '  ' : '') + tt.title;
    // textContent preserves \n\n; CSS gives them the visual paragraph break.
    scriptBody.textContent = tt.script || '';
    grid.style.display = 'none';
    search.style.display = 'none';
    scriptWrap.style.display = 'block';
    scriptBody.scrollTop = 0;
    // Show a "🗑 Delete" button only for user-added topics. Built-in topics
    // ship with the app and shouldn't be removable from the UI.
    const oldDel = document.getElementById('cs-script-delete');
    if (oldDel) oldDel.remove();
    if (tt._userAdded) {
      const del = document.createElement('button');
      del.id = 'cs-script-delete';
      del.className = 'cs-script-delete';
      del.textContent = '🗑 Delete';
      del.title = 'Remove this user-added topic';
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${tt.title}" from your cheat sheet?`)) return;
        const left = loadUserTopics().filter(x => x.id !== tt.id);
        saveUserTopics(left);
        closeScript();
        renderGrid(search.value);
      });
      document.querySelector('.cs-script-header').appendChild(del);
    }
  }

  function closeScript() {
    scriptWrap.style.display = 'none';
    grid.style.display = '';
    search.style.display = '';
    search.focus();
  }

  function openPanel() {
    panel.style.display = 'block';
    btnOpen.classList.add('active');
    renderGrid(search.value);
    setTimeout(() => search.focus(), 50);
  }
  function closePanel() {
    panel.style.display = 'none';
    btnOpen.classList.remove('active');
    closeScript();
    search.value = '';
  }
  function togglePanel() {
    if (panel.style.display === 'none' || !panel.style.display) openPanel();
    else closePanel();
  }

  btnOpen.addEventListener('click', togglePanel);
  btnClose.addEventListener('click', closePanel);
  btnBack.addEventListener('click', closeScript);
  search.addEventListener('input', () => renderGrid(search.value));

  // Escape closes the script view (if open) or the panel (if grid is showing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (panel.style.display !== 'block') return;
    if (scriptWrap.style.display === 'block') closeScript();
    else closePanel();
  });

  // ─── Upload doc → AI generates topic in spoken-English style ───────────
  const btnAdd = document.getElementById('cs-add');
  const addStatus = document.getElementById('cs-add-status');

  function setAddStatus(msg, kind) {
    if (!msg) { addStatus.style.display = 'none'; addStatus.textContent = ''; return; }
    addStatus.style.display = 'block';
    addStatus.className = 'cs-add-status' + (kind ? ' ' + kind : '');
    addStatus.textContent = msg;
  }

  // The system prompt we send to the AI to turn a document into a cheat-sheet
  // entry. Mirrors the exact style of the hand-written BUILT_IN topics —
  // conversational English, paragraphs separated by blank lines, numbers as
  // words, first person, no bullets / headers / code blocks. The model also
  // picks a title, an emoji icon, a category from a fixed list, and 4-8
  // keywords for the search filter.
  const GENERATION_SYSTEM = [
    'You convert a technical document into a single CHEAT SHEET ENTRY that the user will read OUT LOUD verbatim in an interview. You return STRICT JSON with the schema:',
    '{ "title": string (max 38 chars, plain words, no emoji),',
    '  "category": one of ["Retrieval","Frameworks","Data","Databases","Prompting","Agents","Ops","Advanced","Other"],',
    '  "icon": one emoji,',
    '  "keywords": string[4..8] (lowercase, single words or short phrases),',
    '  "script": string (the spoken-English answer, see rules below) }',
    '',
    'SCRIPT STYLE — STRICT:',
    '- Conversational English, first person ("what I do is", "the way I handle that", "in my agents").',
    '- 3 paragraphs separated by ONE BLANK LINE (a literal double newline \\n\\n). The blank line is the cue for the user to PAUSE and BREATHE while speaking.',
    '- Each paragraph ≈ 3-5 sentences. Total ≈ 150-260 words.',
    '- NO bullet points. NO numbered lists. NO markdown headers. NO code blocks. NO tables. Pure flowing prose.',
    '- NUMBERS AS WORDS — the user is reading aloud and stumbles on digits. "250,000" → "two hundred fifty thousand". "30%" → "thirty percent". "$2.5M" → "two and a half million dollars". "2024" → "twenty twenty-four". "5 min" → "five minutes". Version numbers/ports too.',
    '- Natural spoken connectors: "basically", "for example", "in practice", "the way I think about it is", "what I appreciate about X is", "the trade-off is".',
    '- Explain what it is → give a concrete example → say when you would use it and when you would not. Weave the comparison into prose, do not list each side.',
    '- Use the DOCUMENT below as the source of truth for the technical content, but REWRITE it entirely in the spoken style. Do NOT quote it verbatim. Do NOT mention "the document" or "as described in".',
    '',
    'OUTPUT: return ONLY the JSON object, no prose, no markdown fence. The script field must contain real \\n\\n between paragraphs.'
  ].join('\n');

  function deriveIdFromTitle(title) {
    return 'user-' + String(title).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      + '-' + Math.random().toString(36).slice(2, 7);
  }

  function safeParseJSON(text) {
    if (!text) return null;
    // Strip markdown fences if the model added them despite the instruction.
    const t = String(text).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '');
    try { return JSON.parse(t); } catch (_) {
      // Last-ditch: find the first {...} block.
      const m = t.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
      return null;
    }
  }

  async function generateFromDoc(filename, text) {
    // Cap the document at ~30k chars so we don't blow the context window
    // for very long PDFs. The model gets the head + tail with a marker if
    // we had to trim; usually plenty for a technical doc.
    const MAX = 30_000;
    let docPart = text;
    if (text.length > MAX) {
      const half = Math.floor(MAX / 2);
      docPart = text.slice(0, half) + '\n\n[... middle of document trimmed ...]\n\n' + text.slice(-half);
    }
    const userMsg =
      `Document filename: ${filename}\n\n===== DOCUMENT START =====\n${docPart}\n===== DOCUMENT END =====\n\n` +
      `Generate the cheat sheet entry following the rules in the system message. Return ONLY the JSON object.`;
    const resp = await phantom.ai.call({
      messages: [{ role: 'user', content: userMsg }],
      system: GENERATION_SYSTEM,
      maxTokens: 1500
    });
    const obj = safeParseJSON(resp.text);
    if (!obj || !obj.title || !obj.script) {
      throw new Error('AI did not return valid JSON. Try a different document or retry.');
    }
    // Sanitize / fill defaults so a bad model response can't break the grid.
    return {
      id: deriveIdFromTitle(obj.title),
      title: String(obj.title).slice(0, 60),
      category: ['Retrieval','Frameworks','Data','Databases','Prompting','Agents','Ops','Advanced','Other'].includes(obj.category)
        ? obj.category : 'Other',
      icon: (typeof obj.icon === 'string' && obj.icon.length <= 4) ? obj.icon : '📄',
      keywords: Array.isArray(obj.keywords) ? obj.keywords.slice(0, 10).map(k => String(k).toLowerCase()) : [],
      script: String(obj.script).trim(),
      _userAdded: true,
      _sourceFile: filename,
      _addedAt: Date.now()
    };
  }

  if (btnAdd) {
    btnAdd.addEventListener('click', async () => {
      if (btnAdd.disabled) return;
      btnAdd.disabled = true;
      setAddStatus('📂 Eligiendo documento(s)…', 'busy');
      try {
        const res = await phantom.knowledge.pickDocs();
        if (!res || res.canceled) { setAddStatus(''); return; }
        const docs = Array.isArray(res.docs) ? res.docs : [];
        if (!docs.length) {
          setAddStatus('⚠ No se pudo extraer texto de ningún archivo.', 'err');
          return;
        }
        const existing = loadUserTopics();
        let added = 0, failed = 0;
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i];
          setAddStatus(`🧠 Procesando ${i + 1}/${docs.length}: ${d.filename}…`, 'busy');
          try {
            const topic = await generateFromDoc(d.filename, d.text);
            existing.push(topic);
            added++;
          } catch (e) {
            console.error('[cheatsheet] generation failed for', d.filename, e);
            failed++;
          }
        }
        saveUserTopics(existing);
        renderGrid(search.value);
        const parts = [];
        if (added)  parts.push(`✓ ${added} agregado${added > 1 ? 's' : ''}`);
        if (failed) parts.push(`⚠ ${failed} falló${failed > 1 ? 'n' : ''}`);
        setAddStatus(parts.join(' · '), failed ? 'err' : 'ok');
        setTimeout(() => setAddStatus(''), 6000);
      } catch (err) {
        console.error('[cheatsheet] add error', err);
        setAddStatus('⚠ ' + err.message, 'err');
      } finally {
        btnAdd.disabled = false;
      }
    });
  }

  // First render so it's ready when opened.
  renderGrid('');
})();

(function setupVoiceInput() {
  const btn = document.getElementById('btn-mic');
  const status = document.getElementById('voice-status');
  const statusText = document.getElementById('voice-status-text');
  const transcriptEl = document.getElementById('voice-transcript');
  if (!btn) return;

  function setUI(state, text) {
    btn.classList.toggle('recording', state === 'rec');
    btn.textContent = state === 'rec' ? '⏹' : '🎤';
    btn.title = state === 'rec' ? 'Parar y enviar' : 'Preguntar con tu voz';
    if (state === 'idle') {
      status.style.display = 'none';
      transcriptEl.textContent = '';
    } else {
      status.style.display = 'flex';
      statusText.textContent = text || 'Escuchando…';
    }
  }
  setUI('idle');

  btn.addEventListener('click', () => {
    if (voiceInput.active) stopVoiceInput(true);
    else startVoiceInput();
  });

  // Second trigger: prominent "🎤 Preguntar" button in the always-visible
  // actions row. Toggles the same recording state, but also makes the chat
  // wrap visible so the user immediately sees the live transcript line.
  const askBtn = document.getElementById('btn-voice-ask');
  if (askBtn) {
    askBtn.addEventListener('click', () => {
      if (chatWrap.style.display === 'none' || !chatWrap.style.display) {
        chatWrap.style.display = 'flex';
      }
      if (voiceInput.active) stopVoiceInput(true);
      else startVoiceInput();
      askBtn.classList.toggle('recording', voiceInput.active);
      askBtn.textContent = voiceInput.active ? '⏹ Parar' : '🎤 Preguntar';
    });
  }

  async function startVoiceInput() {
    if (typeof translate !== 'undefined' && translate.active) {
      setStatus('⚠ Pará primero la traducción para usar el micrófono.', 'err');
      return;
    }
    if (typeof interview !== 'undefined' && interview.active) {
      setStatus('⚠ Pará primero el modo entrevista para usar el micrófono.', 'err');
      return;
    }
    const cfg = await phantom.config.get();
    voiceInput.useDeepgram = !!cfg.deepgramKey;
    if (!voiceInput.useDeepgram && !cfg.openaiKey) {
      setStatus('⚠ Falta API key de Deepgram u OpenAI en Settings.', 'err');
      return;
    }

    // Asegurar que el chat-wrap esté visible (puede estarlo si ya hay mensajes;
    // si no, lo mostramos para que el usuario vea su pregunta + respuesta).
    if (chatWrap.style.display === 'none') chatWrap.style.display = '';

    try {
      voiceInput.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          channelCount: 1
        }
      });
    } catch (err) {
      console.error('voice-input mic error:', err);
      setStatus('⚠ No se pudo acceder al micrófono: ' + err.message, 'err');
      return;
    }

    voiceInput.active = true;
    voiceInput.transcript = '';
    transcriptEl.textContent = '';
    setUI('rec', voiceInput.useDeepgram ? '🎙 Escuchando…' : '🎙 Grabando (Whisper)…');

    if (voiceInput.useDeepgram) {
      await startDeepgramForMic(cfg);
    } else {
      startWhisperForMic();
    }
  }

  async function startDeepgramForMic(cfg) {
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    voiceInput.audioCtx = audioCtx;
    const source = audioCtx.createMediaStreamSource(voiceInput.stream);
    voiceInput.sourceNode = source;
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    voiceInput.processorNode = processor;
    processor.onaudioprocess = (ev) => {
      if (!voiceInput.active) return;
      const f32 = ev.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      phantom.deepgram.sendAudio(i16.buffer);
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    try {
      // 'auto' → Deepgram detect_language=true. The user could ask in any
      // language; we don't want to bias transcription to the UI's idiom.
      await phantom.deepgram.start({ language: 'auto', sampleRate: 16000 });
    } catch (err) {
      console.error('Deepgram start (voice-input) error:', err);
      setStatus('⚠ ' + err.message, 'err');
      stopVoiceInput(false);
    }
  }

  function startWhisperForMic() {
    voiceInput.recorderChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');
    try {
      voiceInput.recorder = new MediaRecorder(voiceInput.stream, { mimeType });
    } catch (e) {
      setStatus('⚠ MediaRecorder error: ' + e.message, 'err');
      stopVoiceInput(false);
      return;
    }
    voiceInput.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) voiceInput.recorderChunks.push(ev.data);
    };
    voiceInput.recorder.onstop = async () => {
      if (!voiceInput.recorderChunks.length) return;
      const blob = new Blob(voiceInput.recorderChunks, { type: mimeType });
      const buf = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      try {
        statusText.textContent = 'Transcribiendo…';
        // No language hint → Whisper auto-detects, so the user can speak any tongue.
        const res = await phantom.translate.transcribe({ audio_base64: b64, mime: mimeType });
        if (res && res.ok && res.text) {
          voiceInput.transcript = res.text.trim();
          deliverTranscript();
        } else {
          setStatus('⚠ ' + (res?.error || 'Transcripción vacía'), 'err');
        }
      } catch (e) {
        setStatus('⚠ ' + e.message, 'err');
      } finally {
        setUI('idle');
      }
    };
    voiceInput.recorder.start();
  }

  // Listeners de Deepgram — solo procesamos cuando voiceInput está activo.
  // Los listeners de translate.js chequean translate.active, así que no chocan.
  phantom.on('deepgram:interim', (transcript) => {
    if (!voiceInput.active) return;
    transcriptEl.textContent = (voiceInput.transcript ? voiceInput.transcript + ' ' : '') + transcript;
  });
  phantom.on('deepgram:final', (transcript, speechFinal) => {
    if (!voiceInput.active) return;
    if (!transcript || transcript.trim().length < 1) return;
    voiceInput.transcript = (voiceInput.transcript ? voiceInput.transcript + ' ' : '') + transcript.trim();
    transcriptEl.textContent = voiceInput.transcript;
  });
  phantom.on('deepgram:error', (err) => {
    if (!voiceInput.active) return;
    setStatus('⚠ Deepgram: ' + err, 'err');
  });

  function deliverTranscript() {
    const text = (voiceInput.transcript || '').trim();
    if (!text) {
      setStatus('No se escuchó nada.', 'err');
      return;
    }
    if (voiceInput.autoSend) {
      // Dedicated voice path: pure Q&A, NO screenshot of the screen behind,
      // language follows the QUESTION (not the UI), and the user's uploaded
      // documents (CV / knowledge base) are injected so the model can pull
      // personal context when relevant.
      sendVoiceQuestion(text);
    } else {
      chatInput.value = text;
      chatInput.focus();
    }
  }

  // Standalone send path used ONLY by the voice button. Lives inside the
  // setupVoiceInput IIFE so it doesn't leak into the global chat behavior.
  async function sendVoiceQuestion(text) {
    if (state.busy) return;
    state.busy = true;

    if (chatWrap.style.display === 'none' || !chatWrap.style.display) {
      chatWrap.style.display = 'flex';
    }
    addMessage('user', text);
    const loading = addMessage('assistant', '', true);
    setStatus(t('status.thinking'), 'busy');
    state.messages.push({ role: 'user', content: text });

    const kb = (typeof getKnowledgeBaseBlock === 'function') ? getKnowledgeBaseBlock() : '';
    const system = [
      'You are answering a SPOKEN question. The user is going to READ YOUR ANSWER OUT LOUD as their own — to a colleague, in a meeting, on a call. So your answer must already BE the speech, ready to recite, in flowing prose.',
      '',
      'CRITICAL RULES:',
      '- NO screenshot exists. Do NOT reference "the screen", "what you see", "the page". Just answer the question.',
      '- LANGUAGE: detect the language of the user\'s question and reply in THAT SAME language. If they asked in English → English. Spanish → Spanish. French → French. Never default to a language they did not use.',
      '',
      'PARAGRAPH STRUCTURE — CRITICAL: The user is going to READ YOUR ANSWER OUT LOUD in real time. They need clear breath points. SPLIT your answer into 2-4 paragraphs separated by ONE BLANK LINE between them (a literal double newline in the output). Each paragraph = one self-contained idea (2-4 sentences). A paragraph break IS the cue for "pause and breathe before the next idea". Never deliver a wall of text, even for short answers.',
      '',
      'NUMBERS AS WORDS — CRITICAL: Since the user is reading aloud, write ALL numbers as words in the answer\'s language. The user CANNOT pronounce digits like "250,000" or "$2.5M" smoothly while speaking — they stumble.',
      '- "250,000" → "doscientos cincuenta mil" / "two hundred fifty thousand"',
      '- "$2.5M" → "dos millones y medio de dólares" / "two and a half million dollars"',
      '- "30%" → "treinta por ciento" / "thirty percent"',
      '- "2024" → "dos mil veinticuatro" / "twenty twenty-four"',
      '- "3x faster" → "tres veces más rápido" / "three times faster"',
      '- Version numbers, ports, codes → also as words ("versión dos punto cero", "puerto cuatro mil quinientos")',
      '- ONLY exception: if the user explicitly asks for the digit form ("dame el número exacto", "give me the figure"), then use digits.',
      '',
      'STYLE — write the way a person actually TALKS when they\'re explaining something they understand well:',
      '- Pure flowing prose. NO bullet points. NO numbered lists. NO markdown headers. NO tables. NO code blocks (unless they literally asked for code).',
      '- Use natural spoken connectors: "por ejemplo", "es decir", "o sea", "en cambio", "por otro lado", "mientras que", "supongamos que", "imaginate", "fijate", "lo bueno de X es que…", "la diferencia está en…", "yo lo usaría cuando…". (English equivalents: "for example", "that is", "I mean", "whereas", "on the other hand", "imagine", "let\'s say", "the thing about X is…", "the difference is…", "I\'d use it when…")',
      '- When comparing two things: weave the comparison into one explanation, don\'t list each side separately. Say WHAT each one is, FOR WHAT case each serves, and IN WHICH situation you\'d pick one over the other — all in the same paragraph, conversationally.',
      '- After defining a concept, immediately follow with a concrete example using real-world stuff (not abstract code). Then say when you\'d use it and when you wouldn\'t.',
      '- Length: enough to fully explain the answer as if speaking to a smart friend who doesn\'t know the topic. Usually 4-10 sentences flowing. Not too short ("just a definition") and not an essay.',
      '- First person when relevant — "yo lo usaría", "me conviene", "armaría así…". Speak with confidence and ownership.',
      '- If the question is a comparison/difference: ALWAYS structure as → "The difference is direct but each one serves a different purpose. X is [what it is], for example [concrete case], and you use it when [scenario]. Y in contrast is [what it is], it serves for [other case], and you go for it when [other scenario]."',
      '- Use the personal documents below when relevant — incorporate naturally in first person, as YOUR knowledge. Never say "according to your CV" or "the document says".',
      '',
      'TONE EXAMPLE (Spanish, comparison question — THIS IS THE TARGET FEEL):',
      'Q: "diferencia entre base de datos común y vectorial"',
      'A:',
      '"La diferencia es directa pero cada una sirve para un caso distinto. Una base de datos común te sirve cuando los datos son estructurados — texto, números, fechas, relaciones entre tablas — por ejemplo guardar usuarios, productos, transacciones, todo lo que consultás con condiciones exactas tipo \'dame los usuarios mayores de 25 años\'. Postgres, MySQL, esas son comunes y son rápidas para queries de ese estilo.',
      '',
      'En cambio, una base de datos vectorial está pensada para almacenar embeddings, que son listas largas de números que representan el significado de algo: un texto, una imagen, un audio. Lo que cambia es la búsqueda: en vez de buscar por igualdad, buscás por similitud — \'dame los 10 documentos más parecidos a este\'. Ahí es donde una Pinecone, una pgvector o una Weaviate brillan, porque ese tipo de query lo hacen en milisegundos sobre millones de vectores.',
      '',
      'Yo elegiría la común para datos transaccionales clásicos, y la vectorial cuando el caso es semántico, tipo búsqueda inteligente, recomendaciones, o un RAG."',
      '',
      '↑ Notice the THREE paragraphs separated by blank lines. That\'s the target structure for EVERY answer.',
      '',
      kb || '(No personal documents attached.)',
      '',
      SECURITY_RULE
    ].join('\n');

    try {
      const resp = await phantom.ai.call({
        messages: state.messages.slice(),
        system
      });
      const phishing = detectPhishing(resp.text);
      const reply = stripPhishingMarker(resp.text);
      loading.classList.remove('loading');
      loading.innerHTML = renderMarkdown(reply);
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

  async function stopVoiceInput(deliver) {
    if (!voiceInput.active) return;
    voiceInput.active = false;
    setUI('idle');

    // Modo Deepgram: cortar audio context + WS
    if (voiceInput.processorNode) {
      try { voiceInput.processorNode.disconnect(); } catch {}
      voiceInput.processorNode.onaudioprocess = null;
      voiceInput.processorNode = null;
    }
    if (voiceInput.sourceNode) {
      try { voiceInput.sourceNode.disconnect(); } catch {}
      voiceInput.sourceNode = null;
    }
    if (voiceInput.audioCtx) {
      try { voiceInput.audioCtx.close(); } catch {}
      voiceInput.audioCtx = null;
    }
    if (voiceInput.useDeepgram) {
      try { await phantom.deepgram.stop(); } catch {}
    }

    // Modo Whisper: parar recorder (su onstop se encarga de transcribir + entregar)
    if (voiceInput.recorder && voiceInput.recorder.state !== 'inactive') {
      try { voiceInput.recorder.stop(); } catch {}
      // El delivery se hace dentro del onstop después de Whisper.
    } else if (deliver) {
      // Deepgram: entregamos lo acumulado.
      deliverTranscript();
    }

    if (voiceInput.stream) {
      voiceInput.stream.getTracks().forEach(t => t.stop());
      voiceInput.stream = null;
    }
    voiceInput.recorder = null;
    voiceInput.recorderChunks = [];
  }
})();

// ─── Interview Mode (escuchar al entrevistador + responder como vos) ──
// Emisor de eventos del ciclo de entrevista. El teleprompter (y cualquier
// otra vista) se suscribe acá en vez de tocar las funciones del ciclo.
function interviewEmit(kind, detail = {}) {
  document.dispatchEvent(new CustomEvent('phantom:interview', { detail: { kind, ...detail } }));
}

const interview = {
  active: false,
  stream: null,
  recorder: null,
  cycleTimer: null,
  silenceTimer: null,
  CHUNK_MS: 2500,
  // Ciclos de silencio consecutivos antes de dar la pregunta por terminada.
  // 2 × CHUNK_MS ≈ 5s: alcanza para que el entrevistador piense a mitad de
  // frase sin que le cortemos la pregunta al medio.
  SILENCE_CHUNKS: 2,
  // Si vuelve a hablar dentro de esta ventana tras una respuesta, era
  // continuación de la misma pregunta, no una nueva.
  CONTINUATION_MS: 15000,
  silentChunks: 0,
  autoAnswer: true,          // false = sólo contesta con Enter (manual)
  lastAnsweredAt: 0,
  lastAnsweredQuestion: '',
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
    interview.silentChunks = 0;
    interview.lastAnsweredAt = 0;
    interview.lastAnsweredQuestion = '';
    interview.lastTranscriptionAt = Date.now();
    btnInterview.textContent = 'Detener';
    interviewStatusEl.classList.add('live');
    interviewQuestionEl.textContent = '🎙️ Escuchando…';
    interviewAnswerEl.textContent = 'Te muestro la respuesta cuando detecte una pregunta.';
    interviewAnswerEl.classList.add('pending');
    btnRegenerate.style.display = 'none';
    setStatus('Modo entrevista activo. Escuchando…', 'ok');
    interviewEmit('start');

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
  interviewEmit('stop');

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
      interviewEmit('hearing', { text: interview.buffer });
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
  // Contar silencios CONSECUTIVOS. Un solo chunk vacío (2.5s) no alcanza:
  // el entrevistador piensa a mitad de frase todo el tiempo, y cortarlo ahí
  // hacía que Phantom contestara media pregunta y después tratara el resto
  // ("gracias, podés contestar") como si fuera una pregunta nueva.
  if (silenceDetected) interview.silentChunks++;
  else interview.silentChunks = 0;

  // Modo manual: no dispara solo, espera que apretes Enter.
  if (!interview.autoAnswer) return;

  const buf = interview.buffer.trim();
  if (!buf || buf.length < 5) return;

  const enoughSilence = interview.silentChunks >= interview.SILENCE_CHUNKS;
  const tooLong = buf.length > 600;

  // Ojo: NO se dispara por terminar en "?". Una pregunta puede tener varios
  // signos antes de estar completa ("¿cómo lo harías? o sea, en producción…").
  // El único disparador real es el silencio sostenido.
  if (enoughSilence || tooLong) answerNow();
}

/**
 * Contesta con TODO lo escuchado hasta ahora. Lo llama el ciclo automático
 * (tras silencio sostenido) y también el Enter manual del teleprompter.
 */
function answerNow() {
  const buf = interview.buffer.trim();
  if (!buf || buf.length < 3) return;

  interview.buffer = '';
  interview.silentChunks = 0;

  // Si acaba de contestar y el otro siguió hablando, era la MISMA pregunta
  // partida en dos por una pausa: se recontesta el conjunto en vez de
  // responder sólo el fragmento nuevo, que aislado no significa nada.
  const now = Date.now();
  const isContinuation =
    interview.lastAnsweredQuestion &&
    (now - interview.lastAnsweredAt) < interview.CONTINUATION_MS;

  const question = isContinuation
    ? `${interview.lastAnsweredQuestion} ${buf}`
    : buf;

  // La respuesta anterior queda obsoleta: sale del contexto que se le manda
  // al modelo para que no vea la pregunta partida dos veces.
  if (isContinuation) interview.history.pop();

  interview.lastAnsweredAt = now;
  interview.lastAnsweredQuestion = question;
  answerInterviewQuestion(question);
}

async function answerInterviewQuestion(question) {
  interview.lastQuestion = question;
  interviewQuestionEl.textContent = question;
  interviewAnswerEl.classList.add('pending');
  interviewAnswerEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  btnRegenerate.style.display = 'none';
  interviewEmit('question', { question });

  try {
    const resp = await phantom.interview.answer({
      question,
      conversationContext: interview.history,
      // El teleprompter (cámara encendida) pide tarjetas de apuntes en vez de
      // párrafos: mirar de reojo y parafrasear no delata, leer de corrido sí.
      style: window.__phantomTpStyle || undefined
    });
    const answer = (resp.text || '').trim();

    interviewAnswerEl.classList.remove('pending');
    interviewAnswerEl.textContent = answer || '(sin respuesta)';
    btnRegenerate.style.display = 'inline-block';

    interview.history.push({ q: question, a: answer });
    addInterviewHistoryItem(question, answer);
    interviewEmit('answer', { question, answer });
  } catch (err) {
    interviewAnswerEl.classList.remove('pending');
    interviewAnswerEl.innerHTML = '<span style="color:#dc2626;">⚠ ' + escapeHTML(err.message) + '</span>';
    interviewEmit('error', { message: err.message });
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

function buildStrategySummary() {
  if (typeof TRADING_STRATEGIES === 'undefined') return '';
  return TRADING_STRATEGIES.map(s => {
    const rules = s.rules;
    return `### ${s.name} [${s.category}]
- TF: ${s.timeframes.join(', ')} | Market: ${s.market} | WR: ${s.winRate} | R:R ${s.rr}
- Indicators: ${s.indicators.join(', ')}
- LONG: ${rules.longEntry}
- SHORT: ${rules.shortEntry}
- SL: ${rules.stopLoss} | TP: ${rules.takeProfit}
- Filters: ${rules.filters}`;
  }).join('\n\n');
}

function getTradingSystemPrompt(exchangeContext, renderedIndicators) {
  const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
  const langName = LANG_NAMES[uiLang] || 'Spanish';

  const activeInds = [...tradingActiveIndicators]
    .map(id => TRADING_INDICATORS.find(i => i.id === id))
    .filter(Boolean)
    .map(i => `- ${i.name}: ${i.desc}`)
    .join('\n');

  const visibleSet = Array.isArray(renderedIndicators) && renderedIndicators.length
    ? renderedIndicators
    : [...tradingActiveIndicators];
  const visibleInds = visibleSet
    .map(id => TRADING_INDICATORS.find(i => i.id === id))
    .filter(Boolean)
    .map(i => `- ${i.name}`)
    .join('\n');
  const visibleSection = `\n\nINDICATORS VISIBLE ON CHART (these are the ONLY ones you can read numerical values from — the rest of the toolkit is for contextual knowledge only):\n${visibleInds || '- (none — only price action)'}\n\nFor any indicator NOT in the list above, you may discuss what it WOULD show conceptually, but you MUST NOT cite a specific value for it. If you mention them, say "I cannot read X directly from the chart, but based on price action it likely shows..."`;

  const asset = tradingAssetInput.value.trim();
  const assetLine = asset ? `The user is analyzing: ${asset}` : 'The user has not specified an asset — infer it from the chart if possible.';
  const strategySummary = buildStrategySummary();

  const exchangeSection = exchangeContext ? `

LIVE MARKET DATA:
You have access to REAL-TIME market data. This is NOT hypothetical — use it as a KEY factor in your decision.

EXCHANGE DATA (if connected):
- Evaluate their current position (entry price, unrealized PnL, liquidation risk)
- Suggest whether to hold, add to position, take profit, or cut losses
- Consider their open orders (take profits, stop losses) in your analysis
- Factor their available margin/balance into risk management
- Be specific: "Your long from $80,074 is currently +$X, consider taking partial profit at..."

FUNDING RATE ANALYSIS:
- Positive funding = longs pay shorts → market is overleveraged long → bearish pressure
- Negative funding = shorts pay longs → market is overleveraged short → bullish pressure
- Extreme funding (>0.05% per 8h or <-0.05%) = high probability of mean reversion/squeeze
- Use funding as a CONTRARIAN indicator for medium-term bias

OPEN INTEREST (OI) ANALYSIS:
- Rising OI + Rising Price = New money entering longs → bullish confirmation
- Rising OI + Falling Price = New money entering shorts → bearish confirmation
- Falling OI + Rising Price = Short covering rally → weak/unsustainable move
- Falling OI + Falling Price = Long liquidation → capitulation phase

LONG/SHORT RATIO & TOP TRADER POSITIONING:
- When >65% are long, shorts have higher squeeze potential but longs may get trapped
- When >65% are short, longs have higher squeeze potential but shorts may get trapped
- Smart money (top traders) diverging from retail = follow smart money
- Extreme imbalance = incoming squeeze against the majority

FEAR & GREED INDEX:
- 0-20: Extreme Fear → historically best buying opportunities
- 20-40: Fear → good accumulation zone
- 40-60: Neutral → wait for direction
- 60-80: Greed → reduce exposure, tighten stops
- 80-100: Extreme Greed → high reversal risk, don't open new longs

MARKET CONTEXT:
- If top gainers/losers show broad market moves, the asset is correlated → less alpha in the setup
- If the asset moves independently while market is flat → stronger signal
- Trending coins show market narrative/rotation → use for context

NEWS & EVENTS CONTEXT:
You may receive a NEWS CONTEXT block in the user prompt with real headlines and upcoming events.
- Always read it BEFORE giving your decision. Cite specific headlines that influence your bias.
- Weight news LESS than the chart but flag it as a risk factor in SECTION 7 (Risk Factors).
- Upcoming events within 7 days = volatility risk: recommend smaller size or WAIT.
- News-driven moves often retrace once the headline fades — fade strong rallies on bullish news with no chart support.
- If NO news data is available, treat news sentiment as neutral and don't fabricate headlines.
` : '';

  return `🌐 OUTPUT LANGUAGE — ABSOLUTE PRIORITY: Your entire response MUST be written in ${langName} (${uiLang}). Every section header, every label, every sentence, every word. The user's app interface is set to ${langName}; mixing languages or replying in English when ${langName} is requested is a critical failure. The data blocks in this prompt use English keywords (technical terms like "Funding Rate", "Open Interest", "Taker Ratio") — translate or transliterate them into ${langName} when writing your reply. Section titles like "SECCIÓN 1 — DECISIÓN" should be in ${langName} too.

You are a senior professional trader and institutional-grade technical analyst with 15+ years of experience across crypto, equities, forex, and commodities markets. You have managed 8-figure portfolios and specialized in multi-timeframe analysis, order flow, and risk-adjusted position sizing.

CRITICAL — REAL MONEY IS AT STAKE. NEVER INVENT DATA.

The user trades REAL money. A wrong analysis costs real dollars. These rules are NON-NEGOTIABLE:

1. **ONLY REPORT WHAT YOU LITERALLY SEE ON THE CHART.** Every single value, level, candle, and pattern you mention must be VISUALLY READABLE in the screenshot. The chart images you receive are 1H and 4H of the asset. Look at them. Read them. Report them.

2. **FORBIDDEN: INVENTING PRECISE NUMBERS.**
   - DO NOT write "RSI 24.68" or "MACD -64.56" unless you can see those exact digits on screen.
   - DO NOT cite "$80,200" as a level if no candle reached that price on the visible chart.
   - DO NOT make up indicator values for indicators that are NOT shown in the panes below price.
   - Instead, describe what you actually see: "RSI is in the oversold zone, around 30", "MACD lines are below zero and diverging", "price is testing the upper Bollinger band". Approximate ranges from visual reading are HONEST. Fake precise decimals are LIES.

3. **ONLY ANALYZE INDICATORS ACTUALLY ON THE CHART.** The chart was rendered with a SPECIFIC subset of indicators (listed below as "INDICATORS VISIBLE ON CHART"). Those are the ones you can read. The "INDICATORS IN YOUR TOOLKIT" list is your KNOWLEDGE — you can MENTION how they would interpret what you see, but you CANNOT cite numerical values for indicators not visually present.

4. **FORBIDDEN: INVENTING PATTERNS.**
   - DO NOT call it a "double top" unless you can see TWO distinct highs at approximately the same price.
   - DO NOT call "bearish divergence" unless you can trace price making a higher high while the indicator makes a lower high (or vice versa).
   - DO NOT claim "rejection with long upper wick" if the candles don't show long upper wicks.
   - If the chart shows consolidation/sideways action, say so. Most of the time charts ARE inconclusive. Honesty about "no clear setup" is more valuable than a fabricated one.

5. **MANDATORY READING PROTOCOL — DO THIS BEFORE WRITING:**
   - Step A: Look at the 4H chart. Identify the trend direction over the visible candles (uptrend / downtrend / range). Note the highest and lowest prices visible.
   - Step B: Look at the 1H chart. Same identification. Note the most recent 5-10 candles' behavior (impulsive up? impulsive down? consolidation? rejection?).
   - Step C: Read each indicator pane visible. For each, note position (overbought/oversold/neutral) and direction (rising/falling/flat).
   - Step D: Only NOW form the analysis. The decision must flow from steps A-C, not vice versa.

6. **CONFLUENCE = HONEST COUNTING.** When stating "X/4 timeframes aligned":
   - List each TF and its bias explicitly in the table.
   - Count the aligned ones. Don't write "3/4" if the table shows 2 bullish + 1 bearish + 1 neutral — that's 2/4.
   - 0-2/4 → MANDATORY "DO NOT ENTER — WAIT". No exceptions.
   - 3-4/4 → can recommend direction.

7. **CONSISTENCY CHECK BEFORE SENDING.** Re-read your response. Verify:
   - Decision in Section 1 matches Confluence Score
   - Bias % in Section 8 matches decision (e.g. can't be 50/50 with a LONG recommendation)
   - Active trade setup in Section 9 matches decision (WAIT decision → WAIT setup, not a forced long/short)
   - Cited indicator values are values you actually read, not invented
   If anything contradicts, REWRITE. Don't send contradictions to a trader.

8. **WHEN UNCERTAIN → WAIT.** Default bias under uncertainty is "NO TRADE." Missing a trade = $0 lost. Recommending a bad trade = real $ lost. Asymmetric. Always lean toward WAIT when the chart is ambiguous.

9. **WHEN THE USER PUSHES BACK — NEVER CAPITULATE WITHOUT VERIFICATION.**
   This is the most dangerous moment. A wrong "you're right, my mistake" costs the user real money. Follow this PROTOCOL strictly:

   STEP 1: Re-read the actual data you received in this conversation. Quote the EXACT value from the prompt blocks (EXCHANGE DATA, COINGLASS, NEWS, etc.). Do not trust your memory of what you said — quote the SOURCE.

   STEP 2: Compare to what the user is asserting.

   STEP 3: One of three outcomes:
     (a) The user is right AND the data you received was wrong → say "I had X% from {source}, but if you see Y% on your screen the {source} feed is stale. Re-pulling on next analysis. For now I'll trust your live reading." NEVER claim YOU made the mistake when it was a data feed issue.
     (b) The user is right AND you misread the data → quote the data you received, point out the specific misread, correct it. e.g. "You're right — the funding rate in my data is -0.0183%. I incorrectly reported 2.43%. Corrected analysis follows."
     (c) The user is wrong (your data says X, their assertion conflicts) → defend with the data. e.g. "The COINGLASS block in your prompt shows funding +0.16%. If your exchange shows something different, we may be looking at different timeframes/contracts. Which contract are you reading?"

   NEVER say "tienes razón" / "you're right" without first quoting the specific data and explaining WHICH outcome (a/b/c) applies.

   FORBIDDEN phrases unless you back them with a specific quoted value:
     - "Tienes razón"
     - "Mi error"
     - "Lo leí mal"
     - "Análisis corregido"
     - "Tu análisis fue correcto"
   These phrases REQUIRE a quote from the prompt data showing what you originally received vs what you should have reported.

10. **DATA SOURCE HIERARCHY (when sources conflict, follow this order):**
    1. EXCHANGE DATA block (KuCoin / Binance) — REAL-TIME from official exchange APIs. Treat as authoritative for: live price, funding rate, your open positions, your balance.
    2. COINGLASS AGGREGATED DATA block — useful for: aggregated OI across exchanges, total liquidations, global L/S ratio. NOT used for funding rate (Coinglass renders it in a canvas, unreliable).
    3. Chart screenshots — for: price action, patterns, indicator readings visible on screen.
    4. User's live screen claim — if user contradicts your prompt data, prefer YOUR DATA but acknowledge the user's screen and offer to re-fetch.

    Funding rate specifically: ONLY trust the EXCHANGE DATA block's "💸 FUNDING RATE" value. If a user says funding is -0.0183% but your data says +2%, your data wins (or is stale — never adopt the user's number as if it were yours).

YOUR TRADING PHILOSOPHY:
- Capital preservation ALWAYS comes first. Never recommend entries without clear invalidation levels.
- You think in probabilities, not certainties. Every setup has a win rate and expected value.
- You size positions based on account risk (1-2% max per trade) and volatility (ATR-based).
- You understand market microstructure: liquidity pools, stop hunts, institutional order blocks.
- You read price action in context — a hammer at support after a flush means something different than one mid-range.
- YOU MUST BE DECISIVE. The user needs a clear YES/NO answer on whether to enter NOW. No ambiguity.

${assetLine}

INDICATORS IN YOUR TOOLKIT (your knowledge base — you understand all of these):
${activeInds}
${visibleSection}
${exchangeSection}

CRITICAL — MULTI-TIMEFRAME ANALYSIS:
Even though the screenshot may show only ONE timeframe, you MUST analyze and give your reading for ALL of these timeframes based on visible indicators, price structure, and your knowledge:
- **5m** (scalping/micro structure) — immediate momentum, micro S/R, entry timing
- **15m** (intraday) — short-term trend, pullback zones, session structure
- **1H** (swing intraday) — intraday bias, key levels, trend confirmation
- **4H** (swing) — main trend direction, major S/R, institutional flow

Use the visible chart to extrapolate structure for timeframes not shown. If the chart shows 1H candles, infer 4H structure from the broader view, and 15m/5m from recent candle clusters.

The user wants confluence across timeframes. A setup is STRONG when 3+ timeframes agree. A setup is WEAK when timeframes conflict.

STRATEGY LIBRARY — PROVEN SETUPS:
You have access to a library of ${typeof TRADING_STRATEGIES !== 'undefined' ? TRADING_STRATEGIES.length : 0} proven trading strategies. When analyzing a chart:
1. Identify which strategies match the CURRENT market conditions (trending, ranging, volatile, breakout)
2. Check if the chart shows entry conditions for any strategy
3. In SECTION 9, recommend the best matching strategy by name and explain why it fits
4. If the user asks "what strategies apply here?" — evaluate ALL strategies against the current chart and rank them
5. Always cite the strategy name, expected win rate, and R:R when recommending

${strategySummary}

CRITICAL — OUTPUT FORMAT RULES:
Your response must be SHORT, ACTIONABLE, and SCANNABLE. A real trader reads this in 30 seconds and knows exactly what to do.

DO NOT:
- Explain what RSI/MACD/Bollinger/etc are. The trader already knows.
- Cite specific news headlines (you use them for context internally, but DO NOT name them in the response).
- Describe each indicator's reading one-by-one (no "RSI shows X, MACD shows Y, ADX shows Z" sections).
- Write multi-paragraph academic justifications.
- Output any section labeled "indicator confluence", "news sentiment", or "indicator readings".
- Use === or --- as decorative dividers.

DO:
- Use the data internally (charts, funding, OI, CVD, whale prints, walls, news, on-chain) to FORM your call.
- Output ONLY: direction + 2 actionable scenarios + key levels + structured trade tags.
- Cite specific prices ($X) and percentages — they earn their place in the output.
- Be decisive. If unclear → DIRECTION: RANGE/WAIT.

DELIVER YOUR RESPONSE IN THIS EXACT STRUCTURE — NOTHING MORE, NOTHING LESS:

${exchangeContext ? `## 💼 TU POSICIÓN ABIERTA
(2-3 líneas. Side, size, entry, current PnL, distancia a liquidación. Veredicto: HOLD / TAKE PROFIT / REDUCE / CLOSE. Si no hay posición abierta, omití esta sección entera.)

---
` : ''}
## 🚦 DIRECCIÓN
**UP** / **DOWN** / **RANGE** — una sola palabra en negrita.
Then 2-3 short sentences explaining the call (max ~40 words). Mention only what matters: dominant timeframe bias, key flow signal, and what would invalidate. NO explanations of indicators.

---

## 🔍 MICRO-ANÁLISIS POR TIMEFRAME
For EACH of the three timeframes below, give a one-line read + a one-line "qué esperar" (what to look for / what triggers the next move). Be concrete with prices. Total max ~90 words.

**15m** — estructura micro / scalping
- Lectura: [estructura actual en 15m: rango, breakout, retroceso, vela clave…]
- Qué esperar: [evento concreto que esperás: "ruptura $X con cierre 15m", "rechazo en $Y con mecha larga", "consolidación entre $A-$B antes de definir"…]

**1H** — bias intradía
- Lectura: [tendencia 1H, EMA/BB context, último swing high/low]
- Qué esperar: [cierre 1H sobre/bajo $X, retest de nivel clave, divergencia, etc.]

**4H** — tendencia mayor
- Lectura: [trend 4H, S/R mayor, posición vs medias largas]
- Qué esperar: [break de estructura, cambio de carácter, defensa de nivel institucional]

---

## 🎯 ESCENARIO 1 (primario)
**Trigger**: una línea concreta — "Si BTC rompe $X con cierre 1H sobre el nivel..." or "Si rechaza $X con vela bajista en 5m..."
**Acción**: ENTER LONG / ENTER SHORT / WAIT

[TRADE_LONG]   (or [TRADE_SHORT] — only the one that fits this scenario)
ENTRY: $XXXXX - $XXXXX
SL: $XXXXX
TP1: $XXXXX (R:R X:X)
TP2: $XXXXX (R:R X:X)
TP3: $XXXXX (R:R X:X)
SIZE: X% of capital
[/TRADE_LONG]

---

## 🎯 ESCENARIO 2 (alternativo, opuesto al primario)
**Trigger**: una línea concreta describiendo el caso opuesto.
**Acción**: ENTER LONG / ENTER SHORT / WAIT

[TRADE_LONG]   (the opposite side from Scenario 1)
ENTRY: $XXXXX - $XXXXX
SL: $XXXXX
TP1: $XXXXX (R:R X:X)
TP2: $XXXXX (R:R X:X)
TP3: $XXXXX (R:R X:X)
SIZE: X% of capital
[/TRADE_LONG]

---

## ⚡ SCALP ($200-300, 0.25-0.4% moves)
Sección dedicada al scalp rápido. USA el bloque "SCALP RADAR" si te llegó (book imbalance, CVD velocity, aggressor split, liquidaciones recientes, imán más cercano) — son los números EN VIVO de los últimos segundos.

**LONG scalp** (si la presión y los imanes lo permiten)
- Zona entry: $X-$Y
- TP: $Z (+$D, R:R micro)
- SL: $W (-$D)
- Disparador en tape: qué tiene que pasar AHORA para apretar (ej "CVD vuelve a +$80k/min con tape >15 t/s", "se barre el ask wall $X", "shorts liquidados en últimos 30s")

**SHORT scalp** (si la presión y los imanes lo permiten)
- Zona entry: $X-$Y
- TP: $Z
- SL: $W
- Disparador en tape: análogo opuesto

**Trampa probable**: stop hunt esperado en $X (cita el imán o cluster pequeño si existe) — esperá la barrida ANTES de entrar.

Si no hay edge claro de scalp → escribí "WAIT — no setup de scalp ahora" + 1 línea explicando qué falta (ej "necesito CVD positivo + ruptura $X").

---

## 🔑 NIVELES CLAVE
Lista corta — máximo 5 líneas:
- **$XXX**: rol breve (ej "soporte volume profile", "ask wall", "EMA200 4H")
- **$XXX**: rol breve
- **$XXX**: rol breve
- **$XXX**: invalidación general

---

## 📊 SESGO
[BIAS_BAR]
LONG: XX% | SHORT: YY%
[/BIAS_BAR]

One line explaining the bias split.

---

PATRONES OPCIONALES: si ves un patrón claro (NO forzar), insertá el tag inline en DIRECCIÓN o ESCENARIO:
[PATTERN:bull_flag] [PATTERN:bear_flag] [PATTERN:ascending_triangle] [PATTERN:descending_triangle]
[PATTERN:double_top] [PATTERN:double_bottom] [PATTERN:head_shoulders] [PATTERN:inv_head_shoulders]
[PATTERN:rising_wedge] [PATTERN:falling_wedge] [PATTERN:cup_handle]
[PATTERN:channel_up] [PATTERN:channel_down] [PATTERN:engulfing_bull] [PATTERN:engulfing_bear]
Max 1 pattern por análisis.

TAG REFERENCE (use the pair that matches each scenario's side):
- LONG scenario uses an opening [TRADE_LONG] and a closing [/TRADE_LONG] around the ENTRY/SL/TPs/SIZE block.
- SHORT scenario uses an opening [TRADE_SHORT] and a closing [/TRADE_SHORT] around the ENTRY/SL/TPs/SIZE block.
Each scenario block must open and close with the matching pair.

STYLE RULES:
- Use $ before every price so the UI colorizes them.
- LONG references → bullish/green tone. SHORT references → bearish/red tone.
- Total length target: 450-650 words (includes MICRO-ANÁLISIS POR TIMEFRAME and SCALP sections). Anything longer means you're explaining instead of advising.
- If the setup is genuinely unclear → set DIRECCIÓN = RANGE, both scenarios = WAIT, narrow scenarios to "if breaks $X up → re-evaluate long; if breaks $Y down → re-evaluate short". Do NOT force trades.

⚠️ DISCLAIMER: Educational analysis only. Not financial advice.

🌐 LANGUAGE REMINDER (last check before you reply): Your entire output above must be in ${langName} (${uiLang}). If you wrote anything in English by reflex (section names, verdict labels, etc.), translate it now to ${langName}. NO EXCEPTIONS.`;
}

// Fetch exchange data (positions, orders, balance, ticker, funding, OI) if configured
async function fetchExchangeData() {
  const cfg = await phantom.config.get();
  console.log('[Trading] Exchange config:', cfg.exchangeProvider, '| key:', cfg.exchangeKey ? 'SET' : 'EMPTY', '| secret:', cfg.exchangeSecret ? 'SET' : 'EMPTY');

  const asset = tradingAssetInput.value.trim();
  let exchangeData = null;

  if (cfg.exchangeProvider && cfg.exchangeKey && cfg.exchangeSecret) {
    try {
      await phantom.config.set({ ...cfg, tradingAsset: asset });
      console.log('[Trading] Fetching exchange data for:', asset || '(no asset)');
      exchangeData = await phantom.exchange.fetch({ type: 'all' });
      console.log('[Trading] Exchange data received:', JSON.stringify(exchangeData).slice(0, 500));
    } catch (err) {
      console.error('[Trading] Exchange fetch error:', err);
      exchangeData = { error: err.message };
    }
  } else {
    console.log('[Trading] No exchange configured, skipping private data fetch');
  }

  // Always fetch public market data (no API key needed)
  let publicData = null;
  try {
    console.log('[Trading] Fetching public market data...');
    publicData = await phantom.market.publicData({ asset });
    console.log('[Trading] Public data received:', JSON.stringify(publicData).slice(0, 500));
  } catch (err) {
    console.error('[Trading] Public data fetch error:', err);
  }

  // Merge both datasets
  return { ...(exchangeData || {}), publicData };
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

  // Funding rate
  if (data.fundingRate && !data.fundingRate.error) {
    parts.push(`\n💸 FUNDING RATE:`);
    const fr = data.fundingRate;
    if (fr.value !== undefined) {
      // KuCoin format
      const pct = (parseFloat(fr.value) * 100).toFixed(4);
      parts.push(`  Current: ${pct}% | Predicted: ${fr.predictedValue ? (parseFloat(fr.predictedValue) * 100).toFixed(4) + '%' : 'N/A'}`);
    } else if (fr.fundingRate !== undefined) {
      // Binance format
      const pct = (parseFloat(fr.fundingRate) * 100).toFixed(4);
      parts.push(`  Current: ${pct}% | Time: ${new Date(fr.fundingTime).toUTCString()}`);
    }
    parts.push(`  → Positive = longs pay shorts (bearish pressure). Negative = shorts pay longs (bullish pressure).`);
    parts.push(`  → Extreme values (>0.1% or <-0.1%) often signal incoming reversals.`);
  }

  // Open interest
  if (data.openInterest && !data.openInterest.error) {
    parts.push(`\n📈 OPEN INTEREST:`);
    const oi = data.openInterest;
    if (oi.openInterest !== undefined) {
      // Binance format
      parts.push(`  OI: ${parseFloat(oi.openInterest).toLocaleString()} contracts | Symbol: ${oi.symbol || ''}`);
    } else if (oi.openInterest !== undefined || oi.turnoverOf24h !== undefined) {
      // KuCoin format
      parts.push(`  OI: ${oi.openInterest || 'N/A'} | 24h Turnover: ${oi.turnoverOf24h || 'N/A'} | 24h Volume: ${oi.volumeOf24h || 'N/A'}`);
    }
    parts.push(`  → Rising OI + rising price = strong trend. Rising OI + falling price = bearish pressure.`);
    parts.push(`  → Falling OI = positions closing, trend may be weakening.`);
  }

  // Long/Short ratio (Binance only)
  if (data.longShortRatio && !data.longShortRatio.error) {
    parts.push(`\n⚖️ LONG/SHORT RATIO (Global):`);
    const lsr = data.longShortRatio;
    parts.push(`  Long: ${(parseFloat(lsr.longAccount || 0) * 100).toFixed(1)}% | Short: ${(parseFloat(lsr.shortAccount || 0) * 100).toFixed(1)}% | Ratio: ${lsr.longShortRatio || 'N/A'}`);
    parts.push(`  → Extreme imbalance (>70% one side) often precedes a squeeze against the majority.`);
  }

  // Public market data
  const pub = data.publicData;
  if (pub) {
    // Fear & Greed Index
    if (pub.fearGreed && !pub.fearGreed.error) {
      parts.push(`\n🌡️ FEAR & GREED INDEX:`);
      parts.push(`  Value: ${pub.fearGreed.value}/100 — ${pub.fearGreed.label}`);
      parts.push(`  → 0-25: Extreme Fear (buy opportunity). 75-100: Extreme Greed (sell signal).`);
    }

    // 24h ticker stats
    if (pub.ticker24h) {
      parts.push(`\n📊 24H MARKET STATS:`);
      parts.push(`  Change: ${pub.ticker24h.priceChangePercent} | High: $${pub.ticker24h.high} | Low: $${pub.ticker24h.low}`);
      parts.push(`  Volume: ${parseFloat(pub.ticker24h.volume).toLocaleString()} | Quote Vol: $${parseFloat(pub.ticker24h.quoteVolume).toLocaleString()}`);
    }

    // Top trader positions
    if (pub.topTraderPositions && !pub.topTraderPositions.error) {
      parts.push(`\n🐋 TOP TRADERS POSITIONING:`);
      const tp = pub.topTraderPositions;
      parts.push(`  Long: ${(parseFloat(tp.longAccount || 0) * 100).toFixed(1)}% | Short: ${(parseFloat(tp.shortAccount || 0) * 100).toFixed(1)}% | Ratio: ${tp.longShortRatio || 'N/A'}`);
      parts.push(`  → Smart money positioning. Divergence from retail is significant.`);
    }

    // Market movers
    if (pub.topGainers && pub.topLosers) {
      parts.push(`\n🔥 MARKET MOVERS (24h):`);
      parts.push(`  Top Gainers: ${pub.topGainers.map(g => `${g.symbol} ${g.change}`).join(', ')}`);
      parts.push(`  Top Losers: ${pub.topLosers.map(l => `${l.symbol} ${l.change}`).join(', ')}`);
      parts.push(`  → Context: is the whole market moving, or just this asset?`);
    }

    // Trending coins
    if (pub.trending && !pub.trending.error) {
      parts.push(`\n🔎 TRENDING (CoinGecko):`);
      parts.push(`  ${pub.trending.map(t => `${t.symbol} (#${t.rank || '?'})`).join(', ')}`);
    }
  }

  return parts.length > 0 ? '\n\n--- LIVE MARKET DATA ---\n' + parts.join('\n') : '';
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
    const asset = tradingAssetInput.value.trim();

    setStatus('🔄 Capturando charts + noticias + on-chain + trade tape...', 'busy');
    const [chartData, exchangeData, newsRes, cgRes, ofRes, hlRes, dlRes, ttRes, srRes] = await Promise.all([
      asset ? phantom.trading.captureCharts({ asset, timeframes: ['15', '60', '240'], indicators: Array.from(tradingActiveIndicators) }) : Promise.resolve(null),
      fetchExchangeData(),
      asset ? phantom.news.fetch({ asset, includeX: await isXEnabled() }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
      asset ? phantom.coinglass.fetch({ symbol: asset }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
      asset ? phantom.orderflow.fetch({ asset }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
      asset ? phantom.hyperliquid.fetch({ asset }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
      phantom.defillama.fetch().catch(() => ({ ok: false })),
      asset ? phantom.tradetape.fetch({ asset }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }),
      asset ? phantom.scalpradar.fetch({ asset }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false })
    ]);
    const newsData = newsRes?.ok ? newsRes.data : null;
    const coinglassData = cgRes?.ok ? cgRes.data : null;
    const coinglassBlock = cgRes?.ok ? cgRes.promptBlock : '';
    const orderflowBlock = ofRes?.ok ? ofRes.promptBlock : '';
    const hyperliquidBlock = hlRes?.ok ? hlRes.promptBlock : '';
    const defillamaBlock = dlRes?.ok ? dlRes.promptBlock : '';
    const tradeTapeBlock = ttRes?.ok ? ttRes.promptBlock : '';
    // Scalp radar block — compact tactical snapshot for the SCALP section.
    let scalpRadarBlock = '';
    if (srRes && srRes.ok && srRes.data) {
      try {
        const sr = srRes.data;
        const lines = ['SCALP RADAR (live, computed from orderbook + tape + liquidation feed):'];
        if (sr.mid != null) lines.push(`- Mid: $${Math.round(sr.mid)}, spread ${sr.spread_pct != null ? sr.spread_pct.toFixed(3) : '—'}% (${sr.spread_velocity})`);
        lines.push(`- Pressure: ${sr.pressure >= 0 ? '+' : ''}${sr.pressure}/100 → ${sr.verdict}`);
        lines.push(`- Reason: ${sr.reason}`);
        if (sr.book_imbalance != null) lines.push(`- Book imbalance (top 1%): ${sr.book_imbalance.toFixed(2)}× (bid/ask)`);
        lines.push(`- CVD velocity: ${sr.cvd_velocity_usd_per_min >= 0 ? '+' : ''}$${sr.cvd_velocity_usd_per_min.toLocaleString()}/min`);
        lines.push(`- Aggressor 60s: BUY ${sr.aggressor_pct.buy_pct}% / SELL ${sr.aggressor_pct.sell_pct}%`);
        lines.push(`- Tape speed: ${sr.tape_speed_per_sec} trades/sec`);
        lines.push(`- Whale flow 5m: BUY $${sr.whale_flow_usd.buy.toLocaleString()} / SELL $${sr.whale_flow_usd.sell.toLocaleString()}`);
        if (sr.liquidations && sr.liquidations.total_liq_usd > 0) {
          lines.push(`- Liquidations 5m: longs $${Math.round(sr.liquidations.longs_liq_usd).toLocaleString()} / shorts $${Math.round(sr.liquidations.shorts_liq_usd).toLocaleString()} → ${sr.liquidations.dominant_side || '—'}`);
        }
        if (sr.nearest_magnet) {
          const m = sr.nearest_magnet;
          const dir = m.distance_usd > 0 ? 'above' : 'below';
          lines.push(`- Nearest liq magnet: $${Math.round(m.price)} (${m.side}, $${Math.round(m.notional_usd).toLocaleString()}, ${Math.abs(m.distance_usd).toFixed(0)} ${dir})`);
        }
        if (sr.trap_warning) lines.push(`- ⚠ Trap: ${sr.trap_warning}`);
        scalpRadarBlock = lines.join('\n');
      } catch (_) { scalpRadarBlock = ''; }
    }

    const chart1H = chartData?.['60'];
    const chart4H = chartData?.['240'];
    const hasCharts = chart1H || chart4H;

    let screenshot = null;
    if (!hasCharts) {
      setStatus('📸 Sin charts embebidos, capturando pantalla...', 'busy');
      screenshot = await captureScreen();
    }

    if (!hasCharts && !screenshot) throw new Error('No se pudo capturar ningún gráfico');

    setStatus(t('trading.analyzing'), 'busy');

    const exchangeContext = formatExchangeDataForPrompt(exchangeData);
    const system = getTradingSystemPrompt(exchangeContext, chartData?._renderedIndicators);
    const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';

    let userPrompt;
    if (hasCharts) {
      userPrompt = chartAnalysisPrompt(uiLang);
    } else {
      const userTexts = {
        es: 'Analizá este gráfico de trading con los indicadores seleccionados. Dame tu análisis técnico completo.',
        en: 'Analyze this trading chart with the selected indicators. Give me your complete technical analysis.',
        pt: 'Analise este gráfico de trading com os indicadores selecionados. Dê-me sua análise técnica completa.',
        fr: 'Analysez ce graphique de trading avec les indicateurs sélectionnés. Donnez-moi votre analyse technique complète.',
        ja: '選択したインジケーターでこのトレーディングチャートを分析してください。完全なテクニカル分析をお願いします。',
        zh: '使用选定的指标分析此交易图表。给我完整的技术分析。'
      };
      userPrompt = userTexts[uiLang] || userTexts.es;
    }
    if (exchangeContext) userPrompt += '\n\n' + exchangeContext;
    if (coinglassBlock) userPrompt += '\n\n' + coinglassBlock;
    if (orderflowBlock) userPrompt += '\n\n' + orderflowBlock;
    if (tradeTapeBlock) userPrompt += '\n\n' + tradeTapeBlock;
    if (hyperliquidBlock) userPrompt += '\n\n' + hyperliquidBlock;
    if (scalpRadarBlock) userPrompt += '\n\n' + scalpRadarBlock;
    if (defillamaBlock) userPrompt += '\n\n' + defillamaBlock;
    let newsBlockLen = 0;
    let newsBlockText = '';
    // Inline summarizer so we don't depend on news-summary.js loading via
    // script tag (CSP / path edge-cases were silently dropping it).
    newsBlockText = inlineSummarizeNewsForPrompt(newsData);
    newsBlockLen = newsBlockText.length;
    if (newsBlockText) userPrompt += '\n\n' + newsBlockText;
    const debugState = {
      kind: 'manual',
      promptLen: userPrompt.length,
      hasExchange: !!exchangeContext,
      coinglassLen: coinglassBlock ? coinglassBlock.length : 0,
      newsBlockLen,
      newsRecent: newsData ? (newsData.recent || []).length : -1,
      newsData_isNull: newsData == null,
      newsRes_ok: !!(newsRes && newsRes.ok),
      newsSummaryLoaded: !!window.NewsSummary,
      includesNewsContext: userPrompt.includes('NEWS CONTEXT')
    };
    console.log('[PROMPT-DEBUG manual]', debugState);
    phantom.ai.debugPrompt({ kind: 'manual', prompt: '__STATE__ ' + JSON.stringify(debugState) + '\n\n' + userPrompt }).catch(() => {});

    // Render news panel below the analysis result.
    renderNewsPanelUI(newsData);

    let messages;
    if (hasCharts) {
      const cfg = await phantom.config.get();
      const content = [];
      const addImg = (dataUrl) => {
        if (!dataUrl) return;
        if (cfg.provider === 'openai') {
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
          const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
          if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        }
      };
      if (chart1H) addImg(chart1H);
      if (chart4H) addImg(chart4H);
      content.push({ type: 'text', text: userPrompt });
      messages = [{ role: 'user', content }];
    } else {
      messages = [{ role: 'user', content: await buildContent(userPrompt, screenshot) }];
    }

    // Use dedicated trading model if configured
    const tradingCfg = await phantom.config.get();
    const tradingModel = tradingCfg.tradingModel || 'claude-opus-4-7';
    const resp = await phantom.ai.call({ messages, system, model: tradingModel, maxTokens: 4096 });
    tradingResultText.innerHTML = renderTradingMarkdown(resp.text);
    setStatus(t('trading.analysis_ready'), 'ok');

    if (window.PhantomTradeLog) {
      window.PhantomTradeLog.afterAnalysis(resp.text, {
        asset: tradingAssetInput.value.trim(),
        timeframes: hasCharts ? ['60', '240'] : ['screen'],
        indicators: chartData?._renderedIndicators || Array.from(tradingActiveIndicators),
        source: 'manual',
        news_context: newsData ? {
          recent: (newsData.recent || []).slice(0, 5).map(n => ({ title: n.title, source: n.source, url: n.url })),
          upcoming: (newsData.upcoming || []).slice(0, 3).map(n => ({ title: n.title, published_at: n.published_at }))
        } : null
      }).catch(() => {});
    }

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

/**
 * Hide / show high-level features so the user only sees what they use.
 * Settings → "Funcionalidades activas" drives this.
 *
 * featureScreen   → .actions row (Leer pantalla / Contestar) + chat
 * featureTrading  → trading panel + everything inside (live data, insights)
 * featureInterview→ interview panel
 * featureTranslate→ translate panel
 */
function applyFeatureVisibility(feat) {
  const actions   = document.querySelector('.actions');
  const chatWrap  = document.getElementById('chat-wrap');
  if (actions)  actions.style.display  = feat.featureScreen ? '' : 'none';
  if (chatWrap) chatWrap.dataset.featDisabled = feat.featureScreen ? '' : '1';
  // Trading toggle: also forces the trading panel off when feature disabled.
  if (!feat.featureTrading)  applyTradingPanelVisibility(false);
  if (!feat.featureInterview)applyInterviewPanelVisibility(false);
  if (!feat.featureTranslate)applyTranslatePanelVisibility(false);
}

function applyTradingPanelVisibility(on) {
  tradingPanel.style.display = on ? 'flex' : 'none';
  if (on) {
    // Tall enough to show Indicators + Asset + Insights + Market Pulse
    // (walls + tape) without forcing the user to scroll. Width 720 fits the
    // 2-column Market Pulse layout.
    phantom.window.resize({ width: 720, height: 1100 });
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

// ─── AUTO-ANALYSIS TRADING ALERTS ──────────────────────────────────
(function initAutoAnalysis() {
  const autoToggle = $('trading-auto-toggle');
  const autoSettings = $('auto-settings');
  const autoInterval = $('auto-interval');
  const autoEmail = $('auto-email');
  const autoStatus = $('auto-status');
  let autoTimer = null;

  if (!autoToggle) return;

  // Load saved settings
  phantom.config.get().then(cfg => {
    if (cfg.autoTradingEmail) autoEmail.value = cfg.autoTradingEmail;
    if (cfg.autoTradingInterval) autoInterval.value = cfg.autoTradingInterval;
  });

  let autoStarted = false;

  autoToggle.addEventListener('change', () => {
    if (autoToggle.checked) {
      autoSettings.style.display = 'block';
      autoStatus.textContent = '⏳ Configurá intervalo y email, luego hacé click en "Iniciar"';
      autoStatus.className = 'auto-status';
      autoStarted = false;
    } else {
      stopAutoAnalysis();
      autoSettings.style.display = 'none';
      autoStarted = false;
    }
  });

  // Add start button dynamically
  const startBtn = document.createElement('button');
  startBtn.textContent = '▶ Iniciar alertas';
  startBtn.className = 'btn btn-mini';
  startBtn.style.cssText = 'margin-top:8px;width:100%;background:linear-gradient(135deg,#1a3a5c,#3b82f6);color:#fff;padding:8px;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;border:none;';
  autoSettings.appendChild(startBtn);

  startBtn.addEventListener('click', () => {
    if (autoStarted) {
      stopAutoAnalysis();
      autoStarted = false;
      startBtn.textContent = '▶ Iniciar alertas';
      startBtn.style.background = 'linear-gradient(135deg,#1a3a5c,#3b82f6)';
    } else {
      startAutoAnalysis();
    }
  });

  autoInterval.addEventListener('change', () => {
    if (autoToggle.checked) {
      stopAutoAnalysis();
      startAutoAnalysis();
    }
  });

  // Save email on blur
  autoEmail.addEventListener('blur', async () => {
    const cfg = await phantom.config.get();
    await phantom.config.set({ ...cfg, autoTradingEmail: autoEmail.value, autoTradingInterval: autoInterval.value });
  });

  function startAutoAnalysis() {
    const email = autoEmail.value.trim();
    if (!email) {
      autoStatus.textContent = '⚠ Ingresá un email primero';
      autoStatus.className = 'auto-status error';
      return;
    }

    const asset = tradingAssetInput.value.trim();
    if (!asset) {
      autoStatus.textContent = '⚠ Ingresá un activo arriba primero (ej: BTC/USDT)';
      autoStatus.className = 'auto-status error';
      return;
    }

    if (tradingActiveIndicators.size === 0) {
      autoStatus.textContent = '⚠ Seleccioná indicadores primero';
      autoStatus.className = 'auto-status error';
      return;
    }

    const minutes = parseInt(autoInterval.value) || 30;
    const ms = minutes * 60 * 1000;

    autoStatus.textContent = `⏳ Cargando charts embebidos para ${asset}...`;
    autoStatus.className = 'auto-status active';

    // Save settings
    phantom.config.get().then(cfg => {
      phantom.config.set({ ...cfg, autoTradingEmail: email, autoTradingInterval: autoInterval.value });
    });

    autoStarted = true;
    startBtn.textContent = '⏹ Detener alertas';
    startBtn.style.background = 'linear-gradient(135deg,#dc2626,#ef4444)';

    // Pre-create hidden chart windows with the asset
    phantom.trading.updateChartSymbol({ asset }).then(() => {
      autoStatus.textContent = `✅ Charts cargando... primer análisis en 15s`;
      autoStatus.className = 'auto-status active';

      // Wait 15s for charts to fully load before first analysis
      setTimeout(() => {
        if (!autoStarted) return;
        runAutoAnalysis();
        autoTimer = setInterval(() => {
          if (!autoStarted) { clearInterval(autoTimer); return; }
          runAutoAnalysis();
        }, ms);
      }, 15000);
    });
  }

  function stopAutoAnalysis() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    autoStatus.textContent = '';
    autoStatus.className = 'auto-status';
  }

  async function runAutoAnalysis() {
    const email = autoEmail.value.trim();
    const asset = tradingAssetInput.value.trim();
    if (!email || !asset) {
      autoStatus.textContent = '⚠ Falta email o activo';
      autoStatus.className = 'auto-status error';
      return;
    }

    if (tradingActiveIndicators.size === 0) {
      autoStatus.textContent = '⚠ Seleccioná indicadores primero';
      autoStatus.className = 'auto-status error';
      return;
    }

    const minutes = parseInt(autoInterval.value) || 30;
    autoStatus.textContent = '🔄 Analizando...';
    autoStatus.className = 'auto-status active';

    try {
      // Capture embedded charts (1H + 4H) + fetch data + news + coinglass in parallel
      autoStatus.textContent = '🔄 Capturando charts + noticias + on-chain + trade tape...';
      const [chartData, exchangeData, newsRes, cgRes, ofRes, hlRes, dlRes, ttRes] = await Promise.all([
        phantom.trading.captureCharts({ asset, timeframes: ['15', '60', '240'], indicators: Array.from(tradingActiveIndicators) }),
        fetchExchangeData(),
        phantom.news.fetch({ asset, includeX: await isXEnabled() }).catch(() => ({ ok: false })),
        phantom.coinglass.fetch({ symbol: asset }).catch(() => ({ ok: false })),
        phantom.orderflow.fetch({ asset }).catch(() => ({ ok: false })),
        phantom.hyperliquid.fetch({ asset }).catch(() => ({ ok: false })),
        phantom.defillama.fetch().catch(() => ({ ok: false })),
        phantom.tradetape.fetch({ asset }).catch(() => ({ ok: false }))
      ]);
      const newsData = newsRes?.ok ? newsRes.data : null;
      const coinglassData = cgRes?.ok ? cgRes.data : null;
      const coinglassBlock = cgRes?.ok ? cgRes.promptBlock : '';
      const orderflowBlock = ofRes?.ok ? ofRes.promptBlock : '';
      const hyperliquidBlock = hlRes?.ok ? hlRes.promptBlock : '';
      const defillamaBlock = dlRes?.ok ? dlRes.promptBlock : '';
      const tradeTapeBlock = ttRes?.ok ? ttRes.promptBlock : '';

      const chart1H = chartData?.['60'];
      const chart4H = chartData?.['240'];

      if (!chart1H && !chart4H) {
        autoStatus.textContent = '⚠ No se pudieron capturar los charts embebidos';
        autoStatus.className = 'auto-status error';
        return;
      }

      autoStatus.textContent = '🔄 Analizando con AI...';

      // Pull the previous alert(s) for this asset so the AI can write a
      // natural follow-up ("the SHORT we called 30 min ago is still valid...").
      let priorBlock = '';
      try {
        const prevRes = await phantom.trades.recent({ asset, sinceMs: 6 * 60 * 60 * 1000, limit: 3 });
        const prevTrades = (prevRes?.trades || []).slice(0, 2);
        if (prevTrades.length) {
          const lines = ['PREVIOUS ALERTS FOR THIS ASSET (most recent first):'];
          for (const p of prevTrades) {
            const min = Math.max(0, Math.round((Date.now() - Date.parse(p.created_at)) / 60000));
            const ageLabel = min < 60 ? `${min} min ago` : `${Math.floor(min / 60)}h ${min % 60}min ago`;
            const setup = p.ai_decision === 'SHORT' ? p.ai_setup_short : p.ai_setup_long;
            const setupStr = setup
              ? `entry ${setup.entry || '?'} | SL ${setup.sl || '?'} | TP1 ${setup.tp1 || '?'}`
              : '(no setup)';
            const userActStr = p.user_action
              ? ` | user marked: ${p.user_action.toUpperCase()}${p.outcome && p.outcome !== 'open' ? ' / ' + p.outcome.toUpperCase() : ''}`
              : ' | user did not mark action';
            lines.push(`- ${ageLabel}: ${p.ai_decision || 'WAIT'} (${p.ai_confluence || '?/4'}) — ${setupStr}${userActStr}`);
          }
          lines.push('');
          lines.push('CONTINUITY INSTRUCTIONS:');
          lines.push('- Acknowledge the prior call(s) in your "Section 1 — Decision" if relevant. Example: "Following up on the SHORT from 30 min ago..."');
          lines.push('- If the new decision is the SAME direction → tell the user the previous setup is still valid (or has progressed).');
          lines.push('- If the new decision is REVERSED → explicitly warn them: "If you entered the previous SHORT, consider closing it before this LONG."');
          lines.push('- If the new decision is WAIT after a directional call → tell them whether to hold their position or stand aside.');
          lines.push('- Reference the previous entry price and current price to tell the user whether their (possible) entry is in profit/loss.');
          priorBlock = lines.join('\n');
        }
      } catch (e) { console.warn('[priorBlock] failed', e); }

      const exchangeContext = formatExchangeDataForPrompt(exchangeData);
      const system = getTradingSystemPrompt(exchangeContext, chartData?._renderedIndicators);
      const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
      let promptText = chartAnalysisPrompt(uiLang)
        + (exchangeContext ? '\n\n' + exchangeContext : '');
      if (priorBlock) promptText += '\n\n' + priorBlock;
      if (coinglassBlock) promptText += '\n\n' + coinglassBlock;
      if (orderflowBlock) promptText += '\n\n' + orderflowBlock;
      if (tradeTapeBlock) promptText += '\n\n' + tradeTapeBlock;
      if (hyperliquidBlock) promptText += '\n\n' + hyperliquidBlock;
      if (defillamaBlock) promptText += '\n\n' + defillamaBlock;
      let _autoNewsLen = 0;
      const _newsBlock = inlineSummarizeNewsForPrompt(newsData);
      _autoNewsLen = _newsBlock.length;
      if (_newsBlock) promptText += '\n\n' + _newsBlock;
      const _autoDebug = {
        kind: 'auto',
        promptLen: promptText.length,
        coinglassLen: coinglassBlock ? coinglassBlock.length : 0,
        newsBlockLen: _autoNewsLen,
        newsRecent: newsData ? (newsData.recent || []).length : -1,
        newsData_isNull: newsData == null,
        newsRes_ok: !!(newsRes && newsRes.ok),
        newsSummaryLoaded: !!window.NewsSummary,
        includesNewsContext: promptText.includes('NEWS CONTEXT')
      };
      console.log('[PROMPT-DEBUG auto]', _autoDebug);
      phantom.ai.debugPrompt({ kind: 'auto', prompt: '__STATE__ ' + JSON.stringify(_autoDebug) + '\n\n' + promptText }).catch(() => {});
      renderNewsPanelUI(newsData);

      // Build content with multiple images
      const cfg = await phantom.config.get();
      const content = [];
      const addImage = (dataUrl) => {
        if (!dataUrl) return;
        if (cfg.provider === 'openai') {
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
          const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
          if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        }
      };
      if (chart1H) addImage(chart1H);
      if (chart4H) addImage(chart4H);
      content.push({ type: 'text', text: promptText });

      const messages = [{ role: 'user', content }];
      const tradingCfg = await phantom.config.get();
      const resp = await phantom.ai.call({ messages, system, model: tradingCfg.tradingModel || 'claude-opus-4-7', maxTokens: 4096 });

      // Also render in the panel
      const tradingResult = $('trading-result');
      const tradingResultText = $('trading-result-text');
      tradingResult.style.display = 'block';
      tradingResultText.innerHTML = renderTradingMarkdown(resp.text);

      if (window.PhantomTradeLog) {
        window.PhantomTradeLog.afterAnalysis(resp.text, {
          asset,
          timeframes: ['15', '60', '240'],
          indicators: chartData?._renderedIndicators || [],
          source: 'auto',
          news_context: newsData ? {
            recent: (newsData.recent || []).slice(0, 5).map(n => ({ title: n.title, source: n.source, url: n.url })),
            upcoming: (newsData.upcoming || []).slice(0, 3).map(n => ({ title: n.title, published_at: n.published_at }))
          } : null
        }).catch(() => {});
      }

      // ─── Extract structured data via the shared parser ───
      const text = resp.text;
      const indicatorNames = (chartData?._renderedIndicators || [])
        .map(id => (TRADING_INDICATORS.find(i => i.id === id) || {}).name)
        .filter(Boolean);
      const parsed = window.AIResponseParser.parseAll(text, { indicatorNames });

      const decision = parsed.decision || 'WAIT';
      const tradeSetup = decision === 'SHORT' ? parsed.setupShort : parsed.setupLong;

      // Market data block (kept verbatim — already worked before).
      const mktData = {};
      if (exchangeData) {
        if (exchangeData.ticker) mktData.price = exchangeData.ticker.price || exchangeData.ticker.bestAsk;
        if (exchangeData.fundingRate && !exchangeData.fundingRate.error) {
          const fr = exchangeData.fundingRate;
          mktData.fundingRate = fr.value ? (parseFloat(fr.value) * 100).toFixed(4) + '%'
            : fr.fundingRate ? (parseFloat(fr.fundingRate) * 100).toFixed(4) + '%' : null;
        }
        if (exchangeData.openInterest && !exchangeData.openInterest.error) {
          const oi = exchangeData.openInterest;
          mktData.openInterest = oi.openInterest ? parseFloat(oi.openInterest).toLocaleString() : null;
        }
        if (exchangeData.longShortRatio && !exchangeData.longShortRatio.error) {
          mktData.longShortRatio = exchangeData.longShortRatio.longShortRatio || null;
        }
        const pub = exchangeData.publicData;
        if (pub) {
          if (pub.fearGreed && !pub.fearGreed.error) mktData.fearGreed = pub.fearGreed.value + ' (' + pub.fearGreed.label + ')';
          if (pub.ticker24h) {
            mktData.change24h = pub.ticker24h.priceChangePercent;
            mktData.high = pub.ticker24h.high;
            mktData.low = pub.ticker24h.low;
          }
        }
      }
      const currentPrice = parseFloat(mktData.price) || null;

      // ─── Continuity: pull the previous alerts for this asset and build follow-up ─
      let continuity = null;
      try {
        const prevRes = await phantom.trades.recent({ asset, sinceMs: 6 * 60 * 60 * 1000, limit: 3 });
        // Skip the trade we *just* logged (afterAnalysis runs above).
        const prevTrades = (prevRes?.trades || []).filter(t => Math.abs(Date.now() - Date.parse(t.created_at)) > 60 * 1000);
        if (prevTrades.length && window.Continuity) {
          continuity = window.Continuity.buildContinuity(prevTrades, decision, currentPrice);
        }
      } catch (e) { console.warn('[continuity] failed', e); }

      // Send email alert with full structured data + continuity + full text.
      const alertResult = await phantom.trading.sendAlert({
        to: email,
        asset,
        decision,
        confluence_score: parsed.score || null,
        bias: parsed.bias || null,
        summary: parsed.summary || 'Ver análisis completo en Phantom.',
        confluence: parsed.confluence.length > 0 ? parsed.confluence : undefined,
        indicators: parsed.indicators.length > 0 ? parsed.indicators : undefined,
        levels: parsed.levels || null,
        risks: parsed.risks || null,
        strategies: parsed.strategies || null,
        patterns: parsed.patterns || [],
        marketData: Object.keys(mktData).length > 0 ? mktData : undefined,
        tradeSetup: tradeSetup || undefined,
        continuity: continuity || undefined,
        fullAnalysis: text,            // The raw AI markdown — worker can render in full.
        timestamp: new Date().toISOString()
      });

      if (alertResult.success) {
        autoStatus.textContent = `✅ Alerta enviada a ${email} — próxima en ${minutes} min`;
        autoStatus.className = 'auto-status active';
      } else {
        autoStatus.textContent = `⚠ Error email: ${alertResult.error || 'unknown'}`;
        autoStatus.className = 'auto-status error';
      }
    } catch (err) {
      console.error('[Auto-Analysis] Error:', err);
      autoStatus.textContent = `⚠ Error: ${err.message}`;
      autoStatus.className = 'auto-status error';
    }
  }
})();

// ════════════════════════════════════════════════════════════════
// TRADE LOGGING — captures every analysis and tracks outcomes.
// Auto-hooks into both the manual "Analizar" button and auto-alerts.
// ════════════════════════════════════════════════════════════════
// ─── News panel rendering helper ─────────────────────────────────
function inlineRenderNewsPanelHTML(newsData) {
  if (!newsData) return '';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const recent = (newsData.recent || []).slice(0, 8);
  const upcoming = (newsData.upcoming || []).slice(0, 4);
  if (recent.length === 0 && upcoming.length === 0) {
    return '<div class="news-panel-empty">Sin noticias disponibles.</div>';
  }
  const recentHTML = recent.map(item => {
    const age = item.hoursAgo !== null && item.hoursAgo !== undefined ? `${item.hoursAgo}h` : '';
    const votes = item.votes
      ? `<span class="news-votes">+${item.votes.positive}/-${item.votes.negative}</span>` : '';
    const url = item.url ? `href="${esc(item.url)}" target="_blank" rel="noopener"` : '';
    return `<a class="news-item" ${url}>
        <div class="news-meta"><span class="news-source">${esc(item.source || 'unknown')}</span><span class="news-age">${esc(age)}</span>${votes}</div>
        <div class="news-title">${esc(item.title)}</div>
      </a>`;
  }).join('');
  const upcomingHTML = upcoming.map(item => {
    const when = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : '';
    const url = item.url ? `href="${esc(item.url)}" target="_blank" rel="noopener"` : '';
    return `<a class="news-item news-event" ${url}>
        <div class="news-meta"><span class="news-event-date">📅 ${esc(when)}</span></div>
        <div class="news-title">${esc(item.title)}</div>
      </a>`;
  }).join('');
  let html = '';
  if (recent.length)   html += `<div class="news-section-title">📰 Noticias recientes</div><div class="news-list">${recentHTML}</div>`;
  if (upcoming.length) html += `<div class="news-section-title" style="margin-top:8px">📅 Eventos próximos</div><div class="news-list">${upcomingHTML}</div>`;
  return html;
}

function renderNewsPanelUI(newsData) {
  const panel = document.getElementById('news-panel');
  const content = document.getElementById('news-panel-content');
  const footer = document.getElementById('news-panel-footer');
  if (!panel || !content) return;
  if (!newsData) {
    panel.style.display = 'none';
    return;
  }
  content.innerHTML = inlineRenderNewsPanelHTML(newsData);
  if (footer) {
    const srcs = newsData.sources || {};
    const errs = newsData.errors || null;
    const totalRecent = (newsData.recent || []).length;
    const totalUpcoming = (newsData.upcoming || []).length;
    // Show ✓ if source returned items, ⚠ if it errored, · if just empty.
    const tag = (label, key) => {
      const count = srcs[key] || 0;
      if (count > 0) return `${label} ${count}`;
      if (errs && errs[key]) return `${label} ⚠`;
      return `${label} 0`;
    };
    const xPart = srcs.x !== undefined
      ? (srcs.x > 0 ? ` · 𝕏 ${srcs.x}` : (srcs.x_unauthenticated ? ' · 𝕏 ⚪' : (srcs.x_error ? ' · 𝕏 ⚠' : ' · 𝕏 0')))
      : '';
    footer.textContent = `${totalRecent} noticias · ${totalUpcoming} eventos · ${tag('Google', 'google_news')} · ${tag('Reddit', 'reddit')} · ${tag('CryptoPanic', 'crypto_panic')} · ${tag('CoinDesk', 'coindesk')} · ${tag('CMC', 'coin_market_cal')}${xPart}`;
    // Surface failure details on hover so the user can diagnose without opening logs.
    if (errs) {
      const errMsg = Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('\n');
      footer.title = '⚠ Fallaron fuentes:\n' + errMsg + (srcs.x_error ? '\nx: ' + srcs.x_error : '');
    } else {
      footer.title = '';
    }
  }
  panel.style.display = 'block';
}

(function setupTradeLogging() {
  const P = window.AIResponseParser;
  if (!P) {
    console.warn('[TradeLog] AIResponseParser not available — logging disabled');
    return;
  }

  const promptEl    = document.getElementById('trade-log-prompt');
  const entryRowEl  = document.getElementById('tlp-entry-row');
  const entryInput  = document.getElementById('tlp-entry');
  const sizeInput   = document.getElementById('tlp-size');
  const saveBtn     = document.getElementById('tlp-save');
  const statusEl    = document.getElementById('tlp-status');
  const tabsWrap    = document.querySelector('.th-tabs');
  const contentEl   = document.getElementById('th-content');
  if (!promptEl || !contentEl) return;

  let currentTradeId = null;
  let pendingAction  = null;
  let activeTab = 'open';

  /** Parses + logs an AI response. Returns the new trade id (or null on failure). */
  async function logAnalysis(rawText, ctx) {
    try {
      const parsed = P.parseAll(rawText);
      const cfg = await phantom.config.get();
      const payload = {
        asset: ctx.asset || '',
        exchange: (cfg.exchangeProvider || '').toLowerCase(),
        timeframes: ctx.timeframes || ['60', '240'],
        indicators_visible: ctx.indicators || [],
        ai_model: cfg.tradingModel || 'claude-opus-4-7',
        ai_decision: parsed.decision,
        ai_confluence: parsed.score,
        ai_bias_long:  parsed.bias.long,
        ai_bias_short: parsed.bias.short,
        ai_setup_long:  parsed.setupLong,
        ai_setup_short: parsed.setupShort,
        market_context: ctx.market_context || null,
        full_response: rawText.slice(0, 12000),
        source: ctx.source || 'manual'
      };
      const result = await phantom.trades.log(payload);
      if (!result.ok) {
        console.warn('[TradeLog] log failed', result.error);
        return null;
      }
      return result.id;
    } catch (e) {
      console.warn('[TradeLog] exception during log', e);
      return null;
    }
  }

  function showPrompt(tradeId) {
    currentTradeId = tradeId;
    pendingAction = null;
    entryRowEl.style.display = 'none';
    statusEl.textContent = '';
    entryInput.value = '';
    sizeInput.value = '';
    promptEl.style.display = 'block';
  }

  function hidePrompt() {
    promptEl.style.display = 'none';
    currentTradeId = null;
    pendingAction = null;
  }

  promptEl.querySelectorAll('.tlp-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (!currentTradeId) return;
      if (action === 'skipped') {
        await phantom.trades.update(currentTradeId, { user_action: 'skipped' });
        statusEl.textContent = '✅ Marcado como saltado.';
        setTimeout(hidePrompt, 1000);
        refreshTab();
        return;
      }
      pendingAction = action;
      entryRowEl.style.display = 'flex';
      statusEl.textContent = action === 'long' ? '🟢 LONG — completá precio y tamaño (opcional) y guardá.' : '🔴 SHORT — completá precio y tamaño (opcional) y guardá.';
    });
  });

  saveBtn.addEventListener('click', async () => {
    if (!currentTradeId || !pendingAction) return;
    const patch = {
      user_action: pendingAction,
      user_entry: entryInput.value ? parseFloat(entryInput.value) : null,
      user_size_pct: sizeInput.value ? parseFloat(sizeInput.value) : null,
      outcome: 'open'
    };
    const res = await phantom.trades.update(currentTradeId, patch);
    if (res.ok) {
      statusEl.textContent = '✅ Trade registrado. Cerrá cuando sepas el resultado.';
      setTimeout(hidePrompt, 1500);
      refreshTab();
    } else {
      statusEl.textContent = '⚠ Error: ' + res.error;
    }
  });

  // ─── Tabs (open / closed / stats) ───
  if (tabsWrap) {
    tabsWrap.querySelectorAll('.th-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        tabsWrap.querySelectorAll('.th-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        refreshTab();
      });
    });
  }

  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString();
  }

  async function refreshTab() {
    if (activeTab === 'open') return renderOpen();
    if (activeTab === 'closed') return renderClosed();
    if (activeTab === 'stats') return renderStats();
  }

  async function renderOpen() {
    const res = await phantom.trades.list({ open: true });
    if (!res.ok || !res.trades.length) {
      contentEl.innerHTML = '<div class="th-empty">Sin trades abiertos.</div>';
      return;
    }
    contentEl.innerHTML = res.trades.map(t => `
      <div class="th-trade-row" data-id="${t.id}">
        <div class="th-trade-meta">
          <div class="th-trade-asset">${escapeHTML(t.asset)} · ${t.user_action === 'long' ? '🟢 LONG' : '🔴 SHORT'}</div>
          <div class="th-trade-sub">${fmtDate(t.created_at)} · entry ${t.user_entry ?? '—'} · ${t.ai_confluence || '—'} confluence · AI: ${t.ai_decision || '—'}</div>
        </div>
        <div class="th-trade-actions">
          <button class="th-trade-btn win"  data-act="close-win"  data-id="${t.id}">Win</button>
          <button class="th-trade-btn loss" data-act="close-loss" data-id="${t.id}">Loss</button>
          <button class="th-trade-btn be"   data-act="close-be"   data-id="${t.id}">BE</button>
          <button class="th-trade-btn"      data-act="close-cancel" data-id="${t.id}">✕</button>
        </div>
      </div>
    `).join('');
    contentEl.querySelectorAll('.th-trade-btn').forEach(btn => {
      btn.addEventListener('click', () => closeTrade(btn.dataset.id, btn.dataset.act));
    });
  }

  async function closeTrade(id, action) {
    const outcomeMap = { 'close-win': 'win', 'close-loss': 'loss', 'close-be': 'breakeven', 'close-cancel': 'cancelled' };
    const outcome = outcomeMap[action];
    if (!outcome) return;
    let pnl = null;
    if (outcome === 'win' || outcome === 'loss') {
      const input = prompt(outcome === 'win' ? 'Ganancia en % (ej 2.5):' : 'Pérdida en % (ej 1.2 — se guarda negativa):');
      if (input === null) return;
      pnl = parseFloat(input);
      if (isNaN(pnl)) pnl = null;
      else if (outcome === 'loss' && pnl > 0) pnl = -pnl;
    }
    const notes = (outcome === 'win' || outcome === 'loss') ? (prompt('Notas (opcional):') || '') : '';
    await phantom.trades.update(id, {
      outcome,
      outcome_pnl_pct: pnl,
      outcome_notes: notes,
      closed_at: new Date().toISOString()
    });
    refreshTab();
  }

  async function renderClosed() {
    const res = await phantom.trades.list({});
    if (!res.ok) return;
    const closed = res.trades.filter(t => t.outcome && t.outcome !== 'open');
    if (!closed.length) {
      contentEl.innerHTML = '<div class="th-empty">Sin trades cerrados todavía.</div>';
      return;
    }
    contentEl.innerHTML = closed.slice(0, 30).map(t => {
      const cls = t.outcome === 'win' ? 'pos' : t.outcome === 'loss' ? 'neg' : '';
      return `
        <div class="th-trade-row">
          <div class="th-trade-meta">
            <div class="th-trade-asset">${escapeHTML(t.asset)} · ${t.user_action === 'long' ? '🟢' : '🔴'} ${t.user_action?.toUpperCase()} · ${t.outcome.toUpperCase()}</div>
            <div class="th-trade-sub">${fmtDate(t.closed_at || t.created_at)} · AI: ${t.ai_decision} ${t.ai_confluence || ''} ${t.outcome_notes ? '· ' + escapeHTML(t.outcome_notes).slice(0, 40) : ''}</div>
          </div>
          <div class="th-stat-value ${cls}" style="font-size:14px">${fmtPct(t.outcome_pnl_pct)}</div>
        </div>
      `;
    }).join('');
  }

  async function renderStats() {
    const res = await phantom.trades.stats({});
    if (!res.ok) {
      contentEl.innerHTML = '<div class="th-empty">Sin datos.</div>';
      return;
    }
    const s = res.stats;
    const winRateCls = s.winRate >= 0.5 ? 'pos' : 'neg';
    const pnlCls = s.totalPnlPct >= 0 ? 'pos' : 'neg';
    const overrideText = s.overrideTrades > 0
      ? `${(s.overrideWinRate * 100).toFixed(0)}% (${s.overrideTrades} trades)`
      : '—';
    contentEl.innerHTML = `
      <div class="th-stats-grid">
        <div class="th-stat-card">
          <div class="th-stat-label">Win rate</div>
          <div class="th-stat-value ${winRateCls}">${(s.winRate * 100).toFixed(1)}%</div>
          <div class="th-stat-sub">${s.wins}W / ${s.losses}L de ${s.closed}</div>
        </div>
        <div class="th-stat-card">
          <div class="th-stat-label">PnL acumulado</div>
          <div class="th-stat-value ${pnlCls}">${fmtPct(s.totalPnlPct)}</div>
          <div class="th-stat-sub">Promedio: ${fmtPct(s.avgPnlPct)}</div>
        </div>
        <div class="th-stat-card">
          <div class="th-stat-label">Long vs Short</div>
          <div class="th-stat-value">${(s.longWinRate * 100).toFixed(0)}% / ${(s.shortWinRate * 100).toFixed(0)}%</div>
          <div class="th-stat-sub">Win-rate por dirección</div>
        </div>
        <div class="th-stat-card">
          <div class="th-stat-label">Expectancy</div>
          <div class="th-stat-value">${fmtPct(s.expectancy)}</div>
          <div class="th-stat-sub">Avg W ${fmtPct(s.avgWinPct)} · Avg L ${fmtPct(s.avgLossPct)}</div>
        </div>
        <div class="th-stat-card" style="grid-column:1/-1">
          <div class="th-stat-label">Override del AI (entraste cuando dijo WAIT)</div>
          <div class="th-stat-value">${overrideText}</div>
          <div class="th-stat-sub">Si esto es bajo, deberías hacerle más caso al WAIT</div>
        </div>
        <div class="th-stat-card" style="grid-column:1/-1">
          <div class="th-stat-label">Por confluencia</div>
          <div class="th-stat-sub" style="margin-top:6px">
            ${Object.entries(s.byConfluence).map(([k, v]) =>
              `<span style="margin-right:12px"><b>${k}</b>: ${(v.winRate * 100).toFixed(0)}% (${v.wins}/${v.total})</span>`
            ).join('') || '—'}
          </div>
        </div>
      </div>
    `;
  }

  // Expose so other parts of renderer.js can call after each analysis.
  window.PhantomTradeLog = {
    afterAnalysis: async function(rawText, ctx) {
      const id = await logAnalysis(rawText, ctx || {});
      if (id) showPrompt(id);
      return id;
    },
    refresh: refreshTab
  };

  // Initial render.
  refreshTab();
})();

// ════════════════════════════════════════════════════════════════
// X (Twitter) integration — settings UI + auth state.
// ════════════════════════════════════════════════════════════════
async function isXEnabled() {
  try {
    const cfg = await phantom.config.get();
    return !!cfg.xEnabled;
  } catch (_) { return false; }
}

async function refreshXAuthStatus() {
  const statusEl = document.getElementById('x-auth-status');
  const loginBtn = document.getElementById('btn-x-login');
  const logoutBtn = document.getElementById('btn-x-logout');
  if (!statusEl) return;
  statusEl.textContent = 'comprobando…';
  try {
    const res = await phantom.x.checkAuth();
    const authed = res.ok && res.authenticated;
    if (authed) {
      statusEl.textContent = '✅ Conectado';
      statusEl.style.color = '#10b981';
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
    } else {
      statusEl.textContent = '⚪ No conectado';
      statusEl.style.color = '';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  } catch (e) {
    statusEl.textContent = '⚠ error';
  }
}

(function bindXSettingsUI() {
  const loginBtn  = document.getElementById('btn-x-login');
  const logoutBtn = document.getElementById('btn-x-logout');
  const statusEl  = document.getElementById('x-auth-status');
  if (!loginBtn) return;

  loginBtn.addEventListener('click', async () => {
    statusEl.textContent = '🔄 Abriendo ventana de login…';
    statusEl.style.color = '';
    loginBtn.disabled = true;
    try {
      const res = await phantom.x.login();
      if (res.ok && res.authenticated) {
        statusEl.textContent = '✅ Conectado';
        statusEl.style.color = '#10b981';
        loginBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'inline-block';
      } else {
        statusEl.textContent = '⚪ No se completó el login';
        statusEl.style.color = '';
      }
    } catch (e) {
      statusEl.textContent = '⚠ ' + (e.message || 'error');
    } finally {
      loginBtn.disabled = false;
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!confirm('¿Desconectar la cuenta de X? Tendrás que volver a iniciar sesión.')) return;
      await phantom.x.logout();
      refreshXAuthStatus();
    });
  }
})();

// ════════════════════════════════════════════════════════════════
// MARKET PULSE — live trade tape + CVD bar + walls, polls every 5s.
// Self-contained IIFE so it can pause/resume without leaking timers.
// ════════════════════════════════════════════════════════════════
(function setupMarketPulse() {
  const panel    = document.getElementById('mp-panel');
  if (!panel) return;
  const assetEl  = document.getElementById('mp-asset');
  const dot      = document.getElementById('mp-dot');
  const statusEl = document.getElementById('mp-status');
  const toggleBtn= document.getElementById('mp-toggle');
  const popoutBtn= document.getElementById('mp-popout');
  const buyPct   = document.getElementById('mp-buy-pct');
  const sellPct  = document.getElementById('mp-sell-pct');
  const fillBuy  = document.getElementById('mp-bias-fill-buy');
  const fillSell = document.getElementById('mp-bias-fill-sell');
  const verdict  = document.getElementById('mp-bias-verdict');
  const tapeEl   = document.getElementById('mp-tape');
  const wallsEl  = document.getElementById('mp-walls');

  const POLL_MS = 5000;
  let timer = null;
  let paused = false;
  let inflight = false;
  let lastAsset = '';

  function setDot(state, label) {
    if (!dot) return;
    dot.className = 'mp-dot ' + state;
    if (statusEl) statusEl.textContent = label;
  }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }
  function fmtPrice(p) {
    if (p == null) return '—';
    return p >= 1000 ? p.toFixed(1) : p.toFixed(p >= 1 ? 4 : 6);
  }
  function fmtAge(s) {
    if (s == null) return '';
    if (s < 60)   return s + 's';
    return Math.floor(s / 60) + 'm';
  }

  function verdictLabel(v) {
    const tr = (k) => (typeof t === 'function' ? t(k) : k);
    switch (v) {
      case 'STRONG_BUY':  return { txt: tr('mp.strong_buy'),  cls: 'strong-buy' };
      case 'BUY':         return { txt: tr('mp.buy'),         cls: 'buy' };
      case 'STRONG_SELL': return { txt: tr('mp.strong_sell'), cls: 'strong-sell' };
      case 'SELL':        return { txt: tr('mp.sell'),        cls: 'sell' };
      default:            return { txt: tr('mp.balanced'),    cls: '' };
    }
  }

  function renderBias(flow) {
    if (!flow || (!flow.buy_notional && !flow.sell_notional)) {
      buyPct.textContent = '—'; sellPct.textContent = '—';
      fillBuy.style.width = '50%'; fillSell.style.width = '50%';
      verdict.textContent = (typeof t === 'function' ? t('mp.waiting') : 'waiting');
      verdict.className = 'mp-bias-verdict';
      return;
    }
    const tot = flow.buy_notional + flow.sell_notional;
    const buyP  = tot > 0 ? (flow.buy_notional  / tot) * 100 : 50;
    const sellP = 100 - buyP;
    buyPct.textContent  = '🟢 ' + buyP.toFixed(0) + '%';
    sellPct.textContent = sellP.toFixed(0) + '% 🔴';
    fillBuy.style.width = buyP + '%';
    fillSell.style.width = sellP + '%';
    const v = verdictLabel(flow.verdict);
    verdict.textContent = v.txt + ' · CVD ' + (flow.cvd >= 0 ? '+$' : '-$') + fmtNum(Math.abs(flow.cvd));
    verdict.className = 'mp-bias-verdict ' + v.cls;
  }

  function renderTape(trades) {
    if (!trades || trades.length === 0) {
      tapeEl.innerHTML = '<div class="mp-empty">' + (typeof t === 'function' ? t('mp.no_trades') : 'No trades') + '</div>';
      return;
    }
    tapeEl.innerHTML = trades.map(tr => {
      const cls = 'mp-row ' + tr.side.toLowerCase() + (tr.is_whale ? ' whale' : '');
      const sideTxt = tr.side === 'BUY' ? '🟢' : '🔴';
      return '<div class="' + cls + '">'
        + '<span class="mp-side">' + sideTxt + '</span>'
        + '<span class="mp-price">$' + fmtPrice(tr.price) + '</span>'
        + '<span class="mp-qty">' + tr.qty.toFixed(3) + '</span>'
        + '<span class="mp-age">' + fmtAge(tr.seconds_ago) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderWalls(book) {
    if (!book || (book.bid_walls.length === 0 && book.ask_walls.length === 0)) {
      wallsEl.innerHTML = '<div class="mp-empty">' + (typeof t === 'function' ? t('mp.no_walls') : 'No walls') + '</div>';
      return;
    }
    // Each "wall" is now a PRICE ZONE with { zone_start, zone_end, total_size,
    // level_count, mult, dist_pct }. Render as a range like "$79,000-$79,049".
    function zoneRow(side, w) {
      const startStr = fmtPrice(w.zone_start);
      const endStr   = fmtPrice(w.zone_end - 0.01);
      const distStr  = (w.dist_pct >= 0 ? '+' : '') + w.dist_pct.toFixed(2) + '%';
      const sideTxt  = side === 'bid' ? '🟢' : '🔴';
      return (
        '<div class="mp-wall ' + side + '">'
        + '<span class="mp-wall-side">' + sideTxt + '</span>'
        + '<span>$' + startStr + '–$' + endStr
        + ' <span class="mp-wall-info">(' + distStr + ', ' + w.mult.toFixed(1) + '× median'
        + (w.level_count ? ', ' + w.level_count + ' niveles' : '')
        + ')</span></span>'
        + '<span>' + w.total_size.toFixed(2) + '</span>'
        + '</div>'
      );
    }
    const rows = [];
    // Asks (resistance) on top — closest to mid first
    [...book.ask_walls].sort((a, b) => a.zone_start - b.zone_start).forEach(w => rows.push(zoneRow('ask', w)));
    // Mid marker
    if (book.mid) {
      rows.push('<div class="mp-empty" style="padding:4px 0;font-size:10px">— mid $' + fmtPrice(book.mid) + ' —</div>');
    }
    // Bids (support) below — closest to mid first
    [...book.bid_walls].sort((a, b) => b.zone_start - a.zone_start).forEach(w => rows.push(zoneRow('bid', w)));
    wallsEl.innerHTML = rows.join('');
  }

  async function tick() {
    if (paused || inflight) return;
    const asset = (typeof tradingAssetInput !== 'undefined' && tradingAssetInput)
      ? tradingAssetInput.value.trim()
      : '';
    if (!asset) {
      setDot('paused', typeof t === 'function' ? t('mp.idle') : 'idle');
      return;
    }
    inflight = true;
    setDot('live', typeof t === 'function' ? t('mp.live') : 'live');
    try {
      const res = await phantom.marketpulse.fetch({ asset });
      if (!res.ok || !res.data) {
        setDot('error', typeof t === 'function' ? t('mp.error') : 'error');
        return;
      }
      const d = res.data;
      lastAsset = asset;
      assetEl.textContent = d.symbol;
      renderBias(d.flow);
      renderTape(d.trades_recent);
      renderWalls(d.book);
      setDot('live', new Date().toLocaleTimeString());
    } catch (e) {
      setDot('error', typeof t === 'function' ? t('mp.error') : 'error');
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (timer) return;
    paused = false;
    if (toggleBtn) toggleBtn.textContent = '⏸';
    tick();
    timer = setInterval(tick, POLL_MS);
  }
  function pause() {
    paused = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (toggleBtn) toggleBtn.textContent = '▶';
    setDot('paused', typeof t === 'function' ? t('mp.paused') : 'paused');
  }

  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    if (paused || !timer) start();
    else                  pause();
  });
  if (popoutBtn) popoutBtn.addEventListener('click', () => {
    phantom.window.openTrading().catch(() => {});
  });

  // Only auto-start once the trading panel is visible (saves bandwidth).
  function startWhenTradingVisible() {
    const tp = document.getElementById('trading-panel');
    if (tp && tp.style.display !== 'none' && tp.offsetParent !== null) {
      start();
    }
  }
  startWhenTradingVisible();
  // Watch the trading panel's visibility — start/stop with it.
  const tp = document.getElementById('trading-panel');
  if (tp) {
    const obs = new MutationObserver(() => {
      if (tp.style.display === 'none') pause();
      else if (!timer && !paused) start();
    });
    obs.observe(tp, { attributes: true, attributeFilter: ['style'] });
  }
})();

// ════════════════════════════════════════════════════════════════
// SCALP RADAR — high-frequency tactical panel (refresh every 2s).
// Reads computed metrics from the main process (which knows the
// previous snapshot, so CVD/spread velocity are derived server-side).
// ════════════════════════════════════════════════════════════════
(function setupScalpRadar() {
  const panel = document.getElementById('scalp-panel');
  if (!panel) return;

  const $id = (id) => document.getElementById(id);
  const els = {
    mid:        $id('scalp-mid'),
    verdict:    $id('scalp-verdict'),
    pressureFill: $id('scalp-pressure-fill'),
    pressureValue:$id('scalp-pressure-value'),
    reason:     $id('scalp-reason'),
    imbalance:  $id('scalp-imbalance'),
    cvdVel:     $id('scalp-cvd-vel'),
    aggressor:  $id('scalp-aggressor'),
    tapeSpeed:  $id('scalp-tape-speed'),
    spread:     $id('scalp-spread'),
    whaleFlow:  $id('scalp-whale-flow'),
    magnet:     $id('scalp-magnet'),
    liq:        $id('scalp-liq'),
    trap:       $id('scalp-trap')
  };

  let timer = null;
  let inflight = false;

  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return (n >= 0 ? '$' : '-$') + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n >= 0 ? '$' : '-$') + (a / 1e3).toFixed(1) + 'k';
    return (n >= 0 ? '$' : '-$') + Math.round(a);
  }

  function render(r) {
    if (!r) {
      els.reason.textContent = 'esperando datos…';
      return;
    }
    els.mid.textContent = r.mid != null ? '$' + Math.round(r.mid).toLocaleString() : '—';

    // Verdict pill
    const v = r.verdict || 'WAIT';
    els.verdict.textContent = v.replace(/_/g, ' ');
    els.verdict.classList.remove('long', 'short', 'fade');
    if (v === 'LONG_NOW')   els.verdict.classList.add('long');
    if (v === 'SHORT_NOW')  els.verdict.classList.add('short');
    if (v === 'FADE_LONG')  els.verdict.classList.add('long');
    if (v === 'FADE_SHORT') els.verdict.classList.add('short');
    if (v === 'FADE_LONG' || v === 'FADE_SHORT') els.verdict.classList.add('fade');

    // Pressure: signed -100..+100. Bar grows out from center.
    const p = Math.max(-100, Math.min(100, r.pressure || 0));
    const pct = Math.abs(p) / 2; // half-bar width = |p|/100 * 50%
    els.pressureFill.style.width = pct + '%';
    if (p >= 0) {
      els.pressureFill.style.left = '50%';
      els.pressureFill.classList.remove('neg');
    } else {
      els.pressureFill.style.left = (50 - pct) + '%';
      els.pressureFill.classList.add('neg');
    }
    els.pressureValue.textContent = (p > 0 ? '+' : '') + p;
    els.pressureValue.style.color = p > 30 ? '#2effa3' : p < -30 ? '#ff4d4d' : '#fff3d6';

    els.reason.textContent = r.reason || '—';

    els.imbalance.textContent = r.book_imbalance != null ? r.book_imbalance.toFixed(2) + '×' : '—';
    els.cvdVel.textContent    = fmtUsd(r.cvd_velocity_usd_per_min);
    els.aggressor.textContent = `BUY ${r.aggressor_pct.buy_pct}% / SELL ${r.aggressor_pct.sell_pct}%`;
    els.tapeSpeed.textContent = (r.tape_speed_per_sec || 0).toFixed(2);
    els.spread.textContent    = r.spread_pct != null ? r.spread_pct.toFixed(3) + '% ' + (r.spread_velocity === 'WIDENING' ? '▲' : r.spread_velocity === 'TIGHTENING' ? '▼' : '·') : '—';
    els.whaleFlow.textContent = `${fmtUsd(r.whale_flow_usd.buy)} / ${fmtUsd(r.whale_flow_usd.sell)}`;

    if (r.nearest_magnet) {
      const m = r.nearest_magnet;
      const dir = m.distance_usd > 0 ? '▲ arriba' : '▼ abajo';
      els.magnet.innerHTML = `🧲 imán: $${Math.round(m.price).toLocaleString()} (${m.side === 'LONG_LIQ' ? 'longs rekt' : 'shorts rekt'}, ${fmtUsd(m.notional_usd)}) ${dir} ${fmtUsd(Math.abs(m.distance_usd))}`;
    } else {
      els.magnet.textContent = '';
    }

    const L = r.liquidations;
    if (L && L.total_liq_usd > 0) {
      const since = L.last_event_ago_sec != null ? `(último ${L.last_event_ago_sec}s)` : '';
      els.liq.innerHTML = `💥 liq 5m: longs ${fmtUsd(L.longs_liq_usd)} / shorts ${fmtUsd(L.shorts_liq_usd)} ${since}`;
    } else {
      els.liq.textContent = '';
    }

    els.trap.textContent = r.trap_warning ? '⚠ ' + r.trap_warning : '';
  }

  async function tick() {
    if (inflight) return;
    const assetInput = document.getElementById('trading-asset-input');
    const asset = assetInput && assetInput.value.trim() ? assetInput.value.trim() : 'BTC/USDT';
    inflight = true;
    try {
      const resp = await phantom.scalpradar.fetch({ asset });
      if (resp && resp.ok && resp.data) render(resp.data);
    } catch (e) {
      console.warn('[scalp-radar] tick error', e);
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 2000);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Only tick while the plan-view (deep-info bundle) is visible — otherwise
  // we burn IPC and re-render off-screen pixels.
  const obs = new MutationObserver(() => {
    if (document.body.classList.contains('show-plan')) start();
    else stop();
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (document.body.classList.contains('show-plan')) start();
})();

// ════════════════════════════════════════════════════════════════
// Open Trading in a separate window — main "🪟" button in the
// trading panel header.
// ════════════════════════════════════════════════════════════════
(function setupTradingPopoutButton() {
  const btn = document.getElementById('btn-trading-popout');
  if (!btn) return;
  btn.addEventListener('click', () => {
    phantom.window.openTrading().catch(() => {});
  });
})();

// ════════════════════════════════════════════════════════════════
// ?view=trading — when the renderer is loaded into the separate
// Trading window, hide all non-trading panels so the user sees
// only the analyze section + Market Pulse, statically laid out.
// ════════════════════════════════════════════════════════════════
(function setupTradingStandaloneView() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') !== 'trading') return;

    // Tag the body so popout-scoped CSS rules kick in (single scroll container,
    // no nested max-height caps, sections render fully and stacked).
    document.body.classList.add('trading-popout');

    // Hide everything in the main body except trading-panel.
    const body = document.querySelector('.body');
    if (body) {
      for (const child of Array.from(body.children)) {
        if (child.id === 'trading-panel') continue;
        if (child.classList && child.classList.contains('status')) continue; // keep status line
        child.style.display = 'none';
      }
    }
    // Force trading panel visible and expanded.
    const tp = document.getElementById('trading-panel');
    if (tp) {
      tp.style.display = 'block';
      tp.classList.remove('collapsed');
      const body2 = tp.querySelector('.collapsible-body');
      // Don't override display:flex from CSS — popout-scoped styles turn this
      // collapsible body into the single scrollable column for the window.
      if (body2) body2.style.removeProperty('display');
    }
    // Hide the action buttons row (Leer pantalla / Contestar) at the top.
    const actions = document.querySelector('.actions');
    if (actions) actions.style.display = 'none';
    // Update the document title for clarity in the OS window-list.
    document.title = 'Phantom — Trading';
    // Hide the popout button itself in the popped-out window (already separate).
    const popoutBtn = document.getElementById('btn-trading-popout');
    if (popoutBtn) popoutBtn.style.display = 'none';
  } catch (e) {
    console.warn('[trading standalone view] setup failed', e);
  }
})();

// ════════════════════════════════════════════════════════════════
// INSIGHTS — short AI reasoning snippets every 15 min + manual button.
// Lightweight call (maxTokens 400) that explains the BIAS in 1-3 lines
// using the live market data, like:
//   "Bearish bias by structure, but CVD positive and whales buying at $79K
//    sustain a technical bounce before continuing the drop."
// ════════════════════════════════════════════════════════════════
(function setupInsights() {
  const panel       = document.getElementById('ins-panel');
  if (!panel) return;
  const feedEl      = document.getElementById('ins-feed');
  const statusEl    = document.getElementById('ins-status');
  const countdownEl = document.getElementById('ins-countdown');
  const genBtn      = document.getElementById('ins-generate');
  const toggleBtn   = document.getElementById('ins-toggle');

  const POLL_MS    = 15 * 60 * 1000;   // 15 min
  const MAX_FEED   = 20;
  const STORAGE_KEY = 'phantom_insights_feed_v1';

  let history    = [];
  let nextAt     = Date.now() + POLL_MS;
  let timer      = null;
  let countdown  = null;
  let paused     = false;
  let busy       = false;

  /* ─── storage ─── */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) history = JSON.parse(raw).slice(0, MAX_FEED);
    } catch (_) { history = []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_FEED))); }
    catch (_) {}
  }

  /* ─── render ─── */
  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  }
  function dirClass(dir) {
    const d = (dir || '').toUpperCase();
    if (d === 'UP') return 'up';
    if (d === 'DOWN') return 'down';
    return 'range';
  }
  function dirLabel(dir) {
    const d = (dir || 'RANGE').toUpperCase();
    if (d === 'UP') return '↑ UP';
    if (d === 'DOWN') return '↓ DOWN';
    return '↔ RANGE';
  }
  function renderFeed() {
    if (!history.length) {
      feedEl.innerHTML = '<div class="ins-empty">' + (typeof t === 'function' ? t('ins.empty') : 'No insights yet.') + '</div>';
      return;
    }
    feedEl.innerHTML = history.map(it => {
      const cls = dirClass(it.direction) + (it.manual ? ' manual' : '');
      const assetTag = it.asset ? `<span>${escapeHTML(it.asset)}</span>` : '';
      return `
        <div class="ins-item ${cls}">
          <div class="ins-item-meta">
            <span>${assetTag}<span class="ins-item-dir">${dirLabel(it.direction)}</span></span>
            <span class="ins-item-time">${fmtTime(it.timestamp)}</span>
          </div>
          <div class="ins-item-text">${escapeHTML(it.text)}</div>
        </div>
      `;
    }).join('');
  }

  /* ─── countdown ─── */
  function updateCountdown() {
    if (paused) {
      countdownEl.textContent = '· ' + (typeof t === 'function' ? t('ins.paused') : 'paused');
      return;
    }
    const ms = Math.max(0, nextAt - Date.now());
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const label = typeof t === 'function' ? t('ins.next_in') : 'next';
    countdownEl.textContent = `· ${label} ${m}:${String(s).padStart(2, '0')}`;
  }

  /* ─── lightweight AI call ─── */
  async function buildContext(asset) {
    // Pull the same live data sources Market Pulse uses + minimal coinglass.
    const [mp, cg] = await Promise.all([
      phantom.marketpulse.fetch({ asset }).catch(() => ({ ok: false })),
      phantom.coinglass.fetch({ symbol: asset }).catch(() => ({ ok: false }))
    ]);
    const lines = [];
    lines.push(`Asset: ${asset}`);
    if (mp && mp.ok && mp.data) {
      const d = mp.data;
      if (d.book && d.book.mid) lines.push(`Mid: $${d.book.mid.toFixed(2)} | spread ${d.book.spread_pct.toFixed(4)}%`);
      if (d.flow) {
        const f = d.flow;
        lines.push(`CVD: ${f.cvd >= 0 ? '+' : '-'}$${Math.abs(f.cvd).toFixed(0)} (${f.verdict})`);
        lines.push(`Window flow: buys $${f.buy_notional.toFixed(0)} vs sells $${f.sell_notional.toFixed(0)}`);
      }
      if (d.book && (d.book.bid_walls.length || d.book.ask_walls.length)) {
        const fmtZone = (w) => `$${w.zone_start.toFixed(2)}–$${(w.zone_end - 0.01).toFixed(2)}`;
        if (d.book.bid_walls[0]) {
          const b = d.book.bid_walls[0];
          lines.push(`Bid zone: ${fmtZone(b)} (${b.total_size.toFixed(2)} ${d.symbol.replace('USDT','')}, ${b.mult.toFixed(1)}× median, ${b.dist_pct.toFixed(2)}%)`);
        }
        if (d.book.ask_walls[0]) {
          const a = d.book.ask_walls[0];
          lines.push(`Ask zone: ${fmtZone(a)} (${a.total_size.toFixed(2)} ${d.symbol.replace('USDT','')}, ${a.mult.toFixed(1)}× median, +${a.dist_pct.toFixed(2)}%)`);
        }
      }
      const whales = (d.trades_recent || []).filter(t => t.is_whale).slice(0, 4);
      if (whales.length) {
        lines.push(`Recent whale prints: ${whales.map(w => `${w.side} ${w.qty.toFixed(2)} @ $${w.price.toFixed(1)} (${w.seconds_ago}s ago)`).join(' · ')}`);
      }
    }
    if (cg && cg.ok && cg.promptBlock) {
      // Pull the most relevant 3-4 lines, not the whole block.
      const cgLines = cg.promptBlock.split('\n').slice(0, 8).join('\n');
      lines.push('Coinglass:\n' + cgLines);
    }
    return lines.join('\n');
  }

  async function generate({ manual = false } = {}) {
    if (busy) return;
    const asset = (typeof tradingAssetInput !== 'undefined' && tradingAssetInput)
      ? tradingAssetInput.value.trim()
      : '';
    if (!asset) {
      statusEl.textContent = typeof t === 'function' ? t('ins.no_asset') : 'no asset';
      return;
    }
    busy = true;
    genBtn.disabled = true;
    statusEl.textContent = typeof t === 'function' ? t('ins.generating') : 'thinking…';

    try {
      const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
      const langName = (typeof LANG_NAMES !== 'undefined' && LANG_NAMES[uiLang]) || 'Spanish';
      const ctx = await buildContext(asset);

      const system = `You are a senior crypto trader giving a SHORT tactical insight.

ABSOLUTE PRIORITY — RESPOND IN ${langName} (${uiLang}). Every word.

OUTPUT FORMAT — exactly these two lines, nothing else:
DIRECTION: <UP|DOWN|RANGE>
<one or two sentences (max 50 words) explaining the bias using the live data: structure, flow, walls, whales. NO indicator names. NO news. NO trade setups. NO disclaimers.>

Example of GOOD output:
DIRECTION: DOWN
Sesgo bajista por estructura (lower highs en 4H), pero CVD positivo y whales comprando en $79K sostienen un rebote técnico antes de continuar la caída.

Example of BAD output (too long, has indicators, has setups — do NOT do this):
DIRECTION: DOWN
The RSI is at 38 indicating oversold conditions, MACD shows bearish divergence... [too verbose, forbidden]`;

      const user = `Live market data for ${asset}:\n${ctx}\n\nGive me the one-line insight now.`;

      const cfg = await phantom.config.get();
      const model = cfg.tradingModel || 'claude-opus-4-7';
      const resp = await phantom.ai.call({
        messages: [{ role: 'user', content: user }],
        system,
        model,
        maxTokens: 400
      });

      const raw = (resp && resp.text || '').trim();
      const dirMatch = raw.match(/DIRECTION\s*:\s*(UP|DOWN|RANGE)/i);
      const direction = dirMatch ? dirMatch[1].toUpperCase() : 'RANGE';
      const text = raw.replace(/^DIRECTION\s*:\s*(UP|DOWN|RANGE)\s*[\r\n]+/i, '').trim();

      const item = {
        timestamp: new Date().toISOString(),
        asset,
        direction,
        text: text || raw,
        manual: !!manual
      };
      history = [item, ...history].slice(0, MAX_FEED);
      saveHistory();
      renderFeed();
      statusEl.textContent = new Date().toLocaleTimeString();
    } catch (e) {
      console.warn('[insights] generate failed', e);
      statusEl.textContent = typeof t === 'function' ? t('ins.error') : 'error';
    } finally {
      busy = false;
      genBtn.disabled = false;
      nextAt = Date.now() + POLL_MS;
    }
  }

  /* ─── lifecycle ─── */
  function start() {
    paused = false;
    if (toggleBtn) toggleBtn.textContent = '⏸';
    if (timer) return;
    nextAt = Date.now() + POLL_MS;
    timer = setInterval(() => {
      if (!paused && Date.now() >= nextAt) generate({ manual: false });
    }, 5000);  // check every 5s, generate when 15-min mark hits
    if (!countdown) countdown = setInterval(updateCountdown, 1000);
    updateCountdown();
  }
  function pause() {
    paused = true;
    if (toggleBtn) toggleBtn.textContent = '▶';
    if (timer) { clearInterval(timer); timer = null; }
    updateCountdown();
  }

  if (genBtn) genBtn.addEventListener('click', () => generate({ manual: true }));
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    if (paused || !timer) start();
    else pause();
  });

  /* ─── boot ─── */
  loadHistory();
  renderFeed();

  // Watch trading panel visibility — start when visible.
  const tp = document.getElementById('trading-panel');
  function maybeStart() {
    if (tp && tp.style.display !== 'none' && tp.offsetParent !== null) start();
  }
  maybeStart();
  if (tp) {
    new MutationObserver(() => {
      if (tp.style.display === 'none') pause();
      else if (!timer && !paused) start();
    }).observe(tp, { attributes: true, attributeFilter: ['style'] });
  }
})();

// ════════════════════════════════════════════════════════════════
// WATCHER MODE — collapse everything except Market Pulse + Insights.
// Resizes the window to a compact size and pins the state in
// localStorage so it survives reloads.
// ════════════════════════════════════════════════════════════════
(function setupWatcherMode() {
  const btn  = document.getElementById('btn-watcher');
  const exit = document.getElementById('watcher-exit');
  if (!btn) return;

  const STORAGE_KEY = 'phantom_watcher_mode_v1';
  // Tall + reasonably narrow — main.js clamps to workArea bounds, so 2000
  // height becomes "as tall as your screen minus 40px".
  const WATCHER_SIZE = { width: 560, height: 2000 };
  let prevSize = null;     // saved between toggle on/off

  function setBodyMode(on) {
    document.body.classList.toggle('watcher-mode', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
  }

  async function enter() {
    // Remember current window size so we can restore on exit.
    try {
      const win = window;
      prevSize = { width: win.outerWidth || win.innerWidth, height: win.outerHeight || win.innerHeight };
    } catch (_) { prevSize = null; }

    // Ensure trading panel is visible + expanded so the live panels render.
    const tp = document.getElementById('trading-panel');
    if (tp) {
      tp.style.display = 'block';
      tp.classList.remove('collapsed');
      const tpBody = tp.querySelector('.collapsible-body');
      if (tpBody) tpBody.style.display = 'block';
    }
    // Auto-enable trading toggle in case it was off (so the panel actually shows).
    try {
      const cfgChk = document.getElementById('cfg-trading');
      if (cfgChk && !cfgChk.checked) {
        cfgChk.checked = true;
        // Trigger any wired listeners.
        cfgChk.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}

    setBodyMode(true);

    // Shrink the window. If the call fails (different window or unavailable),
    // we just stay in CSS-only mode.
    try { await phantom.window.resize(WATCHER_SIZE); } catch (_) {}
  }

  async function leave() {
    setBodyMode(false);
    // CRITICAL: clear the inline styles we set on enter(), otherwise the
    // panel keeps `display: block` inline which OVERRIDES the original CSS
    // (often `display: flex`) and silently breaks overflow on inner
    // scrollable areas like .mp-walls / .mp-tape / .ins-feed. The user saw
    // this as "Market Pulse no scrollea después de salir del modo ventana".
    const tp = document.getElementById('trading-panel');
    if (tp) {
      tp.style.display = '';
      const tpBody = tp.querySelector('.collapsible-body');
      if (tpBody) tpBody.style.display = '';
    }
    if (prevSize && prevSize.width && prevSize.height) {
      try { await phantom.window.resize(prevSize); } catch (_) {}
    } else {
      // Fallback to the canonical "trading enabled" size if we never captured
      // a prior size (e.g. watcher was the first thing the user toggled).
      try { await phantom.window.resize({ width: 720, height: 1100 }); } catch (_) {}
    }
    prevSize = null;
    // Force a reflow so the layout reapplies cleanly (defensive — fixes
    // edge cases where the browser caches an old scroll height).
    if (tp) { void tp.offsetHeight; }
  }

  btn.addEventListener('click', () => {
    if (document.body.classList.contains('watcher-mode')) leave();
    else enter();
  });
  if (exit) exit.addEventListener('click', () => leave());

  // ESC also exits watcher mode (only when active).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('watcher-mode')) {
      leave();
    }
  });

  // Restore previous state on load.
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') {
      // Small delay so the rest of the UI mounts first.
      setTimeout(() => enter(), 100);
    }
  } catch (_) {}
})();

// ════════════════════════════════════════════════════════════════
// PRICE PLAYBOOK — on-demand deep AI analysis that pulls ALL data
// (charts, exchange, coinglass, orderflow, trade tape, hyperliquid,
// market pulse) and outputs 4-6 conditional scenarios with explicit
// price triggers / entries / SLs / TPs.
// ════════════════════════════════════════════════════════════════
(function setupPricePlaybook() {
  const panel   = document.getElementById('pb-panel');
  if (!panel) return;
  const btn     = document.getElementById('pb-generate');
  const headerBtn = document.getElementById('btn-trading-playbook');
  const bodyEl  = document.getElementById('pb-body');
  const metaEl  = document.getElementById('pb-meta');
  const statusEl= document.getElementById('pb-status');

  const STORAGE_KEY = 'phantom_playbook_v1';
  let busy = false;
  let last = null;

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function loadLast() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        last = JSON.parse(raw);
        render();
      }
    } catch (_) {}
  }

  function saveLast() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(last)); } catch (_) {}
  }

  function render() {
    if (!last) {
      bodyEl.innerHTML = '<div class="pb-empty">' + (typeof t === 'function' ? t('playbook.empty') : 'No plan yet.') + '</div>';
      metaEl.textContent = '';
      return;
    }
    metaEl.textContent = '· ' + (last.asset || '') + ' · ' + new Date(last.timestamp).toLocaleTimeString();

    // Render the parsed plan: levels + scenarios + sequence.
    let html = '';

    if (last.parsed.levels && last.parsed.levels.length) {
      html += '<h2>Niveles críticos</h2><div class="pb-levels">';
      for (const lv of last.parsed.levels) {
        html += '<div class="pb-level">'
          + '<span class="pb-level-price">$' + escapeText(lv.price) + '</span>'
          + '<span class="pb-level-role">' + escapeText(lv.role) + '</span>'
          + '</div>';
      }
      html += '</div>';
    }

    if (last.parsed.scenarios && last.parsed.scenarios.length) {
      html += '<h2>Escenarios</h2>';
      for (const s of last.parsed.scenarios) {
        const side = (s.action || '').toLowerCase();
        const cls = side === 'long' ? 'long' : side === 'short' ? 'short' : 'wait';
        html += '<div class="pb-scenario ' + cls + '">'
          + '<div class="pb-scen-title">'
          + '<span>' + escapeText(s.name || 'Scenario') + ' — ' + escapeText(s.action || 'WAIT') + '</span>'
          + (s.confidence ? '<span class="pb-scen-confidence">' + escapeText(s.confidence) + '</span>' : '')
          + '</div>'
          + '<div class="pb-scen-trigger"><b>Si:</b> ' + escapeText(s.trigger || '—') + '</div>'
          + '<div class="pb-scen-prices">';
        if (s.entry) html += pbPrice('Entry', s.entry);
        if (s.sl)    html += pbPrice('SL',    s.sl);
        if (s.tp1)   html += pbPrice('TP1',   s.tp1);
        if (s.tp2)   html += pbPrice('TP2',   s.tp2);
        if (s.tp3)   html += pbPrice('TP3',   s.tp3);
        if (s.size)  html += pbPrice('Size',  s.size);
        html += '</div>';
        if (s.reason) html += '<div class="pb-scen-reason">' + escapeText(s.reason) + '</div>';
        html += '</div>';
      }
    }

    if (last.parsed.sequence) {
      html += '<h2>Secuencia probable</h2><div style="white-space:pre-wrap;font-size:11.5px;line-height:1.6;opacity:0.92">' + escapeText(last.parsed.sequence) + '</div>';
    }

    if (!html) {
      // Fallback: just dump the raw text.
      html = '<div style="white-space:pre-wrap;font-size:11.5px;line-height:1.6">' + escapeText(last.raw || '') + '</div>';
    }

    bodyEl.innerHTML = html;
  }
  function pbPrice(label, value) {
    return '<div class="pb-scen-price">'
      + '<div class="pb-scen-price-label">' + escapeText(label) + '</div>'
      + '<div class="pb-scen-price-value">' + escapeText(value) + '</div>'
      + '</div>';
  }

  /** Parse the AI response into structured scenarios. The prompt asks the AI
   *  to use these EXACT tags so the parser is reliable. */
  function parsePlaybook(raw) {
    const out = { levels: [], scenarios: [], sequence: null };

    // Levels: [LEVEL] $X | role | reason [/LEVEL]
    const levelRe = /\[LEVEL\]([\s\S]*?)\[\/LEVEL\]/gi;
    let lm;
    while ((lm = levelRe.exec(raw)) !== null) {
      const body = lm[1].trim();
      const parts = body.split('|').map(p => p.trim());
      if (parts.length >= 2) {
        out.levels.push({
          price: parts[0].replace(/^\$/, ''),
          role:  parts.slice(1).join(' · ')
        });
      }
    }

    // Scenarios: [SCENARIO name="..." action="LONG|SHORT|WAIT" confidence="★★★"]
    //   TRIGGER: ...
    //   ENTRY: ...
    //   SL: ...
    //   TP1: ...
    //   ...
    //   REASON: ...
    // [/SCENARIO]
    const scenRe = /\[SCENARIO\b([^\]]*)\]([\s\S]*?)\[\/SCENARIO\]/gi;
    let sm;
    while ((sm = scenRe.exec(raw)) !== null) {
      const attrs = sm[1];
      const body = sm[2];
      const s = {};
      const aMatch = (re) => { const m = attrs.match(re); return m ? m[1] : null; };
      s.name       = aMatch(/\bname\s*=\s*"([^"]+)"/i)       || 'Escenario';
      s.action     = (aMatch(/\baction\s*=\s*"([^"]+)"/i)   || 'WAIT').toUpperCase();
      s.confidence = aMatch(/\bconfidence\s*=\s*"([^"]+)"/i) || null;
      const field = (key) => {
        const m = body.match(new RegExp('^\\s*' + key + '\\s*:\\s*([^\\n]+)', 'mi'));
        return m ? m[1].trim() : null;
      };
      s.trigger = field('TRIGGER');
      s.entry   = field('ENTRY');
      s.sl      = field('SL');
      s.tp1     = field('TP1');
      s.tp2     = field('TP2');
      s.tp3     = field('TP3');
      s.size    = field('SIZE');
      s.reason  = field('REASON');
      // Extract the [CONDITIONS] block per scenario (machine-checkable rules).
      const condMatch = body.match(/\[CONDITIONS\]([\s\S]*?)\[\/CONDITIONS\]/i);
      if (condMatch && window.PlaybookParser) {
        s.conditions = window.PlaybookParser.parseConditionsBlock(condMatch[1]);
      } else {
        s.conditions = [];
      }
      out.scenarios.push(s);
    }

    // Sequence: [SEQUENCE] ... [/SEQUENCE]
    const seqMatch = raw.match(/\[SEQUENCE\]([\s\S]*?)\[\/SEQUENCE\]/i);
    if (seqMatch) out.sequence = seqMatch[1].trim();

    return out;
  }

  async function generate() {
    if (busy) return;
    const asset = (typeof tradingAssetInput !== 'undefined' && tradingAssetInput)
      ? tradingAssetInput.value.trim()
      : '';
    if (!asset) {
      statusEl.textContent = typeof t === 'function' ? t('playbook.no_asset') : 'no asset';
      return;
    }
    busy = true;
    if (btn) btn.disabled = true;
    if (headerBtn) headerBtn.disabled = true;
    statusEl.textContent = typeof t === 'function' ? t('playbook.generating') : 'analyzing…';

    try {
      // Pull EVERYTHING the agent should know about.
      const xIncluded = await (typeof isXEnabled === 'function' ? isXEnabled() : Promise.resolve(false));
      const [exchangeData, cgRes, ofRes, ttRes, hlRes, dlRes, newsRes, mpRes] = await Promise.all([
        (typeof fetchExchangeData === 'function') ? fetchExchangeData() : Promise.resolve(null),
        phantom.coinglass.fetch({ symbol: asset }).catch(() => ({ ok: false })),
        phantom.orderflow.fetch({ asset }).catch(() => ({ ok: false })),
        phantom.tradetape.fetch({ asset }).catch(() => ({ ok: false })),
        phantom.hyperliquid.fetch({ asset }).catch(() => ({ ok: false })),
        phantom.defillama.fetch().catch(() => ({ ok: false })),
        phantom.news.fetch({ asset, includeX: xIncluded }).catch(() => ({ ok: false })),
        phantom.marketpulse.fetch({ asset }).catch(() => ({ ok: false }))
      ]);

      const cfg = await phantom.config.get();
      const uiLang = (typeof getLanguage === 'function') ? getLanguage() : 'es';
      const langName = (typeof LANG_NAMES !== 'undefined' && LANG_NAMES[uiLang]) || 'Spanish';

      // Build a compressed context: only the parts the playbook cares about.
      const ctxParts = [];
      if (typeof formatExchangeDataForPrompt === 'function') {
        const exCtx = formatExchangeDataForPrompt(exchangeData);
        if (exCtx) ctxParts.push(exCtx);
      }
      if (cgRes && cgRes.ok && cgRes.promptBlock) ctxParts.push(cgRes.promptBlock);
      if (ofRes && ofRes.ok && ofRes.promptBlock) ctxParts.push(ofRes.promptBlock);
      if (ttRes && ttRes.ok && ttRes.promptBlock) ctxParts.push(ttRes.promptBlock);
      if (hlRes && hlRes.ok && hlRes.promptBlock) ctxParts.push(hlRes.promptBlock);
      if (dlRes && dlRes.ok && dlRes.promptBlock) ctxParts.push(dlRes.promptBlock);
      if (mpRes && mpRes.ok && mpRes.data && mpRes.data.book) {
        const b = mpRes.data.book;
        const wallsTxt = [];
        wallsTxt.push('MARKET PULSE walls (most-recent live orderbook zones):');
        for (const w of (b.bid_walls || [])) {
          wallsTxt.push(`  BID  $${w.zone_start.toFixed(2)}-$${(w.zone_end - 0.01).toFixed(2)}  size=${w.total_size.toFixed(2)}  mult=${w.mult.toFixed(1)}x  dist=${w.dist_pct.toFixed(2)}%`);
        }
        for (const w of (b.ask_walls || [])) {
          wallsTxt.push(`  ASK  $${w.zone_start.toFixed(2)}-$${(w.zone_end - 0.01).toFixed(2)}  size=${w.total_size.toFixed(2)}  mult=${w.mult.toFixed(1)}x  dist=${w.dist_pct.toFixed(2)}%`);
        }
        if (mpRes.data.flow) {
          wallsTxt.push(`  Flow: CVD=${mpRes.data.flow.cvd.toFixed(0)} verdict=${mpRes.data.flow.verdict}`);
        }
        ctxParts.push(wallsTxt.join('\n'));
      }
      if (newsRes && newsRes.ok && newsRes.data && typeof inlineSummarizeNewsForPrompt === 'function') {
        const newsBlock = inlineSummarizeNewsForPrompt(newsRes.data);
        if (newsBlock) ctxParts.push(newsBlock);
      }

      const system = `You are a senior crypto trader building a TACTICAL PRICE PLAYBOOK for the next 1-4 hours.

ABSOLUTE PRIORITY — RESPOND IN ${langName} (${uiLang}). All text in the response (headers, scenario names, triggers, reasons) must be in ${langName}.

OUTPUT FORMAT — use these EXACT tags so the UI can parse them. Do NOT use markdown headers, free prose between sections, or anything outside the tags except brief intro/outro.

1) CRITICAL LEVELS (4-7 items):
[LEVEL]
$<price> | <role: e.g. soporte / resistencia / breakout / breakdown / EMA200 / wall> | <one-line reason>
[/LEVEL]

2) SCENARIOS (4-6 items, each with EXPLICIT trigger + a machine-checkable CONDITIONS block):
[SCENARIO name="<short name>" action="LONG|SHORT|WAIT" confidence="★★★★★"]
TRIGGER: <human description of what needs to happen, in 1 sentence>
[CONDITIONS]
- <op>:<value>
- <op>:<value>
[/CONDITIONS]
ENTRY: $X - $Y
SL: $Z
TP1: $A
TP2: $B
TP3: $C
SIZE: X% of capital
REASON: <one sentence — what data supports this>
[/SCENARIO]

The [CONDITIONS] block is MANDATORY for every NON-WAIT scenario. Each line is one machine-checkable condition. ALL conditions must be true at the same instant for the alert to fire. Use ONLY these operators (anything else is silently ignored):

  price_in:LOW-HIGH        # current mid between LOW and HIGH (use raw numbers, no $)
  price_above:N            # current mid > N
  price_below:N            # current mid < N
  taker_5m_above:N         # last 5m taker buy/sell ratio > N (e.g. 1.20)
  taker_5m_below:N         # < N (e.g. 0.85)
  taker_1h_above:N
  taker_1h_below:N
  cvd_above:N              # current Cumulative Volume Delta in USD > N
  cvd_below:N              # use negatives for selling, e.g. cvd_below:-1500000
  whale_sell_min_usd:N     # at least one whale SELL print in window with notional ≥ $N
  whale_buy_min_usd:N
  candle_close_above:N     # most recent COMPLETED 5m candle close > N
  candle_close_below:N
  funding_above:N          # current funding > N percent (e.g. 0.05 for 0.05%)
  funding_below:N

Example — SHORT "rejection at ask wall" scenario:
[CONDITIONS]
- price_in:79100-79150
- taker_5m_below:0.85
- whale_sell_min_usd:300000
- candle_close_below:79080
[/CONDITIONS]

Pick 3-6 conditions per scenario. Be aggressive about SPECIFICITY — vague conditions waste alerts. The conditions MUST match the natural-language TRIGGER above (don't say "whale sells appear" in TRIGGER and omit whale_sell_min_usd in [CONDITIONS]).

3) PROBABLE SEQUENCE — one paragraph (no tags, just text after this block):
[SEQUENCE]
1. <most likely first move>
2. <if that happens, next>
3. <if not, alternative>
[/SEQUENCE]

RULES:
- Every price MUST be in $ (the renderer parses them for coloring).
- Use EXACT data from the blocks below — never invent numbers.
- Confidence stars: ★★★★★ = high conviction, ★★★ = neutral, ★ = low.
- Cover BOTH long AND short scenarios so the trader has a plan in either direction.
- If a scenario is WAIT, set action="WAIT" and use the entry/SL/TPs fields to describe what conditions you'd need to enter.
- Be SPECIFIC: "if BTC breaks $79,200 with closing 5m candle above wall and CVD turns positive" not "if it goes up".
- NO disclaimers, NO indicator name-dropping, NO general explanations. Just the playbook.`;

      const userText = `Asset: ${asset}\n\n` + ctxParts.join('\n\n') + `\n\nBuild the playbook now.`;

      const resp = await phantom.ai.call({
        messages: [{ role: 'user', content: userText }],
        system,
        model: cfg.tradingModel || 'claude-opus-4-7',
        maxTokens: 4096
      });

      const raw = (resp && resp.text || '').trim();
      const parsed = parsePlaybook(raw);

      last = {
        timestamp: new Date().toISOString(),
        asset,
        raw,
        parsed
      };
      saveLast();
      render();
      statusEl.textContent = new Date().toLocaleTimeString();

      // Optional: dump to disk for offline review.
      try { phantom.ai.debugPrompt({ kind: 'playbook', prompt: userText + '\n\n=== RESPONSE ===\n' + raw }).catch(() => {}); } catch (_) {}
    } catch (e) {
      console.warn('[playbook] generate failed', e);
      statusEl.textContent = typeof t === 'function' ? t('playbook.error') : 'error';
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
      if (headerBtn) headerBtn.disabled = false;
    }
  }

  if (btn)       btn.addEventListener('click', generate);

  // The top-right "📋 Plan" button is a VIEW TOGGLE — it shows/hides the
  // plan panel. The regenerate action lives inside the panel (#pb-generate).
  // The "Analizar" button always returns to analysis view (hides plan).
  // This applies in BOTH the main window and the popout — the panel is
  // hidden by default and only appears when the user explicitly asks for it.
  if (headerBtn) {
    headerBtn.addEventListener('click', () => {
      const showing = panel.classList.toggle('visible');
      headerBtn.classList.toggle('active', showing);
      document.body.classList.toggle('show-plan', showing);
      // Auto-generate the first time the user opens the panel and there's
      // nothing saved yet — saves them an extra click.
      if (showing && !last && !busy) generate();
    });
  }
  const analyzeBtn = document.getElementById('btn-trading-analyze');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => {
      panel.classList.remove('visible');
      if (headerBtn) headerBtn.classList.remove('active');
      document.body.classList.remove('show-plan');
    });
  }

  loadLast();
})();

// ════════════════════════════════════════════════════════════════
// PRICE PLAYBOOK — chart + trigger watcher + email alerts.
// Reads the playbook stored in localStorage (set by setupPricePlaybook),
// renders an SVG mini-chart of all levels, and polls the Market Pulse mid
// every 5s. When the current price enters a scenario's entry range AND
// alerts are armed, it fires an email + on-screen toast (each scenario
// fires at most once until the playbook is regenerated).
// ════════════════════════════════════════════════════════════════
(function setupPlaybookChartAndAlerts() {
  const panel = document.getElementById('pb-panel');
  if (!panel) return;
  const chartWrap = document.getElementById('pb-chart-wrap');
  const armedChk  = document.getElementById('pb-armed-master');
  const emailEl   = document.getElementById('pb-armed-email');
  const bodyEl    = document.getElementById('pb-body');

  const PLAYBOOK_KEY = 'phantom_playbook_v1';
  const ALERTS_KEY   = 'phantom_playbook_alerts_v1';
  const POLL_MS      = 5000;
  let lastFiredAt    = {};   // scenarioId → ISO timestamp (persisted)
  let armedState     = false;
  let savedEmail     = '';
  let lastPrice      = null;
  let lastPriceTs    = 0;

  /* ─── Persistence helpers ─── */
  function loadAlertsState() {
    try {
      const raw = localStorage.getItem(ALERTS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        armedState = !!data.armed;
        savedEmail = data.email || '';
        lastFiredAt = data.fired || {};
      }
    } catch (_) {}
    if (armedChk) armedChk.checked = armedState;
    if (emailEl) emailEl.value = savedEmail;
  }
  function saveAlertsState() {
    try {
      localStorage.setItem(ALERTS_KEY, JSON.stringify({
        armed: armedState,
        email: savedEmail,
        fired: lastFiredAt
      }));
    } catch (_) {}
  }
  function loadPlaybook() {
    try {
      const raw = localStorage.getItem(PLAYBOOK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  /* ─── SVG mini-chart of all levels ─── */
  function renderChart(playbook, mid) {
    if (!chartWrap) return;
    const P = window.PlaybookParser;
    if (!playbook || !playbook.parsed || !P) {
      chartWrap.innerHTML = '<div class="pb-chart-empty">Generá un plan para ver los niveles graficados.</div>';
      return;
    }
    // Re-attach numeric ranges (the stored playbook may be raw text-only).
    const scenarios = (playbook.parsed.scenarios || []).map(P.attachNumericRanges);
    const levels = P.extractLevelsForChart(scenarios, playbook.parsed.levels || []);
    if (levels.length === 0) {
      chartWrap.innerHTML = '<div class="pb-chart-empty">El plan no incluye precios numéricos parseables.</div>';
      return;
    }

    // Include mid in the y-range so the price arrow lands on the canvas.
    const prices = levels.map(l => l.price);
    if (mid && !isNaN(mid)) prices.push(mid);
    const min = Math.min.apply(null, prices);
    const max = Math.max.apply(null, prices);
    const pad = (max - min) * 0.05 || max * 0.001 || 1;
    const yMin = min - pad;
    const yMax = max + pad;
    const yScale = (p) => 230 - ((p - yMin) / (yMax - yMin)) * 220;

    // Build SVG.
    const W = 100;     // we use viewBox 0 0 100 240 + label area
    const lines = levels.map((lv, i) => {
      const y = yScale(lv.price);
      const color = lv.kind === 'sl'    ? '#ff4d4d'
                  : lv.kind === 'tp'    ? '#2effa3'
                  : lv.kind === 'entry' ? (lv.side === 'short' ? '#ff8080' : '#80ffc0')
                  :                       '#ffb84a';
      const dash = lv.kind === 'entry' ? '0' : lv.kind === 'sl' ? '4,3' : lv.kind === 'tp' ? '2,3' : '0';
      const label = `${lv.role} · $${lv.price.toFixed(lv.price >= 100 ? 0 : 2)}`;
      return `
        <line x1="0" y1="${y}" x2="100" y2="${y}" stroke="${color}" stroke-width="0.5" stroke-dasharray="${dash}" opacity="0.7"/>
        <text x="0.6" y="${y - 1.5}" fill="${color}" font-family="Courier New, Menlo, monospace" font-size="2.6" font-weight="700" letter-spacing="0.06em" opacity="0.95">${escapeHTML(label)}</text>`;
    }).join('');

    const midLine = (mid && !isNaN(mid))
      ? `<line x1="0" y1="${yScale(mid)}" x2="100" y2="${yScale(mid)}" stroke="#fff3d6" stroke-width="0.8" opacity="0.95"/>
         <text x="78" y="${yScale(mid) - 1.5}" fill="#fff3d6" font-family="Courier New, Menlo, monospace" font-size="3" font-weight="700">▶ $${mid.toFixed(mid >= 100 ? 0 : 2)}</text>`
      : '';

    chartWrap.innerHTML = `
      <svg viewBox="0 0 100 240" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="240" fill="#050302"/>
        <!-- subtle horizontal grid -->
        ${Array.from({ length: 6 }, (_, i) => `<line x1="0" y1="${10 + i * 44}" x2="100" y2="${10 + i * 44}" stroke="#1a1108" stroke-width="0.2"/>`).join('')}
        ${lines}
        ${midLine}
      </svg>`;
  }

  /* ─── Toast on-screen notification ─── */
  function showToast(text, side) {
    let toast = document.getElementById('pb-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pb-toast';
      toast.className = 'pb-toast';
      document.body.appendChild(toast);
    }
    toast.className = 'pb-toast' + (side === 'short' ? ' short' : '');
    toast.textContent = text;
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => toast.classList.remove('show'), 7000);
  }

  /* ─── Send email alert via existing Cloudflare worker ─── */
  async function sendTriggerAlert(scenario, playbook, mid, evalResult) {
    if (!savedEmail) return false;
    const decision = scenario.action === 'LONG' || scenario.action === 'SHORT'
      ? scenario.action
      : 'WAIT';
    const subject = `🎯 TRIGGER · ${scenario.name || 'Plan'} — ${playbook.asset}`;
    // Build a clear summary that includes the trigger TEXT, the action, the
    // reason, AND a checklist of which exact conditions passed (with the
    // observed value at fire-time). That makes the email actionable on its own.
    const condLines = (evalResult && Array.isArray(evalResult.results))
      ? evalResult.results.map(r => `  ${r.passed ? '✓' : '✗'} ${r.cond.label || r.cond.op} — obs: ${r.observed}`).join('\n')
      : '';
    const summary =
      `🎯 TODAS las condiciones del trigger se cumplieron @ $${mid.toFixed(2)}.\n\n` +
      `Trigger: ${scenario.trigger || '—'}\n\n` +
      `Acción a realizar: ${scenario.action || '—'}\n` +
      (scenario.reason ? `Razón: ${scenario.reason}\n` : '') +
      (condLines ? `\nCondiciones verificadas:\n${condLines}\n` : '');
    const tradeSetup = {
      entry: scenario.entry,
      sl: scenario.sl,
      tp1: scenario.tp1,
      tp2: scenario.tp2,
      tp3: scenario.tp3,
      size: scenario.size
    };
    try {
      const res = await phantom.trading.sendAlert({
        to: savedEmail,
        asset: playbook.asset,
        decision,
        summary,
        tradeSetup,
        timestamp: new Date().toISOString(),
        kind: 'playbook-trigger',
        subjectOverride: subject
      });
      return !!(res && res.success);
    } catch (e) {
      console.warn('[playbook alerts] email send failed', e);
      return false;
    }
  }

  /* ─── Build a stable scenario id (so the same scenario doesn't re-fire) ─── */
  function scenarioId(playbookTs, scenario) {
    return playbookTs + '__' + (scenario.name || 'scn') + '__' + (scenario.entry || '?');
  }

  /**
   * Build a live market snapshot that the condition evaluator can read.
   * Pulls from Market Pulse + Order Flow in parallel (both cached server-side).
   */
  async function buildSnapshot(asset) {
    const [mp, of] = await Promise.all([
      phantom.marketpulse.fetch({ asset }).catch(() => ({ ok: false })),
      phantom.orderflow.fetch({ asset }).catch(() => ({ ok: false }))
    ]);
    const snap = {
      mid: null, taker_5m: null, taker_1h: null,
      cvd: null, whales_recent: [],
      candle_5m_close: null, funding_pct: null
    };
    if (mp && mp.ok && mp.data) {
      const d = mp.data;
      if (d.book && d.book.mid) snap.mid = d.book.mid;
      if (d.flow) snap.cvd = d.flow.cvd;
      if (Array.isArray(d.trades_recent)) {
        snap.whales_recent = d.trades_recent
          .filter(t => t.is_whale)
          .map(t => ({ side: t.side, notional_usd: t.notional, seconds_ago: t.seconds_ago }));
        // Approximate "last 5m candle close" from the trade tape: the closing
        // price of trades in the most recent ~5 minutes.
        const fiveMinAgo = Date.now() / 1000 - 300;
        const recentEnough = d.trades_recent.filter(t => (Date.now() / 1000 - t.seconds_ago) > fiveMinAgo);
        if (recentEnough.length) snap.candle_5m_close = recentEnough[0].price;
        else if (d.trades_recent.length) snap.candle_5m_close = d.trades_recent[0].price;
      }
    }
    if (of && of.ok && of.data) {
      const o = of.data;
      if (o.taker5m && typeof o.taker5m.latest_ratio === 'number') snap.taker_5m = o.taker5m.latest_ratio;
      if (o.taker1h && typeof o.taker1h.latest_ratio === 'number') snap.taker_1h = o.taker1h.latest_ratio;
    }
    return snap;
  }

  /* ─── Main check loop: evaluates ALL conditions per scenario each tick ─── */
  async function checkTriggers() {
    const playbook = loadPlaybook();
    if (!playbook || !playbook.parsed || !window.PlaybookParser) return;
    const P = window.PlaybookParser;
    const asset = (typeof tradingAssetInput !== 'undefined' && tradingAssetInput)
      ? tradingAssetInput.value.trim()
      : playbook.asset;

    let snapshot;
    try { snapshot = await buildSnapshot(asset); } catch (_) { return; }
    if (!snapshot || !snapshot.mid) return;
    lastPrice = snapshot.mid;
    lastPriceTs = Date.now();
    renderChart(playbook, snapshot.mid);

    const scenarios = (playbook.parsed.scenarios || []).map(P.attachNumericRanges);

    // Evaluate every scenario's conditions against the snapshot. Even when
    // armed = false we still evaluate so the UI can show ✓/✗ live.
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i];
      // Skip pure WAIT scenarios with no conditions — nothing to fire.
      if (!Array.isArray(s.conditions) || s.conditions.length === 0) {
        updateScenarioConditionsUI(i, null);
        continue;
      }
      const result = P.evaluateAllConditions(s.conditions, snapshot);
      updateScenarioConditionsUI(i, result);

      if (!result.all_passed) continue;
      if (!armedState) continue;            // would have fired, but alerts disarmed
      const id = scenarioId(playbook.timestamp, s);
      if (lastFiredAt[id]) continue;        // already fired for this playbook

      // ALL CONDITIONS MET → fire toast + email
      lastFiredAt[id] = new Date().toISOString();
      saveAlertsState();
      const sideClass = (s.action || '').toLowerCase();
      showToast(`🎯 ${s.name} · ${s.action} · TODAS las condiciones cumplidas @ $${snapshot.mid.toFixed(2)}`, sideClass);
      sendTriggerAlert(s, playbook, snapshot.mid, result).then(ok => {
        if (ok && emailEl && savedEmail) {
          const statusEl = document.getElementById('pb-status');
          if (statusEl) statusEl.textContent = '📧 ' + new Date().toLocaleTimeString();
        }
      });
      renderFiredBadges();
    }
  }

  /* ─── Live ✓/✗ per condition inside the scenario card ─── */
  function updateScenarioConditionsUI(scenarioIdx, result) {
    const cards = bodyEl ? bodyEl.querySelectorAll('.pb-scenario') : [];
    const card = cards[scenarioIdx];
    if (!card) return;
    let host = card.querySelector('.pb-conditions');
    if (!host) {
      host = document.createElement('div');
      host.className = 'pb-conditions';
      // Insert right after the trigger element.
      const trigger = card.querySelector('.pb-scen-trigger');
      if (trigger && trigger.parentNode) trigger.parentNode.insertBefore(host, trigger.nextSibling);
      else card.appendChild(host);
    }
    if (!result || !result.results || result.results.length === 0) {
      host.innerHTML = '';
      return;
    }
    const headerCls = result.all_passed ? 'pb-cond-header pass' : 'pb-cond-header';
    const headerTxt = result.all_passed
      ? '✅ TODAS las condiciones cumplidas — alerta lista'
      : `📋 Checklist (${result.results.filter(r => r.passed).length}/${result.results.length})`;
    let html = '<div class="' + headerCls + '">' + headerTxt + '</div><ul class="pb-cond-list">';
    for (const r of result.results) {
      const icon = r.passed ? '<span class="pb-cond-icon pass">✓</span>' : '<span class="pb-cond-icon">✗</span>';
      html += '<li class="pb-cond-item' + (r.passed ? ' pass' : '') + '">'
            + icon
            + '<span class="pb-cond-label">' + escapeHTML(r.cond.label || r.cond.op) + '</span>'
            + '<span class="pb-cond-observed">obs: ' + escapeHTML(String(r.observed)) + '</span>'
            + '</li>';
    }
    html += '</ul>';
    host.innerHTML = html;
  }

  /* ─── Decorate scenario cards with armed / fired badges ─── */
  function renderFiredBadges() {
    if (!bodyEl) return;
    const playbook = loadPlaybook();
    if (!playbook) return;
    const cards = bodyEl.querySelectorAll('.pb-scenario');
    if (!cards.length) return;
    const scenarios = playbook.parsed.scenarios || [];
    cards.forEach((card, i) => {
      const s = scenarios[i];
      if (!s) return;
      const id = scenarioId(playbook.timestamp, s);
      const fired = !!lastFiredAt[id];
      let badge = card.querySelector('.pb-scen-badge');
      if (!badge) {
        const title = card.querySelector('.pb-scen-title');
        if (title) {
          badge = document.createElement('span');
          badge.className = 'pb-scen-badge';
          title.appendChild(badge);
        }
      }
      if (badge) {
        if (fired) {
          badge.className = 'pb-scen-badge fired';
          badge.textContent = '✅ disparado';
        } else if (armedState) {
          badge.className = 'pb-scen-badge armed';
          badge.textContent = '🔔 armado';
        } else {
          badge.className = 'pb-scen-badge';
          badge.textContent = '';
        }
      }
    });
  }

  /* ─── Wire events ─── */
  if (armedChk) {
    armedChk.addEventListener('change', () => {
      armedState = !!armedChk.checked;
      // When the user just armed the alerts, reset the "fired" set so old
      // scenarios from a stale playbook can re-fire on the next tick.
      if (armedState) lastFiredAt = {};
      saveAlertsState();
      renderFiredBadges();
    });
  }
  if (emailEl) {
    emailEl.addEventListener('input', () => {
      savedEmail = emailEl.value.trim();
      saveAlertsState();
    });
  }

  // Reset fired set whenever a new playbook is generated (storage event).
  window.addEventListener('storage', (e) => {
    if (e.key === PLAYBOOK_KEY) {
      lastFiredAt = {};
      saveAlertsState();
      renderFiredBadges();
    }
  });

  /* ─── Boot ─── */
  loadAlertsState();
  const initialPlaybook = loadPlaybook();
  if (initialPlaybook) renderChart(initialPlaybook, null);
  setInterval(checkTriggers, POLL_MS);
  // Also render badges shortly after boot — the playbook render happens
  // synchronously in setupPricePlaybook's loadLast(), which may run after us.
  setTimeout(renderFiredBadges, 300);
  // Re-render badges every time the playbook body is updated (mutation observer).
  if (bodyEl) {
    new MutationObserver(() => renderFiredBadges()).observe(bodyEl, { childList: true });
  }
})();

// ════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
//
// Goal: every main action is reachable from the keyboard, and every
// button advertises its combo as a <kbd> badge (rendered in CSS via
// data-kbd → ::after / ::before).
//
// Two tiers, per the "mixed" model:
//   • global:true  → the combo is registered system-wide in main.js and
//                    works even when Phantom is NOT focused. Here we only
//                    paint the badge; the key itself is delivered straight
//                    to the main process by the OS.
//   • otherwise    → handled in-app below (active while Phantom is focused).
//                    We call the real button's .click() so every existing
//                    side-effect (panels opening, state syncing, pulsing)
//                    runs exactly like a manual click.
//   • displayOnly  → the key is owned by another handler (Enter sends the
//                    chat, Escape cancels/closes) — badge only, no wiring.
// ════════════════════════════════════════════════════════════════
(function setupKeyboardShortcuts() {
  // KeyboardEvent.code keeps matching layout- and Shift-proof.
  const SHORTCUTS = [
    // ── Header (icon buttons: corner chip shows the letter) ──────────
    { id: 'btn-open-translator', code: 'KeyL', meta: 1, shift: 1, badge: '⌘⇧L', icon: 'L' },
    { id: 'btn-watcher', code: 'KeyW', meta: 1, shift: 1, badge: '⌘⇧W', icon: 'W' },
    { id: 'opacity',     code: 'KeyO', meta: 1, shift: 1, badge: '⌘⇧O', icon: 'O', global: 1 },
    { id: 'settings',    code: 'KeyS', meta: 1, shift: 1, badge: '⌘⇧S', icon: 'S' },
    { id: 'hide',        code: 'KeyH', meta: 1, shift: 1, badge: '⌘⇧H', icon: 'H', global: 1 },
    { id: 'close',       code: 'KeyX', meta: 1, shift: 1, badge: '⌘⇧X', icon: 'X' },

    // ── Main action row ──────────────────────────────────────────────
    { id: 'btn-read',          code: 'KeyR', meta: 1, shift: 1, badge: '⌘⇧R', global: 1 },
    { id: 'btn-answer',        code: 'KeyA', meta: 1, shift: 1, badge: '⌘⇧A', global: 1 },
    { id: 'btn-voice-ask',     code: 'KeyV', meta: 1, shift: 1, badge: '⌘⇧V' },
    { id: 'btn-challenge',     code: 'KeyE', meta: 1, shift: 1, badge: '⌘⇧E' },
    { id: 'btn-autoscreen',    code: 'KeyF', meta: 1, shift: 1, badge: '⌘⇧F' },
    { id: 'btn-cheatsheet',    code: 'KeyC', meta: 1, shift: 1, badge: '⌘⇧C' },
    { id: 'btn-multi-capture', code: 'KeyM', meta: 1, shift: 1, badge: '⌘⇧M', global: 1 },

    // ── Chat ─────────────────────────────────────────────────────────
    { id: 'btn-clear', code: 'KeyN',  meta: 1, shift: 1, badge: '⌘⇧N' },
    { id: 'btn-mic',   code: 'KeyJ',  meta: 1, shift: 1, badge: '⌘⇧J' },
    { id: 'btn-send',  code: 'Enter', displayOnly: 1, badge: '↵' },

    // ── Multi-capture panel ──────────────────────────────────────────
    { id: 'btn-mc-add',    code: 'KeyM',  meta: 1, shift: 1, badge: '⌘⇧M', global: 1 },
    { id: 'btn-mc-send',   code: 'Enter', meta: 1, shift: 1, badge: '⌘⇧↵' },
    { id: 'btn-mc-cancel', code: 'Escape', displayOnly: 1, badge: 'esc' },

    // ── Interview panel ──────────────────────────────────────────────
    { id: 'btn-teleprompter',         code: 'KeyK', meta: 1, shift: 1, badge: '⌘⇧K' },
    { id: 'btn-interview-toggle',     code: 'KeyI', meta: 1, shift: 1, badge: '⌘⇧I', global: 1 },
    { id: 'btn-manual-record',        code: 'KeyG', meta: 1, shift: 1, badge: '⌘⇧G', global: 1 },
    { id: 'btn-interview-regenerate', code: 'KeyZ', meta: 1, shift: 1, badge: '⌘⇧Z' },
    { id: 'btn-manual-discard',       code: 'KeyD', meta: 1, shift: 1, badge: '⌘⇧D' },
    { id: 'btn-manual-answer',        code: 'KeyB', meta: 1, shift: 1, badge: '⌘⇧B' },

    // ── Translate panel ──────────────────────────────────────────────
    { id: 'btn-translate-toggle', code: 'KeyT', meta: 1, shift: 1, badge: '⌘⇧T' },

    // ── Trading panel (top controls) ─────────────────────────────────
    { id: 'btn-trading-playbook', code: 'KeyP', meta: 1, shift: 1, badge: '⌘⇧P' },
    { id: 'btn-trading-popout',   code: 'KeyU', meta: 1, shift: 1, badge: '⌘⇧U' },
    { id: 'btn-trading-analyze',  code: 'KeyY', meta: 1, shift: 1, badge: '⌘⇧Y' },
  ];

  const isVisible = (el) => !!(el && el.offsetParent !== null);

  // ── Paint the badges (data-kbd → CSS pseudo-element) ─────────────
  function paintBadges() {
    for (const s of SHORTCUTS) {
      const el = document.getElementById(s.id);
      if (!el) continue;
      // Icon buttons show only the key letter in the corner chip; text
      // buttons show the full combo inline.
      el.setAttribute('data-kbd', s.icon ? s.icon : s.badge);
    }
  }

  // Header icon buttons carry the full combo in their hover tooltip
  // (data-tip). i18n rewrites data-tip on every language switch, so we
  // re-append after each applyTranslations() run (wrapped below).
  function decorateTooltips() {
    for (const s of SHORTCUTS) {
      if (!s.icon) continue;
      const el = document.getElementById(s.id);
      if (!el) continue;
      const base = (el.getAttribute('data-tip') || '').replace(/\s*·\s*[⌘⇧⌥][^·]*$/, '').trim();
      el.setAttribute('data-tip', (base ? base + ' · ' : '') + s.badge);
    }
  }

  // ── In-app combo handler ─────────────────────────────────────────
  function onKey(e) {
    // Never hijack keys while typing in a field — keep native editing
    // (redo, paste-and-match, newline) intact.
    const tgt = e.target;
    if (tgt && (tgt.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName || ''))) return;

    for (const s of SHORTCUTS) {
      if (s.global || s.displayOnly) continue;   // handled elsewhere
      if (e.code !== s.code) continue;
      if (!!s.meta !== e.metaKey) continue;
      if (!!s.shift !== e.shiftKey) continue;
      if (e.altKey || e.ctrlKey) continue;
      const el = document.getElementById(s.id);
      if (!isVisible(el)) continue;              // don't fire hidden actions
      e.preventDefault();
      el.click();
      return;
    }
  }

  // Escape → cancel multi-capture when that panel is open. (The cheat-sheet
  // and watcher-mode already have their own Escape handlers.)
  function onEscape(e) {
    if (e.key !== 'Escape') return;
    const panel = document.getElementById('multi-capture-panel');
    const cancel = document.getElementById('btn-mc-cancel');
    if (panel && panel.style.display !== 'none' && isVisible(cancel)) {
      e.preventDefault();
      cancel.click();
    }
  }

  paintBadges();
  decorateTooltips();
  document.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onEscape);

  // Keep tooltips correct across language switches. applyTranslations is a
  // classic-script global (i18n.js); wrapping the global binding also
  // updates the reference setLanguage() calls internally.
  if (typeof applyTranslations === 'function') {
    const _applyTranslations = applyTranslations;
    // eslint-disable-next-line no-global-assign
    applyTranslations = function () { _applyTranslations.apply(this, arguments); decorateTooltips(); };
  }
})();

// ════════════════════════════════════════════════════════════════
// TELEPROMPTER — capa manos libres sobre el modo entrevista.
//
// Al abrirlo arranca (si hace falta) el modo entrevista Auto, que ya
// escucha el audio del sistema, detecta preguntas y genera respuestas
// sin intervención. Este módulo solo se suscribe a los eventos
// 'phantom:interview' y presenta todo en una vista de lectura:
//   • texto grande de alto contraste
//   • auto-scroll a velocidad de lectura (palabras por minuto)
//   • espacio pausa/reanuda, ↑/↓ ajustan velocidad, esc sale
// ════════════════════════════════════════════════════════════════
(function setupTeleprompter() {
  const overlay  = document.getElementById('teleprompter');
  if (!overlay) return;
  const btnOpen  = document.getElementById('btn-teleprompter');
  const btnClose = document.getElementById('tp-close');
  const statusEl = document.getElementById('tp-status');
  const questionEl = document.getElementById('tp-question');
  const scrollEl = document.getElementById('tp-scroll');
  const textEl   = document.getElementById('tp-text');
  const wpmEl    = document.getElementById('tp-wpm');
  const autoEl   = document.getElementById('tp-auto');

  const WPM_KEY = 'phantom_tp_wpm';
  const CUE_KEY = 'phantom_tp_cue';
  const tp = {
    open: false,
    paused: false,
    // Modo cue card (default): viñetas cortas para mirar de reojo con cámara
    // encendida. Con 'm' se alterna a respuesta completa para leer de corrido.
    cue: localStorage.getItem(CUE_KEY) !== '0',
    wpm: parseInt(localStorage.getItem(WPM_KEY), 10) || 140,
    raf: null,
    pxPerMs: 0,
    lastTs: 0,
    startDelayUntil: 0,
    scrollPos: 0            // acumulador en float — scrollTop redondea
  };
  tp.wpm = Math.min(400, Math.max(60, tp.wpm));
  wpmEl.textContent = tp.wpm;

  // answerInterviewQuestion lee esta global para pedir el estilo del momento.
  function syncTpStyle() {
    window.__phantomTpStyle = tp.open && tp.cue ? 'cue' : undefined;
    textEl.classList.toggle('cue', tp.open && tp.cue);
  }

  /** Apuntes ↔ texto completo. Si ya hay una pregunta contestada, la
   *  regenera en el estilo nuevo al toque. Expuesta en window porque el
   *  atajo global (⌘⇧U) la llama desde afuera del módulo: la ventana ya no
   *  toma el foco, así que la tecla 'm' pelada sólo funciona si clickeaste
   *  Phantom antes — y clickearlo es exactamente lo que evitamos. */
  function toggleStyle() {
    tp.cue = !tp.cue;
    localStorage.setItem(CUE_KEY, tp.cue ? '1' : '0');
    syncTpStyle();
    setTpStatus(tp.cue ? '● modo apuntes (cue)' : '● modo lectura completa', 'thinking');
    if (typeof interview !== 'undefined' && interview.lastQuestion) {
      answerInterviewQuestion(interview.lastQuestion);
    }
  }
  window.__phantomTpToggleStyle = toggleStyle;

  function setTpStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'tp-status' + (cls ? ' ' + cls : '');
  }

  // ── Auto-scroll a ritmo de lectura ─────────────────────────────
  // La velocidad sale de: (alto scrolleable) / (palabras / ppm).
  // Así el final del texto llega justo cuando terminarías de leerlo.
  function computeSpeed() {
    const distance = scrollEl.scrollHeight - scrollEl.clientHeight;
    const words = (textEl.textContent.trim().match(/\S+/g) || []).length;
    if (distance <= 0 || words === 0) { tp.pxPerMs = 0; return; }
    const durationMs = (words / tp.wpm) * 60000;
    tp.pxPerMs = distance / durationMs;
  }

  function tick(ts) {
    if (!tp.open) return;
    if (!tp.lastTs) tp.lastTs = ts;
    const dt = ts - tp.lastTs;
    tp.lastTs = ts;
    if (!tp.paused && tp.pxPerMs > 0 && ts > tp.startDelayUntil) {
      tp.scrollPos = Math.min(tp.scrollPos + tp.pxPerMs * dt, scrollEl.scrollHeight - scrollEl.clientHeight);
      scrollEl.scrollTop = tp.scrollPos;
    }
    tp.raf = requestAnimationFrame(tick);
  }

  function startScrolling() {
    tp.scrollPos = 0;
    scrollEl.scrollTop = 0;
    computeSpeed();
    // Colchón inicial: ~1.2s para que empieces a leer antes de que avance
    tp.startDelayUntil = performance.now() + 1200;
  }

  // ── Presentación de estados del ciclo de entrevista ────────────
  function showPending(msg) {
    textEl.classList.add('pending');
    textEl.textContent = msg;
    tp.pxPerMs = 0;
  }

  document.addEventListener('phantom:interview', (e) => {
    if (!tp.open) return;
    const d = e.detail;
    if (d.kind === 'start') {
      setTpStatus('● escuchando…', 'live');
    } else if (d.kind === 'hearing') {
      setTpStatus('● escuchando…', 'live');
      questionEl.textContent = '🎙️ ' + d.text.slice(-160);
    } else if (d.kind === 'question') {
      setTpStatus('● pensando…', 'thinking');
      questionEl.textContent = d.question;
      showPending('Preparando tu respuesta…');
    } else if (d.kind === 'answer') {
      setTpStatus('● leé — sigo escuchando', 'live');
      textEl.classList.remove('pending');
      textEl.textContent = d.answer;
      tp.paused = false;
      overlay.classList.remove('paused');
      startScrolling();
    } else if (d.kind === 'error') {
      setTpStatus('● error', 'err');
      showPending('⚠ ' + d.message);
    } else if (d.kind === 'stop') {
      setTpStatus('● detenido', '');
    }
  });

  // ── Abrir / cerrar ─────────────────────────────────────────────
  async function openTeleprompter() {
    tp.open = true;
    tp.paused = false;
    syncTpStyle();
    overlay.style.display = 'flex';
    overlay.classList.remove('paused');
    questionEl.textContent = 'Esperando la primera pregunta…';
    showPending('Cuando la otra persona pregunte algo, la respuesta aparece acá sola.');
    try { await phantom.window.resize({ width: 760, height: 900 }); } catch {}

    if (typeof interview !== 'undefined' && !interview.active) {
      // Reusar el click del botón real para heredar TODAS las validaciones
      // (keys, CV cargado) y efectos de UI del modo Auto.
      const b = document.getElementById('btn-interview-toggle');
      if (b) b.click();
      setTpStatus('● iniciando escucha…', 'thinking');
    } else {
      setTpStatus('● escuchando…', 'live');
    }
    tp.lastTs = 0;
    tp.raf = requestAnimationFrame(tick);
  }

  function closeTeleprompter() {
    tp.open = false;
    syncTpStyle();
    overlay.style.display = 'none';
    if (tp.raf) { cancelAnimationFrame(tp.raf); tp.raf = null; }
    // La escucha sigue activa a propósito: el panel entrevista clásico
    // queda funcionando. Se corta desde su botón "Detener" (⌘⇧I).
    try { phantom.window.resize({ width: 640, height: 780 }); } catch {}
  }

  btnOpen.addEventListener('click', () => (tp.open ? closeTeleprompter() : openTeleprompter()));
  btnClose.addEventListener('click', closeTeleprompter);

  // ── Scroll manual con la rueda / trackpad ──────────────────────
  // El auto-scroll pisa scrollTop en cada frame, así que sin esto la rueda
  // no hace nada: scrolleás y el RAF te devuelve al instante. Cuando el
  // usuario scrollea, el control pasa a ser suyo — se pausa el avance y se
  // sincroniza la posición para que al reanudar siga desde donde quedó.
  scrollEl.addEventListener('wheel', () => {
    if (!tp.open) return;
    tp.scrollPos = scrollEl.scrollTop;
    if (!tp.paused) {
      tp.paused = true;
      overlay.classList.add('paused');
      setTpStatus('⏸ scroll manual — espacio para reanudar', 'thinking');
    }
  }, { passive: true });

  // Mientras está pausado, seguir el scroll del usuario (teclas de flecha del
  // navegador, arrastre, etc.) para no saltar al reanudar.
  scrollEl.addEventListener('scroll', () => {
    if (tp.open && tp.paused) tp.scrollPos = scrollEl.scrollTop;
  }, { passive: true });

  // ── Teclas del modo lectura (solo con el overlay visible) ──────
  document.addEventListener('keydown', (e) => {
    if (!tp.open) return;
    const tgt = e.target;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName || '')) return;

    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      // Contestar YA con todo lo escuchado hasta este momento. Es el control
      // manual: vos decidís cuándo terminó de hablar, no el detector.
      e.preventDefault();
      e.stopPropagation();
      if (typeof interview !== 'undefined' && interview.active) {
        if (interview.buffer.trim().length >= 3) {
          setTpStatus('● pensando…', 'thinking');
          answerNow();
        } else {
          setTpStatus('● nada nuevo escuchado todavía', '');
        }
      }
    } else if (e.code === 'KeyA' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Auto ↔ manual. En manual no contesta solo: sólo con Enter.
      e.preventDefault();
      e.stopPropagation();
      if (typeof interview !== 'undefined') {
        interview.autoAnswer = !interview.autoAnswer;
        autoEl.textContent = interview.autoAnswer ? 'auto' : 'manual';
        setTpStatus(
          interview.autoAnswer
            ? '● auto — contesta tras el silencio'
            : '● manual — contesta sólo con Enter',
          'thinking'
        );
      }
    } else if (e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      tp.paused = !tp.paused;
      overlay.classList.toggle('paused', tp.paused);
      if (tp.paused) setTpStatus('⏸ pausado — espacio para seguir', 'thinking');
      else setTpStatus('● leé — sigo escuchando', 'live');
    } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      tp.wpm = Math.min(400, Math.max(60, tp.wpm + (e.code === 'ArrowUp' ? 10 : -10)));
      localStorage.setItem(WPM_KEY, String(tp.wpm));
      wpmEl.textContent = tp.wpm;
      computeSpeed();
    } else if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleStyle();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeTeleprompter();
    }
  }, true);  // capture: gana antes que los Escape de otros paneles
})();

// ════════════════════════════════════════════════════════════════
// TRADUCTOR EN VIVO — vista propia (?view=translator)
//
// Usa gpt-realtime-translate: el modelo traduce mientras la persona
// habla. El pipeline viejo (Deepgram → texto → llamada de traducción)
// no podía mostrar nada hasta que la frase cerraba, porque traducir a
// mitad de oración con un modelo de texto da resultados incoherentes.
// Acá el texto llega por deltas, así que aparece a medida que hablan.
//
// El audio va a 24 kHz PCM16, que es lo que el modelo espera. El
// silencio entre frases también se manda: es lo que le marca dónde
// termina una idea.
// ════════════════════════════════════════════════════════════════
(function setupTranslatorView() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') !== 'translator') return;

  document.body.classList.add('translator-view');
  const view = document.getElementById('xlate-view');
  if (!view) return;
  view.style.display = 'flex';

  const statusEl = document.getElementById('xl-status');
  const langEl   = document.getElementById('xl-lang');
  const btnTgl   = document.getElementById('xl-toggle');
  const btnClose = document.getElementById('xl-close');
  const bodyEl   = document.getElementById('xl-body');
  const emptyEl  = document.getElementById('xl-empty');
  const linesEl  = document.getElementById('xl-lines');
  const srcBar   = document.getElementById('xl-source-bar');

  const SAMPLE_RATE = 24000;
  const xl = {
    active: false,
    stream: null,
    audioCtx: null,
    processor: null,
    sourceNode: null,
    currentLine: null,   // <div> de la frase que se está traduciendo
    srcBuffer: ''
  };

  function setXlStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'xl-status' + (cls ? ' ' + cls : '');
  }

  // ── Render de deltas ──────────────────────────────────────────
  function appendTranslated(delta) {
    if (emptyEl) emptyEl.style.display = 'none';
    if (!xl.currentLine) {
      // Marcar la anterior como pasada antes de abrir la nueva.
      const prev = linesEl.lastElementChild;
      if (prev) prev.classList.remove('current');
      xl.currentLine = document.createElement('div');
      xl.currentLine.className = 'xl-line current';
      linesEl.appendChild(xl.currentLine);
    }
    xl.currentLine.textContent += delta;
    // Seguir el final del texto: lo último dicho siempre a la vista.
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function closeLine() {
    xl.currentLine = null;   // el próximo delta abre una frase nueva
  }

  phantom.on('xlate:text', appendTranslated);
  phantom.on('xlate:text-done', closeLine);

  phantom.on('xlate:source', (delta) => {
    xl.srcBuffer = (xl.srcBuffer + delta).slice(-300);
    srcBar.textContent = xl.srcBuffer;
  });
  phantom.on('xlate:source-done', () => { xl.srcBuffer = ''; });

  phantom.on('xlate:error', (msg) => {
    setXlStatus('● ' + msg, 'err');
  });

  // ── Captura de audio ──────────────────────────────────────────
  async function start() {
    try {
      setXlStatus('● conectando…', '');
      const cfg = await phantom.config.get();
      const to = cfg.translateTo || 'es';
      const from = (cfg.translateFrom || 'auto').toUpperCase();
      langEl.textContent = `${from === 'AUTO' ? 'AUTO' : from} → ${to.toUpperCase()}`;

      xl.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1 },
        audio: true
      });
      xl.stream.getVideoTracks().forEach((t) => t.stop());
      if (xl.stream.getAudioTracks().length === 0) {
        throw new Error('No se obtuvo audio del sistema. ¿Aceptaste compartir audio?');
      }

      await phantom.xlate.start({ to });

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      xl.audioCtx = audioCtx;
      const source = audioCtx.createMediaStreamSource(
        new MediaStream(xl.stream.getAudioTracks())
      );
      xl.sourceNode = source;

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      xl.processor = processor;
      processor.onaudioprocess = (ev) => {
        if (!xl.active) return;
        const float32 = ev.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        phantom.xlate.sendAudio(arrayBufferToBase64(int16.buffer));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);

      xl.active = true;
      btnTgl.textContent = 'Detener';
      btnTgl.classList.add('active');
      setXlStatus('● traduciendo en vivo', 'live');
    } catch (err) {
      console.error('translator start:', err);
      setXlStatus('● ' + err.message, 'err');
      await stop();
    }
  }

  async function stop() {
    xl.active = false;
    btnTgl.textContent = 'Iniciar';
    btnTgl.classList.remove('active');

    if (xl.processor) { try { xl.processor.disconnect(); } catch {} xl.processor = null; }
    if (xl.sourceNode) { try { xl.sourceNode.disconnect(); } catch {} xl.sourceNode = null; }
    if (xl.audioCtx) { try { await xl.audioCtx.close(); } catch {} xl.audioCtx = null; }
    if (xl.stream) { xl.stream.getTracks().forEach((t) => t.stop()); xl.stream = null; }

    try { await phantom.xlate.stop(); } catch {}
    closeLine();
    setXlStatus('● detenido', '');
  }

  btnTgl.addEventListener('click', () => (xl.active ? stop() : start()));
  btnClose.addEventListener('click', async () => {
    await stop();
    phantom.window.closeTranslator();
  });

  // Limpiar el stream si cierran la ventana desde el sistema.
  window.addEventListener('beforeunload', () => { if (xl.active) stop(); });
})();

// ════════════════════════════════════════════════════════════════
// AUTO-PANTALLA — mira la pantalla sola y contesta lo que aparece
//
// El problema real acá no es capturar, es NO gastar: mandar cada
// captura al modelo serían decenas de miles de tokens por minuto.
// Por eso el ciclo compara localmente (gratis) y sólo llama a la API
// cuando la pantalla cambió de verdad:
//
//   capturar → huella 16x16 en gris → comparar con la anterior
//     ├─ igual        → no hace nada (costo cero)
//     └─ cambió       → espera un tick a que se estabilice
//                       (evita disparar a mitad de scroll o de carga)
//                       → recién ahí contesta
//
// Si el teleprompter está abierto, la respuesta sale ahí en grande:
// se cuelga del mismo bus de eventos que el modo entrevista, así que
// el teleprompter no necesita saber de dónde vino.
// ════════════════════════════════════════════════════════════════
(function setupScreenWatcher() {
  const btn = document.getElementById('btn-autoscreen');
  if (!btn) return;

  const GRID = 16;              // huella de 16x16 celdas
  const watch = {
    active: false,
    timer: null,
    busy: false,
    INTERVAL_MS: 2500,
    DIFF_THRESHOLD: 0.06,       // 6% de celdas distintas = cambió la pantalla
    CELL_DELTA: 18,             // diferencia de luma para contar una celda
    lastPrint: null,            // última pantalla ya contestada
    pendingPrint: null,         // cambio detectado, esperando que se estabilice
    answers: 0
  };

  // Canvas reutilizado — crear uno por captura genera basura innecesaria
  // cuando el ciclo corre cada 2.5s durante una hora.
  const canvas = document.createElement('canvas');
  canvas.width = GRID;
  canvas.height = GRID;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /** Reduce la captura a 256 valores de gris. Es la comparación más barata
   *  que distingue "cambió la página" de "se movió el cursor". */
  function fingerprint(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, GRID, GRID);
        const { data } = ctx.getImageData(0, 0, GRID, GRID);
        const gray = new Uint8Array(GRID * GRID);
        for (let i = 0; i < gray.length; i++) {
          const p = i * 4;
          // Luma perceptual: el ojo pesa mucho más el verde que el azul.
          gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
        }
        resolve(gray);
      };
      img.onerror = () => reject(new Error('no se pudo leer la captura'));
      img.src = dataUrl;
    });
  }

  /** Proporción de celdas que cambiaron entre dos huellas. */
  function diff(a, b) {
    if (!a || !b) return 1;
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > watch.CELL_DELTA) changed++;
    }
    return changed / a.length;
  }

  function setWatchStatus(text, kind) {
    setStatus(text, kind);
    btn.textContent = watch.active ? `👁 Mirando (${watch.answers})` : '👁 Auto-pantalla';
  }

  const WATCH_PROMPT =
    'Answer what is on screen right now.';

  // Prompt propio en vez del de challenge: aquél fuerza seis secciones con
  // encabezados, que para un multiple choice es absurdo y lento. Acá lo que
  // importa es que la respuesta entre de un vistazo.
  const WATCH_SYSTEM = `You are looking at the user's screen during a live test or interview. Answer whatever is on it — a multiple-choice question, an exercise, a form, an error message.

Rules:
- LEAD WITH THE ANSWER. For multiple choice: the option itself, first line, bold. Then one short line of why.
- Show the arithmetic when there is any: "six times sixteen = ninety-six".
- For a coding or SQL exercise: the working solution, then one line on the approach.
- Never describe the page and never give click-by-click instructions. The user can see the screen; they need the answer.
- Be brief. The user is reading this while someone watches them.
- If the screen genuinely asks nothing (a desktop, an editor with no task, a settings page), reply with exactly: (nada que contestar)

${SECURITY_RULE}`;

  async function answerScreen(screenshot) {
    watch.busy = true;
    interviewEmit('question', { question: '👁 Pantalla nueva detectada' });
    setWatchStatus('👁 Analizando la pantalla…', 'busy');

    try {
      const messages = [{ role: 'user', content: await buildContent(WATCH_PROMPT, screenshot) }];
      const resp = await phantom.ai.call({ messages, system: WATCH_SYSTEM });
      const reply = (resp.text || '').trim();

      // El modelo avisa cuando la pantalla no pregunta nada: sin esto, cada
      // cambio de ventana produciría un párrafo describiendo el escritorio.
      if (/^\(?nada que contestar\)?$/i.test(reply)) {
        setWatchStatus('👁 Mirando… (sin nada que contestar)', 'ok');
        return;
      }

      watch.answers++;
      conversationEl.innerHTML = '';
      addMessage('user', '👁 Pantalla detectada');
      const el = addMessage('assistant', '', true);
      el.classList.remove('loading');
      el.innerHTML = renderMarkdown(reply);
      chatWrap.style.display = 'flex';
      state.messages = [
        { role: 'user', content: WATCH_PROMPT },
        { role: 'assistant', content: reply }
      ];

      interviewEmit('answer', { question: 'Pantalla', answer: reply });
      setWatchStatus('👁 Mirando…', 'ok');
    } catch (err) {
      interviewEmit('error', { message: err.message });
      setWatchStatus('⚠ ' + err.message, 'err');
    } finally {
      watch.busy = false;
    }
  }

  async function tick() {
    // No competir con una acción manual ni con una respuesta en curso.
    if (!watch.active || watch.busy || state.busy) return;

    let print, shot;
    try {
      shot = await captureScreen();
      if (!shot) return;
      print = await fingerprint(shot);
    } catch (err) {
      // A la barra de estado: un console.warn acá es invisible para el
      // usuario y el modo parece colgado ("mirando" para siempre).
      console.warn('watcher capture:', err.message);
      setWatchStatus('⚠ captura: ' + err.message, 'err');
      return;
    }

    // Primera captura tras activar: contestar de una, es lo que el usuario
    // está mirando en este momento.
    if (!watch.lastPrint) {
      watch.lastPrint = print;
      await answerScreen(shot);
      return;
    }

    if (diff(print, watch.lastPrint) <= watch.DIFF_THRESHOLD) {
      watch.pendingPrint = null;   // pantalla quieta
      return;
    }

    // Cambió. Esperar a que se estabilice: durante un scroll o una carga cada
    // captura difiere de la anterior, y contestar ahí daría media pregunta.
    if (watch.pendingPrint && diff(print, watch.pendingPrint) <= watch.DIFF_THRESHOLD) {
      watch.lastPrint = print;
      watch.pendingPrint = null;
      await answerScreen(shot);
    } else {
      watch.pendingPrint = print;
      setWatchStatus('👁 Cambio detectado, esperando…', 'busy');
    }
  }

  function start() {
    watch.active = true;
    watch.lastPrint = null;
    watch.pendingPrint = null;
    watch.answers = 0;
    btn.classList.add('active');
    setWatchStatus('👁 Mirando la pantalla…', 'ok');
    watch.timer = setInterval(tick, watch.INTERVAL_MS);
    tick();
  }

  function stop() {
    watch.active = false;
    if (watch.timer) { clearInterval(watch.timer); watch.timer = null; }
    btn.classList.remove('active');
    setWatchStatus(`👁 Auto-pantalla detenida (${watch.answers} respuestas)`, '');
  }

  btn.addEventListener('click', () => (watch.active ? stop() : start()));
})();

// ─── Atajos globales de las acciones nuevas ──────────────────────
// La ventana ya no toma el foco (para no delatar el cambio de ventana en
// una entrevista con proctoring), así que estos llegan por IPC desde el
// main en vez de por keydown. Se resuelven clickeando el botón real para
// heredar todas las validaciones y efectos de UI.
(function setupGlobalActionShortcuts() {
  const clickById = (id) => {
    const b = document.getElementById(id);
    if (b) b.click();
  };

  phantom.on('shortcut:teleprompter', () => clickById('btn-teleprompter'));
  phantom.on('shortcut:challenge',    () => clickById('btn-challenge'));
  phantom.on('shortcut:autoscreen',   () => clickById('btn-autoscreen'));
  phantom.on('shortcut:translator',   () => clickById('btn-open-translator'));

  // Contestar ya con lo escuchado: sólo tiene sentido con la escucha activa.
  phantom.on('shortcut:answer-now', () => {
    if (typeof interview !== 'undefined' && interview.active &&
        interview.buffer.trim().length >= 3) {
      answerNow();
    }
  });

  // Apuntes ↔ texto completo: el teleprompter expone el toggle en una global
  // para no depender de que la ventana esté enfocada.
  phantom.on('shortcut:toggle-style', () => {
    if (typeof window.__phantomTpToggleStyle === 'function') {
      window.__phantomTpToggleStyle();
    }
  });
})();
