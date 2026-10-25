# Roanoke Valley outage dashboard

TypeScript, Vite, Tailwind and deck.gl dashboard connected to the FastAPI backend. The app uses processed AEP data and model outputs; it does not silently substitute mock predictions when the API fails. The historical storm replay is a simulation, not a live outage feed.

## Run

From `web/`, run `npm install`, then `npm run dev`. Open the printed URL followed by `/web/index.html`. Start the backend separately as described in `../backend/README.md`. Set `VITE_API_BASE` in `web/.env.local` to override `http://localhost:8000`.

`npm run build` performs the TypeScript check and creates `dist/`. `npm run typecheck` checks types only.

## Dashboard

- Area map with risk cells, selected home and equipment path.
- Elevation-based 3D terrain, satellite imagery, animated navigation, home/overview controls and a flat 2D option.
- Outage risk, restoration scenario controls and explanations.
- Preparation guidance, alerts, historical storm replay and food/heat duration comparison.
- Session-scoped outage concierge and clear-data controls.

## TomTom 3D map

The dashboard uses the official `@tomtom-org/maps-sdk` with TomTom vector street maps, 3D buildings, and elevation through TerrainModule. Native GeoJSON layers keep the AEP risk areas, circuit boundary, and equipment path aligned to the terrain. The selected home is the only customer marker. Equipment and area hover cards show model estimates. The 2D/3D toggle, home/overview buttons, zoom and compass controls are available on the map.

Create `web/.env.local` with `VITE_TOMTOM_API_KEY=your_browser_key`. This file is ignored by Git. Vite explicitly reads environment files from `web/` even though the server root is the repository. Restart the dev server after changing the key. For production, provide the key at build time. Browser map keys are visible in network requests; configure allowed domains and API permissions in TomTom before publishing. TomTom's free usage allowance is subject to its current pricing; no paid plan is enabled by this app.

TomTom and OpenStreetMap attribution is supplied by the renderer. Internet and WebGL2 are required. If the key or connection fails, the map displays a status message instead of claiming that the provider is working. Terrain and buildings depend on provider coverage and key permissions. The older deck.gl renderer remains in `src/map3d.ts` but is not used by the dashboard.

MapLibre's worker is explicitly bundled for Vite 5. The SDK and MapLibre entry aliases allow dependency optimization with this repository's nested frontend directory.

References: https://docs.tomtom.com/maps-sdk-js/guides/map/terrain and https://docs.tomtom.com/maps-sdk-js/guides/map/base-map

## Main files

`index.html`: accessible dashboard structure. `src/styles.css`: responsive layout and theme. `src/main.ts`: dashboard state and controls. `src/tomtomMap.ts`: TomTom rendering. `src/api.ts`: backend requests. `src/prepare.ts`: preparation experience.
