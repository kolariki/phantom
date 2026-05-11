/**
 * landing.js
 *   - Cambio de idioma con persistencia
 *   - Spotlight: al pasar el mouse sobre una feature, destaca la zona correspondiente
 *     en el screenshot (con un agujero brillante sobre fondo oscurecido)
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

  // Usamos innerHTML para TODOS los data-i18n / data-i18n-html.
  // Las traducciones son nuestras y pueden contener <strong>, <br/>, <code>, <em>.
  document.querySelectorAll('[data-i18n], [data-i18n-html]').forEach(el => {
    const k = el.dataset.i18n || el.dataset.i18nHtml;
    if (dict[k]) el.innerHTML = dict[k];
  });
}

const initLang = detectLang();
LANG_SELECT.value = initLang;
applyLang(initLang);
LANG_SELECT.addEventListener('change', e => applyLang(e.target.value));

// ─── SPOTLIGHT ────────────────────────────────────────────
// Cada feature tiene un "box" en porcentajes del screenshot (643x896).
// {left, top, width, height} en %.
const SPOTS = {
  'read-screen': { left: 3,  top: 7,    width: 45, height: 5  },
  'answer':      { left: 51, top: 7,    width: 45, height: 5  },
  'interview':   { left: 3,  top: 13,   width: 94, height: 7  },
  'record':      { left: 80, top: 14,   width: 17, height: 6  },
  'translate':   { left: 3,  top: 21,   width: 94, height: 6  },
  'language':    { left: 3,  top: 29,   width: 94, height: 7  },
  'apikey':      { left: 3,  top: 44,   width: 94, height: 10 },
  'stealth':     { left: 3,  top: 61,   width: 94, height: 5  },
  'opacity':     { left: 3,  top: 66,   width: 95, height: 10 },
  'hotkey':      { left: 80, top: 1,    width: 17, height: 5  }
};

const wrap = document.getElementById('screenshot-wrap');
const spotlight = document.getElementById('spotlight');

function showSpot(feat) {
  const s = SPOTS[feat];
  if (!s) return;
  spotlight.style.left = s.left + '%';
  spotlight.style.top = s.top + '%';
  spotlight.style.width = s.width + '%';
  spotlight.style.height = s.height + '%';
  wrap.classList.add('active');
}
function hideSpot() {
  wrap.classList.remove('active');
}

document.querySelectorAll('.feat').forEach(el => {
  const f = el.dataset.feat;
  el.addEventListener('mouseenter', () => {
    el.classList.add('active');
    showSpot(f);
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('active');
    hideSpot();
  });
});
