/*
 * Research Institutions Map
 * ---------------------------------------------------
 * 1. Fetches map_data.json and papers.json (both made by build_data.py).
 *      - map_data.json: the venue list and every institution, with the
 *        papers it took part in, its country, coordinates, top 3
 *        collaborating institutions and top authors
 *      - papers.json:   every paper, so we know each paper's venue
 * 2. Builds two GeoJSON layers:
 *      - institutions: one point per institution with valid coordinates
 *      - countries:    one big point per country (paper-weighted average
 *                      position of its institutions)
 * 3. Renders them on a MapLibre GL map using a free Esri raster style
 *    (no API key required).
 * 4. Zoomed OUT: only the country nodes are shown.
 *    Zoomed IN (past COUNTRY_TO_INSTITUTION_ZOOM): the country nodes
 *    disappear and the individual institutions appear.
 * 5. Node radius is scaled by sqrt(papers) so a few very large
 *    nodes don't drown out everything else.
 *    Many institutions share the exact same coordinates (often the city
 *    centre). Those are fanned out around that point, biggest in the
 *    middle, so each one can be seen and clicked (see spreadStacks()).
 * 6. Every paper count on the page (node sizes, popups, search results)
 *    only counts papers in the venues ticked in the venue filter.
 *    A country counts each paper ONCE, even when several of its
 *    institutions worked on it. Institutions without coordinates are not
 *    drawn but still count towards their country (when the country is known).
 * 7. Clicking a node shows a popup:
 *      - institution node: country / papers / papers per venue /
 *                          top 3 collaborating institutions / top authors
 *      - country node:     country / papers / papers per venue / top 3 institutes
 *    The "papers per venue" list opens and closes with a click.
 * 8. Left sidebar (see the SIDEBAR section near the bottom):
 *      - search box: type an institution name, click a result and the
 *        map flies to it and opens its popup
 *      - country filter: tick/untick countries to show/hide their nodes
 *      - venue filter: tick/untick venues; counts and node sizes follow
 */

const MAP_DATA_PATH = "map_data.json";
const PAPERS_PATH = "papers.json";

// Radius range (in pixels) for individual institution circles.
const MIN_RADIUS = 3;
const MAX_RADIUS = 24;

// Radius range (in pixels) for the big merged country circles.
const COUNTRY_MIN_RADIUS = 8;
const COUNTRY_MAX_RADIUS = 50;

// CHANGE THIS to control when countries split into institutions.
// Below this zoom level you see countries; at or above it you see institutions.
// (Bigger number = you have to zoom in further before they split.)
const COUNTRY_TO_INSTITUTION_ZOOM = 3;

// How many institutes to list in a country popup.
const TOP_INSTITUTES_COUNT = 3;

const statusBox = document.getElementById("status");

function showStatus(message, isError = false) {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? "#000" : "#000";
}

function hideStatus() {
  statusBox.hidden = true;
}

/**
 * Free, no-API-key base map style: Esri's classic "Light Gray Canvas" raster
 * tile service (services.arcgisonline.com). This is a legacy, long-standing
 * public REST tile service — distinct from Esri's newer key-gated basemap
 * APIs — and has historically not required any account, token, or key for
 * this kind of usage. It renders a minimal light-gray map showing only
 * country/region borders, water, and streets — no building outlines,
 * land-use coloring, or text labels.
 *
 * A CSS grayscale filter (see style.css) is applied on top as a safety net
 * to guarantee a fully black-and-white look regardless of subtle tinting.
 *
 * Note: this is a third-party free service governed by Esri's terms of use.
 * If it's ever unavailable or terms change, the OSM raw tile fallback used
 * earlier can be swapped back in (see the commented block below).
 */
