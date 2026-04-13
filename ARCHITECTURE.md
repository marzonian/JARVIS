# McNAIR MINDSET by 3130
## System Architecture Document v1.0

---

## 1. STRATEGY SPECIFICATION — ORB 3130

### Core Rules (codified from trader input)

**Opening Range Breakout (ORB):**
- ORB is defined by the 15-minute candle from 9:30–9:45 AM EST
- ORB_HIGH = high of that candle
- ORB_LOW = low of that candle

**Breakout Detection (5-min chart, after 9:45 AM):**
- LONG breakout: a 5-min candle CLOSES above ORB_HIGH
- SHORT breakout: a 5-min candle CLOSES below ORB_LOW
- The first qualifying candle becomes the "breakout candle"

**Retest Detection (any 5-min candle after breakout candle):**
- LONG retest: candle's LOW touches or penetrates ORB_HIGH (price returns to level)
- SHORT retest: candle's HIGH touches or penetrates ORB_LOW
- The retest candle does NOT need to close — just a wick touch qualifies

**Invalidation Rule:**
- If ANY candle during the retest phase CLOSES on the opposite side of the ORB:
  - LONG setup invalidated if candle closes below ORB_LOW
  - SHORT setup invalidated if candle closes above ORB_HIGH
- An invalidated setup becomes a NEW setup in the opposite direction
- The new setup must complete its own full sequence: breakout → retest → confirmation
- Note: closing between ORB_HIGH and ORB_LOW (inside ORB) is NOT invalidation
  - Only closing THROUGH the opposite boundary invalidates

**Confirmation & Entry (candle after retest):**
- LONG: a 5-min candle closes above the breakout candle's HIGH
- SHORT: a 5-min candle closes below the breakout candle's LOW
- Entry price = CLOSE of the confirmation candle
- This is the entry signal — trade is taken at candle close

**Take Profit (TP):**
- MNQ psych levels occur every 25 points: ..., 22175, 22200, 22225, 22250, ...
- LONG: find the nearest psych level ABOVE entry price
  - If distance < 110 ticks (27.5 points), skip to next psych level up
  - TP = first psych level that is ≥ 110 ticks from entry
- SHORT: find the nearest psych level BELOW entry price
  - Same 110-tick minimum rule
  - TP = first psych level that is ≥ 110 ticks from entry

**Stop Loss (SL):**
- SL distance = TP distance (strict 1:1 risk-to-reward)
- LONG: SL = entry_price - (TP - entry_price)
- SHORT: SL = entry_price + (entry_price - TP)

**Trade Resolution:**
- Scan subsequent 5-min candles after entry
- WIN: price reaches TP (LONG: candle HIGH ≥ TP; SHORT: candle LOW ≤ TP)
- LOSS: price reaches SL (LONG: candle LOW ≤ SL; SHORT: candle HIGH ≥ SL)
- If both TP and SL are hit in the same candle → conservative assumption = LOSS
- Topstep rule: all positions must close by 4:00 PM EST
  - If neither TP nor SL hit by 3:55 PM → close at 3:55 close price
  - Result = difference between entry and exit (can be win or loss)

**Trade Limits:**
- Primary: 1 ORB setup per day
- Exception: if first setup invalidates and flips → the flip counts as the day's trade
- Extension: open to 2nd trade if data/conditions strongly support it (future feature)

### Psych Level Formula
```
psych_level(price) = round(price / 25) * 25
next_psych_above(price) = ceil(price / 25) * 25
next_psych_below(price) = floor(price / 25) * 25
```

### Tick/Point Conversion (MNQ)
- 1 point = 4 ticks
- 1 tick = $0.50 (MNQ contract)
- 25 points = 100 ticks = $50/contract
- 110 ticks = 27.5 points = $55/contract minimum TP

---

## 2. SYSTEM ARCHITECTURE

### Tech Stack
- **Runtime**: Node.js 22 (already installed)
- **Backend**: Express.js + SQLite (better-sqlite3 for sync perf)
- **Frontend**: React (Vite build) served by Express
- **AI Layer**: Claude API (Anthropic) for intelligence modules
- **Scheduler**: node-cron for overnight/morning jobs
- **Data**: TradingView CSV exports → SQLite

### Why Node.js over Python?
- Already installed (v22)
- Single language for full stack
- better-sqlite3 is faster than Python sqlite3 for our use case
- Native JSON handling for API responses
- Vite + React is the fastest path to the UI we prototyped

