// TV Schedule panel: the picked team's 82 games, as one bar (live on League Pass vs blacked out, by
// network) over a game-by-game table, for a viewer outside every team's local area or, once a ZIP is
// picked on the map, for that ZIP. Data:
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

  let data, rows = [];
  let team = null; // team whose games are listed
  let zip = null; // { zip, name, local: [abbr] | null } from the map, or null for "outside every local area"
  let hooks = { change() {}, clearZip() {} };

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

  // the categories in this team's bar, in bar order, with a divider between live and blacked out
  function renderLegend(r) {
    const cats = CATS.filter((cat) => r.c[cat.key]);
    $("legend").innerHTML = cats.map((cat, i) =>
      (i && cats[i - 1].live && !cat.live ? '<li class="sep" aria-hidden="true"></li>' : "") +
      `<li><span class="sw seg-${cat.key}"></span>${cat.label}</li>`).join("");
  }

  function renderBar(r) {
    const bar = $("team-bar");
    bar.style.setProperty("--team", r.team.color);
    bar.setAttribute("aria-label", `${r.live} of ${GAMES} games live on League Pass, ${r.blackout} blacked out` +
      (r.c.tbd ? `, ${r.c.tbd} not yet scheduled` : ""));
    bar.innerHTML = CATS.filter((cat) => r.c[cat.key]).map((cat) => {
      const n = r.c[cat.key];
      const what = cat.key === "lp" ? "live on League Pass" : cat.key === "nbatv" ? "live on NBA TV (and League Pass)"
        : cat.key === "tbd" ? "NBA Cup week, not yet scheduled"
        : cat.key === "local" ? `blacked out locally in ${zip.zip}` : `on ${cat.label}, blacked out`;
      return `<span class="seg seg-${cat.key}${n < 3 ? " small" : ""}" style="flex:${n}" data-tip="${esc(`${n} game${n === 1 ? "" : "s"} ${what}`)}">${n}</span>`;
    }).join("");
  }

  function renderContext() {
    const ctx = $("tv-context");
    if (!zip) {
      ctx.innerHTML = "For a viewer outside every team's local area. <span class=\"muted\">Pick a ZIP on the map to add its local blackouts.</span>";
      return;
    }
    const note = zip.local === null ? " NBA.com has no local blackout data for this ZIP."
      : zip.local.length ? ` Local blackouts: ${zip.local.map((a) => data.teams[a].name).join(", ")}.` : " No local blackouts.";
    ctx.innerHTML = `<b>${esc(zip.name)}</b>.${note} <button type="button" class="link" id="tv-clear-zip">Clear ZIP</button>`;
    $("tv-clear-zip").onclick = () => { setZip(null); hooks.clearZip(); };
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
    $("games").hidden = !r;
    $("games-none").hidden = !!r;
    if (!r) return;
    $("games-title").textContent = `${r.team.city} ${r.team.name}`;
    $("games").style.setProperty("--team", r.team.color);
    renderLegend(r);
    renderBar(r);
    $("games-sum").innerHTML = `<b>${r.live}</b> of ${GAMES} live on League Pass` +
      (r.c.local ? `, <b>${r.c.local}</b> blacked out locally` : "") +
      `, <b>${r.national}</b> on national TV` +
      (r.c.tbd ? `, ${r.c.tbd} NBA Cup game${r.c.tbd === 1 ? "" : "s"} not yet scheduled` : "") + ".";
    $("games-table").querySelector("tbody").innerHTML = data.games.filter((g) => g[3] === team || g[4] === team)
      .map(([, date, time, away, home, nat, label]) => {
        const atHome = home === team, opp = atHome ? away : home, o = data.teams[opp];
        const cat = category(away, home, nat);
        const out = !IS_LIVE[cat];
        // 🏀 watchable on League Pass (noting NBA TV), 📺 not, with the network or local team to blame
        const why = cat === "local"
          ? `Local (${[away, home].filter((a) => local().includes(a)).map((a) => data.teams[a].name).join(" / ")})`
          : nat.filter((n) => n !== "NBA TV" && n !== "Telemundo").join(" / ");
        const status = out
          ? `<span role="img" aria-label="Blacked out">📺</span> <span class="net">${esc(why)}</span>`
          : `<span role="img" aria-label="Live on League Pass">🏀</span>${cat === "nbatv" ? ' <span class="net">(NBA TV)</span>' : ""}`;
        return `<tr class="${out ? "out" : "live"}${NATIONAL.some((c) => c.key === cat) ? " natl" : ""}">
          <td class="date">${fmtDate(date)}</td>
          <td class="opp">${atHome ? "vs" : "@"} <b>${opp}</b>${label ? ` <span class="tag">${esc(tag(label))}</span>` : ""}</td>
          <td class="time">${fmtTime(time)}</td>
          <td class="status">${status}</td></tr>`;
      }).join("");
    $("games-table").classList.toggle("out-only", $("only-out").checked);
  }

  function render() {
    tally();
    renderContext();
    renderGames();
  }

  // ---- public ----
  function show(abbr) {
    team = abbr && (!data || abbr in data.teams) ? abbr : null; // before the data loads, kept for init
    if (!data) return;
    renderGames();
    hooks.change(team);
  }
  function setZip(z) {
    zip = z;
    if (data) render();
  }

  async function init(opts) {
    hooks = { ...hooks, ...opts };
    team = opts.team || team;
    data = await (await fetch("data/schedule.json")).json();
    if (team && !(team in data.teams)) team = null;
    $("only-out").addEventListener("change", () => $("games-table").classList.toggle("out-only", $("only-out").checked));
    render();

    // tooltip: hover on desktop, tap on touch
    const tip = $("tip"), chart = $("team-bar");
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
