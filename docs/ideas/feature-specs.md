# Feature specs: Power Path, Time That Matters, Text Concierge

Chosen 2026-10-24 from [standout-ideas.md](standout-ideas.md). Each feature reuses the engine in [mvp-plan.md](../mvp-plan.md). Rubric links refer to [JUDGING_CRITERIA.md](../../JUDGING_CRITERIA.md).

---

## 1. Your Power Path

**One line:** show the customer the actual chain of equipment that feeds their home, which link is weakest, and (during the storm) where their repair is in line.

### What the customer sees

```
 SUBSTATION ── BREAKER ── RECLOSER R-12 ── FUSE F-881 ── TRANSFORMER ── 🏠 YOU
     ●            ●            ●               ▲ weak link       ●
                                         "Single fuse on 1.8 mi of
                                          overhead line, poles avg 54 yrs"
```

- Each link is a dot colored **Low / Moderate / High** (color plus a text label, never color alone).
- Tapping a link gives one plain-language reason and how many homes share it ("about 340 homes share this fuse"), never who they are.
- **During the storm replay:** a damaged link turns red with the damage type ("broken pole"), then green when the repair is done. A line under the path shows **your place in line**: "2 repairs ahead of yours. 1 of them restores a hospital circuit." Counts only, no locations.

### How it is built

| Piece | Data | Notes |
| --- | --- | --- |
| The chain | `matched_upstream.txt` (premise → transformer → fuses/reclosers → breaker) | Already parsed in MVP plan step 4.3 |
| Risk per link | Poles (age, material, class), primary lines (overhead length), device type, past ARCOS damage near that link | Same features as the risk model, but scored per segment |
| "Homes sharing" | Count of premises downstream of the device | Rounded (e.g. to nearest 10) for privacy |
| Damage + repair order | Storm replay + restoration simulator queue | Queue rules already in MVP plan 5.2 |

**Effort:** about 4 to 5 h (mostly front end; the data is already joined).
**Rubric:** Communication (a clear visual of the concept), Curiosity ("something clever"), Breadth (power engineering + graph analysis + UX).

---

## 2. Time That Matters

**One line:** put the restoration range on one timeline next to the things in the home that run out first, and flag each one where the outage will probably last longer.

### The household checklist

The scenario is a **February winter storm in the Roanoke Valley**, so heat matters as much as food.

**Core items (every home, shown by default):**

| # | Item | How long it lasts without power | Source |
| --- | --- | --- | --- |
| 1 | **Phone battery** | Customer enters current %. Estimate about 1% per 15 min with light use (≈ 24 h from full), shown as an assumption. | Assumption, adjustable |
| 2 | **Refrigerator** (milk, meat, leftovers, medicines kept cold) | **4 hours** with the door closed | USDA / FoodSafety.gov |
| 3 | **Freezer** | **48 hours** if full, **24 hours** if half full | USDA / FoodSafety.gov |
| 4 | **Home heat** (most furnaces, including gas, need electricity to run) | Hours until indoors drops below 40°F: **about 8 h** for a 1950s home, **23 h** for a 1980s home, **45 h** for a 2009-code home. Vulnerable people need about 64°F, which is crossed sooner. | RMI "Hours of Safety" (modeled on a Minnesota cold snap, so conservative for Virginia) |

**Optional items (only if the customer ticks them):**

| # | Item | How long it lasts | Source |
| --- | --- | --- | --- |
| 5 | **Sump pump battery backup** (homes with a basement) | **5 to 6 h** running continuously, up to about **12 h** if cycling | HomeServe |
| 6 | **CPAP** | Customer enters battery size (Wh). Hours ≈ Wh ÷ 30 W without a heated humidifier, or Wh ÷ 60 to 90 W with one. Turning off the humidifier roughly triples runtime. | PowerOutage.us |
| 7 | **Oxygen concentrator or other powered medical device** | Customer enters battery hours from the device label | Declared by customer |
| 8 | **Insulin** | **Up to 28 days** unrefrigerated at 59 to 86°F, so the message is reassurance plus **"don't let it freeze"** in a cold house | FDA |
| 9 | **Well water pump** | **No running water as soon as the power goes out**, so the action is to store water before the storm | Common knowledge, label as general guidance |

The minimum demo uses **items 1 to 4** plus **one declared medical device (item 6 or 7)**.

### How the comparison works

The restoration simulator already runs about 200 Monte Carlo runs. For each item:

```
P(outage lasts longer than item) = share of simulated runs with duration > item's limit
```

| Status | Rule | Shown as |
| --- | --- | --- |
| **OK** | P < 20% | "Your freezer should be fine." |
| **Watch** | 20% to 50% | "Your fridge may get warm. Move milk and medicines to a cooler." |
| **At risk** | P > 50% | "Likely to run out. Act before the storm: …" |

At risk on a **declared medical device** fires the medical escalation rule (E1 in the MVP plan) with the specific reason, for example: *"Your oxygen battery lasts 6 h. There is a 70% chance the outage lasts longer."*

Each item also gets an **"act by" time**: the time the storm is expected to hit, plus the item's limit. That tells the customer when to move food, go somewhere warm, or charge a backup battery.

