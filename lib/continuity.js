/**
 * Continuity helper — given the previous N analyses for an asset and the
 * current one, produce a structured "follow-up" payload that tells the user:
 *   • What we recommended last time
 *   • Whether the previous setup would have worked (had they entered)
 *   • What to do now if they DID enter vs DIDN'T enter
 *   • Whether the new call is consistent with the previous one
 *
 * Pure functions. No DOM, no IPC. Fully testable.
 */

function minutesAgo(iso) {
  if (!iso) return null;
  const diff = Date.now() - Date.parse(iso);
  if (isNaN(diff)) return null;
  return Math.max(0, Math.round(diff / 60000));
}

function formatAge(min) {
  if (min == null) return '';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `hace ${h}h ${rem}min` : `hace ${h}h`;
}

function parseFirstPrice(s) {
  if (!s) return null;
  const m = String(s).match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

/** Build a follow-up record describing the previous setup vs current price. */
function evaluatePrevious(prev, currentPrice) {
  if (!prev) return null;
  const setup =
    prev.ai_decision === 'LONG'  ? prev.ai_setup_long  :
    prev.ai_decision === 'SHORT' ? prev.ai_setup_short : null;

  const entry = setup ? parseFirstPrice(setup.entry) : null;
  const sl    = setup ? parseFirstPrice(setup.sl)    : null;
  const tp1   = setup ? parseFirstPrice(setup.tp1)   : null;

  let pnlIfEntered = null;
  let hitTP = false;
  let hitSL = false;
  if (entry && currentPrice) {
    if (prev.ai_decision === 'LONG') {
      pnlIfEntered = ((currentPrice - entry) / entry) * 100;
      if (tp1 && currentPrice >= tp1) hitTP = true;
      if (sl  && currentPrice <= sl)  hitSL = true;
    } else if (prev.ai_decision === 'SHORT') {
      pnlIfEntered = ((entry - currentPrice) / entry) * 100;
      if (tp1 && currentPrice <= tp1) hitTP = true;
      if (sl  && currentPrice >= sl)  hitSL = true;
    }
  }

  return {
    id: prev.id,
    age_min: minutesAgo(prev.created_at),
    age_label: formatAge(minutesAgo(prev.created_at)),
    decision: prev.ai_decision,
    confluence: prev.ai_confluence,
    entry: setup ? setup.entry : null,
    sl: setup ? setup.sl : null,
    tp1: setup ? setup.tp1 : null,
    entry_price: entry,
    sl_price: sl,
    tp1_price: tp1,
    current_price: currentPrice,
    pnl_if_entered_pct: pnlIfEntered,
    hit_tp1: hitTP,
    hit_sl: hitSL,
    user_action: prev.user_action || null,    // 'long' | 'short' | 'skipped' | null
    user_entry: prev.user_entry || null,
    outcome: prev.outcome || null             // 'open' | 'win' | 'loss' | 'breakeven' | 'cancelled' | null
  };
}

/** Compare current decision vs previous to classify the follow-up. */
function classifyChange(prevDecision, currentDecision) {
  if (!prevDecision || !currentDecision) return 'first';
  if (prevDecision === currentDecision) return 'same';        // same call as before
  if (prevDecision === 'WAIT' || currentDecision === 'WAIT') return 'shift';
  return 'reversal';                                          // LONG ↔ SHORT
}

/** Produce a guidance text block (HTML-friendly, pre-rendered). */
function buildGuidance(prevEval, currentDecision) {
  if (!prevEval) {
    return {
      kind: 'first',
      headline: '🆕 Primera alerta para este activo',
      text: 'No hay alertas previas para este activo. Tomá esta como base para futuros seguimientos.'
    };
  }

  const kind = classifyChange(prevEval.decision, currentDecision);
  const pnl = prevEval.pnl_if_entered_pct;
  const pnlStr = (pnl != null && !isNaN(pnl))
    ? ((pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%')
    : null;

  // Lines that depend on whether the user already marked an action.
  const userTookAction = prevEval.user_action === 'long' || prevEval.user_action === 'short';
  const userSkipped    = prevEval.user_action === 'skipped';

  const blocks = [];

  // Header — what we said before.
  if (prevEval.decision && prevEval.entry) {
    blocks.push(`📍 Alerta previa (${prevEval.age_label}): <b>${prevEval.decision}</b> en ${prevEval.entry}`);
  } else if (prevEval.decision) {
    blocks.push(`📍 Alerta previa (${prevEval.age_label}): <b>${prevEval.decision}</b>`);
  }

  // What happened to price since then.
  if (prevEval.hit_tp1) {
    blocks.push(`🎯 El precio TOCÓ tu primer take-profit ${prevEval.tp1 ? '(' + prevEval.tp1 + ')' : ''} ${pnlStr ? '— ' + pnlStr : ''}`);
  } else if (prevEval.hit_sl) {
    blocks.push(`🛑 El precio TOCÓ el stop loss ${prevEval.sl ? '(' + prevEval.sl + ')' : ''} ${pnlStr ? '— ' + pnlStr : ''}`);
  } else if (pnlStr) {
    blocks.push(`📈 Si hubieras entrado: ${pnlStr} respecto a la entrada sugerida`);
  }

  // Did the user enter or not?
  if (userTookAction) {
    blocks.push('');
    blocks.push(`✅ Marcaste que entraste en ${prevEval.user_action.toUpperCase()}${prevEval.user_entry ? ' @ $' + prevEval.user_entry : ''}.`);
    if (prevEval.hit_tp1) {
      blocks.push('→ Considerá tomar al menos parcial de ganancia y mover stop a breakeven.');
    } else if (prevEval.hit_sl) {
      blocks.push('→ El SL ya debería haberte sacado. Si seguís dentro, revisá la posición.');
    } else if (kind === 'reversal') {
      blocks.push('→ ⚠ La señal se INVIRTIÓ. Considerá cerrar la posición previa antes de operar la nueva dirección.');
    } else if (kind === 'shift' && currentDecision === 'WAIT') {
      blocks.push('→ La señal pasó a WAIT. Mantené el SL ajustado, no agregues a la posición.');
    } else if (kind === 'same') {
      blocks.push('→ Misma dirección, setup sigue vivo. Mantené tu plan original.');
    }
  } else if (userSkipped) {
    blocks.push('');
    blocks.push('⏭ Marcaste que NO entraste en la alerta previa.');
    if (kind === 'same') {
      if (pnl != null && pnl < -0.5 && prevEval.decision !== 'WAIT') {
        blocks.push(`→ El precio se movió en contra de la entrada original. Mejor esperar al nuevo setup que perseguir el anterior.`);
      } else {
        blocks.push('→ Setup sigue vigente con la misma dirección. Considerá la nueva alerta abajo si el precio entra al rango.');
      }
    } else if (kind === 'reversal') {
      blocks.push('→ ⚠ La señal se INVIRTIÓ — bueno que no entraste. Evaluá el nuevo setup desde cero.');
    } else if (kind === 'shift') {
      blocks.push('→ La situación cambió. Revisá el nuevo análisis abajo.');
    }
  } else {
    // User never marked the previous alert.
    blocks.push('');
    blocks.push(`❓ No marcaste si entraste a la alerta previa.`);
    if (kind === 'same' && currentDecision !== 'WAIT') {
      blocks.push('→ Si entraste: mantené tu plan. Si no entraste: revisá si el precio aún está en zona válida.');
    } else if (kind === 'reversal') {
      blocks.push('→ Si entraste en la dirección anterior, considerá CERRAR ahora — el setup se invirtió.');
    } else if (kind === 'shift') {
      blocks.push('→ Si tenés posición abierta del anterior, ajustá según el nuevo análisis.');
    }
  }

  return {
    kind,
    headline:
      kind === 'reversal' ? '🔄 SEGUIMIENTO — Señal invertida' :
      kind === 'shift'    ? '➡️ SEGUIMIENTO — Cambio de señal' :
      kind === 'same'     ? '🔁 SEGUIMIENTO — Misma dirección' :
                            '🕐 SEGUIMIENTO',
    text: blocks.filter(Boolean).join('\n')
  };
}

/** Top-level builder. Returns null if there's no previous alert. */
function buildContinuity(prevTrades, currentDecision, currentPrice) {
  const prev = (prevTrades && prevTrades.length) ? prevTrades[0] : null;
  if (!prev) return null;
  const ev = evaluatePrevious(prev, currentPrice);
  const guidance = buildGuidance(ev, currentDecision);
  return {
    previous: ev,
    guidance,
    change_kind: guidance.kind
  };
}

const api = {
  evaluatePrevious,
  classifyChange,
  buildGuidance,
  buildContinuity,
  _internal: { minutesAgo, formatAge, parseFirstPrice }
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.Continuity = api;
