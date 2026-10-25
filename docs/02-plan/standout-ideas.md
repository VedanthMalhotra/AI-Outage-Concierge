# Ideas to make the AI Outage Concierge stand out

The current [MVP plan](mvp-plan.md) is solid, but it maps one-to-one onto the brief: every team will show a risk card, a restoration range, a checklist and four messages. Judges score **beyond-the-brief thinking** (Innovation, Curiosity, Breadth). These ideas build on the same engine and data, so none of them is a rewrite.

Each idea lists the gap it fills (from [existing-solutions.md](../03-research/existing-solutions.md)), the data it uses, a rough build effort, and the [rubric](../05-judging/judging-criteria.md) criteria it targets.

## Recommended: pick these four

### 1. "Works when the power is out": SMS-first, low-battery mode

**Insight (contrarian):** every team will build a web dashboard, but once the power is out the customer has no Wi-Fi, a draining phone, and maybe weak cell data. A dashboard is the wrong interface at the moment that matters most.

**What we build:** a two-way SMS-style concierge (simulated phone screen in the demo). Customers reply with one word: `WHY`, `WHEN`, `PREP`, `MED`, `OUT`. Answers fit in 160 characters. A "low-battery mode" toggle in the web app switches to a text-only page under 20 KB.

- **Gap filled:** utility alerts are one-way; chatbots need an app or a website.
- **Data:** same engine tools; the LLM compresses answers to SMS length, with templates as fallback.
- **Effort:** about 3 to 4 h (UI mock and short-answer mode on the existing tools).
- **Rubric:** Innovation (challenges the dashboard norm), Impact (real user need), Curiosity ("what does the customer actually have during an outage?").

### 2. "Your Power Path": the customer's own line from substation to home

**Insight:** customers don't know *why* they lose power. The topology file tells us exactly which breaker, recloser, fuse and transformer feed each home.

**What we build:** a simple horizontal diagram: `Substation → Breaker → Recloser → Fuse → Transformer → Your home`. Each link is colored by risk (pole age, overhead length, past damage) with a one-line reason. During the storm replay, links turn red when damaged and green when repaired, and the customer sees their **place in the repair queue** in aggregate ("2 repairs are ahead of yours; one restores a hospital circuit").

- **Gap filled:** no existing customer tool explains dependencies or repair order; utilities show one ETR time.
- **Data:** `matched_upstream.txt`, poles, lines, devices, ARCOS damage, priority facilities (aggregated only).
- **Effort:** about 4 to 5 h (the chain already exists in the plan; this is a visual on top).
- **Rubric:** Communication (a clear, beautiful visual of the concept), Breadth (power engineering + graph analysis + design), Curiosity ("show us something clever").

### 3. "Time that matters": a personal countdown against the restoration range

**Insight:** an ETR range only matters relative to what runs out first. Ready.gov says a fridge keeps food safe for about 4 h and a full freezer for about 48 h; a CPAP or oxygen concentrator battery may last only a few hours.

**What we build:** one timeline bar showing the P10 to P90 restoration range alongside the customer's own deadlines: phone battery, fridge (4 h), freezer (48 h), and any **declared** device battery runtime. Where a deadline falls inside the range, the app flags a **"battery gap"** ("Your oxygen battery lasts 6 h; there is a 70% chance the outage lasts longer") and triggers the medical escalation rule with a specific reason.

- **Gap filled:** prep advice is generic everywhere; medical-alert programs aren't tied to predicted duration.
- **Data:** Monte Carlo restoration distribution (already planned) plus public-health thresholds and declared needs.
- **Effort:** about 3 h.
- **Rubric:** Breadth (public health and human factors, a non-computing domain needed for 4 to 5 pts), Impact (life-safety value), Innovation.

### 4. Prove it: backtest on a held-out storm and test the messages on real people

**Insight:** judges ask "how did you test your ideas?" and "did you get feedback from your target audience?" Most teams will have neither.

**What we build:**
- **Backtest:** train on Feb 2025, replay Sep 2024 (or another event). Show a calibration chart ("of homes we called High risk, X% actually lost power") and how often the real repair day fell inside our range, compared with a naive single-number estimate.
- **Message test:** show 2 versions of each alert (single ETR time vs our range with a reason) to 10 to 15 people at the hackathon. Ask which they trust more and what they would do. Report the result on one slide.
- **Effort:** backtest about 2 to 3 h on top of the planned validation; survey about 1 h.
- **Rubric:** Impact (user feedback, research justification), Navigating challenges (evidence for pivots), Innovation (direct testing of the accepted solution).

## Strong extras if time allows

| Idea | What it is | Rubric |
| --- | --- | --- |
| **Under-promise by design** | Quote the P75 or P80 as "plan for", not the median, because research shows customers punish late restorations more than early ones (Exelon, 2025). Explain the choice on a slide. | Innovation, Impact |
| **Plain-language and multilingual check** | Every generated message is scored for reading level (target grade 8) and offered in Spanish; failures get regenerated. | Breadth (linguistics/accessibility), Communication |
| **Operator mirror view** | The same engine shows AEP an aggregated view: expected outages per circuit, predicted call volume, which messages go out when. Shows feasibility and business value. | Impact (feasible for AEP), Breadth (10x answer) |
| **"What would fix this" hardening what-if** | "Adding a recloser above this fuse would cut risk for 340 homes by about X%." Turns the risk model into a planning tool, filling the Rhizome-style gap. | Innovation, Impact, 10x answer |

## Process work that is worth points (do this regardless)

- **Questions log** (Curiosity, 5 pts needs "acted on the plan"): keep a running list of the questions asked, the plan to answer each, and what was done. Mentor questions in the MVP plan section 13 count.
- **Pivot log** (Navigating challenges): record each thing that failed and the change made (for example, damage-to-network matching rate, repair dates being closeout dates, missing conductor hours).
- **"Before vs after" slide:** today's AEP outage journey next to ours.

## Suggested pitch line

> "Every outage tool today talks to customers *after* the lights go out, through a website they can no longer load. Ours tells you before the storm what could fail on *your* line, how long it could last compared with what matters to you, and keeps working by text when your phone is at 15%."