### Directory Structure
```
mcnair-mindset/
├── package.json
├── setup.sh                      # One-command setup
├── .env                          # API keys (Claude, etc.)
├── server/
│   ├── index.js                  # Express app entry
│   ├── config.js                 # Configuration
│   ├── db/
│   │   ├── schema.sql            # Full database schema
│   │   ├── database.js           # SQLite connection & helpers
│   │   └── seed.js               # Initial data seeding
│   ├── engine/
│   │   ├── orb.js                # ORB 3130 core strategy logic
│   │   ├── backtest.js           # Backtesting framework
│   │   ├── regime.js             # Regime classification
│   │   ├── psych-levels.js       # Psych level calculator
│   │   ├── fingerprint.js        # Session fingerprinting
│   │   ├── mutations.js          # Strategy mutation generator
│   │   ├── stats.js              # Statistical calculations
│   │   ├── adversary.js          # Vulnerability scanner
│   │   ├── decay.js              # Edge decay detection
│   │   ├── drift.js              # Behavioral drift detection
│   │   └── counterfactual.js     # What-if analysis
│   ├── routes/
│   │   ├── bridge.js             # Dashboard data
│   │   ├── journal.js            # Trade CRUD
│   │   ├── backtest.js           # Run backtests
│   │   ├── adversary.js          # Stress test results
│   │   ├── fingerprint.js        # Session matching
│   │   ├── lab.js                # Mutation results
│   │   ├── briefing.js           # Morning briefing
│   │   ├── data.js               # Data import/export
│   │   └── ai.js                 # Claude API proxy
│   ├── jobs/
│   │   ├── scheduler.js          # Cron job manager
│   │   ├── overnight.js          # Overnight analysis
│   │   └── morning-briefing.js   # 6 AM briefing generator
│   └── data/
│       └── imports/              # TradingView CSV drop folder
├── client/
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx               # Main app (McNair Mindset)
│       ├── main.jsx              # Entry point
│       ├── styles/
│       │   └── globals.css       # Theme, fonts, animations
│       ├── components/
│       │   ├── Sidebar.jsx
│       │   ├── StatusBar.jsx
│       │   ├── GlowBar.jsx
│       │   ├── StatCard.jsx
│       │   ├── ModuleChat.jsx
│       │   └── TradeRow.jsx
│       ├── modules/
│       │   ├── Bridge.jsx
│       │   ├── Adversary.jsx
│       │   ├── Fingerprint.jsx
│       │   ├── DriftWatch.jsx
│       │   ├── Lab.jsx
│       │   ├── Counterfactual.jsx
│       │   ├── EdgeDecay.jsx
│       │   ├── Briefing.jsx
│       │   ├── Journal.jsx
│       │   └── Extensions.jsx
│       └── hooks/
│           ├── useApi.js
│           └── useWebSocket.js
└── data/
    ├── mcnair.db                 # SQLite database
    └── exports/                  # TradingView CSVs
```

---

## 3. DATABASE SCHEMA

### Tables

**sessions** — Every MNQ trading session
```sql
CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  date          TEXT NOT NULL UNIQUE,     -- YYYY-MM-DD
  orb_high      REAL,                     -- ORB high price
  orb_low       REAL,                     -- ORB low price
  orb_range     REAL,                     -- orb_high - orb_low in ticks
  open_price    REAL,                     -- 9:30 open
  close_price   REAL,                     -- 4:00 close
  high_price    REAL,                     -- Session high
  low_price     REAL,                     -- Session low
  gap_size      REAL,                     -- Open vs prev close (ticks)
  gap_direction TEXT,                     -- 'up', 'down', 'flat'
  overnight_high REAL,
  overnight_low  REAL,
  overnight_range REAL,                   -- In ticks
  volume_total  INTEGER,
  -- Regime classification (computed)
  regime_trend    TEXT,                   -- 'trending', 'ranging', 'choppy'
  regime_vol      TEXT,                   -- 'low', 'normal', 'high', 'extreme'
  regime_gap      TEXT,                   -- 'gap_up', 'gap_down', 'flat'
  regime_orb_size TEXT,                   -- 'narrow', 'normal', 'wide'
  day_of_week   INTEGER,                  -- 0=Mon, 4=Fri
  has_econ_event TEXT,                    -- JSON array of events
  vix_open      REAL,
  es_correlation REAL,
  fingerprint   TEXT,                     -- JSON: multi-dimensional fingerprint
  created_at    TEXT DEFAULT (datetime('now'))
);
```

