(async function () {
  const GAMES = 82;
  // one category per game, in bar order; a game on several networks goes to the first that matches
  const CATS = [
    { key: "lp", label: "League Pass", live: true },
    { key: "nbatv", label: "NBA TV", live: true },
    { key: "abc", label: "ABC", nets: ["ABC"] },
    { key: "espn", label: "ESPN", nets: ["ESPN"] },
    { key: "nbc", label: "NBC", nets: ["NBC"] },
    { key: "peacock", label: "Peacock", nets: ["Peacock", "NBCSN", "Telemundo"] },
    { key: "prime", label: "Prime Video", nets: ["Prime Video"] },
    { key: "tbd", label: "Not yet scheduled" },
  ];
  const NATIONAL = CATS.filter((c) => c.nets);

  function category(nat) {
    for (const c of NATIONAL) if (nat.some((n) => c.nets.includes(n))) return c.key;
    return nat.includes("NBA TV") ? "nbatv" : "lp";
  }

  const data = await (await fetch("data/schedule.json")).json();
  const counts = {};
  for (const t in data.teams) counts[t] = Object.fromEntries(CATS.map((c) => [c.key, 0]));
  let national = 0, scheduled = 0;
  for (const [, , , away, home, nat] of data.games) {
    const cat = category(nat);
    if (away in counts && home in counts) {
      scheduled++;
      if (NATIONAL.some((c) => c.key === cat)) national++;
    }
    for (const t of [away, home]) if (t in counts) counts[t][cat]++;
  }
  const rows = Object.entries(counts).map(([abbr, c]) => {
    const played = CATS.reduce((s, k) => s + c[k.key], 0);
    c.tbd = Math.max(0, GAMES - played);
    return { abbr, team: data.teams[abbr], c, live: c.lp + c.nbatv, blackout: NATIONAL.reduce((s, k) => s + c[k.key], 0) };
  });

  // legend
  const legend = document.getElementById("legend");
  for (const cat of CATS) {
    if (cat.key === "tbd" && !rows.some((r) => r.c.tbd)) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="sw seg-${cat.key}"></span>${cat.label}`;
    if (cat.key === "lp") li.title = "Live on League Pass, in the team's color";
    legend.append(li);
    if (cat.key === "nbatv") legend.insertAdjacentHTML("beforeend", '<li class="sep" aria-hidden="true"></li>');
  }

  const chart = document.getElementById("chart");
  const tip = document.getElementById("tip");
  const els = new Map();
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "chart-row";
    row.setAttribute("role", "row");
    row.style.setProperty("--team", r.team.color);
    const bar = CATS.filter((cat) => r.c[cat.key]).map((cat) => {
      const n = r.c[cat.key];
      const what = cat.live ? `live on ${cat.label === "NBA TV" ? "NBA TV (and League Pass)" : "League Pass"}`
        : cat.key === "tbd" ? "NBA Cup week, not yet scheduled" : `on ${cat.label}, blacked out`;
      return `<span class="seg seg-${cat.key}${n < 5 ? " small" : ""}" style="flex:${n}" data-tip="${r.team.city} ${r.team.name}: ${n} game${n === 1 ? "" : "s"} ${what}">${n >= 3 ? n : ""}</span>`;
    }).join("");
    row.innerHTML = `
      <a class="team" role="cell" href="#team=${r.abbr}"><span class="abbr">${r.abbr}</span><span class="name">${r.team.city} ${r.team.name}</span></a>
      <span class="bar" role="cell" aria-label="${r.live} live, ${r.blackout} national blackouts${r.c.tbd ? `, ${r.c.tbd} not yet scheduled` : ""}">${bar}</span>
      <span class="num" role="cell"><b>${r.live}</b> <span class="muted">of ${GAMES}</span></span>`;
    els.set(r.abbr, row);
  }

  function sort(by) {
    const sorted = [...rows].sort(by === "team"
      ? (a, b) => (a.team.city + a.team.name).localeCompare(b.team.city + b.team.name)
      : (a, b) => (by === "national" ? b.blackout - a.blackout : a.blackout - b.blackout) || a.abbr.localeCompare(b.abbr));
    for (const r of sorted) chart.append(els.get(r.abbr));
  }
  for (const input of document.querySelectorAll("#sort input")) input.addEventListener("change", () => sort(input.value));
  sort("national");

  const hi = Math.max(...rows.map((r) => r.blackout)), lo = Math.min(...rows.map((r) => r.blackout));
  const who = (n) => rows.filter((r) => r.blackout === n).map((r) => r.abbr).sort().join(", ");
  document.getElementById("league").textContent =
    `${data.season} season: ${national} of ${scheduled.toLocaleString()} scheduled games are national blackouts, ` +
    `from ${lo} per team (${who(lo)}) to ${hi} (${who(hi)}).`;

  // ---- game-by-game table for one team (#team=ABBR) ----
  const pick = document.getElementById("team-pick");
  const onlyOut = document.getElementById("only-out");
  const tbody = document.querySelector("#games-table tbody");
  for (const r of [...rows].sort((a, b) => (a.team.city + a.team.name).localeCompare(b.team.city + b.team.name))) {
    pick.add(new Option(`${r.team.city} ${r.team.name}`, r.abbr));
  }
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
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function renderGames(abbr) {
    const r = rows.find((x) => x.abbr === abbr);
    for (const [a, el] of els) el.classList.toggle("sel", a === abbr);
    pick.value = r ? abbr : "";
    document.getElementById("games-body").hidden = !r;
    const sum = document.getElementById("games-sum");
    document.getElementById("games-title").textContent = r ? `${r.team.city} ${r.team.name}` : "Game by game";
    if (!r) {
      sum.textContent = "Click a team in the chart, or choose one here, to see which of its games are blacked out on League Pass outside its local area.";
      return;
    }
    document.getElementById("games").style.setProperty("--team", r.team.color);
    sum.innerHTML = `<b>${r.live}</b> live on League Pass, <b>${r.blackout}</b> blacked out on national TV` +
      (r.c.tbd ? `, ${r.c.tbd} NBA Cup game${r.c.tbd === 1 ? "" : "s"} not yet scheduled` : "") + ".";
    tbody.innerHTML = data.games.filter((g) => g[3] === abbr || g[4] === abbr).map(([, date, time, away, home, nat, label]) => {
      const home_ = home === abbr, opp = home_ ? away : home, o = data.teams[opp];
      const cat = category(nat);
      const out = !CATS.find((c) => c.key === cat).live;
      const nets = NATIONAL.find((c) => c.key === cat);
      const status = out
        ? `<span class="st st-out">Blacked out</span> <span class="net">${esc(nat.filter((n) => n !== "NBA TV" && n !== "Telemundo").join(" / "))}</span>`
        : `<span class="st st-live">Live</span>${cat === "nbatv" ? ' <span class="net">(also on NBA TV)</span>' : ""}`;
      return `<tr class="${out ? "out" : "live"}${nets ? " n-" + cat : ""}">
        <td class="date">${fmtDate(date)}</td>
        <td class="opp">${home_ ? "vs" : "@"} <b>${opp}</b><span class="oname"> ${o ? esc(o.name) : ""}</span>${label ? ` <span class="tag">${esc(tag(label))}</span>` : ""}</td>
        <td class="time">${fmtTime(time)}</td>
        <td class="status">${status}</td></tr>`;
    }).join("");
    filterGames();
  }
  function filterGames() {
    document.getElementById("games-table").classList.toggle("only-out", onlyOut.checked);
  }
  onlyOut.addEventListener("change", filterGames);
  pick.addEventListener("change", () => { location.hash = pick.value ? `team=${pick.value}` : ""; });
  const fromHash = () => (location.hash.match(/team=([A-Z]{3})/) || [])[1];
  window.addEventListener("hashchange", () => {
    renderGames(fromHash());
    if (fromHash()) document.getElementById("games").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  renderGames(fromHash());

  // tooltip: hover on desktop, tap on touch
  function show(e) {
    const seg = e.target.closest(".seg");
    if (!seg) { tip.hidden = true; return; }
    tip.textContent = seg.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  }
  chart.addEventListener("pointermove", show);
  chart.addEventListener("pointerdown", show);
  chart.addEventListener("pointerleave", () => (tip.hidden = true));
  window.addEventListener("scroll", () => (tip.hidden = true), { passive: true });
})();
