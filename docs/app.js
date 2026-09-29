// NBA League Pass blackout map. Data: data/blackouts.json, built by scripts/build_site_data.py.
(async function () {
  // theme: "auto" follows the system setting; Light/Dark are saved per browser
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  let theme = "auto";
  try { theme = localStorage.getItem("theme") || "auto"; } catch (e) {}
  if (!["auto", "light", "dark"].includes(theme)) theme = "auto";
  const isDark = () => (theme === "auto" ? systemDark.matches : theme === "dark");
  let dark = isDark();
  const basemap = () => `https://basemaps.cartocdn.com/gl/${dark ? "dark-matter" : "positron"}-gl-style/style.json`;
  const map = new maplibregl.Map({
    container: "map",
    style: basemap(),
    bounds: [[-125, 24], [-66.5, 49.5]],
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // listen before awaiting the data, or a fast basemap can fire "load" before we're listening
  const mapLoaded = new Promise((resolve) => map.once("load", resolve));

  const data = await (await fetch("data/blackouts.json")).json();
  const teams = data.teams;
  document.getElementById("updated").textContent = data.updated;
  if (data.population_source) document.getElementById("pop-source").textContent = ` (${data.population_source})`;

  // A ZIP blacked out for several teams is drawn as a pie with one equal slice per team, turned so
  // each slice faces its team's arena. Slices keep the arenas' order around the ZIP; the pie's
  // rotation is the circular mean of how far each slice would have to turn to face its arena.
  // Bearings are on the Web Mercator map, so they match what's on screen. Returns the slice order
  // (pk, clockwise from the top of the unrotated image) and the rotation in degrees (r).
  // arena pairs so close that bearings to them swing wildly between neighboring ZIPs: split these
  // two-team pies straight north/south instead, with the northern arena's team on top
  const NORTH_SOUTH = { "BKN,NYK": "NYK", "LAC,LAL": "LAL" };
  function pie(lat, lon, idxs) {
    const key = idxs.map((i) => teams[i].abbr).sort().join(",");
    if (NORTH_SOUTH[key]) {
      // slice 0 (the first team in pk) sits at the top before rotation; turning 180° puts it at the bottom
      return { pk: key, r: key.startsWith(NORTH_SOUTH[key]) ? 0 : 180 };
    }
    const merc = (la) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
    const y0 = merc(lat);
    const byBearing = idxs.map((i) => {
      const t = teams[i];
      const b = (Math.atan2(((t.lon - lon) * Math.PI) / 180, merc(t.lat) - y0) * 180) / Math.PI;
      return { abbr: t.abbr, b: (b + 360) % 360 };
    }).sort((a, b) => a.b - b.b);
    // start the order at the alphabetically first team, so a set of teams needs few distinct images
    const first = byBearing.reduce((m, x, k) => (x.abbr < byBearing[m].abbr ? k : m), 0);
    const order = [...byBearing.slice(first), ...byBearing.slice(0, first)];
    const w = 360 / order.length;
    let sx = 0, sy = 0;
    order.forEach((x, k) => {
      const a = ((x.b - k * w) * Math.PI) / 180;
      sx += Math.sin(a); sy += Math.cos(a);
    });
    return { pk: order.map((x) => x.abbr).join(","), r: Math.round((Math.atan2(sx, sy) * 180) / Math.PI) };
  }

  // ZIP lookup + per-team counts. t is "|BOS|NYK|" so map filters can match with a substring test.
  const byZip = new Map();
  const counts = teams.map(() => 0);
  const features = data.zips.map(([zip, lat, lon, idxs, place, pop, drives]) => {
    byZip.set(zip, { lat, lon, idxs, place, pop, drives });
    if (idxs) idxs.forEach((i) => counts[i]++);
    const abbrs = idxs ? idxs.map((i) => teams[i].abbr) : [];
    const props = { z: zip, t: `|${abbrs.join("|")}|`, nd: idxs === null, n: idxs ? idxs.length : -1, p: pop ?? -1 };
    if (idxs && idxs.length >= 2) Object.assign(props, pie(lat, lon, idxs));
    return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props };
  });
  const looked = data.zips.filter((z) => z[3] !== null).length;
  const poOnly = new Set(data.po_only || []);

  // ---- state (mirrored to the URL hash so views can be shared) ----
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get("teams");
  let selected = new Set(
    fromHash === null ? teams.map((t) => t.abbr) : fromHash.split(",").filter((a) => teams.some((t) => t.abbr === a))
  );
  const showOther = document.getElementById("show-other");
  const rings = document.getElementById("rings");
  const sizePop = document.getElementById("size-pop");
  const popLo = document.getElementById("pop-lo");
  const popHi = document.getElementById("pop-hi");
  // population slider stops; the last position means "no upper limit"
  const POP_STOPS = [0, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  const TOP = POP_STOPS.length;
  let mode = ["any", "one", "multiple", "none"].includes(params.get("blackouts")) ? params.get("blackouts") : "any";
  document.querySelector(`#count input[value="${mode}"]`).checked = true;
  if (params.get("other") === "1") showOther.checked = true;
  if (params.get("rings") === "0") rings.checked = false;
  if (params.get("size") === "0") sizePop.checked = false;
  const popParam = (params.get("pop") || "").match(/^(\d+)-(\d*)$/);
  if (popParam) {
    const lo = POP_STOPS.indexOf(+popParam[1]);
    const hi = popParam[2] === "" ? TOP : POP_STOPS.indexOf(+popParam[2]);
    if (lo >= 0 && hi > lo) { popLo.value = lo; popHi.value = hi; }
  }
  // older data files have no population; the range filter can't apply then
  if (!data.population_source) {
    popLo.value = 0; popHi.value = TOP;
    popLo.disabled = popHi.disabled = true;
    document.querySelector(".range").classList.add("disabled");
  }
  const popRange = () => [POP_STOPS[+popLo.value], +popHi.value === TOP ? Infinity : POP_STOPS[+popHi.value]];
  const popFull = () => +popLo.value === 0 && +popHi.value === TOP;

  function writeHash(zip) {
    const p = new URLSearchParams();
    if (selected.size !== teams.length) p.set("teams", [...selected].join(","));
    if (mode !== "any") p.set("blackouts", mode);
    if (!popFull()) {
      const [lo, hi] = popRange();
      p.set("pop", `${lo}-${hi === Infinity ? "" : hi}`);
    }
    if (!rings.checked) p.set("rings", "0");
    if (!sizePop.checked) p.set("size", "0");
    if (showOther.checked) p.set("other", "1");
    if (zip) p.set("zip", zip);
    const h = p.toString().replace(/%2C/g, ",");
    history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
  }

  // ---- team list ----
  const list = document.getElementById("teams");
  const order = teams.map((_, i) => i).sort((a, b) => teams[a].city.localeCompare(teams[b].city));
  for (const i of order) {
    const t = teams[i];
    const li = document.createElement("li");
    li.innerHTML = `
      <label>
        <input type="checkbox" value="${t.abbr}">
        <span class="swatch" style="background:${t.color}"></span>
        <span class="name">${t.city} ${t.name}</span>
      </label>
      <span class="count" title="ZIP codes blacked out">${counts[i].toLocaleString()}</span>
      <button type="button" class="only" title="Show only this team">only</button>`;
    li.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? selected.add(t.abbr) : selected.delete(t.abbr);
      update();
    });
    li.querySelector(".only").addEventListener("click", () => solo(t.abbr));
    list.appendChild(li);
  }
  document.getElementById("all").onclick = () => { selected = new Set(teams.map((t) => t.abbr)); update(); };
  document.getElementById("none").onclick = () => { selected = new Set(); update(); };
  for (const el of [showOther, rings, sizePop]) el.onchange = update;
  for (const r of document.querySelectorAll("#count input")) r.onchange = () => { mode = r.value; update(); };
  for (const el of [popLo, popHi]) {
    el.oninput = () => {
      // keep the handles from crossing
      if (+popLo.value >= +popHi.value) (el === popLo ? (popLo.value = +popHi.value - 1) : (popHi.value = +popLo.value + 1));
      update();
    };
  }

  function solo(abbr) {
    selected = new Set([abbr]);
    update();
  }

  // arena marker clicks: from the all-teams view, show just that team; after that each click
  // adds or removes one team, so several can be picked (or dropped) on the map
  function toggleTeam(abbr) {
    if (selected.size === teams.length) return solo(abbr);
    selected.has(abbr) ? selected.delete(abbr) : selected.add(abbr);
    update();
  }

  // ---- map styling from the filters ----
  const NONE_COLOR = "#2a9d8f";
  const GRAY = () => (dark ? "#4a4a46" : "#d2d2cc");
  const OUTLINE = () => (dark ? "#9a9a94" : "#5f5f58"); // darker outline on blacked-out dots
  const RING = () => (dark ? "#f0f0ec" : "#1c1c1c");
  const COUNT_TEST = { any: (n) => n >= 1, one: (n) => n === 1, multiple: (n) => n >= 2, none: (n) => n === 0 };
  const COUNT_EXPR = {
    any: [">=", ["get", "n"], 1], one: ["==", ["get", "n"], 1],
    multiple: [">=", ["get", "n"], 2], none: ["==", ["get", "n"], 0],
  };
  const has = (abbr) => ["in", `|${abbr}|`, ["get", "t"]];

  function expressions() {
    const sel = teams.filter((t) => selected.has(t.abbr));
    const matches = ["+", 0, 0, ...sel.map((t) => ["case", has(t.abbr), 1, 0])];
    const [lo, hi] = popRange();
    const popCond = popFull() ? true
      : ["all", [">=", ["get", "p"], lo], ...(hi === Infinity ? [] : [["<=", ["get", "p"], hi]])];
    const hit = mode === "none"
      ? ["all", COUNT_EXPR.none, popCond]
      : ["all", [">", matches, 0], COUNT_EXPR[mode], popCond];
    const teamColor = sel.length ? ["case", ...sel.flatMap((t) => [has(t.abbr), t.color]), "#888"] : "#888";
    // like the Tableau viz, only single-team ZIPs take a team color; a ZIP blacked out for two or
    // more teams is gray (outlined) even when one of them is selected
    // pies cover 2+ team ZIPs; their circle underneath only draws the outline
    const color = mode === "none" ? NONE_COLOR : ["case", [">=", ["get", "n"], 2], "rgba(0,0,0,0)", teamColor];
    return { hit, other: ["all", ["!", hit], popCond], color };
  }

  // circle radius: zoom must be the top-level input, so each stop scales by population instead
  function radius(k) {
    const f = sizePop.checked
      ? ["max", 0.55, ["min", 2.6, ["*", 0.009, ["sqrt", ["max", 0, ["get", "p"]]]]]]
      : 1;
    const g = sizePop.checked ? 1.5 : 1; // population sizing shrinks most dots, so start larger
    return ["interpolate", ["linear"], ["zoom"],
      3, ["*", 1.6 * k * g, f], 6, ["*", 3 * k * g, f], 10, ["*", 6 * k * g, f], 13, ["*", 9 * k * g, f]];
  }

  function matching() {
    const [lo, hi] = popRange();
    let n = 0, people = 0;
    for (const z of byZip.values()) {
      if (!z.idxs || !COUNT_TEST[mode](z.idxs.length)) continue;
      if (mode !== "none" && !z.idxs.some((i) => selected.has(teams[i].abbr))) continue;
      if (!popFull() && (z.pop == null || z.pop < lo || z.pop > hi)) continue;
      n++;
      people += z.pop || 0;
    }
    return { n, people };
  }

  function update() {
    for (const cb of list.querySelectorAll("input")) cb.checked = selected.has(cb.value);
    document.getElementById("team-section").classList.toggle("disabled", mode === "none");

    const [lo, hi] = popRange();
    const fmt = (v) => v.toLocaleString();
    document.getElementById("pop-label").textContent = !data.population_source ? "Population data isn't loaded yet"
      : popFull() ? "Any population"
      : hi === Infinity ? `${fmt(lo)}+ people` : `${fmt(lo)} – ${fmt(hi)} people`;
    const fill = document.querySelector(".range-fill");
    fill.style.left = `${(popLo.value / TOP) * 100}%`;
    fill.style.right = `${100 - (popHi.value / TOP) * 100}%`;

    if (map.getLayer("zips-hit")) {
      const { hit, other, color } = expressions();
      map.setFilter("zips-hit", hit);
      map.setPaintProperty("zips-hit", "circle-color", color);
      // every dot in the filter gets the darker outline
      map.setPaintProperty("zips-hit", "circle-stroke-color", OUTLINE());
      map.setPaintProperty("zips-hit", "circle-stroke-width", ["interpolate", ["linear"], ["zoom"], 3, 0.25, 7, 0.9]);
      map.setPaintProperty("zips-other", "circle-color", GRAY());
      map.setPaintProperty("rings", "line-color", RING());
      map.setPaintProperty("zips-hit", "circle-radius", radius(1));
      map.setFilter("zips-pie", mode === "none" ? false : ["all", hit, [">=", ["get", "n"], 2]]);
      map.setLayoutProperty("zips-pie", "icon-size", radius(1 / PIE_R));
      map.setFilter("zips-other", other);
      map.setPaintProperty("zips-other", "circle-radius", radius(0.8));
      map.setLayoutProperty("zips-other", "visibility", showOther.checked ? "visible" : "none");
      // rings for the selected teams; every arena's when there's no selection to follow (no teams, or "None")
      const ringTeams = mode === "none" || !selected.size ? teams.map((t) => t.abbr) : [...selected];
      map.setFilter("rings", ["in", ["get", "abbr"], ["literal", ringTeams]]);
      map.setLayoutProperty("rings", "visibility", rings.checked ? "visible" : "none");
    }
    for (const [abbr, el] of markers) el.style.opacity = mode === "none" || selected.has(abbr) ? 1 : 0.35;

    const { n, people } = matching();
    // older data files lack lookup_remaining; fall back to counting ZIPs without data
    const remaining = data.lookup_remaining ?? data.zips.length - looked;
    const coverage = remaining > 0
      ? ` Lookup in progress: ${(data.zips.length - remaining).toLocaleString()} of ${data.zips.length.toLocaleString()} ZIPs checked so far.`
      : "";
    const all = selected.size === teams.length, k = selected.size;
    const single = k === 1 ? `the ${teams.find((t) => selected.has(t.abbr)).name}` : null;
    const what = {
      any: all ? "blacked out for any team" : single ? `blacked out for ${single}` : `blacked out for any of the ${k} selected teams`,
      one: all ? "blacked out for exactly one team" : single ? `blacked out only for ${single}`
        : `blacked out for exactly one team, one of the ${k} selected`,
      multiple: all ? "blacked out for two or more teams" : single ? `blacked out for ${single} and at least one other team`
        : `blacked out for two or more teams, including one of the ${k} selected`,
      none: "with no local blackouts",
    }[mode];
    const pop = people ? ` (${people.toLocaleString()} people)` : "";
    document.getElementById("summary").textContent = mode !== "none" && !selected.size
      ? `Select a team to see its blackout area.${coverage}`
      : `${n.toLocaleString()} ZIPs ${what}${pop}.${coverage}`;
    writeHash();
  }

  // ---- arena markers ----
  const markers = new Map();
  teams.forEach((t) => {
    const el = document.createElement("div");
    el.className = "arena";
    el.style.background = t.color;
    el.textContent = t.abbr;
    el.title = `${t.city} ${t.name} — ${t.arena}. Click to add or remove this team.`;
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleTeam(t.abbr); });
    markers.set(t.abbr, el);
    new maplibregl.Marker({ element: el }).setLngLat([t.lon, t.lat]).addTo(map);
  });
  update(); // fill the sidebar now; map layers pick up the selection on load

  // ---- popups ----
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "320px" });
  const STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
    LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
    NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
    OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    PR: "Puerto Rico", VI: "U.S. Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
  };
  // great-circle distance in miles
  function miles(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
  }
  const duration = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`);
  const row = (label, value) => `<div><span class="label">${label}:</span> ${value}</div>`;

  // z: a map ZIP's record, or one built for a search-only ZIP; note: extra lines under the title
  function describe(zip, z = byZip.get(zip), note = postCensusNote(zip)) {
    let title = `ZIP ${zip}`;
    if (z.place) {
      const cut = z.place.lastIndexOf(", ");
      const st = z.place.slice(cut + 2);
      title = `${z.place.slice(0, cut)}, ${STATES[st] || st} (${zip})`;
    }
    const blackout = z.idxs === undefined ? "Not looked up yet"
      : !z.idxs ? "No data from NBA.com"
      : z.idxs.length ? z.idxs.map((i) => teams[i].name).join("/")
      : "None";
    const crow = (t) => Math.round(miles(z.lat, z.lon, t.lat, t.lon)).toLocaleString();
    // teams blacked out here keep the dark text; the rest are in the lighter label color
    // (all dark when there's no blackout data to go by)
    const out = (i) => Array.isArray(z.idxs) && !z.idxs.includes(i);
    const line = (i, text) => `<div${out(i) ? ' class="label"' : ""}>${text}</div>`;
    let closest, heading = "Closest Teams";
    if (z.drives && z.drives.length) {
      // miles by road when the data has them; older rows only have drive time
      closest = z.drives.map(([i, m, mi]) => line(i, `${teams[i].name}: ${duration(m)} (${
        mi != null ? `${mi.toLocaleString()} mi` : `${crow(teams[i])} mi straight line`})`));
    } else {
      heading += ' <span class="label">(straight line)</span>';
      closest = teams
        .map((t, i) => ({ t, i, d: miles(z.lat, z.lon, t.lat, t.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map(({ t, i }) => line(i, `${t.name}: ${crow(t)} Miles`));
    }
    return `<div class="title">${title}</div>` + note +
      (z.noPop ? "" : row("ZIP Population", z.pop == null ? "—"
        : z.pop === 0 && poOnly.has(zip) ? "0 (PO Boxes Only)" : z.pop.toLocaleString())) +
      row("Blackout Team(s)", blackout) +
      `<div class="title closest">${heading}</div>${closest.join("")}`;
  }
  function postCensusNote(zip) {
    if (!data.post_census || !(zip in data.post_census)) return "";
    const name = data.post_census[zip];
    return (name ? `<div>${name}</div>` : "") +
      '<div class="label">USPS ZIP newer than the 2020 Census.</div>';
  }

  // USPS ZIPs with no area of their own (PO boxes, single organizations, ...), loaded on first use
  let extraZips;
  const EXTRA_KIND = {
    "PO boxes": (po) => `PO boxes at the ${po} post office`,
    organization: () => "Single-organization ZIP",
    "organization (unnamed)": () => "Single-organization ZIP",
    "business reply mail": () => "Business reply mail ZIP",
    "delivery area": () => "USPS delivery ZIP newer than the 2020 Census",
  };
  async function searchExtra(zip) {
    if (extraZips === undefined) {
      try { extraZips = await (await fetch("data/extra_zips.json")).json(); } catch { extraZips = {}; }
    }
    const e = extraZips[zip];
    const parent = e && byZip.get(e[4]);
    if (!e || !parent) return false;
    const [kind, names, po, st, parentZip, t] = e;
    const idxs = t === null ? undefined : t === -1 ? null : t;
    const z = { lat: parent.lat, lon: parent.lon, idxs, place: `${po}, ${st}`, noPop: true, drives: parent.drives };
    const note = (names ? `<div>${names}</div>` : "") +
      `<div class="label">${(EXTRA_KIND[kind] || (() => "USPS ZIP with no Census area of its own"))(po)}, ` +
      `within ZIP ${parentZip}'s area (shown at its point).</div>`;
    result.textContent = idxs === undefined ? `${zip}: blackouts not looked up yet.`
      : !idxs ? `${zip} isn't recognized by NBA.com.`
      : idxs.length ? `Blacked out: ${idxs.map((i) => teams[i].name).join(", ")}` : "No local blackouts.";
    map.flyTo({ center: [z.lon, z.lat], zoom: 9 });
    popup.setLngLat([z.lon, z.lat]).setHTML(describe(zip, z, note)).addTo(map);
    writeHash(zip);
    return true;
  }

  function showZip(zip) {
    const z = byZip.get(zip);
    popup.setLngLat([z.lon, z.lat]).setHTML(describe(zip)).addTo(map);
  }

  const result = document.getElementById("search-result");
  async function search(zip, fly = true) {
    const z = byZip.get(zip);
    if (!z) {
      popup.remove();
      const st = data.hidden && data.hidden[zip];
      if (st) {
        result.textContent = `${STATES[st] || st} isn't shown on the map: none of its ZIPs has a local blackout (see Notes).`;
      } else if (!(await searchExtra(zip))) {
        result.textContent = `${zip} isn't a USPS ZIP code we know of.`;
      }
      return;
    }
    result.textContent = !z.idxs ? "No data for this ZIP."
      : z.idxs.length ? `Blacked out: ${z.idxs.map((i) => teams[i].name).join(", ")}`
      : "No local blackouts.";
    if (fly) map.flyTo({ center: [z.lon, z.lat], zoom: 9 });
    showZip(zip);
    writeHash(zip);
  }
  document.getElementById("search").addEventListener("submit", (e) => {
    e.preventDefault();
    const zip = document.getElementById("zip").value.trim();
    if (/^\d{5}$/.test(zip)) search(zip);
    else result.textContent = "Enter a 5-digit ZIP code.";
  });

  // 75-mile circle around an arena, as a geodesic ring
  function ring(t, radiusMiles = 75, steps = 96) {
    const r = Math.PI / 180, d = radiusMiles / 3958.8;
    const lat1 = t.lat * r, lon1 = t.lon * r;
    const coords = [];
    for (let i = 0; i <= steps; i++) {
      const b = (2 * Math.PI * i) / steps;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
      const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
      coords.push([lon2 / r, lat2 / r]);
    }
    return { type: "Feature", properties: { abbr: t.abbr, color: t.color }, geometry: { type: "LineString", coordinates: coords } };
  }

  // pie image, PIE_R px in radius: slice k is centered k slices clockwise from the top
  const PIE_R = 24;
  function pieImage(colors) {
    const size = PIE_R * 4; // drawn at 2x for sharp edges
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const w = (2 * Math.PI) / colors.length;
    colors.forEach((color, k) => {
      const mid = k * w - Math.PI / 2; // canvas angles start at 3 o'clock
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2);
      ctx.arc(size / 2, size / 2, size / 2, mid - w / 2, mid + w / 2);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    });
    return ctx.getImageData(0, 0, size, size);
  }

  // info popovers close on a click anywhere else
  document.addEventListener("click", (e) => {
    for (const d of document.querySelectorAll("details.info[open]")) if (!d.contains(e.target)) d.open = false;
  });

  // ---- theme switch ----
  function setupTheme() {
    const OURS = new Set(["zips", "rings"]);
    function apply() {
      if (theme === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      if (isDark() === dark) return;
      dark = isDark();
      // swap the basemap, carrying our sources and layers over to the new style
      map.setStyle(basemap(), {
        diff: false, // a full reload, so "style.load" fires and update() can restyle for the theme
        transformStyle: (prev, next) => ({
          ...next,
          sources: { ...next.sources, ...Object.fromEntries(Object.entries(prev.sources).filter(([id]) => OURS.has(id))) },
          layers: [...next.layers, ...prev.layers.filter((l) => OURS.has(l.source))],
        }),
      });
      map.once("style.load", update);
    }
    for (const r of document.querySelectorAll("#theme input")) {
      r.checked = r.value === theme;
      r.onchange = () => {
        theme = r.value;
        try { theme === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", theme); } catch (e) {}
        apply();
      };
    }
    systemDark.addEventListener("change", () => theme === "auto" && apply());
  }

  // ---- layers ----
  mapLoaded.then(() => {
    map.addSource("zips", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({
      id: "zips-other",
      type: "circle",
      source: "zips",
      paint: {
        "circle-radius": radius(0.8),
        // ZIPs outside the filter: plain gray, no outline
        "circle-color": GRAY(),
        "circle-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "zips-hit",
      type: "circle",
      source: "zips",
      paint: {
        "circle-radius": radius(1),
        "circle-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "zips-pie",
      type: "symbol",
      source: "zips",
      layout: {
        "icon-image": ["concat", "pie|", ["get", "pk"]],
        "icon-rotate": ["get", "r"],
        "icon-rotation-alignment": "map", // stays aimed at the arenas if the map is rotated
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": 0.85 },
    });
    map.on("styleimagemissing", (e) => {
      const [kind, pk] = e.id.split("|");
      if (kind !== "pie" || map.hasImage(e.id)) return;
      const colors = pk.split(",").map((a) => teams.find((t) => t.abbr === a).color);
      map.addImage(e.id, pieImage(colors), { pixelRatio: 2 });
    });
    map.addSource("rings", { type: "geojson", data: { type: "FeatureCollection", features: teams.map((t) => ring(t)) } });
    map.addLayer({
      id: "rings",
      type: "line",
      source: "rings",
      // neutral like the Tableau viz; a team-colored ring disappears into that team's dots
      paint: { "line-color": RING(), "line-width": 1.6, "line-opacity": 0.9 },
    });
    for (const layer of ["zips-hit", "zips-other"]) {
      map.on("click", layer, (e) => showZip(e.features[0].properties.z));
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    update();
    setupTheme();
    const zip = params.get("zip");
    if (zip && /^\d{5}$/.test(zip)) {
      document.getElementById("zip").value = zip;
      search(zip);
    }
  });
})();