const OSM_STYLE = {
  version: 8,
  sources: {
    "esri-light-gray": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS community",
    },
  },
  layers: [
    {
      id: "base-tiles",
      type: "raster",
      source: "esri-light-gray",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

/* --- Fallback option (raw OpenStreetMap raster tiles), kept for reference:
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};
--- */

const map = new maplibregl.Map({
  container: "map",
  style: OSM_STYLE,
  center: [10, 30],
  zoom: 1.5,
  renderWorldCopies: false, // prevents the map repeating sideways when panned/zoomed out
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right"
);

/* =====================================================================
 * DATA: institutions, countries and paper counts
 * ===================================================================== */

let venues = [];                   // [{ code, name, papers }] from map_data.json
let paperVenues = [];              // paperVenues[paperId] = venue code of that paper
let institutions = [];             // every institution (with or without coordinates)
let countries = [];                // one entry per country, see buildCountries()
let selectedCountries = new Set(); // country codes that are currently ticked
let selectedVenues = new Set();    // venue codes that are currently ticked

/**
 * Number of the given papers that are in a ticked venue.
 */
function countPapers(paperIds) {
  let count = 0;
  for (const id of paperIds) {
    if (selectedVenues.has(paperVenues[id])) count++;
  }
  return count;
}

/**
 * Papers per ticked venue, biggest first: [{ code, count }].
 * Venues with no papers are left out.
 */
function papersPerVenue(paperIds) {
  const counts = new Map();
  for (const id of paperIds) {
    const venue = paperVenues[id];
    if (selectedVenues.has(venue)) counts.set(venue, (counts.get(venue) || 0) + 1);
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * Turns a 2-letter country code (e.g. "NL") into a readable name
 * ("Netherlands") using the browser's built-in region names.
 * Falls back to the code itself if the browser doesn't know it.
 */
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

/**
 * Groups the institutions by country and works out, for each country:
 *   - all of its papers, each paper ONCE (a set of paper ids)
 *   - a map position (paper-weighted average of its institutions' coordinates)
 * The position uses all venues, so country nodes don't jump around when
 * the venue filter changes. Countries where no institution has coordinates
 * cannot be placed and are skipped.
 */
function buildCountries() {
  const groups = new Map();
  for (const inst of institutions) {
    if (!inst.country) continue;
    if (!groups.has(inst.country)) groups.set(inst.country, []);
    groups.get(inst.country).push(inst);
  }

  const result = [];
  for (const [code, members] of groups) {
    const placed = members.filter((i) => i.hasCoords && i.papers.length > 0);
    if (placed.length === 0) continue;

    const weight = placed.reduce((sum, i) => sum + i.papers.length, 0);
    const lon = placed.reduce((sum, i) => sum + i.lon * i.papers.length, 0) / weight;
    const lat = placed.reduce((sum, i) => sum + i.lat * i.papers.length, 0) / weight;

    const paperIds = new Set();
    members.forEach((i) => i.papers.forEach((id) => paperIds.add(id)));

    result.push({ code, name: countryName(code), lon, lat, members, papers: [...paperIds] });
  }
  return result;
}

/**
 * Turns a raw "papers" count into a circle radius (in px) using a
 * square-root scale. Square-root (rather than linear) keeps a single
 * huge outlier from making every other node invisible, because circle
 * *area* then scales roughly linearly with paper count.
 * minRadius / maxRadius let us reuse this for both institutions and countries.
 */
function papersToRadius(papers, minPapers, maxPapers, minRadius = MIN_RADIUS, maxRadius = MAX_RADIUS) {
  if (maxPapers === minPapers) return (minRadius + maxRadius) / 2;

  const sqrtVal = Math.sqrt(papers);
  const sqrtMin = Math.sqrt(minPapers);
  const sqrtMax = Math.sqrt(maxPapers);

  const t = (sqrtVal - sqrtMin) / (sqrtMax - sqrtMin); // 0..1
  return minRadius + t * (maxRadius - minRadius);
}

/**
 * Turns a list of { item, papers, lon, lat } into GeoJSON points whose
 * radius depends on the (filtered) paper count. Each point only stores the
 * position of its item in the original list ("id"); the popup looks the
 * rest up from there.
 */
function toGeoJSON(entries, minRadius, maxRadius) {
  addRadius(entries, minRadius, maxRadius);
  return {
    type: "FeatureCollection",
    features: entries.map((e) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lon, e.lat] }, // GeoJSON is [lng, lat]
      properties: {
        id: e.id,
        papers: e.papers,
        radius: e.radius,
      },
    })),
  };
}

/**
 * Gives every entry its circle radius (in px) from its paper count.
 */
function addRadius(entries, minRadius, maxRadius) {
  const counts = entries.map((e) => e.papers);
  const minPapers = Math.min(...counts);
  const maxPapers = Math.max(...counts);
  entries.forEach((e) => {
    e.radius = papersToRadius(e.papers, minPapers, maxPapers, minRadius, maxRadius);
  });
}

// Gap (in pixels) between fanned-out nodes that share a location.
const SPREAD_GAP = 2;

/**
 * Fans out institutions that sit on exactly the same coordinates, so they
 * don't hide each other. The biggest stays on the real point; the others
 * are placed around it in a sunflower pattern (each one a bit further out
 * and turned by the "golden angle"), spaced in SCREEN pixels. Because of
 * that the positions depend on the zoom level and are recalculated after
 * every zoom (see redrawInstitutions()).
 * Sets e.lon / e.lat to the position to draw at; e.realLon / e.realLat
 * keep the true coordinates.
 */
function spreadStacks(entries) {
  const stacks = new Map();
  for (const e of entries) {
    e.lon = e.realLon;
    e.lat = e.realLat;
    const key = `${e.realLon},${e.realLat}`;
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push(e);
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const stack of stacks.values()) {
    if (stack.length < 2) continue;
    stack.sort((a, b) => b.papers - a.papers);

    const centre = map.project([stack[0].realLon, stack[0].realLat]);
    const others = stack.slice(1);
    const averageRadius = others.reduce((sum, e) => sum + e.radius, 0) / others.length;
    const firstRing = stack[0].radius + averageRadius + SPREAD_GAP;
    const spacing = 2 * averageRadius + SPREAD_GAP;

    others.forEach((e, i) => {
      // Never closer than touching the middle node.
      const distance = Math.max(firstRing + spacing * 0.9 * Math.sqrt(i), stack[0].radius + e.radius + SPREAD_GAP);
      const angle = i * goldenAngle;
      const point = map.unproject([
        centre.x + distance * Math.cos(angle),
        centre.y + distance * Math.sin(angle),
      ]);
      e.lon = point.lng;
      e.lat = point.lat;
    });
  }
}

let shownInstitutions = [];          // the institution entries currently drawn
let drawnPositions = new Map();      // institution id -> [lng, lat] where it is drawn

/**
 * (Re)draws the institution layer: fans out stacked nodes for the current
 * zoom and remembers where every institution is drawn.
 */
function redrawInstitutions() {
  if (!map.getSource("institutions")) return;
  addRadius(shownInstitutions, MIN_RADIUS, MAX_RADIUS);
  spreadStacks(shownInstitutions);
  drawnPositions = new Map(shownInstitutions.map((e) => [e.id, [e.lon, e.lat]]));
  map.getSource("institutions").setData(toGeoJSON(shownInstitutions, MIN_RADIUS, MAX_RADIUS));
  refreshOpenPopup();
}

/**
 * True when an institution should be drawn: it has coordinates, its
 * country is ticked and it has at least one paper in a ticked venue.
 */
function isInstitutionVisible(inst) {
  return inst.hasCoords && selectedCountries.has(inst.country) && countPapers(inst.papers) > 0;
}

/**
 * Redraws both layers for the current filters: hidden nodes disappear and
 * the sizes of the others follow their filtered paper counts.
 */
function applyFilters() {
  // The layers are added a moment after the page loads; do nothing until then.
  if (!map.getSource("institutions")) return;

  shownInstitutions = [];
  institutions.forEach((inst, id) => {
    if (!isInstitutionVisible(inst)) return;
    shownInstitutions.push({ id, realLon: inst.lon, realLat: inst.lat, papers: countPapers(inst.papers) });
  });

  const shownCountries = [];
  countries.forEach((country, id) => {
    if (!selectedCountries.has(country.code)) return;
    const papers = countPapers(country.papers);
    if (papers > 0) shownCountries.push({ id, lon: country.lon, lat: country.lat, papers });
  });

  map.getSource("countries").setData(toGeoJSON(shownCountries, COUNTRY_MIN_RADIUS, COUNTRY_MAX_RADIUS));
  redrawInstitutions(); // also refreshes the open popup
}

/* =====================================================================
 * MAP LAYERS AND POPUPS
 * ===================================================================== */

/**
 * Shared circle styling. Big circles are drawn first so small ones
 * are never hidden underneath them.
 */
function circleLayer(id, source, zoomRange) {
  return {
    id,
    type: "circle",
    source,
    ...zoomRange,
    layout: {
      "circle-sort-key": ["-", ["get", "papers"]],
    },
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#000000",
      "circle-opacity": 0.5,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#000000",
      "circle-stroke-opacity": 0.9,
    },
  };
}

