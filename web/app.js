// ===== Helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(el) { el?.classList.remove("hidden"); }
function hide(el) { el?.classList.add("hidden"); }

function setPage(pageId) {
  // pageId: "dashboard" | "individual" | "group"
  hide($("#view-dashboard"));
  hide($("#view-individual"));
  hide($("#view-group"));

  show($(`#view-${pageId}`));
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = ms / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m} min ${rs} s`;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ===== App State =====
const state = {
  selectedTestId: "TEST",
  selectedSessionId: null,
  selectedSession: null,
  selectedTaskId: null,

  sessions: [], // loaded from /api/sessions
};

// ===== API =====
async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiUpload(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

// ===== Rendering: metrics blocks =====
function renderMetricGrid(metricsObj, containerEl) {
  // metricsObj: { key: value, ... } where value is formatted string/number
  if (!containerEl) return;

  const entries = Object.entries(metricsObj ?? {});
  if (!entries.length) {
    containerEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím nic</div>
        <div class="muted small">Data nejsou k dispozici.</div>
      </div>
    `;
    return;
  }

  const rows = entries.map(([k, v]) => `
    <div class="metric">
      <div class="k">${k}</div>
      <div class="v">${v ?? "—"}</div>
    </div>
  `).join("");

  containerEl.innerHTML = `<div class="metric-grid">${rows}</div>`;
}

// ===== Dashboard: Test aggregation per task =====
function computeAggByTask(sessions) {
  // sessions: [{task, stats:{duration_ms, events_total,...}}]
  const buckets = new Map();

  for (const s of sessions) {
    const task = s.task ?? "unknown";
    if (!buckets.has(task)) buckets.set(task, []);
    buckets.get(task).push(s);
  }

  const out = [];
  for (const [task, items] of buckets.entries()) {
    const count = items.length;

    const durations = items
      .map(x => safeNum(x.stats?.duration_ms))
      .filter(x => x !== null);
    const avgDur = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const events = items
      .map(x => safeNum(x.stats?.events_total))
      .filter(x => x !== null);
    const avgEvents = events.length ? events.reduce((a, b) => a + b, 0) / events.length : null;

    const pairs = items
      .map(x => safeNum(x.stats?.movement_pairs_hint))
      .filter(x => x !== null);
    const avgPairs = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null;

    out.push({
      task,
      sessions_count: count,
      avg_duration_ms: avgDur,
      avg_events: avgEvents,
      avg_pairs: avgPairs,
    });
  }

  // stable sort
  out.sort((a, b) => String(a.task).localeCompare(String(b.task)));
  return out;
}

