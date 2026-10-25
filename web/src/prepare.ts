/* =============================================================================
 * Prepare panel: a storm plan that adapts to THIS home's predicted outage
 * (restoration simulator, current sliders) and the storm severity.
 *
 *   1. Plan header   - risk band, likely outage length, storm strength
 *   2. Checklist     - Before / During / After tabs; items appear or drop out as
 *                      the expected outage gets longer or the storm stronger
 *   3. Will it last? - fridge, freezer, home heat: how long each lasts vs the
 *                      outage range
 *
 * Checklist rules and durations: MVP plan 5.3, USDA/FoodSafety.gov (fridge,
 * freezer, food after an outage), RMI "Hours of Safety" (home heat). Rules are
 * challenge assumptions, not AEP policy.
 * ========================================================================== */
import { $, el } from "./dom";

export interface PrepContext {
  band: string | null;          // risk band at the current storm severity
  probability: number | null;
  severityLabel: string;        // "Feb-2025-like (1.0×)"
  severity: number;
  runs: number[] | null;        // simulated outage hours (sorted), current sliders
  p10: number;
  p50: number;
  p90: number;
  medical: boolean;
  overheadService: boolean;
  general?: boolean;            // no premise selected: general guidance only
}

type Phase = "before" | "during" | "after";
interface Task { id: string; text: string; why?: string }

const ui = {
  phase: "before" as Phase,
  locked: false,                  // storm replay: show only the current phase's checklist
  done: new Set<string>(),        // checked task ids, this session only
  freezer: "full" as "full" | "half",
  home: "1970to2000" as "pre1970" | "1970to2000" | "post2000",
};

const HIGH = new Set(["High", "Very High"]);

function tasks(c: PrepContext): Record<Phase, Task[]> {
  const long = c.p50 >= 12;          // most likely half a day or more
  const veryLong = c.p90 > 24;        // could run past a day
  const days = Math.max(1, Math.min(7, Math.ceil(c.p90 / 24)));
  // general (no premise) has its own list, so the risk-based extras don't double up on it
  const high = !c.general && (HIGH.has(c.band ?? "") || c.severity >= 1.5);
  const before: Task[] = [
    { id: "charge", text: "Charge phones, power banks and laptops", why: "Your phone is how you'll get updates." },
    { id: "lights", text: "Put flashlights and spare batteries where you can find them (no candles)" },
    // basics for everyone, with or without a home: they don't depend on risk or outage length
    { id: "breaker", text: "Find your main breaker so you can switch it off if needed" },
    { id: "radio", text: "Have a battery or crank radio for news if phones go down" },
  ];
  if (c.general) {
    // no premise: steps that make sense for anyone, nothing sized to an outage length
    before.push(
      { id: "unplug", text: "Unplug TVs, computers and other sensitive electronics" },
      { id: "meds", text: "Check you have enough of any medicines" },
      { id: "buddy", text: "Set up a check-in with a neighbour or family" },
    );
  }
  if (c.p50 >= 4) {
    before.push({ id: "water", text: `Store water: 1 gallon per person per day for ${days} day${days > 1 ? "s" : ""}`, why: `Sized to your outage range (up to ${Math.round(c.p90)} h).` });
    before.push({ id: "food", text: "Stock food that needs no cooking or fridge" });
    before.push({ id: "meds", text: "Refill prescriptions and check you have enough medicine" });
  }
  if (long || high) {
    before.push({ id: "ice", text: "Freeze water bottles to keep the fridge cold longer" });
    before.push({ id: "car", text: "Fill your car's tank and get some cash" });
  }
  if (veryLong) before.push({ id: "stay", text: "Pick a warm place you could stay if it runs past a day" });
  if (high) {
    before.push({ id: "unplug", text: "Unplug sensitive electronics before the storm" });
    before.push({ id: "buddy", text: "Set up a check-in with a neighbour or family" });
  }
  if (c.medical) {
    before.unshift({ id: "med-batt", text: "Fully charge your medical device and spare batteries", why: c.p90 ? `Your outage could last up to ${Math.round(c.p90)} h.` : undefined });
    before.push({ id: "med-plan", text: "Ask your equipment supplier about backup power, and plan where you'd go" });
  }

  const during: Task[] = [
    { id: "closed", text: "Keep the fridge and freezer closed" },
    { id: "lines", text: "Stay at least 30 ft from downed lines and report them" + (c.overheadService ? ", including the line to your house" : "") },
    { id: "gen", text: "Run a generator outdoors only, far from windows; never refuel it running" },
    { id: "appl", text: "Switch off big appliances; leave one light on so you know when power is back" },
  ];
  if (long) {
    during.push({ id: "warm", text: "Close off unused rooms and wear layers to hold heat" });
    during.push({ id: "phone-save", text: "Save your phone: low-power mode, charge in the car" });
  }
  if (veryLong) during.push({ id: "go", text: "If the house drops below 40°F, go to your warm place" });
  if (c.medical) during.unshift({ id: "med-switch", text: "Switch to battery backup; if it will run out, go to your backup place early" });

  const after: Task[] = [
    { id: "food-check", text: "Throw out fridge food that was above 40°F for over 2 hours", why: "USDA food safety rule." },
    { id: "replug", text: "Plug appliances back in one at a time" },
    { id: "still-out", text: "Neighbours back on but you're not? Report it (reply OUT)" },
    { id: "mast", text: "Check the pipe where wires meet your house; if damaged, call an electrician first" },
    { id: "restock", text: "Restock water, batteries and food for next time" },
  ];
  return { before, during, after };
}

