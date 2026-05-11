/**
 * landing.js
 *   - Cambio de idioma con persistencia en localStorage
 *   - Auto-detect del idioma del browser
 *   - Highlight de flechas al hacer hover en feature labels
 */

const LANG_SELECT = document.getElementById('lang-select');

function detectLang() {
  const stored = localStorage.getItem('phantom_landing_lang');
  if (stored && LANDING_TR[stored]) return stored;
  const browser = (navigator.language || 'es').toLowerCase().split('-')[0];
  return LANDING_TR[browser] ? browser : 'es';
}

function applyLang(lang) {
  if (!LANDING_TR[lang]) lang = 'es';
  const dict = LANDING_TR[lang];
  document.documentElement.lang = lang;
  localStorage.setItem('phantom_landing_lang', lang);

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.dataset.i18n;
    if (dict[k]) el.textContent = dict[k];
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const k = el.dataset.i18nHtml;
    if (dict[k]) el.innerHTML = dict[k];
  });
}

const initLang = detectLang();
LANG_SELECT.value = initLang;
applyLang(initLang);
LANG_SELECT.addEventListener('change', e => applyLang(e.target.value));

// ─── Highlight arrows on hover ─────────────────
function highlightArrow(feat, on) {
  const g = document.querySelector(`.arrow-g[data-target="${feat}"]`);
  if (g) g.classList.toggle('highlight', on);
}

document.querySelectorAll('.feat').forEach(el => {
  const f = el.dataset.feat;
  el.addEventListener('mouseenter', () => highlightArrow(f, true));
  el.addEventListener('mouseleave', () => highlightArrow(f, false));
});
