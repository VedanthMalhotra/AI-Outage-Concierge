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
  // "Will it last?": the appliances this person said they have, and their settings
  have: new Set<string>(),       // nothing ticked until the person picks
  phone: "phone" as "phone" | "bank",
  medBattery: "8" as "4" | "8" | "12" | "24",
  sump: "none" as "none" | "battery",
};

const HIGH = new Set(["High", "Very High"]);

/* AI-written checklist for the selected home (backend /ai-checklist); null = use the rules below */
export interface AiChecklist {
  before: { text: string; why?: string }[];
  during: { text: string; why?: string }[];
  after: { text: string; why?: string }[];
  source: string;
}
let ai: AiChecklist | null = null;
export function setAiChecklist(list: AiChecklist | null): void {
  ai = list;
  if (lastCtx) renderPrepare(lastCtx);
}

/* the appliance keys this household ticked (sent with the AI checklist request) */
export function getAppliances(): string[] {
  return [...ui.have];
}
let onMake: (() => void) | null = null;
let onAppliancesChange: ((have: string[]) => void) | null = null;
/* told whenever the ticked appliances change (main.ts maps "medical" to declared medical needs) */
export function setOnAppliancesChange(fn: (have: string[]) => void): void {
  onAppliancesChange = fn;
}
/* "Clear my data": untick everything */
export function clearAppliances(): void {
  ui.have.clear();
  onAppliancesChange?.([]);
  if (lastCtx) renderPrepare(lastCtx);
}
export function setOnMake(fn: () => void): void {
  onMake = fn;
}

/* While the AI writes the checklist: the factors it is using, shown as an animated list
 * (each one "checks off" in turn). null = not building. */
let aiBuilding: string[] | null = null;
export function setAiBuilding(factors: string[] | null): void {
  aiBuilding = factors;
  if (lastCtx) renderPrepare(lastCtx);
}

function buildingBlock(factors: string[]): HTMLElement {
  const box = el("div", "ai-building");
  box.setAttribute("role", "status");
  box.appendChild(el("div", "ai-building__title", "✦ Building your personalised checklist…"));
  const ul = el("ul", "ai-building__steps");
  factors.forEach((f, i) => {
    const li = el("li", "ai-step");
    li.style.setProperty("--d", `${i * 0.45}s`);
    li.appendChild(el("span", "ai-step__spin"));
    li.appendChild(el("span", "ai-step__tick", "✓"));
    const t = el("span", "ai-step__text");
    t.textContent = f;
    li.appendChild(t);
    ul.appendChild(li);
  });
  box.appendChild(ul);
  return box;
}