**candles** — Raw 5-min candle data
```sql
CREATE TABLE candles (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  timestamp  TEXT NOT NULL,               -- ISO 8601
  timeframe  TEXT NOT NULL,               -- '5m', '15m'
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     INTEGER,
  UNIQUE(session_id, timestamp, timeframe)
);
```

**trades** — Logged trades (manual + backtest)
```sql
CREATE TABLE trades (
  id              INTEGER PRIMARY KEY,
  session_id      INTEGER REFERENCES sessions(id),
  source          TEXT NOT NULL,            -- 'manual', 'backtest', 'mutation'
  mutation_id     INTEGER REFERENCES mutations(id),
  direction       TEXT NOT NULL,            -- 'long', 'short'
  -- ORB data
  orb_high        REAL NOT NULL,
  orb_low         REAL NOT NULL,
  -- Sequence timestamps
  breakout_time   TEXT,
  breakout_candle_high REAL,
  breakout_candle_low  REAL,
  breakout_candle_close REAL,
  retest_time     TEXT,
  confirmation_time TEXT,
  -- Entry/Exit
  entry_price     REAL NOT NULL,
  entry_time      TEXT NOT NULL,
  tp_price        REAL NOT NULL,
  sl_price        REAL NOT NULL,
  tp_distance     REAL,                    -- In ticks
  exit_price      REAL,
  exit_time       TEXT,
  exit_reason     TEXT,                    -- 'tp', 'sl', 'time_close', 'manual'
  -- Result
  result          TEXT,                    -- 'win', 'loss', 'breakeven', 'time_exit'
  pnl_ticks       REAL,
  pnl_dollars     REAL,
  -- Regime at time of trade
  regime_snapshot TEXT,                    -- JSON
  -- Manual trade metadata
  confidence      INTEGER,                -- 1-5 self-rated
  notes           TEXT,
  screenshot_path TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
```

