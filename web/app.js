// ===== Helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(el) { el?.classList.remove("hidden"); }
function hide(el) { el?.classList.add("hidden"); }

function setPage(pageId) {
  hide($("#view-dashboard"));
  hide($("#view-settings"));
  hide($("#view-individual"));
  hide($("#view-group"));
  show($(`#view-${pageId}`));
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m} min ${rs} s`;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ===== App State =====
const state = {
  selectedTestId: "TEST",
  selectedSessionId: null,
  selectedSession: null,
  selectedTaskId: null,
  sessions: [],

  // answers cache: testId -> { taskId -> int }
  correctAnswers: {},
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

async function apiGetTaskMetrics(sessionId, taskId) {
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/metrics`);
}

// --- NEW: persisted answers per test (backend file in data/) ---
async function apiGetTestAnswers(testId) {
  return apiGet(`/api/tests/${encodeURIComponent(testId)}/answers`);
}

async function apiPutTestAnswer(testId, taskId, answerIntOrNull) {
  const res = await fetch(
    `/api/tests/${encodeURIComponent(testId)}/answers/${encodeURIComponent(taskId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: answerIntOrNull }),
    }
  );
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

// ===== Rendering: metrics blocks =====
function renderMetricGrid(metricsObj, containerEl) {
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
      <div class="k">${escapeHtml(k)}</div>
      <div class="v">${escapeHtml(v ?? "—")}</div>
    </div>
  `).join("");

  containerEl.innerHTML = `<div class="metric-grid">${rows}</div>`;
}

// ===== Dashboard: Test aggregation per task (prepared) =====
function computeAggByTask(sessions) {
  // We can now use per-task metrics in stats.tasks if desired later.
  // For now: aggregate based on session primary task or (better) by iterating task metrics keys.
  const buckets = new Map();

  for (const s of sessions) {
    const taskIds = Array.isArray(s.tasks) && s.tasks.length ? s.tasks : [s.task ?? "unknown"];
    for (const task of taskIds) {
      if (!buckets.has(task)) buckets.set(task, []);
      buckets.get(task).push(s);
    }
  }

  const out = [];
  for (const [task, items] of buckets.entries()) {
    // sessions count that contain this task
    const count = items.length;

    // average task duration: if backend later provides stats.tasks[task].duration_ms per session, we can do it precisely.
    // Right now, we fallback to session duration (not accurate for task-level), but keeps UI consistent.
    const durations = items
      .map(x => safeNum(x.stats?.session?.duration_ms))
      .filter(x => x !== null);
    const avgDur = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const events = items
      .map(x => safeNum(x.stats?.session?.events_total))
      .filter(x => x !== null);
    const avgEvents = events.length ? events.reduce((a, b) => a + b, 0) / events.length : null;

    out.push({
      task,
      sessions_count: count,
      avg_duration_ms: avgDur,
      avg_events: avgEvents,
    });
  }

  out.sort((a, b) => String(a.task).localeCompare(String(b.task)));
  return out;
}

