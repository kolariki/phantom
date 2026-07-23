/**
 * News summary formatter — dep-free, dual node/browser load.
 * Takes the news data object returned from the IPC handler and produces:
 *   - summarizeForPrompt(data): text block to inject in AI system prompt
 *   - renderNewsPanel(data): HTML string for the trading UI
 */

function summarizeForPrompt(newsData) {
  if (!newsData) return '';
  const hasRecent   = !!(newsData.recent   && newsData.recent.length);
  const hasUpcoming = !!(newsData.upcoming && newsData.upcoming.length);
  // If neither headlines nor upcoming events were actually fetched, return
  // an empty block — the AI's prompt instruction handles the "no news"
  // case explicitly and we don't want to inject a fake empty header.
  if (!hasRecent && !hasUpcoming) return '';

  const lines = [];
  lines.push('NEWS CONTEXT (real headlines fetched from public feeds — these ARE specific news items, you MUST cite them):');
  if (hasRecent) {
    lines.push('\nRecent headlines:');
    for (const item of newsData.recent.slice(0, 10)) {
      const age = item.hoursAgo !== null && item.hoursAgo !== undefined
        ? `${item.hoursAgo}h ago`
        : 'recent';
      const votes = item.votes
        ? ` [+${item.votes.positive}/-${item.votes.negative}]`
        : '';
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

function escapeHTMLBasic(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNewsPanel(newsData) {
  if (!newsData) return '';
  const recent = (newsData.recent || []).slice(0, 8);
  const upcoming = (newsData.upcoming || []).slice(0, 4);
  if (recent.length === 0 && upcoming.length === 0) {
    return '<div class="news-panel-empty">Sin noticias disponibles.</div>';
  }
  const recentHTML = recent.map(item => {
    const age = item.hoursAgo !== null && item.hoursAgo !== undefined ? `${item.hoursAgo}h` : '';
    const votes = item.votes
      ? `<span class="news-votes">+${item.votes.positive}/-${item.votes.negative}</span>`
      : '';
    const url = item.url ? `href="${escapeHTMLBasic(item.url)}" target="_blank" rel="noopener"` : '';
    return `
      <a class="news-item" ${url}>
        <div class="news-meta">
          <span class="news-source">${escapeHTMLBasic(item.source || 'unknown')}</span>
          <span class="news-age">${escapeHTMLBasic(age)}</span>
          ${votes}
        </div>
        <div class="news-title">${escapeHTMLBasic(item.title)}</div>
      </a>
    `;
  }).join('');
  const upcomingHTML = upcoming.map(item => {
    const when = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : '';
    const url = item.url ? `href="${escapeHTMLBasic(item.url)}" target="_blank" rel="noopener"` : '';
    return `
      <a class="news-item news-event" ${url}>
        <div class="news-meta">
          <span class="news-event-date">📅 ${escapeHTMLBasic(when)}</span>
        </div>
        <div class="news-title">${escapeHTMLBasic(item.title)}</div>
      </a>
    `;
  }).join('');
  let html = '';
  if (recent.length) {
    html += `<div class="news-section-title">📰 Noticias recientes</div><div class="news-list">${recentHTML}</div>`;
  }
  if (upcoming.length) {
    html += `<div class="news-section-title" style="margin-top:8px">📅 Eventos próximos</div><div class="news-list">${upcomingHTML}</div>`;
  }
  return html;
}

const api = { summarizeForPrompt, renderNewsPanel };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.NewsSummary = api;
}
