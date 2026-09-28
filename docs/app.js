// NBA League Pass blackout map. Data: data/blackouts.json, built by scripts/build_site_data.py.
(async function () {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = new maplibregl.Map({
    container: "map",
    style: `https://basemaps.cartocdn.com/gl/${dark ? "dark-matter" : "positron"}-gl-style/style.json`,
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

  // ZIP lookup + per-team counts. t is "|BOS|NYK|" so map filters can match with a substring test.
  const byZip = new Map();
  const counts = teams.map(() => 0);
  const features = data.zips.map(([zip, lat, lon, idxs, place, pop, drives]) => {
    byZip.set(zip, { lat, lon, idxs, place, pop, drives });
    if (idxs) idxs.forEach((i) => counts[i]++);
    const abbrs = idxs ? idxs.map((i) => teams[i].abbr) : [];
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { z: zip, t: `|${abbrs.join("|")}|`, nd: idxs === null, n: idxs ? idxs.length : -1, p: pop ?? -1 },
    };
  });
  const looked = data.zips.filter((z) => z[3] !== null).length;

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
  if (params.get("other") === "0") showOther.checked = false;
  if (params.get("rings") === "0") rings.checked = false;
  if (params.get("size") === "0") sizePop.checked = false;
  const popParam = (params.get("pop") || "").match(/^(\d+)-(\d*)$/);
  if (popParam) {
    const lo = POP_STOPS.indexOf(+popParam[1]);
    const hi = popParam[2] === "" ? TOP : POP_STOPS.indexOf(+popParam[2]);
    if (lo >= 0 && hi > lo) { popLo.value = lo; popHi.value = hi; }
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
    if (!showOther.checked) p.set("other", "0");
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

  // ---- map styling from the filters ----
  const NONE_COLOR = "#2a9d8f";
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
    const color = mode === "none" ? NONE_COLOR
      : sel.length ? ["case", ...sel.flatMap((t) => [has(t.abbr), t.color]), "#888"] : "#888";
    return { hit, other: ["all", ["!", hit], popCond], color, matches };
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
    document.getElementById("pop-label").textContent = popFull() ? "Any population"
      : hi === Infinity ? `${fmt(lo)}+ people` : `${fmt(lo)} – ${fmt(hi)} people`;
    const fill = document.querySelector(".range-fill");
    fill.style.left = `${(popLo.value / TOP) * 100}%`;
    fill.style.right = `${100 - (popHi.value / TOP) * 100}%`;

    if (map.getLayer("zips-hit")) {
      const { hit, other, color, matches } = expressions();
      map.setFilter("zips-hit", hit);
      map.setPaintProperty("zips-hit", "circle-color", color);
      map.setPaintProperty("zips-hit", "circle-stroke-width", mode === "none" ? 0 : ["case", [">", matches, 1], 1.2, 0]);
      map.setPaintProperty("zips-hit", "circle-radius", radius(1));
      map.setFilter("zips-other", other);
      map.setPaintProperty("zips-other", "circle-radius", radius(0.8));
      map.setLayoutProperty("zips-other", "visibility", showOther.checked ? "visible" : "none");
      map.setFilter("rings", ["in", ["get", "abbr"], ["literal", [...selected]]]);
      map.setLayoutProperty("rings", "visibility", rings.checked && mode !== "none" ? "visible" : "none");
    }
    for (const [abbr, el] of markers) el.style.opacity = mode === "none" || selected.has(abbr) ? 1 : 0.35;

    const { n, people } = matching();
    const coverage = looked < data.zips.length
      ? ` Lookup in progress: ${looked.toLocaleString()} of ${data.zips.length.toLocaleString()} ZIPs checked so far.`
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
    el.title = `${t.city} ${t.name} — ${t.arena}. Click to show only this team.`;
    el.addEventListener("click", (e) => { e.stopPropagation(); solo(t.abbr); });
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

  function describe(zip) {
    const z = byZip.get(zip);
    let title = `ZIP ${zip}`;
    if (z.place) {
      const cut = z.place.lastIndexOf(", ");
      const st = z.place.slice(cut + 2);
      title = `${z.place.slice(0, cut)}, ${STATES[st] || st} (${zip})`;
    }
    const blackout = !z.idxs ? "No data from NBA.com"
      : z.idxs.length ? z.idxs.map((i) => teams[i].name).join("/")
      : "None";
    const mi = (t) => Math.round(miles(z.lat, z.lon, t.lat, t.lon)).toLocaleString();
    let closest, heading = "Closest Teams";
    if (z.drives && z.drives.length) {
      closest = z.drives.map(([i, m]) => `<div>${teams[i].name}: ${duration(m)} <span class="label">(${mi(teams[i])} mi)</span></div>`);
    } else {
      if (z.drives) heading += ' <span class="label">(straight line)</span>'; // computed, but no road route
      closest = teams
        .map((t) => ({ t, d: miles(z.lat, z.lon, t.lat, t.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map(({ t }) => `<div>${t.name}: ${mi(t)} Miles</div>`);
    }
    return `<div class="title">${title}</div>` +
      row("Population", z.pop != null ? z.pop.toLocaleString() : "—") +
      row("Blackout Team(s)", blackout) +
      `<div class="title closest">${heading}</div>${closest.join("")}`;
  }
  function showZip(zip) {
    const z = byZip.get(zip);
    popup.setLngLat([z.lon, z.lat]).setHTML(describe(zip)).addTo(map);
  }

  const result = document.getElementById("search-result");
  function search(zip, fly = true) {
    const z = byZip.get(zip);
    if (!z) {
      result.textContent = `${zip} isn't in the Census ZIP areas (it may be a PO-box-only ZIP).`;
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

  // ---- layers ----
  mapLoaded.then(() => {
    map.addSource("zips", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({
      id: "zips-other",
      type: "circle",
      source: "zips",
      paint: {
        "circle-radius": radius(0.8),
        "circle-color": ["case", ["get", "nd"], dark ? "#3a3a3a" : "#e2e2dc", dark ? "#5a5a55" : "#c4c4bc"],
        "circle-opacity": 0.8,
      },
    });
    map.addLayer({
      id: "zips-hit",
      type: "circle",
      source: "zips",
      paint: {
        "circle-radius": radius(1),
        "circle-opacity": 0.85,
        "circle-stroke-color": dark ? "#fff" : "#000",
      },
    });
    map.addSource("rings", { type: "geojson", data: { type: "FeatureCollection", features: teams.map((t) => ring(t)) } });
    map.addLayer({
      id: "rings",
      type: "line",
      source: "rings",
      paint: { "line-color": ["get", "color"], "line-width": 1.8, "line-opacity": 0.9 },
    });
    for (const layer of ["zips-hit", "zips-other"]) {
      map.on("click", layer, (e) => showZip(e.features[0].properties.z));
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    update();
    const zip = params.get("zip");
    if (zip && byZip.has(zip)) {
      document.getElementById("zip").value = zip;
      search(zip);
    }
  });
})();
