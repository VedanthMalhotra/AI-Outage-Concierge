# Dashboard (`web/`) — TypeScript + Tailwind

The AI Outage Concierge dashboard, built with **TypeScript** and **Tailwind CSS** on **Vite**. It reads the mock JSON in [`../mock/api`](../mock/README.md); every response shape is typed in [`src/types.ts`](src/types.ts), so swapping the mock fetch for the real endpoint is a one-line change when the backend exists.

All functionality from the original build is preserved: the Leaflet map (home pin + shaded circuit + aggregated damage heat), the storm timeline player with weather effects, the risk card, the live restoration scenario sliders with before/after notes, preparation guidance, alerts, the chat panel, the assumptions modal, toasts, and the "clear my data" flow.

## AEP brand standards

The AEP look is encoded as the Tailwind theme in [`tailwind.config.ts`](tailwind.config.ts) so it is reusable and consistent:

- **AEP red** `#c22823` (with `accent-dark`, `accent-ink`, `accent-soft`) used sparingly for buttons, links and accents
- White page, white cards with light `#e3e6ea` borders, cool-gray `#f5f6f8` band behind cards
- Dark slate text `#2b2b2b`, muted `#666b72`
- Risk bands always paired with text, never colour alone
- Small 6px radii, soft low shadows, Segoe UI type stack

Component patterns and the map/weather visuals that Tailwind can't express inline live in [`src/styles.css`](src/styles.css) under `@layer components` / `@layer utilities`.

## Project layout

```
web/
  index.html            entry; loads src/main.ts as a module
  src/
    main.ts             app logic (boot, map, risk, restoration, timeline, chat)
    types.ts            typed mock API shapes (MVP plan §7)
    dom.ts              typed DOM + fetch + toast helpers
    styles.css          Tailwind layers + AEP component/utility CSS
  tailwind.config.ts    AEP brand tokens as the Tailwind theme
  postcss.config.js     tailwindcss + autoprefixer
  vite.config.ts        serves web/ and the sibling mock/ folder
  tsconfig.json         strict TypeScript config
  package.json          scripts + deps
```

## Run it

Requires Node.js 18+.

```bash
cd web
npm install
npm run dev        # starts Vite, opens web/index.html
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build to web/dist
npm run preview    # serve the production build
```

Vite's root is the repo root so the dashboard can read the sibling `mock/` folder over http; the entry point stays `web/index.html`.

## Live backend vs mock data

The dashboard now talks to the FastAPI backend (`../backend`) for the data it
serves, and falls back to the mock JSON when the backend is unreachable.

- **Live from the API** (`src/api.ts`): premise lookup + the dev picker list
  (`/premise/lookup`) and the damage heat layer (`/damage/heat`). When these
  load from the backend, the header reads "… · live API".
- **Still mock** (`../mock/api`): the circuit outline, risk-by-severity, the
  restoration grid, guidance, alerts, the storm timeline, chat, and the
  assumptions list. The backend has no equivalents for these yet, so they load
  from the sample JSON and the header reads "… · sample data".

Point the frontend at a backend with an env var — create `web/.env.local`:

```bash
# web/.env.local
VITE_API_BASE=http://localhost:8000
```

Start the backend first (see [`../backend/README.md`](../backend/README.md)):

```bash
cd backend
uv run uvicorn app.main:app --port 8000
```

If `VITE_API_BASE` is unset the client defaults to `http://localhost:8000`. If
the health probe fails, the dashboard quietly loads the mock data instead, so
the page always renders.

### Extending the live wiring

To move another panel onto the live API, add a `fetch*` adapter in
`src/api.ts` that reshapes the backend response into the matching type from
`src/types.ts`, then load it in `boot()` alongside the existing live calls.
