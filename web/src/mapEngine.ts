/// <reference types="vite/client" />
/* Which map the dashboard uses: the TomTom 3D map (tomtomMap.ts) when a TomTom key is
 * configured (VITE_TOMTOM_API_KEY in web/.env), otherwise the deck.gl satellite map
 * (map3d.ts), so the site always has a working map. Both expose the same functions. */
import * as deckMap from "./map3d";
import * as tomtom from "./tomtomMap";

export const usingTomTom = !!import.meta.env.VITE_TOMTOM_API_KEY?.trim();
const m = usingTomTom ? tomtom : deckMap;

export function initMap(args: deckMap.InitMapArgs): void {
  m.initMap(args);
  // the page says "Loading TomTom 3D map…" by default; say what's really showing
  const status = document.getElementById("map-status");
  if (!usingTomTom && status) status.textContent = "Satellite map · 3D terrain";
}

export const {
  flyToPremise,
  flyToOverview,
  flyToArea,
  setViewMode,
  getViewMode,
  setHomeVisible,
  setPowerPath,
  setRiskHeat,
  setCircuit,
  setPhaseVisuals,
  resizeMap,
} = m;