function renderTestAggMetrics() {
  const el = $("#testAggMetrics");
  if (!el) return;

  const sessions = state.sessions;

  if (!sessions.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím nejsou data</div>
        <div class="muted small">
          Nahraj jednu nebo více sessions (CSV). Pak se zde zobrazí počet sessions v testu.
        </div>
      </div>
    `;
    return;
  }

  renderMetricGrid(
    { "Počet sessions v testu": sessions.length },
    el
  );
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
    const sessionStats = s.stats?.session ?? {};
    const dur = fmtMs(sessionStats.duration_ms);
    const events = sessionStats.events_total ?? "—";
    const tasksCount = sessionStats.tasks_count ?? (Array.isArray(s.tasks) ? s.tasks.length : "—");
    const user = s.user_id ?? "—";

    return `
      <div class="list-item ${selected}" data-session="${escapeHtml(s.session_id)}">
        <div class="row">
          <div class="title">${escapeHtml(s.session_id)}</div>
          <span class="pill">events: ${escapeHtml(events)}</span>
        </div>
        <div class="muted small">
          user: ${escapeHtml(user)} · tasks: ${escapeHtml(tasksCount)} · délka: ${escapeHtml(dur)}
        </div>
      </div>
    `;

  }).join("");

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
  const sessionStats = s.stats?.session ?? {};
  const soc = sessionStats.soc_demo ?? {};

  renderMetricGrid({
    "Session ID": s.session_id,
    "User": s.user_id ?? "—",
    "Počet tasků": sessionStats.tasks_count ?? (Array.isArray(s.tasks) ? s.tasks.length : "—"),
    "Počet eventů": sessionStats.events_total ?? "—",
    "Celkový čas řešení": fmtMs(sessionStats.duration_ms),

    "Age": soc.age ?? "—",
    "Gender": soc.gender ?? "—",
    "Occupation": soc.occupation ?? "—",
    "Education": soc.education ?? "—",
    "Nationality": soc.nationality ?? "—",
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
    <div class="list-item" data-task="${escapeHtml(t)}">
      <div class="row">
        <div class="title">${escapeHtml(t)}</div>
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
async function openTaskModal(taskId) {
  state.selectedTaskId = taskId;

  const modal = $("#taskMetricsModal");
  const subtitle = $("#taskModalSubtitle");
  const metrics = $("#taskModalMetrics");

  const s = state.selectedSession;

  if (subtitle) {
    subtitle.textContent = `Session: ${s?.session_id ?? "—"} · Úloha: ${taskId}`;
  }

  // show immediately with loading state
  if (metrics) {
    metrics.innerHTML = `
      <div class="empty">
        <div class="empty-title">Načítám metriky…</div>
        <div class="muted small">Chvilku strpení.</div>
      </div>
    `;
  }
  show(modal);

  if (!s?.session_id) return;

  try {
    const m = await apiGetTaskMetrics(s.session_id, taskId);

    renderMetricGrid({
      "Čas řešení úlohy": fmtMs(m.duration_ms),
      "Počet eventů v úloze": m.events_total ?? "—",
    }, metrics);
  } catch (e) {
    if (metrics) {
      metrics.innerHTML = `
        <div class="empty">
          <div class="empty-title">Chyba</div>
          <div class="muted small">${escapeHtml(e?.message ?? e)}</div>
        </div>
      `;
    }
  }
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

  if (testEl) testEl.classList.toggle("muted", !state.selectedTestId);
  if (sessionEl) sessionEl.classList.toggle("muted", !state.selectedSessionId);
}

function selectTest(testId) {
  state.selectedTestId = testId;
  updateBreadcrumbs();

  $$("#testsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.test === testId);
  });

  renderTestAggMetrics();
}

function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.selectedSession = state.sessions.find(s => s.session_id === sessionId) ?? null;
  updateBreadcrumbs();

  $$("#sessionsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.session === sessionId);
  });

  renderSessionMetrics();
}

// ===== Loading data =====
async function refreshSessions() {
  const data = await apiGet("/api/sessions");
  state.sessions = data.sessions ?? [];

  if (state.selectedSessionId && !state.sessions.some(s => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = null;
    state.selectedSession = null;
  } else if (state.selectedSessionId) {
    state.selectedSession = state.sessions.find(s => s.session_id === state.selectedSessionId) ?? null;
  }
}

// ===== Settings page =====
function getAllTasksForSelectedTest() {
  // MVP: sessions nejsou asociované s testId, takže bereme všechny tasks z nahraných sessions
  const set = new Set();
  for (const s of state.sessions) {
    const taskIds = Array.isArray(s.tasks) && s.tasks.length ? s.tasks : [s.task ?? "unknown"];
    for (const t of taskIds) set.add(String(t));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function renderSettingsStatus(text) {
  const el = $("#settingsStatus");
  if (el) el.textContent = text ?? "—";
}

async function loadAnswersForSelectedTest() {
  const testId = state.selectedTestId ?? "TEST";
  try {
    renderSettingsStatus("Načítám uložené odpovědi…");
    const out = await apiGetTestAnswers(testId);
    state.correctAnswers[testId] = out.answers ?? {};
    renderSettingsStatus("Načteno.");
  } catch (e) {
    renderSettingsStatus(`Chyba načtení: ${e?.message ?? e}`);
    state.correctAnswers[testId] = state.correctAnswers[testId] ?? {};
  }
}

function getCorrectAnswerLocal(testId, taskId) {
  return state.correctAnswers?.[testId]?.[taskId];
}

async function setCorrectAnswerPersisted(testId, taskId, answerIntOrNull) {
  // optimistic update
  if (!state.correctAnswers[testId]) state.correctAnswers[testId] = {};
  if (answerIntOrNull === null) {
    delete state.correctAnswers[testId][taskId];
  } else {
    state.correctAnswers[testId][taskId] = answerIntOrNull;
  }

  try {
    renderSettingsStatus("Ukládám…");
    await apiPutTestAnswer(testId, taskId, answerIntOrNull);
    renderSettingsStatus("Uloženo.");
  } catch (e) {
    renderSettingsStatus(`Chyba uložení: ${e?.message ?? e}`);
  }
}

function renderSettingsPage() {
  const testId = state.selectedTestId ?? "TEST";

  const nameEl = $("#settingsTestName");
  if (nameEl) nameEl.textContent = testId;

  const listEl = $("#settingsTasksList");
  if (!listEl) return;

  const tasks = getAllTasksForSelectedTest();

  if (!tasks.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím žádné úlohy</div>
        <div class="muted small">Nahraj aspoň jednu session (CSV), aby se načetly názvy úloh.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = tasks.map((taskId) => {
    const val = getCorrectAnswerLocal(testId, taskId);
    const valueAttr = (val === null || val === undefined) ? "" : String(val);

    return `
      <div class="list-item" data-task="${escapeHtml(taskId)}">
        <div class="row" style="align-items:center; justify-content:space-between; gap:12px;">
          <div>
            <div class="title">${escapeHtml(taskId)}</div>
            <div class="muted small">Správná odpověď (integer)</div>
          </div>

          <input
            type="number"
            inputmode="numeric"
            step="1"
            value="${escapeHtml(valueAttr)}"
            placeholder="např. 3"
            style="width:140px;"
          />
        </div>
      </div>
    `;
  }).join("");

  // listeners na inputy
  $$("#settingsTasksList .list-item").forEach((item) => {
    const taskId = item.dataset.task;
    const input = item.querySelector("input");
    if (!input) return;

    input.addEventListener("change", async () => {
      const raw = input.value;

      if (raw === "") {
        await setCorrectAnswerPersisted(testId, taskId, null);
        return;
      }

      const n = Number(raw);
      if (!Number.isInteger(n)) {
        const fixed = Math.trunc(n);
        input.value = String(fixed);
        await setCorrectAnswerPersisted(testId, taskId, fixed);
        return;
      }

      await setCorrectAnswerPersisted(testId, taskId, n);
    });
  });
}

// ===== Events wiring =====
function wireNavButtons() {
  $("#openTestBtn")?.addEventListener("click", () => {
    setPage("individual");
    renderSessionsList();
    renderSessionMetrics();
  });

  $("#backToTestsBtn")?.addEventListener("click", () => {
    setPage("dashboard");
    selectTest(state.selectedTestId ?? "TEST");
  });

  $("#openSessionBtn")?.addEventListener("click", () => {
    if (!state.selectedSession) return;
    setPage("group");
    renderTasksList();
  });

  $("#backToSessionsBtn")?.addEventListener("click", () => {
    setPage("individual");
    renderSessionsList();
    renderSessionMetrics();
  });

  $("#openSettingsBtn")?.addEventListener("click", async () => {
    setPage("settings");
    await loadAnswersForSelectedTest();
    renderSettingsPage();
  });

  $("#backFromSettingsBtn")?.addEventListener("click", () => {
    setPage("dashboard");
    selectTest(state.selectedTestId ?? "TEST");
  });

  $("#settingsReloadBtn")?.addEventListener("click", async () => {
    await loadAnswersForSelectedTest();
    renderSettingsPage();
  });
}

function wireModal() {
  $("#closeTaskModalBtn")?.addEventListener("click", closeTaskModal);
  $("#closeTaskModalBtn2")?.addEventListener("click", closeTaskModal);
  $("#taskMetricsModal .modal-backdrop")?.addEventListener("click", closeTaskModal);

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
      renderTestAggMetrics();

      if (!state.selectedSessionId) {
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

      if (!$("#view-settings")?.classList.contains("hidden")) {
        // tasks list might change if new CSV introduces new task ids
        renderSettingsPage();
      }

    } catch (ex) {
      if (statusEl) statusEl.textContent = `Chyba: ${ex?.message ?? ex}`;
    } finally {
      input.value = "";
    }
  });
}

// ===== Init =====
async function init() {
  wireNavButtons();
  wireModal();
  wireUpload();

  try {
    await refreshSessions();
  } catch (e) {
    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Backend nedostupný: ${e?.message ?? e}`;
  }

  selectTest("TEST");
  setPage("dashboard");
  updateBreadcrumbs();
  renderTestAggMetrics();

  // preload cached answers for default test (non-blocking)
  (async () => {
    try {
      const out = await apiGetTestAnswers(state.selectedTestId ?? "TEST");
      state.correctAnswers[state.selectedTestId] = out.answers ?? {};
    } catch { /* ignore */ }
  })();
}

init();
