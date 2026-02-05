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

function fmtSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "—";
  if (n < 60) return `${n.toFixed(1)} s`;
  const m = Math.floor(n / 60);
  const rs = Math.round(n % 60);
  return `${m}:${String(rs).padStart(2, "0")}`;
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

function isCoordinateLike(s) {
  if (!s) return false;
  return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(String(s).trim());
}

// ===== App State =====
const state = {
  selectedTestId: "TEST",
  selectedSessionId: null,
  selectedSession: null,
  selectedTaskId: null,
  sessions: [],
  sessionFilters: {
    gender: "",
    ageMin: "",
    ageMax: "",
    occupation: "",
    nationality: "",
    userIdQuery: "",
  },
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

async function apiUploadBulk(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload/bulk", { method: "POST", body: fd });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiGetTestAnswers(testId) {
  return apiGet(`/api/tests/${encodeURIComponent(testId)}/answers`);
}

async function apiPutTestAnswer(testId, taskName, answerOrNull) {
  const res = await fetch(
    `/api/tests/${encodeURIComponent(testId)}/answers/${encodeURIComponent(taskName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: answerOrNull }),
    }
  );

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

// NEW: raw events for timeline
async function apiGetSessionEvents(sessionId) {
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
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
    const count = items.length;

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
function getSocDemo(session) {
  return session?.stats?.session?.soc_demo ?? {};
}

function normalizeFilterValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSearchValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseOptionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getSessionFilterOptions(sessions) {
  const gender = new Set();
  const occupation = new Set();
  const nationality = new Set();

  sessions.forEach((session) => {
    const soc = getSocDemo(session);
    if (soc.gender) gender.add(String(soc.gender));
    if (soc.occupation) occupation.add(String(soc.occupation));
    if (soc.nationality) nationality.add(String(soc.nationality));
  });

  const sort = (a, b) => a.localeCompare(b, "cs", { sensitivity: "base" });
  return {
    gender: Array.from(gender).sort(sort),
    occupation: Array.from(occupation).sort(sort),
    nationality: Array.from(nationality).sort(sort),
  };
}

function renderSessionFilterControls() {
  const genderEl = $("#sessionFilterGender");
  const occupationEl = $("#sessionFilterOccupation");
  const nationalityEl = $("#sessionFilterNationality");
  const ageMinEl = $("#sessionFilterAgeMin");
  const ageMaxEl = $("#sessionFilterAgeMax");
  const userIdEl = $("#sessionFilterUserId");

  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !userIdEl) return;

  const options = getSessionFilterOptions(state.sessions);
  const makeOptions = (values, emptyLabel) => {
    const base = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    return base.concat(values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  };

  genderEl.innerHTML = makeOptions(options.gender, "Vše");
  occupationEl.innerHTML = makeOptions(options.occupation, "Vše");
  nationalityEl.innerHTML = makeOptions(options.nationality, "Vše");

  genderEl.value = state.sessionFilters.gender;
  occupationEl.value = state.sessionFilters.occupation;
  nationalityEl.value = state.sessionFilters.nationality;
  ageMinEl.value = state.sessionFilters.ageMin;
  ageMaxEl.value = state.sessionFilters.ageMax;
  userIdEl.value = state.sessionFilters.userIdQuery;
}

function applySessionFilters(sessions) {
  const genderFilter = normalizeFilterValue(state.sessionFilters.gender);
  const occupationFilter = normalizeFilterValue(state.sessionFilters.occupation);
  const nationalityFilter = normalizeFilterValue(state.sessionFilters.nationality);
  const ageMin = parseOptionalNumber(state.sessionFilters.ageMin);
  const ageMax = parseOptionalNumber(state.sessionFilters.ageMax);
  const userIdQuery = normalizeSearchValue(state.sessionFilters.userIdQuery);

  return sessions.filter((session) => {
    const soc = getSocDemo(session);
    const gender = normalizeFilterValue(soc.gender);
    const occupation = normalizeFilterValue(soc.occupation);
    const nationality = normalizeFilterValue(soc.nationality);
    const age = parseOptionalNumber(soc.age);
    const userId = normalizeSearchValue(session.user_id);

    if (genderFilter && genderFilter !== gender) return false;
    if (occupationFilter && occupationFilter !== occupation) return false;
    if (nationalityFilter && nationalityFilter !== nationality) return false;
    if (userIdQuery && !userId.includes(userIdQuery)) return false;

    if (ageMin !== null || ageMax !== null) {
      if (age === null) return false;
      if (ageMin !== null && age < ageMin) return false;
      if (ageMax !== null && age > ageMax) return false;
    }

    return true;
  });
}

function renderSessionsList() {
  const listEl = $("#sessionsList");
  if (!listEl) return;

  const sessions = state.sessions;
  renderSessionFilterControls();
  const summaryEl = $("#sessionFilterSummary");

  if (!sessions.length) {
    if (summaryEl) summaryEl.textContent = "Zobrazeno 0 z 0";
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Žádná session</div>
        <div class="muted small">Nahraj CSV na nástěnce, potom se sem sessions doplní.</div>
      </div>
    `;
    return;
  }

  const filteredSessions = applySessionFilters(sessions);
  if (summaryEl) {
    summaryEl.textContent = `Zobrazeno ${filteredSessions.length} z ${sessions.length}`;
  }

  if (!filteredSessions.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Žádná session neodpovídá filtru</div>
        <div class="muted small">Uprav filtry nebo je zruš tlačítkem „Zrušit filtr“.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = filteredSessions.map(s => {
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

// ===== NEW: Timeline (modal) =====
const EVENT_COLORS = {
  // intervals
  "MOVE": "#4C78A8",
  "ZOOM": "#F58518",
  "POPUP": "#72B7B2",
  "INTRO": "#8E8E8E",

  // instants
  "answer selected": "#54A24B",
  "answer button clicked": "#9C755F",
  "setting task": "#E45756",
  "completed": "#B279A2",
  "legend opened": "#FF9DA6",
  "polygon selected": "#A0CBE8",
  "popupopen": "#72B7B2",
  "popupclose": "#72B7B2",
  "popupopen:name": "#D37295",
  "show layer": "#59A14F",
  "hide layer": "#EDC948",
  "question dialog closed": "#79706E",
  "zoom in": "#F58518",
  "zoom out": "#F58518",
};

function colorFor(name) {
  return EVENT_COLORS[name] ?? "#999999";
}

function toTextDetail(detail) {
  if (!detail) return null;
  if (isCoordinateLike(detail)) return null;
  const t = String(detail).trim();
  return t ? t : null;
}

function buildTimelineItems(events) {
  // Output items:
  // - interval: {type:"interval", name:"MOVE"|"ZOOM"|"POPUP", startTs, endTs, details[]}
  // - instant:  {type:"instant", name, ts, detail}
  const items = [];

  let openMove = null;  // {startTs, hadZoom, details[]}
  let openPopup = null; // {startTs, details[]}

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ts = Number(e.timestamp);
    const name = String(e.event_name);
    const detail = toTextDetail(e.event_detail);

    // --- MOVE/ZOOM interval handling (movestart..moveend, zoom in/out inside => ZOOM) ---
    if (name === "movestart") {
      // close previous open move if any (edge-case)
      if (openMove) {
        items.push({
          type: "interval",
          name: openMove.hadZoom ? "ZOOM" : "MOVE",
          startTs: openMove.startTs,
          endTs: ts,
          details: openMove.details,
        });
      }
      openMove = { startTs: ts, hadZoom: false, details: [] };
      continue;
    }

    if (name === "zoom in" || name === "zoom out") {
      if (openMove) {
        openMove.hadZoom = true;
        if (detail) openMove.details.push(`${name}: ${detail}`);
      } else {
        items.push({ type: "instant", name, ts, detail });
      }
      continue;
    }

    if (name === "moveend") {
      if (openMove) {
        items.push({
          type: "interval",
          name: openMove.hadZoom ? "ZOOM" : "MOVE",
          startTs: openMove.startTs,
          endTs: ts,
          details: openMove.details,
        });
        openMove = null;
      } else {
        items.push({ type: "instant", name, ts, detail });
      }
      continue;
    }

    // --- POPUP interval handling (popupopen..popupclose) ---
    if (name === "popupopen") {
      // close previous open popup if any (edge-case)
      if (openPopup) {
        items.push({
          type: "interval",
          name: "POPUP",
          startTs: openPopup.startTs,
          endTs: ts,
          details: openPopup.details,
        });
      }
      openPopup = { startTs: ts, details: [] };
      if (detail) openPopup.details.push(`popupopen: ${detail}`);
      continue;
    }

    if (name === "popupclose") {
      if (openPopup) {
        if (detail) openPopup.details.push(`popupclose: ${detail}`);
        items.push({
          type: "interval",
          name: "POPUP",
          startTs: openPopup.startTs,
          endTs: ts,
          details: openPopup.details,
        });
        openPopup = null;
      } else {
        items.push({ type: "instant", name, ts, detail });
      }
      continue;
    }

    // If popup is open, collect useful detail from events that happen inside popup (optional)
    // We keep it lightweight: only if event_detail exists and is text.
    if (openPopup && detail) {
      openPopup.details.push(`${name}: ${detail}`);
    }

    // default: instant tick
    items.push({ type: "instant", name, ts, detail });
  }

  // close any open intervals at end
  const lastTs = events.length ? Number(events[events.length - 1].timestamp) : 0;

  if (openMove) {
    items.push({
      type: "interval",
      name: openMove.hadZoom ? "ZOOM" : "MOVE",
      startTs: openMove.startTs,
      endTs: lastTs,
      details: openMove.details,
    });
  }

  if (openPopup) {
    items.push({
      type: "interval",
      name: "POPUP",
      startTs: openPopup.startTs,
      endTs: lastTs,
      details: openPopup.details,
    });
  }

  return items;
}

function buildLegendHtml(usedNames) {
  // usedNames: Set<string>
  const items = Array.from(usedNames);
  // prefer interval types first
  const order = ["MOVE", "ZOOM", "POPUP"];
  items.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return String(a).localeCompare(String(b));
  });

  const chips = items.map(name => `
    <div style="display:flex; align-items:center; gap:8px; margin-right:14px; margin-bottom:8px;">
      <span style="
        width:12px; height:12px; border-radius:3px;
        background:${colorFor(name)};
        display:inline-block;
        border:1px solid rgba(255,255,255,0.18);
      "></span>
      <span class="muted small" style="line-height:1;">${escapeHtml(name)}</span>
    </div>
  `).join("");

  return `
    <div style="margin-top:12px;">
      <div class="muted small" style="margin-bottom:8px;">Legenda</div>
      <div style="display:flex; flex-wrap:wrap; align-items:center;">
        ${chips}
      </div>
    </div>
  `;
}

function ensureTimelineTooltip(container) {
  let tip = container.querySelector("#timelineTooltip");
  if (tip) return tip;

  tip = document.createElement("div");
  tip.id = "timelineTooltip";
  tip.className = "hidden";
  tip.style.position = "fixed";
  tip.style.zIndex = "9999";
  tip.style.maxWidth = "520px";
  tip.style.padding = "10px 12px";
  tip.style.borderRadius = "12px";
  tip.style.border = "1px solid rgba(255,255,255,0.14)";
  tip.style.background = "rgba(10, 12, 16, 0.92)";
  tip.style.boxShadow = "0 12px 30px rgba(0,0,0,0.45)";
  tip.style.whiteSpace = "pre-line";
  tip.style.pointerEvents = "none";
  tip.style.fontSize = "12px";
  tip.style.lineHeight = "1.25";

  document.body.appendChild(tip);
  return tip;
}

function wireTimelineTooltip(container) {
  const tip = ensureTimelineTooltip(container);
  const nodes = Array.from(container.querySelectorAll("[data-tip]"));

  const hideTip = () => {
    tip.classList.add("hidden");
  };

  const showTip = (text) => {
    tip.textContent = text;
    tip.classList.remove("hidden");
  };

  const moveTip = (evt) => {
    // little offset from cursor, keep inside viewport
    const pad = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // temporarily show to measure
    const rect = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;

    if (x + rect.width + pad > vw) x = evt.clientX - rect.width - pad;
    if (y + rect.height + pad > vh) y = evt.clientY - rect.height - pad;

    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };

  nodes.forEach(el => {
    el.addEventListener("mouseenter", (e) => {
      const txt = el.dataset.tip || "";
      if (!txt) return;
      showTip(txt);
      moveTip(e);
    });
    el.addEventListener("mousemove", moveTip);
    el.addEventListener("mouseleave", hideTip);
  });

  // also hide when leaving modal content quickly
  container.addEventListener("mouseleave", hideTip);
}

function findItemAtTime(items, tMs) {
  // Prefer interval that contains t
  for (const it of items) {
    if (it.type === "interval" && tMs >= it.startTs && tMs <= it.endTs) return it;
  }

  // Otherwise find nearest instant within threshold
  let best = null;
  let bestDist = Infinity;
  const TH = 200; // ms tolerance
  for (const it of items) {
    if (it.type !== "instant") continue;
    const d = Math.abs(it.ts - tMs);
    if (d < bestDist) {
      bestDist = d;
      best = it;
    }
  }
  if (best && bestDist <= TH) return best;

  return null;
}

function renderTimelineModalContent(eventsPayload) {
  const container = $("#timelineContent");
  if (!container) return;

  const events = eventsPayload?.events ?? [];
  if (!events.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-title">Žádné eventy</div>
        <div class="muted small">Pro tuto session se nepodařilo načíst eventy.</div>
      </div>
    `;
    return;
  }

  // IMPORTANT: timeline starts at 0 (intro before first event)
  const startTs = 0;
  const firstEventTs = Number(events[0].timestamp);
  const lastEventTs = Number(events[events.length - 1].timestamp);
  const totalMs = Math.max(1, lastEventTs - startTs);
  const totalSec = totalMs / 1000;

  const items = buildTimelineItems(events);

  // Add INTRO interval: 0 -> firstEventTs (if any gap)
  if (Number.isFinite(firstEventTs) && firstEventTs > 0) {
    items.unshift({
      type: "interval",
      name: "INTRO",
      startTs: 0,
      endTs: firstEventTs,
      details: ["čas před prvním eventem (čtení zadání)"],
    });
  }

  const usedNames = new Set();
  items.forEach(it => usedNames.add(it.name));

  const barHeightPx = 30; // 1.5x (was 20)

  const segmentsHtml = items.map(it => {
    if (it.type === "interval") {
      const l = ((it.startTs - startTs) / totalMs) * 100;
      const w = (Math.max(1, it.endTs - it.startTs) / totalMs) * 100;
      const durSec = (it.endTs - it.startTs) / 1000;

      const detailLines = Array.isArray(it.details) && it.details.length
        ? `\n${it.details.slice(0, 12).join("\n")}${it.details.length > 12 ? "\n…" : ""}`
        : "";

      const tipText = `${it.name}\ntrvání: ${fmtSec(durSec)}${detailLines}`;

      return `
        <div
          data-tip="${escapeHtml(tipText)}"
          style="
            position:absolute;
            left:${l}%;
            width:${w}%;
            top:0;
            height:100%;
            background:${colorFor(it.name)};
            opacity:0.95;
            cursor:help;
          ">
        </div>
      `;
    } else {
      const l = ((it.ts - startTs) / totalMs) * 100;
      const relSec = (it.ts - startTs) / 1000;
      const tipText = `${it.name}\nčas: ${fmtSec(relSec)}${it.detail ? `\n${it.detail}` : ""}`;

      return `
        <div
          data-tip="${escapeHtml(tipText)}"
          style="
            position:absolute;
            left:${l}%;
            width:2px;
            top:0;
            height:100%;
            background:${colorFor(it.name)};
            opacity:0.95;
            cursor:help;
          ">
        </div>
      `;
    }
  }).join("");

  const legendHtml = buildLegendHtml(usedNames);

  // Slider ticks (text labels)
  const tick25 = fmtSec(totalSec * 0.25);
  const tick50 = fmtSec(totalSec * 0.50);
  const tick75 = fmtSec(totalSec * 0.75);
  const tick100 = fmtSec(totalSec);

  container.innerHTML = `
    <div style="
      border-radius:12px;
      background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.08);
      padding:10px;
      position:relative;
    " id="timelineWrap">

      <!-- marker spanning bar + legend area -->
      <div id="timelineMarker" style="
        position:absolute;
        top:10px;
        bottom:10px;
        width:2px;
        background:rgba(255,255,255,0.65);
        left:0%;
        pointer-events:none;
        transform:translateX(-1px);
      "></div>

      <!-- BAR -->
      <div style="
        position:relative;
        height:${barHeightPx}px;
        overflow:hidden;
        background:rgba(255,255,255,0.06);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:0;       /* remove rounded corners */
      " id="timelineBar">
        ${segmentsHtml}
      </div>

      <!-- X axis ticks -->
      <div class="row" style="justify-content:space-between; margin-top:10px;">
        <div class="muted small">0 s</div>
        <div class="muted small">${escapeHtml(tick25)}</div>
        <div class="muted small">${escapeHtml(tick50)}</div>
        <div class="muted small">${escapeHtml(tick75)}</div>
        <div class="muted small">${escapeHtml(tick100)}</div>
      </div>

      <!-- Slider + readout -->
      <div style="margin-top:12px;">
        <div class="row" style="align-items:center; gap:12px;">
          <div class="muted small" style="min-width:80px;">Čas</div>
          <input
            id="timelineSlider"
            type="range"
            min="0"
            max="${Math.round(totalMs)}"
            value="0"
            step="10"
            style="flex:1;"
          />
          <div class="muted small" id="timelineSliderTime" style="min-width:120px; text-align:right;">
            0.0 s
          </div>
        </div>

        <div id="timelineReadout" style="margin-top:10px;">
          <div class="metric-grid">
            <div class="metric">
              <div class="k">Event</div>
              <div class="v">—</div>
            </div>
            <div class="metric">
              <div class="k">Čas</div>
              <div class="v">0.0 s</div>
            </div>
            <div class="metric">
              <div class="k">Detail</div>
              <div class="v">—</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Legend -->
      ${legendHtml}

      <div class="muted small" style="margin-top:10px;">
        Hover: ukáže typ eventu + trvání/čas + text z <b>event_detail</b> (pokud je k dispozici).
        Slider: totéž pro konkrétní čas.
      </div>
    </div>
  `;

  // hover tooltip
  wireTimelineTooltip(container);

  // Slider wiring
  const slider = $("#timelineSlider");
  const marker = $("#timelineMarker");
  const timeEl = $("#timelineSliderTime");
  const readout = $("#timelineReadout");

  function updateFromTime(tMs) {
    const wrap = $("#timelineWrap");
    const bar = $("#timelineBar");

    if (marker && wrap && bar) {
      const wrapRect = wrap.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();

      // x pozice uvnitř baru (px)
      const xInBar = (tMs / totalMs) * barRect.width;

      // marker chceme umístit tak, aby seděl na bar (a tím i na segmenty),
      // ale zároveň spanoval celý wrap (osa + slider + legenda)
      const leftPx = (barRect.left - wrapRect.left) + xInBar;

      marker.style.left = `${leftPx}px`;
    }


    const sec = tMs / 1000;
    if (timeEl) timeEl.textContent = fmtSec(sec);

    const it = findItemAtTime(items, tMs);

    let ev = "—";
    let det = "—";
    if (it) {
      ev = it.name;

      if (it.type === "interval") {
        const d = (it.endTs - it.startTs) / 1000;
        const dLines = Array.isArray(it.details) && it.details.length
          ? it.details.slice(0, 6).join(" · ")
          : null;
        det = `trvání ${fmtSec(d)}${dLines ? ` · ${dLines}` : ""}`;
      } else {
        det = it.detail ?? "—";
      }
    }

    if (readout) {
      readout.innerHTML = `
        <div class="metric-grid">
          <div class="metric">
            <div class="k">Event</div>
            <div class="v">${escapeHtml(ev)}</div>
          </div>
          <div class="metric">
            <div class="k">Čas</div>
            <div class="v">${escapeHtml(fmtSec(sec))}</div>
          </div>
          <div class="metric">
            <div class="k">Detail</div>
            <div class="v">${escapeHtml(det)}</div>
          </div>
        </div>
      `;
    }
  }

  if (slider) {
    slider.addEventListener("input", () => {
      const tMs = Number(slider.value);
      updateFromTime(tMs);
    });

    // init state
    updateFromTime(0);

    window.addEventListener("resize", () => {
      const tMs = slider ? Number(slider.value) : 0;
      updateFromTime(tMs);
    });

  }
}

async function openTimelineModal() {
  const s = state.selectedSession;
  if (!s?.session_id) return;

  const modal = $("#timelineModal");
  const subtitle = $("#timelineModalSubtitle");
  const content = $("#timelineContent");

  if (subtitle) {
    subtitle.textContent = `Session: ${s.session_id} · user: ${s.user_id ?? "—"}`;
  }

  if (content) {
    content.innerHTML = `
      <div class="empty">
        <div class="empty-title">Načítám časovou osu…</div>
        <div class="muted small">Chvilku strpení.</div>
      </div>
    `;
  }

  show(modal);

  try {
    const payload = await apiGetSessionEvents(s.session_id);
    renderTimelineModalContent(payload);
  } catch (e) {
    if (content) {
      content.innerHTML = `
        <div class="empty">
          <div class="empty-title">Chyba</div>
          <div class="muted small">${escapeHtml(e?.message ?? e)}</div>
        </div>
      `;
    }
  }
}

function closeTimelineModal() {
  hide($("#timelineModal"));
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

  // NEW: Timeline button (on "Úlohy v session" page, right column)
  $("#openTimelineBtn")?.addEventListener("click", () => {
    openTimelineModal();
  });
}

function wireModal() {
  $("#closeTaskModalBtn")?.addEventListener("click", closeTaskModal);
  $("#closeTaskModalBtn2")?.addEventListener("click", closeTaskModal);
  $("#taskMetricsModal .modal-backdrop")?.addEventListener("click", closeTaskModal);

  // NEW: timeline modal close wiring (only if modal exists in HTML)
  $("#closeTimelineBtn")?.addEventListener("click", closeTimelineModal);
  $("#closeTimelineBtn2")?.addEventListener("click", closeTimelineModal);
  $("#timelineModalBackdrop")?.addEventListener("click", closeTimelineModal);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal1 = $("#taskMetricsModal");
      if (modal1 && !modal1.classList.contains("hidden")) closeTaskModal();

      const modal2 = $("#timelineModal");
      if (modal2 && !modal2.classList.contains("hidden")) closeTimelineModal();
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

function wireBulkUpload() {
  const input = $("#bulkCsvInput");
  if (!input) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Nahrávám hromadné CSV: ${file.name}…`;

    try {
      const out = await apiUploadBulk(file);
      if (statusEl) statusEl.textContent = `Nahráno hromadné CSV: ${out.count ?? 0} sessions`;

      await refreshSessions();
      renderTestAggMetrics();

      if (!state.selectedSessionId && out.sessions?.length) {
        const firstSessionId = out.sessions[0].session_id;
        state.selectedSessionId = firstSessionId;
        state.selectedSession = state.sessions.find(s => s.session_id === firstSessionId) ?? null;
      }

      if (!$("#view-individual")?.classList.contains("hidden")) {
        renderSessionsList();
        renderSessionMetrics();
      }

      if (!$("#view-group")?.classList.contains("hidden")) {
        renderTasksList();
      }

      if (!$("#view-settings")?.classList.contains("hidden")) {
        renderSettingsPage();
      }
    } catch (ex) {
      if (statusEl) statusEl.textContent = `Chyba: ${ex?.message ?? ex}`;
    } finally {
      input.value = "";
    }
  });
}

