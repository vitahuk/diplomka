const $ = (sel) => document.querySelector(sel);

function setView(viewName) {
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(`#view-${viewName}`).classList.remove("hidden");
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = (s % 60).toFixed(0);
  return `${m} min ${rs} s`;
}

function renderMetrics(session) {
  const el = $("#basicMetrics");
  const stats = session?.stats;
  if (!stats) {
    el.innerHTML = `<div class="muted">Nahraj CSV a vyber session…</div>`;
    return;
  }

  el.innerHTML = `
    <div class="kv-row"><div class="muted">Session</div><div>${session.session_id}</div></div>
    <div class="kv-row"><div class="muted">User</div><div>${session.user_id ?? "—"}</div></div>
    <div class="kv-row"><div class="muted">Task</div><div>${session.task ?? "—"}</div></div>
    <div class="kv-row"><div class="muted">Eventů celkem</div><div>${stats.events_total}</div></div>
    <div class="kv-row"><div class="muted">Délka</div><div>${fmtMs(stats.duration_ms)}</div></div>
    <div class="kv-row"><div class="muted">movestart / moveend</div><div>${stats.movestart_count} / ${stats.moveend_count}</div></div>
    <div class="kv-row"><div class="muted">Páry (hint)</div><div>${stats.movement_pairs_hint}</div></div>
  `;
}

function renderSessions(list) {
  const dash = $("#sessionsList");
  const ind = $("#individualSessions");

  const html = list.map(s => `
    <div class="list-item" data-session="${s.session_id}">
      <div><b>${s.session_id}</b></div>
      <div class="muted">user: ${s.user_id ?? "—"} · task: ${s.task ?? "—"} · events: ${s.stats?.events_total ?? "—"}</div>
    </div>
  `).join("");

  dash.innerHTML = html || `<div class="muted">Zatím nic. Nahraj CSV.</div>`;
  ind.innerHTML = html || `<div class="muted">Zatím nic. Nahraj CSV.</div>`;

  // kliky: nastav metriky + detail
  document.querySelectorAll(".list-item").forEach(item => {
    item.addEventListener("click", async () => {
      const id = item.dataset.session;
      const session = list.find(x => x.session_id === id);
      renderMetrics(session);
      $("#sessionDetail").innerText = `Session: ${id} (user: ${session.user_id ?? "—"}, task: ${session.task ?? "—"})`;
      setView("individual");
    });
  });
}

async function refreshSessions() {
  const res = await fetch("/api/sessions");
  const data = await res.json();
  renderSessions(data.sessions || []);
}

$("#csvInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  $("#uploadStatus").innerText = `Nahrávám: ${file.name}…`;

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    $("#uploadStatus").innerText = `Chyba: ${err.detail ?? res.statusText}`;
    return;
  }

  const out = await res.json();
  $("#uploadStatus").innerText = `Nahráno: ${out.session_id} (user: ${out.user_id ?? "—"})`;

  await refreshSessions();
  renderMetrics(out);
});

// inicializace
refreshSessions().then(() => renderMetrics(null));