function renderTestAggMetrics() {
  const el = $("#testAggMetrics");
  if (!el) return;

  // For now: only TEST exists, and all sessions belong to TEST
  const sessions = state.sessions;

  if (!sessions.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím nejsou data</div>
        <div class="muted small">Nahraj jednu nebo více sessions (CSV). Pak se zde zobrazí agregace za úlohy v testu.</div>
      </div>
    `;
    return;
  }

  const agg = computeAggByTask(sessions);

  const cards = agg.map(a => {
    const title = a.task;
    const rows = {
      "Respondentů (sessions)": a.sessions_count,
      "Průměrný čas": fmtMs(a.avg_duration_ms),
      "Průměrný počet eventů": a.avg_events?.toFixed?.(0) ?? "—",
      "Průměrný počet pohybových párů": a.avg_pairs?.toFixed?.(0) ?? "—",
      "% správnosti": "— (později)",
    };

    const inner = Object.entries(rows).map(([k, v]) => `
      <div class="metric">
        <div class="k">${k}</div>
        <div class="v">${v}</div>
      </div>
    `).join("");

    return `
      <div class="card" style="padding:12px; border-radius:16px;">
        <div class="row" style="margin-bottom:8px;">
          <div class="title">${title}</div>
          <span class="pill">agregace</span>
        </div>
        <div class="metric-grid">${inner}</div>
      </div>
    `;
  }).join("");

  el.innerHTML = `<div class="stack" style="gap:12px;">${cards}</div>`;
}

// ===== Sessions list page =====
function renderSessionsList() {
  const listEl = $("#sessionsList");
  if (!listEl) return;

  const sessions = state.sessions;

  if (!sessions.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Žádná session</div>
        <div class="muted small">Nahraj CSV na nástěnce, potom se sem sessions doplní.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = sessions.map(s => {
    const selected = s.session_id === state.selectedSessionId ? "is-selected" : "";
    const dur = fmtMs(s.stats?.duration_ms);
    const events = s.stats?.events_total ?? "—";
    const task = s.task ?? "—";
    const user = s.user_id ?? "—";

    return `
      <div class="list-item ${selected}" data-session="${s.session_id}">
        <div class="row">
          <div class="title">${s.session_id}</div>
          <span class="pill">events: ${events}</span>
        </div>
        <div class="muted small">user: ${user} · task: ${task} · délka: ${dur}</div>
      </div>
    `;
  }).join("");

  // bind clicks
  $$("#sessionsList .list-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.session;
      selectSession(id);
    });
  });
}

function renderSessionMetrics() {
  const el = $("#sessionMetrics");
  const btn = $("#openSessionBtn");
  if (!el) return;

  if (!state.selectedSession) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-title">Vyber session</div>
        <div class="muted small">Klikni vlevo na session, aby se zde zobrazily její metriky.</div>
      </div>
    `;
    if (btn) btn.disabled = true;
    return;
  }

  const s = state.selectedSession;
  const stats = s.stats ?? {};

  renderMetricGrid({
    "Session ID": s.session_id,
    "User": s.user_id ?? "—",
    "Task (hlavní)": s.task ?? "—",
    "Eventů celkem": stats.events_total ?? "—",
    "Délka": fmtMs(stats.duration_ms),
    "movestart / moveend": `${stats.movestart_count ?? "—"} / ${stats.moveend_count ?? "—"}`,
    "Pohybové páry (hint)": stats.movement_pairs_hint ?? "—",
  }, el);

  if (btn) btn.disabled = false;
}

// ===== Tasks page =====
function inferTasksForSelectedSession() {
  const s = state.selectedSession;
  if (!s) return [];
  if (Array.isArray(s.tasks) && s.tasks.length) return s.tasks;
  return [s.task ?? "unknown"];
}