function wireSessionFilters() {
  const genderEl = $("#sessionFilterGender");
  const occupationEl = $("#sessionFilterOccupation");
  const nationalityEl = $("#sessionFilterNationality");
  const ageMinEl = $("#sessionFilterAgeMin");
  const ageMaxEl = $("#sessionFilterAgeMax");
  const userIdEl = $("#sessionFilterUserId");
  const clearBtn = $("#clearSessionFiltersBtn");

  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !userIdEl || !clearBtn) return;

  const updateAndRender = () => {
    state.sessionFilters.gender = genderEl.value;
    state.sessionFilters.occupation = occupationEl.value;
    state.sessionFilters.nationality = nationalityEl.value;
    state.sessionFilters.ageMin = ageMinEl.value;
    state.sessionFilters.ageMax = ageMaxEl.value;
    state.sessionFilters.userIdQuery = userIdEl.value;
    renderSessionsList();
  };

  genderEl.addEventListener("change", updateAndRender);
  occupationEl.addEventListener("change", updateAndRender);
  nationalityEl.addEventListener("change", updateAndRender);
  ageMinEl.addEventListener("input", updateAndRender);
  ageMaxEl.addEventListener("input", updateAndRender);
  userIdEl.addEventListener("input", updateAndRender);

  clearBtn.addEventListener("click", () => {
    state.sessionFilters = {
      gender: "",
      ageMin: "",
      ageMax: "",
      occupation: "",
      nationality: "",
      userIdQuery: "",
    };
    renderSessionsList();
  });
}

// ===== Init =====
async function init() {
  wireNavButtons();
  wireModal();
  wireUpload();
  wireBulkUpload();
  wireSessionFilters();

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

  (async () => {
    try {
      const out = await apiGetTestAnswers(state.selectedTestId ?? "TEST");
      state.correctAnswers[state.selectedTestId] = out.answers ?? {};
    } catch { /* ignore */ }
  })();
  
}

init();