# Session Mode

Session-based edge measurement system for time-window analysis.

## Versions

| Version | Session Window (TRT) | Session Window (UTC) | Duration |
|---------|---------------------|---------------------|----------|
| v1.1 | 14:00–20:00 | 11:00–17:00 | 6h |
| **v1.2** | **15:00–19:00** | **12:00–16:00** | **4h** |

v1.2 focuses on peak hours identified by modal analysis (15:30-17:00 TRT).

## Workflow

```bash
# 1. Generate today's config (v1.2 defaults)
npm run session:init

# 2. Generate specific date config
npm run session:init -- --date 2026-03-02

# 3. Run session watch (at 14:30 TRT for v1.2)
npm run session:watch -- --config archive/YYYYMMDD_session_v1_2/session_config.json

# 4. Analyze after session ends (19:00 TRT for v1.2)
npm run session:analyze -- --input archive/YYYYMMDD_session_v1_2

# 5. After 5 days, run 5-day verdict
npm run session:5day
```

## Daily Scoring System

4-component scoring (0-100 total):

| Component | Weight | Metric |
|-----------|--------|--------|
| Intensity | 25 pts | T2 events/hour |
| p95 Strength | 25 pts | Peak basis points |
| Continuity | 25 pts | % of 15-min windows passing |
| Health | 25 pts | Valid rate % |

## Daily Classification

| Score | Class |
|-------|-------|
| 75-100 | STRONG |
| 60-74 | MODERATE |
| 40-59 | WEAK |
| 0-39 | NO_REGIME |

## 5-Day Verdict

After 5 consecutive sessions, run `npm run session:5day` for final verdict.

### PASS Conditions (ALL must be met)

1. **≥3 days** with classification ∈ {STRONG, MODERATE}
2. **≤1 day** with NO_REGIME (score < 40)
3. All PASS days have **passRatio ≥ 40%** (minutesPass / 360)
4. All 5 days have **validRate ≥ 45%**

### FAIL Conditions (ANY triggers)

- STRONG/MODERATE days ≤ 2
- NO_REGIME days ≥ 2  
- Any PASS day has passRatio < 40%
- Any day has validRate < 45%

### INCONCLUSIVE

- STRONG/MODERATE = 2 AND NO_REGIME ≤ 1
- → Window may need recalibration (v1.2)

**Note:** PASS means "14:00–20:00 TRT window produces repeatable regime", NOT "start execution". Stage3/4 is a separate decision.

## Output Files

```
archive/YYYYMMDD_session_v1_1/
├── session_config.json      # Config
├── arb_watch_*.jsonl        # Raw samples
├── rolling_metrics.jsonl    # 15-min rolling metrics
├── monitoring_summary.json  # Watch summary
└── session_summary.json     # Final scoring

data/
└── session_5day_verdict.json  # 5-day verdict result
```

## Rolling Window Thresholds

Rolling 60-min window pass criteria:
- validRate_roll >= 50%
- T2/hour >= 8
- p95 >= 80bps

## passRatio Calculation

```
passRatio = minutesPass / 360
minutesPass = (15-min windows passing all criteria) × 15
```

---

# Session Verdict v2 (Edge Workability)

v2 focuses on **"how many tradeable hours + when"** rather than "6h stable edge".
Edge is clustered/bursty, not continuous.

## Workability Classes

Based on `tradeableHours = rollingWindowsPass * 15 / 60`:

| Class | Threshold |
|-------|-----------|
| TRADEABLE | ≥ 2.0h |
| PARTIAL | 0.5h - 2.0h |
| NONE | < 0.5h |

## v2 Verdict Conditions

### PASS (any ONE sufficient)
- **P1:** tradeableDays ≥ 2
- **P2:** partialOrBetterDays ≥ 3 AND totalTradeableHours ≥ 6.0

### INCONCLUSIVE
- **I1:** partialOrBetterDays = 2 AND totalTradeableHours ∈ [2.0, 6.0)
- **I2:** partialOrBetterDays ≥ 3 BUT totalTradeableHours < 6.0

### FAIL (any ONE)
- **F1:** partialOrBetterDays ≤ 1
- **F2:** totalTradeableHours < 2.0

## v2 Usage

```bash
npm run session:5day:v2
```

## v2 Output

```json
{
  "days": [{
    "date": "2026-02-28",
    "tradeableHours": 2.25,
    "workabilityClass": "TRADEABLE",
    "peakStartUTC": "12:30",
    "peakEndUTC": "14:00",
    "peakBlockMinutes": 75
  }],
  "aggregates": {
    "totalTradeableHours": 3.5,
    "meanTradeableHours": 1.17,
    "tradeableDays": 1,
    "partialOrBetterDays": 2,
    "modalPeakStartUTC": "12:30"
  },
  "verdict": "INCONCLUSIVE",
  "verdictReason": "I1: partialOrBetterDays=2 AND totalTradeableHours=3.5 in [2.0, 6.0)"
}
```

**Note:** v2 does NOT use passRatio ≥40% as a hard gate. passRatio remains for context only.