// Remembers the popup that is currently open, so we can close it
// before opening a new one (only one popup at a time), and what it is
// about, so it can be redrawn when the filters change.
let currentPopup = null;
let currentPopupTarget = null; // { kind: "institution" | "country", id }

/**
 * Opens a popup at the given [lng, lat]. Used by map clicks AND by the
 * sidebar search.
 */
function openPopupAt(coords, target) {
  if (currentPopup) currentPopup.remove();

  currentPopupTarget = target;
  currentPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
    .setLngLat(coords)
    .setHTML(popupHtml(target))
    .addTo(map);

  currentPopup.on("close", () => {
    currentPopup = null;
    currentPopupTarget = null;
  });
}

function popupHtml({ kind, id }) {
  return kind === "institution"
    ? institutionPopupHtml(institutions[id])
    : countryPopupHtml(countries[id]);
}

/**
 * After a filter change: redraws the open popup with the new counts,
 * or closes it if its node is no longer on the map.
 */
function refreshOpenPopup() {
  if (!currentPopup) return;

  const { kind, id } = currentPopupTarget;
  const stillShown =
    kind === "institution"
      ? isInstitutionVisible(institutions[id])
      : selectedCountries.has(countries[id].code) && countPapers(countries[id].papers) > 0;

  if (!stillShown) {
    currentPopup.remove();
    return;
  }

  // Institutions can move when stacked nodes are fanned out again.
  if (kind === "institution" && drawnPositions.has(id)) currentPopup.setLngLat(drawnPositions.get(id));

  // Keep the venue list open if it was open.
  const wasOpen = !!currentPopup.getElement().querySelector("details.popup-venues[open]");
  currentPopup.setHTML(popupHtml(currentPopupTarget));
  if (wasOpen) currentPopup.getElement().querySelector("details.popup-venues").open = true;
}

