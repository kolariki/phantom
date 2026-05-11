/**
 * landing.js — Lógica de la landing
 *   - Cambio de idioma con persistencia en localStorage
 *   - Auto-detect del idioma del browser
 *   - Highlight de flechas al hacer hover en mockup o feature labels
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

// ─── Highlight de flechas al pasar mouse ───────────────────────
function highlightArrow(feature, on) {
  const arrow = document.querySelector(`.arrow[data-target="${feature}"]`);
  if (arrow) arrow.classList.toggle('highlight', on);

  const label = document.querySelector(`.feature-label[data-anchor="${feature}"]`);
  if (label) {
    label.style.transform = on ? 'translateY(-4px)' : '';
    label.style.boxShadow = on ? '0 16px 36px rgba(15, 23, 42, 0.18)' : '';
  }

  const mockEl = document.querySelector(`.phantom-mock [data-feature="${feature}"]`);
  if (mockEl) {
    mockEl.style.outline = on ? '2px solid #3b82f6' : '';
    mockEl.style.outlineOffset = on ? '3px' : '';
  }
}

// Hover en feature labels
document.querySelectorAll('.feature-label').forEach(label => {
  const f = label.dataset.anchor;
  label.addEventListener('mouseenter', () => highlightArrow(f, true));
  label.addEventListener('mouseleave', () => highlightArrow(f, false));
});

// Hover en elementos del mockup
document.querySelectorAll('.phantom-mock [data-feature]').forEach(el => {
  const f = el.dataset.feature;
  el.style.cursor = 'pointer';
  el.addEventListener('mouseenter', () => highlightArrow(f, true));
  el.addEventListener('mouseleave', () => highlightArrow(f, false));
});

// Hover en flechas
document.querySelectorAll('.arrow').forEach(arrow => {
  const f = arrow.dataset.target;
  arrow.addEventListener('mouseenter', () => highlightArrow(f, true));
  arrow.addEventListener('mouseleave', () => highlightArrow(f, false));
});
