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
  const features = data.zips.map(([zip, lat, lon, idxs, place, pop]) => {
    byZip.set(zip, { lat, lon, idxs, place, pop });
    if (idxs) idxs.forEach((i) => counts[i]++);
    const abbrs = idxs ? idxs.map((i) => teams[i].abbr) : [];
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { z: zip, t: `|${abbrs.join("|")}|`, nd: idxs === null },
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
  if (params.get("other") === "0") showOther.checked = false;

  function writeHash(zip) {
    const p = new URLSearchParams();
    if (selected.size !== teams.length) p.set("teams", [...selected].join(","));
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
  showOther.onchange = update;

  function solo(abbr) {
    selected = new Set([abbr]);
    update();
  }

  // ---- map styling from the selection ----
  const has = (abbr) => ["in", `|${abbr}|`, ["get", "t"]];
  function expressions() {
    const sel = teams.filter((t) => selected.has(t.abbr));
    const color = sel.length ? ["case", ...sel.flatMap((t) => [has(t.abbr), t.color]), "#888"] : "#888";
    const matches = ["+", 0, 0, ...sel.map((t) => ["case", has(t.abbr), 1, 0])];
    return { color, matches };
  }

  function update() {
    for (const cb of list.querySelectorAll("input")) cb.checked = selected.has(cb.value);
    const { color, matches } = expressions();
    if (map.getLayer("zips-hit")) {
      map.setFilter("zips-hit", [">", matches, 0]);
      map.setPaintProperty("zips-hit", "circle-color", color);
      map.setPaintProperty("zips-hit", "circle-stroke-width", ["case", [">", matches, 1], 1.2, 0]);
      map.setFilter("zips-other", ["==", matches, 0]);
      map.setLayoutProperty("zips-other", "visibility", showOther.checked ? "visible" : "none");
    }
    for (const [abbr, el] of markers) el.style.opacity = selected.has(abbr) ? 1 : 0.35;

    let n = 0;
    for (const { idxs } of byZip.values()) if (idxs && idxs.some((i) => selected.has(teams[i].abbr))) n++;
    const coverage = looked < data.zips.length
      ? ` Lookup in progress: ${looked.toLocaleString()} of ${data.zips.length.toLocaleString()} ZIPs checked so far.`
      : "";
    document.getElementById("summary").textContent = selected.size
      ? `${n.toLocaleString()} ZIPs blacked out for ${selected.size === teams.length ? "any team" : `the ${selected.size} selected team${selected.size > 1 ? "s" : ""}`}.${coverage}`
      : `Select a team to see its blackout area.${coverage}`;
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
    const closest = teams
      .map((t) => ({ name: t.name, d: miles(z.lat, z.lon, t.lat, t.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map((t) => `<div>${t.name}: ${Math.round(t.d).toLocaleString()} Miles</div>`)
      .join("");
    return `<div class="title">${title}</div>` +
      row("Population", z.pop != null ? z.pop.toLocaleString() : "—") +
      row("Blackout Team(s)", blackout) +
      `<div class="title closest">Closest Teams</div>${closest}`;
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

  // ---- layers ----
  mapLoaded.then(() => {
    map.addSource("zips", { type: "geojson", data: { type: "FeatureCollection", features } });
    // zoom must be the top-level input, so scale the stop values rather than the expression
    const radius = (k) => ["interpolate", ["linear"], ["zoom"], 3, 1.6 * k, 6, 3 * k, 10, 6 * k, 13, 9 * k];
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