**mutations** — Strategy variations from The Lab
```sql
CREATE TABLE mutations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  -- What changed from base strategy
  mutation_type TEXT NOT NULL,             -- 'filter', 'entry', 'exit', 'sizing'
  parameters    TEXT NOT NULL,             -- JSON: the specific modification
  -- Results
  total_trades  INTEGER,
  wins          INTEGER,
  losses        INTEGER,
  win_rate      REAL,
  profit_factor REAL,
  sharpe_ratio  REAL,
  max_drawdown  REAL,
  avg_win_ticks REAL,
  avg_loss_ticks REAL,
  -- Comparison to base
  base_win_rate    REAL,
  base_pf          REAL,
  improvement_pf   REAL,                  -- percentage change
  -- Status
  status        TEXT DEFAULT 'testing',   -- 'testing', 'validated', 'rejected'
  validated_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

**adversary_findings** — Vulnerability scan results
```sql
CREATE TABLE adversary_findings (
  id            INTEGER PRIMARY KEY,
  regime_desc   TEXT NOT NULL,            -- Human readable
  regime_filter TEXT NOT NULL,            -- JSON: filter conditions
  total_trades  INTEGER,
  wins          INTEGER,
  losses        INTEGER,
  win_rate      REAL,
  profit_factor REAL,
  severity      TEXT,                     -- 'critical', 'high', 'moderate', 'low'
  baseline_wr   REAL,                     -- Baseline win rate for comparison
  baseline_pf   REAL,
  scan_date     TEXT DEFAULT (datetime('now'))
);
```

**briefings** — Generated morning briefings
```sql
CREATE TABLE briefings (
  id              INTEGER PRIMARY KEY,
  date            TEXT NOT NULL UNIQUE,
  confidence      TEXT,                   -- 'high', 'moderate', 'low'
  fingerprint_match REAL,                 -- Percentage
  similar_sessions INTEGER,
  adversary_clear  INTEGER,               -- Boolean
  active_vulnerabilities TEXT,            -- JSON
  key_levels       TEXT,                  -- JSON
  module_reports   TEXT,                  -- JSON
  recommendation   TEXT,                  -- 'trade', 'caution', 'sit_out'
  narrative        TEXT,                  -- AI-generated summary
  created_at       TEXT DEFAULT (datetime('now'))
);
```

**topstep_account** — Account tracking
```sql
CREATE TABLE topstep_account (
  id             INTEGER PRIMARY KEY,
  date           TEXT NOT NULL,
  balance        REAL NOT NULL,
  daily_pnl      REAL,
  trailing_dd    REAL,
  max_dd_buffer  REAL,
  trades_today   INTEGER,
  notes          TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
```

**activity_log** — The "while you were away" feed
```sql
CREATE TABLE activity_log (
  id         INTEGER PRIMARY KEY,
  module     TEXT NOT NULL,
  message    TEXT NOT NULL,
  severity   TEXT DEFAULT 'info',         -- 'info', 'warning', 'critical', 'success'
  data       TEXT,                        -- JSON: any associated data
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## 4. MODULE SPECIFICATIONS

### 4.1 ORB ENGINE (engine/orb.js)
The heart of the system. Pure functions, no side effects, fully testable.

**Inputs**: Array of 5-min candles for a session
**Outputs**: Trade signal object or null

```
processSession(candles_5m, candles_15m) → {
  orb: { high, low, range },
  breakout: { time, candle, direction } | null,
  retest: { time, candle } | null,
  invalidation: { time, candle, new_direction } | null,
  confirmation: { time, candle } | null,
  entry: { price, time, direction },
  tp: { price, distance_ticks, psych_level },
  sl: { price, distance_ticks },
}
```

### 4.2 BACKTESTER (engine/backtest.js)
Runs ORB engine across all historical sessions.

**Features**:
- Walk-forward testing (in-sample / out-of-sample splits)
- Monte Carlo simulation (N=10,000 randomized trade sequences)
- Topstep-specific drawdown simulation
- Commission and slippage modeling ($4.50 round trip MNQ, 1 tick slippage)

**Outputs per backtest run**:
- Win rate, profit factor, Sharpe ratio, Sortino ratio
- Max drawdown (points and dollars)
- Average win/loss in ticks
- Win/loss streaks
- Equity curve data points
- Monthly/weekly P&L breakdown
- Probability of hitting Topstep payout before drawdown limit

### 4.3 REGIME CLASSIFIER (engine/regime.js)
Classifies each session along multiple dimensions.

**Dimensions**:
1. Trend: trending / ranging / choppy (based on ADX-like calc on session)
2. Volatility: low / normal / high / extreme (based on ATR percentile)
3. Gap: gap_up_large / gap_up_small / flat / gap_down_small / gap_down_large
4. ORB size: narrow (<20 ticks) / normal (20-50) / wide (>50)
5. Overnight range: tight / normal / extended
6. Day of week: mon / tue / wed / thu / fri
7. Econ calendar: none / minor / major / FOMC
8. VIX regime: <15 / 15-20 / 20-25 / 25-30 / 30+
9. First 15min post-ORB: continuation / rejection / inside

### 4.4 ADVERSARY (engine/adversary.js)
Scans for regime combinations where strategy underperforms.

**Algorithm**:
1. For each regime dimension, group trades
2. Calculate win rate and PF per group
3. For each pair of dimensions, cross-tabulate
4. Flag any group where:
   - Win rate < baseline - 10%
   - Profit factor < 1.0
   - Sample size ≥ 10 trades (statistical minimum)
5. Rank by severity (deviation from baseline × sample size)

### 4.5 FINGERPRINT ENGINE (engine/fingerprint.js)
Creates multi-dimensional signature for each session.

**Algorithm**:
1. Compute 9 regime dimensions for today's developing session
2. Calculate Euclidean distance to all historical sessions
3. Return top N most similar sessions
4. Compute ORB 3130 win rate on those matching sessions
5. Identify dominant outcome pattern

### 4.6 THE LAB (engine/mutations.js)
Generates and tests strategy variations.

**Mutation Types**:
- **Filters**: Add conditions that must be true to take the trade
  - ORB range filter (min/max)
  - Time-of-day filter (breakout must occur by X time)
  - Volume filter on breakout candle
  - Overnight range filter
  - VIX filter
  - Skip if econ event within N minutes
  - Day of week filter
  - Gap size filter
- **Entry modifications**:
  - Require N candles of consolidation before breakout
  - Require volume > X multiplier on breakout
  - Require retest within N candles
- **Exit modifications**:
  - Use 2nd psych level as TP when conditions X
  - Trail stop after N ticks of profit
  - Time-based exit (close if not hit TP by X time)

**Process**:
1. Generate mutation candidates (parameterized)
2. Backtest each against full dataset
3. Compare to base strategy
4. Require: improvement > 10%, sample size > 50, no overfitting (walk-forward validated)
5. Status: testing → validated / rejected

### 4.7 DRIFT WATCH (engine/drift.js)
Monitors trader behavior against their own rules.

**Tracks**:
- Entry timing vs rule-based signal timing
- Actual TP vs planned TP
- Actual SL vs planned SL
- Hold time distribution
- Trade frequency
- Missed signals (ORB setup existed but no trade logged)

**Alerts when**:
- Any metric deviates > 1 standard deviation from rolling average
- Pattern emerges (e.g., always cutting winners short on Fridays)

### 4.8 COUNTERFACTUAL ENGINE (engine/counterfactual.js)
For each logged trade, computes alternative outcomes.

**Scenarios per trade**:
- What if TP was the next psych level?
- What if TP was the previous psych level?
- What if SL was tighter by 5/10/15 ticks?
- What if you trailed the stop?
- What if you held until session close?
- What if you took partial profit at first psych level?

**Aggregates across all trades to show net impact of each alternative.**

### 4.9 EDGE DECAY MONITOR (engine/decay.js)
Tracks rolling strategy performance metrics.

**Windows**: 10, 20, 30, 50 trade rolling windows
**Metrics**: win rate, profit factor, average R, Sharpe
**Alert**: when current window deviates > 1.5 SD from long-term average

---

## 5. DATA FLOW

### TradingView Export → System
1. User exports 5-min MNQ chart data as CSV from TradingView
2. Drops CSV into `data/exports/` folder
3. System detects new file, parses it
4. Creates session records and candle records
5. Runs ORB engine on each session → generates backtest trades
6. Runs regime classifier on each session
7. Runs fingerprint engine
8. Runs adversary scan
9. Updates all module dashboards

### Daily Flow
- **4:30 AM**: Scheduler pulls overnight data (if available)
- **5:00 AM**: Adversary runs full vulnerability scan
- **5:30 AM**: Fingerprint engine matches developing session
- **6:00 AM**: Morning briefing generated (Claude API)
- **9:30 AM**: ORB period begins — system monitors
- **9:45 AM**: ORB defined — breakout watch begins
- **4:00 PM**: Session ends — log trade result
- **8:00 PM**: Lab runs overnight mutations
- **11:00 PM**: Drift Watch and Decay Monitor update

### Manual Trade Logging
1. User clicks "Log Trade" in Journal
2. Enters: direction, entry price, exit price, result
3. System auto-fills: ORB levels, psych levels, regime data, TP/SL calculations
4. System cross-references with backtest signal:
   - Did the system also signal this trade? (alignment check)
   - Was there a signal the user didn't take? (missed opportunity)

---

## 6. AI INTEGRATION (Claude API)

### Where Claude adds intelligence:
1. **Morning Briefing**: Synthesizes all module data into natural language narrative
2. **Module Chat**: Each module has a chat interface where you can ask questions
3. **Pattern Discovery**: Analyzes fingerprint clusters for non-obvious correlations
4. **Mutation Ideas**: Suggests new mutation candidates based on adversary findings
5. **Trade Review**: Analyzes logged trades and provides coaching feedback
6. **Anomaly Explanation**: When edge decay triggers, explains possible causes

### API Usage Estimate
- Morning briefing: ~2K tokens in, ~1K out = $0.01/day
- Module chats: ~5 interactions/day × 2K tokens = $0.05/day
- Overnight analysis: ~5K tokens = $0.03/day
- **Total**: ~$3-5/month on Claude Sonnet

---

## 7. BUILD ORDER

### Phase 1: Foundation (Build Now)
1. Project setup (package.json, Express, SQLite, Vite)
2. Database schema creation
3. TradingView CSV import pipeline
4. ORB 3130 engine (core strategy logic)
5. Psych level calculator
6. Basic backtester
7. Frontend shell (McNair Mindset UI)

### Phase 2: Intelligence Modules (Week 2)
1. Regime classifier
2. Adversary scanner
3. Fingerprint engine
4. Journal CRUD + auto-fill
5. Connect frontend modules to real data

### Phase 3: Advanced Features (Week 3)
1. The Lab (mutation engine)
2. Counterfactual engine
3. Drift Watch
4. Edge Decay monitor
5. Claude API integration for chat + briefings

### Phase 4: Automation (Week 4)
1. Scheduler (overnight jobs)
2. Morning briefing generation
3. Topstep Guardian (account tracking)
4. Activity feed (while you were away)

### Phase 5: Extensions (Ongoing)
1. Correlation Radar
2. Session Replay
3. Scenario Planner
4. Additional data sources
