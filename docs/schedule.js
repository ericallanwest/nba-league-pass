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
      <span class="team" role="cell"><span class="abbr">${r.abbr}</span><span class="name">${r.team.city} ${r.team.name}</span></span>
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