function tasks(c: PrepContext): Record<Phase, Task[]> {
  // a home is selected and the AI list is in: use it (no premise keeps the general rules)
  if (ai && !c.general) {
    const conv = (ph: Phase, list: AiChecklist[Phase]) =>
      list.map((t, i) => ({ id: `ai-${ph}-${i}`, text: t.text, why: t.why || undefined }));
    return { before: conv("before", ai.before), during: conv("during", ai.during), after: conv("after", ai.after) };
  }
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

/* a <select data-k=key> for a card setting (static options only) */
function sel(key: string, current: string, options: [string, string][]): string {
  return `<select data-k="${key}">` +
    options.map(([v, label]) => `<option value="${v}"${v === current ? " selected" : ""}>${label}</option>`).join("") +
    `</select>`;
}

/* Everything a person can pick, with how long it keeps working without power. Food times are
 * USDA guidance; the rest are typical values the person can adjust on the card. */
function allCards(): Card[] {
  return [
    { key: "fridge", icon: "🧊", name: "Fridge", hours: 4, tip: "Move milk, meat and cold medicines to a cooler with ice." },
    { key: "freezer", icon: "❄️", name: "Freezer", hours: ui.freezer === "full" ? 48 : 24,
      tip: "Keep it shut; fill gaps with ice.",
      control: sel("freezer", ui.freezer, [["full", "full"], ["half", "half full"]]) },
    { key: "heat", icon: "🔥", name: "Home heat", hours: HEAT[ui.home],
      tip: "Plan a warm place to go before it gets cold.",
      control: sel("home", ui.home, [["pre1970", "built before 1970"], ["1970to2000", "built 1970–2000"], ["post2000", "built after 2000"]]) },
    { key: "phone", icon: "📱", name: "Phone", hours: ui.phone === "bank" ? 36 : 12,
      tip: "Use low-power mode, and charge from the car if you can.",
      control: sel("phone", ui.phone, [["phone", "phone battery only"], ["bank", "with a power bank"]]) },
    { key: "medical", icon: "🩺", name: "Medical device", hours: Number(ui.medBattery),
      tip: "Plan now where you'd go to plug it in before the battery runs out.",
      control: sel("medBattery", ui.medBattery, [["4", "4 h battery"], ["8", "8 h battery"], ["12", "12 h battery"], ["24", "24 h battery"]]) },
    { key: "sump", icon: "💧", name: "Sump pump", hours: ui.sump === "battery" ? 6 : 0,
      tip: "Without power it stops: move valuables off the basement floor.",
      control: sel("sump", ui.sump, [["none", "no battery backup"], ["battery", "battery backup"]]) },
    { key: "well", icon: "🚰", name: "Well water pump", hours: 0,
      tip: "No running water until power is back: fill jugs and the bathtub before the storm." },
  ];
}

/* only the cards for appliances this person picked */
function cards(): Card[] {
  return allCards().filter((k) => ui.have.has(k.key));
}

function chance(runs: number[], h: number): number {
  return runs.length ? runs.filter((x) => x > h).length / runs.length : 0;
}

function verdict(p: number, hours = 1): { cls: string; text: string } {
  if (hours <= 0) return { cls: "risk", text: "Stops right away" };
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
  if (aiBuilding && !c.general) basis.appendChild(buildingBlock(aiBuilding));
  else if (ai && !c.general) {
    const tag = el("div", "prep-basis__ai");
    tag.textContent = `✦ ${ai.source}`;
    basis.appendChild(tag);
  }

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
  // (or, for a selected home, once its personalised checklist has been made)
  // A selected home shows NO checklist until its personalised one has been made (not even
  // during the storm walkthrough); with no premise, the general list shows during the walkthrough
  const started = c.general ? ui.locked : !!ai;
  $(".prep-tabs").hidden = !started;
  $(".prep-progress").hidden = !started;
  $("#prep-checklist").hidden = !started;
  if (!started) {
    $("#prep-progress-text").textContent = c.general
      ? "Press Step on the map to see what to do before, during and after the storm."
      : aiBuilding
        ? ""
        : ui.locked
          ? "Make your personalised checklist above to see what to do at each step of the storm."
          : "Tick what you have above, then press “Make my personalised checklist”.";
  }

  // step 1 for a selected home: appliance picker + make button
  $("#prep-start").hidden = !!c.general;
  const picker = $("#ttm-picker");
  picker.innerHTML = "";
  allCards().forEach((k) => {
    const b = el("button", "ttm-chip" + (ui.have.has(k.key) ? " is-on" : ""), `${k.icon} ${k.name}`);
    b.setAttribute("type", "button");
    b.dataset.have = k.key;
    b.setAttribute("aria-pressed", String(ui.have.has(k.key)));
    picker.appendChild(b);
  });
  const make = $<HTMLButtonElement>("#prep-make");
  make.disabled = !!aiBuilding;
  make.textContent = aiBuilding ? "Building your checklist…" : ai ? "↻ Update my checklist" : "✦ Make my personalised checklist";
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
    if (t.why) {
      const why = el("span", "prep-task__why");
      why.textContent = t.why; // text, not HTML: this can be AI-written
      txt.appendChild(why);
    }
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
  if (!ui.have.size) {
    grid.appendChild(el("p", "muted small", "Tick the appliances you have under “What do you have at home?” to see how long each would last."));
  }
  const max = Math.max(48, c.p90 * 1.1);
  const pct = (h: number) => `${Math.min(100, (h / max) * 100).toFixed(1)}%`;
  cards().forEach((k) => {
    const p = k.hours <= 0 ? 1 : chance(c.runs!, k.hours);
    const v = verdict(p, k.hours);
    const card = el("div", `ttm-card ttm-card--${v.cls}`);
    card.innerHTML =
      `<div class="ttm-card__top"><span class="ttm-card__icon" aria-hidden="true">${k.icon}</span>` +
      `<span class="ttm-card__name">${k.name}</span><span class="ttm-pill ttm-pill--${v.cls}">${v.text}</span></div>` +
      (k.hours <= 0
        ? `<div class="ttm-card__lasts">stops <strong>as soon as the power goes out</strong></div>`
        : `<div class="ttm-card__lasts">lasts about <strong>${Math.round(k.hours)} h</strong>` +
          (p >= 0.2 ? ` · ${Math.round(p * 100)}% chance the outage is longer` : "") + `</div>`) +
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
          const p = k.hours <= 0 ? 1 : chance(c.runs!, k.hours);
          return { item: k.name, lasts_about_hours: Math.round(k.hours), verdict: verdict(p, k.hours).text,
                   chance_outage_is_longer_pct: Math.round(p * 100) };
        })
      : [],
    appliances_picked: [...ui.have],
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
    if (k === "phone") ui.phone = t.value as typeof ui.phone;
    if (k === "medBattery") ui.medBattery = t.value as typeof ui.medBattery;
    if (k === "sump") ui.sump = t.value as typeof ui.sump;
    renderPrepare(lastCtx);
  };
  $("#ttm-cards").addEventListener("change", onCtl);
  $("#prep-make").addEventListener("click", () => onMake?.());
  // appliance picker chips: toggle an appliance on or off
  $("#ttm-picker").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-have]");
    if (!b || !lastCtx) return;
    const key = b.dataset.have!;
    if (ui.have.has(key)) ui.have.delete(key); else ui.have.add(key);
    onAppliancesChange?.([...ui.have]);
    renderPrepare(lastCtx);
  });
}
