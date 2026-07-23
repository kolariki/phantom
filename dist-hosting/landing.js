/**
 * landing.js
 *   - Cambio de idioma con persistencia
 *   - Spotlight: al pasar el mouse sobre una feature, destaca la zona correspondiente
 *     en el screenshot (con un agujero brillante sobre fondo oscurecido)
 *   - Dual-stage: Stage 1 (funcionalidades) + Stage 2 (trading/settings)
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
LANG_SELECT.addEventListener('change', e => {
  applyLang(e.target.value);
  track('language_change', { lang: e.target.value });
});

// ─── Google Analytics: helper de tracking ─────────────────
function track(eventName, params = {}) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}

// Trackear cualquier click al botón de compra (Stripe)
document.querySelectorAll('a[href*="buy.stripe.com"]').forEach(btn => {
  btn.addEventListener('click', () => {
    track('begin_checkout', {
      currency: 'USD',
      value: 9.99,
      items: [{ item_name: 'Phantom Lifetime' }]
    });
  });
});

// Trackear scroll a sección Pricing (intent to buy)
const pricingSection = document.getElementById('pricing');
if (pricingSection && 'IntersectionObserver' in window) {
  let pricingTracked = false;
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !pricingTracked) {
      pricingTracked = true;
      track('view_pricing');
    }
  }, { threshold: 0.5 }).observe(pricingSection);
}

// Trackear primera interacción con feature (hover en cualquier .feat)
let featInteracted = false;
document.querySelectorAll('.feat').forEach(el => {
  el.addEventListener('mouseenter', () => {
    if (!featInteracted) {
      featInteracted = true;
      track('feature_explore');
    }
  });
});

// ─── SPOTLIGHT (Dual-Stage) ─────────────────────────────────
// Cada feature tiene un "box" en porcentajes del screenshot.
// {left, top, width, height} en %.

// Stage 1: screen-funcionalidades.png (494×927)
// Calibrado con grilla de 5% sobre la imagen renderizada
const SPOTS_1 = {
  'read-screen': { left: 3,  top: 7,   width: 45, height: 4  },
  'answer':      { left: 50, top: 7,   width: 47, height: 4  },
  'interview':   { left: 3,  top: 13,  width: 94, height: 5  },
  'record':      { left: 73, top: 13,  width: 24, height: 5  },
  'translate':   { left: 3,  top: 19,  width: 94, height: 5  },
  'trading':     { left: 3,  top: 25,  width: 94, height: 5  },
  'language':    { left: 3,  top: 31,  width: 94, height: 10 },
  'stealth':     { left: 3,  top: 63,  width: 94, height: 4  },
  'opacity':     { left: 3,  top: 66,  width: 94, height: 10 },
  'hotkey':      { left: 75, top: 1,   width: 23, height: 5  }
};

// Stage 2: screen-trading.png (495×929)
// Calibrado con grilla de 5% sobre la imagen renderizada
const SPOTS_2 = {
  'trading-enable':  { left: 3,  top: 6,   width: 94, height: 18 },
  'trading-model':   { left: 3,  top: 13,  width: 94, height: 10 },
  'exchange':        { left: 3,  top: 24,  width: 94, height: 28 },
  'interview-cv':    { left: 3,  top: 53,  width: 94, height: 25 },
  'interview-setup': { left: 3,  top: 78,  width: 94, height: 14 },
  'save-btn':        { left: 3,  top: 93,  width: 94, height: 6  }
};

const wrap1 = document.getElementById('screenshot-wrap-1');
const wrap2 = document.getElementById('screenshot-wrap-2');
const spot1 = document.getElementById('spotlight-1');
const spot2 = document.getElementById('spotlight-2');

function showSpot(feat, stage) {
  const isStage1 = stage === '1';
  const spots = isStage1 ? SPOTS_1 : SPOTS_2;
  const s = spots[feat];
  if (!s) return;
  const sp = isStage1 ? spot1 : spot2;
  const wr = isStage1 ? wrap1 : wrap2;
  sp.style.left   = s.left + '%';
  sp.style.top    = s.top + '%';
  sp.style.width  = s.width + '%';
  sp.style.height = s.height + '%';
  wr.classList.add('active');
}

function hideSpot(stage) {
  const wr = stage === '1' ? wrap1 : wrap2;
  wr.classList.remove('active');
}

document.querySelectorAll('.feat').forEach(el => {
  const f = el.dataset.feat;
  const stage = el.dataset.stage || '1';
  el.addEventListener('mouseenter', () => {
    el.classList.add('active');
    showSpot(f, stage);
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('active');
    hideSpot(stage);
  });
});