function renderTasksList() {
  const listEl = $("#tasksList");
  if (!listEl) return;

  if (!state.selectedSession) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Vyber nejdřív session</div>
        <div class="muted small">Úlohy se načtou až po výběru session v předchozím kroku.</div>
      </div>
    `;
    return;
  }

  const tasks = inferTasksForSelectedSession();

  listEl.innerHTML = tasks.map(t => `
    <div class="list-item" data-task="${t}">
      <div class="row">
        <div class="title">${t}</div>
        <span class="pill">úloha</span>
      </div>
      <div class="muted small">Klikni pro metriky (pop-up).</div>
    </div>
  `).join("");

  $$("#tasksList .list-item").forEach(item => {
    item.addEventListener("click", () => {
      const taskId = item.dataset.task;
      openTaskModal(taskId);
    });
  });
}

// ===== Modal (task metrics pop-up) =====
function openTaskModal(taskId) {
  state.selectedTaskId = taskId;

  const modal = $("#taskMetricsModal");
  const subtitle = $("#taskModalSubtitle");
  const metrics = $("#taskModalMetrics");

  if (subtitle) {
    const s = state.selectedSession;
    subtitle.textContent = `Session: ${s?.session_id ?? "—"} · Úloha: ${taskId}`;
  }

  // MVP: metriky úlohy = zatím metriky celé session (dokud nemáme eventy po tasku)
  if (metrics) {
    const s = state.selectedSession;
    const stats = s?.stats ?? {};

    renderMetricGrid({
      "Úloha": taskId,
      "Respondent": s?.user_id ?? "—",
      "Délka (session)": fmtMs(stats.duration_ms),
      "Eventů celkem (session)": stats.events_total ?? "—",
      "movestart / moveend": `${stats.movestart_count ?? "—"} / ${stats.moveend_count ?? "—"}`,
      "Poznámka": "MVP: zatím metriky za celou session. Později: přesný výpočet za úlohu.",
    }, metrics);
  }

  show(modal);
}

function closeTaskModal() {
  hide($("#taskMetricsModal"));
}

// ===== Selection + Breadcrumbs =====
function updateBreadcrumbs() {
  const testEl = $("#crumb-test");
  const sessionEl = $("#crumb-session");

  if (testEl) testEl.textContent = state.selectedTestId ?? "—";
  if (sessionEl) sessionEl.textContent = state.selectedSessionId ?? "—";

  // styling muted when empty
  if (testEl) testEl.classList.toggle("muted", !state.selectedTestId);
  if (sessionEl) sessionEl.classList.toggle("muted", !state.selectedSessionId);
}

function selectTest(testId) {
  state.selectedTestId = testId;
  updateBreadcrumbs();

  // highlight (only one default for now)
  $$("#testsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.test === testId);
  });

  // render aggregated metrics for test
  renderTestAggMetrics();
}

function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.selectedSession = state.sessions.find(s => s.session_id === sessionId) ?? null;
  updateBreadcrumbs();

  // highlight list
  $$("#sessionsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.session === sessionId);
  });

  renderSessionMetrics();
}

// ===== Loading data =====
async function refreshSessions() {
  const data = await apiGet("/api/sessions");
  state.sessions = data.sessions ?? [];

  // If selected session disappeared, clear selection
  if (state.selectedSessionId && !state.sessions.some(s => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = null;
    state.selectedSession = null;
  }
}

// ===== Events wiring =====
function wireNavButtons() {
  // Dashboard -> Sessions
  $("#openTestBtn")?.addEventListener("click", () => {
    setPage("individual");
    renderSessionsList();
    renderSessionMetrics();
  });

  // Sessions -> Dashboard
  $("#backToTestsBtn")?.addEventListener("click", () => {
    setPage("dashboard");
    selectTest(state.selectedTestId ?? "TEST");
  });

  // Sessions -> Tasks
  $("#openSessionBtn")?.addEventListener("click", () => {
    if (!state.selectedSession) return;
    setPage("group");
    renderTasksList();
  });

  // Tasks -> Sessions
  $("#backToSessionsBtn")?.addEventListener("click", () => {
    setPage("individual");
    renderSessionsList();
    renderSessionMetrics();
  });
}

function wireModal() {
  // close buttons
  $("#closeTaskModalBtn")?.addEventListener("click", closeTaskModal);
  $("#closeTaskModalBtn2")?.addEventListener("click", closeTaskModal);

  // backdrop click
  $("#taskMetricsModal .modal-backdrop")?.addEventListener("click", closeTaskModal);

  // ESC
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = $("#taskMetricsModal");
      if (modal && !modal.classList.contains("hidden")) closeTaskModal();
    }
  });
}

function wireUpload() {
  const input = $("#csvInput");
  if (!input) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Nahrávám: ${file.name}…`;

    try {
      const out = await apiUpload(file);
      if (statusEl) statusEl.textContent = `Nahráno: ${out.session_id} (user: ${out.user_id ?? "—"})`;

      await refreshSessions();
      // re-render wherever we are
      renderTestAggMetrics();

      if (!state.selectedSessionId) {
        // auto-select last uploaded session for convenience (optional)
        state.selectedSessionId = out.session_id;
        state.selectedSession = state.sessions.find(s => s.session_id === out.session_id) ?? null;
      }

      if (!$("#view-individual")?.classList.contains("hidden")) {
        renderSessionsList();
        renderSessionMetrics();
      }

      if (!$("#view-group")?.classList.contains("hidden")) {
        renderTasksList();
      }

    } catch (ex) {
      if (statusEl) statusEl.textContent = `Chyba: ${ex?.message ?? ex}`;
    } finally {
      // allow re-upload same file
      input.value = "";
    }
  });
}

// ===== Init =====
async function init() {
  wireNavButtons();
  wireModal();
  wireUpload();

  // initial load
  try {
    await refreshSessions();
  } catch (e) {
    // If server not reachable, show hint
    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Backend nedostupný: ${e?.message ?? e}`;
  }

  // initial selection
  selectTest("TEST");

  // initial page
  setPage("dashboard");
  updateBreadcrumbs();

  // dashboard metrics
  renderTestAggMetrics();
}

init();