### What the customer sees

```
 Restoration estimate        ░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░   likely 10–26 h
 0h      4h      8h     12h     16h     20h     24h     28h     48h
 Fridge   ──▲ AT RISK (4 h)
 Heat (1980s home) ─────────────────────────▲ WATCH (23 h)
 Phone (40%) ──────────▲ AT RISK (~10 h)  → charge now
 Freezer (full) ─────────────────────────────────────────────▲ OK (48 h)
 Oxygen battery (6 h) ────▲ AT RISK → escalation on, call option
```

**Inputs the customer can change:** home age (before 1970 / 1970 to 2000 / after 2000), freezer full or half, phone %, any declared devices. Judges can change these and watch the flags move, which meets the brief's "change one input" ask.

**Effort:** about 3 to 4 h (the Monte Carlo already exists; this is a lookup table, one probability per item, and a chart).
**Rubric:** Breadth (public health, building science and human factors are non-computing domains, needed for 4 to 5 pts), Impact (life safety), Innovation (no existing tool links prep advice to predicted duration).

---

## 3. Text concierge ("works when the power is out")

### What I meant

The MVP plan is a **web dashboard**. That works well *before* the storm, when people are at home with Wi-Fi and a charged laptop. But once the power is out:

- **Home Wi-Fi is gone.** The router has no power.
- **The phone is the only device, and its battery is precious.** Loading a map-heavy website uses far more battery than reading a text.
- **Cell networks get congested and weaker.** Many cell sites have **under 8 hours** of backup power (NIST, via Light Reading), and voice and data jam during disasters. Emergency agencies tell people to **text, not call**, because texts get through more often.

So the moment the customer most needs answers (during the outage) is the moment a dashboard works worst. The fix is to let customers use the concierge **by text message**, with very short answers.

### How it works

The customer texts a single keyword to an AEP number. The same engine tools answer, compressed to one SMS (about 160 characters).

| Customer texts | Reply (example) | Engine tool |
| --- | --- | --- |
| `WHEN` | "AEP est.: power back likely 6PM–2AM (range, not confirmed). Next update by 3PM." | `estimate_restoration` |
| `WHY` | "A broken pole on the line feeding your street. 2 repairs are ahead of yours. Reply MORE for details." | Power Path + queue |
| `PREP` | "Fridge food is at risk after 4h. Move meds and milk to a cooler. Never run a generator indoors." | Time That Matters |
| `MED` | "Your device battery may run out before power returns. Reply CALL for a callback, or 911 if urgent." | Alert escalation E1 |
| `OUT` | "Thanks, we've logged that you're still out." | Restoration-complete follow-up |
| anything else | Claude answers in one SMS using only tool outputs, or replies "Sorry, try WHEN, WHY, PREP or MED." | Chat tools + guardrails |

**Design rules:** every reply under 160 characters · always says "estimate" or "confirmed" · safety words in capitals (NEVER, 911) · **send the most important info early** (before the storm and right when the outage starts), because towers may fail later.

### What we build for the demo

- A **phone mock-up** next to the dashboard: a chat-bubble screen where judges type `WHEN` / `WHY` and see the short reply. The four proactive messages also appear here as incoming texts during the storm replay.
- **No real SMS needed.** It runs on the same API. If time allows, a real number via an SMS provider (for example Twilio's trial) is a stretch goal.
- **Optional "low-battery mode":** a text-only version of the web page under 20 KB.

**Effort:** about 3 to 4 h (UI mock-up plus a short-answer mode on the existing tools).
**Rubric:** Innovation (challenges the "dashboard" norm with a reason), Impact (meets a real user need during the outage), Curiosity (the question "what does the customer actually have when the power is out?").

---

## Sources

- USDA fridge/freezer guidance (via WVXU, 2026): https://www.wvxu.org/local-news/2026-08-12/how-long-food-last-refrigerator-power-outage
- Ready.gov power outage tips: https://www.cpp.edu/em/documents/power-outage-safety-tips-readygov-pdf.pdf
- RMI "Hours of Safety" brief: https://district10comopark.org/wp-content/uploads/2023/09/Passive-HouseHours-of-Safety-insight-brief_230821_215950.pdf
- Urban Green Council, *Baby It's Cold Inside* (2014): https://www.urbangreencouncil.org/wp-content/uploads/2022/11/2014.02.05-Baby-Its-Cold-Inside.pdf
- Sump pump battery runtime (HomeServe): https://www.homeserve.com/blog/home-improvement/how-long-will-battery-backup-sump-pump-last
- CPAP power draw and battery runtime (PowerOutage.us): https://poweroutage.us/home-battery-backup/best-cpap-battery-backups
- FDA insulin storage in emergencies: https://www.fda.gov/drugs/emergencypreparedness/ucm085213.htm
- Cell-site backup power (Light Reading, Sandy): https://www.lightreading.com/2g-3g-4g/sandy-the-case-for-better-cell-site-backup-
- Text vs call in disasters (CityLab, 2012): https://www.citylab.com/tech/2012/10/why-you-should-text-not-call-check-loved-ones-post-sandy/3736/