/**
 * The "Papers per venue" part of a popup: a list that opens and closes
 * when its title is clicked.
 */
function venueListHtml(paperIds) {
  const rows = papersPerVenue(paperIds)
    .map((v) => `<li>${escapeHtml(v.code)} <span class="label">(${v.count})</span></li>`)
    .join("");

  return `
    <details class="popup-venues">
      <summary>Papers per venue</summary>
      <ul class="popup-list">${rows}</ul>
    </details>
  `;
}

/**
 * The "Top collaborators" part of an institution popup: the 3 institutions
 * it shares the most papers with (all venues). The ones on the map link to them.
 */
function collaboratorsHtml(inst) {
  if (inst.collaborators.length === 0) {
    return `<div class="popup-row"><span class="label">Top collaborators:</span> none</div>`;
  }

  const items = inst.collaborators
    .map((c) => {
      const other = institutionsByName.get(c.name);
      const name =
        other && other.hasCoords
          ? `<a href="#" data-institution="${escapeHtml(c.name)}">${escapeHtml(c.name)}</a>`
          : escapeHtml(c.name);
      const shared = c.shared === null ? "" : ` <span class="label">(${c.shared} shared)</span>`;
      return `<li>${name}${shared}</li>`;
    })
    .join("");

  return `
    <div class="popup-row"><span class="label">Top ${inst.collaborators.length} collaborators:</span></div>
    <ol class="popup-list">${items}</ol>
  `;
}

/**
 * The "Top authors" part of an institution popup: the best-scoring authors
 * (see build_data.py) with their points and rank, each linking to
 * their profile page.
 */
function topAuthorsHtml(inst) {
  if (inst.topAuthors.length === 0) {
    return `<div class="popup-row"><span class="label">Top authors:</span> none found</div>`;
  }

  const items = inst.topAuthors
    .map((a) => {
      const rank = a.rank ? `, rank #${a.rank}` : "";
      return (
        `<li><a href="authors.html?name=${encodeURIComponent(a.name)}">${escapeHtml(a.name)}</a> ` +
        `<span class="label">(${a.points} points${rank})</span></li>`
      );
    })
    .join("");

  return `
    <div class="popup-row"><span class="label">Top ${inst.topAuthors.length} authors:</span></div>
    <ol class="popup-list">${items}</ol>
  `;
}