// ---- Will it last? ---------------------------------------------------------

const HEAT = { pre1970: 8, "1970to2000": 23, post2000: 45 } as const;

interface Card { key: string; icon: string; name: string; hours: number; tip: string; control?: string }

function cards(): Card[] {
  const list: Card[] = [
    { key: "fridge", icon: "🧊", name: "Fridge", hours: 4, tip: "Move milk, meat and cold medicines to a cooler with ice." },
    { key: "freezer", icon: "❄️", name: "Freezer", hours: ui.freezer === "full" ? 48 : 24,
      tip: "Keep it shut; fill gaps with ice.",
      control: `<select data-k="freezer"><option value="full"${ui.freezer === "full" ? " selected" : ""}>full</option><option value="half"${ui.freezer === "half" ? " selected" : ""}>half full</option></select>` },
    { key: "heat", icon: "🔥", name: "Home heat", hours: HEAT[ui.home],
      tip: "Plan a warm place to go before it gets cold.",
      control: `<select data-k="home"><option value="pre1970"${ui.home === "pre1970" ? " selected" : ""}>built before 1970</option><option value="1970to2000"${ui.home === "1970to2000" ? " selected" : ""}>built 1970–2000</option><option value="post2000"${ui.home === "post2000" ? " selected" : ""}>built after 2000</option></select>` },
  ];
  return list;
}

function chance(runs: number[], h: number): number {
  return runs.length ? runs.filter((x) => x > h).length / runs.length : 0;
}

function verdict(p: number): { cls: string; text: string } {
  if (p > 0.5) return { cls: "risk", text: "Likely to run out" };
  if (p >= 0.2) return { cls: "watch", text: "Might run out" };
  return { cls: "ok", text: "Should be fine" };
}

// ---- render ----------------------------------------------------------------

let lastCtx: PrepContext | null = null;

