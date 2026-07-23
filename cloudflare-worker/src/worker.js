/**
 * Phantom Desktop — Download Protection Worker
 *
 * Validates Stripe checkout session_id, ensures one-time download,
 * and tracks download analytics.
 *
 * Endpoints:
 *   POST /validate   — Validate session & get download URL
 *   GET  /stats      — Download analytics (protected by admin key)
 *   POST /send-alert — Send trading alert email
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env.ALLOWED_ORIGIN, request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/validate' && request.method === 'POST') {
        return await handleValidate(request, env, cors);
      }

      if (url.pathname === '/stats' && request.method === 'GET') {
        return await handleStats(request, env, cors);
      }

      if (url.pathname === '/send-alert' && request.method === 'POST') {
        return await handleSendAlert(request, env, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message }, 500, cors);
    }
  }
};

// ─── Validate Stripe session & return download URL ────────────────
async function handleValidate(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { session_id } = body;

  if (!session_id || !session_id.startsWith('cs_')) {
    return json({ error: 'Invalid session_id' }, 400, cors);
  }

  // 1. Check if this session was already used
  const existing = await env.DOWNLOADS.get(`session:${session_id}`);
  if (existing) {
    const data = JSON.parse(existing);
    return json({
      error: 'already_used',
      message: 'This download link has already been used.',
      used_at: data.used_at
    }, 403, cors);
  }

  // 2. Validate with Stripe API
  const stripeRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${session_id}`,
    {
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      }
    }
  );

  if (!stripeRes.ok) {
    return json({ error: 'Invalid or expired session' }, 403, cors);
  }

  const session = await stripeRes.json();

  // 3. Verify payment was successful
  if (session.payment_status !== 'paid') {
    return json({ error: 'Payment not completed' }, 403, cors);
  }

  // 4. Mark session as used in KV
  const record = {
    session_id,
    customer_email: session.customer_details?.email || 'unknown',
    amount: session.amount_total,
    currency: session.currency,
    used_at: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    country: request.headers.get('CF-IPCountry') || 'unknown',
    user_agent: request.headers.get('User-Agent') || 'unknown'
  };

  // Store session record (expires in 90 days)
  await env.DOWNLOADS.put(
    `session:${session_id}`,
    JSON.stringify(record),
    { expirationTtl: 60 * 60 * 24 * 90 }
  );

  // 5. Increment download counter
  const countStr = await env.DOWNLOADS.get('stats:total_downloads') || '0';
  await env.DOWNLOADS.put('stats:total_downloads', String(parseInt(countStr) + 1));

  // Store in download log for analytics
  const logKey = `log:${Date.now()}_${session_id.slice(-8)}`;
  await env.DOWNLOADS.put(logKey, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 });

  // 6. Return download URL
  return json({
    success: true,
    download_url: env.DMG_URL,
    customer_email: record.customer_email,
    message: 'Download authorized. This link is now consumed.'
  }, 200, cors);
}

// ─── Stats endpoint (admin only) ─────────────────────────────────
async function handleStats(request, env, cors) {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('key');

  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  const totalDownloads = await env.DOWNLOADS.get('stats:total_downloads') || '0';

  // Get recent downloads from log
  const logEntries = await env.DOWNLOADS.list({ prefix: 'log:' });
  const recentDownloads = [];

  for (const key of logEntries.keys.slice(-20)) {
    const data = await env.DOWNLOADS.get(key.name);
    if (data) recentDownloads.push(JSON.parse(data));
  }

  return json({
    total_downloads: parseInt(totalDownloads),
    recent: recentDownloads.reverse(),
    github_releases_url: 'https://api.github.com/repos/kolariki/phantom/releases'
  }, 200, cors);
}

// ─── Send Trading Alert Email ─────────────────────────────────────
async function handleSendAlert(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const {
    to, asset, decision,
    summary, details, timestamp,
    confluence, confluence_score, bias,
    indicators, marketData, tradeSetup,
    levels, risks, strategies, patterns,
    continuity, fullAnalysis
  } = body;

  if (!to || !asset || !decision) {
    return json({ error: 'Missing required fields: to, asset, decision' }, 400, cors);
  }

  if (!env.RESEND_API_KEY) {
    return json({ error: 'Email service not configured (RESEND_API_KEY missing)' }, 500, cors);
  }

  const decisionMap = {
    'LONG':  { emoji: '🟢', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', label: 'ENTER NOW — LONG' },
    'SHORT': { emoji: '🔴', color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: 'ENTER NOW — SHORT' },
    'WAIT':  { emoji: '🟡', color: '#d97706', bg: '#fffbeb', border: '#fde68a', label: 'DO NOT ENTER — WAIT' }
  };
  const d = decisionMap[decision] || decisionMap['WAIT'];
  const time = timestamp || new Date().toISOString();

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Helper for section blocks (accepts pre-rendered HTML content).
  const section = (icon, title, content, accent) => content ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid ${accent || '#1a3a5c'};border-radius:12px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:800;color:#1a3a5c;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px;">${icon} ${title}</div>
      ${content}
    </div>` : '';

  /* ─── Continuity card (renders at TOP, before the decision) ─── */
  let continuityHtml = '';
  if (continuity && continuity.guidance) {
    const g = continuity.guidance;
    const p = continuity.previous || {};
    const kindColor = g.kind === 'reversal' ? '#dc2626'
                    : g.kind === 'shift'    ? '#d97706'
                    : g.kind === 'same'     ? '#0369a1'
                                            : '#475569';
    const kindBg = g.kind === 'reversal' ? '#fef2f2'
                 : g.kind === 'shift'    ? '#fffbeb'
                 : g.kind === 'same'     ? '#f0f9ff'
                                         : '#f8fafc';
    const prevLine = p.decision ? `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;font-size:12px;">
        <div>
          <div style="color:#94a3b8;text-transform:uppercase;font-size:10px;letter-spacing:0.6px;">Alerta previa</div>
          <div style="font-weight:800;color:${kindColor};margin-top:2px;">${esc(p.decision)} ${p.entry ? '· ' + esc(p.entry) : ''}</div>
        </div>
        ${p.age_label ? `<div style="color:#64748b;font-size:11px;">${esc(p.age_label)}</div>` : ''}
      </div>
      ${p.user_action ? `<div style="font-size:11px;color:#475569;margin-bottom:6px;">Marcaste: <b>${esc(p.user_action.toUpperCase())}</b>${p.user_entry ? ' @ $' + esc(p.user_entry) : ''}${p.outcome && p.outcome !== 'open' ? ' · ' + esc(p.outcome) : ''}</div>` : ''}
    ` : '';
    continuityHtml = `
      <div style="background:${kindBg};border:1px solid ${kindColor}33;border-left:4px solid ${kindColor};border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:800;color:${kindColor};text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">${esc(g.headline)}</div>
        ${prevLine}
        <div style="font-size:13px;color:#334155;line-height:1.7;white-space:pre-line;">${esc(g.text)}</div>
      </div>
    `;
  }

  // Build confluence table
  let confluenceHtml = '';
  if (confluence && confluence.length > 0) {
    const biasColor = b => b === 'BULLISH' ? '#16a34a' : b === 'BEARISH' ? '#dc2626' : '#d97706';
    const biasEmoji = b => b === 'BULLISH' ? '🟢' : b === 'BEARISH' ? '🔴' : '🟡';
    const computedScore = confluence.filter(c => c.bias === (decision === 'SHORT' ? 'BEARISH' : 'BULLISH')).length + '/' + confluence.length;
    const scoreLabel = confluence_score || computedScore;
    confluenceHtml = section('⏱', 'Multi-Timeframe Confluence', `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:2px solid #e2e8f0;">
          <th style="text-align:left;padding:6px 8px;color:#64748b;font-size:11px;">TF</th>
          <th style="text-align:left;padding:6px 8px;color:#64748b;font-size:11px;">TREND</th>
          <th style="text-align:left;padding:6px 8px;color:#64748b;font-size:11px;">SIGNAL</th>
          <th style="text-align:center;padding:6px 8px;color:#64748b;font-size:11px;">BIAS</th>
        </tr>
        ${confluence.map(c => `<tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:6px 8px;font-weight:700;">${esc(c.tf)}</td>
          <td style="padding:6px 8px;">${esc(c.trend)}</td>
          <td style="padding:6px 8px;font-size:12px;">${esc(c.signal)}</td>
          <td style="padding:6px 8px;text-align:center;"><span style="color:${biasColor(c.bias)};font-weight:800;">${biasEmoji(c.bias)} ${esc(c.bias)}</span></td>
        </tr>`).join('')}
      </table>
      <div style="margin-top:10px;font-size:13px;font-weight:700;color:#1a3a5c;">
        Score: ${esc(scoreLabel)} aligned${bias ? ` · LONG ${esc(bias.long ?? '?')}% / SHORT ${esc(bias.short ?? '?')}%` : ''}
      </div>
    `);
  }

  // Build indicators section
  let indicatorsHtml = '';
  if (indicators && indicators.length > 0) {
    indicatorsHtml = section('📊', 'Indicadores', `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        ${indicators.map(ind => `<tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:6px 8px;font-weight:700;width:100px;color:#475569;vertical-align:top;">${esc(ind.name)}</td>
          <td style="padding:6px 8px;line-height:1.5;">${esc(ind.value)}</td>
          <td style="padding:6px 8px;text-align:right;vertical-align:top;white-space:nowrap;"><span style="color:${ind.signal === 'BULLISH' ? '#16a34a' : ind.signal === 'BEARISH' ? '#dc2626' : '#d97706'};font-weight:700;font-size:11px;">${esc(ind.signal)}</span></td>
        </tr>`).join('')}
      </table>
    `);
  }

  // Build market data section
  let marketHtml = '';
  if (marketData) {
    const items = [];
    if (marketData.price) items.push(`<span style="font-size:18px;font-weight:900;color:#0f172a;">$${marketData.price}</span>`);
    const pills = [];
    if (marketData.change24h) {
      const isUp = !marketData.change24h.startsWith('-');
      pills.push(`<span style="background:${isUp ? '#f0fdf4' : '#fef2f2'};color:${isUp ? '#16a34a' : '#dc2626'};padding:3px 10px;border-radius:20px;font-weight:700;font-size:12px;">${marketData.change24h}</span>`);
    }
    if (marketData.fundingRate) pills.push(`<span style="background:#f0f9ff;color:#0369a1;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">FR: ${marketData.fundingRate}</span>`);
    if (marketData.fearGreed) pills.push(`<span style="background:#fefce8;color:#a16207;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">F&G: ${marketData.fearGreed}</span>`);
    if (marketData.longShortRatio) pills.push(`<span style="background:#faf5ff;color:#7c3aed;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">L/S: ${marketData.longShortRatio}</span>`);
    if (marketData.openInterest) pills.push(`<span style="background:#f0fdf4;color:#15803d;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">OI: ${marketData.openInterest}</span>`);

    marketHtml = section('📡', 'Market Data', `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        ${items.join('')}
        ${pills.join(' ')}
      </div>
      ${marketData.high && marketData.low ? `<div style="margin-top:8px;font-size:12px;color:#64748b;">24H Range: <strong>$${marketData.low}</strong> — <strong>$${marketData.high}</strong></div>` : ''}
    `);
  }

  // Build trade setup section
  let setupHtml = '';
  if (tradeSetup) {
    const s = tradeSetup;
    const isLong = decision === 'LONG';
    const setupColor = isLong ? '#16a34a' : decision === 'SHORT' ? '#dc2626' : '#d97706';
    setupHtml = section(isLong ? '📗' : '📕', `Trade Setup — ${decision}`, `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        ${s.entry ? `<tr><td style="padding:4px 8px;color:#64748b;width:70px;">Entry</td><td style="padding:4px 8px;font-weight:700;">${esc(s.entry)}</td></tr>` : ''}
        ${s.sl ? `<tr><td style="padding:4px 8px;color:#dc2626;font-weight:600;">SL</td><td style="padding:4px 8px;font-weight:700;color:#dc2626;">${esc(s.sl)}</td></tr>` : ''}
        ${s.tp1 ? `<tr><td style="padding:4px 8px;color:#16a34a;font-weight:600;">TP1</td><td style="padding:4px 8px;font-weight:700;color:#16a34a;">${esc(s.tp1)}</td></tr>` : ''}
        ${s.tp2 ? `<tr><td style="padding:4px 8px;color:#16a34a;font-weight:600;">TP2</td><td style="padding:4px 8px;font-weight:700;color:#16a34a;">${esc(s.tp2)}</td></tr>` : ''}
        ${s.tp3 ? `<tr><td style="padding:4px 8px;color:#16a34a;font-weight:600;">TP3</td><td style="padding:4px 8px;font-weight:700;color:#16a34a;">${esc(s.tp3)}</td></tr>` : ''}
        ${s.rr ? `<tr><td style="padding:4px 8px;color:#d97706;">R:R</td><td style="padding:4px 8px;font-weight:700;color:#d97706;">${esc(s.rr)}</td></tr>` : ''}
        ${s.size ? `<tr><td style="padding:4px 8px;color:#64748b;">Size</td><td style="padding:4px 8px;font-weight:600;">${esc(s.size)}</td></tr>` : ''}
      </table>
    `, isLong ? '#16a34a' : '#dc2626');
  }

  // Build details/summary fallback
  let summaryHtml = '';
  if (summary) {
    summaryHtml = section('💡', 'Análisis', `<div style="font-size:13px;color:#334155;line-height:1.7;white-space:pre-line;">${esc(summary)}</div>`);
  }

  // Levels / Risks / Strategies — render only if AI provided them.
  const levelsHtml = levels ? section('🔑', 'Niveles Críticos',
    `<div style="font-size:12px;color:#334155;line-height:1.7;white-space:pre-line;">${esc(levels)}</div>`) : '';
  const risksHtml = risks ? section('⚠️', 'Factores de Riesgo',
    `<div style="font-size:12px;color:#334155;line-height:1.7;white-space:pre-line;">${esc(risks)}</div>`, '#d97706') : '';
  const strategiesHtml = strategies ? section('📚', 'Estrategias Recomendadas',
    `<div style="font-size:12px;color:#334155;line-height:1.7;white-space:pre-line;">${esc(strategies)}</div>`, '#6366f1') : '';
  const patternsHtml = (patterns && patterns.length > 0) ? section('📐', 'Patrones',
    `<div style="font-size:12px;color:#334155;line-height:1.7;">
       ${patterns.map(p => `<span style="display:inline-block;background:#eef2ff;color:#4338ca;padding:4px 10px;border-radius:14px;margin:2px 4px 2px 0;font-weight:600;">${esc(p.id.replace(/_/g, ' '))}${p.caption ? ' — ' + esc(p.caption) : ''}</span>`).join('')}
     </div>`) : '';

  // Full analysis fallback at the bottom — guarantees nothing gets truncated.
  let fullAnalysisHtml = '';
  if (fullAnalysis) {
    const cleaned = String(fullAnalysis)
      .replace(/\[TRADE_(LONG|SHORT)\][\s\S]*?\[\/TRADE_\1\]/gi, '')   // setups already rendered
      .replace(/\[BIAS_BAR\][\s\S]*?\[\/BIAS_BAR\]/gi, '')              // bias already in confluence
      .replace(/\[PATTERN:[^\]]+\]/gi, '')                              // patterns already rendered
      .trim();
    fullAnalysisHtml = section('📋', 'Análisis completo',
      `<div style="font-size:12px;color:#334155;line-height:1.65;white-space:pre-wrap;">${esc(cleaned)}</div>`);
  }
  let detailsHtml = '';
  if (details && !tradeSetup) {
    detailsHtml = section('📋', 'Detalles', `<div style="font-size:12px;color:#475569;line-height:1.6;white-space:pre-line;">${esc(details)}</div>`);
  }

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:0;background:#ffffff;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:20px 24px;text-align:center;border-radius:16px 16px 0 0;">
      <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:0.5px;">
        <img src="https://raw.githubusercontent.com/kolariki/phantom/main/assets/icon.png" width="28" height="28" style="vertical-align:middle;border-radius:6px;margin-right:8px;" />
        Phantom
      </div>
      <div style="font-size:11px;color:#94a3b8;margin-top:4px;text-transform:uppercase;letter-spacing:1px;">Trading Alert</div>
    </div>

    <div style="padding:20px 24px 24px;">
      ${continuityHtml}

      <!-- Decision Card -->
      <div style="background:${d.bg};border:2px solid ${d.border};border-radius:14px;padding:20px;text-align:center;margin-bottom:16px;">
        <div style="font-size:38px;margin-bottom:6px;">${d.emoji}</div>
        <div style="font-size:20px;font-weight:900;color:${d.color};letter-spacing:0.3px;">${esc(d.label)}</div>
        <div style="font-size:15px;color:#64748b;margin-top:4px;font-weight:700;">${esc(asset)}</div>
      </div>

      ${marketHtml}
      ${confluenceHtml}
      ${indicatorsHtml}
      ${setupHtml}
      ${summaryHtml}
      ${levelsHtml}
      ${patternsHtml}
      ${strategiesHtml}
      ${risksHtml}
      ${fullAnalysisHtml}
      ${detailsHtml}

      <!-- Footer -->
      <div style="text-align:center;margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;">
          ${new Date(time).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
        </div>
        <div style="font-size:10px;color:#cbd5e1;margin-top:4px;">Phantom Auto-Analysis · Not financial advice</div>
      </div>
    </div>
  </div>`;

  // Send via Resend API
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Phantom <alerts@phantom-download.online>',
      to: [to],
      subject: continuity && continuity.change_kind === 'reversal'
        ? `🔄 ${d.emoji} ${d.label} — ${asset} (CAMBIO de señal)`
        : continuity && continuity.change_kind === 'same'
          ? `🔁 ${d.emoji} ${d.label} — ${asset} (sigue)`
          : `${d.emoji} ${d.label} — ${asset}`,
      html
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.text();
    return json({ error: 'Email send failed', details: err }, 500, cors);
  }

  const result = await emailRes.json();
  return json({ success: true, email_id: result.id }, 200, cors);
}

// ─── Helpers ──────────────────────────────────────────────────────
function corsHeaders(allowedOrigin, request) {
  const origin = request.headers.get('Origin') || '';
  // Allow localhost for testing + production origin
  const isAllowed = origin === allowedOrigin
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