function institutionPopupHtml(inst) {
  return `
    <div class="popup-institution">${escapeHtml(inst.name)}</div>
    <div class="popup-row"><span class="label">Country:</span> ${escapeHtml(countryName(inst.country))}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${countPapers(inst.papers)}</div>
    ${venueListHtml(inst.papers)}
    ${collaboratorsHtml(inst)}
    ${topAuthorsHtml(inst)}
  `;
}

function countryPopupHtml(country) {
  const top = country.members
    .map((inst) => ({ inst, papers: countPapers(inst.papers) }))
    .filter((t) => t.papers > 0)
    .sort((a, b) => b.papers - a.papers || a.inst.name.localeCompare(b.inst.name))
    .slice(0, TOP_INSTITUTES_COUNT);

  const items = top
    .map((t) => {
      const name = t.inst.hasCoords
        ? `<a href="#" data-institution="${escapeHtml(t.inst.name)}">${escapeHtml(t.inst.name)}</a>`
        : escapeHtml(t.inst.name);
      return `<li>${name} <span class="label">(${t.papers})</span></li>`;
    })
    .join("");

  return `
    <div class="popup-institution">${escapeHtml(country.name)}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${countPapers(country.papers)}</div>
    ${venueListHtml(country.papers)}
    <div class="popup-row"><span class="label">Top ${top.length} institutes:</span></div>
    <ol class="popup-list">${items}</ol>
  `;
}

/**
 * Makes a layer clickable: pointer cursor on hover, popup on click.
 */
function makeClickable(layerId, kind) {
  map.on("mouseenter", layerId, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layerId, () => {
    map.getCanvas().style.cursor = "";
  });
  map.on("click", layerId, (e) => {
    const feature = e.features[0];
    const coords = feature.geometry.coordinates.slice();

    // If the map is zoomed/panned such that the point is duplicated
    // across the antimeridian, adjust the popup to the correct copy.
    while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
      coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
    }
    openPopupAt(coords, { kind, id: feature.properties.id });
  });
}

/**
 * Adds both layers. The country layer only shows BELOW the switch zoom,
 * the institution layer only AT/ABOVE it.
 */
function addLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("countries", { type: "geojson", data: empty });
  map.addSource("institutions", { type: "geojson", data: empty });

  map.addLayer(
    circleLayer("countries-circles", "countries", { maxzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );
  map.addLayer(
    circleLayer("institutions-circles", "institutions", { minzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );

  makeClickable("countries-circles", "country");
  makeClickable("institutions-circles", "institution");

  // Fanned-out positions are in screen pixels, so they change with the zoom.
  map.on("zoomend", redrawInstitutions);

  // The layers now exist, so draw whatever the checkboxes say.
  applyFilters();
  openInstitutionFromUrl();
}

// Links inside popups that point at another institution fly the map there.
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-institution]");
  if (!link) return;
  event.preventDefault();
  const inst = institutionsByName.get(link.dataset.institution);
  if (inst) goToInstitution(inst);
});

// Minimal HTML-escaping so institution/country names can't break the popup markup.
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =====================================================================
 * SIDEBAR: institution search + country filter + venue filter
 * ===================================================================== */

// How far the map zooms in when you pick a search result.
// Must be at least COUNTRY_TO_INSTITUTION_ZOOM, otherwise the institution
// nodes would still be hidden.
const SEARCH_JUMP_ZOOM = 8;

// Width of the sidebar in pixels. Must match the width in style.css.
// Used so that "fly to" centres the node in the visible part of the map,
// not underneath the sidebar.
const SIDEBAR_WIDTH = 320;

// Maximum number of results listed under the search box.
const MAX_SEARCH_RESULTS = 50;

// Makes the browser check for a newer copy of the data files instead of
// reusing an old one it saved earlier.
const FRESH = { cache: "no-cache" };

// Grab the sidebar elements from index.html.
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

let institutionsByName = new Map(); // institution name -> institution

/**
 * Lower-cases text and removes accents, so typing "universite" also
 * finds "Université" and "zurich" finds "Zürich".
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/* ---------- Checkbox filters (used for countries AND venues) ---------- */

/**
 * Builds one row of a checkbox list: [x] label ........ count
 */
function buildCheckboxRow({ value, label, count }) {
  const row = document.createElement("li");
  const wrapper = document.createElement("label");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = value;
  checkbox.checked = true;

  const name = document.createElement("span");
  name.textContent = label;

  const number = document.createElement("span");
  number.className = "count";
  number.textContent = count;

  wrapper.append(checkbox, name, number);
  row.append(wrapper);
  return row;
}

