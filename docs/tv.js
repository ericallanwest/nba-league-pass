// TV Schedule panel: each team's 82 games split into live on League Pass vs blacked out, for a viewer
// outside every team's local area or, once a ZIP is picked on the map, for that ZIP. Data:
// data/schedule.json, built by scripts/fetch_schedule.py. The map (app.js) drives it through window.TV.
window.TV = (function () {
  const GAMES = 82;
  // one category per game, in bar order; a game on several networks goes to the first that matches.
  // National networks come before the local blackout, so their counts don't change with the ZIP.
  const CATS = [
    { key: "lp", label: "League Pass", live: true },
    { key: "nbatv", label: "NBA TV", live: true },
    { key: "local", label: "Local blackout" },
    { key: "abc", label: "ABC", nets: ["ABC"] },
    { key: "espn", label: "ESPN", nets: ["ESPN"] },
    { key: "nbc", label: "NBC", nets: ["NBC"] },
    { key: "peacock", label: "Peacock", nets: ["Peacock", "NBCSN", "Telemundo"] },
    { key: "prime", label: "Prime Video", nets: ["Prime Video"] },
    { key: "tbd", label: "Not yet scheduled" },
  ];
  const NATIONAL = CATS.filter((c) => c.nets);
  const IS_LIVE = Object.fromEntries(CATS.map((c) => [c.key, !!c.live]));

  let data, rows = [], els = new Map();
  let team = null; // team whose games are listed
  let zip = null; // { zip, name, local: [abbr] | null } from the map, or null for "outside every local area"
  let sortBy = "national";
  let hooks = { change() {}, showOnMap() {}, clearZip() {} };

  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const local = () => (zip && zip.local ? zip.local : []);

  function category(away, home, nat) {
    for (const c of NATIONAL) if (nat.some((n) => c.nets.includes(n))) return c.key;
    if (local().includes(away) || local().includes(home)) return "local";
    return nat.includes("NBA TV") ? "nbatv" : "lp";
  }

  function tally() {
    const counts = {};
    for (const t in data.teams) counts[t] = Object.fromEntries(CATS.map((c) => [c.key, 0]));
    for (const [, , , away, home, nat] of data.games) {
      const cat = category(away, home, nat);
      for (const t of [away, home]) if (t in counts) counts[t][cat]++;
    }
    rows = Object.entries(counts).map(([abbr, c]) => {
      const played = CATS.reduce((s, k) => s + c[k.key], 0);
      c.tbd = Math.max(0, GAMES - played);
      return {
        abbr, team: data.teams[abbr], c, live: c.lp + c.nbatv,
        national: NATIONAL.reduce((s, k) => s + c[k.key], 0), blackout: GAMES - c.tbd - c.lp - c.nbatv,
      };
    });
  }

  function renderLegend() {
    const legend = $("legend");
    legend.innerHTML = "";
    for (const cat of CATS) {
      if (cat.key === "tbd" && !rows.some((r) => r.c.tbd)) continue;
      if (cat.key === "local" && !local().length) continue;
      legend.insertAdjacentHTML("beforeend", `<li><span class="sw seg-${cat.key}"></span>${cat.label}</li>`);
      if (cat.key === "nbatv") legend.insertAdjacentHTML("beforeend", '<li class="sep" aria-hidden="true"></li>');
    }
  }

  function renderChart() {
    const chart = $("chart");
    for (const el of els.values()) el.remove();
    els = new Map();
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "chart-row";
      row.setAttribute("role", "row");
      row.style.setProperty("--team", r.team.color);
      const bar = CATS.filter((cat) => r.c[cat.key]).map((cat) => {
        const n = r.c[cat.key];
        const what = cat.key === "lp" ? "live on League Pass" : cat.key === "nbatv" ? "live on NBA TV (and League Pass)"
          : cat.key === "tbd" ? "NBA Cup week, not yet scheduled"
          : cat.key === "local" ? `blacked out locally in ${zip.zip}` : `on ${cat.label}, blacked out`;
        return `<span class="seg seg-${cat.key}${n < 5 ? " small" : ""}" style="flex:${n}" data-tip="${esc(`${r.team.city} ${r.team.name}: ${n} game${n === 1 ? "" : "s"} ${what}`)}">${n >= 3 ? n : ""}</span>`;
      }).join("");
      row.innerHTML = `
        <button type="button" class="team" role="cell" title="${esc(`${r.team.city} ${r.team.name}: game by game`)}"><span class="abbr">${r.abbr}</span></button>
        <span class="bar" role="cell" aria-label="${r.live} live, ${r.blackout} blacked out${r.c.tbd ? `, ${r.c.tbd} not yet scheduled` : ""}">${bar}</span>
        <span class="num" role="cell"><b>${r.live}</b></span>`;
      row.addEventListener("click", () => show(r.abbr, true));
      els.set(r.abbr, row);
      chart.append(row);
    }
    sort();
    for (const [a, el] of els) el.classList.toggle("sel", a === team);
  }

  function sort() {
    const key = zip ? "blackout" : "national";
    const sorted = [...rows].sort(sortBy === "team"
      ? (a, b) => (a.team.city + a.team.name).localeCompare(b.team.city + b.team.name)
      : (a, b) => (sortBy === "national" ? b[key] - a[key] || a.live - b.live : a[key] - b[key] || b.live - a.live) || a.abbr.localeCompare(b.abbr));
    for (const r of sorted) $("chart").append(els.get(r.abbr));
  }

  function renderContext() {
    const ctx = $("tv-context");
    if (!zip) {
      ctx.innerHTML = "For a viewer outside every team's local area. <span class=\"muted\">Pick a ZIP on the map to add its local blackouts.</span>";
      $("league").textContent = summaryLine();
      return;
    }
    const where = `${esc(zip.name)}`;
    const note = zip.local === null ? " NBA.com has no local blackout data for this ZIP."
      : zip.local.length ? ` Local blackouts: ${zip.local.map((a) => data.teams[a].name).join(", ")}.` : " No local blackouts.";
    ctx.innerHTML = `Live from <b>${where}</b>.${note} <button type="button" class="link" id="tv-clear-zip">Clear ZIP</button>`;
    $("tv-clear-zip").onclick = () => { setZip(null); hooks.clearZip(); };
    $("league").textContent = summaryLine();
  }

  function summaryLine() {
    let national = 0, scheduled = 0;
    for (const [, , , away, home, nat] of data.games) {
      if (!(away in data.teams && home in data.teams)) continue;
      scheduled++;
      if (NATIONAL.some((c) => nat.some((n) => c.nets.includes(n)))) national++;
    }
    const hi = Math.max(...rows.map((r) => r.national)), lo = Math.min(...rows.map((r) => r.national));
    const who = (n) => rows.filter((r) => r.national === n).map((r) => r.abbr).sort().join(", ");
    return `${data.season}: ${national} of ${scheduled.toLocaleString()} scheduled games are on national TV, ` +
      `from ${lo} per team (${who(lo)}) to ${hi} (${who(hi)}).`;
  }

  // ---- game-by-game table ----
  const WD = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  const MD = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fmtDate = (d) => {
    const day = new Date(`${d}T12:00:00Z`);
    return `<span class="wd">${WD.format(day)}, </span>${MD.format(day)}`;
  };
  const fmtTime = (t) => {
    if (!t) return "TBD";
    const [h, m] = t.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  };
  const tag = (label) => label.replace(/^(Emirates|AWS) /, "").replace(/ (East|West) Group [A-C]$/, "");

  function renderGames() {
    const r = rows.find((x) => x.abbr === team);
    for (const [a, el] of els) el.classList.toggle("sel", a === team);
    $("team-pick").value = r ? team : "";
    $("games-body").hidden = !r;
    $("games-title").textContent = r ? `${r.team.city} ${r.team.name}` : "Game by game";
    $("show-on-map").hidden = !r;
    const sum = $("games-sum");
    if (!r) {
      sum.textContent = "Click a team in the chart, or choose one here, to see which of its games are blacked out.";
      return;
    }
    $("games").style.setProperty("--team", r.team.color);
    sum.innerHTML = `<b>${r.live}</b> live on League Pass` +
      (r.c.local ? `, <b>${r.c.local}</b> blacked out locally` : "") +
      `, <b>${r.national}</b> on national TV` +
      (r.c.tbd ? `, ${r.c.tbd} NBA Cup game${r.c.tbd === 1 ? "" : "s"} not yet scheduled` : "") + ".";
    $("games-table").querySelector("tbody").innerHTML = data.games.filter((g) => g[3] === team || g[4] === team)
      .map(([, date, time, away, home, nat, label]) => {
        const atHome = home === team, opp = atHome ? away : home, o = data.teams[opp];
        const cat = category(away, home, nat);
        const out = !IS_LIVE[cat];
        const status = cat === "local"
          ? `<span class="st st-out">Local blackout</span> <span class="net">${esc([away, home].filter((a) => local().includes(a)).map((a) => data.teams[a].name).join(" / "))}</span>`
          : out
          ? `<span class="st st-out">Blacked out</span> <span class="net">${esc(nat.filter((n) => n !== "NBA TV" && n !== "Telemundo").join(" / "))}</span>`
          : `<span class="st st-live">Live</span>${cat === "nbatv" ? ' <span class="net">(also on NBA TV)</span>' : ""}`;
        return `<tr class="${out ? "out" : "live"}">
          <td class="date">${fmtDate(date)}</td>
          <td class="opp">${atHome ? "vs" : "@"} <b>${opp}</b>${label ? ` <span class="tag">${esc(tag(label))}</span>` : ""}</td>
          <td class="time">${fmtTime(time)}</td>
          <td class="status">${status}</td></tr>`;
      }).join("");
    $("games-table").classList.toggle("only-out", $("only-out").checked);
  }

  function render() {
    tally();
    renderLegend();
    renderChart();
    renderContext();
    renderGames();
  }

  // ---- public ----
  function show(abbr, scroll) {
    team = abbr && data && abbr in data.teams ? abbr : null;
    if (!data) return;
    renderGames();
    hooks.change(team);
    if (scroll && team) $("games").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function setZip(z) {
    zip = z;
    if (data) render();
  }

  async function init(opts) {
    hooks = { ...hooks, ...opts };
    team = opts.team || null;
    data = await (await fetch("data/schedule.json")).json();
    if (team && !(team in data.teams)) team = null;
    const pick = $("team-pick");
    for (const [abbr, t] of Object.entries(data.teams).sort((a, b) => (a[1].city + a[1].name).localeCompare(b[1].city + b[1].name))) {
      pick.add(new Option(`${t.city} ${t.name}`, abbr));
    }
    pick.addEventListener("change", () => show(pick.value, false));
    $("only-out").addEventListener("change", () => $("games-table").classList.toggle("only-out", $("only-out").checked));
    $("show-on-map").addEventListener("click", () => team && hooks.showOnMap(team));
    for (const input of document.querySelectorAll("#sort input")) {
      input.addEventListener("change", () => { sortBy = input.value; sort(); });
    }
    render();

    // tooltip: hover on desktop, tap on touch
    const tip = $("tip"), chart = $("chart");
    function tipAt(e) {
      const seg = e.target.closest(".seg");
      if (!seg) { tip.hidden = true; return; }
      tip.textContent = seg.dataset.tip;
      tip.hidden = false;
      const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${e.clientY + 14}px`;
    }
    chart.addEventListener("pointermove", tipAt);
    chart.addEventListener("pointerdown", tipAt);
    chart.addEventListener("pointerleave", () => (tip.hidden = true));
    $("tv").addEventListener("scroll", () => (tip.hidden = true), { passive: true });
  }

  return { init, show, setZip, get team() { return team; } };
})();
