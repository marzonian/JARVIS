import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import healthAudioUtils from './health-audio-utils.cjs';

const {
  normalizeHealthStatus,
  shouldEmitHealthAudioTransition,
  healthAudioToneType,
} = healthAudioUtils;

// ─── API ───
function useApi(url, deps = [], options = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const requestSeq = useRef(0);
  const hasDataRef = useRef(false);
  const activeControllerRef = useRef(null);
  const pollingTimerRef = useRef(null);

  const autoRefreshMsRaw = Number(options?.autoRefreshMs);
  const autoRefreshMs = Number.isFinite(autoRefreshMsRaw)
    ? Math.max(0, autoRefreshMsRaw)
    : 30000;
  const autoRefreshWhenHidden = options?.autoRefreshWhenHidden === true;
  const autoRefreshBackoffMs = Math.max(5000, Number(options?.autoRefreshBackoffMs || 60000));

  useEffect(() => {
    hasDataRef.current = data != null;
  }, [data]);

  const shouldRetry = (err) => {
    const msg = String(err?.message || '').toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    return name.includes('abort') || msg.includes('timeout') || msg.includes('network');
  };

  const fetchWithRetry = async (signal) => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const r = await fetch(url, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (err) {
        lastErr = err;
        if (attempt === 1 && shouldRetry(err)) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Request failed');
  };

  const reload = useCallback((reloadOptions = {}) => {
    const allowAbortActive = reloadOptions?.allowAbortActive !== false;
    const seq = ++requestSeq.current;
    if (activeControllerRef.current && !allowAbortActive) {
      return;
    }
    if (activeControllerRef.current && allowAbortActive) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(!hasDataRef.current);
    setError(null);
    fetchWithRetry(controller.signal)
      .then((d) => {
        if (seq !== requestSeq.current) return;
        setData(d);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setError(err?.name === 'AbortError' ? 'Request timeout' : (err?.message || 'Request failed'));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (activeControllerRef.current === controller) activeControllerRef.current = null;
        if (seq !== requestSeq.current) return;
        setLoading(false);
      });
  }, [url]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  useEffect(() => {
    if (autoRefreshMs <= 0) return undefined;
    let active = true;
    const schedule = (ms) => {
      if (pollingTimerRef.current) clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = setTimeout(tick, ms);
    };
    const tick = () => {
      if (!active) return;
      if (!autoRefreshWhenHidden && typeof document !== 'undefined' && document.hidden) {
        schedule(Math.max(10000, autoRefreshMs));
        return;
      }
      reload({ allowAbortActive: false });
      const hasError = !!error;
      schedule(hasError ? autoRefreshBackoffMs : autoRefreshMs);
    };
    schedule(autoRefreshMs);
    return () => {
      active = false;
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [autoRefreshMs, autoRefreshWhenHidden, autoRefreshBackoffMs, reload, error]);
  useEffect(() => () => {
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }
    if (pollingTimerRef.current) {
      clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);
  return { data, loading, error, reload };
}

const ASSISTANT_SESSION_STORAGE_KEY = 'mcnair_assistant_session_id';
const ASSISTANT_CLIENT_STORAGE_KEY = 'mcnair_assistant_client_id';
const HEALTH_AUDIO_ALERT_STORAGE_KEY = 'mcnair_health_audio_alert_enabled';
const VOICE_LOCATION_HINT_STORAGE_KEY = 'mcnair_voice_location_hint_enabled';
function getAssistantSessionId() {
  if (typeof window === 'undefined') return 'session-server';
  try {
    const existing = String(window.sessionStorage.getItem(ASSISTANT_SESSION_STORAGE_KEY) || '').trim();
    if (existing) return existing;
    const next = `sess_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    window.sessionStorage.setItem(ASSISTANT_SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return `sess_fallback_${Date.now().toString(36)}`;
  }
}

function getAssistantClientId() {
  if (typeof window === 'undefined') return 'client-server';
  try {
    const existing = String(window.localStorage.getItem(ASSISTANT_CLIENT_STORAGE_KEY) || '').trim();
    if (existing) return existing;
    const next = `client_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    window.localStorage.setItem(ASSISTANT_CLIENT_STORAGE_KEY, next);
    return next;
  } catch {
    return `client_fallback_${Date.now().toString(36)}`;
  }
}

function getStoredHealthAudioAlertEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return String(window.localStorage.getItem(HEALTH_AUDIO_ALERT_STORAGE_KEY) || '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function getStoredVoiceLocationHintEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return String(window.localStorage.getItem(VOICE_LOCATION_HINT_STORAGE_KEY) || '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function buildQrImageUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
}

function normalizeTransportFailureReason(rawReason, intentHint = 'general') {
  const text = String(rawReason || '').trim();
  const lower = text.toLowerCase();
  const isTransport = lower.includes('abort')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('failed to fetch')
    || lower.includes('network');
  if (!isTransport) return text;
  if (String(intentHint || '').toLowerCase().startsWith('trading')) {
    return "I couldn't complete the live trading check in time.";
  }
  return 'Connection delay while contacting Jarvis.';
}

function formatAgeLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 'unknown age';
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  return `${Math.round(n / 3600)}h`;
}

function generateVoiceTraceId() {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `trace_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

function logVoiceAudit(stage, payload = {}) {
  const row = {
    at: new Date().toISOString(),
    stage: String(stage || 'unknown'),
    ...payload,
  };
  try {
    console.log(`[JARVIS_VOICE_TRACE] ${JSON.stringify(row)}`);
  } catch {
    console.log('[JARVIS_VOICE_TRACE] {"stage":"log_failed"}');
  }
}

function nowInEtDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function inFastMarketHealthWindowEt(dateObj = nowInEtDate()) {
  const mins = (dateObj.getHours() * 60) + dateObj.getMinutes();
  return mins >= 560 && mins <= 970; // 09:20 -> 16:10 ET
}

function useMarketHealthHud() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState('');
  const inFlightRef = useRef(false);
  const pollTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const runPollRef = useRef(null);

  const scheduleNext = useCallback(() => {
    if (!mountedRef.current) return;
    const delay = inFastMarketHealthWindowEt() ? 15_000 : 60_000;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      if (mountedRef.current && typeof runPollRef.current === 'function') runPollRef.current(false);
    }, delay);
  }, []);

  const runPoll = useCallback(async (forceFresh = true) => {
    if (!mountedRef.current) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const url = `/api/market/health?forceFresh=${forceFresh ? '1' : '0'}&compareLive=1&live=false`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!mountedRef.current) return;
      setHealth(data && typeof data === 'object' ? data : null);
      setError('');
      setLastSuccessAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (err) {
      if (!mountedRef.current) return;
      setError(String(err?.message || 'Health unavailable'));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        scheduleNext();
      }
    }
  }, [scheduleNext]);
  runPollRef.current = runPoll;

  useEffect(() => {
    mountedRef.current = true;
    runPoll(true);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [runPoll]);

  const reload = useCallback(() => {
    runPoll(true);
  }, [runPoll]);

  return {
    health,
    loading,
    error,
    lastSuccessAt,
    reload,
  };
}

// ─── COLOR HELPERS ───
const wr = v => v >= 55 ? 'green' : v >= 50 ? 'yellow' : 'red';
const pf = v => v >= 1.2 ? 'green' : v >= 1.0 ? 'yellow' : 'red';
const pnl = v => v >= 0 ? 'green' : 'red';
const dir = v => v === 'long' ? 'green' : 'red';
const normalizeDecisionSignal = (value) => {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'GO' || v === 'TRADE') return 'TRADE';
  if (v === 'WAIT') return 'WAIT';
  return "DON'T TRADE";
};
const signalBadgeClass = (value) => {
  const signal = normalizeDecisionSignal(value);
  if (signal === 'TRADE') return 'bg-green';
  if (signal === 'WAIT') return 'bg-yellow';
  return 'bg-red';
};
const signalTone = (value) => {
  const signal = normalizeDecisionSignal(value);
  if (signal === 'TRADE') return 'positive';
  if (signal === 'WAIT') return 'neutral';
  return 'negative';
};

// ═══════════════════════════════════════════
// BOOT SEQUENCE
// ═══════════════════════════════════════════
function BootSequence({ onComplete }) {
  const [lines, setLines] = useState([]);
  const bootLines = [
    { tag: 'SYS', text: 'Initializing McNair Mindset v1.0.0' },
    { tag: 'SYS', text: 'Connecting to 3130 core engine...' },
    { tag: 'DB', text: 'SQLite database — online' },
    { tag: 'ENG', text: 'ORB 3130 strategy engine — loaded' },
    { tag: 'ENG', text: 'Psych level calculator — ready' },
    { tag: 'ENG', text: 'Regime classifier — online' },
    { tag: 'ADV', text: 'The Adversary — scanning vulnerabilities' },
    { tag: 'MOD', text: 'Edge Decay Monitor — active' },
    { tag: 'MOD', text: 'Monte Carlo simulator — armed' },
    { tag: 'API', text: 'Server connection — established' },
    { tag: '✓', text: 'All systems nominal', done: true },
  ];

  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      if (i < bootLines.length) {
        const line = bootLines[i];
        setLines(prev => [...prev, line]);
        i++;
      } else {
        clearInterval(timer);
        setTimeout(onComplete, 500);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="boot-screen">
      <div className="boot-logo">3130</div>
      <div className="boot-sub">McNAIR MINDSET</div>
      <div className="boot-lines">
        {lines.map((l, i) => (
          <div key={i} className={`boot-line ${l.done ? 'done' : ''}`}
            style={{ animationDelay: `${i * 0.03}s` }}>
            <span className="tag">[{l.tag}]</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════
const MODULES = [
  { id: 'system', icon: '⛭', label: 'System Core' },
  { id: 'analyst', icon: '⬢', label: 'Codex Console' },
  { id: 'bridge', icon: '◈', label: 'The Bridge' },
  { id: 'adversary', icon: '⚔', label: 'The Adversary' },
  { id: 'journal', icon: '◫', label: 'Trade Journal' },
  { id: 'sessions', icon: '▤', label: 'Session Log' },
  { id: 'breakdown', icon: '◧', label: 'Breakdowns' },
  { id: 'conflicts', icon: '⚡', label: 'Conflicts' },
  { id: 'lab', icon: '◬', label: 'The Lab' },
  { id: 'coach', icon: '◎', label: 'Coach Ops' },
  { id: 'portfolio', icon: '◩', label: 'Portfolio' },
  { id: 'briefing', icon: '◉', label: 'Command Intel' },
  { id: 'import', icon: '⬡', label: 'Import Data' },
];

const MODULE_DESCRIPTIONS = {
  system: 'Monitor uptime, health, and fail-safe recovery controls.',
  analyst: 'Use Codex command execution, terminal control, and live trade guidance.',
  bridge: 'Track account performance and session-level strategy output.',
  adversary: 'Inspect vulnerabilities before they degrade your edge.',
  journal: 'Audit every executed trade and behavior pattern.',
  sessions: 'Validate day-by-day structure across all sessions.',
  breakdown: 'Detect weak zones by weekday, month, and outcome profile.',
  conflicts: 'Resolve ambiguous sessions before they bias decision logic.',
  lab: 'Discover and validate new strategy opportunities.',
  coach: 'Promote validated opportunities into production playbooks.',
  portfolio: 'Operate one prioritized strategy stack with clear actions.',
  briefing: 'Get one clear signal, playbook, and execution guidance.',
  import: 'Ingest and normalize new market data safely.',
};

function Sidebar({ active, onSelect, sessionCount }) {
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <h1>3130</h1>
        <h2>McNair Mindset</h2>
      </div>
      <div className="sidebar-section-label">Modules</div>
      <div className="sidebar-nav">
        {MODULES.map(m => (
          <div key={m.id}
            className={`nav-item ${active === m.id ? 'active' : ''}`}
            onClick={() => onSelect(m.id)}>
            <span className="nav-icon">{m.icon}</span>
            <span>{m.label}</span>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        ORB 3130 × MNQ
        <div className="sidebar-status">
          <div className="status-dot" />
          <span>{sessionCount || 0} sessions loaded</span>
        </div>
      </div>
    </div>
  );
}

function ModuleBanner({ activeModule, strategy, health, sessionCount, onSelect }) {
  const healthLabel = health?.status === 'ok' ? 'NOMINAL' : 'DEGRADED';
  const codexLabel = health?.analyst?.configured
    ? String(health?.analyst?.provider || 'READY').toUpperCase()
    : 'OFFLINE';
  const moduleSummary = MODULE_DESCRIPTIONS[activeModule?.id] || 'Unified intelligence and execution support.';
  return (
    <div className="module-banner">
      <div className="module-banner-head">
        <div className="module-banner-eyebrow">ACTIVE MODULE</div>
        <div className="module-banner-title">{activeModule?.label || 'Unknown Module'}</div>
        <div className="module-banner-sub">{moduleSummary}</div>
      </div>
      <div className="module-banner-meta">
        <span className="module-pill">{strategy === 'alt' ? 'CLOSER TP MODE' : 'ORIGINAL MODE'}</span>
        <span className={`module-pill ${health?.status === 'ok' ? 'ok' : 'warn'}`}>SYSTEM {healthLabel}</span>
        <span className={`module-pill ${health?.api?.ok ? 'ok' : 'warn'}`}>API {health?.api?.ok ? 'ONLINE' : 'DOWN'}</span>
        <span className={`module-pill ${health?.database?.ok ? 'ok' : 'warn'}`}>DB {health?.database?.ok ? 'READY' : 'ERROR'}</span>
        <span className={`module-pill ${health?.analyst?.configured ? 'ok' : 'warn'}`}>CODEX {codexLabel}</span>
        <span className="module-pill">{sessionCount || 0} SESSIONS</span>
      </div>
      <div className="module-banner-actions">
        {activeModule?.id !== 'briefing' && (
          <button className="touch-safe" onClick={() => onSelect('briefing')}>OPEN COMMAND INTEL</button>
        )}
        {activeModule?.id !== 'bridge' && (
          <button className="touch-safe" onClick={() => onSelect('bridge')}>OPEN BRIDGE</button>
        )}
        {activeModule?.id !== 'system' && (
          <button className="touch-safe" onClick={() => onSelect('system')}>OPEN SYSTEM CORE</button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// TOPBAR
// ═══════════════════════════════════════════
function Topbar({ title, metrics: m }) {
  return (
    <div className="topbar">
      <div className="topbar-title">{title}</div>
      {m && (
        <div className="topbar-stats">
          <div className="topbar-stat">WR <span className={wr(m.winRate)}>{m.winRate}%</span></div>
          <div className="topbar-stat">PF <span className={pf(m.profitFactor)}>{m.profitFactor}</span></div>
          <div className="topbar-stat">TRADES <span>{m.totalTrades}</span></div>
          <div className="topbar-stat">P&L <span className={pnl(m.totalPnlDollars)}>${m.totalPnlDollars?.toFixed(2)}</span></div>
        </div>
      )}
    </div>
  );
}

function HealthStrip({ health }) {
  const dbOk = !!health?.database?.ok;
  const apiOk = !!health?.api?.ok;
  const codexOk = !!health?.analyst?.configured;
  const statusText = health?.status === 'ok' ? 'NOMINAL' : 'DEGRADED';

  return (
    <div className="health-strip">
      <div className={`health-chip ${health?.status === 'ok' ? 'ok' : 'warn'}`}>SYSTEM {statusText}</div>
      <div className={`health-chip ${apiOk ? 'ok' : 'warn'}`}>API {apiOk ? 'ONLINE' : 'DOWN'}</div>
      <div className={`health-chip ${dbOk ? 'ok' : 'warn'}`}>DB {dbOk ? 'READY' : 'ERROR'}</div>
      <div className={`health-chip ${codexOk ? 'ok' : 'warn'}`}>
        CODEX {codexOk ? (health?.analyst?.provider || 'READY').toUpperCase() : 'OFFLINE'}
      </div>
      <div className="health-meta">
        {health?.database?.sessions ?? 0} sessions · {health?.database?.trades ?? 0} trades
      </div>
    </div>
  );
}

function MarketHealthWidget({ health, loading, error, lastSuccessAt, onRefresh }) {
  const status = String(health?.status || '').trim().toUpperCase() || (loading ? 'LOADING' : 'UNAVAILABLE');
  const isOk = status === 'OK';
  const barsAge = Number.isFinite(Number(health?.topstep_bars?.minutes_since_last_bar))
    ? `${Number(health.topstep_bars.minutes_since_last_bar)}m`
    : 'n/a';
  const rollStatus = String(health?.contract_roll_status || 'UNKNOWN').trim().toUpperCase();
  const orbReady = health?.orb_state?.hasORBComplete === true ? 'YES' : 'NO';
  const reason = error || String(health?.reason || '').trim() || null;

  return (
    <div className={`market-health-widget ${isOk ? 'ok' : 'warn'}`}>
      <div className="market-health-head">
        <div className="market-health-title">Market Health</div>
        <div className={`market-health-status ${isOk ? 'ok' : 'warn'}`}>{status}</div>
        <button type="button" className="market-health-refresh" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="market-health-grid">
        <div className="market-health-item"><span>Bars Age</span><strong>{barsAge}</strong></div>
        <div className="market-health-item"><span>Contract</span><strong>{health?.contractId_in_use || 'n/a'}</strong></div>
        <div className="market-health-item"><span>Roll Status</span><strong>{rollStatus}</strong></div>
        <div className="market-health-item"><span>ORB Complete</span><strong>{orbReady}</strong></div>
      </div>
      {!isOk && (
        <div className="market-health-warning">
          <span className="market-health-badge">Warning</span>
          <span>{reason || 'Health: unavailable.'}</span>
        </div>
      )}
      <div className="market-health-meta">
        Last success: {lastSuccessAt || 'none'} {health?.now_et ? `• Snapshot ${health.now_et}` : ''}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// METRIC CELL
// ═══════════════════════════════════════════
function Metric({ label, value, sub, color, tone }) {
  return (
    <div className={`metric-cell ${tone || 'neutral'}`}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${color || ''}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function DailyTradePlanCard({ strategy, onOpenCommandIntel }) {
  const cmdUrl = strategy === 'alt' ? '/api/command/snapshot?strategy=alt' : '/api/command/snapshot?strategy=original';
  const { data, loading, error, reload } = useApi(cmdUrl, [strategy]);
  const snapshot = data?.snapshot || null;
  const plan = snapshot?.plan || null;
  const elite = snapshot?.elite || null;
  const decision = snapshot?.decision || null;

  if (!loading && !plan) return null;

  const newsEvents = elite?.news?.events || [];
  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowEtMinutes = (nowEt.getHours() * 60) + nowEt.getMinutes();
  const upcoming = newsEvents
    .filter((e) => !Number.isFinite(e?.minutes) || e.minutes > nowEtMinutes)
    .slice(0, 3);
  const topSetup = decision?.topSetups?.[0];

  return (
    <div className="global-plan-card">
      <div className="global-plan-head">
        <div className="global-plan-title">DAILY TRADE PLAN</div>
        <div className={`card-badge ${plan?.action === 'GREEN LIGHT' ? 'bg-green' : plan?.action?.includes('DEFENSIVE') ? 'bg-red' : 'bg-yellow'}`}>
          {plan?.action || (loading ? 'LOADING' : 'NO DATA')}
        </div>
        <button
          onClick={reload}
          style={{
            marginLeft: 'auto', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-1)',
            background: 'var(--bg-3)', color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10,
          }}
        >
          REFRESH
        </button>
        <button
          onClick={onOpenCommandIntel}
          style={{
            padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-1)',
            background: 'var(--bg-3)', color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10,
          }}
        >
          OPEN COMMAND INTEL
        </button>
      </div>
      {error ? (
        <div className="global-plan-line red">Plan unavailable: {error}</div>
      ) : (
        <>
          <div className="global-plan-grid">
            <div className="global-plan-cell">
              <div className="dim">Win Chance</div>
              <div>{elite?.winModel?.point ?? 0}%</div>
              <div className="dim">{elite?.winModel?.rangeLow ?? 0}-{elite?.winModel?.rangeHigh ?? 0}%</div>
            </div>
            <div className="global-plan-cell">
              <div className="dim">Decision</div>
              <div>{normalizeDecisionSignal(decision?.signal || decision?.signalLabel || decision?.verdict)}</div>
              <div className="dim">{decision?.confidence ?? 0}% confidence</div>
            </div>
            <div className="global-plan-cell">
              <div className="dim">Risk</div>
              <div>{plan?.riskPlan?.mode || 'NORMAL'}</div>
              <div className="dim">max {plan?.riskPlan?.maxTrades ?? 2} trades · {plan?.riskPlan?.sizeGuidance || 'half-size'}</div>
            </div>
            <div className="global-plan-cell">
              <div className="dim">Top Setup</div>
              <div>{topSetup?.name || '—'}</div>
              <div className="dim">{topSetup ? `${topSetup.probability}% (${topSetup.grade})` : 'not available'}</div>
            </div>
          </div>

          <div className="global-plan-line">
            <span className="dim">Focus:</span> {(plan?.primarySetups || []).slice(0, 2).map((s) => s.title).join(' | ') || 'No setup priorities available.'}
          </div>
          <div className="global-plan-line">
            <span className="dim">News (ET):</span> {upcoming.length > 0
              ? upcoming.map((e) => `${e.time || 'TBD'} ${e.country} ${String(e.impact || '').toUpperCase()} ${e.title}`).join(' | ')
              : 'No upcoming scheduled events today.'}
          </div>
          {(decision?.blockers || []).length > 0 && (
            <div className="global-plan-line yellow">
              <span className="dim">Blockers:</span> {(decision.blockers || []).slice(0, 4).join(', ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error(`[3130] Module crash in "${this.props.moduleId}"`, error, info);
    if (typeof this.props.onError === 'function') this.props.onError(error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (typeof this.props.onReset === 'function') this.props.onReset();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="content">
          <div className="card" style={{ borderLeft: '2px solid var(--red)' }}>
            <div className="card-header">
              <div className="card-title">Module Recovery</div>
              <div className="card-badge bg-red">CRASH CAUGHT</div>
            </div>
            <div className="data-row"><span className="label">Module</span><span className="value">{this.props.moduleId || 'current module'}</span></div>
            <div className="data-row"><span className="label">Error</span><span className="value">{this.state.error?.message || 'Unhandled render error'}</span></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '8px 12px', borderRadius: 'var(--radius)',
                  border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                  color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                }}
              >
                RELOAD MODULE
              </button>
              <button
                onClick={this.props.onGoSafe}
                style={{
                  padding: '8px 12px', borderRadius: 'var(--radius)',
                  border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                  color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                }}
              >
                GO TO BRIDGE
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════
// CODEX CONSOLE
// ═══════════════════════════════════════════
function Analyst({ strategy = 'original', setActive }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chartAnalyzing, setChartAnalyzing] = useState(false);
  const [chartFile, setChartFile] = useState(null);
  const [chartPrompt, setChartPrompt] = useState('');
  const [chartInputKey, setChartInputKey] = useState(0);
  const [status, setStatus] = useState(null);
  const assistantSessionIdRef = useRef(getAssistantSessionId());
  const messagesEndRef = React.useRef(null);

  React.useEffect(() => {
    fetch(`/api/system/status?strategy=${strategy === 'alt' ? 'alt' : 'original'}`)
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus(null));
  }, [strategy]);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const applyClientActions = React.useCallback((actions) => {
    if (!Array.isArray(actions) || typeof setActive !== 'function') return;
    for (const action of actions) {
      if (String(action?.type || '') === 'open_module' && action?.module) {
        setActive(action.module);
      }
    }
  }, [setActive]);

  const runAssistantQuery = React.useCallback(async (message, options = {}) => {
    const runQuickFallback = async () => {
      const url = '/api/assistant/quick';
      const body = {
        message,
        strategy,
        activeModule: 'analyst',
        preferCachedLive: true,
        sessionId: assistantSessionIdRef.current,
        clientId: assistantSessionIdRef.current,
      };
      console.log(`[ANALYST_UI_TRACE] request url=${url} body=${JSON.stringify(body)}`);
      const fallbackResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const fallbackRaw = await fallbackResp.text();
      const fallbackPreview = String(fallbackRaw || '').slice(0, 250);
      const fallbackHeader = fallbackResp.headers.get('X-Analyst-Sanitized');
      console.log(`[ANALYST_UI_TRACE] response url=${url} status=${fallbackResp.status} sanitizedHeader=${fallbackHeader} responseText=${fallbackPreview}`);
      let fallbackData = {};
      try {
        fallbackData = JSON.parse(fallbackRaw || '{}');
      } catch {
        fallbackData = {};
      }
      const fallbackReply = String(fallbackData?.reply || '').trim();
      if (!fallbackResp.ok || fallbackData?.success === false || fallbackData?.handled === false || !fallbackReply) {
        throw new Error(fallbackData?.error || 'assistant_quick_fallback_failed');
      }
      fallbackData.__trace = {
        url,
        status: fallbackResp.status,
        sanitizedHeader: fallbackHeader,
        responseText: fallbackPreview,
      };
      return fallbackData;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(2200, Number(options.timeoutMs || 4200)));
    try {
      const url = '/api/assistant/query';
      const body = {
        message,
        strategy,
        activeModule: 'analyst',
        preferCachedLive: options.preferCachedLive === true,
        sessionId: assistantSessionIdRef.current,
        clientId: assistantSessionIdRef.current,
      };
      console.log(`[ANALYST_UI_TRACE] request url=${url} body=${JSON.stringify(body)}`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await resp.text();
      const responseText = String(raw || '').slice(0, 250);
      const sanitizedHeader = resp.headers.get('X-Analyst-Sanitized');
      console.log(`[ANALYST_UI_TRACE] response url=${url} status=${resp.status} sanitizedHeader=${sanitizedHeader} responseText=${responseText}`);
      let data = {};
      try {
        data = JSON.parse(raw || '{}');
      } catch {
        data = {};
      }
      if (!resp.ok || data?.success === false) throw new Error(data?.error || 'assistant_query_failed');
      data.__trace = { url, status: resp.status, sanitizedHeader, responseText };
      return data;
    } catch (err) {
      if (options.allowFallback !== false) {
        try {
          return await runQuickFallback();
        } catch {}
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, [strategy]);

  const sendMessage = async (text, isAuto = false) => {
    const prompt = String(text || '').trim();
    if (!prompt) return;
    setMessages(prev => [...prev, { role: 'user', content: prompt, auto: isAuto }]);
    if (!isAuto) setInput('');
    setSending(true);
    try {
      const normalized = normalizeVoiceText(prompt);
      const wantsRealtime = isRealtimeVoiceMarketIntent(prompt)
        || /\b(what do you need|what are you missing|better function|better perform|capability audit|capability gap|how can i make you better)\b/.test(normalized);
      const out = await runAssistantQuery(prompt, {
        preferCachedLive: !wantsRealtime,
        timeoutMs: wantsRealtime ? 7000 : 4200,
      });
      applyClientActions(out?.clientActions || []);
      const reply = String(out?.reply || '').trim()
        || 'I could not produce a clear answer yet. Ask: "what is today stance and why?"';
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: reply,
        source: String(out?.source || 'codex'),
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Command failed: ${String(err?.message || 'unknown error')}`,
        source: 'error',
      }]);
    } finally {
      setSending(false);
    }
  };

  const analyzeChartUpload = async () => {
    if (!chartFile || sending || chartAnalyzing) return;
    const note = String(chartPrompt || '').trim();
    setMessages(prev => [...prev, {
      role: 'user',
      content: note ? `Analyze this chart: ${note}` : 'Analyze this chart upload.',
    }]);
    setChartAnalyzing(true);
    try {
      const form = new FormData();
      form.append('image', chartFile);
      form.append('strategy', strategy);
      if (note) form.append('prompt', note);
      const resp = await fetch('/api/assistant/chart/analyze', {
        method: 'POST',
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.success === false) throw new Error(data?.error || 'chart_analyze_failed');
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: String(data?.response || 'No chart analysis returned.'),
        source: String(data?.source || 'chart_vision'),
      }]);
      setChartPrompt('');
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Chart analysis failed: ${String(err?.message || 'unknown error')}`,
        source: 'error',
      }]);
    } finally {
      setChartAnalyzing(false);
      setChartFile(null);
      setChartInputKey((v) => v + 1);
    }
  };

  React.useEffect(() => {
    if (messages.length > 0) return;
    sendMessage('What is today gameplan and top setup right now?', true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleReset = async () => {
    try {
      await fetch('/api/assistant/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
    } catch {}
    setMessages([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const quickActions = [
    { label: 'Today Gameplan', prompt: 'What is today gameplan and why?' },
    { label: 'Take Setup Now?', prompt: 'Should I take this setup right now?' },
    { label: 'Potential Setups', prompt: 'What potential setups do you see in real time?' },
    { label: 'Live Trade State', prompt: 'Am I in profit and what is my current trade state?' },
    { label: 'Sync Live Data', prompt: 'Sync topstep live data now and refresh.' },
    { label: 'Open Command Intel', prompt: 'Open command intel.' },
    { label: 'Run Health Check', prompt: 'Run doctor.' },
  ];

  const codexProvider = status?.health?.analyst?.provider
    ? String(status.health.analyst.provider).toUpperCase()
    : 'READY';

  return (
    <>
      <Topbar title="CODEX CONSOLE" />
      <div className="content" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', padding: 0 }}>
        <div style={{
          padding: '10px 16px', margin: '12px 16px 0',
          background: 'rgba(249,115,22,0.08)', borderRadius: 'var(--radius)',
          borderLeft: '2px solid var(--accent)',
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-1)',
        }}>
          CODEX ENGINE: {codexProvider}. Live routing is enabled for gameplan, setup scan, and trade-state checks.
        </div>

        <div style={{ padding: '12px 16px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {quickActions.map((qa, i) => (
            <button
              key={i}
              onClick={() => sendMessage(qa.prompt)}
              disabled={sending}
              style={{
                padding: '5px 10px', borderRadius: 'var(--radius)',
                background: 'var(--bg-3)', color: 'var(--text-2)',
                border: '1px solid var(--border-1)', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 10,
              }}
            >
              {qa.label}
            </button>
          ))}
          <button
            onClick={handleReset}
            style={{
              padding: '5px 10px', borderRadius: 'var(--radius)',
              background: 'transparent', color: 'var(--text-4)',
              border: '1px solid var(--border-0)', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 10, marginLeft: 'auto',
            }}
          >
            ↺ Reset
          </button>
        </div>

        <div style={{
          margin: '10px 16px 0',
          padding: '10px 12px',
          border: '1px solid var(--border-1)',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-2)',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr auto',
          gap: 8,
          alignItems: 'center',
        }}>
          <input
            key={chartInputKey}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setChartFile(e.target.files?.[0] || null)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-2)',
            }}
          />
          <input
            value={chartPrompt}
            onChange={(e) => setChartPrompt(e.target.value)}
            placeholder="Optional note: entry idea, level, concern..."
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border-1)',
              background: 'var(--bg-1)',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              outline: 'none',
            }}
          />
          <button
            onClick={analyzeChartUpload}
            disabled={!chartFile || sending || chartAnalyzing}
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--radius)',
              border: 'none',
              background: (!chartFile || sending || chartAnalyzing) ? 'var(--bg-3)' : 'var(--accent)',
              color: (!chartFile || sending || chartAnalyzing) ? 'var(--text-4)' : '#000',
              cursor: (!chartFile || sending || chartAnalyzing) ? 'default' : 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            {chartAnalyzing ? 'ANALYZING...' : 'ANALYZE CHART'}
          </button>
        </div>

        <div style={{
          flex: 1, overflow: 'auto', padding: '12px 16px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {messages.length === 0 && !sending && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-4)' }}>
              <div style={{ fontSize: 24, marginBottom: 12, opacity: 0.3 }}>⬢</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                Codex is ready. Ask in plain English for live guidance or terminal tasks.
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: msg.role === 'user' ? '72%' : '92%',
                padding: '10px 14px',
                borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                background: msg.role === 'user' ? 'var(--accent-dim)' : msg.source === 'error' ? 'var(--red-dim)' : 'var(--bg-3)',
                border: msg.role === 'user' ? '1px solid rgba(249,115,22,0.2)' : '1px solid var(--border-1)',
                fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
                color: msg.source === 'error' ? 'var(--red)' : 'var(--text-1)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {msg.role === 'assistant' && (
                  <div style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
                    {msg.source === 'error' ? 'ERROR' : 'CODEX'}
                  </div>
                )}
                {msg.content}
              </div>
            </div>
          ))}

          {(sending || chartAnalyzing) && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                padding: '10px 14px', borderRadius: '12px 12px 12px 2px',
                background: 'var(--bg-3)', border: '1px solid var(--border-1)',
                fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)',
              }}>
                <div style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>CODEX</div>
                {chartAnalyzing ? 'Analyzing chart...' : 'Thinking...'}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div style={{
          padding: '12px 16px', borderTop: '1px solid var(--border-1)',
          display: 'flex', gap: 8, background: 'var(--bg-1)',
        }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Codex: 'should I take this setup now?', 'run npm test', 'update the design', 'open command intel'..."
            rows={1}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 'var(--radius)',
              background: 'var(--bg-2)', color: 'var(--text-0)',
              border: '1px solid var(--border-1)',
              fontFamily: 'var(--font-mono)', fontSize: 12,
              resize: 'none', outline: 'none', lineHeight: 1.5,
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={sending || chartAnalyzing || !input.trim()}
            style={{
              padding: '10px 20px', borderRadius: 'var(--radius)',
              background: input.trim() ? 'var(--accent)' : 'var(--bg-3)',
              color: input.trim() ? '#000' : 'var(--text-4)',
              border: 'none', cursor: input.trim() ? 'pointer' : 'default',
              fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: 1,
            }}
          >
            SEND
          </button>
        </div>
      </div>
    </>
  );
}

const VOICE_MODULE_ALIASES = [
  { id: 'bridge', names: ['bridge', 'dashboard', 'main board'] },
  { id: 'briefing', names: ['command intel', 'intel', 'briefing', 'command center'] },
  { id: 'analyst', names: ['analyst', 'ai analyst', 'brain', 'codex', 'codex console'] },
  { id: 'system', names: ['system', 'system core', 'status board'] },
  { id: 'lab', names: ['lab', 'research', 'discovery'] },
  { id: 'coach', names: ['coach', 'coach ops'] },
  { id: 'portfolio', names: ['portfolio', 'strategy stack'] },
  { id: 'journal', names: ['journal', 'trade journal'] },
  { id: 'sessions', names: ['sessions', 'session log'] },
  { id: 'adversary', names: ['adversary', 'risk scan'] },
  { id: 'conflicts', names: ['conflicts', 'conflict'] },
  { id: 'breakdown', names: ['breakdown', 'breakdowns'] },
  { id: 'import', names: ['import', 'data import'] },
];

const MODULE_ID_SET = new Set(MODULES.map((m) => String(m.id || '').trim()).filter(Boolean));
const ROUTABLE_ASSISTANT_MODULE_SET = new Set([
  ...Array.from(MODULE_ID_SET),
  ...VOICE_MODULE_ALIASES.map((item) => String(item.id || '').trim().toLowerCase()).filter(Boolean),
  'analyst',
]);

function normalizeDashboardModuleId(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  return MODULE_ID_SET.has(raw) ? raw : '';
}

function normalizeAssistantModuleId(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  return ROUTABLE_ASSISTANT_MODULE_SET.has(raw) ? raw : '';
}

function normalizeVoiceText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isRealtimeVoiceMarketIntent(text) {
  const t = normalizeVoiceText(text);
  return /\b(should i take|should i enter|enter now|take this|buy or sell|long or short|should i trade|market|mnq|price|setup|outlook|gameplan|in profit|trade status|open trade|live|right now|current)\b/.test(t);
}

function stripForSpeech(text) {
  return String(text || '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function previewVoiceText(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractVoiceLabelMeta(text) {
  const src = String(text || '');
  const lines = src.split(/\n+/).map((s) => String(s || '').trim()).filter(Boolean);
  const sigLine = lines.find((line) => /\[(TRADE|WAIT|DON['’]T TRADE)\]|^(TRADE|WAIT|DON['’]T TRADE)\b/i.test(line)) || '';
  const decisionLine = lines.find((line) => /\b(decision|stance|signal)\b/i.test(line)) || '';
  const labelFields = [];
  if (/\bDON['’]T TRADE\b/i.test(src)) labelFields.push("DON'T TRADE");
  if (/\bWAIT:\s*/i.test(src)) labelFields.push('WAIT:');
  if (/\bTRADE\.\s*/i.test(src)) labelFields.push('TRADE.');
  if (/\[[^\]]+\]/.test(src)) labelFields.push('BRACKET_LABEL');
  return { sigLine, decisionLine, labelFields };
}

function findModuleByVoice(text) {
  const t = normalizeVoiceText(text);
  for (const item of VOICE_MODULE_ALIASES) {
    if (item.names.some((n) => t.includes(n))) return item.id;
  }
  return null;
}

function shouldRouteVoiceToAnalyst(text, activeModule) {
  const currentModule = normalizeAssistantModuleId(activeModule);
  if (currentModule === 'analyst') return true;
  const t = normalizeVoiceText(text);
  if (!t) return false;
  if (/\b(open|show|go to)\b/.test(t) && findModuleByVoice(t)) return false;
  return /\b(stay out|sit out|stand down|avoid the market|good day to stay out|was it right to stay out|should i stay out|should i sit out|outlook|gameplan|should i trade|should i enter|take this setup|enter now|buy or sell|long or short|mnq|market|price|setup|trade status|in profit|risk|blockers?)\b/.test(t);
}

function VoiceCopilot({
  activeModule,
  strategy,
  onSelectModule,
  marketHealth,
  marketHealthError,
  marketHealthLastSuccessAt,
}) {
  const VOICE_SERVER_TIMEOUT_MS = 4500;
  const LOCKED_VOICE_PROVIDER = 'edge_tts';
  const LOCKED_VOICE_PROFILE = 'jarvis_prime';
  const [supported, setSupported] = useState({ recognition: false, speech: false });
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voicePlaybackPaused, setVoicePlaybackPaused] = useState(false);
  const [micPermission, setMicPermission] = useState('unknown');
  const autoSpeak = true;
  const [lastHeard, setLastHeard] = useState('');
  const [interimHeard, setInterimHeard] = useState('');
  const [lastReply, setLastReply] = useState('Say: "today outlook", "open bridge", or "run topstep sync".');
  const [lastJarvisTools, setLastJarvisTools] = useState('');
  const [jarvisRouteState, setJarvisRouteState] = useState({
    status: 'jarvis',
    endpoint: '/api/jarvis/query',
    routePathTag: 'jarvis_orchestrator',
    traceId: '',
    reason: '',
  });
  const [voiceProfiles, setVoiceProfiles] = useState([]);
  const [voiceProfile, setVoiceProfile] = useState(LOCKED_VOICE_PROFILE);
  const [voiceBriefMode, setVoiceBriefMode] = useState('earbud');
  const [healthAudioAlertEnabled, setHealthAudioAlertEnabled] = useState(() => getStoredHealthAudioAlertEnabled());
  const [sendLocationHint, setSendLocationHint] = useState(() => getStoredVoiceLocationHintEnabled());
  const [userLocationHint, setUserLocationHint] = useState(null);
  const [jarvisConsentState, setJarvisConsentState] = useState({
    pending: false,
    kind: null,
    needLocation: false,
  });
  const [phoneLinkUrl, setPhoneLinkUrl] = useState('');
  const [showPhoneLinkModal, setShowPhoneLinkModal] = useState(false);
  const [phoneLocationStatus, setPhoneLocationStatus] = useState({
    hasLocation: false,
    ageSeconds: null,
    ttlSecondsRemaining: 0,
    lastLocation: null,
  });
  const [phoneLocationStatusError, setPhoneLocationStatusError] = useState('');
  const [voiceBackend, setVoiceBackend] = useState({
    provider: 'browser',
    openaiConfigured: false,
    localProvider: null,
    browserFallbackEnabled: false,
  });
  const [error, setError] = useState('');
  const [complaintNotes, setComplaintNotes] = useState('');
  const [complaintStatus, setComplaintStatus] = useState('');
  const [lastInteractionMeta, setLastInteractionMeta] = useState({
    prompt: '',
    reply: '',
    traceId: '',
    intent: '',
    selectedSkill: '',
    routePath: '',
    toolsUsed: [],
  });
  const recognitionRef = useRef(null);
  const keepListeningRef = useRef(false);
  const manualMicPauseRef = useRef(false);
  const speakingRef = useRef(false);
  const mutedRef = useRef(false);
  const manualVoicePauseRef = useRef(false);
  const micPausedForPlaybackRef = useRef(false);
  const audioRef = useRef(null);
  const micProbeStreamRef = useRef(null);
  const greetedRef = useRef(false);
  const lastUtteranceRef = useRef({ text: '', at: 0 });
  const lastSpokenRef = useRef({ text: '', at: 0 });
  const utteranceSeqRef = useRef(0);
  const requestSeqRef = useRef(0);
  const assistantSessionIdRef = useRef(getAssistantSessionId());
  const assistantClientIdRef = useRef(getAssistantClientId());
  const audioUnlockedRef = useRef(false);
  const pendingSpeechRef = useRef(null);
  const flushPendingSpeechRef = useRef(() => {});
  const greetingPlaybackStartedRef = useRef(false);
  const autoStartInFlightRef = useRef(false);
  const userInteractedRef = useRef(false);
  const bargeInTriggeredRef = useRef(false);
  const healthAudioCtxRef = useRef(null);
  const prevMarketHealthStatusRef = useRef(normalizeHealthStatus(marketHealth?.status || ''));
  const recognitionRestartTimerRef = useRef(null);
  const recognitionStartFailCountRef = useRef(0);

  const commitVoiceReply = useCallback((text, source = 'unknown', extra = {}) => {
    const hintIntent = String(extra?.traceMeta?.intent || '').trim().toLowerCase();
    const nextRaw = String(text || '').trim();
    const next = normalizeTransportFailureReason(nextRaw, hintIntent || 'general');
    setLastReply(next);
    const meta = extractVoiceLabelMeta(next);
    const renderedReply = String(extra.replyText ?? next);
    const traceMeta = extra?.traceMeta && typeof extra.traceMeta === 'object' ? extra.traceMeta : {};
    console.log(
      `[VOICE_RENDER_TRACE] spokenText=${previewVoiceText(next)} spokenTextSource=${source} reply=${previewVoiceText(renderedReply)} sigLine=${previewVoiceText(meta.sigLine)} decisionLine=${previewVoiceText(meta.decisionLine)} labelFields=${JSON.stringify(meta.labelFields)}`
    );
    logVoiceAudit('voice_render', {
      traceId: String(traceMeta.traceId || '').trim() || null,
      endpoint: String(traceMeta.endpoint || '/client/voice/render'),
      intent: String(traceMeta.intent || 'unknown'),
      toolsUsed: Array.isArray(traceMeta.toolsUsed) ? traceMeta.toolsUsed : [],
      voiceMode: true,
      voiceBriefMode: String(traceMeta.voiceBriefMode || 'earbud'),
      finalReplyPreview: previewVoiceText(renderedReply),
      source: String(traceMeta.source || source || 'voice_render'),
      mode: String(traceMeta.mode || 'voice_render'),
      routePathTag: String(traceMeta.routePathTag || traceMeta.routePath || traceMeta.source || source || 'voice_render'),
      didEarbudFinalize: traceMeta.didEarbudFinalize === true,
      invariantsPass: traceMeta.invariantsPass === true,
      failedRules: Array.isArray(traceMeta.failedRules) ? traceMeta.failedRules : [],
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HEALTH_AUDIO_ALERT_STORAGE_KEY, healthAudioAlertEnabled ? 'true' : 'false');
    } catch {}
  }, [healthAudioAlertEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(VOICE_LOCATION_HINT_STORAGE_KEY, sendLocationHint ? 'true' : 'false');
    } catch {}
  }, [sendLocationHint]);

  useEffect(() => {
    if (!sendLocationHint) {
      setUserLocationHint(null);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setUserLocationHint(null);
      return;
    }
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        const lat = Number(pos?.coords?.latitude);
        const lon = Number(pos?.coords?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          setUserLocationHint(null);
          return;
        }
        setUserLocationHint({
          lat,
          lon,
          accuracyMeters: Number.isFinite(Number(pos?.coords?.accuracy)) ? Number(pos.coords.accuracy) : null,
          capturedAt: new Date().toISOString(),
        });
      },
      () => {
        if (cancelled) return;
        setUserLocationHint(null);
      },
      {
        enableHighAccuracy: false,
        maximumAge: 60 * 1000,
        timeout: 5000,
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sendLocationHint]);

  const refreshPhoneLocationStatus = useCallback(async () => {
    const sessionId = String(assistantSessionIdRef.current || '').trim();
    if (!sessionId) return null;
    try {
      const qs = new URLSearchParams({
        sessionId,
        clientId: String(assistantClientIdRef.current || sessionId || '').trim() || sessionId,
      });
      const resp = await fetch(`/api/jarvis/location/status?${qs.toString()}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data) throw new Error(String(data?.error || `HTTP ${resp.status}`));
      setPhoneLocationStatus({
        hasLocation: data.hasLocation === true,
        ageSeconds: Number.isFinite(Number(data.ageSeconds)) ? Number(data.ageSeconds) : null,
        ttlSecondsRemaining: Number.isFinite(Number(data.ttlSecondsRemaining)) ? Number(data.ttlSecondsRemaining) : 0,
        lastLocation: data.lastLocation && typeof data.lastLocation === 'object' ? data.lastLocation : null,
      });
      if (data.phoneLinkUrl) {
        setPhoneLinkUrl(String(data.phoneLinkUrl));
      }
      setPhoneLocationStatusError('');
      return data;
    } catch (err) {
      setPhoneLocationStatusError(String(err?.message || 'status_unavailable'));
      return null;
    }
  }, []);

  useEffect(() => {
    refreshPhoneLocationStatus();
    const timer = setInterval(() => {
      refreshPhoneLocationStatus();
    }, 20_000);
    return () => clearInterval(timer);
  }, [refreshPhoneLocationStatus]);

  const recognitionCtor = () => {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  };

  const unlockAudioPlayback = useCallback(async () => {
    if (audioUnlockedRef.current) return true;
    if (typeof window === 'undefined') return false;
    try {
      const unlockTone = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=');
      unlockTone.volume = 0;
      await unlockTone.play();
      unlockTone.pause();
      unlockTone.src = '';
      audioUnlockedRef.current = true;
      return true;
    } catch {
      return false;
    }
  }, []);

  const playHealthAlertTone = useCallback(async (toneType = 'degraded') => {
    if (typeof window === 'undefined') return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      if (!healthAudioCtxRef.current) {
        healthAudioCtxRef.current = new AudioCtx();
      }
      const ctx = healthAudioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const baseFreq = toneType === 'recovered' ? 860 : 520;
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.linearRampToValueAtTime(toneType === 'recovered' ? 980 : 420, now + 0.16);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.04, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.22);
      osc.onended = () => {
        try { osc.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshMicPermission = useCallback(async () => {
    if (typeof navigator === 'undefined') return;
    try {
      if (!navigator.permissions?.query) return;
      const p = await navigator.permissions.query({ name: 'microphone' });
      const state = String(p?.state || 'unknown');
      setMicPermission(state);
    } catch {}
  }, []);

  const requestMicAccess = useCallback(async (options = {}) => {
    const silent = options.silent === true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      if (!silent) setError('Microphone APIs are not available in this browser.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicPermission('granted');
      const unlocked = await unlockAudioPlayback();
      if (unlocked) flushPendingSpeechRef.current?.();
      if (micProbeStreamRef.current) {
        try { micProbeStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      }
      micProbeStreamRef.current = stream;
      setTimeout(() => {
        const probe = micProbeStreamRef.current;
        if (probe) {
          try { probe.getTracks().forEach((t) => t.stop()); } catch {}
          micProbeStreamRef.current = null;
        }
      }, 1200);
      return true;
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('denied') || msg.includes('notallowed') || err?.name === 'NotAllowedError') {
        setMicPermission('denied');
        if (!silent) {
          setError('Microphone blocked for this site. Enable mic in browser site settings, then press "Enable Mic Access".');
        }
      } else if (!silent) {
        setError('Unable to initialize microphone. Check your device audio input and browser permissions.');
      }
      return false;
    }
  }, []);

  useEffect(() => {
    const hasRecognition = !!recognitionCtor();
    const hasSpeech = typeof window !== 'undefined' && !!window.speechSynthesis;
    setSupported({ recognition: hasRecognition, speech: hasSpeech });
    refreshMicPermission();
    requestMicAccess({ silent: true });
    fetch(`/api/command/snapshot?strategy=${strategy === 'alt' ? 'alt' : 'original'}`).catch(() => {});
    fetch(`/api/system/status?strategy=${strategy === 'alt' ? 'alt' : 'original'}`).catch(() => {});
    fetch('/api/assistant/voice/status')
      .then((r) => r.json())
      .then((d) => {
        if (!d || typeof d !== 'object') return;
        const profiles = Array.isArray(d.voiceProfiles) ? d.voiceProfiles : [];
        setVoiceProfiles(profiles);
        const warmProfile = LOCKED_VOICE_PROFILE;
        setVoiceProfile(LOCKED_VOICE_PROFILE);
        setVoiceBackend({
          provider: String(d.provider || 'browser'),
          openaiConfigured: !!d.openaiConfigured,
          localProvider: d.localProvider ? String(d.localProvider) : null,
          browserFallbackEnabled: d.browserFallbackEnabled === true,
        });
        // Warm greeting synthesis so first spoken response is instant on load.
        fetch('/api/assistant/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Hello boss, what is on your mind today?',
            provider: LOCKED_VOICE_PROVIDER,
            profile: warmProfile,
          }),
        }).catch(() => {});
      })
      .catch(() => {});
  }, [refreshMicPermission, requestMicAccess, strategy, LOCKED_VOICE_PROFILE]);

  const stopListening = useCallback((options = {}) => {
    const manualPause = options.manualPause !== false;
    if (manualPause) {
      manualMicPauseRef.current = true;
    }
    keepListeningRef.current = false;
    micPausedForPlaybackRef.current = false;
    recognitionStartFailCountRef.current = 0;
    if (recognitionRestartTimerRef.current) {
      clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    }
    setListening(false);
    setInterimHeard('');
  }, []);

  const stopVoicePlayback = useCallback((options = {}) => {
    const cancelRequest = options.cancelRequest !== false;
    const clearManualPause = options.clearManualPause !== false;
    if (cancelRequest) requestSeqRef.current += 1;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch {}
      audioRef.current = null;
    }
    if (clearManualPause) manualVoicePauseRef.current = false;
    micPausedForPlaybackRef.current = false;
    bargeInTriggeredRef.current = false;
    setVoicePlaybackPaused(false);
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const pauseVoicePlayback = useCallback(() => {
    manualVoicePauseRef.current = true;
    let paused = false;
    if (audioRef.current) {
      try {
        if (!audioRef.current.paused) {
          audioRef.current.pause();
          paused = true;
        }
      } catch {}
    }
    if (!paused && typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.pause();
          paused = true;
        }
      } catch {}
    }
    speakingRef.current = false;
    setSpeaking(false);
    setVoicePlaybackPaused(true);
    return paused || true;
  }, []);

  const resumeVoicePlayback = useCallback(async () => {
    manualVoicePauseRef.current = false;
    let resumed = false;
    if (audioRef.current) {
      try {
        if (audioRef.current.paused) {
          await audioRef.current.play();
          resumed = true;
        }
      } catch {}
    }
    if (!resumed && typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        if (window.speechSynthesis.paused || window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.resume();
          resumed = true;
        }
      } catch {}
    }
    if (!resumed && pendingSpeechRef.current) {
      setVoicePlaybackPaused(false);
      const flush = flushPendingSpeechRef.current;
      if (typeof flush === 'function') {
        setTimeout(() => { flush(); }, 20);
        return true;
      }
      return true;
    }
    if (resumed) {
      speakingRef.current = true;
      setSpeaking(true);
      setVoicePlaybackPaused(false);
    }
    return resumed;
  }, []);

  const resumeListeningAfterSpeech = useCallback((shouldResume) => {
    speakingRef.current = false;
    micPausedForPlaybackRef.current = false;
    setSpeaking(false);
    setVoicePlaybackPaused(false);
    if (shouldResume && keepListeningRef.current) {
      setTimeout(() => {
        const rec2 = recognitionRef.current;
        if (rec2) {
          try { rec2.start(); } catch {}
        }
      }, 120);
    }
  }, []);

  const isLikelyAssistantEcho = useCallback((value) => {
    const sample = normalizeVoiceText(value).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sample || sample.length < 6) return false;
    const spoken = normalizeVoiceText(lastSpokenRef.current.text || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!spoken) return false;
    if (spoken.includes(sample)) return true;
    const sampleWords = sample.split(' ').filter((w) => w.length > 2);
    if (sampleWords.length < 3) return false;
    let hitCount = 0;
    for (const w of sampleWords) {
      if (spoken.includes(w)) hitCount += 1;
    }
    return (hitCount / sampleWords.length) >= 0.75;
  }, []);

  const speakReply = useCallback((text, options = {}) => {
    if (mutedRef.current || muted) return;
    const replyText = String(options.replyText ?? text ?? '').trim();
    const spokenTextSource = String(options.spokenTextSource || 'unknown');
    const traceMeta = options?.traceMeta && typeof options.traceMeta === 'object' ? options.traceMeta : {};
    const traceId = String(options.traceId || traceMeta.traceId || '').trim() || null;
    const useExactReply = options.useExactReply === true || normalizeDashboardModuleId(activeModule) === 'analyst';
    const preparedText = useExactReply ? replyText : stripForSpeech(text);
    const content = useExactReply ? preparedText : preparedText.slice(0, 800);
    if (!content) return;
    if (manualVoicePauseRef.current) {
      pendingSpeechRef.current = {
        text: content,
        options: {
          pauseListening: false,
          spokenTextSource: `${spokenTextSource}.manual_pause`,
          replyText,
          useExactReply,
          traceId,
          traceMeta,
        },
      };
      speakingRef.current = false;
      setSpeaking(false);
      setVoicePlaybackPaused(true);
      return;
    }
    const labelMeta = extractVoiceLabelMeta(replyText);
    console.log(
      `[VOICE_SPEAK_TRACE] spokenText=${previewVoiceText(content)} spokenTextSource=${spokenTextSource} reply=${previewVoiceText(replyText)} sigLine=${previewVoiceText(labelMeta.sigLine)} decisionLine=${previewVoiceText(labelMeta.decisionLine)} labelFields=${JSON.stringify(labelMeta.labelFields)}`
    );
    logVoiceAudit('voice_speak_enqueue', {
      traceId,
      endpoint: '/api/assistant/voice/speak',
      intent: String(traceMeta.intent || 'unknown'),
      toolsUsed: Array.isArray(traceMeta.toolsUsed) ? traceMeta.toolsUsed : [],
      voiceMode: true,
      voiceBriefMode: String(traceMeta.voiceBriefMode || voiceBriefMode || 'earbud'),
      finalReplyPreview: previewVoiceText(replyText),
      source: String(traceMeta.source || spokenTextSource || 'voice_speak'),
      mode: String(traceMeta.mode || 'voice_speak'),
      routePathTag: String(traceMeta.routePathTag || traceMeta.routePath || traceMeta.source || 'voice_speak'),
      didEarbudFinalize: traceMeta.didEarbudFinalize === true,
      invariantsPass: traceMeta.invariantsPass === true,
      failedRules: Array.isArray(traceMeta.failedRules) ? traceMeta.failedRules : [],
    });
    const allowBrowserFallback = options.allowBrowserFallback === true || voiceBackend.browserFallbackEnabled;
    const onPlaybackStart = typeof options.onPlaybackStart === 'function' ? options.onPlaybackStart : null;
    const spokenNorm = normalizeVoiceText(content);
    const nowSpoken = Date.now();
    if (lastSpokenRef.current.text === spokenNorm && (nowSpoken - lastSpokenRef.current.at) < 1800) {
      return;
    }
    lastSpokenRef.current = { text: spokenNorm, at: nowSpoken };
    const requestId = requestSeqRef.current + 1;
    stopVoicePlayback();
    requestSeqRef.current = requestId;
    bargeInTriggeredRef.current = false;
    const shouldPauseListening = options.pauseListening === true;
    const shouldResume = keepListeningRef.current && shouldPauseListening;
    if (shouldPauseListening) {
      micPausedForPlaybackRef.current = true;
      const rec = recognitionRef.current;
      if (rec) {
        try { rec.stop(); } catch {}
      }
      setListening(false);
    }
    const speakWithBrowser = () => {
      if (requestId !== requestSeqRef.current) return;
      if (!allowBrowserFallback) {
        resumeListeningAfterSpeech(shouldResume);
        return;
      }
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resumeListeningAfterSpeech(shouldResume);
        return;
      }
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
        const availableVoices = window.speechSynthesis.getVoices() || [];
        const utter = new SpeechSynthesisUtterance(content);
        const selected = availableVoices.find((v) => /(ryan|daniel|alex|aaron|david|male|uk english male)/i.test(v.name))
          || availableVoices.find((v) => /^en[-_](gb|us)/i.test(v.lang))
          || availableVoices.find((v) => /^en(-|_)/i.test(v.lang))
          || availableVoices[0];
        if (selected) utter.voice = selected;
        utter.rate = 0.94;
        utter.pitch = 0.92;
        utter.onstart = () => {
          if (requestId !== requestSeqRef.current) return;
          if (onPlaybackStart) {
            try { onPlaybackStart(); } catch {}
          }
          speakingRef.current = true;
          setVoicePlaybackPaused(false);
          setSpeaking(true);
        };
        utter.onend = () => {
          if (requestId !== requestSeqRef.current) return;
          resumeListeningAfterSpeech(shouldResume);
        };
        utter.onerror = () => {
          if (requestId !== requestSeqRef.current) return;
          resumeListeningAfterSpeech(shouldResume);
        };
        window.speechSynthesis.speak(utter);
      } catch {
        resumeListeningAfterSpeech(shouldResume);
      }
    };

    (async () => {
      speakingRef.current = true;
      setVoicePlaybackPaused(false);
      setSpeaking(true);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VOICE_SERVER_TIMEOUT_MS);
      try {
        const resp = await fetch('/api/assistant/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: content,
            replyText,
            spokenTextSource,
            traceId,
            routePathTag: String(traceMeta.routePathTag || traceMeta.routePath || traceMeta.source || 'voice_speak'),
            intent: String(traceMeta.intent || 'unknown'),
            provider: LOCKED_VOICE_PROVIDER,
            profile: LOCKED_VOICE_PROFILE,
          }),
          signal: controller.signal,
        });
        const data = await resp.json().catch(() => ({}));
        console.log(
          `[VOICE_TTS_CLIENT_TRACE] spokenText=${previewVoiceText(content)} spokenTextSource=${spokenTextSource} reply=${previewVoiceText(replyText)} serverEqualsReply=${String(data?.debugTrace?.equalsReply ?? '')} serverTextSha1=${String(data?.debugTrace?.textSha1 ?? '')} serverReplySha1=${String(data?.debugTrace?.replySha1 ?? '')} serverTextLen=${String(data?.debugTrace?.textLen ?? '')} serverReplyLen=${String(data?.debugTrace?.replyLen ?? '')}`
        );
        logVoiceAudit('voice_tts_response', {
          traceId: String(data?.debugTrace?.traceId || traceId || '').trim() || null,
          endpoint: '/api/assistant/voice/speak',
          intent: String(traceMeta.intent || 'unknown'),
          toolsUsed: Array.isArray(traceMeta.toolsUsed) ? traceMeta.toolsUsed : [],
          voiceMode: true,
          voiceBriefMode: String(traceMeta.voiceBriefMode || voiceBriefMode || 'earbud'),
          finalReplyPreview: previewVoiceText(replyText),
          source: String(traceMeta.source || 'assistant_voice_tts'),
          mode: String(traceMeta.mode || 'voice_speak'),
          routePathTag: String(traceMeta.routePathTag || traceMeta.routePath || traceMeta.source || 'voice_speak'),
          didEarbudFinalize: traceMeta.didEarbudFinalize === true,
          invariantsPass: traceMeta.invariantsPass === true,
          failedRules: Array.isArray(traceMeta.failedRules) ? traceMeta.failedRules : [],
          serverEqualsReply: data?.debugTrace?.equalsReply === true,
        });
        if (requestId !== requestSeqRef.current) return;
        if (data?.provider) {
          setVoiceBackend((prev) => ({
            ...prev,
            provider: String(data.provider || prev.provider || 'browser'),
            browserFallbackEnabled: data.browserFallbackEnabled === true ? true : prev.browserFallbackEnabled,
          }));
        }
        if (resp.ok && data?.success && data?.audioBase64) {
          const mime = String(data.mimeType || 'audio/mpeg');
          const src = `data:${mime};base64,${data.audioBase64}`;
          if (audioRef.current) {
            try { audioRef.current.pause(); } catch {}
            audioRef.current = null;
          }
          const audio = new Audio(src);
          audioRef.current = audio;
          audio.onended = () => {
            if (requestId !== requestSeqRef.current) return;
            audioRef.current = null;
            setVoicePlaybackPaused(false);
            resumeListeningAfterSpeech(shouldResume);
          };
          audio.onerror = () => {
            if (requestId !== requestSeqRef.current) return;
            audioRef.current = null;
            setVoicePlaybackPaused(false);
            speakWithBrowser();
          };
          try {
            await audio.play();
            audioUnlockedRef.current = true;
            setVoicePlaybackPaused(false);
            if (onPlaybackStart) {
              try { onPlaybackStart(); } catch {}
            }
            return;
          } catch (playErr) {
            if (requestId !== requestSeqRef.current) return;
            audioRef.current = null;
            const playMsg = String(playErr?.name || playErr?.message || '').toLowerCase();
            const autoplayBlocked = !audioUnlockedRef.current
              || playMsg.includes('notallowed')
              || playMsg.includes('gesture')
              || playMsg.includes('autoplay');
            if (autoplayBlocked) {
              if (allowBrowserFallback) {
                speakWithBrowser();
                return;
              }
              pendingSpeechRef.current = {
                text: content,
                options: {
                  pauseListening: false,
                  spokenTextSource: `${spokenTextSource}.pending`,
                  replyText,
                  useExactReply,
                },
              };
              setError('Tap anywhere once to enable voice playback.');
              resumeListeningAfterSpeech(shouldResume);
              return;
            }
          }
        }
      } catch {}
      finally {
        clearTimeout(timeout);
      }
      if (requestId !== requestSeqRef.current) return;
      speakWithBrowser();
    })();
  }, [LOCKED_VOICE_PROFILE, muted, resumeListeningAfterSpeech, stopVoicePlayback, voiceBackend.browserFallbackEnabled, VOICE_SERVER_TIMEOUT_MS, activeModule, voiceBriefMode]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    if (!muted) return;
    manualVoicePauseRef.current = false;
    pendingSpeechRef.current = null;
    stopVoicePlayback({ cancelRequest: false });
  }, [muted, stopVoicePlayback]);

  useEffect(() => {
    const nextStatus = normalizeHealthStatus(marketHealth?.status || '');
    if (!nextStatus) return;
    const prevStatus = normalizeHealthStatus(prevMarketHealthStatusRef.current || '');
    if (prevStatus && shouldEmitHealthAudioTransition(prevStatus, nextStatus)) {
      const toneType = healthAudioToneType(prevStatus, nextStatus) || 'degraded';
      if (healthAudioAlertEnabled && userInteractedRef.current && audioUnlockedRef.current) {
        playHealthAlertTone(toneType).then((played) => {
          console.log(`[VOICE_HEALTH_ALERT] transition=${prevStatus}->${nextStatus} tone=${toneType} played=${played ? 1 : 0}`);
        });
      } else {
        const reason = !healthAudioAlertEnabled
          ? 'disabled'
          : (!userInteractedRef.current ? 'no_user_interaction' : 'audio_locked');
        console.log(`[VOICE_HEALTH_ALERT] transition=${prevStatus}->${nextStatus} tone=${toneType} played=0 reason=${reason}`);
      }
    }
    prevMarketHealthStatusRef.current = nextStatus;
  }, [healthAudioAlertEnabled, marketHealth?.status, playHealthAlertTone]);

  useEffect(() => {
    flushPendingSpeechRef.current = () => {
      if (!pendingSpeechRef.current) return;
      const pending = pendingSpeechRef.current;
      pendingSpeechRef.current = null;
      setError('');
      const text = String(pending?.text || '').trim();
      if (!text) return;
      setTimeout(() => {
        speakReply(text, pending?.options || {
          pauseListening: false,
          spokenTextSource: 'pendingSpeech.text',
          replyText: text,
        });
      }, 20);
    };
    return () => {
      flushPendingSpeechRef.current = () => {};
    };
  }, [speakReply]);

  useEffect(() => {
    const unlockAudio = async () => {
      userInteractedRef.current = true;
      const unlocked = await unlockAudioPlayback();
      if (unlocked) flushPendingSpeechRef.current?.();
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [speakReply, unlockAudioPlayback]);

  const runAssistantQuery = useCallback(async (message, options = {}) => {
    const contextHint = normalizeAssistantModuleId(options.moduleOverride)
      || normalizeAssistantModuleId(activeModule)
      || String(activeModule || '').trim()
      || 'bridge';
    const traceId = String(options.traceId || '').trim() || generateVoiceTraceId();
    const looksTrading = shouldRouteVoiceToAnalyst(message, contextHint) || isRealtimeVoiceMarketIntent(message);
    const controller = new AbortController();
    const defaultTimeout = options.preferCachedLive === true ? 5000 : 9000;
    const timer = setTimeout(() => controller.abort(), Math.max(1100, Number(options.timeoutMs || defaultTimeout)));
    try {
      const url = '/api/jarvis/query';
      const body = {
        traceId,
        message,
        strategy,
        activeModule: contextHint,
        contextHint,
        preferCachedLive: options.preferCachedLive === true,
        voiceMode: true,
        voiceBriefMode,
        sessionId: assistantSessionIdRef.current,
        clientId: assistantClientIdRef.current,
        userLocationHint: sendLocationHint && userLocationHint
          ? {
            lat: Number(userLocationHint.lat),
            lon: Number(userLocationHint.lon),
          }
          : null,
      };
      logVoiceAudit('voice_submit_request', {
        traceId,
        endpoint: url,
        intent: 'unknown',
        toolsUsed: [],
        voiceMode: true,
        voiceBriefMode,
        finalReplyPreview: '',
        source: 'voice_copilot_submit',
        mode: 'request',
        routePathTag: 'client.voice.submit',
      });
      console.log(`[VOICE_COPILOT_TRACE] request url=${url} body=${JSON.stringify(body)}`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await resp.text();
      const responseText = String(raw || '').slice(0, 250);
      const sanitizedHeader = resp.headers.get('X-Analyst-Sanitized');
      console.log(`[VOICE_COPILOT_TRACE] response url=${url} status=${resp.status} sanitizedHeader=${sanitizedHeader} responseText=${responseText}`);
      let data = {};
      try {
        data = JSON.parse(raw || '{}');
      } catch {
        data = {};
      }
      if (!resp.ok || data?.success === false) throw new Error(data?.error || 'Assistant query failed.');
      data.__trace = { url, status: resp.status, sanitizedHeader, responseText };
      const source = String(data?.source || '').trim().toLowerCase();
      const mode = String(data?.mode || '').trim().toLowerCase();
      const routeState = source.includes('fallback') || mode.includes('fallback')
        ? {
          status: 'unavailable',
          endpoint: '/api/jarvis/query',
          routePathTag: String(data?.routePathTag || data?.routePath || source || 'jarvis_transport_unavailable'),
          traceId: String(data?.traceId || traceId),
          reason: 'Jarvis returned a fallback payload. Retry in a moment.',
        }
        : {
          status: 'jarvis',
          endpoint: '/api/jarvis/query',
          routePathTag: String(data?.routePathTag || data?.routePath || source || 'jarvis_orchestrator'),
          traceId: String(data?.traceId || traceId),
          reason: '',
        };
      setJarvisRouteState(routeState);
      logVoiceAudit('voice_submit_response', {
        traceId: String(data?.traceId || traceId),
        endpoint: url,
        intent: String(data?.intent || 'unknown'),
        toolsUsed: Array.isArray(data?.toolsUsed) ? data.toolsUsed : [],
        voiceMode: true,
        voiceBriefMode,
        finalReplyPreview: previewVoiceText(String(data?.reply || '')),
        source: String(data?.source || 'jarvis_orchestrator'),
        mode: String(data?.mode || 'jarvis'),
        routePathTag: String(data?.routePathTag || data?.routePath || data?.source || 'jarvis_orchestrator'),
        didEarbudFinalize: data?.didEarbudFinalize === true,
        invariantsPass: data?.invariantsPass === true || data?.invariants?.pass === true,
        failedRules: Array.isArray(data?.invariants?.failedRules) ? data.invariants.failedRules : [],
      });
      return data;
    } catch (err) {
      const errName = String(err?.name || '').toLowerCase();
      const errMsg = String(err?.message || '').toLowerCase();
      const retriable = errName === 'aborterror'
        || errMsg.includes('failed to fetch')
        || errMsg.includes('networkerror')
        || errMsg.includes('network request failed')
        || errMsg.includes('load failed');
      if (retriable && options.retryAttempted !== true) {
        return runAssistantQuery(message, {
          ...options,
          retryAttempted: true,
          preferCachedLive: false,
          timeoutMs: Math.max(9000, Number(options.timeoutMs || 0)),
        });
      }
      const reason = normalizeTransportFailureReason(
        String(err?.message || err || 'jarvis_query_failed'),
        looksTrading ? 'trading_decision' : 'general_chat'
      );
      setJarvisRouteState({
        status: 'unavailable',
        endpoint: '/api/jarvis/query',
        routePathTag: 'client.voice.transport_unavailable',
        traceId,
        reason,
      });
      logVoiceAudit('voice_submit_transport_unavailable', {
        traceId,
        endpoint: '/api/jarvis/query',
        intent: looksTrading ? 'trading_decision' : 'general_chat',
        toolsUsed: [],
        voiceMode: true,
        voiceBriefMode,
        finalReplyPreview: '',
        source: 'voice_copilot_submit',
        mode: 'error',
        routePathTag: 'client.voice.transport_unavailable',
        didEarbudFinalize: false,
        invariantsPass: false,
        failedRules: ['jarvis_transport_unavailable'],
        error: String(err?.message || err || 'jarvis_query_failed'),
      });
      throw new Error(reason || 'Jarvis is unavailable right now. Please retry.');
    } finally {
      clearTimeout(timer);
    }
  }, [activeModule, strategy, voiceBriefMode, sendLocationHint, userLocationHint]);

  const applyClientActions = useCallback((actions) => {
    if (!Array.isArray(actions)) return;
    for (const action of actions) {
      if (String(action?.type || '') === 'open_module' && action?.module) {
        onSelectModule(action.module);
      }
    }
  }, [onSelectModule]);

  const submitVoiceComplaint = useCallback(async () => {
    const prompt = String(lastInteractionMeta.prompt || lastHeard || '').trim();
    const reply = String(lastInteractionMeta.reply || lastReply || '').trim();
    if (!prompt || !reply) {
      setComplaintStatus('Need a prompt and reply before logging a complaint.');
      return;
    }
    try {
      const body = {
        prompt,
        reply,
        notes: String(complaintNotes || '').trim(),
        traceId: String(lastInteractionMeta.traceId || jarvisRouteState.traceId || '').trim() || null,
        intent: String(lastInteractionMeta.intent || '').trim() || null,
        selectedSkill: String(lastInteractionMeta.selectedSkill || '').trim() || null,
        routePath: String(lastInteractionMeta.routePath || '').trim() || null,
        toolsUsed: Array.isArray(lastInteractionMeta.toolsUsed) ? lastInteractionMeta.toolsUsed : [],
        sessionId: String(assistantSessionIdRef.current || '').trim() || null,
        clientId: String(assistantClientIdRef.current || '').trim() || null,
      };
      const resp = await fetch('/api/jarvis/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.success === false) {
        throw new Error(String(data?.error || `HTTP ${resp.status}`));
      }
      const id = Number(data?.complaintId || 0) || null;
      setComplaintStatus(id ? `Complaint logged (#${id}).` : 'Complaint logged.');
      setComplaintNotes('');
    } catch (err) {
      setComplaintStatus(`Complaint log failed: ${String(err?.message || 'request_failed')}`);
    }
  }, [
    complaintNotes,
    jarvisRouteState.traceId,
    lastHeard,
    lastInteractionMeta,
    lastReply,
  ]);

  const copyLatestComplaint = useCallback(async () => {
    const tools = Array.isArray(lastInteractionMeta.toolsUsed) ? lastInteractionMeta.toolsUsed.join(', ') : '';
    const text = [
      `Prompt: ${String(lastInteractionMeta.prompt || lastHeard || '').trim() || '-'}`,
      `Reply: ${String(lastInteractionMeta.reply || lastReply || '').trim() || '-'}`,
      `Trace: ${String(lastInteractionMeta.traceId || jarvisRouteState.traceId || '').trim() || '-'}`,
      `Intent: ${String(lastInteractionMeta.intent || '').trim() || '-'}`,
      `Skill: ${String(lastInteractionMeta.selectedSkill || '').trim() || '-'}`,
      `Route: ${String(lastInteractionMeta.routePath || '').trim() || '-'}`,
      `Tools: ${tools || '-'}`,
      complaintNotes ? `Notes: ${String(complaintNotes).trim()}` : null,
    ].filter(Boolean).join('\n');
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        setComplaintStatus('Complaint snapshot copied.');
        return;
      } catch {}
    }
    setComplaintStatus('Clipboard unavailable. Use Export JSON or Export Markdown.');
  }, [
    complaintNotes,
    jarvisRouteState.traceId,
    lastHeard,
    lastInteractionMeta,
    lastReply,
  ]);

  const exportComplaints = useCallback(async (format = 'json') => {
    try {
      const resp = await fetch(`/api/jarvis/complaints/export?format=${encodeURIComponent(format)}&limit=500`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'markdown' ? 'jarvis_complaints.md' : 'jarvis_complaints.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setComplaintStatus(`Exported complaints (${format}).`);
    } catch (err) {
      setComplaintStatus(`Export failed: ${String(err?.message || 'request_failed')}`);
    }
  }, []);

  const handleUtterance = useCallback(async (raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const traceId = generateVoiceTraceId();
    const baseTraceMeta = {
      traceId,
      endpoint: '/api/jarvis/query',
      intent: 'unknown',
      toolsUsed: [],
      voiceBriefMode,
      source: 'voice_copilot',
      mode: 'voice',
      routePathTag: 'client.voice.handleUtterance',
      didEarbudFinalize: false,
      invariantsPass: false,
      failedRules: [],
    };
    logVoiceAudit('voice_input', {
      traceId,
      endpoint: '/client/voice/input',
      intent: 'unknown',
      toolsUsed: [],
      voiceMode: true,
      voiceBriefMode,
      finalReplyPreview: '',
      source: 'voice_input',
      mode: 'listen',
      routePathTag: 'client.voice.handleUtterance',
      didEarbudFinalize: false,
      invariantsPass: true,
      failedRules: [],
    });
    const dedupeKey = normalizeVoiceText(text);
    const now = Date.now();
    if (lastUtteranceRef.current.text === dedupeKey && (now - lastUtteranceRef.current.at) < 1400) {
      return;
    }
    lastUtteranceRef.current = { text: dedupeKey, at: now };
    const utteranceSeq = utteranceSeqRef.current + 1;
    utteranceSeqRef.current = utteranceSeq;
    setProcessing(true);
    setLastHeard(text);
    console.log(`[VOICE_TRANSCRIPT_TRACE] spokenText=${previewVoiceText(text)} spokenTextSource=handleUtterance.input reply=`);
    setError('');
    let replyModule = normalizeAssistantModuleId(activeModule) || String(activeModule || '').trim() || 'bridge';
    let suppressVoiceReply = false;
    try {
      const normalized = normalizeVoiceText(text);
      let reply = '';
      let traceMeta = { ...baseTraceMeta };
      if (/\b(stop listening|mic off|mute mic)\b/.test(normalized)) {
        stopListening();
        reply = 'Voice listening stopped.';
        suppressVoiceReply = true;
      } else if (/\b(pause voice|pause speech|hold voice)\b/.test(normalized)) {
        const paused = pauseVoicePlayback();
        reply = paused ? 'Voice playback paused.' : 'No active voice playback to pause.';
        suppressVoiceReply = true;
      } else if (/\b(resume voice|resume speech|continue voice)\b/.test(normalized)) {
        const resumed = await resumeVoicePlayback();
        reply = resumed ? 'Voice playback resumed.' : 'No paused voice playback to resume.';
        suppressVoiceReply = true;
      } else if (/\b(stop talking)\b/.test(normalized)) {
        stopVoicePlayback({ clearManualPause: false });
        reply = 'Stopped voice playback.';
        suppressVoiceReply = true;
      } else if (/\b(mute voice|quiet mode)\b/.test(normalized)) {
        mutedRef.current = true;
        setMuted(true);
        reply = 'Voice output muted.';
        suppressVoiceReply = true;
      } else if (/\b(unmute voice|voice on|speak again)\b/.test(normalized)) {
        mutedRef.current = false;
        setMuted(false);
        reply = 'Voice output enabled.';
        suppressVoiceReply = true;
      } else if (/\b(what endpoint|which endpoint|endpoint are you using|voice requests.*endpoint)\b/.test(normalized)) {
        reply = 'Voice requests are using /api/jarvis/query via Jarvis orchestrator.';
        traceMeta = {
          ...traceMeta,
          source: 'voice_route_check',
          mode: 'client_check',
          routePathTag: 'client.voice.endpoint_check',
          invariantsPass: true,
        };
        setLastJarvisTools('Jarvis Route Check');
      } else if (/\b(open|show|go to)\b/.test(normalized)) {
        const moduleId = findModuleByVoice(normalized);
        const isSimpleNav = moduleId
          && !/\b(and|then|also|what|today|outlook|status|plan|should|trade|run|sync|check)\b/.test(normalized);
        if (isSimpleNav) {
          onSelectModule(moduleId);
          const label = MODULES.find((m) => m.id === moduleId)?.label || moduleId;
          reply = `Opening ${label}.`;
          traceMeta = {
            ...traceMeta,
            source: 'voice_navigation',
            mode: 'client_action',
            routePathTag: 'client.voice.navigation',
            invariantsPass: true,
          };
        }
      }

      if (!reply) {
        const wantsRealtime = isRealtimeVoiceMarketIntent(text);
        const resolvedModule = replyModule;
        console.log(`[VOICE_COPILOT_SUBMIT] submit text=${text} activeModule=${activeModule} contextHint=${resolvedModule} preferCachedLive=${!wantsRealtime}`);
        const out = await runAssistantQuery(text, {
          preferCachedLive: !wantsRealtime,
          moduleOverride: resolvedModule,
          traceId,
        });
        const meta = out?.__trace || {};
        console.log(`[VOICE_COPILOT_SUBMIT] result source=${String(out?.source || '')} sanitizedHeader=${meta?.sanitizedHeader ?? null} responseText=${String(meta?.responseText || out?.reply || '').slice(0, 250)}`);
        if (utteranceSeq !== utteranceSeqRef.current) return;
        applyClientActions(out?.clientActions || []);
        const toolsUsed = Array.isArray(out?.toolsUsed) ? out.toolsUsed.filter(Boolean) : [];
        setLastJarvisTools(toolsUsed.join(' + '));
        setJarvisConsentState({
          pending: out?.consentPending === true,
          kind: out?.consentKind ? String(out.consentKind) : null,
          needLocation: out?.consentNeedLocation === true,
        });
        if (out?.phoneLinkUrl) {
          setPhoneLinkUrl(String(out.phoneLinkUrl));
        }
        if (out?.locationStatus && typeof out.locationStatus === 'object') {
          setPhoneLocationStatus({
            hasLocation: out.locationStatus.hasLocation === true,
            ageSeconds: Number.isFinite(Number(out.locationStatus.ageSeconds)) ? Number(out.locationStatus.ageSeconds) : null,
            ttlSecondsRemaining: Number.isFinite(Number(out.locationStatus.ttlSecondsRemaining)) ? Number(out.locationStatus.ttlSecondsRemaining) : 0,
            lastLocation: out.locationStatus.lastLocation && typeof out.locationStatus.lastLocation === 'object'
              ? out.locationStatus.lastLocation
              : null,
          });
          setPhoneLocationStatusError('');
        }
        reply = String(out?.reply || '').trim()
          || 'I did not produce a clear answer yet. Ask: "what is today stance and why?"';
        replyModule = String(out?.activeModule || 'analyst').trim().toLowerCase() || 'analyst';
        traceMeta = {
          ...traceMeta,
          traceId: String(out?.traceId || traceId),
          endpoint: String(meta?.url || '/api/jarvis/query'),
          intent: String(out?.intent || 'unknown'),
          toolsUsed,
          source: String(out?.source || 'jarvis_orchestrator'),
          mode: String(out?.mode || 'jarvis'),
          routePathTag: String(out?.routePathTag || out?.routePath || out?.source || 'jarvis_orchestrator'),
          didEarbudFinalize: out?.didEarbudFinalize === true,
          invariantsPass: out?.invariantsPass === true || out?.invariants?.pass === true,
          failedRules: Array.isArray(out?.invariants?.failedRules) ? out.invariants.failedRules : [],
        };
        setLastInteractionMeta({
          prompt: text,
          reply,
          traceId: String(out?.traceId || traceId),
          intent: String(out?.intent || '').trim(),
          selectedSkill: String(out?.selectedSkill || '').trim(),
          routePath: String(out?.routePathTag || out?.routePath || '').trim(),
          toolsUsed,
        });
      } else {
        setLastJarvisTools('Voice Controls');
        setJarvisConsentState({
          pending: false,
          kind: null,
          needLocation: false,
        });
        traceMeta = {
          ...traceMeta,
          source: 'voice_controls',
          mode: 'client_control',
          routePathTag: 'client.voice.controls',
          invariantsPass: true,
        };
        setLastInteractionMeta({
          prompt: text,
          reply,
          traceId,
          intent: 'general_chat',
          selectedSkill: 'GeneralConversation',
          routePath: 'client.voice.controls',
          toolsUsed: ['Jarvis'],
        });
      }

      if (utteranceSeq !== utteranceSeqRef.current) return;
      commitVoiceReply(reply, 'handleUtterance.reply', { replyText: reply, traceMeta });
      if (autoSpeak && !suppressVoiceReply) {
        speakReply(reply, {
          traceId: traceMeta.traceId,
          traceMeta,
          spokenTextSource: 'handleUtterance.reply',
          replyText: reply,
          useExactReply: normalizeAssistantModuleId(replyModule) === 'analyst',
        });
      }
    } catch (err) {
      if (utteranceSeq !== utteranceSeqRef.current) return;
      const rawMsg = String(err?.message || 'I could not process that request.');
      const errName = String(err?.name || '').toLowerCase();
      const errMsg = rawMsg.toLowerCase();
      const looksTrading = shouldRouteVoiceToAnalyst(text, normalizeAssistantModuleId(activeModule) || 'bridge')
        || isRealtimeVoiceMarketIntent(text);
      const isTransportError = errName === 'aborterror'
        || errMsg.includes('aborted')
        || errMsg.includes('timeout')
        || errMsg.includes('failed to fetch')
        || errMsg.includes('network');
      const msg = isTransportError
        ? (
          looksTrading
            ? "I couldn't complete the live trading check in time. I'd stand down for now and re-check in a moment. If you want, say explain and I'll give the full brief once it's back."
            : "I hit a connection delay before I could answer that. Ask again and I'll respond normally."
        )
        : rawMsg;
      setError(msg);
      setLastJarvisTools('');
      setJarvisConsentState({
        pending: false,
        kind: null,
        needLocation: false,
      });
      setJarvisRouteState({
        status: 'unavailable',
        endpoint: '/api/jarvis/query',
        routePathTag: 'client.voice.error',
        traceId,
        reason: normalizeTransportFailureReason(msg, looksTrading ? 'trading_decision' : 'general_chat'),
      });
      setLastInteractionMeta({
        prompt: text,
        reply: msg,
        traceId,
        intent: looksTrading ? 'trading_decision' : 'general_chat',
        selectedSkill: looksTrading ? 'TradingDecision' : 'GeneralConversation',
        routePath: 'client.voice.error',
        toolsUsed: ['Jarvis'],
      });
      const traceMeta = {
        ...baseTraceMeta,
        source: 'voice_error',
        mode: 'error',
        routePathTag: 'client.voice.error',
        invariantsPass: false,
        failedRules: ['client_error'],
      };
      commitVoiceReply(msg, 'handleUtterance.error', { replyText: msg, traceMeta });
      if (autoSpeak) {
        speakReply(msg, {
          traceId: traceMeta.traceId,
          traceMeta,
          spokenTextSource: 'handleUtterance.error',
          replyText: msg,
          useExactReply: normalizeAssistantModuleId(replyModule) === 'analyst',
        });
      }
    } finally {
      if (utteranceSeq === utteranceSeqRef.current) setProcessing(false);
    }
  }, [
    activeModule,
    applyClientActions,
    autoSpeak,
    commitVoiceReply,
    pauseVoicePlayback,
    resumeVoicePlayback,
    runAssistantQuery,
    speakReply,
    stopVoicePlayback,
    stopListening,
  ]);

  const startListening = useCallback(async (options = {}) => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError('Speech recognition is not available in this browser.');
      return;
    }
    if (recognitionRestartTimerRef.current) {
      clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    const micReady = await requestMicAccess({ silent: options.silentMic === true });
    if (!micReady) {
      keepListeningRef.current = false;
      return;
    }
    manualMicPauseRef.current = false;
    keepListeningRef.current = true;
    setError('');
    if (options.forceNew === true && recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    let rec = recognitionRef.current;
    if (!rec) {
      rec = new Ctor();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onstart = () => {
        recognitionStartFailCountRef.current = 0;
        setListening(true);
        setMicPermission('granted');
      };
      rec.onerror = (evt) => {
        const code = String(evt?.error || 'voice_error');
        if (code === 'no-speech') return;
        if (code === 'aborted') return;
        if (code === 'not-allowed') {
          setError('Microphone blocked. Enable permission in browser site settings, then press "Enable Mic Access".');
          setMicPermission('denied');
          keepListeningRef.current = false;
          recognitionStartFailCountRef.current = 0;
        } else if (code === 'audio-capture') {
          setError('No microphone input detected. Check your selected input device.');
          setListening(false);
        } else {
          setError(`Voice input error: ${code}`);
        }
      };
      rec.onresult = (evt) => {
        let interim = '';
        const finals = [];
        for (let i = evt.resultIndex; i < evt.results.length; i += 1) {
          const value = String(evt.results[i]?.[0]?.transcript || '').trim();
          if (!value) continue;
          if (evt.results[i].isFinal) finals.push(value);
          else interim += `${value} `;
        }
        const interimText = interim.trim();
        const finalText = finals.join(' ').trim();
        const candidate = finalText || interimText;
        if (speakingRef.current && candidate) {
          if (!isLikelyAssistantEcho(candidate)) {
            if (!bargeInTriggeredRef.current) {
              bargeInTriggeredRef.current = true;
              stopVoicePlayback();
            }
            setInterimHeard(interimText);
            if (finalText) {
              setInterimHeard('');
              handleUtterance(finalText);
            }
            return;
          }
          if (!finalText) return;
          return;
        }
        setInterimHeard(interimText);
        if (finals.length > 0) {
          setInterimHeard('');
          handleUtterance(finalText);
        }
      };
      rec.onend = () => {
        setListening(false);
        if (!keepListeningRef.current || micPausedForPlaybackRef.current || manualMicPauseRef.current) return;
        setTimeout(() => {
          if (!keepListeningRef.current || micPausedForPlaybackRef.current || manualMicPauseRef.current) return;
          try {
            rec.start();
          } catch {
            recognitionRef.current = null;
            if (recognitionRestartTimerRef.current) {
              clearTimeout(recognitionRestartTimerRef.current);
              recognitionRestartTimerRef.current = null;
            }
            recognitionRestartTimerRef.current = setTimeout(() => {
              if (!keepListeningRef.current || micPausedForPlaybackRef.current || manualMicPauseRef.current) return;
              startListening({ silentMic: true, forceNew: true });
            }, 180);
          }
        }, speakingRef.current ? 60 : 120);
      };
      recognitionRef.current = rec;
    }
    try {
      rec.start();
      recognitionStartFailCountRef.current = 0;
    } catch (err) {
      const alreadyStarted = String(err?.name || '').toLowerCase() === 'invalidstateerror'
        || /already started|start/i.test(String(err?.message || '').toLowerCase());
      if (alreadyStarted) {
        setListening(true);
        return;
      }
      recognitionRef.current = null;
      try { rec.stop(); } catch {}
      recognitionStartFailCountRef.current += 1;
      const failCount = recognitionStartFailCountRef.current;
      if (keepListeningRef.current && !manualMicPauseRef.current && failCount <= 2) {
        if (recognitionRestartTimerRef.current) clearTimeout(recognitionRestartTimerRef.current);
        recognitionRestartTimerRef.current = setTimeout(() => {
          if (!keepListeningRef.current || manualMicPauseRef.current) return;
          startListening({ silentMic: true, forceNew: true });
        }, 160 * failCount);
      } else {
        setError('Microphone failed to start. Press "Resume Mic" and verify browser mic permission for this site.');
      }
    }
  }, [handleUtterance, isLikelyAssistantEcho, requestMicAccess, stopVoicePlayback]);

  const ensureListeningHot = useCallback(async () => {
    if (micPermission === 'denied') return;
    if (manualMicPauseRef.current) return;
    if (autoStartInFlightRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (listening || speakingRef.current || processing) return;
    autoStartInFlightRef.current = true;
    try {
      if (typeof window !== 'undefined' && typeof window.focus === 'function') {
        try { window.focus(); } catch {}
      }
      if (!keepListeningRef.current) keepListeningRef.current = true;
      await startListening({ silentMic: true });
    } finally {
      autoStartInFlightRef.current = false;
    }
  }, [listening, micPermission, processing, startListening]);

  useEffect(() => {
    keepListeningRef.current = true;
    const kick = () => { ensureListeningHot(); };
    const delays = [120, 450, 950, 1800, 3200, 5200, 8200];
    const timers = delays.map((ms) => setTimeout(kick, ms));
    const interval = setInterval(kick, 10000);
    const onFocus = () => { kick(); };
    const onPageShow = () => { kick(); };
    const onVisible = () => {
      if (document.hidden) return;
      kick();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ensureListeningHot]);

  useEffect(() => {
    if (greetedRef.current) return;
    greetedRef.current = true;
    const greeting = 'Hello boss, what is on your mind today?';
    const markGreetingStarted = () => {
      greetingPlaybackStartedRef.current = true;
    };
    const playGreeting = () => {
      speakReply(greeting, {
        pauseListening: true,
        allowBrowserFallback: true,
        onPlaybackStart: markGreetingStarted,
        spokenTextSource: 'startup.greeting',
        replyText: greeting,
        useExactReply: true,
      });
    };
    commitVoiceReply(greeting, 'startup.greeting', { replyText: greeting });
    const t0 = setTimeout(() => { playGreeting(); }, 350);
    const t1 = setTimeout(() => {
      if (!greetingPlaybackStartedRef.current) playGreeting();
    }, 2500);
    const t2 = setTimeout(() => {
      if (!greetingPlaybackStartedRef.current) playGreeting();
    }, 5000);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [speakReply, commitVoiceReply]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.__voiceCopilotDebugSubmit = (text) => handleUtterance(String(text || ''));
    return () => {
      try { delete window.__voiceCopilotDebugSubmit; } catch {}
    };
  }, [handleUtterance]);

  useEffect(() => {
    const onFocusRefresh = () => {
      refreshMicPermission();
      ensureListeningHot();
    };
    window.addEventListener('focus', onFocusRefresh);
    window.addEventListener('pageshow', onFocusRefresh);
    return () => {
      window.removeEventListener('focus', onFocusRefresh);
      window.removeEventListener('pageshow', onFocusRefresh);
    };
  }, [ensureListeningHot, refreshMicPermission]);

  useEffect(() => () => {
    keepListeningRef.current = false;
    recognitionStartFailCountRef.current = 0;
    if (recognitionRestartTimerRef.current) {
      clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    stopVoicePlayback();
    if (micProbeStreamRef.current) {
      try { micProbeStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      micProbeStreamRef.current = null;
    }
    if (healthAudioCtxRef.current) {
      try { healthAudioCtxRef.current.close(); } catch {}
      healthAudioCtxRef.current = null;
    }
  }, [stopVoicePlayback]);

  useEffect(() => {
    const onHotkey = (evt) => {
      if (!(evt.metaKey || evt.ctrlKey) || !evt.shiftKey) return;
      if (String(evt.key || '').toLowerCase() !== 'v') return;
      evt.preventDefault();
      if (listening) stopListening();
      else startListening();
    };
    window.addEventListener('keydown', onHotkey);
    return () => window.removeEventListener('keydown', onHotkey);
  }, [listening, startListening, stopListening]);

  const moduleLabel = MODULES.find((m) => m.id === activeModule)?.label || activeModule;
  const activeVoiceProfile = voiceProfiles.find((p) => p.id === voiceProfile) || null;
  const micPermissionLabel = micPermission === 'granted'
    ? 'mic permission: allowed'
    : micPermission === 'denied'
      ? 'mic permission: blocked'
      : micPermission === 'prompt'
        ? 'mic permission: prompt'
        : 'mic permission: unknown';
  const voiceLabel = (() => {
    const provider = String(voiceBackend.provider || 'browser').toLowerCase();
    if (provider === 'elevenlabs') return 'jarvis voice: elevenlabs';
    if (provider === 'openai') return 'jarvis voice: ai';
    if (provider.includes('edge')) return 'jarvis voice: edge neural';
    if (provider.includes('piper') || provider.includes('xtts')) return 'jarvis voice: local premium';
    return 'jarvis voice: local';
  })();
  const jarvisRouteBadgeClass = jarvisRouteState.status === 'jarvis' ? 'bg-green' : 'bg-red';
  const jarvisRouteLabel = jarvisRouteState.status === 'jarvis' ? 'Jarvis: ON' : 'Jarvis unavailable';
  const consentLabel = (() => {
    if (!jarvisConsentState.pending) return '';
    if (jarvisConsentState.kind === 'location') return 'Jarvis: waiting for your location choice (phone GPS or city).';
    if (jarvisConsentState.kind === 'web_search') return 'Jarvis: waiting for your OK to search the web.';
    return 'Jarvis: waiting for your confirmation.';
  })();
  const phoneLocationLabel = phoneLocationStatus.hasLocation
    ? `connected (age ${formatAgeLabel(phoneLocationStatus.ageSeconds)})`
    : 'not connected';
  const qrImageUrl = buildQrImageUrl(phoneLinkUrl);
  const phoneLinkModalNode = showPhoneLinkModal ? (
    <div className="voice-modal-overlay" onClick={() => setShowPhoneLinkModal(false)}>
      <div className="voice-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="voice-modal-title">Link Android Phone</div>
        <div className="voice-modal-text">
          Open this link on your Android browser, tap <b>Share Location with Jarvis</b>, then say
          {' '}"use my phone location".
        </div>
        {qrImageUrl && (
          <img
            src={qrImageUrl}
            alt="Jarvis phone link QR"
            className="voice-qr-image"
          />
        )}
        {phoneLinkUrl ? (
          <a href={phoneLinkUrl} target="_blank" rel="noreferrer" className="voice-link-url">
            {phoneLinkUrl}
          </a>
        ) : (
          <div className="voice-link-url">Fetching phone link from Jarvis server...</div>
        )}
        <div className="voice-modal-actions">
          <button
            type="button"
            onClick={() => {
              if (phoneLinkUrl && navigator?.clipboard?.writeText) {
                navigator.clipboard.writeText(phoneLinkUrl).catch(() => {});
              }
            }}
          >
            Copy Link
          </button>
          <button type="button" onClick={() => setShowPhoneLinkModal(false)} className="primary">
            Close
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={`voice-copilot ${listening ? 'is-listening' : ''} ${processing ? 'is-processing' : ''}`}>
      <div className="voice-copilot-head">
        <div className="voice-copilot-title">3130 Voice Copilot</div>
        <div className={`voice-copilot-state ${listening ? 'on' : ''}`}>
          {listening ? 'LISTENING' : (processing ? 'PROCESSING' : (voicePlaybackPaused ? 'VOICE PAUSED' : (speaking ? 'SPEAKING' : 'IDLE')))}
        </div>
      </div>
      <div className="voice-copilot-meta">
        <span>Module: {moduleLabel}</span>
        <span>{supported.recognition ? 'mic ready' : 'mic unsupported'}</span>
        <span>{micPermissionLabel}</span>
        <span>{supported.speech ? 'speaker ready' : 'speaker unsupported'}</span>
        <span>{voiceLabel}</span>
        <span>
          Market Health: {String(marketHealth?.status || '').toUpperCase() || (marketHealthError ? 'UNAVAILABLE' : 'UNKNOWN')}
        </span>
        {activeVoiceProfile?.name && <span>profile: {activeVoiceProfile.name}</span>}
      </div>
      {(marketHealth || marketHealthError) && (
        <div className={`voice-health-inline ${String(marketHealth?.status || '').toUpperCase() === 'OK' ? 'ok' : 'warn'}`}>
          <span className="voice-health-inline-title">Live Data</span>
          <span>
            {marketHealthError
              ? `Health unavailable (${marketHealthError})`
              : `${String(marketHealth?.status || 'UNKNOWN').toUpperCase()}${marketHealth?.reason ? ` - ${marketHealth.reason}` : ''}`}
          </span>
          <span className="voice-health-inline-time">
            Last good: {marketHealthLastSuccessAt || 'none'}
          </span>
        </div>
      )}
      <div className="voice-copilot-actions">
        <button type="button" onClick={listening ? stopListening : startListening} className={listening ? 'danger' : 'primary'}>
          {listening ? 'Pause Mic' : 'Resume Mic'}
        </button>
        <button
          type="button"
          onClick={voicePlaybackPaused ? () => { resumeVoicePlayback(); } : () => { pauseVoicePlayback(); }}
          disabled={!speaking && !voicePlaybackPaused}
        >
          {voicePlaybackPaused ? 'Resume Voice' : 'Pause Voice'}
        </button>
        <button type="button" onClick={() => stopVoicePlayback()} disabled={!speaking && !voicePlaybackPaused}>
          Stop Voice
        </button>
        <button
          type="button"
          onClick={() => setMuted((v) => {
            const next = !v;
            mutedRef.current = next;
            if (next) {
              manualVoicePauseRef.current = false;
              pendingSpeechRef.current = null;
              stopVoicePlayback({ cancelRequest: false });
            }
            return next;
          })}
        >
          {muted ? 'Unmute Voice' : 'Mute Voice'}
        </button>
        <button type="button" onClick={() => setHealthAudioAlertEnabled((v) => !v)}>
          {healthAudioAlertEnabled ? 'Health Chime On' : 'Health Chime Off'}
        </button>
        <button
          type="button"
          onClick={async () => {
            await refreshPhoneLocationStatus();
            setShowPhoneLinkModal(true);
          }}
        >
          Link Phone
        </button>
        <button
          type="button"
          onClick={() => speakReply(lastReply, {
            pauseListening: false,
            spokenTextSource: 'ui.replay.lastReply',
            replyText: lastReply,
            useExactReply: normalizeDashboardModuleId(activeModule) === 'analyst',
          })}
          disabled={!lastReply || muted}
        >
          Replay Voice
        </button>
        {micPermission !== 'granted' && (
          <button type="button" onClick={() => requestMicAccess({ silent: false })}>Enable Mic Access</button>
        )}
      </div>
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Heard</div>
        <div className="voice-copilot-value">{lastHeard || interimHeard || 'Waiting for voice input...'}</div>
      </div>
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Reply</div>
        <div className="voice-copilot-value">{lastReply}</div>
      </div>
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Jarvis Used Tools</div>
        <div className="voice-copilot-value">{lastJarvisTools || 'Jarvis'}</div>
      </div>
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Jarvis Route</div>
        <div className="voice-copilot-value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`card-badge ${jarvisRouteBadgeClass}`}>{jarvisRouteLabel}</span>
          <span className="dim">{jarvisRouteState.endpoint}</span>
          {jarvisRouteState.traceId && <span className="dim">trace {jarvisRouteState.traceId.slice(0, 8)}</span>}
          {jarvisRouteState.status !== 'jarvis' && jarvisRouteState.reason && (
            <span className="dim">({jarvisRouteState.reason})</span>
          )}
        </div>
      </div>
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Phone Location</div>
        <div className="voice-copilot-value">
          {phoneLocationLabel}
          {phoneLocationStatusError ? ` (status: ${phoneLocationStatusError})` : ''}
        </div>
      </div>
      {jarvisConsentState.pending && (
        <div className="voice-copilot-field">
          <div className="voice-copilot-label">Jarvis Authorization</div>
          <div className="voice-copilot-value">{consentLabel}</div>
        </div>
      )}
      <div className="voice-copilot-field">
        <div className="voice-copilot-label">Response Quality</div>
        <div className="voice-copilot-value" style={{ display: 'grid', gap: 8 }}>
          <input
            type="text"
            placeholder="optional complaint notes"
            value={complaintNotes}
            onChange={(e) => setComplaintNotes(String(e.target.value || ''))}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={submitVoiceComplaint}>
              Not a good response
            </button>
            <button type="button" onClick={copyLatestComplaint}>
              Copy complaint
            </button>
            <button type="button" onClick={() => exportComplaints('json')}>
              Export JSON
            </button>
            <button type="button" onClick={() => exportComplaints('markdown')}>
              Export Markdown
            </button>
          </div>
          {complaintStatus && <span className="dim">{complaintStatus}</span>}
        </div>
      </div>
      <div className="voice-copilot-select">
        <label>Voice Mode</label>
        <select value={voiceBriefMode} onChange={(e) => setVoiceBriefMode(String(e.target.value || 'earbud'))}>
          <option value="earbud">Earbud (Fast Brief)</option>
          <option value="full_brief">Full Brief</option>
        </select>
        <div className="voice-copilot-hint" style={{ marginTop: 6 }}>
          {voiceBriefMode === 'earbud'
            ? 'Earbud mode speaks a compact trading brief: stance, blocker, change trigger, setup cue, risk rule.'
            : 'Full Brief mode keeps full narrative detail for deeper context.'}
        </div>
      </div>
      <div className="voice-copilot-select">
        <label>Send Location to Jarvis</label>
        <select value={sendLocationHint ? 'on' : 'off'} onChange={(e) => setSendLocationHint(String(e.target.value) === 'on')}>
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>
        <div className="voice-copilot-hint" style={{ marginTop: 6 }}>
          {sendLocationHint
            ? (userLocationHint
              ? `Location hint ready (${Number(userLocationHint.lat).toFixed(3)}, ${Number(userLocationHint.lon).toFixed(3)}).`
              : 'Location hint is on, but location is unavailable right now.')
            : 'Location hint is off. Jarvis will ask for a city when needed.'}
        </div>
      </div>
      {voiceProfiles.length > 0 && (
        <div className="voice-copilot-select">
          <label>Voice Profile</label>
          <select value={voiceProfile} disabled>
            {voiceProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="voice-copilot-hint" style={{ marginTop: 6 }}>
            {activeVoiceProfile?.description || 'Curated 3130 premium voices only.'} Locked for consistent playback quality.
          </div>
        </div>
      )}
      {showPhoneLinkModal && typeof document !== 'undefined'
        ? createPortal(phoneLinkModalNode, document.body)
        : phoneLinkModalNode}
      {error && <div className="voice-copilot-error">{error}</div>}
      <div className="voice-copilot-hint">
        Mic auto-starts by default and auto-resumes on focus. Voice replies are always ON. Guidance uses live feed plus account state, and chart-specific reads require a shared chart image. Fast commands: "what&apos;s the gameplan", "should I take this setup now", "what setups do you see", "run topstep sync", "run npm test in terminal". Hotkey: Ctrl/Command + Shift + V.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// BRIDGE (Dashboard)
// ═══════════════════════════════════════════
function Bridge({ strategy }) {
  const url = strategy === 'alt' ? '/api/bridge?strategy=alt' : '/api/bridge';
  const { data, loading } = useApi(url, [strategy]);
  if (loading) return <><Topbar title="THE BRIDGE" /><div className="content"><Loading /></div></>;
  if (!data || data.status === 'no_data') return <NoData />;

  const m = data.metrics;
  const mc = data.monteCarlo;
  const ls = data.latestSession;
  const eq = (data.equityCurve || []).slice(1);
  const maxBal = Math.max(...eq.map(p => p.balance), 50000);
  const minBal = Math.min(...eq.map(p => p.balance), 50000);
  const range = maxBal - minBal || 1;

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'THE BRIDGE — CLOSER TP' : 'THE BRIDGE'} metrics={m} />
      <div className="content">
        <div className="glow-line" />

        {/* Alt Strategy Change Summary */}
        {strategy === 'alt' && data.changeSummary && (
          <div style={{
            background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)',
            borderRadius: 'var(--radius)', padding: '10px 16px', marginBottom: 12,
            fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.8,
            display: 'flex', justifyContent: 'space-around',
          }}>
            <span style={{ color: '#0f8' }}>✦ {data.changeSummary.flipped} LOSSES FLIPPED TO WINS</span>
            <span style={{ color: 'var(--text-3)' }}>{data.changeSummary.reduced} wins reduced</span>
            <span style={{ color: data.changeSummary.netImpact > 0 ? '#0f8' : '#f44' }}>
              NET IMPACT: ${data.changeSummary.netImpact > 0 ? '+' : ''}{data.changeSummary.netImpact?.toFixed(0)}
            </span>
          </div>
        )}

        {/* Primary Metrics */}
        <div className="grid grid-5" style={{ marginBottom: 12 }}>
          <Metric label="Win Rate" value={`${m.winRate}%`}
            sub={`${m.wins}W / ${m.losses}L`}
            color={wr(m.winRate)} tone={m.winRate >= 50 ? 'positive' : 'negative'} />
          <Metric label="Profit Factor" value={m.profitFactor}
            sub={`Sharpe ${data.sharpe}`}
            color={pf(m.profitFactor)} tone={m.profitFactor >= 1 ? 'positive' : 'negative'} />
          <Metric label="Total P&L" value={`$${m.totalPnlDollars?.toFixed(0)}`}
            sub={`${m.totalPnlTicks} ticks`}
            color={pnl(m.totalPnlDollars)} tone={m.totalPnlDollars >= 0 ? 'positive' : 'negative'} />
          <Metric label="Expectancy" value={`$${m.expectancyDollars?.toFixed(2)}`}
            sub="per trade"
            color={pnl(m.expectancyDollars)} tone={m.expectancyDollars >= 0 ? 'positive' : 'negative'} />
          <Metric label="Max Drawdown" value={`$${data.drawdown?.maxDrawdownDollars?.toFixed(0)}`}
            sub={`${data.drawdown?.maxDrawdownPercent}%`}
            color="red" tone="negative" />
        </div>

        {/* Equity Curve */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Equity Curve</div>
            <div className="card-badge bg-accent">{data.summary?.totalSessions} sessions &middot; {m.totalTrades} trades</div>
          </div>
          <div className="equity-container">
            {eq.map((p, i) => {
              const h = ((p.balance - minBal) / range) * 100;
              const cls = p.pnl > 0 ? 'win' : p.pnl < 0 ? 'loss' : 'flat';
              return <div key={i} className={`equity-bar ${cls}`}
                style={{ height: `${Math.max(h, 3)}%` }}
                title={`${p.date}: $${p.pnl?.toFixed(2)} → $${p.balance?.toFixed(2)}`} />;
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-4)', marginTop: 4 }}>
            <span>{data.summary?.dateRange?.start}</span>
            <span>Balance: <span className={pnl(data.drawdown?.finalBalance - 50000)} style={{ fontWeight: 600 }}>${data.drawdown?.finalBalance?.toFixed(2)}</span></span>
            <span>{data.summary?.dateRange?.end}</span>
          </div>
        </div>

        <div className="grid grid-2">
          {/* Latest Session */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Latest Session</div>
              <div className="card-badge bg-blue">{ls?.date}</div>
            </div>
            {ls?.orb && (
              <div className="session-detail" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 2.2 }}>
                <div><span className="dim">ORB</span> <span className="accent">{ls.orb.high}</span> <span className="muted">/</span> <span className="accent">{ls.orb.low}</span> <span className="dim">({ls.orb.range_ticks}t)</span></div>
                {ls.trade ? (
                  <>
                    <div><span className="dim">DIR</span> <span className={dir(ls.trade.direction)}>{ls.trade.direction.toUpperCase()}</span> <span className="dim">@ {ls.trade.entry_price}</span></div>
                    <div><span className="dim">TP</span> {ls.trade.tp_price} <span className="muted">/</span> <span className="dim">SL</span> {ls.trade.sl_price?.toFixed(2)}</div>
                    <div><span className="dim">EXIT</span> <span className={pnl(ls.trade.pnl_ticks)} style={{ fontWeight: 600 }}>{ls.trade.result?.toUpperCase()}</span> <span className="dim">{ls.trade.pnl_ticks}t (${ls.trade.pnl_dollars?.toFixed(2)})</span></div>
                  </>
                ) : (
                  <div className="dim">No trade — {ls.noTradeReason}</div>
                )}
              </div>
            )}
          </div>

          {/* Monte Carlo */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Topstep Monte Carlo</div>
              <div className="card-badge bg-yellow">10K sims</div>
            </div>
            {mc && (
              <>
                <div className="data-row"><span className="label">P(Hit Payout)</span><span className="value green">{mc.probabilities?.hitPayout}%</span></div>
                <div className="data-row"><span className="label">P(Hit Drawdown)</span><span className="value red">{mc.probabilities?.hitDrawdown}%</span></div>
                <div className="data-row"><span className="label">P(Survived)</span><span className="value blue">{mc.probabilities?.survived}%</span></div>
                <div className="data-row"><span className="label">Max DD Median</span><span className="value">${mc.maxDrawdown?.median}</span></div>
                <div className="data-row"><span className="label">Max DD p95</span><span className="value red">${mc.maxDrawdown?.p95}</span></div>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-2">
          {/* Edge Decay */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Edge Decay Monitor</div>
              <div className={`card-badge ${data.decay?.status === 'HEALTHY' ? 'bg-green' : 'bg-red'}`}>{data.decay?.status}</div>
            </div>
            {data.decay?.latest && (
              <>
                <div className="data-row"><span className="label">Recent WR</span><span className="value">{data.decay.latest.winRate}%</span></div>
                <div className="data-row"><span className="label">Long-term WR</span><span className="value dim">{data.decay.longTerm?.winRate}%</span></div>
                <div className="data-row"><span className="label">Recent PF</span><span className="value">{data.decay.latest.profitFactor}</span></div>
                <div className="data-row"><span className="label">Long-term PF</span><span className="value dim">{data.decay.longTerm?.profitFactor}</span></div>
              </>
            )}
          </div>

          {/* Streaks / Direction */}
          <div className="card">
            <div className="card-header"><div className="card-title">Profile</div></div>
            <div className="data-row"><span className="label">Avg Win</span><span className="value green">${m.avgWinDollars?.toFixed(2)} ({m.avgWinTicks}t)</span></div>
            <div className="data-row"><span className="label">Avg Loss</span><span className="value red">${m.avgLossDollars?.toFixed(2)} ({m.avgLossTicks}t)</span></div>
            <div className="data-row"><span className="label">Max Win Streak</span><span className="value">{m.maxConsecWins}</span></div>
            <div className="data-row"><span className="label">Max Loss Streak</span><span className="value red">{m.maxConsecLosses}</span></div>
            <div className="data-row"><span className="label">Long / Short</span><span className="value">{m.longTrades}L ({m.longWinRate}%) / {m.shortTrades}S ({m.shortWinRate}%)</span></div>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// ADVERSARY
// ═══════════════════════════════════════════
function Adversary({ strategy }) {
  const url = strategy === 'alt' ? '/api/adversary?strategy=alt' : '/api/adversary';
  const { data, loading } = useApi(url, [strategy]);
  if (loading) return <><Topbar title={strategy === 'alt' ? 'THE ADVERSARY — CLOSER TP' : 'THE ADVERSARY'} /><div className="content"><Loading /></div></>;

  const findings = data?.findings || [];
  const b = data?.baseline || {};
  const critCount = findings.filter(f => f.severity === 'critical').length;

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'THE ADVERSARY — CLOSER TP' : 'THE ADVERSARY'} />
      <div className="content">
        <div className="glow-line" />

        <div className="grid grid-3" style={{ marginBottom: 12 }}>
          <Metric label="Baseline WR" value={`${b.winRate}%`} color={wr(b.winRate)} tone="neutral" />
          <Metric label="Baseline PF" value={b.profitFactor} color={pf(b.profitFactor)} tone="neutral" />
          <Metric label="Vulnerabilities" value={findings.length} sub={`${critCount} critical`} color={critCount > 0 ? 'red' : 'green'} tone={critCount > 0 ? 'negative' : 'positive'} />
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Vulnerability Scan Results</div>
            <div className="card-badge bg-red">{critCount} critical findings</div>
          </div>

          {findings.length === 0 ? (
            <div className="dim" style={{ padding: 20, textAlign: 'center' }}>No vulnerabilities detected.</div>
          ) : (
            findings.map((f, i) => (
              <div key={i} className={`finding ${f.severity}`}>
                <div className="finding-desc">
                  <div className="finding-title">{f.regime_desc}</div>
                  <div className="finding-meta">{f.total_trades} trades &middot; ${f.pnl?.toFixed(2)} P&L &middot; ${f.expectancy?.toFixed(2)}/trade</div>
                </div>
                <div className="finding-stats">
                  <div className="finding-stat-group">
                    <div className={`val ${f.win_rate < b.winRate ? 'red' : 'green'}`}>{f.win_rate}%</div>
                    <div className="lbl">WR</div>
                  </div>
                  <div className="finding-stat-group">
                    <div className={`val ${f.profit_factor < 1 ? 'red' : 'green'}`}>{f.profit_factor}</div>
                    <div className="lbl">PF</div>
                  </div>
                  <div className={`sev-badge ${f.severity}`}>{f.severity}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// JOURNAL
// ═══════════════════════════════════════════
function Journal({ strategy }) {
  const url = strategy === 'alt' ? '/api/journal?source=backtest&strategy=alt' : '/api/journal?source=backtest';
  const { data, loading } = useApi(url, [strategy]);
  if (loading) return <><Topbar title="TRADE JOURNAL" /><div className="content"><Loading /></div></>;
  const trades = data?.trades || [];
  const m = data?.metrics || {};

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'TRADE JOURNAL — CLOSER TP' : 'TRADE JOURNAL'} metrics={m} />
      <div className="content">
        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <Metric label="Total Trades" value={m.totalTrades} tone="neutral" />
          <Metric label="Avg Win" value={`$${m.avgWinDollars?.toFixed(2)}`} sub={`${m.avgWinTicks}t`} color="green" tone="positive" />
          <Metric label="Avg Loss" value={`$${m.avgLossDollars?.toFixed(2)}`} sub={`${m.avgLossTicks}t`} color="red" tone="negative" />
          <Metric label="Direction" value={`${m.longTrades}L / ${m.shortTrades}S`} tone="neutral" />
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th><th>Dir</th><th>Entry</th><th>TP</th><th>SL</th>
                  <th>Exit</th><th>Reason</th><th>Result</th><th>Ticks</th><th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i} style={t._alt_change === 'flipped' ? { background: 'rgba(0,255,136,0.05)' } : {}}>
                    <td>{t.date} {t._alt_change === 'flipped' && <span style={{ color: '#0f8', fontSize: 9, fontWeight: 700 }}>✦ FLIP</span>}</td>
                    <td className={dir(t.direction)}>{t.direction?.toUpperCase()}</td>
                    <td>{t.entry_price}</td>
                    <td>{t.tp_price}</td>
                    <td>{t.sl_price?.toFixed(2)}</td>
                    <td>{t.exit_price}</td>
                    <td className="dim">{t.exit_reason}</td>
                    <td><span className={t.result === 'win' ? 'green' : 'red'} style={{ fontWeight: 600 }}>{t.result?.toUpperCase()}</span></td>
                    <td className={pnl(t.pnl_ticks)}>{t.pnl_ticks}</td>
                    <td className={pnl(t.pnl_dollars)}>${t.pnl_dollars?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════
function Sessions({ strategy }) {
  const url = strategy === 'alt' ? '/api/sessions?strategy=alt' : '/api/sessions';
  const { data, loading } = useApi(url, [strategy]);
  if (loading) return <><Topbar title="SESSION LOG" /><div className="content"><Loading /></div></>;
  const sessions = data?.sessions || [];

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'SESSION LOG — CLOSER TP' : 'SESSION LOG'} />
      <div className="content">
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ maxHeight: 600, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th><th>ORB H</th><th>ORB L</th><th>ORB T</th>
                  <th>Trend</th><th>Vol</th><th>ORB Size</th>
                  <th>Trade</th><th>Result</th><th>Ticks</th><th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map((s, i) => (
                  <tr key={i} style={s.trade?._alt_change === 'flipped' ? { background: 'rgba(0,255,136,0.05)' } : {}}>
                    <td>{s.date} {s.trade?._alt_change === 'flipped' && <span style={{ color: '#0f8', fontSize: 9, fontWeight: 700 }}>✦</span>}</td>
                    <td>{s.orb?.high?.toFixed(2)}</td>
                    <td>{s.orb?.low?.toFixed(2)}</td>
                    <td className={s.regime?.regime_orb_size === 'wide' ? 'yellow' : ''}>{s.orb?.range_ticks}</td>
                    <td className="dim">{s.regime?.regime_trend || '—'}</td>
                    <td className={s.regime?.regime_vol === 'extreme' ? 'red' : s.regime?.regime_vol === 'high' ? 'yellow' : 'dim'}>{s.regime?.regime_vol || '—'}</td>
                    <td className="dim">{s.regime?.regime_orb_size || '—'}</td>
                    <td className={s.trade ? dir(s.trade.direction) : 'muted'}>
                      {s.trade ? s.trade.direction.toUpperCase() : s.noTradeReason || '—'}
                    </td>
                    <td><span className={s.trade?.result === 'win' ? 'green' : s.trade ? 'red' : 'muted'} style={{ fontWeight: s.trade ? 600 : 400 }}>{s.trade?.result?.toUpperCase() || '—'}</span></td>
                    <td className={pnl(s.trade?.pnl_ticks || 0)}>{s.trade?.pnl_ticks || '—'}</td>
                    <td className={pnl(s.trade?.pnl_dollars || 0)}>{s.trade ? `$${s.trade.pnl_dollars?.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// BREAKDOWNS
// ═══════════════════════════════════════════
function Breakdowns({ strategy }) {
  const url = strategy === 'alt' ? '/api/breakdown?strategy=alt' : '/api/breakdown';
  const { data, loading } = useApi(url, [strategy]);
  if (loading) return <><Topbar title="BREAKDOWNS" /><div className="content"><Loading /></div></>;
  const monthly = data?.monthly || [];
  const dow = data?.dayOfWeek || [];

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'BREAKDOWNS — CLOSER TP' : 'BREAKDOWNS'} />
      <div className="content">
        <div className="glow-line" />

        {/* Day of Week — this is the money table */}
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header"><div className="card-title">Day of Week Performance</div></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Day</th><th>Trades</th><th>W</th><th>L</th><th>Win Rate</th><th>PF</th><th>P&L</th><th>Exp/Trade</th></tr></thead>
              <tbody>
                {dow.map((d, i) => {
                  const hot = d.winRate >= 60;
                  const cold = d.winRate < 30 && d.totalTrades > 3;
                  return (
                    <tr key={i} style={cold ? { background: 'var(--red-dim)' } : hot ? { background: 'var(--green-dim)' } : {}}>
                      <td style={{ fontWeight: cold || hot ? 700 : 400, color: cold ? 'var(--red)' : hot ? 'var(--green)' : 'inherit' }}>{d.dayName}</td>
                      <td>{d.totalTrades}</td>
                      <td className="green">{d.wins}</td>
                      <td className="red">{d.losses}</td>
                      <td style={{ fontWeight: 700 }} className={wr(d.winRate)}>{d.winRate}%</td>
                      <td className={pf(d.profitFactor)}>{d.profitFactor}</td>
                      <td className={pnl(d.totalPnlDollars)}>${d.totalPnlDollars?.toFixed(2)}</td>
                      <td className={pnl(d.expectancyDollars)}>${d.expectancyDollars?.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Monthly */}
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header"><div className="card-title">Monthly Performance</div></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Month</th><th>Trades</th><th>WR</th><th>PF</th><th>P&L</th><th>Avg Win</th><th>Avg Loss</th></tr></thead>
              <tbody>
                {monthly.map((m, i) => (
                  <tr key={i}>
                    <td>{m.month}</td>
                    <td>{m.totalTrades}</td>
                    <td className={wr(m.winRate)} style={{ fontWeight: 600 }}>{m.winRate}%</td>
                    <td className={pf(m.profitFactor)}>{m.profitFactor}</td>
                    <td className={pnl(m.totalPnlDollars)} style={{ fontWeight: 600 }}>${m.totalPnlDollars?.toFixed(2)}</td>
                    <td className="green">${m.avgWinDollars?.toFixed(2)}</td>
                    <td className="red">${m.avgLossDollars?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Exit / No-Trade Reasons */}
        <div className="grid grid-2">
          <div className="card">
            <div className="card-header"><div className="card-title">Exit Reasons</div></div>
            {Object.entries(data?.exitReasons || {}).map(([r, c]) => (
              <div key={r} className="data-row">
                <span className="label">{r}</span>
                <span className="value">{c}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-header"><div className="card-title">No-Trade Reasons</div></div>
            {Object.entries(data?.noTradeReasons || {}).map(([r, c]) => (
              <div key={r} className="data-row">
                <span className="label">{r}</span>
                <span className="value">{c}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// CONFLICTS
// ═══════════════════════════════════════════
function Conflicts() {
  const { data, loading, reload } = useApi('/api/conflicts');
  const [resolving, setResolving] = useState(null);

  const handleResolve = async (conflict, result) => {
    setResolving(conflict.date);
    try {
      await fetch('/api/conflicts/resolve', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: conflict.date,
          direction: conflict.direction,
          entry_price: conflict.entry_price,
          result,
        }),
      });
      reload();
    } catch (err) {
      console.error('Resolution failed:', err);
    }
    setResolving(null);
  };

  const handleUndo = async (conflict) => {
    try {
      await fetch('/api/conflicts/resolve', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: conflict.date,
          direction: conflict.direction,
          entry_price: conflict.entry_price,
        }),
      });
      reload();
    } catch (err) {
      console.error('Undo failed:', err);
    }
  };

  if (loading) return <><Topbar title="CONFLICTS" /><div className="content"><Loading /></div></>;

  const conflicts = data?.conflicts || [];
  const unresolved = data?.unresolved || 0;

  return (
    <>
      <Topbar title="CONFLICT RESOLUTION" />
      <div className="content">
        <div className="glow-line" />

        <div className="card">
          <div className="card-header">
            <div className="card-title">Ambiguous Trades</div>
            <div className={`card-badge ${unresolved > 0 ? 'bg-yellow' : 'bg-green'}`}>
              {unresolved > 0 ? `${unresolved} unresolved` : 'All resolved'}
            </div>
          </div>
          <div className="dim" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 16 }}>
            When both TP and SL are hit within the same 5-minute candle, the engine infers which hit first using
            wick direction — bearish candles go <span className="green" style={{ fontWeight: 600 }}>high first</span>,
            bullish candles go <span className="red" style={{ fontWeight: 600 }}>low first</span>.
            Trades marked <span className="yellow" style={{ fontWeight: 600 }}>wick_inferred</span> are the engine's best guess.
            If you took this trade live, tell the system what actually happened.
          </div>
        </div>

        {conflicts.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 28, opacity: 0.3, marginBottom: 12 }}>✓</div>
            <div className="dim">No ambiguous trades found. All entries resolved cleanly.</div>
          </div>
        ) : (
          conflicts.map((c, i) => (
            <div key={i} className="card" style={{ borderLeft: c.resolved ? '2px solid var(--green)' : '2px solid var(--yellow)' }}>
              <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="card-title" style={{ color: 'var(--text-0)', fontSize: 13 }}>{c.date}</div>
                  <span className={`sev-badge ${c.resolved ? 'bg-green' : 'bg-yellow'}`} style={{ background: c.resolved ? 'var(--green-dim)' : 'var(--yellow-dim)', color: c.resolved ? 'var(--green)' : 'var(--yellow)' }}>
                    {c.resolved ? `RESOLVED → ${c.resolved.result.toUpperCase()}` : 'NEEDS INPUT'}
                  </span>
                </div>
              </div>

              <div className="grid grid-4" style={{ marginBottom: 12 }}>
                <div>
                  <div className="metric-label">Direction</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }} className={dir(c.direction)}>{c.direction.toUpperCase()}</div>
                </div>
                <div>
                  <div className="metric-label">Entry</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>{c.entry_price}</div>
                  <div className="metric-sub">{c.entry_time?.split(' ')[1]}</div>
                </div>
                <div>
                  <div className="metric-label">TP Target</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }} className="green">{c.tp_price}</div>
                  <div className="metric-sub">{c.tp_distance_ticks}t → ${((c.tp_distance_ticks * 0.25 * 2) - 4.50).toFixed(2)}</div>
                </div>
                <div>
                  <div className="metric-label">SL Target</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }} className="red">{c.sl_price?.toFixed(2)}</div>
                  <div className="metric-sub">{c.sl_distance_ticks}t → -${((c.sl_distance_ticks * 0.25 * 2) + 4.50).toFixed(2)}</div>
                </div>
              </div>

              <div style={{
                background: 'var(--yellow-dim)',
                borderRadius: 'var(--radius)',
                padding: '10px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--yellow)',
                marginBottom: 12,
              }}>
                ⚠ Both TP ({c.tp_price}) and SL ({c.sl_price?.toFixed(2)}) hit in same candle at {c.ambiguous_candle?.time?.split(' ')[1] || '—'} — Engine inferred: <span style={{ fontWeight: 700 }}>{c.inferred_result?.toUpperCase() || 'UNKNOWN'}</span>
              </div>

              {!c.resolved ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => handleResolve(c, 'win')}
                    disabled={resolving === c.date}
                    style={{
                      flex: 1, padding: '10px 16px', borderRadius: 'var(--radius)',
                      background: 'var(--green-dim)', color: 'var(--green)',
                      border: '1px solid rgba(16,185,129,0.3)', cursor: 'pointer',
                      fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                      transition: 'all 0.15s',
                    }}
                  >
                    ✓ TP HIT FIRST — WIN
                  </button>
                  <button
                    onClick={() => handleResolve(c, 'loss')}
                    disabled={resolving === c.date}
                    style={{
                      flex: 1, padding: '10px 16px', borderRadius: 'var(--radius)',
                      background: 'var(--red-dim)', color: 'var(--red)',
                      border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
                      fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                      transition: 'all 0.15s',
                    }}
                  >
                    ✗ SL HIT FIRST — LOSS
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    <span className="dim">Resolved as </span>
                    <span className={c.resolved.result === 'win' ? 'green' : 'red'} style={{ fontWeight: 700 }}>
                      {c.resolved.result.toUpperCase()}
                    </span>
                    <span className="dim"> → </span>
                    <span className={pnl(c.resolved.pnl_dollars)} style={{ fontWeight: 600 }}>
                      {c.resolved.pnl_ticks}t (${c.resolved.pnl_dollars?.toFixed(2)})
                    </span>
                  </div>
                  <button
                    onClick={() => handleUndo(c)}
                    style={{
                      padding: '4px 12px', borderRadius: 'var(--radius)',
                      background: 'var(--bg-4)', color: 'var(--text-3)',
                      border: '1px solid var(--border-1)', cursor: 'pointer',
                      fontFamily: 'var(--font-mono)', fontSize: 10,
                    }}
                  >
                    UNDO
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// THE LAB
// ═══════════════════════════════════════════
function Lab() {
  const { data, loading, reload } = useApi('/api/discovery/latest', []);
  const { data: validationsData, reload: reloadValidations } = useApi('/api/discovery/validations', []);
  const { data: remindersData, reload: reloadReminders } = useApi('/api/discovery/reminders', []);
  const { data: notifyData, reload: reloadNotify } = useApi('/api/assistant/notifications', []);
  const { data: autonomyData, reload: reloadAutonomy } = useApi('/api/execution/autonomy', []);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('two_stage');
  const [selectedCandidateId, setSelectedCandidateId] = useState(null);
  const [candidateIntel, setCandidateIntel] = useState(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [notifyForm, setNotifyForm] = useState({
    active: false,
    discordWebhookUrl: '',
    opportunityAlerts: true,
    approvalAlerts: true,
    reminderAlerts: false,
  });
  const [autonomyForm, setAutonomyForm] = useState({
    mode: 'manual',
    proactiveMorningEnabled: true,
    proactiveMorningTime: '08:50',
    paperAutoEnabled: false,
    paperAutoWindowStart: '09:45',
    paperAutoWindowEnd: '11:00',
    minSetupProbability: 55,
    minConfidencePct: 60,
    requireOpenRiskClear: true,
    maxPaperActionsPerDay: 2,
  });

  useEffect(() => {
    if (!notifyData) return;
    setNotifyForm(prev => ({
      ...prev,
      active: !!notifyData.active,
      opportunityAlerts: notifyData.opportunityAlerts !== false,
      approvalAlerts: notifyData.approvalAlerts !== false,
      reminderAlerts: !!notifyData.reminderAlerts,
    }));
  }, [notifyData]);

  useEffect(() => {
    const s = autonomyData?.settings;
    if (!s) return;
    setAutonomyForm({
      mode: s.mode || 'manual',
      proactiveMorningEnabled: s.proactiveMorningEnabled !== false,
      proactiveMorningTime: s.proactiveMorningTime || '08:50',
      paperAutoEnabled: !!s.paperAutoEnabled,
      paperAutoWindowStart: s.paperAutoWindowStart || '09:45',
      paperAutoWindowEnd: s.paperAutoWindowEnd || '11:00',
      minSetupProbability: Number(s.minSetupProbability || 55),
      minConfidencePct: Number(s.minConfidencePct || 60),
      requireOpenRiskClear: s.requireOpenRiskClear !== false,
      maxPaperActionsPerDay: Number(s.maxPaperActionsPerDay || 2),
    });
  }, [autonomyData]);

  const runDiscovery = async () => {
    setBusy(true);
    try {
      await fetch('/api/discovery/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          maxCandidates: mode === 'two_stage' ? 120 : 80,
          stage1Budget: mode === 'two_stage' ? 60 : undefined,
          seedTopK: mode === 'two_stage' ? 12 : undefined,
        }),
      });
      reload();
      reloadValidations();
      reloadReminders();
    } finally {
      setBusy(false);
    }
  };

  const startValidation = async (candidateId) => {
    setBusy(true);
    try {
      await fetch(`/api/discovery/candidates/${candidateId}/start-validation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTrades: 20 }),
      });
      reload();
      reloadValidations();
      reloadReminders();
    } finally {
      setBusy(false);
    }
  };

  const checkValidation = async (candidateId) => {
    setBusy(true);
    try {
      await fetch(`/api/discovery/candidates/${candidateId}/check-validation`, { method: 'POST' });
      reload();
      reloadValidations();
      reloadReminders();
    } finally {
      setBusy(false);
    }
  };

  const promoteCandidate = async (candidateId) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/discovery/candidates/${candidateId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'owner' }),
      });
      const json = await res.json();
      if (!res.ok) alert(json.error || 'Promotion failed');
      reload();
      reloadValidations();
      reloadReminders();
    } finally {
      setBusy(false);
    }
  };

  const loadCandidateIntel = async (candidateId) => {
    setSelectedCandidateId(candidateId);
    setIntelLoading(true);
    try {
      const res = await fetch(`/api/discovery/candidates/${candidateId}/intel`);
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Failed to load candidate intel');
        setCandidateIntel(null);
      } else {
        setCandidateIntel(json);
      }
    } finally {
      setIntelLoading(false);
    }
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text || '');
      alert(`${label} copied to clipboard.`);
    } catch {
      alert(`Could not copy ${label}.`);
    }
  };

  const setDailyReminder = async (candidateId) => {
    setBusy(true);
    try {
      const res = await fetch('/api/discovery/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          timeLocal: '09:20',
          timezone: 'America/New_York',
          active: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) alert(json.error || 'Reminder setup failed');
      reloadReminders();
      if (selectedCandidateId === candidateId) loadCandidateIntel(candidateId);
    } finally {
      setBusy(false);
    }
  };

  const savePhoneAlerts = async () => {
    setBusy(true);
    try {
      const payload = {
        active: notifyForm.active,
        opportunityAlerts: notifyForm.opportunityAlerts,
        approvalAlerts: notifyForm.approvalAlerts,
        reminderAlerts: notifyForm.reminderAlerts,
      };
      if ((notifyForm.discordWebhookUrl || '').trim().length > 0) {
        payload.discordWebhookUrl = notifyForm.discordWebhookUrl.trim();
      }
      const res = await fetch('/api/assistant/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Failed to save assistant notification settings.');
      } else {
        alert('Assistant phone alerts updated.');
      }
      reloadNotify();
    } finally {
      setBusy(false);
    }
  };

  const testPhoneAlerts = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/assistant/notifications/test', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Failed to send test alert.');
      } else {
        alert('Test alert sent to your phone channel.');
      }
    } finally {
      setBusy(false);
    }
  };

  const saveAutonomySettings = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/execution/autonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(autonomyForm),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Failed to save autonomy settings.');
      } else {
        alert(`Autonomy settings updated (${json.settings?.mode || autonomyForm.mode}).`);
      }
      reloadAutonomy();
    } finally {
      setBusy(false);
    }
  };

  const runAutonomyCycle = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/execution/autonomy/run-cycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Failed to run autonomy cycle.');
      } else {
        const result = json.result || {};
        alert(`Autonomy cycle: ${result.status || 'unavailable'}${result.reason ? ` (${result.reason})` : ''}`);
      }
      reloadAutonomy();
    } finally {
      setBusy(false);
    }
  };

  const candidates = data?.candidates || [];
  const top = (data?.topRecommendations || []).slice(0, 3);
  const companion = data?.companionRecommendation || null;
  const summary = data?.summary || {};
  const stage = data?.stage;
  const diagnostics = data?.diagnostics;
  const validations = validationsData?.validations || [];
  const reminders = remindersData?.reminders || [];
  const valMap = {};
  for (const v of validations) valMap[v.candidate_id] = v;
  const reminderMap = {};
  for (const r of reminders) reminderMap[r.candidate_id] = r;
  const getFrequency = (candidate) => {
    if (candidate?.frequency?.bucket) return candidate.frequency;
    const totalTrades = Number(candidate?.splits?.overall?.totalTrades || 0);
    const sessions = Number(summary?.sessions || 0);
    if (sessions > 0) {
      const annualizedTrades = Math.round((totalTrades / sessions) * 252);
      const bucket = annualizedTrades < 20 ? 'low' : annualizedTrades < 80 ? 'mid' : 'high';
      return { bucket, annualizedTrades };
    }
    const bucket = totalTrades < 30 ? 'low' : totalTrades < 100 ? 'mid' : 'high';
    return { bucket, annualizedTrades: null };
  };

  return (
    <>
      <Topbar title="THE LAB" />
      <div className="content">
        <div className="glow-line" />

        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <Metric label="Candidates" value={summary.candidates || 0} tone="neutral" />
          <Metric label="Live Eligible" value={summary.recommended || 0} tone={(summary.recommended || 0) > 0 ? 'positive' : 'neutral'} />
          <Metric label="Watchlist" value={summary.watchlist || 0} tone="neutral" />
          <Metric label="Rejected" value={summary.rejected || 0} tone={(summary.rejected || 0) > 0 ? 'negative' : 'neutral'} />
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Discovery Engine</div>
            <span className="phase-badge">NON-ORB RESEARCH</span>
          </div>
          <div className="dim" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
            Generates independent strategy families, evaluates them with chronological train/validation/test splits,
            and recommends only robust candidates that pass hard gates.
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
            fontFamily: 'var(--font-mono)', fontSize: 10,
          }}>
            <button
              onClick={() => setMode('two_stage')}
              style={{
                padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                border: mode === 'two_stage' ? '1px solid var(--cyan)' : '1px solid var(--border-1)',
                background: mode === 'two_stage' ? 'var(--cyan-dim)' : 'var(--bg-3)',
                color: mode === 'two_stage' ? 'var(--cyan)' : 'var(--text-2)',
              }}
            >
              TWO-STAGE
            </button>
            <button
              onClick={() => setMode('full_scan')}
              style={{
                padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                border: mode === 'full_scan' ? '1px solid var(--accent)' : '1px solid var(--border-1)',
                background: mode === 'full_scan' ? 'var(--accent-dim)' : 'var(--bg-3)',
                color: mode === 'full_scan' ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              FULL SCAN
            </button>
            <span className="dim">Selected: {mode.replace('_', ' ')}</span>
          </div>
          <button
            onClick={runDiscovery}
            disabled={busy}
            style={{
              padding: '8px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border-1)', background: 'var(--bg-3)',
              color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
            }}
          >
            {busy ? 'RUNNING DISCOVERY...' : 'RUN DISCOVERY SCAN'}
          </button>
          {data?.methodology?.split && (
            <div className="dim" style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              Split: {data.methodology.split} · Mode: {(data.mode || mode).replace('_', ' ')}
            </div>
          )}
          {stage?.mode === 'two_stage' && (
            <div className="dim" style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              Stage 1: {stage.stage1?.scanned}/{stage.stage1?.budget} · Stage 2: {stage.stage2?.scanned}/{stage.stage2?.budget} · Seeds: {stage.stage1?.seedTopK}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Assistant Reach-Out (Phone)</div>
            <div className="card-badge bg-cyan">{notifyData?.active ? 'ON' : 'OFF'}</div>
          </div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
            Connect a Discord webhook to receive push notifications on your phone for new opportunities and approval requests.
          </div>
          <div className="data-row">
            <span className="label">Webhook</span>
            <input
              value={notifyForm.discordWebhookUrl}
              onChange={(e) => setNotifyForm(prev => ({ ...prev, discordWebhookUrl: e.target.value }))}
              placeholder={notifyData?.webhookMasked ? `Current: ${notifyData.webhookMasked}` : 'https://discord.com/api/webhooks/...'}
              style={{ width: '100%' }}
            />
          </div>
          <div className="data-row">
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={notifyForm.active} onChange={(e) => setNotifyForm(prev => ({ ...prev, active: e.target.checked }))} />
              Alerts Enabled
            </label>
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={notifyForm.opportunityAlerts} onChange={(e) => setNotifyForm(prev => ({ ...prev, opportunityAlerts: e.target.checked }))} />
              Opportunities
            </label>
          </div>
          <div className="data-row">
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={notifyForm.approvalAlerts} onChange={(e) => setNotifyForm(prev => ({ ...prev, approvalAlerts: e.target.checked }))} />
              Approval Requests
            </label>
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={notifyForm.reminderAlerts} onChange={(e) => setNotifyForm(prev => ({ ...prev, reminderAlerts: e.target.checked }))} />
              Daily Reminders
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={savePhoneAlerts} disabled={busy} style={{ fontSize: 10 }}>Save Phone Alerts</button>
            <button onClick={testPhoneAlerts} disabled={busy} style={{ fontSize: 10 }}>Send Test Ping</button>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Execution Autonomy</div>
            <div className="card-badge bg-yellow">{autonomyData?.settings?.mode || 'manual'}</div>
          </div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
            Safety ladder: manual → paper_auto → live_assist. Paper mode sends autonomous signals only.
          </div>
          <div className="data-row">
            <span className="label">Mode</span>
            <select
              value={autonomyForm.mode}
              onChange={(e) => setAutonomyForm(prev => ({ ...prev, mode: e.target.value }))}
              style={{ width: '100%' }}
            >
              <option value="manual">manual</option>
              <option value="paper_auto">paper_auto</option>
              <option value="live_assist">live_assist</option>
            </select>
          </div>
          <div className="data-row">
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={autonomyForm.proactiveMorningEnabled} onChange={(e) => setAutonomyForm(prev => ({ ...prev, proactiveMorningEnabled: e.target.checked }))} />
              Morning Autopilot
            </label>
            <input
              value={autonomyForm.proactiveMorningTime}
              onChange={(e) => setAutonomyForm(prev => ({ ...prev, proactiveMorningTime: e.target.value }))}
              placeholder="08:50"
              style={{ maxWidth: 120 }}
            />
          </div>
          <div className="data-row">
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={autonomyForm.paperAutoEnabled} onChange={(e) => setAutonomyForm(prev => ({ ...prev, paperAutoEnabled: e.target.checked }))} />
              Paper Auto Cycle
            </label>
            <span className="dim">Window ET</span>
            <input value={autonomyForm.paperAutoWindowStart} onChange={(e) => setAutonomyForm(prev => ({ ...prev, paperAutoWindowStart: e.target.value }))} style={{ maxWidth: 90 }} />
            <input value={autonomyForm.paperAutoWindowEnd} onChange={(e) => setAutonomyForm(prev => ({ ...prev, paperAutoWindowEnd: e.target.value }))} style={{ maxWidth: 90 }} />
          </div>
          <div className="data-row">
            <span className="label">Setup Probability Min</span>
            <input type="number" value={autonomyForm.minSetupProbability} onChange={(e) => setAutonomyForm(prev => ({ ...prev, minSetupProbability: Number(e.target.value || 55) }))} style={{ maxWidth: 90 }} />
            <span className="label">Confidence Min</span>
            <input type="number" value={autonomyForm.minConfidencePct} onChange={(e) => setAutonomyForm(prev => ({ ...prev, minConfidencePct: Number(e.target.value || 60) }))} style={{ maxWidth: 90 }} />
          </div>
          <div className="data-row">
            <label className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={autonomyForm.requireOpenRiskClear} onChange={(e) => setAutonomyForm(prev => ({ ...prev, requireOpenRiskClear: e.target.checked }))} />
              Require Open-Risk Clear
            </label>
            <span className="label">Daily Paper Cap</span>
            <input type="number" value={autonomyForm.maxPaperActionsPerDay} onChange={(e) => setAutonomyForm(prev => ({ ...prev, maxPaperActionsPerDay: Number(e.target.value || 2) }))} style={{ maxWidth: 90 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={saveAutonomySettings} disabled={busy} style={{ fontSize: 10 }}>Save Autonomy</button>
            <button onClick={runAutonomyCycle} disabled={busy} style={{ fontSize: 10 }}>Run Paper Cycle Now</button>
          </div>
          <div className="dim" style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            Recent: {(autonomyData?.events || []).slice(0, 3).map((e) => `${e.eventDate} ${e.eventTime} ${e.eventType}:${e.status}`).join(' | ') || 'none'}
          </div>
        </div>

        {companion && (
          <div className="card">
            <div className="card-header">
              <div className="card-title">Companion Setup</div>
              <div className="card-badge bg-green">{String(companion.frequency?.bucket || 'mid').toUpperCase()}</div>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{companion.name}</div>
            <div className="data-row"><span className="label">Why</span><span className="value">Higher-frequency companion to avoid low-opportunity days.</span></div>
            <div className="data-row"><span className="label">Expected Rate</span><span className="value">{Number.isFinite(companion.frequency?.annualizedTrades) ? `~${companion.frequency.annualizedTrades}/yr` : 'sample-based'}</span></div>
            <div className="data-row"><span className="label">Test WR / PF</span><span className="value">{companion.test?.winRate}% / {companion.test?.profitFactor}</span></div>
          </div>
        )}

        {(diagnostics?.topRejections || []).length > 0 && (
          <div className="card">
            <div className="card-header">
              <div className="card-title">Research Diagnostics</div>
              <div className="card-badge bg-yellow">{diagnostics.topRejections.length}</div>
            </div>
            {diagnostics.topRejections.map((r, idx) => (
              <div key={idx} className="data-row">
                <span className="label">{r.reason}</span>
                <span className="value">{r.count}</span>
              </div>
            ))}
            {(diagnostics?.nextResearchActions || []).map((n, idx) => (
              <div key={idx} style={{ marginTop: 8, padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontSize: 11 }}>
                • {n}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-3">
          {top.length === 0 && (
            <div className="card">
              <div className="dim" style={{ textAlign: 'center', padding: 16 }}>No live-eligible strategies yet. Run a scan.</div>
            </div>
          )}
          {top.map((c, i) => (
            <div key={i} className="card">
              {(() => {
                const f = getFrequency(c);
                const freqText = Number.isFinite(f.annualizedTrades) ? `~${f.annualizedTrades}/yr` : 'sample-based';
                return (
                  <div className="dim" style={{ fontSize: 10, marginBottom: 8 }}>
                    Frequency: {String(f.bucket || 'low').toUpperCase()} ({freqText})
                  </div>
                );
              })()}
              <div className="card-header">
                <div className="card-title">{c.name}</div>
                <div className="card-badge bg-green">LIVE ELIGIBLE</div>
              </div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>{c.hypothesis}</div>
              <div className="data-row"><span className="label">Score</span><span className="value green">{c.robustnessScore}</span></div>
              <div className="data-row"><span className="label">Test WR</span><span className="value">{c.splits?.test?.winRate}%</span></div>
              <div className="data-row"><span className="label">Test PF</span><span className="value">{c.splits?.test?.profitFactor}</span></div>
              <div className="data-row"><span className="label">Trades</span><span className="value">{c.splits?.overall?.totalTrades}</span></div>
              {c.id && (
                <button onClick={() => loadCandidateIntel(c.id)} style={{ marginTop: 8, fontSize: 10 }}>
                  Open Intel
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header">
              <div className="card-title">Paper-Forward Queue</div>
              <div className="card-badge bg-cyan">{validations.length}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Candidate</th><th>Status</th><th>Sample</th><th>WR</th><th>PF</th><th>PnL</th></tr>
              </thead>
              <tbody>
                {validations.length === 0 && (
                  <tr><td colSpan={6} className="dim">No paper-forward validations started.</td></tr>
                )}
                {validations.map((v, idx) => (
                  <tr key={idx}>
                    <td>{v.candidate_name}</td>
                    <td>
                      <span className={v.status === 'live_eligible' ? 'green' : v.status === 'failed' ? 'red' : 'yellow'}>
                        {v.status}
                      </span>
                    </td>
                    <td>{v.sample_size}/{v.target_trades}</td>
                    <td>{v.win_rate ?? '—'}</td>
                    <td>{v.profit_factor ?? '—'}</td>
                    <td className={Number(v.pnl_dollars || 0) >= 0 ? 'green' : 'red'}>{v.pnl_dollars ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Candidate Intel</div>
            <div className="card-badge bg-accent">{selectedCandidateId || '—'}</div>
          </div>
          {!selectedCandidateId && <div className="dim">Select a candidate from the table to see execution detail and scripts.</div>}
          {intelLoading && <div className="dim">Loading candidate intel...</div>}
          {candidateIntel && (
            <>
              <div className="data-row"><span className="label">Candidate</span><span className="value">{candidateIntel.candidate?.name}</span></div>
              <div className="data-row"><span className="label">Status</span><span className="value">{candidateIntel.candidate?.status}</span></div>
              <div className="data-row">
                <span className="label">Frequency</span>
                <span className="value">
                  {String(candidateIntel.candidate?.frequency?.bucket || 'low').toUpperCase()}
                  {Number.isFinite(candidateIntel.candidate?.frequency?.annualizedTrades)
                    ? ` (~${candidateIntel.candidate.frequency.annualizedTrades}/yr)`
                    : ''}
                </span>
              </div>
              <div className="data-row"><span className="label">Setup</span><span className="value">{candidateIntel.playbook?.setup}</span></div>
              <div className="data-row"><span className="label">Trigger</span><span className="value">{candidateIntel.playbook?.trigger}</span></div>
              <div className="data-row"><span className="label">Exit</span><span className="value">{candidateIntel.playbook?.exit}</span></div>

              <div style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>Filters</div>
              {(candidateIntel.playbook?.filters || []).map((f, idx) => (
                <div key={idx} className="dim" style={{ fontSize: 11, marginTop: 4 }}>• {f}</div>
              ))}
              <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>Risk</div>
              {(candidateIntel.playbook?.risk || []).map((r, idx) => (
                <div key={idx} className="dim" style={{ fontSize: 11, marginTop: 4 }}>• {r}</div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => copyText(candidateIntel.scripts?.pine_indicator, 'Pine indicator script')} style={{ fontSize: 10 }}>
                  Copy Indicator Script
                </button>
                <button onClick={() => copyText(candidateIntel.scripts?.pine_strategy, 'Pine strategy script')} style={{ fontSize: 10 }}>
                  Copy Strategy Script
                </button>
                <button onClick={() => copyText((candidateIntel.dailyReminder?.checklist || []).join('\\n'), 'Daily checklist')} style={{ fontSize: 10 }}>
                  Copy Checklist
                </button>
                <button onClick={() => setDailyReminder(candidateIntel.candidate?.id)} style={{ fontSize: 10 }}>
                  {reminderMap[candidateIntel.candidate?.id] ? 'Update Reminder 09:20 ET' : 'Set Daily Reminder 09:20 ET'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header">
              <div className="card-title">Candidate Breakdown</div>
              <div className="card-badge bg-blue">{candidates.length}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Strategy</th><th>Status</th><th>Confidence</th><th>Score</th><th>Test WR</th><th>Test PF</th><th>Total Trades</th><th>Failure Reasons</th><th>Validation</th>
                </tr>
              </thead>
              <tbody>
                {!loading && candidates.length === 0 && (
                  <tr><td colSpan={9} className="dim">No discovery run yet. Launch a scan.</td></tr>
                )}
                {candidates.map((c, idx) => (
                  <tr key={idx}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="dim" style={{ fontSize: 10 }}>{c.hypothesis}</div>
                      {(() => {
                        const f = getFrequency(c);
                        const freqText = Number.isFinite(f.annualizedTrades) ? `~${f.annualizedTrades}/yr` : 'sample';
                        return <div className="dim" style={{ fontSize: 10, marginTop: 2 }}>Frequency: {String(f.bucket || 'low').toUpperCase()} ({freqText})</div>;
                      })()}
                      <button onClick={() => loadCandidateIntel(c.id)} style={{ marginTop: 6, fontSize: 10 }}>Intel</button>
                    </td>
                    <td>
                      <span className={c.status === 'live_eligible' ? 'green' : c.status === 'watchlist' ? 'yellow' : 'red'}>
                        {c.status}
                      </span>
                    </td>
                    <td>
                      <span className={c.confidence === 'high' ? 'green' : c.confidence === 'moderate' ? 'yellow' : 'dim'}>
                        {c.confidence || 'low'}
                      </span>
                    </td>
                    <td>{c.robustnessScore}</td>
                    <td>{c.splits?.test?.winRate}%</td>
                    <td>{c.splits?.test?.profitFactor}</td>
                    <td>{c.splits?.overall?.totalTrades}</td>
                    <td className="dim">{(c.failureReasons || []).join(', ') || '—'}</td>
                    <td>
                      {(() => {
                        const v = valMap[c.id];
                        if (c.status !== 'live_eligible') return <span className="dim">not applicable</span>;
                        if (!v) {
                          return <button onClick={() => startValidation(c.id)} disabled={busy} style={{ fontSize: 10 }}>Start</button>;
                        }
                        if (v.status === 'running' || v.status === 'pending') {
                          return <button onClick={() => checkValidation(c.id)} disabled={busy} style={{ fontSize: 10 }}>Check</button>;
                        }
                        if (v.status === 'live_eligible') {
                          return <button onClick={() => promoteCandidate(c.id)} disabled={busy} style={{ fontSize: 10 }}>Promote</button>;
                        }
                        return <span className="red">failed</span>;
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function classifySetupFrequency(annualizedTrades) {
  const n = Number(annualizedTrades);
  if (!Number.isFinite(n) || n <= 0) {
    return { bucket: 'sample', label: 'Sample-dependent frequency' };
  }
  if (n < 20) return { bucket: 'low', label: `Low frequency (~${Math.round(n)} trades/year)` };
  if (n < 80) return { bucket: 'mid', label: `Mid frequency (~${Math.round(n)} trades/year)` };
  return { bucket: 'high', label: `High frequency (~${Math.round(n)} trades/year)` };
}

function parseSetupTokens(name = '', rationale = '') {
  const text = `${String(name || '')} ${String(rationale || '')}`.toLowerCase().replace(/[_+]/g, ' ');
  const isFilter = /\bfilter\b/.test(text);
  const gapFlat = /\bgap\b.*\bflat\b|\bflat\b.*\bgap\b/.test(text);
  const trendRange = /\btrend\b.*\brange\b|\brange\b.*\btrend\b|\branging\b/.test(text);
  const highVol = /\bvol\b.*\bhigh\b|\bhigh\b.*\bvol\b|\bextreme\b/.test(text);
  const biasLong = /\bbias\b.*\blong\b|\btoward\b.*\blong\b|\bprefer\b.*\blong\b/.test(text);
  const biasShort = /\bbias\b.*\bshort\b|\btoward\b.*\bshort\b|\bprefer\b.*\bshort\b/.test(text);
  const closerTp = /\bcloser\s*tp\b|\btighter\s*tp\b/.test(text);
  return { isFilter, gapFlat, trendRange, highVol, biasLong, biasShort, closerTp };
}

function buildSetupConditionSentence(flags) {
  const parts = [];
  if (flags.gapFlat) parts.push('opening gap is flat');
  if (flags.trendRange) parts.push('session structure is ranging');
  if (flags.highVol) parts.push('volatility is elevated');
  if (parts.length === 0) return 'the named setup conditions are present';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function safePineName(name) {
  return String(name || '3130 Setup').replace(/"/g, "'").trim() || '3130 Setup';
}

function buildCommandSetupIndicatorScript(setup, flags) {
  const title = safePineName(setup?.name);
  const condParts = [];
  if (flags.gapFlat) condParts.push('gapFlat');
  if (flags.trendRange) condParts.push('trendRange');
  if (flags.highVol) condParts.push('highVol');
  const setupCondExpr = condParts.length ? condParts.join(' and ') : (flags.isFilter ? 'gapFlat' : 'true');
  const filterMode = flags.isFilter ? 'true' : 'false';
  const preferLong = flags.biasLong ? 'true' : 'false';
  const preferShort = flags.biasShort ? 'true' : 'false';
  const tpTicks = flags.closerTp ? 90 : 120;

  return `//@version=5
indicator("${title} [3130 Command Intel]", overlay=true, max_labels_count=500)

// Marker legend:
// - FILTER ON / SETUP ON: condition check at signal time.
// - GATE PASS: allowed to take new trades for this setup.
// - BLOCKED: gate is closed (skip entries).
// - ENTRY L / ENTRY S: simulated long/short entry.
// - WIN TP / LOSS SL: simulated outcome from bar highs/lows.

tz = input.string("America/New_York", "Timezone")
gapFlatMaxTicks = input.int(40, "Flat Gap Max (ticks)", minval=1)
trendRangeMaxTicks = input.int(180, "Range Trend Max (ticks)", minval=10)
highVolMinTicks = input.int(500, "High Vol Min (ticks)", minval=100)
signalHour = input.int(10, "Signal Hour (ET)", minval=0, maxval=23)
signalMinute = input.int(15, "Signal Minute (ET)", minval=0, maxval=59)
tpTicks = input.int(${tpTicks}, "TP (ticks)", minval=10)
slTicks = input.int(${tpTicks}, "SL (ticks)", minval=10)
maxTradesPerDay = input.int(2, "Max Trades / Day", minval=1, maxval=4)
isFilterMode = ${filterMode}
preferLongOnly = ${preferLong}
preferShortOnly = ${preferShort}

h = hour(time, tz)
m = minute(time, tz)
newDay = ta.change(time("D"))
inOrb = (h > 9 or (h == 9 and m >= 30)) and (h < 9 or (h == 9 and m <= 44))
inEntry = (h > 9 or (h == 9 and m >= 45)) and (h < 11)
onSignalBar = h == signalHour and m == signalMinute

prevClose = request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_off)
gapTicks = na(prevClose) ? na : math.abs((open - prevClose) / syminfo.mintick)
gapFlat = not na(gapTicks) and gapTicks <= gapFlatMaxTicks

inFirstHour = (h > 9 or (h == 9 and m >= 30)) and (h < 10 or (h == 10 and m <= 29))
var float firstHourHigh = na
var float firstHourLow = na
var float orbHigh = na
var float orbLow = na
if newDay
    firstHourHigh := na
    firstHourLow := na
    orbHigh := na
    orbLow := na
if inFirstHour
    firstHourHigh := na(firstHourHigh) ? high : math.max(firstHourHigh, high)
    firstHourLow := na(firstHourLow) ? low : math.min(firstHourLow, low)
if inOrb
    orbHigh := na(orbHigh) ? high : math.max(orbHigh, high)
    orbLow := na(orbLow) ? low : math.min(orbLow, low)

firstHourRangeTicks = na(firstHourHigh) or na(firstHourLow) ? na : (firstHourHigh - firstHourLow) / syminfo.mintick
trendRange = not na(firstHourRangeTicks) and firstHourRangeTicks <= trendRangeMaxTicks
highVol = not na(firstHourRangeTicks) and firstHourRangeTicks >= highVolMinTicks

setupMatch = ${setupCondExpr}
tradeAllowed = isFilterMode ? not setupMatch : setupMatch
gatePass = onSignalBar and tradeAllowed
gateBlocked = onSignalBar and not tradeAllowed
allowLong = not preferShortOnly
allowShort = not preferLongOnly
longBreak = inEntry and not na(orbHigh) and close > orbHigh and close[1] <= orbHigh
shortBreak = inEntry and not na(orbLow) and close < orbLow and close[1] >= orbLow

var bool inTrade = false
var int tradeSide = 0
var float entryPx = na
var float tpPx = na
var float slPx = na
var int tradesToday = 0
if newDay
    inTrade := false
    tradeSide := 0
    entryPx := na
    tpPx := na
    slPx := na
    tradesToday := 0

entryLong = false
entryShort = false
exitWin = false
exitLoss = false

canEnter = not inTrade and tradesToday < maxTradesPerDay and tradeAllowed
if canEnter and allowLong and longBreak
    entryLong := true
    inTrade := true
    tradeSide := 1
    entryPx := close
    tpPx := entryPx + (tpTicks * syminfo.mintick)
    slPx := entryPx - (slTicks * syminfo.mintick)
    tradesToday += 1
else if canEnter and allowShort and shortBreak
    entryShort := true
    inTrade := true
    tradeSide := -1
    entryPx := close
    tpPx := entryPx - (tpTicks * syminfo.mintick)
    slPx := entryPx + (slTicks * syminfo.mintick)
    tradesToday += 1

if inTrade
    longTP = tradeSide == 1 and high >= tpPx
    longSL = tradeSide == 1 and low <= slPx
    shortTP = tradeSide == -1 and low <= tpPx
    shortSL = tradeSide == -1 and high >= slPx
    winNow = (longTP or shortTP) and not (longSL or shortSL)
    lossNow = (longSL or shortSL)
    if (longTP and longSL) or (shortTP and shortSL)
        winNow := false
        lossNow := true
    if winNow or lossNow
        exitWin := winNow
        exitLoss := lossNow
        inTrade := false
        tradeSide := 0
        entryPx := na
        tpPx := na
        slPx := na

plotshape(onSignalBar and setupMatch and isFilterMode, title="Filter On", style=shape.labeldown, color=color.orange, text="FILTER ON", textcolor=color.black, location=location.abovebar, size=size.tiny)
plotshape(onSignalBar and setupMatch and not isFilterMode, title="Setup On", style=shape.labeldown, color=color.lime, text="SETUP ON", textcolor=color.black, location=location.abovebar, size=size.tiny)
plotshape(gatePass, title="Gate Pass", style=shape.circle, color=color.new(color.blue, 0), text="GATE PASS", textcolor=color.white, location=location.belowbar, size=size.tiny)
plotshape(gateBlocked, title="Gate Blocked", style=shape.xcross, color=color.red, text="BLOCKED", textcolor=color.white, location=location.abovebar, size=size.tiny)
plotshape(entryLong, title="Entry Long", style=shape.triangleup, color=color.lime, text="ENTRY L", textcolor=color.black, location=location.belowbar, size=size.tiny)
plotshape(entryShort, title="Entry Short", style=shape.triangledown, color=color.red, text="ENTRY S", textcolor=color.white, location=location.abovebar, size=size.tiny)
plotshape(exitWin, title="Exit Win", style=shape.labelup, color=color.lime, text="WIN TP", textcolor=color.black, location=location.abovebar, size=size.tiny)
plotshape(exitLoss, title="Exit Loss", style=shape.labeldown, color=color.red, text="LOSS SL", textcolor=color.white, location=location.belowbar, size=size.tiny)

bgcolor(isFilterMode and setupMatch ? color.new(color.red, 88) : na)

activeEntry = inTrade ? entryPx : na
activeTp = inTrade ? tpPx : na
activeSl = inTrade ? slPx : na
plot(activeEntry, "Active Entry", color=color.new(color.white, 0), style=plot.style_linebr)
plot(activeTp, "Active TP", color=color.new(color.lime, 0), style=plot.style_linebr)
plot(activeSl, "Active SL", color=color.new(color.red, 0), style=plot.style_linebr)
plot(firstHourHigh, "First-Hour High", color=color.new(color.aqua, 10))
plot(firstHourLow, "First-Hour Low", color=color.new(color.orange, 10))
plot(orbHigh, "ORB High", color=color.new(color.aqua, 0))
plot(orbLow, "ORB Low", color=color.new(color.orange, 0))
`;
}

function buildCommandSetupStrategyScript(setup, flags, riskPlan = {}) {
  const title = safePineName(setup?.name);
  const condParts = [];
  if (flags.gapFlat) condParts.push('gapFlat');
  if (flags.trendRange) condParts.push('trendRange');
  if (flags.highVol) condParts.push('highVol');
  const setupCondExpr = condParts.length ? condParts.join(' and ') : (flags.isFilter ? 'gapFlat' : 'true');
  const filterMode = flags.isFilter ? 'true' : 'false';
  const preferLong = flags.biasLong ? 'true' : 'false';
  const preferShort = flags.biasShort ? 'true' : 'false';
  const tpTicks = flags.closerTp ? 90 : 120;
  const maxTrades = Math.max(1, Number(riskPlan?.maxTrades || 2));

  return `//@version=5
strategy("${title} [3130 Command Strategy]", overlay=true, initial_capital=50000, process_orders_on_close=true)

tz = input.string("America/New_York", "Timezone")
tpTicks = input.int(${tpTicks}, "TP (ticks)", minval=10)
slTicks = input.int(${tpTicks}, "SL (ticks, 1:1 default)", minval=10)
gapFlatMaxTicks = input.int(40, "Flat Gap Max (ticks)", minval=1)
trendRangeMaxTicks = input.int(180, "Range Trend Max (ticks)", minval=10)
highVolMinTicks = input.int(500, "High Vol Min (ticks)", minval=100)
maxTradesPerDay = input.int(${maxTrades}, "Max Trades / Day", minval=1, maxval=4)
isFilterMode = ${filterMode}
preferLongOnly = ${preferLong}
preferShortOnly = ${preferShort}

h = hour(time, tz)
m = minute(time, tz)
newDay = ta.change(time("D"))
inOrb = (h > 9 or (h == 9 and m >= 30)) and (h < 9 or (h == 9 and m <= 44))
inEntry = (h > 9 or (h == 9 and m >= 45)) and (h < 11)

var float orbHigh = na
var float orbLow = na
var int tradesToday = 0
if newDay
    orbHigh := na
    orbLow := na
    tradesToday := 0
if inOrb
    orbHigh := na(orbHigh) ? high : math.max(orbHigh, high)
    orbLow := na(orbLow) ? low : math.min(orbLow, low)

prevClose = request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_off)
gapTicks = na(prevClose) ? na : math.abs((open - prevClose) / syminfo.mintick)
gapFlat = not na(gapTicks) and gapTicks <= gapFlatMaxTicks

inFirstHour = (h > 9 or (h == 9 and m >= 30)) and (h < 10 or (h == 10 and m <= 29))
var float firstHourHigh = na
var float firstHourLow = na
if newDay
    firstHourHigh := na
    firstHourLow := na
if inFirstHour
    firstHourHigh := na(firstHourHigh) ? high : math.max(firstHourHigh, high)
    firstHourLow := na(firstHourLow) ? low : math.min(firstHourLow, low)
firstHourRangeTicks = na(firstHourHigh) or na(firstHourLow) ? na : (firstHourHigh - firstHourLow) / syminfo.mintick
trendRange = not na(firstHourRangeTicks) and firstHourRangeTicks <= trendRangeMaxTicks
highVol = not na(firstHourRangeTicks) and firstHourRangeTicks >= highVolMinTicks

setupMatch = ${setupCondExpr}
tradeAllowed = isFilterMode ? not setupMatch : setupMatch

longBreak = inEntry and not na(orbHigh) and close > orbHigh and close[1] <= orbHigh
shortBreak = inEntry and not na(orbLow) and close < orbLow and close[1] >= orbLow
canEnter = strategy.position_size == 0 and tradesToday < maxTradesPerDay and tradeAllowed
allowLong = not preferShortOnly
allowShort = not preferLongOnly

if canEnter and allowLong and longBreak
    strategy.entry("L", strategy.long)
    tradesToday += 1
else if canEnter and allowShort and shortBreak
    strategy.entry("S", strategy.short)
    tradesToday += 1

tpPts = tpTicks * syminfo.mintick
slPts = slTicks * syminfo.mintick
if strategy.position_size > 0
    strategy.exit("L-Exit", "L", stop=strategy.position_avg_price - slPts, limit=strategy.position_avg_price + tpPts)
if strategy.position_size < 0
    strategy.exit("S-Exit", "S", stop=strategy.position_avg_price + slPts, limit=strategy.position_avg_price - tpPts)
`;
}

function buildCommandSetupDetail(setup, cmd) {
  const safeSetup = setup || {};
  const plan = cmd?.plan || {};
  const riskPlan = plan?.riskPlan || {};
  const flags = parseSetupTokens(safeSetup.name, safeSetup.rationale);
  const conditionText = buildSetupConditionSentence(flags);
  const freq = classifySetupFrequency(safeSetup.annualizedTrades);
  const typeLabel = flags.isFilter
    ? 'Risk Filter'
    : flags.closerTp
      ? 'Exit Variant'
      : (flags.biasLong || flags.biasShort)
        ? 'Directional Bias'
        : 'Entry Setup';
  const confidenceNote = `Decision confidence ${cmd?.decision?.confidence ?? 0}% is a readiness score, not a guaranteed single-trade win rate.`;

  const plainEnglish = flags.isFilter
    ? `This setup is a gate, not a trigger. If ${conditionText}, stand down and skip marginal entries.`
    : `This setup is tradeable when ${conditionText}. Enter only after your trigger and structure are both valid.`;

  const barByBar = [
    '09:30-09:44 ET: script builds ORB high/low (reference range).',
    '09:30-10:29 ET: script measures first-hour structure for gap/range/vol filters.',
    '10:15 ET default signal bar: script prints FILTER ON/SETUP ON and GATE PASS/BLOCKED.',
    '09:45-10:59 ET: entry scan. ENTRY L appears on break above ORB high; ENTRY S on break below ORB low.',
    'After entry: every new bar checks whether TP or SL was touched first.',
    'Exit marker: WIN TP (green) or LOSS SL (red). If TP+SL touch same bar, script marks LOSS SL (conservative).',
  ];

  const markerLegend = [
    'FILTER ON (orange label): filter condition is active on the signal bar.',
    'SETUP ON (green label): setup condition detected on the signal bar.',
    'GATE PASS (blue circle): allowed to take new trades for this setup.',
    'BLOCKED (red X): no new entries should be taken.',
    'ENTRY L / ENTRY S (triangles): simulated entry trigger fired.',
    'WIN TP / LOSS SL (labels): simulated exit result from bar highs/lows.',
    'Active Entry / TP / SL lines: live trade levels while a simulated trade is open.',
  ];

  const stepByStep = flags.isFilter
    ? [
      'Open a 5-minute MNQ chart and add the indicator script from this panel.',
      'Use ET session time so first-hour calculations line up with market open.',
      'At 10:15 ET (default), read FILTER ON/SETUP ON and GATE PASS/BLOCKED.',
      'If BLOCKED appears, skip entries for this setup window.',
      'If GATE PASS appears, wait for ENTRY L or ENTRY S marker before acting.',
      'Use WIN TP / LOSS SL markers to review how the setup would have resolved.',
      `Respect limits: max ${riskPlan.maxTrades ?? 2} trades, stop-after-losses ${riskPlan.stopAfterConsecutiveLosses ?? 2}.`,
      'Log the outcome in Outcome Feedback Loop to improve live calibration.',
    ]
    : [
      'Open a 5-minute MNQ chart and add the indicator/strategy scripts.',
      'At 10:15 ET (default), confirm SETUP ON plus GATE PASS is printed.',
      'Wait for ENTRY L or ENTRY S marker inside 09:45-10:59 ET window.',
      'Do not anticipate breakouts before marker confirmation.',
      'Track active Entry/TP/SL lines once in trade.',
      'Exit review is explicit: WIN TP or LOSS SL marker prints when resolved.',
      `Run ${riskPlan.mode || 'NORMAL'} risk mode with max ${riskPlan.maxTrades ?? 2} trades.`,
      `Use 1:1 default exits unless your current playbook says otherwise (size: ${riskPlan.sizeGuidance || 'half-size'}).`,
      'After the trade, log win/loss/breakeven and notes for learning feedback.',
    ];

  const riskRules = [
    `Max trades/day: ${riskPlan.maxTrades ?? 2}`,
    `Stop after consecutive losses: ${riskPlan.stopAfterConsecutiveLosses ?? 2}`,
    `Size guidance: ${riskPlan.sizeGuidance || 'half-size'}`,
    flags.isFilter ? 'Filter true = no trade for that condition window.' : 'No forced entries when condition is not clean.',
  ];

  const indicatorScript = buildCommandSetupIndicatorScript(safeSetup, flags);
  const strategyScript = buildCommandSetupStrategyScript(safeSetup, flags, riskPlan);
  const guideText = [
    `3130 Command Intel Guide`,
    `Setup: ${safeSetup.name || 'Unknown setup'}`,
    `Type: ${typeLabel}`,
    `Probability: ${safeSetup.probability ?? 0}% (${safeSetup.grade || 'not graded'})`,
    `Expected Value: $${safeSetup.expectedValueDollars ?? 0}`,
    `Frequency: ${freq.label}`,
    '',
    `Plain English: ${plainEnglish}`,
    `Confidence Note: ${confidenceNote}`,
    safeSetup.rationale ? `Rationale: ${safeSetup.rationale}` : null,
    '',
    'Step-by-Step:',
    ...stepByStep.map((s, idx) => `${idx + 1}. ${s}`),
    '',
    'Bar-by-Bar Workflow:',
    ...barByBar.map((s, idx) => `${idx + 1}. ${s}`),
    '',
    'Chart Marker Legend:',
    ...markerLegend.map((m, idx) => `${idx + 1}. ${m}`),
    '',
    'Risk Rules:',
    ...riskRules.map((r, idx) => `${idx + 1}. ${r}`),
    '',
    'Important Notes:',
    '1. Indicator outcomes are simulated from candle highs/lows; they are not broker fill reports.',
    '2. If both TP and SL touch on the same bar, the script records LOSS SL for conservative review.',
    '3. Confirm signals with your broker platform before executing live orders.',
  ].filter(Boolean).join('\n');

  return {
    typeLabel,
    plainEnglish,
    confidenceNote,
    conditionText,
    frequency: freq,
    stepByStep,
    barByBar,
    markerLegend,
    riskRules,
    scripts: {
      indicator: indicatorScript,
      strategy: strategyScript,
    },
    guideText,
  };
}

// ═══════════════════════════════════════════
// BRIEFING
// ═══════════════════════════════════════════
function Briefing({ strategy }) {
  const cmdUrl = strategy === 'alt' ? '/api/command/snapshot?strategy=alt' : '/api/command/snapshot?strategy=original';
  const deskUrl = strategy === 'alt' ? '/api/desk/start-sequence?strategy=alt' : '/api/desk/start-sequence?strategy=original';
  const feedbackUrl = '/api/feedback/trade-outcomes?limit=80';
  const intelUrl = strategy === 'alt' ? '/api/intel?strategy=alt' : '/api/intel';
  const sessUrl = strategy === 'alt' ? '/api/sessions?strategy=alt' : '/api/sessions';
  const agentsUrl = strategy === 'alt' ? '/api/agents/briefing?strategy=alt' : '/api/agents/briefing';
  const historyUrl = strategy === 'alt' ? '/api/agents/briefing/history?strategy=alt&limit=14' : '/api/agents/briefing/history?limit=14';
  const eliteUrl = strategy === 'alt' ? '/api/coach/elite-brief?strategy=alt' : '/api/coach/elite-brief?strategy=original';
  const commandCenterUrl = '/api/jarvis/command-center';
  const panelUrl = '/api/session/control-panel';
  const verdictUrl = '/api/verdict/daily';
  const topstepJournalUrl = '/api/topstep/auto-journal/status';
  const { data: commandData, reload: reloadCommand } = useApi(cmdUrl, [strategy]);
  const { data: commandCenterData } = useApi(commandCenterUrl, [strategy]);
  const { data: deskData, reload: reloadDesk } = useApi(deskUrl, [strategy]);
  const { data: feedbackData, reload: reloadFeedback } = useApi(feedbackUrl, [strategy]);
  const { data: intel, loading } = useApi(intelUrl, [strategy]);
  const { data: sessData } = useApi(sessUrl, [strategy]);
  const { data: agentsData } = useApi(agentsUrl, [strategy]);
  const { data: historyData } = useApi(historyUrl, [strategy]);
  const { data: eliteData } = useApi(eliteUrl, [strategy]);
  const { data: panelData } = useApi(panelUrl, [strategy]);
  const { data: verdictData } = useApi(verdictUrl, [strategy]);
  const { data: topstepJournalData, reload: reloadTopstepJournal } = useApi(topstepJournalUrl, [strategy]);
  const [sequenceBusy, setSequenceBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackForm, setFeedbackForm] = useState({
    setupId: '',
    setupName: '',
    outcome: 'win',
    pnlDollars: '',
    notes: '',
    wins: '1',
    losses: '1',
    breakeven: '0',
  });
  const [feedbackSentence, setFeedbackSentence] = useState('');
  const [selectedSetupId, setSelectedSetupId] = useState('');
  const setupIntelRef = useRef(null);
  const feedbackRef = useRef(null);

  const cmd = commandData?.snapshot || null;
  const sessions = sessData?.sessions || [];
  const last5 = sessions.slice(-5).reverse();
  const i = cmd?.intel || intel || {};
  const brief = i.todayBrief;
  const alertColors = { critical: 'red', warning: 'yellow', action: 'accent', info: 'blue' };
  const alertBg = { critical: 'var(--red-dim)', warning: 'var(--yellow-dim)', action: 'var(--accent-dim)', info: 'var(--blue-dim)' };

  const scoreColor = i.score >= 60 ? 'green' : i.score >= 40 ? 'yellow' : 'red';
  const verdictColor = i.score >= 60 ? 'green' : i.score >= 40 ? 'yellow' : 'red';
  const agents = cmd?.agents || agentsData || null;
  const history = cmd?.history || historyData?.history || [];
  const elite = cmd?.elite || eliteData?.brief || null;
  const panel = cmd?.panel || panelData?.panel || null;
  const setupScore = agents?.summary?.setupQuality?.score || 0;
  const setupGrade = agents?.summary?.setupQuality?.grade || '—';
  const riskLimits = agents?.agents?.risk?.limits;
  const topOps = agents?.agents?.pattern?.topOpportunities || cmd?.opportunities || [];
  const changes = agents?.today?.changedVsPriorDay || [];
  const nextAction = agents?.summary?.nextAction || cmd?.decision?.verdict || '—';
  const setupTone = setupScore >= 65 ? 'positive' : setupScore >= 50 ? 'neutral' : 'negative';
  const ctrl = panel?.execution;
  const tradeState = panel?.tradeState;
  const deskSequence = deskData?.sequence || null;
  const recentFeedback = feedbackData?.rows || [];
  const feedbackSummary = feedbackData?.summary || cmd?.feedback || {};
  const topDecisionSetups = cmd?.decision?.topSetups || [];
  const topSetupKey = topDecisionSetups.map((s) => s.setupId || s.rank || s.name).join('|');
  const selectedTopSetup = topDecisionSetups.find((s) => s.setupId === selectedSetupId) || topDecisionSetups[0] || null;
  const selectedSetupIntel = selectedTopSetup ? buildCommandSetupDetail(selectedTopSetup, cmd) : null;
  const selectedSetupSlug = String(selectedTopSetup?.setupId || 'setup').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const dailyVerdict = verdictData?.verdict || null;
  const topstepAutoJournal = topstepJournalData?.autoJournal || null;
  const newsEvents = elite?.news?.events || [];
  const focusNewsEvents = elite?.news?.focusEvents || [];
  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowEtMinutes = (nowEt.getHours() * 60) + nowEt.getMinutes();
  const releasedNews = newsEvents.filter((e) => Number.isFinite(e?.minutes) && e.minutes <= nowEtMinutes);
  const upcomingNews = newsEvents.filter((e) => !Number.isFinite(e?.minutes) || e.minutes > nowEtMinutes);
  const frontLineDecision = cmd?.decision || null;
  const heroWhy = dailyVerdict?.why10Words || frontLineDecision?.why10Words || 'Signal generated from current guardrails.';
  const commandCenter = commandCenterData?.commandCenter || null;
  const commandCenterTodayRecommendation = commandCenter?.todayRecommendation || {};
  const commandCenterDecisionBoard = commandCenter?.decisionBoard || {};
  const commandCenterTodayContext = commandCenter?.todayContext || {};
  const frontLineSignalRaw = (
    frontLineDecision?.signalLabel
    || frontLineDecision?.signal
    || frontLineDecision?.verdict
    || dailyVerdict?.signalLabel
    || dailyVerdict?.signal
    || nextAction
  );
  const decisionMomentSignal = normalizeDecisionSignal(frontLineSignalRaw);
  const frontLineSignalSource = frontLineDecision
    ? 'command_snapshot.decision'
    : (dailyVerdict ? 'daily_verdict' : 'agent_summary_fallback');
  const frontLineSignalLine = (
    frontLineDecision?.signalLine
    || dailyVerdict?.signalLine
    || `[${decisionMomentSignal}] ${heroWhy}`
  );
  const frontLineConfidence = Number.isFinite(Number(frontLineDecision?.confidence))
    ? Number(frontLineDecision.confidence)
    : null;
  const frontLineBlockers = Array.isArray(frontLineDecision?.blockers)
    ? frontLineDecision.blockers.slice(0, 3)
    : [];
  const decisionMomentPosture = String(
    commandCenterTodayRecommendation.posture
      || commandCenterDecisionBoard.posture
      || 'trade_selectively'
  ).replace(/_/g, ' ');
  const decisionMomentStrategy = commandCenterTodayRecommendation.recommendedStrategy
    || commandCenterDecisionBoard.todayRecommendation
    || commandCenter?.jarvisBrief?.recommendedStrategy
    || 'Original Trading Plan';
  const decisionMomentTpMode = commandCenterTodayRecommendation.recommendedTpMode
    || commandCenterDecisionBoard.tpRecommendation
    || 'Nearest';
  const decisionMomentProjectedWinChance = Number.isFinite(Number(commandCenterTodayRecommendation.projectedWinChance))
    ? Number(commandCenterTodayRecommendation.projectedWinChance)
    : (Number.isFinite(Number(commandCenterDecisionBoard.projectedWinChance))
      ? Number(commandCenterDecisionBoard.projectedWinChance)
      : (Number.isFinite(Number(cmd?.elite?.winModel?.point)) ? Number(cmd.elite.winModel.point) : null));
  const decisionMomentConfidenceScore = Number.isFinite(Number(commandCenterTodayRecommendation.confidenceScore))
    ? Number(commandCenterTodayRecommendation.confidenceScore)
    : (Number.isFinite(Number(commandCenterDecisionBoard?.confidence?.score))
      ? Number(commandCenterDecisionBoard.confidence.score)
      : (Number.isFinite(Number(cmd?.decision?.confidence)) ? Number(cmd.decision.confidence) : null));
  const decisionMomentConfidenceLabel = String(
    commandCenterTodayRecommendation.confidenceLabel
      || commandCenterDecisionBoard?.confidence?.label
      || 'medium'
  ).toLowerCase();
  const decisionMomentRegime = commandCenterDecisionBoard.regimeLabel
    || commandCenterTodayContext.marketRegime
    || commandCenter?.regimeLabel
    || 'unknown';
  const decisionMomentTrend = commandCenterTodayContext.marketTrend
    || cmd?.plan?.regime?.trend
    || 'unknown';
  const decisionMomentVolatility = commandCenterTodayContext.volatilityContext
    || cmd?.plan?.regime?.volatility
    || 'unknown';
  const decisionMomentOrbProfile = cmd?.plan?.regime?.orbSize
    || commandCenterTodayContext?.regimeDetection?.evidenceSignals?.orbProfile
    || 'unknown';
  const decisionMomentSessionPhase = commandCenterTodayContext.sessionPhase
    || 'unknown';
  const decisionMomentWhyRaw = [
    String(commandCenterTodayRecommendation.postureReason || '').trim(),
    String(commandCenterTodayRecommendation.tpRecommendationReason || '').trim(),
  ].filter(Boolean).join(' ');
  const decisionMomentWhy = (
    decisionMomentWhyRaw
      || commandCenterDecisionBoard.summaryLine
      || dailyVerdict?.signalLine
      || cmd?.decision?.signalLine
      || heroWhy
  ).slice(0, 300);
  const runtimeFreshnessStatus = String(
    commandCenterTodayRecommendation.liveRuntimeFreshnessStatus
      || commandCenter?.liveRuntimeFreshnessStatus
      || ''
  ).toLowerCase();
  const runtimeAutoRepairStatus = String(
    commandCenterTodayRecommendation.liveRuntimeAutoRepairStatus
      || commandCenter?.liveRuntimeAutoRepairStatus
      || ''
  ).toLowerCase();
  const runtimeMissingDerivedRows = (
    commandCenterTodayRecommendation.liveRuntimeDeterministicMissingDerivedRowsDetected === true
    || commandCenter?.liveRuntimeDeterministicMissingDerivedRowsDetected === true
  );
  const decisionMomentTrustMaterial = (
    runtimeFreshnessStatus === 'stale'
    || runtimeFreshnessStatus === 'repaired'
    || runtimeAutoRepairStatus === 'escalation'
    || runtimeMissingDerivedRows
  );
  const decisionMomentTrustLine = decisionMomentTrustMaterial
    ? (
      commandCenterTodayRecommendation.liveRuntimeLatestIntegrityIssue
      || commandCenter?.liveRuntimeLatestIntegrityIssue
      || 'Integrity warning detected; review before acting.'
    )
    : '';
  const decisionMomentCaution = (
    commandCenterTodayRecommendation.keyCaution
    || commandCenterDecisionBoard.newsCaution
    || commandCenterDecisionBoard.keyRisk
    || null
  );
  const recommendationContextSource = 'jarvis_command_center.todayRecommendation';
  // Baseline guard: a non-original strategy can only displace the original plan
  // if it clears a sample-size threshold AND strictly higher dollar P&L. Surface
  // the evaluation so users can see *why* the recommendation either stayed on
  // original or promoted a variant — not just the name of the chosen strategy.
  const baselineGuard = commandCenterTodayRecommendation.baselineGuard || null;
  const recommendationBasisDetail = commandCenterTodayRecommendation.recommendationBasisDetail || null;
  const baselineGuardEnforced = baselineGuard?.enforced === true;
  const baselineGuardApplied = baselineGuard?.applied === true;
  const baselineGuardPnlDelta = Number.isFinite(Number(baselineGuard?.pnlDeltaVsOriginal))
    ? Number(baselineGuard.pnlDeltaVsOriginal)
    : null;
  const baselineGuardTrades = Number.isFinite(Number(baselineGuard?.topStrategyTrades))
    ? Number(baselineGuard.topStrategyTrades)
    : null;
  const baselineGuardMinTrades = Number.isFinite(Number(baselineGuard?.minTradesThreshold))
    ? Number(baselineGuard.minTradesThreshold)
    : null;
  const baselineGuardReason = String(baselineGuard?.reason || '').trim();
  const baselineGuardStatusLabel = baselineGuardEnforced
    ? 'Variant rejected — original retained'
    : (baselineGuardApplied
      ? 'Variant cleared guard — promoted'
      : 'No variant challenger');
  const baselineGuardStatusTone = baselineGuardEnforced
    ? 'positive'
    : (baselineGuardApplied ? 'neutral' : 'neutral');
  const recommendationPostureBlocksTrade = /stand[\s_]?down|no[\s_]?trade|wait/.test(String(decisionMomentPosture || '').toLowerCase());
  const recommendationPostureFavorsTrade = !recommendationPostureBlocksTrade;
  const decisionLayerDivergent = (
    (decisionMomentSignal === "DON'T TRADE" && !recommendationPostureBlocksTrade)
    || (decisionMomentSignal === 'TRADE' && recommendationPostureBlocksTrade)
  );
  const decisionLayerAlignmentLabel = decisionLayerDivergent
    ? 'Live signal and trade lean disagree.'
    : 'Live signal and trade lean agree.';

  let decisionActionNowLabel = 'Wait';
  let decisionActionNowLine = 'Hold for clearer confirmation before acting.';
  if (decisionMomentSignal === "DON'T TRADE" && recommendationPostureFavorsTrade) {
    decisionActionNowLabel = 'Skip Now';
    decisionActionNowLine = 'Setup lean is constructive, but execution is blocked right now.';
  } else if (decisionMomentSignal === 'WAIT' && recommendationPostureFavorsTrade) {
    decisionActionNowLabel = 'Wait for Clearance';
    decisionActionNowLine = 'Trade lean is constructive, but wait until blockers clear.';
  } else if (decisionMomentSignal === 'TRADE' && recommendationPostureFavorsTrade) {
    decisionActionNowLabel = 'Trade Selectively';
    decisionActionNowLine = 'Signal and setup lean are aligned; keep risk disciplined.';
  } else if (decisionMomentSignal === 'TRADE' && recommendationPostureBlocksTrade) {
    decisionActionNowLabel = 'Reduced Size / Nearest';
    decisionActionNowLine = 'Signal is tradable, but model posture is defensive.';
  } else if (decisionMomentSignal === "DON'T TRADE") {
    decisionActionNowLabel = "Don't Trade";
    decisionActionNowLine = 'Stand down until live blockers clear.';
  } else if (decisionMomentSignal === 'WAIT') {
    decisionActionNowLabel = 'Wait';
    decisionActionNowLine = 'Stay patient and wait for a cleaner entry window.';
  }

  useEffect(() => {
    const top = cmd?.decision?.topSetups?.[0];
    if (!top) return;
    setFeedbackForm((prev) => ({
      ...prev,
      setupId: top.setupId || prev.setupId,
      setupName: top.name || prev.setupName,
    }));
  }, [cmd?.decision?.topSetups?.[0]?.setupId, cmd?.decision?.topSetups?.[0]?.name]);

  useEffect(() => {
    if (!topDecisionSetups.length) {
      if (selectedSetupId) setSelectedSetupId('');
      return;
    }
    if (!topDecisionSetups.some((s) => s.setupId === selectedSetupId)) {
      setSelectedSetupId(String(topDecisionSetups[0].setupId || ''));
    }
  }, [topSetupKey, selectedSetupId]);

  if (loading) return <><Topbar title="COMMAND INTEL" /><div className="content"><Loading /></div></>;

  const runDeskStartNow = async () => {
    setSequenceBusy(true);
    try {
      await fetch(`${deskUrl}&force=1`);
      reloadDesk();
      reloadCommand();
    } finally {
      setSequenceBusy(false);
    }
  };

  const scrollToCard = (ref) => {
    if (!ref?.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const bindSetupToFeedback = (setup, forcedOutcome = null) => {
    if (!setup) return;
    setFeedbackForm((prev) => ({
      ...prev,
      setupId: String(setup.setupId || prev.setupId),
      setupName: setup.name || prev.setupName,
      ...(forcedOutcome ? { outcome: forcedOutcome } : {}),
    }));
  };

  const postFeedbackPayload = async (payload) => {
    const res = await fetch('/api/feedback/trade-outcomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to log trade feedback.');
    return json;
  };

  const parseFeedbackSentence = () => {
    const raw = String(feedbackSentence || '').trim();
    if (!raw) {
      alert('Type a sentence first.');
      return;
    }
    const text = raw.toLowerCase();
    const parseCount = (patterns) => {
      for (const re of patterns) {
        const m = text.match(re);
        if (m && Number.isFinite(Number(m[1]))) return Math.max(0, Math.floor(Number(m[1])));
      }
      return 0;
    };
    let wins = parseCount([/(\d+)\s*(?:wins?|w)\b/, /\bwins?\s*[:=]?\s*(\d+)\b/]);
    let losses = parseCount([/(\d+)\s*(?:loss(?:es)?|l)\b/, /\bloss(?:es)?\s*[:=]?\s*(\d+)\b/]);
    let breakeven = parseCount([/(\d+)\s*(?:breakeven|break-even|be)\b/, /\b(?:breakeven|break-even|be)\s*[:=]?\s*(\d+)\b/]);

    let outcome = feedbackForm.outcome;
    const total = wins + losses + breakeven;
    if (total > 0) {
      const nonZeroKinds = [wins > 0, losses > 0, breakeven > 0].filter(Boolean).length;
      if (nonZeroKinds > 1) outcome = 'mixed';
      else if (wins > 0) outcome = 'win';
      else if (losses > 0) outcome = 'loss';
      else outcome = 'breakeven';
    } else {
      const hasWin = /\b(win|tp|target hit)\b/.test(text);
      const hasLoss = /\b(loss|sl|stop|stopped)\b/.test(text);
      const hasBe = /\b(be|breakeven|break-even)\b/.test(text);
      if ((hasWin && hasLoss) || (hasWin && hasBe) || (hasLoss && hasBe)) {
        outcome = 'mixed';
        if (!wins && !losses && !breakeven) {
          wins = hasWin ? 1 : 0;
          losses = hasLoss ? 1 : 0;
          breakeven = hasBe ? 1 : 0;
        }
      } else if (hasWin) {
        outcome = 'win';
      } else if (hasLoss) {
        outcome = 'loss';
      } else if (hasBe) {
        outcome = 'breakeven';
      }
    }

    let pnlDollars = '';
    const dollarMatch = raw.match(/([+-]?\s*\$\s*\d+(?:\.\d+)?)/i);
    const netMatch = raw.match(/\b(?:net|pnl|profit|loss)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
    const parsedPnl = dollarMatch
      ? Number(String(dollarMatch[1]).replace(/[^0-9+.-]/g, ''))
      : (netMatch ? Number(netMatch[1]) : null);
    if (Number.isFinite(parsedPnl)) pnlDollars = String(parsedPnl);

    setFeedbackForm((prev) => ({
      ...prev,
      setupId: prev.setupId || String(selectedTopSetup?.setupId || ''),
      setupName: prev.setupName || String(selectedTopSetup?.name || ''),
      outcome,
      wins: String(wins || 0),
      losses: String(losses || 0),
      breakeven: String(breakeven || 0),
      pnlDollars: pnlDollars || prev.pnlDollars,
      notes: raw,
    }));
    alert('Sentence parsed into outcome form.');
  };

  const submitFeedback = async () => {
    if (!feedbackForm.setupId || !feedbackForm.setupName) return alert('Missing setup mapping.');
    setFeedbackBusy(true);
    try {
      const payload = {
        setupId: feedbackForm.setupId,
        setupName: feedbackForm.setupName,
        outcome: feedbackForm.outcome,
        notes: feedbackForm.notes || null,
        source: 'briefing',
      };
      if (feedbackForm.outcome === 'mixed') {
        const wins = Math.max(0, Math.floor(Number(feedbackForm.wins || 0)));
        const losses = Math.max(0, Math.floor(Number(feedbackForm.losses || 0)));
        const breakeven = Math.max(0, Math.floor(Number(feedbackForm.breakeven || 0)));
        if ((wins + losses + breakeven) <= 0) {
          alert('For mixed outcome, enter at least one trade count (win/loss/breakeven).');
          setFeedbackBusy(false);
          return;
        }
        payload.wins = wins;
        payload.losses = losses;
        payload.breakeven = breakeven;
      }
      if (String(feedbackForm.pnlDollars || '').trim() !== '') payload.pnlDollars = Number(feedbackForm.pnlDollars);
      const json = await postFeedbackPayload(payload);
      const created = Number(json?.logged?.entriesCreated || 0);
      alert(created > 1 ? `Trade feedback logged (${created} entries).` : 'Trade feedback logged.');
      setFeedbackForm((prev) => ({ ...prev, notes: '', pnlDollars: '' }));
      reloadFeedback();
      reloadCommand();
      reloadTopstepJournal();
    } finally {
      setFeedbackBusy(false);
    }
  };

  const quickLogOutcome = async (outcome) => {
    if (!selectedTopSetup?.setupId || !selectedTopSetup?.name) {
      alert('Select a setup first.');
      return;
    }
    setFeedbackBusy(true);
    try {
      const json = await postFeedbackPayload({
        setupId: selectedTopSetup.setupId,
        setupName: selectedTopSetup.name,
        outcome,
        source: 'briefing_quick',
      });
      const created = Number(json?.logged?.entriesCreated || 0);
      alert(created > 1 ? `${outcome.toUpperCase()} logged (${created} entries).` : `${outcome.toUpperCase()} logged.`);
      bindSetupToFeedback(selectedTopSetup, outcome);
      reloadFeedback();
      reloadCommand();
      reloadTopstepJournal();
    } catch (err) {
      alert(err.message || 'Quick log failed.');
    } finally {
      setFeedbackBusy(false);
    }
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      alert(`${label} copied to clipboard.`);
    } catch {
      alert(`Could not copy ${label}.`);
    }
  };

  const downloadTextFile = (filename, text) => {
    try {
      const blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 250);
    } catch {
      alert(`Could not download ${filename}.`);
    }
  };

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'COMMAND INTEL — CLOSER TP' : 'COMMAND INTEL'} />
      <div className="content">
        <div className="glow-line" />

        <div className={`card decision-hero ${decisionMomentSignal === 'TRADE' ? 'hero-trade' : decisionMomentSignal === 'WAIT' ? 'hero-wait' : 'hero-dont'}`}>
          <div className="card-header" style={{ marginBottom: 8 }}>
            <div className="card-title">Decision Moment</div>
            <div className={`card-badge ${signalBadgeClass(decisionMomentSignal)}`}>{decisionMomentSignal}</div>
          </div>
          <div className="decision-hero-signal">Action Now: {decisionActionNowLabel}</div>
          <div className="decision-hero-line">{decisionActionNowLine}</div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 4 }}>
            Live Signal: {frontLineSignalLine}
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 4 }}>
            Signal Source: {frontLineSignalSource}
          </div>
          {frontLineBlockers.length > 0 && (
            <div className="decision-chip-row" style={{ marginTop: 8 }}>
              {frontLineBlockers.map((b, idx) => (
                <span key={`${b}-${idx}`} className="decision-chip">{b}</span>
              ))}
            </div>
          )}
          <div className="decision-hero-line" style={{ marginTop: 10 }}>
            Trade Lean: {decisionMomentPosture} · {decisionMomentStrategy} · TP {decisionMomentTpMode}
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 4 }}>
            Lean Source: {recommendationContextSource}
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 4, color: decisionLayerDivergent ? 'var(--yellow)' : 'var(--text-2)' }}>
            Signal Match: {decisionLayerAlignmentLabel}
          </div>
          <div className="grid grid-3" style={{ marginBottom: 8 }}>
            <Metric
              label="Projected Win Chance"
              value={decisionMomentProjectedWinChance != null ? `${Number(decisionMomentProjectedWinChance).toFixed(2)}%` : '—'}
              tone={Number(decisionMomentProjectedWinChance || 0) >= 55 ? 'positive' : (Number(decisionMomentProjectedWinChance || 0) >= 50 ? 'neutral' : 'negative')}
            />
            <Metric
              label="Context Confidence"
              value={decisionMomentConfidenceScore != null ? `${Number(decisionMomentConfidenceScore).toFixed(2)} (${String(decisionMomentConfidenceLabel || '').toUpperCase()})` : String(decisionMomentConfidenceLabel || '—').toUpperCase()}
              tone={decisionMomentConfidenceLabel === 'high' ? 'positive' : decisionMomentConfidenceLabel === 'medium' ? 'neutral' : 'negative'}
            />
            <Metric
              label="Top Caution"
              value={decisionMomentCaution || 'none'}
              tone={decisionMomentCaution ? 'negative' : 'positive'}
            />
          </div>
          <div className="grid grid-3" style={{ marginBottom: 8 }}>
            <Metric
              label="Front-Line Confidence"
              value={frontLineConfidence != null ? `${Number(frontLineConfidence).toFixed(2)}%` : '—'}
              tone={frontLineConfidence != null ? (frontLineConfidence >= 60 ? 'positive' : (frontLineConfidence >= 50 ? 'neutral' : 'negative')) : 'neutral'}
            />
            <Metric label="Recommended Strategy" value={decisionMomentStrategy} tone="neutral" />
            <Metric label="TP Recommendation" value={decisionMomentTpMode} tone="neutral" />
          </div>
          <div className="grid grid-5" style={{ marginBottom: 8 }}>
            <Metric label="Regime" value={decisionMomentRegime} tone="neutral" />
            <Metric label="Trend" value={decisionMomentTrend} tone="neutral" />
            <Metric label="Volatility" value={decisionMomentVolatility} tone="neutral" />
            <Metric label="ORB Profile" value={decisionMomentOrbProfile} tone="neutral" />
            <Metric label="Session Phase" value={String(decisionMomentSessionPhase || '').replace(/_/g, ' ')} tone="neutral" />
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 6 }}>
            Why this call: {decisionMomentWhy || 'Signal generated from current guardrails.'}
          </div>
          {(baselineGuardApplied || recommendationBasisDetail) && (
            <div
              className="card"
              style={{
                marginTop: 10,
                borderLeft: baselineGuardEnforced
                  ? '3px solid var(--green)'
                  : (baselineGuardApplied ? '3px solid var(--cyan)' : '3px solid var(--text-3)'),
                padding: 10,
                background: 'var(--bg-2)',
              }}
            >
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-1)', marginBottom: 6 }}>
                Baseline Guard · {baselineGuardStatusLabel}
              </div>
              <div className="grid grid-3" style={{ marginBottom: 6 }}>
                <Metric
                  label="Chosen Layer"
                  value={String(recommendationBasisDetail?.recommendedLayer || 'original').toUpperCase()}
                  tone={String(recommendationBasisDetail?.recommendedLayer || 'original') === 'original' ? 'positive' : 'neutral'}
                />
                <Metric
                  label="Variant $ vs Original"
                  value={baselineGuardPnlDelta != null
                    ? `${baselineGuardPnlDelta >= 0 ? '+' : ''}$${baselineGuardPnlDelta.toFixed(2)}`
                    : '—'}
                  tone={baselineGuardPnlDelta == null
                    ? 'neutral'
                    : (baselineGuardPnlDelta >= 0 ? 'positive' : 'negative')}
                />
                <Metric
                  label="Variant Trades"
                  value={baselineGuardTrades != null
                    ? `${baselineGuardTrades}${baselineGuardMinTrades != null ? ` / min ${baselineGuardMinTrades}` : ''}`
                    : '—'}
                  tone={baselineGuardTrades == null
                    ? 'neutral'
                    : (baselineGuardMinTrades != null && baselineGuardTrades >= baselineGuardMinTrades
                      ? 'positive'
                      : 'negative')}
                />
              </div>
              {baselineGuardReason && (
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                  {baselineGuardReason}
                </div>
              )}
              {!baselineGuardApplied && recommendationBasisDetail?.rationale && (
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                  {recommendationBasisDetail.rationale}
                </div>
              )}
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 9, marginTop: 4, color: 'var(--text-3)' }}>
                Guard rule: a variant must have ≥{baselineGuardMinTrades ?? 10} trades AND net higher dollar P&amp;L than original to displace it.
              </div>
            </div>
          )}
          {decisionMomentTrustLine && (
            <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 6, color: 'var(--yellow)' }}>
              Trust: {decisionMomentTrustLine}
            </div>
          )}
          <div className="decision-hero-actions" style={{ marginTop: 10 }}>
            <button className="touch-safe" onClick={() => scrollToCard(setupIntelRef)}>OPEN SETUP GUIDE</button>
            <button
              className="touch-safe"
              onClick={() => {
                if (selectedTopSetup) bindSetupToFeedback(selectedTopSetup);
                scrollToCard(feedbackRef);
              }}
            >
              LOG OUTCOME
            </button>
            <button className="touch-safe" onClick={runDeskStartNow} disabled={sequenceBusy}>
              {sequenceBusy ? 'REFRESHING...' : 'RUN DESK START'}
            </button>
          </div>
        </div>

        <details className="card" style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-1)' }}>
            Secondary Intel (execution, operations, research, history)
          </summary>
          <div style={{ marginTop: 10 }}>

        {elite && (
          <div className="card" style={{ borderLeft: '2px solid var(--cyan)' }}>
            <div className="card-header">
              <div className="card-title">Morning Command Deck</div>
              <div className="card-badge bg-cyan">{elite.modelVersion || 'ELITE'}</div>
            </div>
            <div className="grid grid-4" style={{ marginBottom: 10 }}>
              <Metric
                label="Win Chance"
                value={`${elite.winModel?.point ?? 0}%`}
                sub={`${elite.winModel?.rangeLow ?? 0}-${elite.winModel?.rangeHigh ?? 0}%`}
                tone={(elite.winModel?.point ?? 0) >= 55 ? 'positive' : (elite.winModel?.point ?? 0) >= 50 ? 'neutral' : 'negative'}
              />
              <Metric
                label="Confidence"
                value={String(elite.winModel?.confidenceLevel || 'low').toUpperCase()}
                sub={`${elite.winModel?.confidencePct ?? 0}%`}
                tone={elite.winModel?.confidenceLevel === 'high' ? 'positive' : elite.winModel?.confidenceLevel === 'medium' ? 'neutral' : 'negative'}
              />
              <Metric
                label="Outcome P50"
                value={`$${elite.outcome?.distribution?.p50 ?? 0}`}
                sub={`P10 $${elite.outcome?.distribution?.p10 ?? 0} / P90 $${elite.outcome?.distribution?.p90 ?? 0}`}
                tone={(elite.outcome?.distribution?.p50 ?? 0) >= 0 ? 'positive' : 'negative'}
              />
              <Metric
                label="Prob Green"
                value={`${elite.outcome?.distribution?.probGreen ?? 0}%`}
                sub={`Max ${elite.outcome?.maxTrades ?? 0} trades`}
                tone={(elite.outcome?.distribution?.probGreen ?? 0) >= 55 ? 'positive' : (elite.outcome?.distribution?.probGreen ?? 0) >= 50 ? 'neutral' : 'negative'}
              />
            </div>

            <div className="grid grid-3" style={{ marginBottom: 10 }}>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-0)' }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>PRE-MARKET FOCUS</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{(elite.phasePlan?.preMarket?.focus || []).join(' | ') || '—'}</div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-0)' }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>POST-ORB FOCUS</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{(elite.phasePlan?.postORB?.focus || []).join(' | ') || '—'}</div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-0)' }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>MIDDAY FOCUS</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{(elite.phasePlan?.midday?.focus || []).join(' | ') || '—'}</div>
              </div>
            </div>

            <div className="grid grid-2" style={{ marginBottom: 10 }}>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-0)' }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>SETUP ODDS</div>
                {(elite.setupProbabilities || []).slice(0, 4).map((s, idx) => (
                  <div key={idx} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '4px 0' }}>
                    <span style={{ color: s.probability >= 55 ? 'var(--green)' : s.probability >= 50 ? 'var(--yellow)' : 'var(--red)', fontWeight: 700 }}>
                      {s.probability}%
                    </span>
                    <span className="dim"> ({s.grade}) </span>
                    <span>{s.name}</span>
                  </div>
                ))}
                {(elite.setupProbabilities || []).length === 0 && (
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>No setup probability cards available.</div>
                )}
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-0)' }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>LEARNING LOOP</div>
                {(elite.learning?.completedDays || 0) > 0 ? (
                  <>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 4 }}>Completed days: {elite.learning.completedDays}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 4 }}>Hit-rate: {elite.learning.hitRate}%</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 4 }}>Avg abs error: {elite.learning.avgPredictionError}%</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Avg day PnL: ${elite.learning.avgPnlDollars}</div>
                  </>
                ) : (
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {topstepAutoJournal?.enabled
                      ? 'Auto-journal is active. Topstep fills will calibrate learning automatically.'
                      : 'Waiting for outcome logs to calibrate live performance.'}
                  </div>
                )}
              </div>
            </div>

            <div className="card-header" style={{ marginTop: 6 }}>
              <div className="card-title">News Calendar (ET)</div>
              <div className="card-badge bg-yellow">{elite.news?.eventCount ?? newsEvents.length}</div>
            </div>
            <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>
              Critical filter for decision engine: {(elite.news?.focusCurrencies || []).join(', ') || 'USD'} · {String(elite.news?.minImpact || 'Medium').toUpperCase()}+ ({elite.news?.focusEventCount ?? focusNewsEvents.length} events)
            </div>

            {focusNewsEvents.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>CRITICAL EVENTS (FILTERED)</div>
                {focusNewsEvents.slice(0, 5).map((e, idx) => (
                  <div key={`focus-${idx}`} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{e.time || 'TBD'} ET</span>
                    <span className="dim"> | {e.country} {String(e.impact || '').toUpperCase()}</span>
                    <span style={{ marginLeft: 8 }}>{e.title}</span>
                  </div>
                ))}
              </div>
            )}

            {newsEvents.length === 0 ? (
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>No calendar events found for today.</div>
            ) : (
              <>
                <div style={{ marginBottom: 8 }}>
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>RELEASED EARLIER TODAY</div>
                  {releasedNews.length === 0 ? (
                    <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>None released yet.</div>
                  ) : (
                    releasedNews.slice(-6).map((e, idx) => (
                      <div key={`released-${idx}`} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        <span style={{ color: 'var(--blue)', fontWeight: 700 }}>{e.time || 'TBD'} ET</span>
                        <span className="dim"> | {e.country} {String(e.impact || '').toUpperCase()}</span>
                        <span style={{ marginLeft: 8 }}>{e.title}</span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>UPCOMING TODAY</div>
                  {upcomingNews.length === 0 ? (
                    <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>No more scheduled events today.</div>
                  ) : (
                    upcomingNews.slice(0, 8).map((e, idx) => (
                      <div key={`upcoming-${idx}`} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{e.time || 'TBD'} ET</span>
                        <span className="dim"> | {e.country} {String(e.impact || '').toUpperCase()}</span>
                        <span style={{ marginLeft: 8 }}>{e.title}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {dailyVerdict && (
          <div className="card" style={{ borderLeft: '2px solid var(--cyan)' }}>
            <div className="card-header">
              <div className="card-title">Daily Verdict (10:35 ET)</div>
              <div className={`card-badge ${signalBadgeClass(dailyVerdict.signalLabel || dailyVerdict.signal)}`}>
                {normalizeDecisionSignal(dailyVerdict.signalLabel || dailyVerdict.signal)}
              </div>
            </div>
            <div style={{ padding: '8px 12px', marginBottom: 6, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {dailyVerdict.signalLine || `[${normalizeDecisionSignal(dailyVerdict.signalLabel || dailyVerdict.signal)}] ${dailyVerdict.why10Words || ''}`}
            </div>
            <div className="data-row"><span className="label">Performance</span><span className="value">{dailyVerdict.performanceLine || 'No data yet.'}</span></div>
            <div className="data-row"><span className="label">Final Result</span><span className="value">{dailyVerdict.finalResultLine || 'No final result yet.'}</span></div>
          </div>
        )}

        {cmd?.decision && (
          <div className="card" style={{ borderLeft: '2px solid var(--accent)' }}>
            <div className="card-header">
              <div className="card-title">Unified Trade Decision</div>
              <div className={`card-badge ${signalBadgeClass(cmd.decision.signalLabel || cmd.decision.signal || cmd.decision.verdict)}`}>
                {normalizeDecisionSignal(cmd.decision.signalLabel || cmd.decision.signal || cmd.decision.verdict)}
              </div>
            </div>
            <div style={{ padding: '8px 12px', marginBottom: 8, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {cmd.decision.signalLine || `[${normalizeDecisionSignal(cmd.decision.signalLabel || cmd.decision.signal || cmd.decision.verdict)}] ${cmd.decision.why10Words || ''}`}
            </div>
            <div className="grid grid-3" style={{ marginBottom: 10 }}>
              <Metric label="Decision Confidence" value={`${cmd.decision.confidence || 0}%`} tone={signalTone(cmd.decision.signalLabel || cmd.decision.signal || cmd.decision.verdict)} />
              <Metric label="Blockers" value={cmd.decision.blockers?.length ?? 0} sub={(cmd.decision.blockers || []).slice(0, 2).join(', ') || 'none'} tone={(cmd.decision.blockers || []).length ? 'negative' : 'positive'} />
              <Metric label="Top Setup" value={cmd.decision.topSetups?.[0]?.name || '—'} sub={cmd.decision.topSetups?.[0] ? `${cmd.decision.topSetups[0].probability}% / ${cmd.decision.topSetups[0].grade}` : undefined} tone="neutral" />
            </div>
            {(cmd.decision.actionablePlan || []).map((step, idx) => (
              <div key={idx} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {idx + 1}. {step}
              </div>
            ))}
            {(cmd.decision.topSetups || []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>TOP SETUPS + LIVE FEEDBACK</div>
                {(cmd.decision.topSetups || []).slice(0, 3).map((s) => (
                  <div
                    key={s.setupId || s.rank}
                    onClick={() => {
                      setSelectedSetupId(s.setupId);
                      bindSetupToFeedback(s);
                    }}
                    style={{
                      padding: '8px 12px',
                      marginBottom: 5,
                      borderRadius: 'var(--radius)',
                      border: selectedTopSetup?.setupId === s.setupId ? '1px solid var(--cyan)' : '1px solid transparent',
                      background: selectedTopSetup?.setupId === s.setupId ? 'var(--cyan-dim)' : 'var(--bg-3)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: 6 }}>#{s.rank}</span>
                    {s.name} · {s.probability}% ({s.grade})
                    {Number.isFinite(s.liveWinRate) && (
                      <span className="dim"> · live {s.liveWinRate}% on {s.liveSamples || 0}</span>
                    )}
                  </div>
                ))}
                {selectedTopSetup && selectedSetupIntel && (
                  <div ref={setupIntelRef} style={{ marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-1)' }}>
                    <div className="card-header">
                      <div className="card-title">Setup Execution Intel</div>
                      <div className="card-badge bg-cyan">CLICK-TO-TRADE GUIDE</div>
                    </div>
                    <div className="setup-action-rail">
                      <button className="touch-safe rail-step is-active" onClick={() => scrollToCard(setupIntelRef)}>1 READ SETUP</button>
                      <button className="touch-safe rail-step" onClick={() => copyText(selectedSetupIntel.scripts.indicator, 'Indicator script')}>2 LOAD SCRIPT</button>
                      <button
                        className="touch-safe rail-step"
                        onClick={() => {
                          bindSetupToFeedback(selectedTopSetup);
                          scrollToCard(feedbackRef);
                        }}
                      >
                        3 LOG OUTCOME
                      </button>
                    </div>
                    <div className="grid grid-4" style={{ marginBottom: 10 }}>
                      <Metric label="Selected Setup" value={selectedTopSetup.name || '—'} tone="neutral" />
                      <Metric label="Type" value={selectedSetupIntel.typeLabel} tone="neutral" />
                      <Metric label="Odds" value={`${selectedTopSetup.probability || 0}% (${selectedTopSetup.grade || '—'})`} tone={(selectedTopSetup.probability || 0) >= 55 ? 'positive' : 'neutral'} />
                      <Metric label="Frequency" value={selectedSetupIntel.frequency.bucket.toUpperCase()} sub={selectedSetupIntel.frequency.label} tone="neutral" />
                    </div>
                    <div className="data-row"><span className="label">Plain English</span><span className="value">{selectedSetupIntel.plainEnglish}</span></div>
                    <div className="data-row"><span className="label">Condition</span><span className="value">{selectedSetupIntel.conditionText}</span></div>
                    <div className="data-row"><span className="label">Confidence Note</span><span className="value">{selectedSetupIntel.confidenceNote}</span></div>

                    <div style={{ marginTop: 10, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>STEP-BY-STEP EXECUTION</div>
                    {selectedSetupIntel.stepByStep.map((step, idx) => (
                      <div key={`step-${idx}`} style={{ padding: '8px 10px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {idx + 1}. {step}
                      </div>
                    ))}

                    <div style={{ marginTop: 8, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>BAR-BY-BAR WORKFLOW</div>
                    {selectedSetupIntel.barByBar.map((step, idx) => (
                      <div key={`bar-${idx}`} style={{ padding: '8px 10px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {idx + 1}. {step}
                      </div>
                    ))}

                    <div style={{ marginTop: 8, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>CHART MARKER LEGEND</div>
                    {selectedSetupIntel.markerLegend.map((line, idx) => (
                      <div key={`legend-${idx}`} className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 3 }}>
                        • {line}
                      </div>
                    ))}

                    <div style={{ marginTop: 8, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>RISK GUARDRAILS</div>
                    {selectedSetupIntel.riskRules.map((rule, idx) => (
                      <div key={`risk-${idx}`} className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 3 }}>
                        • {rule}
                      </div>
                    ))}

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, marginBottom: 10 }}>
                      <button className="touch-safe" onClick={() => copyText(selectedSetupIntel.scripts.indicator, 'Indicator script')} style={{ fontSize: 10 }}>
                        Copy Indicator Script
                      </button>
                      <button className="touch-safe" onClick={() => copyText(selectedSetupIntel.scripts.strategy, 'Strategy script')} style={{ fontSize: 10 }}>
                        Copy Strategy Script
                      </button>
                      <button className="touch-safe" onClick={() => downloadTextFile(`3130_${selectedSetupSlug}_guide.txt`, selectedSetupIntel.guideText)} style={{ fontSize: 10 }}>
                        Download Guide (.txt)
                      </button>
                      <button className="touch-safe" onClick={() => downloadTextFile(`3130_${selectedSetupSlug}_indicator.pine`, selectedSetupIntel.scripts.indicator)} style={{ fontSize: 10 }}>
                        Download Indicator (.pine)
                      </button>
                      <button className="touch-safe" onClick={() => downloadTextFile(`3130_${selectedSetupSlug}_strategy.pine`, selectedSetupIntel.scripts.strategy)} style={{ fontSize: 10 }}>
                        Download Strategy (.pine)
                      </button>
                      <button className="touch-safe" onClick={() => quickLogOutcome('win')} disabled={feedbackBusy} style={{ fontSize: 10 }}>
                        ONE-CLICK WIN
                      </button>
                      <button className="touch-safe" onClick={() => quickLogOutcome('loss')} disabled={feedbackBusy} style={{ fontSize: 10 }}>
                        ONE-CLICK LOSS
                      </button>
                      <button className="touch-safe" onClick={() => quickLogOutcome('breakeven')} disabled={feedbackBusy} style={{ fontSize: 10 }}>
                        ONE-CLICK BE
                      </button>
                    </div>

                    <div className="grid grid-2" style={{ marginTop: 6 }}>
                      <div>
                        <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>INDICATOR PREVIEW</div>
                        <textarea
                          readOnly
                          value={selectedSetupIntel.scripts.indicator}
                          style={{ width: '100%', minHeight: 180, borderRadius: 'var(--radius)', background: 'var(--bg-2)', border: '1px solid var(--border-1)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 10, padding: 8 }}
                        />
                      </div>
                      <div>
                        <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>STRATEGY PREVIEW</div>
                        <textarea
                          readOnly
                          value={selectedSetupIntel.scripts.strategy}
                          style={{ width: '100%', minHeight: 180, borderRadius: 'var(--radius)', background: 'var(--bg-2)', border: '1px solid var(--border-1)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 10, padding: 8 }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-2">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Desk Start Sequence</div>
              <div className={`card-badge ${deskSequence?.status === 'ok' ? 'bg-green' : 'bg-yellow'}`}>
                {deskSequence?.status === 'ok' ? 'READY' : 'NO DATA'}
              </div>
            </div>
            <button
              onClick={runDeskStartNow}
              disabled={sequenceBusy}
              style={{
                marginBottom: 10, padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              {sequenceBusy ? 'REFRESHING...' : 'RUN DESK START NOW'}
            </button>
            {(deskSequence?.checklist || []).length === 0 ? (
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>No sequence available yet.</div>
            ) : (
              (deskSequence?.checklist || []).slice(0, 6).map((line, idx) => (
                <div key={idx} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {idx + 1}. {line}
                </div>
              ))
            )}
          </div>

          <div className="card" ref={feedbackRef}>
            <div className="card-header">
              <div className="card-title">Outcome Feedback Loop</div>
              <div className="card-badge bg-cyan">LIVE</div>
            </div>
            <div className="grid grid-3" style={{ marginBottom: 10 }}>
              <Metric label="Samples" value={feedbackSummary.totalSamples || 0} tone="neutral" />
              <Metric label="Live WR" value={`${feedbackSummary.totalWinRate || 0}%`} tone={(feedbackSummary.totalWinRate || 0) >= 50 ? 'positive' : 'negative'} />
              <Metric
                label="Top Focus"
                value={feedbackSummary.topFocus?.[0]?.setupName || topDecisionSetups?.[0]?.name || '—'}
                sub={feedbackSummary.topFocus?.[0] ? `${feedbackSummary.topFocus[0].winRate}% on ${feedbackSummary.topFocus[0].samples}` : undefined}
                tone="neutral"
              />
            </div>
            <div style={{ padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--bg-3)', border: '1px solid var(--border-1)', marginBottom: 8 }}>
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>AUTO JOURNAL</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {topstepAutoJournal?.enabled
                  ? `ON · Pending fills ${topstepAutoJournal.pendingFills || 0} · Last add ${topstepAutoJournal.latestRun?.feedbackRowsAdded || 0} rows`
                  : 'OFF · Manual outcome entry required'}
              </div>
              {topstepAutoJournal?.latestRun?.createdAt && (
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 3 }}>
                  Last run: {topstepAutoJournal.latestRun.createdAt} ({String(topstepAutoJournal.latestRun.status || '').toUpperCase()})
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginBottom: 8 }}>
              <input
                placeholder="Plain English: 1 win 1 loss net -$80 first entry failed"
                value={feedbackSentence}
                onChange={(e) => setFeedbackSentence(e.target.value)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <button className="touch-safe" onClick={parseFeedbackSentence} style={{ fontSize: 10 }}>
                Auto-Fill
              </button>
            </div>
            <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 8 }}>
              Use plain English to fill mixed outcomes quickly.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <select
                value={feedbackForm.setupId}
                onChange={(e) => {
                  const sid = e.target.value;
                  const match = topDecisionSetups.find((s) => s.setupId === sid);
                  setFeedbackForm((prev) => ({ ...prev, setupId: sid, setupName: match?.name || prev.setupName }));
                }}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              >
                <option value="">Select setup</option>
                {topDecisionSetups.map((s) => (
                  <option key={s.setupId} value={s.setupId}>{s.name}</option>
                ))}
              </select>
              <select
                value={feedbackForm.outcome}
                onChange={(e) => setFeedbackForm((prev) => ({ ...prev, outcome: e.target.value }))}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              >
                <option value="win">win</option>
                <option value="loss">loss</option>
                <option value="breakeven">breakeven</option>
                <option value="mixed">mixed (counted)</option>
              </select>
              <input
                placeholder={feedbackForm.outcome === 'mixed' ? 'Net PnL $ (optional)' : 'PnL $'}
                value={feedbackForm.pnlDollars}
                onChange={(e) => setFeedbackForm((prev) => ({ ...prev, pnlDollars: e.target.value }))}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <input
                placeholder="improvement notes / what happened"
                value={feedbackForm.notes}
                onChange={(e) => setFeedbackForm((prev) => ({ ...prev, notes: e.target.value }))}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
            </div>
            {feedbackForm.outcome === 'mixed' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>WINS</div>
                  <input
                    type="number"
                    min="0"
                    placeholder="wins"
                    value={feedbackForm.wins}
                    onChange={(e) => setFeedbackForm((prev) => ({ ...prev, wins: e.target.value }))}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  />
                </div>
                <div>
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>LOSSES</div>
                  <input
                    type="number"
                    min="0"
                    placeholder="losses"
                    value={feedbackForm.losses}
                    onChange={(e) => setFeedbackForm((prev) => ({ ...prev, losses: e.target.value }))}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  />
                </div>
                <div>
                  <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 4 }}>BREAKEVEN</div>
                  <input
                    type="number"
                    min="0"
                    placeholder="breakeven"
                    value={feedbackForm.breakeven}
                    onChange={(e) => setFeedbackForm((prev) => ({ ...prev, breakeven: e.target.value }))}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  />
                </div>
              </div>
            )}
            <button
              className="touch-safe"
              onClick={submitFeedback}
              disabled={feedbackBusy}
              style={{
                marginBottom: 10, padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              {feedbackBusy ? 'LOGGING...' : 'LOG TRADE OUTCOME'}
            </button>
            {(feedbackSummary?.testIdeas || []).length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 6 }}>NOTES → TEST IDEAS</div>
                {(feedbackSummary.testIdeas || []).slice(0, 4).map((idea, idx) => (
                  <div key={`idea-${idx}`} style={{ padding: '8px 10px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {idx + 1}. {idea}
                  </div>
                ))}
              </div>
            )}
            {(recentFeedback || []).slice(0, 4).map((row) => (
              <div key={row.id} style={{ padding: '8px 12px', marginBottom: 5, borderRadius: 'var(--radius)', background: 'var(--bg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                <span className={row.outcome === 'win' ? 'green' : row.outcome === 'loss' ? 'red' : 'yellow'} style={{ fontWeight: 700, marginRight: 6 }}>
                  {String(row.outcome || '').toUpperCase()}
                </span>
                {row.setupName}
                {Number.isFinite(row.pnlDollars) && <span className="dim"> · ${Number(row.pnlDollars).toFixed(2)}</span>}
                {row.notes && <span className="dim"> · {String(row.notes).slice(0, 72)}</span>}
              </div>
            ))}
            {(recentFeedback || []).length === 0 && (
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>No logged outcomes yet.</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Daily Agent Briefing</div>
            <div className="card-badge bg-cyan">{nextAction}</div>
          </div>
          <div className="grid grid-4" style={{ marginBottom: 10 }}>
            <Metric label="Setup Quality" value={`${setupScore}/100`} sub={`Grade ${setupGrade}`} tone={setupTone} />
            <Metric label="Risk Mode" value={riskLimits?.mode || '—'} tone={riskLimits?.mode === 'NORMAL' ? 'positive' : riskLimits?.mode ? 'negative' : 'neutral'} />
            <Metric label="Max Daily Loss" value={riskLimits ? `$${riskLimits.maxDailyLossDollars}` : '—'} tone="neutral" />
            <Metric label="Max Trades" value={riskLimits?.maxTrades ?? '—'} sub={riskLimits?.sizeGuidance || undefined} tone="neutral" />
          </div>

          {(agents?.summary?.setupQuality?.drivers || []).map((d, idx) => (
            <div key={idx} style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 6 }}>
              • {d}
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Session Control Panel</div>
            <div className={`card-badge ${ctrl?.canActNow ? 'bg-green' : 'bg-red'}`}>{ctrl?.canActNow ? 'ACTIONS OPEN' : 'BLOCKED'}</div>
          </div>
          <div className="grid grid-4">
            <Metric label="Kill Switch" value={ctrl?.controls?.killSwitch ? 'ON' : 'OFF'} tone={ctrl?.controls?.killSwitch ? 'negative' : 'positive'} />
            <Metric label="Max Size" value={ctrl?.controls?.maxPositionSize ?? '—'} tone="neutral" />
            <Metric label="Max Daily Loss" value={ctrl?.controls ? `$${ctrl.controls.maxDailyLossDollars}` : '—'} tone="neutral" />
            <Metric label="Realized PnL" value={ctrl?.realizedPnlDollars != null ? `$${Number(ctrl.realizedPnlDollars).toFixed(2)}` : '—'} tone={Number(ctrl?.realizedPnlDollars || 0) >= 0 ? 'positive' : 'negative'} />
          </div>
          <div className="data-row"><span className="label">Position</span><span className="value">{tradeState?.inPosition ? `${tradeState.side?.toUpperCase()} ${tradeState.qty} ${tradeState.symbol}` : 'Flat'}</span></div>
          <div className="data-row"><span className="label">Live PnL</span><span className="value">{tradeState ? `${tradeState.pnlTicks}t / $${Number(tradeState.pnlDollars || 0).toFixed(2)}` : '—'}</span></div>
          <div className="data-row"><span className="label">Autonomy Mode</span><span className="value">{ctrl?.autonomy?.mode || 'manual'} {ctrl?.autonomy?.paperAutoEnabled ? '(paper cycle on)' : ''}</span></div>
          <div className="data-row"><span className="label">Allowed Actions</span><span className="value">{(ctrl?.allowedActions || []).join(', ') || '—'}</span></div>
          <div className="data-row"><span className="label">Blocked Reasons</span><span className="value">{(ctrl?.blockedReasons || []).join(', ') || 'none'}</span></div>
        </div>

        {/* Verdict + Score */}
        <div className="grid grid-3" style={{ marginBottom: 12 }}>
          <Metric label="Strategy Verdict" value={i.verdict || '—'} color={verdictColor} tone={i.score >= 50 ? 'positive' : 'negative'} />
          <Metric label="Edge Score" value={`${i.score || 0}/100`} color={scoreColor} tone={i.score >= 50 ? 'positive' : 'negative'} />
          <Metric label="Edge Map" value={`${(i.edgeMap?.strong || []).length}↑ ${(i.edgeMap?.weak || []).length}— ${(i.edgeMap?.avoid || []).length}↓`}
            sub={i.edgeMap?.avoid?.length > 0 ? `Avoid: ${i.edgeMap.avoid.join(', ')}` : 'No days flagged to avoid'}
            tone="neutral" />
        </div>

        {/* Alerts */}
        {(i.alerts || []).length > 0 && (
          <div className="card">
            <div className="card-header">
              <div className="card-title">⚠ Active Alerts</div>
              <div className="card-badge bg-red">{i.alerts.length}</div>
            </div>
            {i.alerts.map((a, idx) => (
              <div key={idx} style={{
                padding: '10px 14px', marginBottom: 6, borderRadius: 'var(--radius)',
                background: alertBg[a.level] || 'var(--bg-3)',
                borderLeft: `2px solid var(--${alertColors[a.level] || 'text-3'})`,
                fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6,
                color: `var(--${alertColors[a.level] || 'text-1'})`,
              }}>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', marginRight: 8, fontSize: 9, letterSpacing: 1 }}>{a.level}</span>
                {a.msg}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-2">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Top 3 Opportunities</div>
              <div className="card-badge bg-accent">{topOps.length}</div>
            </div>
            {topOps.length === 0 ? (
              <div className="dim" style={{ textAlign: 'center', padding: 16 }}>No opportunity deltas detected.</div>
            ) : (
              topOps.map((op, idx) => (
                <div key={idx} style={{
                  padding: '10px 14px', marginBottom: 6, borderRadius: 'var(--radius)',
                  background: 'var(--bg-3)', borderLeft: '2px solid var(--accent)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 700, color: 'var(--accent)' }}>{op.title}</div>
                  <div className="dim">{op.rationale}</div>
                  <div style={{ marginTop: 4 }}>
                    <span className="green" style={{ marginRight: 10 }}>Impact ${op.expectedImpact}</span>
                    <span className="dim">{op.category} · {op.confidence}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Changed Vs Prior Day</div>
              <div className="card-badge bg-blue">{changes.length}</div>
            </div>
            {changes.length === 0 ? (
              <div className="dim" style={{ textAlign: 'center', padding: 16 }}>No recent changes detected.</div>
            ) : (
              changes.map((c, idx) => (
                <div key={idx} style={{
                  padding: '10px 14px', marginBottom: 6, borderRadius: 'var(--radius)',
                  background: 'var(--bg-3)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6,
                  color: 'var(--text-1)',
                }}>
                  {c}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header">
              <div className="card-title">Agent Memory Trend (Last 14)</div>
              <div className="card-badge bg-cyan">{history.length}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Setup</th><th>Edge</th><th>WR</th><th>Risk</th><th>Top Opportunity</th></tr></thead>
              <tbody>
                {history.map((h, idx) => (
                  <tr key={idx}>
                    <td>{h.briefing_date}</td>
                    <td>
                      <span className={h.setup_score >= 65 ? 'green' : h.setup_score >= 50 ? 'yellow' : 'red'}>
                        {h.setup_score}/100 ({h.setup_grade})
                      </span>
                      {h.deltas && <span className="dim"> {h.deltas.setupScore >= 0 ? '+' : ''}{h.deltas.setupScore}</span>}
                    </td>
                    <td>
                      <span className={h.edge_score >= 60 ? 'green' : h.edge_score >= 45 ? 'yellow' : 'red'}>{h.edge_score}</span>
                      {h.deltas && <span className="dim"> {h.deltas.edgeScore >= 0 ? '+' : ''}{h.deltas.edgeScore}</span>}
                    </td>
                    <td>{h.win_rate}%</td>
                    <td>{h.risk_mode || '—'}</td>
                    <td className="dim">{h.top_opportunity || '—'}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={6} className="dim">No agent memory yet. Open this module to create today's snapshot.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Today's Brief */}
        {brief && (
          <div className="card" style={{ borderLeft: brief.action === 'GREEN LIGHT' ? '2px solid var(--green)' : brief.action === 'CAUTION' ? '2px solid var(--red)' : '2px solid var(--yellow)' }}>
            <div className="card-header">
              <div className="card-title">Today — {brief.dayName} {brief.date}</div>
              <div className={`card-badge ${brief.action === 'GREEN LIGHT' ? 'bg-green' : brief.action === 'CAUTION' ? 'bg-red' : 'bg-yellow'}`}>
                {brief.action}
              </div>
            </div>
            {brief.lastSession && <div className="data-row"><span className="label">Last Session</span><span className="value dim">{brief.lastSession}</span></div>}
            <div className="data-row"><span className="label">Trend</span><span className="value">{brief.regime?.regime_trend || '—'}</span></div>
            <div className="data-row"><span className="label">Volatility</span><span className="value" style={{ color: brief.regime?.regime_vol === 'extreme' ? 'var(--red)' : brief.regime?.regime_vol === 'high' ? 'var(--yellow)' : 'inherit' }}>{brief.regime?.regime_vol || '—'}</span></div>
            <div className="data-row"><span className="label">ORB Size</span><span className="value">{brief.regime?.regime_orb_size || '—'}</span></div>
            <div className="data-row"><span className="label">{brief.dayName} Historical</span><span className="value">{brief.dayStats ? `${brief.dayStats.winRate}% WR, PF ${brief.dayStats.profitFactor}, $${brief.dayStats.totalPnlDollars?.toFixed(0)}` : '—'}</span></div>
            {brief.warnings.map((w, idx) => (
              <div key={idx} style={{ color: 'var(--yellow)', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 8, padding: '8px 12px', background: 'var(--yellow-dim)', borderRadius: 'var(--radius)' }}>
                ⚠ {w}
              </div>
            ))}
            {brief.signals.map((s, idx) => (
              <div key={idx} style={{ color: 'var(--green)', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 8, padding: '8px 12px', background: 'var(--green-dim)', borderRadius: 'var(--radius)' }}>
                ✓ {s}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-2">
          {/* Recommendations */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Recommendations</div>
              <div className="card-badge bg-accent">{(i.recommendations || []).length}</div>
            </div>
            {(i.recommendations || []).length === 0 ? (
              <div className="dim" style={{ textAlign: 'center', padding: 16 }}>No recommendations yet.</div>
            ) : (
              i.recommendations.map((r, idx) => (
                <div key={idx} style={{
                  padding: '10px 14px', marginBottom: 6, borderRadius: 'var(--radius)',
                  background: r.priority === 'high' ? 'var(--accent-dim)' : 'var(--bg-3)',
                  borderLeft: r.priority === 'high' ? '2px solid var(--accent)' : '2px solid var(--border-1)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6,
                  color: 'var(--text-1)',
                }}>
                  {r.impact > 0 && <span className="green" style={{ fontWeight: 700, fontSize: 10 }}>+${r.impact.toFixed(0)} </span>}
                  {r.msg}
                </div>
              ))
            )}
          </div>

          {/* Insights */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Insights</div>
              <div className="card-badge bg-blue">{(i.insights || []).length}</div>
            </div>
            {(i.insights || []).length === 0 ? (
              <div className="dim" style={{ textAlign: 'center', padding: 16 }}>No insights yet.</div>
            ) : (
              i.insights.map((ins, idx) => {
                const typeColors = { edge: 'green', caution: 'yellow', risk: 'red', math: 'blue', direction: 'cyan', exits: 'accent' };
                return (
                  <div key={idx} style={{
                    padding: '10px 14px', marginBottom: 6, borderRadius: 'var(--radius)',
                    background: 'var(--bg-3)',
                    fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6,
                    color: 'var(--text-1)',
                  }}>
                    <span style={{ fontWeight: 700, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginRight: 6, color: `var(--${typeColors[ins.type] || 'text-2'})` }}>{ins.type}</span>
                    {ins.msg}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Recent Sessions */}
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header"><div className="card-title">Last 5 Sessions</div></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>ORB</th><th>Trade</th><th>Result</th><th>Ticks</th></tr></thead>
              <tbody>
                {last5.map((s, idx) => (
                  <tr key={idx}>
                    <td>{s.date}</td>
                    <td>{s.orb?.range_ticks}t <span className="dim">({s.regime?.regime_orb_size})</span></td>
                    <td className={s.trade ? dir(s.trade.direction) : 'muted'}>{s.trade ? s.trade.direction.toUpperCase() : 'NO TRADE'}</td>
                    <td><span className={s.trade?.result === 'win' ? 'green' : s.trade ? 'red' : 'muted'} style={{ fontWeight: 600 }}>{s.trade?.result?.toUpperCase() || '—'}</span></td>
                    <td className={pnl(s.trade?.pnl_ticks || 0)}>{s.trade?.pnl_ticks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

          </div>
        </details>
      </div>
    </>
  );
}

function CoachOps({ strategy }) {
  const { data: report, loading: reportLoading, reload: reloadReport } = useApi(`/api/coach/report?strategy=${strategy}`, [strategy]);
  const { data: proposalsData, loading: proposalsLoading, reload: reloadProposals } = useApi('/api/coach/proposals', []);
  const [busy, setBusy] = useState(false);

  const proposals = proposalsData?.proposals || [];

  const runGenerate = async () => {
    setBusy(true);
    try {
      await fetch('/api/coach/proposals/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      reloadProposals();
      reloadReport();
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (id, action) => {
    setBusy(true);
    try {
      await fetch(`/api/coach/proposals/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'owner' }),
      });
      reloadProposals();
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = async (id) => {
    setBusy(true);
    try {
      const resp = await fetch(`/api/coach/proposals/${id}/apply`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) alert(data.error || 'Apply failed');
      reloadProposals();
    } finally {
      setBusy(false);
    }
  };

  const startValidation = async (id) => {
    setBusy(true);
    try {
      await fetch(`/api/coach/proposals/${id}/start-validation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTrades: 20 }),
      });
      reloadProposals();
    } finally {
      setBusy(false);
    }
  };

  const checkValidation = async (id) => {
    setBusy(true);
    try {
      await fetch(`/api/coach/proposals/${id}/check-validation`, { method: 'POST' });
      reloadProposals();
    } finally {
      setBusy(false);
    }
  };

  if (reportLoading || proposalsLoading) {
    return <><Topbar title="COACH OPS" /><div className="content"><Loading /></div></>;
  }

  const pending = proposals.filter(p => p.status === 'pending_approval');

  return (
    <>
      <Topbar title="COACH OPS" />
      <div className="content">
        <div className="glow-line" />

        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <Metric label="Coach Verdict" value={report?.verdict || '—'} tone={(report?.edgeScore || 0) >= 50 ? 'positive' : 'negative'} />
          <Metric label="Edge Score" value={`${report?.edgeScore || 0}/100`} tone={(report?.edgeScore || 0) >= 50 ? 'positive' : 'negative'} />
          <Metric label="Opportunities" value={(report?.opportunities || []).length} tone="neutral" />
          <Metric label="Pending Approval" value={pending.length} tone={pending.length > 0 ? 'negative' : 'positive'} />
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Guardrail</div>
            <div className="card-badge bg-yellow">MANUAL APPROVAL REQUIRED</div>
          </div>
          <div className="dim" style={{ fontSize: 12, lineHeight: 1.8 }}>
            Coach can discover strategy opportunities but cannot apply changes until you approve each proposal.
          </div>
          <button
            onClick={runGenerate}
            disabled={busy}
            style={{
              marginTop: 12, padding: '8px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border-1)', background: 'var(--bg-3)',
              color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
            }}
          >
            {busy ? 'WORKING...' : 'GENERATE NEW PROPOSALS'}
          </button>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="card-header"><div className="card-title">Strategy Proposals</div></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th><th>Title</th><th>Category</th><th>Impact</th><th>Status</th><th>Validation</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{p.title}</td>
                    <td>{p.category}</td>
                    <td className={p.expected_impact >= 0 ? 'green' : 'red'}>${Number(p.expected_impact || 0).toFixed(0)}</td>
                    <td>
                      <span className={p.status === 'approved' ? 'green' : p.status === 'rejected' ? 'red' : p.status === 'applied' ? 'cyan' : 'yellow'}>
                        {p.status}
                      </span>
                    </td>
                    <td>
                      <span className={p.validation_status === 'live_eligible' ? 'green' : p.validation_status === 'failed' ? 'red' : p.validation_status === 'running' ? 'yellow' : 'dim'}>
                        {p.validation_status || 'not_started'}
                      </span>
                      {p.validation_status && (
                        <div className="dim" style={{ fontSize: 9 }}>
                          {(p.sample_size || 0)}/{p.target_trades || 0}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {p.status === 'pending_approval' && (
                          <>
                            <button onClick={() => updateStatus(p.id, 'approve')} disabled={busy} style={{ fontSize: 10 }}>Approve</button>
                            <button onClick={() => updateStatus(p.id, 'reject')} disabled={busy} style={{ fontSize: 10 }}>Reject</button>
                          </>
                        )}
                        {p.status === 'approved' && (
                          <>
                            {!p.validation_status || p.validation_status === 'pending' ? (
                              <button onClick={() => startValidation(p.id)} disabled={busy} style={{ fontSize: 10 }}>Start Test</button>
                            ) : (
                              <button onClick={() => checkValidation(p.id)} disabled={busy} style={{ fontSize: 10 }}>Check Test</button>
                            )}
                            {p.validation_status === 'live_eligible' && (
                              <button onClick={() => applyProposal(p.id)} disabled={busy} style={{ fontSize: 10 }}>Apply</button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {proposals.length === 0 && (
                  <tr><td colSpan={7} className="dim">No proposals yet. Generate from Coach.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// STRATEGY PORTFOLIO
// ═══════════════════════════════════════════
function StrategyPortfolio({ strategy, setActive }) {
  const url = strategy === 'alt' ? '/api/strategy/portfolio?strategy=alt' : '/api/strategy/portfolio?strategy=original';
  const { data, loading, reload } = useApi(url, [strategy]);
  const [familyFilter, setFamilyFilter] = useState('all');
  const [eligibilityFilter, setEligibilityFilter] = useState('all');
  const [sortBy, setSortBy] = useState('confidence');
  const [selectedKey, setSelectedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const portfolio = data?.portfolio || null;
  const rows = portfolio?.rows || [];
  const summary = portfolio?.summary || { total: 0, active: 0, todayEligible: 0, blocked: 0 };
  const badgeClass = (stage) => (
    stage === 'active' ? 'green'
      : stage === 'paper_passed' ? 'cyan'
        : stage === 'paper_testing' ? 'yellow'
          : stage === 'rejected' ? 'red'
            : 'dim'
  );
  const filteredRows = rows.filter((r) => {
    if (familyFilter !== 'all' && r.family !== familyFilter) return false;
    if (eligibilityFilter === 'eligible' && !r.todayEligible) return false;
    if (eligibilityFilter === 'blocked' && r.todayEligible) return false;
    return true;
  });
  const sortedRows = [...filteredRows].sort((a, b) => {
    if (sortBy === 'stage') return String(a.stage || '').localeCompare(String(b.stage || ''));
    if (sortBy === 'eligible') {
      if (!!a.todayEligible !== !!b.todayEligible) return a.todayEligible ? -1 : 1;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    }
    return Number(b.confidence || 0) - Number(a.confidence || 0);
  });
  const selected = sortedRows.find((r) => r.key === selectedKey) || sortedRows[0] || null;
  const selectedKeys = sortedRows.map((r) => r.key).join('|');

  useEffect(() => {
    if (!sortedRows.length) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    if (!sortedRows.some((r) => r.key === selectedKey)) setSelectedKey(sortedRows[0].key);
  }, [selectedKeys, selectedKey]);

  if (loading) return <><Topbar title="STRATEGY PORTFOLIO" /><div className="content"><Loading /></div></>;

  const postAction = async (path, body = {}) => {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.error || 'Action failed.');
    return json;
  };

  const runAction = async (actionId, row) => {
    if (!row?.entityId || busy) return;
    setBusy(true);
    setNotice('');
    try {
      if (actionId === 'discovery_start') {
        await postAction(`/api/discovery/candidates/${row.entityId}/start-validation`, { targetTrades: 20 });
      } else if (actionId === 'discovery_check') {
        await postAction(`/api/discovery/candidates/${row.entityId}/check-validation`, {});
      } else if (actionId === 'discovery_promote') {
        await postAction(`/api/discovery/candidates/${row.entityId}/promote`, { reviewedBy: 'owner' });
      } else if (actionId === 'proposal_approve') {
        await postAction(`/api/coach/proposals/${row.entityId}/approve`, { reviewedBy: 'owner' });
      } else if (actionId === 'proposal_reject') {
        await postAction(`/api/coach/proposals/${row.entityId}/reject`, { reviewedBy: 'owner' });
      } else if (actionId === 'proposal_start') {
        await postAction(`/api/coach/proposals/${row.entityId}/start-validation`, { targetTrades: 20 });
      } else if (actionId === 'proposal_check') {
        await postAction(`/api/coach/proposals/${row.entityId}/check-validation`, {});
      } else if (actionId === 'proposal_apply') {
        await postAction(`/api/coach/proposals/${row.entityId}/apply`, {});
      }
      setNotice(`Action complete: ${row.name}`);
      reload();
    } catch (err) {
      setNotice(err.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const primaryAction = (() => {
    if (!selected || !selected.entityId) return null;
    if (selected.family === 'discovery') {
      if (selected.stage === 'research_ready' && selected.status === 'live_eligible') return { id: 'discovery_start', label: 'Start Validation' };
      if (selected.stage === 'paper_testing') return { id: 'discovery_check', label: 'Check Validation' };
      if (selected.stage === 'paper_passed') return { id: 'discovery_promote', label: 'Promote Candidate' };
      return null;
    }
    if (selected.family === 'proposal') {
      if (selected.status === 'pending_approval') return { id: 'proposal_approve', label: 'Approve Proposal' };
      if (selected.stage === 'research_ready' && selected.status === 'approved') return { id: 'proposal_start', label: 'Start Validation' };
      if (selected.stage === 'paper_testing') return { id: 'proposal_check', label: 'Check Validation' };
      if (selected.stage === 'paper_passed') return { id: 'proposal_apply', label: 'Apply to Strategy' };
      return null;
    }
    return null;
  })();
  const secondaryAction = selected?.family === 'proposal' && selected?.status === 'pending_approval'
    ? { id: 'proposal_reject', label: 'Reject Proposal' }
    : null;

  return (
    <>
      <Topbar title={strategy === 'alt' ? 'STRATEGY PORTFOLIO — CLOSER TP' : 'STRATEGY PORTFOLIO'} />
      <div className="content">
        <div className="glow-line" />

        <div className="card">
          <div className="card-header">
            <div className="card-title">Portfolio Summary</div>
            <div className="card-badge bg-blue">{rows.length} rows</div>
          </div>
          <div className="grid grid-4" style={{ marginBottom: 10 }}>
            <Metric label="Total" value={summary.total || 0} tone="neutral" />
            <Metric label="Active" value={summary.active || 0} tone={(summary.active || 0) > 0 ? 'positive' : 'neutral'} />
            <Metric label="Today Eligible" value={summary.todayEligible || 0} tone={(summary.todayEligible || 0) > 0 ? 'positive' : 'neutral'} />
            <Metric label="Blocked" value={summary.blocked || 0} tone={(summary.blocked || 0) > 0 ? 'negative' : 'positive'} />
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 10 }}>
            Generated {portfolio?.generatedAt ? new Date(portfolio.generatedAt).toLocaleString() : '—'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8 }}>
            <select
              value={familyFilter}
              onChange={(e) => setFamilyFilter(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              <option value="all">All families</option>
              <option value="core">Core</option>
              <option value="discovery">Discovery</option>
              <option value="proposal">Proposal</option>
            </select>
            <select
              value={eligibilityFilter}
              onChange={(e) => setEligibilityFilter(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              <option value="all">All eligibility</option>
              <option value="eligible">Eligible only</option>
              <option value="blocked">Blocked only</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--bg-3)', color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              <option value="confidence">Sort: confidence</option>
              <option value="eligible">Sort: eligible first</option>
              <option value="stage">Sort: stage</option>
            </select>
            <button
              onClick={reload}
              style={{
                padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              REFRESH
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 16px 0' }}>
              <div className="card-header">
                <div className="card-title">Strategy Stack</div>
                <div className="card-badge bg-blue">{sortedRows.length} visible</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Family</th>
                    <th>Stage</th>
                    <th>Confidence</th>
                    <th>Frequency</th>
                    <th>Today</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
                    <tr
                      key={r.key}
                      onClick={() => setSelectedKey(r.key)}
                      style={{ cursor: 'pointer', background: selected?.key === r.key ? 'var(--bg-3)' : 'transparent' }}
                    >
                      <td>
                        <div>{r.name}</div>
                        <div className="dim" style={{ fontSize: 9 }}>{r.eligibilityReason || '—'}</div>
                      </td>
                      <td>{r.family || '—'}</td>
                      <td><span className={badgeClass(r.stage)}>{r.stage || '—'}</span></td>
                      <td>{r.confidence != null ? `${Number(r.confidence).toFixed(0)}%` : '—'}</td>
                      <td>{r.frequency || '—'}</td>
                      <td><span className={r.todayEligible ? 'green' : 'red'}>{r.todayEligible ? 'YES' : 'NO'}</span></td>
                      <td className="dim">
                        {r.testWR != null && r.testPF != null
                          ? `WR ${r.testWR}% · PF ${r.testPF}`
                          : r.expectedValueDollars != null
                            ? `EV $${Number(r.expectedValueDollars).toFixed(0)}`
                            : 'insufficient evidence'}
                        {r.validationTarget ? ` · ${r.validationSample || 0}/${r.validationTarget}` : ''}
                      </td>
                    </tr>
                  ))}
                  {sortedRows.length === 0 && (
                    <tr><td colSpan={7} className="dim">No rows match current filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Selected Strategy</div>
              <div className={`card-badge ${selected?.todayEligible ? 'bg-green' : 'bg-yellow'}`}>
                {selected?.todayEligible ? 'ELIGIBLE' : 'BLOCKED'}
              </div>
            </div>
            {!selected ? (
              <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Select a row to see actions and details.</div>
            ) : (
              <>
                <div className="data-row"><span className="label">Name</span><span className="value">{selected.name}</span></div>
                <div className="data-row"><span className="label">Family</span><span className="value">{selected.family}</span></div>
                <div className="data-row"><span className="label">Stage</span><span className={`value ${badgeClass(selected.stage)}`}>{selected.stage || '—'}</span></div>
                <div className="data-row"><span className="label">Status</span><span className="value">{selected.status || selected.validationStatus || '—'}</span></div>
                <div className="data-row"><span className="label">Confidence</span><span className="value">{selected.confidence != null ? `${Number(selected.confidence).toFixed(0)}%` : '—'}</span></div>
                <div className="data-row"><span className="label">Frequency</span><span className="value">{selected.frequency || '—'}</span></div>
                <div className="data-row"><span className="label">Evidence</span><span className="value">{selected.testWR != null && selected.testPF != null ? `WR ${selected.testWR}% · PF ${selected.testPF}` : selected.expectedValueDollars != null ? `EV $${Number(selected.expectedValueDollars).toFixed(0)}` : 'insufficient evidence'}</span></div>
                <div className="data-row"><span className="label">Validation</span><span className="value">{selected.validationTarget ? `${selected.validationSample || 0}/${selected.validationTarget}` : 'not started'}</span></div>
                <div className="data-row"><span className="label">Reason</span><span className="value">{selected.eligibilityReason || '—'}</span></div>
                <div className="data-row"><span className="label">Blockers</span><span className="value">{(selected.blockers || []).join(', ') || 'none'}</span></div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {primaryAction && (
                    <button
                      onClick={() => runAction(primaryAction.id, selected)}
                      disabled={busy}
                      style={{
                        padding: '8px 12px', borderRadius: 'var(--radius)',
                        border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                        color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                      }}
                    >
                      {busy ? 'WORKING...' : primaryAction.label}
                    </button>
                  )}
                  {secondaryAction && (
                    <button
                      onClick={() => runAction(secondaryAction.id, selected)}
                      disabled={busy}
                      style={{
                        padding: '8px 12px', borderRadius: 'var(--radius)',
                        border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                        color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                      }}
                    >
                      {busy ? 'WORKING...' : secondaryAction.label}
                    </button>
                  )}
                  {selected.family === 'discovery' && typeof setActive === 'function' && (
                    <button
                      onClick={() => setActive('lab')}
                      style={{
                        padding: '8px 12px', borderRadius: 'var(--radius)',
                        border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                        color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                      }}
                    >
                      OPEN LAB
                    </button>
                  )}
                  {selected.family === 'proposal' && typeof setActive === 'function' && (
                    <button
                      onClick={() => setActive('coach')}
                      style={{
                        padding: '8px 12px', borderRadius: 'var(--radius)',
                        border: '1px solid var(--border-1)', background: 'var(--bg-3)',
                        color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
                      }}
                    >
                      OPEN COACH
                    </button>
                  )}
                </div>
                {notice && (
                  <div className={notice.toLowerCase().includes('failed') || notice.toLowerCase().includes('error') ? 'red' : 'green'} style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {notice}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// SYSTEM CORE
// ═══════════════════════════════════════════
function SystemCore({ strategy }) {
  const statusUrl = strategy === 'alt' ? '/api/system/status?strategy=alt' : '/api/system/status?strategy=original';
  const readinessUrl = strategy === 'alt' ? '/api/system/readiness?strategy=alt' : '/api/system/readiness?strategy=original';
  const steadyStateUrl = strategy === 'alt' ? '/api/system/steady-state?strategy=alt' : '/api/system/steady-state?strategy=original';
  const { data, loading, error, reload } = useApi(statusUrl, [strategy]);
  const { data: readinessData, loading: readinessLoading, reload: reloadReadiness } = useApi(readinessUrl, [strategy]);
  const { data: steadyStateData, loading: steadyStateLoading, reload: reloadSteadyState } = useApi(steadyStateUrl, [strategy]);
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState(null);
  const [guardTriggering, setGuardTriggering] = useState(false);
  const [guardTriggerResult, setGuardTriggerResult] = useState(null);

  const runRecovery = async () => {
    setRecovering(true);
    setRecoverResult(null);
    try {
      const res = await fetch('/api/system/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      const json = await res.json();
      if (!res.ok) {
        setRecoverResult({ status: 'error', error: json.error || 'recovery_failed' });
      } else {
        setRecoverResult(json);
      }
    } catch (err) {
      setRecoverResult({ status: 'error', error: err.message || 'recovery_failed' });
    } finally {
      setRecovering(false);
      reload();
      reloadReadiness();
      reloadSteadyState();
    }
  };

  const triggerGuard = async () => {
    setGuardTriggering(true);
    setGuardTriggerResult(null);
    try {
      const res = await fetch('/api/system/runtime-guard/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'manual_system_core_trigger',
          note: 'Manual trigger from System Core dashboard',
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGuardTriggerResult({ status: 'error', error: json.error || `HTTP ${res.status}` });
      } else {
        setGuardTriggerResult({ status: 'ok', trigger: json.trigger || null });
      }
    } catch (err) {
      setGuardTriggerResult({ status: 'error', error: err.message || 'trigger_failed' });
    } finally {
      setGuardTriggering(false);
      reload();
      reloadReadiness();
      reloadSteadyState();
    }
  };

  const status = data || {};
  const health = status.health || {};
  const discord = status.discord || {};
  const notifications = status.notifications || {};
  const news = status.news || {};
  const brain = status.brain || {};
  const tradePlan = status.tradePlan || {};
  const locks = status.locks || {};
  const dataFreshness = status.dataFreshness || {};
  const operations = status.operations || {};
  const runtimeGuard = status.runtimeGuard || {};
  const cacheStats = status.cacheStats || {};
  const sessionCache = cacheStats.sessionData || {};
  const readiness = readinessData?.summary || null;
  const steadyState = steadyStateData?.summary || null;

  return (
    <>
      <Topbar title="SYSTEM CORE" />
      <div className="content">
        <div className="glow-line" />

        <div className="card" style={{ borderLeft: '2px solid var(--cyan)' }}>
          <div className="card-header">
            <div className="card-title">System Status</div>
            <div className={`card-badge ${health.status === 'ok' ? 'bg-green' : 'bg-yellow'}`}>{String(health.status || 'initializing').toUpperCase()}</div>
          </div>
          {loading && <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Loading system telemetry...</div>}
          {error && <div className="red" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Status error: {error}</div>}
          {!loading && !error && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 10 }}>
                <Metric label="API" value={health?.api?.ok ? 'ONLINE' : 'DOWN'} tone={health?.api?.ok ? 'positive' : 'negative'} />
                <Metric label="Database" value={health?.database?.ok ? 'READY' : 'ERROR'} sub={`${health?.database?.sessions || 0} sessions`} tone={health?.database?.ok ? 'positive' : 'negative'} />
                <Metric label="AI Brain" value={brain?.configured ? 'CONFIGURED' : 'MISSING KEY'} sub={String(brain?.provider || 'none').toUpperCase()} tone={brain?.configured ? 'positive' : 'negative'} />
                <Metric label="Uptime" value={`${health?.uptimeSeconds || 0}s`} sub={status.generatedAt || '—'} tone="neutral" />
              </div>

              <div className="data-row"><span className="label">Discord Runtime</span><span className="value">{discord?.runtime?.ready ? 'CONNECTED' : (discord?.enabled ? 'STARTING/DEGRADED' : 'DISABLED')}</span></div>
              <div className="data-row"><span className="label">Discord Guardrails</span><span className="value">users {discord?.allowedUsersCount || 0} · channels {discord?.allowedChannelsCount || 0} · plain english {discord?.plainEnglishMode ? 'on' : 'off'}</span></div>
              <div className="data-row"><span className="label">Assistant Alerts</span><span className="value">{notifications?.active ? 'ON' : 'OFF'} · webhook {notifications?.webhookConfigured ? 'configured' : 'missing'}</span></div>
              <div className="data-row"><span className="label">News Feed</span><span className="value">{news?.eventCount ?? 0} today · next {news?.nextEvent ? `${news.nextEvent.time || 'TBD'} ${news.nextEvent.country} ${news.nextEvent.title}` : 'none'}</span></div>
              <div className="data-row"><span className="label">Trade Plan Pulse</span><span className="value">{tradePlan?.action || 'NO DATA'} · confidence {tradePlan?.decision?.confidence ?? 0}% · blockers {(tradePlan?.decision?.blockers || []).length}</span></div>
              <div className="data-row"><span className="label">Readiness</span><span className={`value ${readiness?.readiness === 'READY' ? 'green' : readiness?.readiness === 'NOT_READY' ? 'red' : 'yellow'}`}>{readinessLoading ? 'loading...' : (readiness?.line || 'no readiness summary')}</span></div>
              <div className="data-row"><span className="label">Steady State</span><span className={`value ${steadyState?.status === 'READY' ? 'green' : steadyState?.status === 'ACTION_REQUIRED' ? 'red' : 'yellow'}`}>{steadyStateLoading ? 'loading...' : (steadyState?.line || 'no steady-state summary')}</span></div>
              <div className="data-row"><span className="label">Data Freshness</span><span className={`value ${dataFreshness?.isStale ? 'yellow' : 'green'}`}>{dataFreshness?.lastSessionDate ? `last ${dataFreshness.lastSessionDate} · stale ${dataFreshness.staleDays ?? '?'}d (limit ${dataFreshness.staleThresholdDays ?? '?'})` : 'no session data loaded'}</span></div>
              <div className="data-row"><span className="label">Auto Data Sync</span><span className="value">{operations?.dataSync ? `${String(operations.dataSync.status || 'unavailable').toUpperCase()} · +${operations.dataSync.sessionsAdded || 0} sessions @ ${operations.dataSync.createdAt || 'no timestamp'}` : 'no runs yet'}</span></div>
              <div className="data-row"><span className="label">Model Eval</span><span className={`value ${operations?.modelEval?.status === 'passed' ? 'green' : operations?.modelEval ? 'yellow' : ''}`}>{operations?.modelEval ? `${String(operations.modelEval.status || 'unavailable').toUpperCase()} · interpreter ${operations.modelEval.interpreterPassed ? 'ok' : 'fail'} · decision ${operations.modelEval.decisionPassed ? 'ok' : 'fail'}` : 'no runs yet'}</span></div>
              <div className="data-row"><span className="label">Stale Locks</span><span className="value">{locks?.stalePendingOrderIntents || 0} stale / {locks?.pendingOrderIntents || 0} pending order intents</span></div>
              <div className="data-row"><span className="label">Runtime Guard</span><span className="value">{runtimeGuard?.inFlight ? 'RUNNING' : 'IDLE'} · triggers {runtimeGuard?.totalTriggers || 0} · suppressed {runtimeGuard?.suppressed || 0} · cooldown {Math.round((runtimeGuard?.cooldownRemainingMs || 0) / 1000)}s</span></div>
              <div className="data-row"><span className="label">Session Cache</span><span className="value">{sessionCache?.warm ? 'WARM' : 'COLD'} · {sessionCache?.sessionCount || 0} sessions · {(sessionCache?.candleCount || 0).toLocaleString()} candles · age {sessionCache?.ageMs != null ? `${Math.round(sessionCache.ageMs / 1000)}s` : 'not available'}</span></div>
              <div className="data-row"><span className="label">Snapshot Cache</span><span className="value">coach {cacheStats?.coachSnapshotEntries || 0} · command {cacheStats?.commandSnapshotEntries || 0} · plan {cacheStats?.dailyPlanEntries || 0} · panel {cacheStats?.panelEntries || 0}</span></div>
              {runtimeGuard?.lastReason && (
                <div className="data-row"><span className="label">Last Guard Trigger</span><span className="value">{runtimeGuard.lastReason} @ {runtimeGuard.lastTriggerAt || 'time unavailable'}</span></div>
              )}
              {runtimeGuard?.lastError && (
                <div className="data-row"><span className="label">Guard Error</span><span className="value red">{runtimeGuard.lastError}</span></div>
              )}
            </>
          )}
        </div>

        <div className="card" style={{ borderLeft: '2px solid var(--accent)' }}>
          <div className="card-header">
            <div className="card-title">Recovery Console</div>
            <div className={`card-badge ${recoverResult?.status === 'ok' ? 'bg-green' : recoverResult?.status === 'degraded' ? 'bg-yellow' : recoverResult?.status === 'error' ? 'bg-red' : 'bg-blue'}`}>
              {recoverResult ? String(recoverResult.status || 'done').toUpperCase() : 'READY'}
            </div>
          </div>
          <div className="dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 10 }}>
            Runs self-heal actions: cache reset, stale intent cleanup, preflight checks, snapshot/news warm-up, Discord reconnect.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              onClick={runRecovery}
              disabled={recovering}
              style={{
                padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border-1)',
                background: 'var(--bg-3)', color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              {recovering ? 'RECOVERING...' : 'RUN ONE-CLICK RECOVERY'}
            </button>
            <button
              onClick={triggerGuard}
              disabled={guardTriggering}
              style={{
                padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border-1)',
                background: 'var(--bg-3)', color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              {guardTriggering ? 'TRIGGERING...' : 'TRIGGER AUTO-HEAL NOW'}
            </button>
            <button
              onClick={() => { reload(); reloadReadiness(); reloadSteadyState(); }}
              style={{
                padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border-1)',
                background: 'var(--bg-3)', color: 'var(--text-0)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              REFRESH STATUS
            </button>
          </div>

          {recoverResult?.error && (
            <div className="red" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{recoverResult.error}</div>
          )}
          {guardTriggerResult?.error && (
            <div className="red" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Guard trigger failed: {guardTriggerResult.error}</div>
          )}
          {guardTriggerResult?.trigger && (
            <div className="data-row"><span className="label">Guard Trigger</span><span className="value">{guardTriggerResult.trigger.triggered ? `triggered (${guardTriggerResult.trigger.reason})` : `suppressed (${guardTriggerResult.trigger.reason})`}</span></div>
          )}
          {recoverResult?.actions && (
            <>
              <div className="data-row"><span className="label">Backup</span><span className={`value ${recoverResult.actions.backup?.ok ? 'green' : 'red'}`}>{recoverResult.actions.backup?.ok ? `${recoverResult.actions.backup.method} → ${recoverResult.actions.backup.path || 'saved'}` : (recoverResult.actions.backup?.error || 'failed')}</span></div>
              <div className="data-row"><span className="label">Cache Reset</span><span className="value">{recoverResult.actions.cacheReset ? 'done' : 'not run'}</span></div>
              <div className="data-row"><span className="label">Expired Intents</span><span className="value">{recoverResult.actions.expiredIntents || 0} + aged {recoverResult.actions.expiredAgedIntents || 0}</span></div>
              <div className="data-row"><span className="label">Preflight</span><span className={`value ${recoverResult.actions.preflightOk ? 'green' : 'red'}`}>{recoverResult.actions.preflightOk ? 'ok' : 'failed'}</span></div>
              <div className="data-row"><span className="label">Discord Reconnect</span><span className="value">{recoverResult.actions.discordRecovery?.attempted ? (recoverResult.actions.discordRecovery?.ok ? 'ok' : `failed (${recoverResult.actions.discordRecovery?.error || 'error unavailable'})`) : 'not needed'}</span></div>
              {(recoverResult.warnings || []).length > 0 && (
                <div className="yellow" style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  Warnings: {(recoverResult.warnings || []).join(' | ')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// IMPORT
// ═══════════════════════════════════════════
function ImportData() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef();
  const { data: status, reload } = useApi('/api/status');

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/import', { method: 'POST', body: fd });
      const data = await res.json();
      setResult(data);
      reload();
    } catch (err) {
      setResult({ error: err.message });
    }
    setImporting(false);
  };

  return (
    <>
      <Topbar title="IMPORT DATA" />
      <div className="content">
        <div className="glow-line" />

        <div className="card">
          <div className="card-header"><div className="card-title">Database</div></div>
          {status?.database && (
            <>
              <div className="data-row"><span className="label">Sessions</span><span className="value accent">{status.database.sessions}</span></div>
              <div className="data-row"><span className="label">Candles</span><span className="value">{status.database.candles}</span></div>
              <div className="data-row"><span className="label">Trades</span><span className="value">{status.database.trades}</span></div>
              <div className="data-row"><span className="label">Range</span><span className="value">{status.database.dateRange?.first} → {status.database.dateRange?.last}</span></div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Import TradingView CSV</div></div>
          <input type="file" accept=".csv" ref={fileRef} onChange={handleImport} style={{ display: 'none' }} />
          <div className="import-zone" onClick={() => fileRef.current?.click()}>
            {importing ? (
              <div className="accent" style={{ fontFamily: 'var(--font-mono)' }}>Processing...</div>
            ) : (
              <>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>⬡</div>
                <div style={{ fontWeight: 500 }}>Drop TradingView 5-min CSV here</div>
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>MNQ 5-minute chart export</div>
              </>
            )}
          </div>
        </div>

        {result && (
          <div className="card">
            <div className="card-header"><div className="card-title">Result</div></div>
            {result.error ? (
              <div className="red">{result.error}</div>
            ) : (
              <>
                <div className="data-row"><span className="label">Sessions added</span><span className="value green">{result.sessionsAdded}</span></div>
                <div className="data-row"><span className="label">Candles added</span><span className="value">{result.candlesAdded}</span></div>
                <div className="data-row"><span className="label">Backtest</span><span className="value">{result.backtest?.totalTrades} trades, {result.backtest?.winRate}% WR, PF {result.backtest?.profitFactor}</span></div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
      <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>Loading...</span>
    </div>
  );
}

function NoData() {
  return (
    <>
      <Topbar title="THE BRIDGE" />
      <div className="content">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <div style={{ fontSize: 48, opacity: 0.2, marginBottom: 16 }}>⬡</div>
          <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>No Data Loaded</div>
          <div className="dim">Import TradingView 5-min CSV from the Import Data module</div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// STRATEGY TOGGLE
// ═══════════════════════════════════════════
function StrategyToggle({ strategy, onToggle }) {
  return (
    <div className="strategy-toggle">
      <button
        type="button"
        onClick={() => onToggle('original')}
        className={`strategy-option ${strategy === 'original' ? 'active original' : ''}`}
      >
        ORIGINAL
      </button>
      <button
        type="button"
        onClick={() => onToggle('alt')}
        className={`strategy-option ${strategy === 'alt' ? 'active alt' : ''}`}
      >
        CLOSER TP ✦
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════
// APP
// ═══════════════════════════════════════════
export default function App() {
  const [booted, setBooted] = useState(false);
  const [active, setActive] = useState('bridge');
  const [strategy, setStrategy] = useState('original');
  const [lastModuleCrash, setLastModuleCrash] = useState(null);
  const { data: status } = useApi('/api/status');
  const { data: health } = useApi('/api/health', [active, strategy]);
  const {
    health: marketHealth,
    loading: marketHealthLoading,
    error: marketHealthError,
    lastSuccessAt: marketHealthLastSuccessAt,
    reload: reloadMarketHealth,
  } = useMarketHealthHud();

  if (!booted) return <BootSequence onComplete={() => setBooted(true)} />;

  const moduleMap = {
    system: SystemCore,
    analyst: Analyst, bridge: Bridge, adversary: Adversary, journal: Journal,
    sessions: Sessions, breakdown: Breakdowns, conflicts: Conflicts,
    coach: CoachOps,
    lab: Lab, portfolio: StrategyPortfolio, briefing: Briefing, import: ImportData,
  };
  const Module = moduleMap[active] || Analyst;
  const activeModule = MODULES.find((m) => m.id === active);

  // Modules that support strategy toggle
  const supportsStrategy = ['bridge', 'adversary', 'journal', 'breakdown', 'sessions', 'briefing', 'portfolio', 'system'].includes(active);

  return (
    <div className="app">
      <div className="noise-overlay" />
      <div className="scanline" />
      <Sidebar active={active} onSelect={setActive} sessionCount={status?.database?.sessions} />
      <div className={`main module-${active}`}>
        {/* Strategy Toggle Bar — only on supported modules */}
        {supportsStrategy && (
          <div className={`strategy-shell ${strategy === 'alt' ? 'is-alt' : 'is-original'}`}>
            <div className="strategy-shell-label">STRATEGY VIEW</div>
            <StrategyToggle strategy={strategy} onToggle={setStrategy} />
            <div className="strategy-shell-note">
              {strategy === 'alt' ? 'Showing closer TP variant' : 'Showing baseline ORB model'}
            </div>
          </div>
        )}
        <HealthStrip health={health} />
        <MarketHealthWidget
          health={marketHealth}
          loading={marketHealthLoading}
          error={marketHealthError}
          lastSuccessAt={marketHealthLastSuccessAt}
          onRefresh={reloadMarketHealth}
        />
        <ModuleBanner
          activeModule={activeModule}
          strategy={strategy}
          health={health}
          sessionCount={status?.database?.sessions}
          onSelect={setActive}
        />
        {active !== 'briefing' && (
          <DailyTradePlanCard strategy={strategy} onOpenCommandIntel={() => setActive('briefing')} />
        )}
        {lastModuleCrash && (
          <div className="crash-banner">
            Last recovered module crash: {lastModuleCrash.module} ({lastModuleCrash.at})
          </div>
        )}
        <div className="module-frame">
          <ModuleErrorBoundary
            moduleId={active}
            resetKey={`${active}:${strategy}`}
            onError={(error) => setLastModuleCrash({
              module: active,
              message: String(error?.message || 'error unavailable'),
              at: new Date().toLocaleTimeString(),
            })}
            onGoSafe={() => setActive('bridge')}
          >
            <Module strategy={strategy} setActive={setActive} />
          </ModuleErrorBoundary>
        </div>
        <VoiceCopilot
          activeModule={active}
          strategy={strategy}
          onSelectModule={setActive}
          marketHealth={marketHealth}
          marketHealthError={marketHealthError}
          marketHealthLastSuccessAt={marketHealthLastSuccessAt}
        />
      </div>
    </div>
  );
}