/**
 * Fills one collapsible checkbox box from index.html and wires up its
 * "Select all" / "Clear all" buttons.
 *   title:    heading text, e.g. "Filter by country"
 *   items:    [{ value, label, count }], one per checkbox (all start ticked)
 *   ids:      the element ids of this box in index.html
 *   onChange: function that runs every time the ticked boxes change
 * Returns the live Set of ticked values.
 */
function createCheckboxFilter({ title, items, ids, onChange }) {
  const list = document.getElementById(ids.list);
  const summary = document.getElementById(ids.summary);
  const selected = new Set(items.map((item) => item.value));

  function updateSummary() {
    summary.textContent = `${title} (${selected.size} of ${items.length} selected)`;
  }

  function changed() {
    updateSummary();
    onChange();
  }

  function setAll(checked) {
    selected.clear();
    for (const checkbox of list.querySelectorAll("input")) {
      checkbox.checked = checked;
      if (checked) selected.add(checkbox.value);
    }
    changed();
  }

  list.innerHTML = "";
  items.forEach((item) => list.append(buildCheckboxRow(item)));

  list.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    changed();
  });
  document.getElementById(ids.selectAll).addEventListener("click", () => setAll(true));
  document.getElementById(ids.clearAll).addEventListener("click", () => setAll(false));

  updateSummary();
  return selected;
}

/**
 * One checkbox item per country (alphabetical), with its number of drawn institutions.
 */