export function renderPrepare(c: PrepContext): void {
  lastCtx = c;
  const hasRuns = !!c.runs && c.runs.length > 0;

  // 1. plan header
  const basis = $("#prep-basis");
  basis.innerHTML = hasRuns
    ? `<div class="prep-basis__main">Plan for about <strong>${Math.round(c.p50)} hours</strong> without power</div>` +
      `<div class="prep-basis__sub">could be ${Math.round(c.p10)}–${Math.round(c.p90)} h` +
      (c.band ? ` · ${c.band} risk${c.probability != null ? ` (${Math.round(c.probability * 100)}%)` : ""}` : "") +
      ` · ${c.severityLabel} storm · model estimate</div>`
    : c.general
      ? `<div class="prep-basis__main">General storm plan</div><div class="prep-basis__sub">No premise ID entered, so these steps aren't tailored to a home. ` +
        `Enter a premise ID at the top to see that home's chance of an outage and how long it could last.</div>`
      : `<div class="prep-basis__main">General storm plan</div><div class="prep-basis__sub">We can't estimate an outage for this home.</div>`;

  // 2. checklist with tabs + progress
  const all = tasks(hasRuns ? c : { ...c, p10: 0, p50: 0, p90: 0 });
  (["before", "during", "after"] as Phase[]).forEach((ph) => {
    const btn = $(`#prep-tab-${ph}`);
    btn.hidden = ui.locked && ui.phase !== ph;
    const left = all[ph].filter((t) => !ui.done.has(t.id)).length;
    btn.classList.toggle("is-active", ui.phase === ph);
    btn.setAttribute("aria-selected", String(ui.phase === ph));
    btn.querySelector(".prep-tab__count")!.textContent = left ? String(left) : "✓";
  });
  // the checklist appears once the storm walkthrough starts (Step); before that, a hint
  const started = ui.locked;
  $(".prep-tabs").hidden = !started;
  $(".prep-progress").hidden = !started;
  $("#prep-checklist").hidden = !started;
  if (!started) {
    $("#prep-progress-text").textContent =
      "Press Step on the map to see what to do before, during and after the storm.";
  }
  const list = all[ui.phase];
  const doneN = list.filter((t) => ui.done.has(t.id)).length;
  $("#prep-progress-bar").style.width = `${list.length ? (doneN / list.length) * 100 : 0}%`;
  if (started) $("#prep-progress-text").textContent = `${doneN} of ${list.length} done`;
  const ul = $("#prep-checklist");
  ul.innerHTML = "";
  list.forEach((t) => {
    const li = el("li", "prep-task" + (ui.done.has(t.id) ? " is-done" : ""));
    const label = el("label", "prep-task__label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = ui.done.has(t.id);
    box.addEventListener("change", () => {
      if (box.checked) ui.done.add(t.id); else ui.done.delete(t.id);
      renderPrepare(lastCtx!);
    });
    label.appendChild(box);
    const txt = el("span", "prep-task__text");
    txt.textContent = t.text;
    if (t.why) txt.appendChild(el("span", "prep-task__why", t.why));
    label.appendChild(txt);
    li.appendChild(label);
    ul.appendChild(li);
  });

  // 3. will it last?
  // only with a home: the cards compare against that home's outage length, so with no
  // premise there is nothing to base them on and the section is hidden
  $("#ttm-section").hidden = !hasRuns;
  const grid = $("#ttm-cards");
  grid.innerHTML = "";
  if (!hasRuns) return;
  const max = Math.max(48, c.p90 * 1.1);
  const pct = (h: number) => `${Math.min(100, (h / max) * 100).toFixed(1)}%`;
  cards().forEach((k) => {
    const p = chance(c.runs!, k.hours);
    const v = verdict(p);
    const card = el("div", `ttm-card ttm-card--${v.cls}`);
    card.innerHTML =
      `<div class="ttm-card__top"><span class="ttm-card__icon" aria-hidden="true">${k.icon}</span>` +
      `<span class="ttm-card__name">${k.name}</span><span class="ttm-pill ttm-pill--${v.cls}">${v.text}</span></div>` +
      `<div class="ttm-card__lasts">lasts about <strong>${Math.round(k.hours)} h</strong>` +
      (p >= 0.2 ? ` · ${Math.round(p * 100)}% chance the outage is longer` : "") + `</div>` +
      `<div class="ttm-mini" title="Blue: your likely outage (${Math.round(c.p10)}–${Math.round(c.p90)} h). Line: when it runs out.">` +
      `<span class="ttm-mini__band" style="left:${pct(c.p10)};width:calc(${pct(c.p90)} - ${pct(c.p10)})"></span>` +
      `<span class="ttm-mini__mark" style="left:${pct(k.hours)}"></span></div>` +
      (k.control ? `<div class="ttm-card__ctl">${k.control}</div>` : "") +
      (p >= 0.2 ? `<div class="ttm-card__tip">${k.tip}</div>` : "");
    grid.appendChild(card);
  });
}

/** What the prepare panel shows right now, for the chatbot: ticked / open tasks per phase and
 *  the "Will it last?" verdicts. */
export function prepSnapshot(): Record<string, unknown> | null {
  const c = lastCtx;
  if (!c) return null;
  const hasRuns = !!c.runs && c.runs.length > 0;
  const all = tasks(hasRuns ? c : { ...c, p10: 0, p50: 0, p90: 0 });
  const phase = (ph: Phase) => ({
    done: all[ph].filter((t) => ui.done.has(t.id)).map((t) => t.text),
    still_to_do: all[ph].filter((t) => !ui.done.has(t.id)).map((t) => t.text),
  });
  return {
    checklist_tab_showing: ui.phase,
    before_the_storm: phase("before"),
    power_is_out: phase("during"),
    power_is_back: phase("after"),
    will_it_last: hasRuns
      ? cards().map((k) => {
          const p = chance(c.runs!, k.hours);
          return { item: k.name, lasts_about_hours: Math.round(k.hours), verdict: verdict(p).text,
                   chance_outage_is_longer_pct: Math.round(p * 100) };
        })
      : [],
    freezer: ui.freezer,
    home_built: ui.home,
  };
}

/** Switch the checklist tab. The storm replay passes lock=true so only that phase shows. */
export function setPrepPhase(ph: Phase, lock = false): void {
  ui.phase = ph;
  ui.locked = lock;
  if (lastCtx) renderPrepare(lastCtx);
}

/** One delegated listener for the tabs and the card controls. */
export function wirePrepare(): void {
  (["before", "during", "after"] as Phase[]).forEach((ph) =>
    $(`#prep-tab-${ph}`).addEventListener("click", () => {
      ui.phase = ph;
      if (lastCtx) renderPrepare(lastCtx);
    })
  );
  const onCtl = (e: Event) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.k;
    if (!k || !lastCtx) return;
    if (k === "freezer") ui.freezer = t.value as typeof ui.freezer;
    if (k === "home") ui.home = t.value as typeof ui.home;
    renderPrepare(lastCtx);
  };
  $("#ttm-cards").addEventListener("change", onCtl);
}