function buildCountryItems() {
  const counts = new Map();
  for (const inst of institutions) {
    if (inst.hasCoords && inst.country) counts.set(inst.country, (counts.get(inst.country) || 0) + 1);
  }

  return [...counts]
    .map(([code, count]) => ({ value: code, label: countryName(code), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * One checkbox item per venue, with its total number of papers.
 */
function buildVenueItems() {
  return venues.map((v) => ({ value: v.code, label: `${v.code} – ${v.name}`, count: v.papers }));
}

/**
 * Called after any filter change: refreshes the map and the search results.
 */
function onFiltersChanged() {
  applyFilters();
  renderSearchResults();
}

/* ---------- Institution search ---------- */

/**
 * Returns the visible institutions whose name contains EVERY typed word
 * (in any order, so "univ of tokyo" finds "The University of Tokyo"),
 * biggest (most papers) first.
 */
function findMatches(query) {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  return institutions
    .filter(isInstitutionVisible)
    .filter((inst) => {
      const name = normalizeText(inst.name);
      return words.every((word) => name.includes(word));
    })
    .map((inst) => ({ inst, papers: countPapers(inst.papers) }))
    .sort((a, b) => b.papers - a.papers);
}

/**
 * Flies the map to an institution and opens its popup.
 */
function goToInstitution(inst) {
  const coords = [inst.lon, inst.lat];

  map.flyTo({
    center: coords,
    zoom: Math.max(map.getZoom(), SEARCH_JUMP_ZOOM), // never zoom OUT
    // Keep the node clear of the sidebar while it is showing.
    padding: { left: isSidebarOpen() ? SIDEBAR_WIDTH : 0 },
    essential: true,
  });

  // The popup moves onto the node (which may be fanned out) once the
  // zoom has finished, see refreshOpenPopup().
  const id = institutions.indexOf(inst);
  openPopupAt(drawnPositions.get(id) || coords, { kind: "institution", id });
}

/**
 * Opens the institution named in the page address (?institution=...).
 * The author profile page links here.
 */
function openInstitutionFromUrl() {
  const name = new URLSearchParams(window.location.search).get("institution");
  if (!name) return;

  const inst = institutionsByName.get(name);
  if (inst && inst.hasCoords) goToInstitution(inst);
  else showStatus(`"${name}" cannot be shown on the map (no coordinates).`);
}

/**
 * Adds one line of plain text (not clickable) to the results list,
 * used for messages like "No matches".
 */
function addResultMessage(text) {
  const item = document.createElement("li");
  item.className = "no-hover";
  item.textContent = text;
  searchResults.append(item);
}

/**
 * Adds one clickable result line for an institution.
 */
function addResultItem({ inst, papers }) {
  const item = document.createElement("li");
  item.tabIndex = 0; // lets keyboard users reach it with Tab

  const name = document.createElement("div");
  name.textContent = inst.name;

  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.textContent = `${countryName(inst.country)} · ${papers} papers`;

  item.append(name, meta);
  item.addEventListener("click", () => goToInstitution(inst));
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToInstitution(inst);
  });

  searchResults.append(item);
}

/**
 * Redraws the list under the search box for whatever is typed right now.
 */
function renderSearchResults() {
  searchResults.innerHTML = "";

  if (searchInput.value.trim() === "") return; // nothing typed: empty list

  const matches = findMatches(searchInput.value);

  if (matches.length === 0) {
    addResultMessage("No matches with the current filters.");
    return;
  }

  matches.slice(0, MAX_SEARCH_RESULTS).forEach(addResultItem);

  if (matches.length > MAX_SEARCH_RESULTS) {
    addResultMessage(`…and ${matches.length - MAX_SEARCH_RESULTS} more. Keep typing to narrow it down.`);
  }
}

/* ---------- Show / hide the sidebar ---------- */

/**
 * True while the sidebar is visible. (The CSS class "sidebar-closed"
 * on <body> is what makes it slide away.)
 */
function isSidebarOpen() {
  return !document.body.classList.contains("sidebar-closed");
}

/**
 * Slides the sidebar away, or brings it back.
 */
function toggleSidebar() {
  document.body.classList.toggle("sidebar-closed");

  const label = isSidebarOpen() ? "Hide sidebar" : "Show sidebar";
  const button = document.getElementById("sidebar-toggle");
  button.setAttribute("aria-label", label);
  button.title = label;
}

/**
 * Makes the tab button work. Called straight away (not after the data
 * loads) so the button never depends on the data.
 */
function setupSidebarToggle() {
  document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
}

/* ---------- Setup ---------- */

/**
 * Sets up the whole sidebar. Called once, as soon as the data is loaded.
 */
function initSidebar() {
  selectedCountries = createCheckboxFilter({
    title: "Filter by country",
    items: buildCountryItems(),
    ids: { list: "country-list", summary: "country-summary", selectAll: "select-all", clearAll: "clear-all" },
    onChange: onFiltersChanged,
  });

  selectedVenues = createCheckboxFilter({
    title: "Filter by venue",
    items: buildVenueItems(),
    ids: { list: "venue-list", summary: "venue-summary", selectAll: "select-all-venues", clearAll: "clear-all-venues" },
    onChange: onFiltersChanged,
  });

  searchInput.addEventListener("input", renderSearchResults);
}

/**
 * Loads a JSON file.
 */
function fetchJson(path) {
  return fetch(path, FRESH).then((response) => {
    if (!response.ok) {
      throw new Error(
        `Could not fetch ${path} (HTTP ${response.status}). ` +
          `Make sure the file sits next to index.html and you're viewing this ` +
          `over http/https (not double-clicking the file), e.g. via a local server ` +
          `or GitHub Pages.`
      );
    }
    return response.json();
  });
}

function loadData() {
  showStatus("Loading institution data…");

  Promise.all([fetchJson(MAP_DATA_PATH), fetchJson(PAPERS_PATH)])
    .then(([mapData, papers]) => {
      venues = mapData.venues;
      paperVenues = papers.map((p) => p.venue);
      institutions = mapData.institutions.map((inst) => ({
        ...inst,
        hasCoords: inst.lat !== null && inst.lon !== null,
      }));
      institutionsByName = new Map(institutions.map((inst) => [inst.name, inst]));
      countries = buildCountries();

      initSidebar(); // fills the search box and both filters

      const located = institutions.filter((i) => i.hasCoords).length;
      if (located === 0) {
        showStatus("No institutions with valid coordinates were found in map_data.json.", true);
        return;
      }

      if (map.isStyleLoaded()) addLayers();
      else map.once("load", addLayers);

      const missing = institutions.length - located;
      if (missing > 0) {
        console.warn(
          `${missing} institution(s) have no coordinates (not drawn; counted in their country when it is known):`,
          institutions.filter((i) => !i.hasCoords).map((i) => i.name)
        );
        showStatus(
          `Showing ${located} of ${institutions.length} institutions ` +
            `(${missing} have no coordinates). See browser console for the list.`
        );
      } else {
        hideStatus();
      }
    })
    .catch((err) => {
      console.error(err);
      showStatus(err.message, true);
    });
}

setupSidebarToggle();
loadData();
