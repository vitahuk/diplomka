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
  hide($("#view-groups"));
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

function fmtPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)} %`;
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

const TESTS_STORAGE_KEY = "maptrack_tests";
const SELECTED_TEST_STORAGE_KEY = "maptrack_selected_test";
const GROUP_DRAFT_SELECTION_KEY = "maptrack_group_selection";


// ===== App State =====
const state = {
  selectedTestId: "TEST",
  selectedSessionId: null,
  selectedSession: null,
  selectedTaskId: null,
  selectedSessionIds: [],
  sessions: [],
  tests: [],
  groups: [],
  selectedGroupId: null,
  selectedGroupCompareIds: [],
  groupsSearchQuery: "",
  groupCompareTab: "summary",
  groupCompareSort: { key: "avgDurationMs", direction: "desc" },
  groupTaskSearchQuery: "",
  selectedGroupCompareTaskId: null,
  groupTaskCompareSort: { key: "avgDurationMs", direction: "desc" },
  isGroupUsersExpanded: false,
  groupEditSessionIds: [],
  groupEditTab: "sessions",
  groupEditFilters: {
    gender: "",
    ageMin: "",
    ageMax: "",
    occupation: "",
    nationality: "",
    query: "",
  },
  pendingUpload: null,
  sessionFilters: {
    gender: "",
    ageMin: "",
    ageMax: "",
    occupation: "",
    nationality: "",
    userIdQuery: "",
  },
  // answers cache: testId -> { taskId -> text }
  correctAnswers: {},
  settingsTab: "answers",
  settingsSessionSelection: [],
  settingsSessionFilters: {
    gender: "",
    ageMin: "",
    ageMax: "",
    occupation: "",
    nationality: "",
    userIdQuery: "",
  },
  settingsDeleteTarget: null,
  testSettings: {},
  map: {
    leafletMap: null,
    baseLayers: null,
    pointsLayer: null,
    trajectoryLayer: null,
    trajectoryPointsLayer: null,
    endpointLayer: null,
    viewportLayer: null,
    viewportRectangles: [],
    isInitialized: false,
  },
  taskModalTab: "metrics",
  taskMap: {
    leafletMap: null,
    baseLayers: null,
    pointsLayer: null,
    trajectoryLayer: null,
    trajectoryPointsLayer: null,
    endpointLayer: null,
    viewportLayer: null,
    viewportRectangles: [],
    isInitialized: false,
  },
};

function normalizeTestId(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function loadTestsFromStorage() {
  let tests = [];
  try {
    const raw = localStorage.getItem(TESTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      tests = parsed.map(normalizeTestId).filter(Boolean);
    }
  } catch {
    tests = [];
  }

  if (!tests.length) tests = ["TEST"];
  tests = Array.from(new Set(tests));
  saveTestsToStorage(tests);
  return tests;
}

function saveTestsToStorage(tests) {
  try {
    localStorage.setItem(TESTS_STORAGE_KEY, JSON.stringify(tests));
  } catch {
    /* ignore */
  }
}

function loadSelectedTestFromStorage(tests) {
  try {
    const raw = localStorage.getItem(SELECTED_TEST_STORAGE_KEY);
    const selected = normalizeTestId(raw);
    if (selected && tests.includes(selected)) return selected;
  } catch {
    /* ignore */
  }
  return tests[0] ?? "TEST";
}

function saveSelectedTestToStorage(testId) {
  try {
    localStorage.setItem(SELECTED_TEST_STORAGE_KEY, testId);
  } catch {
    /* ignore */
  }
}

function syncTestsWithSessions(sessions) {
  const seen = new Set(state.tests);
  sessions.forEach((s) => {
    const testId = normalizeTestId(s.test_id) ?? "TEST";
    if (!seen.has(testId)) {
      seen.add(testId);
      state.tests.push(testId);
    }
  });
  state.tests = Array.from(new Set(state.tests));
  saveTestsToStorage(state.tests);
}

function getSessionsForSelectedTest() {
  const testId = state.selectedTestId ?? "TEST";
  return state.sessions.filter((s) => (s.test_id ?? "TEST") === testId);
}

function persistGroupDraftSelection() {
  try {
    localStorage.setItem(
      GROUP_DRAFT_SELECTION_KEY,
      JSON.stringify({ testId: state.selectedTestId ?? "TEST", sessionIds: state.selectedSessionIds ?? [] })
    );
  } catch {
    /* ignore */
  }
}

function loadGroupDraftSelectionForTest(testId) {
  try {
    const raw = localStorage.getItem(GROUP_DRAFT_SELECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.testId !== testId || !Array.isArray(parsed.sessionIds)) return [];
    return parsed.sessionIds.filter((id) => typeof id === "string" && id.trim());
  } catch {
    return [];
  }
}

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

async function apiUpload(file, testId) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("test_id", testId);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiUploadBulk(file, testId) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("test_id", testId);
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

async function apiDeleteSessions(testId, sessionIds) {
  const res = await fetch(`/api/tests/${encodeURIComponent(testId)}/sessions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_ids: sessionIds }),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiDeleteAllSessions(testId) {
  const res = await fetch(`/api/tests/${encodeURIComponent(testId)}/sessions/all`, { method: "DELETE" });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiGetTestSettings(testId) {
  return apiGet(`/api/tests/${encodeURIComponent(testId)}/settings`);
}

async function apiUpdateTestSettings(testId, payload) {
  const res = await fetch(`/api/tests/${encodeURIComponent(testId)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiDeleteTest(testId) {
  const res = await fetch(`/api/tests/${encodeURIComponent(testId)}`, { method: "DELETE" });
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

async function apiGetSessionAnswersEval(sessionId) {
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/answers-eval`);
}

async function apiListGroups(testId) {
  const q = testId ? `?test_id=${encodeURIComponent(testId)}` : "";
  return apiGet(`/api/groups${q}`);
}

async function apiCreateGroup(payload) {
  const res = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiUpdateGroup(groupId, payload) {
  const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiUpdateGroupSettings(groupId, payload) {
  const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiDeleteGroup(groupId) {
  const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

async function apiGetGroupAnswers(groupId) {
  return apiGet(`/api/groups/${encodeURIComponent(groupId)}/answers`);
}

async function apiGetGroupWordcloud(groupId, taskId = null) {
  const q = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
  return apiGet(`/api/groups/${encodeURIComponent(groupId)}/wordcloud${q}`);
}

async function apiCompareWordcloud(groupIds, taskId = null) {
  const res = await fetch(`/api/groups/compare/wordcloud`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_ids: groupIds, task_id: taskId }),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { }
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

// NEW: raw events for timeline
async function apiGetSessionEvents(sessionId) {
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
}

function apiGetSessionEventsExportUrl(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/events/export`;
}

async function apiGetSessionSpatialTrace(sessionId, taskId = null) {
  const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/spatial-trace${query}`);
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

function renderTestsList() {
  const listEl = $("#testsList");
  if (!listEl) return;

  if (!state.tests.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím žádné testy</div>
        <div class="muted small">Klikni na „Přidat test“ a vytvoř nový uživatelský test.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = state.tests.map((testId) => {
    const selected = testId === state.selectedTestId ? "is-selected" : "";
    const customName = String(state.testSettings?.[testId]?.name ?? "").trim();
    const displayName = customName || testId;
    return `
      <div class="list-item ${selected}" data-test="${escapeHtml(testId)}">
        <div class="row">
          <div class="title">${escapeHtml(displayName)}</div>
        </div>
        <div class="muted small">Test pro práci se sessions a nastavením správných odpovědí.</div>
        <div class="row actions">
          <button class="btn btn-ghost" data-action="settings" type="button">Nastavení</button>
          <button class="btn" data-action="open" type="button">Otevřít test</button>
        </div>
      </div>
    `;
  }).join("");

  $$("#testsList .list-item").forEach(item => {
    item.addEventListener("click", () => {
      selectTest(item.dataset.test);
    });
  });

  $$("#testsList [data-action]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const testId = btn.closest(".list-item")?.dataset.test;
      if (!testId) return;

      selectTest(testId);

      if (action === "settings") {
        setPage("settings");
        await loadAnswersForSelectedTest();
        await loadTestSettingsForSelectedTest();
        renderSettingsPage();
      } else if (action === "open") {
        setPage("individual");
        renderSessionsList();
        renderSessionMetrics();
      }
    });
  });
}

function renderTestAggMetrics() {
  const el = $("#testAggMetrics");
  if (!el) return;

  const sessions = getSessionsForSelectedTest();

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

  const options = getSessionFilterOptions(getSessionsForSelectedTest());
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
  return applyGenericSessionFilters(sessions, {
    gender: state.sessionFilters.gender,
    occupation: state.sessionFilters.occupation,
    nationality: state.sessionFilters.nationality,
    ageMin: state.sessionFilters.ageMin,
    ageMax: state.sessionFilters.ageMax,
    query: state.sessionFilters.userIdQuery,
  });
}

function applyGenericSessionFilters(sessions, filters = {}) {
  const genderFilter = normalizeFilterValue(filters.gender);
  const occupationFilter = normalizeFilterValue(filters.occupation);
  const nationalityFilter = normalizeFilterValue(filters.nationality);
  const ageMin = parseOptionalNumber(filters.ageMin);
  const ageMax = parseOptionalNumber(filters.ageMax);
  const query = normalizeSearchValue(filters.query);

  return sessions.filter((session) => {
    const soc = getSocDemo(session);
    const gender = normalizeFilterValue(soc.gender);
    const occupation = normalizeFilterValue(soc.occupation);
    const nationality = normalizeFilterValue(soc.nationality);
    const age = parseOptionalNumber(soc.age);
    const userId = normalizeSearchValue(session.user_id);
    const sessionId = normalizeSearchValue(session.session_id);

    if (genderFilter && genderFilter !== gender) return false;
    if (occupationFilter && occupationFilter !== occupation) return false;
    if (nationalityFilter && nationalityFilter !== nationality) return false;
    if (query && !userId.includes(query) && !sessionId.includes(query)) return false;

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

  const sessions = getSessionsForSelectedTest();
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
    const selectedCount = (state.selectedSessionIds ?? []).filter((sid) => sessions.some((s) => s.session_id === sid)).length;
    summaryEl.textContent = `Zobrazeno ${filteredSessions.length} z ${sessions.length} · Vybráno ${selectedCount}`;
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

    const checked = (state.selectedSessionIds ?? []).includes(s.session_id) ? "checked" : "";

    return `
      <div class="list-item ${selected}" data-session="${escapeHtml(s.session_id)}">
        <div class="row">
          <div class="row" style="justify-content:flex-start; gap:8px;">
            <input type="checkbox" data-role="group-select" data-session="${escapeHtml(s.session_id)}" ${checked} />
            <div class="title">${escapeHtml(s.session_id)}</div>
          </div>
          <span class="pill">events: ${escapeHtml(events)}</span>
        </div>
        <div class="muted small">
          user: ${escapeHtml(user)} · tasks: ${escapeHtml(tasksCount)} · délka: ${escapeHtml(dur)}
        </div>
      </div>
    `;

  }).join("");

  $$("#sessionsList .list-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target?.matches?.('input[data-role="group-select"]')) return;
      const id = item.dataset.session;
      selectSession(id);
    });
  });

  $$("#sessionsList input[data-role='group-select']").forEach((input) => {
    input.addEventListener("change", () => {
      const sessionId = input.dataset.session;
      if (!sessionId) return;

      const selected = new Set(state.selectedSessionIds ?? []);
      if (input.checked) selected.add(sessionId);
      else selected.delete(sessionId);

      state.selectedSessionIds = Array.from(selected);
      persistGroupDraftSelection();
      renderSessionsList();
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
  const answersSummary = s.stats?.answers_eval?.summary ?? {};

  renderMetricGrid({
    "Session ID": s.session_id,
    "User": s.user_id ?? "—",
    "Počet tasků": sessionStats.tasks_count ?? (Array.isArray(s.tasks) ? s.tasks.length : "—"),
    "Počet eventů": sessionStats.events_total ?? "—",
    "Celkový čas řešení": fmtMs(sessionStats.duration_ms),
    "Průměrná správnost odpovědí": fmtPercent(answersSummary.accuracy),

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
  const sessions = getSessionsForSelectedTest();
  const set = new Set();
  for (const s of sessions) {
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

async function loadTestSettingsForSelectedTest() {
  const testId = state.selectedTestId ?? "TEST";
  try {
    const out = await apiGetTestSettings(testId);
    state.testSettings[testId] = {
      name: String(out?.name ?? "").trim(),
      note: String(out?.note ?? ""),
    };
  } catch {
    state.testSettings[testId] = state.testSettings[testId] ?? { name: "", note: "" };
  }
}

function getCurrentTestDisplayName() {
  const testId = state.selectedTestId ?? "TEST";
  const saved = state.testSettings?.[testId]?.name;
  return String(saved ?? "").trim() || testId;
}

function getCorrectAnswerLocal(testId, taskId) {
  return state.correctAnswers?.[testId]?.[taskId];
}

async function setCorrectAnswerPersisted(testId, taskId, answerTextOrNull) {
  // optimistic update
  if (!state.correctAnswers[testId]) state.correctAnswers[testId] = {};
  if (answerTextOrNull === null) {
    delete state.correctAnswers[testId][taskId];
  } else {
    state.correctAnswers[testId][taskId] = answerTextOrNull;
  }

  try {
    renderSettingsStatus("Ukládám…");
    await apiPutTestAnswer(testId, taskId, answerTextOrNull);
    renderSettingsStatus("Uloženo.");
  } catch (e) {
    renderSettingsStatus(`Chyba uložení: ${e?.message ?? e}`);
  }
}

function renderSettingsSessionFilterControls() {
  const genderEl = $("#settingsSessionFilterGender");
  const occupationEl = $("#settingsSessionFilterOccupation");
  const nationalityEl = $("#settingsSessionFilterNationality");
  const ageMinEl = $("#settingsSessionFilterAgeMin");
  const ageMaxEl = $("#settingsSessionFilterAgeMax");
  const userIdEl = $("#settingsSessionFilterUserId");
  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !userIdEl) return;

  const options = getSessionFilterOptions(getSessionsForSelectedTest());
  const makeOptions = (values, emptyLabel) => {
    const base = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    return base.concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  };

  genderEl.innerHTML = makeOptions(options.gender, "Vše");
  occupationEl.innerHTML = makeOptions(options.occupation, "Vše");
  nationalityEl.innerHTML = makeOptions(options.nationality, "Vše");

  genderEl.value = state.settingsSessionFilters.gender;
  occupationEl.value = state.settingsSessionFilters.occupation;
  nationalityEl.value = state.settingsSessionFilters.nationality;
  ageMinEl.value = state.settingsSessionFilters.ageMin;
  ageMaxEl.value = state.settingsSessionFilters.ageMax;
  userIdEl.value = state.settingsSessionFilters.userIdQuery;
}

function applySettingsSessionFilters(sessions) {
  return applyGenericSessionFilters(sessions, {
    gender: state.settingsSessionFilters.gender,
    occupation: state.settingsSessionFilters.occupation,
    nationality: state.settingsSessionFilters.nationality,
    ageMin: state.settingsSessionFilters.ageMin,
    ageMax: state.settingsSessionFilters.ageMax,
    query: state.settingsSessionFilters.userIdQuery,
  });
}

function renderSettingsSessionsTab() {
  const listEl = $("#settingsSessionsList");
  const summaryEl = $("#settingsSessionFilterSummary");
  const statusEl = $("#settingsSessionStatus");
  if (!listEl) return;

  const sessions = getSessionsForSelectedTest();
  renderSettingsSessionFilterControls();

  const validSet = new Set(sessions.map((s) => s.session_id));
  state.settingsSessionSelection = (state.settingsSessionSelection ?? []).filter((sid) => validSet.has(sid));

  const filtered = applySettingsSessionFilters(sessions);
  const selectedSet = new Set(state.settingsSessionSelection);

  if (summaryEl) summaryEl.textContent = `Zobrazeno ${filtered.length} z ${sessions.length} · Vybráno ${selectedSet.size}`;
  if (statusEl && !statusEl.textContent) statusEl.textContent = "—";

  if (!sessions.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">V tomto testu zatím nejsou sessions</div></div>`;
    return;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">Žádná session neodpovídá filtru</div></div>`;
    return;
  }
  listEl.innerHTML = filtered.map((s) => {
    const checked = selectedSet.has(s.session_id) ? "checked" : "";
    return `
      <label class="list-item" style="cursor:default;">
        <div class="row" style="justify-content:flex-start; gap:10px;">
          <input type="checkbox" data-role="settings-session" data-session="${escapeHtml(s.session_id)}" ${checked} />
          <div>
            <div class="title">${escapeHtml(s.user_id ?? "—")}</div>
            <div class="muted small">session: ${escapeHtml(s.session_id)} · task: ${escapeHtml((s.tasks && s.tasks[0]) || s.task || "—")}</div>
          </div>
        </div>
      </label>
    `;
  }).join("");

  $$("#settingsSessionsList input[data-role='settings-session']").forEach((input) => {
    input.addEventListener("change", () => {
      const sid = input.dataset.session;
      if (!sid) return;
      const set = new Set(state.settingsSessionSelection ?? []);
      if (input.checked) set.add(sid);
      else set.delete(sid);
      state.settingsSessionSelection = Array.from(set);
      renderSettingsSessionsTab();
    });
  });
}

function renderSettingsPage() {
  const testId = state.selectedTestId ?? "TEST";

  const nameEl = $("#settingsTestName");
  if (nameEl) nameEl.textContent = getCurrentTestDisplayName();

  const tabs = $$("#settingsTabs .tab-btn");
  tabs.forEach((btn) => {
    const active = btn.dataset.tab === state.settingsTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });


  $$("#view-settings .tab-panel").forEach((panel) => {
    const key = panel.dataset.panel;
    panel.classList.toggle("hidden", key !== state.settingsTab);
  });

  const userTestNameEl = $("#settingsUserTestNameInput");
  const userTestNoteEl = $("#settingsUserTestNoteInput");
  const userSettings = state.testSettings?.[testId] ?? { name: "", note: "" };
  if (userTestNameEl) userTestNameEl.value = String(userSettings.name ?? "");
  if (userTestNoteEl) userTestNoteEl.value = String(userSettings.note ?? "");

  const listEl = $("#settingsTasksList");
  if (listEl) {
    const tasks = getAllTasksForSelectedTest();

    if (!tasks.length) {
      listEl.innerHTML = `
        <div class="empty">
          <div class="empty-title">Zatím žádné úlohy</div>
          <div class="muted small">Nahraj aspoň jednu session (CSV), aby se načetly názvy úloh.</div>
        </div>
      `;
    } else {
      listEl.innerHTML = tasks.map((taskId) => {
        const val = getCorrectAnswerLocal(testId, taskId);
        const valueAttr = (val === null || val === undefined) ? "" : String(val);

        return `
          <div class="list-item" data-task="${escapeHtml(taskId)}">
            <div class="row" style="align-items:center; justify-content:space-between; gap:12px;">
              <div>
                <div class="title">${escapeHtml(taskId)}</div>
                <div class="muted small">Správná odpověď (text)</div>
              </div>

              <input
                type="text"
                inputmode="text"
                value="${escapeHtml(valueAttr)}"
                placeholder="např. Praha"
                style="width:140px;"
              />
            </div>
          </div>
        `;
      }).join("");

      $$("#settingsTasksList .list-item").forEach((item) => {
        const taskId = item.dataset.task;
        const input = item.querySelector("input");
        if (!input) return;

        input.addEventListener("change", async () => {
          const raw = String(input.value ?? "").trim();

          if (raw === "") {
            await setCorrectAnswerPersisted(testId, taskId, null);
            return;
          }

          input.value = raw;
          await setCorrectAnswerPersisted(testId, taskId, raw);
        });
      });
    }
  }

  renderSettingsSessionsTab();
}

function openSettingsDeleteConfirmModal(mode) {
  const sessions = getSessionsForSelectedTest();
  const filtered = applySettingsSessionFilters(sessions);
  const selectedIds = (state.settingsSessionSelection ?? []).filter((sid) => sessions.some((s) => s.session_id === sid));

  let count = 0;
  if (mode === "all") count = sessions.length;
  else count = selectedIds.length;

  if (mode === "test") {
    state.settingsDeleteTarget = { mode: "test", count: 1 };
    const textEl = $("#settingsDeleteConfirmText");
    if (textEl) {
      textEl.textContent = "Chystáte se smazat celý uživatelský test včetně všech sessions, skupin, odpovědí a dalších navázaných dat. Opravdu si přejete pokračovat?";
    }
    show($("#settingsDeleteConfirmModal"));
    return;
  }

  if (!count) {
    const statusEl = $("#settingsSessionStatus");
    if (statusEl) statusEl.textContent = mode === "all" ? "V testu nejsou žádné sessions ke smazání." : "Vyber nejprve aspoň jednu session.";
    return;
  }

  state.settingsDeleteTarget = {
    mode,
    sessionIds: mode === "all" ? sessions.map((s) => s.session_id) : selectedIds,
    count,
    filteredCount: filtered.length,
  };

  const textEl = $("#settingsDeleteConfirmText");
  if (textEl) {
    textEl.textContent = `Chystáte se smazat ${count} sessions. Tímto dojde k jejich odstranění z databáze. Opravdu si přejete pokračovat?`;
  }
  show($("#settingsDeleteConfirmModal"));
}

function closeSettingsDeleteConfirmModal() {
  state.settingsDeleteTarget = null;
  hide($("#settingsDeleteConfirmModal"));
}

async function confirmDeleteSettingsSessions() {
  const target = state.settingsDeleteTarget;
  if (!target) return;

  const testId = state.selectedTestId ?? "TEST";
  const statusEl = $("#settingsSessionStatus");

  try {
    if (target.mode === "test") {
      const deletingTestId = state.selectedTestId ?? "TEST";
      if (statusEl) statusEl.textContent = "Mazání uživatelského testu…";
      await apiDeleteTest(deletingTestId);
      state.testSettings[deletingTestId] = { name: "", note: "" };
      state.tests = (state.tests ?? []).filter((id) => id !== deletingTestId);
      if (!state.tests.length) state.tests = ["TEST"];
      saveTestsToStorage(state.tests);
      selectTest(state.tests[0]);
      await refreshSessions();
      await refreshGroups();
      renderTests();
      renderSettingsPage();
      renderSessionsList();
      renderTestAggMetrics();
      if (statusEl) statusEl.textContent = "Uživatelský test byl smazán.";
      setPage("dashboard");
      return;
    }

    if (statusEl) statusEl.textContent = "Mazání session…";
    if (target.mode === "all") {
      await apiDeleteAllSessions(testId);
    } else {
      await apiDeleteSessions(testId, target.sessionIds ?? []);
    }

    await refreshSessions();
    await refreshGroups();
    renderSettingsPage();
    renderSessionsList();
    renderTestAggMetrics();

    state.settingsSessionSelection = [];
    if (statusEl) statusEl.textContent = `Smazáno: ${target.count} sessions.`;
  } catch (e) {
    if (statusEl) statusEl.textContent = `Chyba mazání: ${e?.message ?? e}`;
  } finally {
    closeSettingsDeleteConfirmModal();
  }
}

async function saveUserTestSettings() {
  const testId = state.selectedTestId ?? "TEST";
  const nameInput = $("#settingsUserTestNameInput");
  const noteInput = $("#settingsUserTestNoteInput");
  const statusEl = $("#settingsUserTestStatus");

  const name = String(nameInput?.value ?? "").trim();
  const note = String(noteInput?.value ?? "");

  try {
    if (statusEl) statusEl.textContent = "Ukládám nastavení testu…";
    const out = await apiUpdateTestSettings(testId, { name, note });
    state.testSettings[testId] = { name: String(out?.name ?? ""), note: String(out?.note ?? "") };
    renderTestsList();
    renderSettingsPage();
    if (statusEl) statusEl.textContent = "Uloženo.";
  } catch (e) {
    if (statusEl) statusEl.textContent = `Chyba uložení: ${e?.message ?? e}`;
  }
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
  state.taskModalTab = "metrics";

  const modal = $("#taskMetricsModal");
  const subtitle = $("#taskModalSubtitle");
  const metrics = $("#taskModalMetrics");

  const s = state.selectedSession;

  if (subtitle) {
    subtitle.textContent = `Session: ${s?.session_id ?? "—"} · Úloha: ${taskId}`;
  }

  if (metrics) {
    metrics.innerHTML = `
      <div class="empty">
        <div class="empty-title">Načítám metriky…</div>
        <div class="muted small">Chvilku strpení.</div>
      </div>
    `;
  }

  renderTaskModalTabs();
  show(modal);

  ensureTaskMapInitialized();
  clearTaskMapData();
  syncTaskMapLegend();
  if (state.taskMap.leafletMap) {
    setTimeout(() => state.taskMap.leafletMap.invalidateSize(), 50);
  }

  if (!s?.session_id) {
    setTaskMapPlaceholderStatus({ title: "Vyber session", detail: "Bez vybrané session nelze načíst mapová data." });
    return;
  }

  loadTaskSpatialTraceIntoMap(s.session_id, taskId).catch((e) => {
    clearTaskMapData();
    setTaskMapPlaceholderStatus({ title: "Chyba při načítání dat", detail: e?.message ?? String(e), isError: true });
  });

  try {
    const m = await apiGetTaskMetrics(s.session_id, taskId);

    renderMetricGrid({
      "Čas řešení úlohy": fmtMs(m.duration_ms),
      "Počet eventů v úloze": m.events_total ?? "—",
      "Odpověď uživatele": m.answer ?? "—",
      "Správná odpověď": m.correct_answer ?? "—",
      "Správně": m.is_correct === true ? "ANO" : (m.is_correct === false ? "NE" : "—"),
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

function getTaskMapControlsState() {
  return {
    showPoints: $("#taskMapShowPoints")?.checked ?? true,
    showTrajectory: $("#taskMapShowTrajectory")?.checked ?? true,
    showEndpoints: $("#taskMapShowEndpoints")?.checked ?? true,
    showViewportRects: $("#taskMapShowViewportRects")?.checked ?? false,
    showAllViewportRects: $("#taskMapShowAllViewportRects")?.checked ?? false,
    pointsColor: $("#taskMapPointsColorInput")?.value ?? "#4cc9f0",
    lineColor: $("#taskMapLineColorInput")?.value ?? "#f72585",
  };
}

function syncTaskMapLegend() {
  const controls = getTaskMapControlsState();
  const pointSwatch = $("#taskMapLegendPointSwatch");
  const lineSwatch = $("#taskMapLegendLineSwatch");
  const endpointSwatch = $("#taskMapLegendEndpointSwatch");
  const viewportSwatch = $("#taskMapLegendViewportSwatch");
  if (pointSwatch) {
    pointSwatch.style.background = controls.pointsColor;
    pointSwatch.style.opacity = controls.showPoints ? "1" : ".35";
  }
  if (lineSwatch) {
    lineSwatch.style.borderTopColor = controls.lineColor;
    lineSwatch.style.opacity = controls.showTrajectory ? "1" : ".35";
  }
  if (endpointSwatch) endpointSwatch.style.opacity = controls.showEndpoints ? "1" : ".35";
  if (viewportSwatch) viewportSwatch.style.opacity = controls.showViewportRects ? "1" : ".35";
}

function applyTaskMapLayerStyles() {
  const controls = getTaskMapControlsState();
  const pointsLayer = state.taskMap.pointsLayer;
  const trajectoryLayer = state.taskMap.trajectoryLayer;
  const trajectoryPointsLayer = state.taskMap.trajectoryPointsLayer;
  const endpointLayer = state.taskMap.endpointLayer;
  const viewportLayer = state.taskMap.viewportLayer;
  const showAllEl = $("#taskMapShowAllViewportRects");
  if (showAllEl) {
    showAllEl.disabled = !controls.showViewportRects;
    if (!controls.showViewportRects) showAllEl.checked = false;
  }

  if (pointsLayer?.setStyle) {
    pointsLayer.setStyle({ color: controls.pointsColor, fillColor: controls.pointsColor, fillOpacity: 0.9, radius: 6, weight: 1 });
  }
  if (trajectoryLayer?.setStyle) {
    trajectoryLayer.setStyle({ color: controls.lineColor, weight: 4, opacity: 0.9 });
  }
  if (trajectoryPointsLayer?.setStyle) {
    trajectoryPointsLayer.setStyle({ color: controls.lineColor, fillColor: controls.lineColor, fillOpacity: 0.8, radius: 5, weight: 1 });
  }
  if (endpointLayer?.setStyle) {
    endpointLayer.setStyle({ color: "#ff9f1c", fillColor: "#ff9f1c", fillOpacity: 0.95, radius: 8, weight: 2 });
  }

  const map = state.taskMap.leafletMap;
  if (map && pointsLayer) {
    const hasLayer = map.hasLayer(pointsLayer);
    if (controls.showPoints && !hasLayer) map.addLayer(pointsLayer);
    if (!controls.showPoints && hasLayer) map.removeLayer(pointsLayer);
  }
  if (map && trajectoryLayer) {
    const hasLayer = map.hasLayer(trajectoryLayer);
    if (controls.showTrajectory && !hasLayer) map.addLayer(trajectoryLayer);
    if (!controls.showTrajectory && hasLayer) map.removeLayer(trajectoryLayer);
  }
  if (map && trajectoryPointsLayer) {
    const hasLayer = map.hasLayer(trajectoryPointsLayer);
    if (controls.showTrajectory && !hasLayer) map.addLayer(trajectoryPointsLayer);
    if (!controls.showTrajectory && hasLayer) map.removeLayer(trajectoryPointsLayer);
  }
  if (map && endpointLayer) {
    const hasLayer = map.hasLayer(endpointLayer);
    if (controls.showEndpoints && !hasLayer) map.addLayer(endpointLayer);
    if (!controls.showEndpoints && hasLayer) map.removeLayer(endpointLayer);
  }
  if (map && viewportLayer) {
    const hasLayer = map.hasLayer(viewportLayer);
    if (controls.showViewportRects && !hasLayer) map.addLayer(viewportLayer);
    if (!controls.showViewportRects && hasLayer) map.removeLayer(viewportLayer);
  }

  updateViewportRectanglesVisibility(state.taskMap, controls);

  syncTaskMapLegend();
}

function setTaskMapPlaceholderStatus({ title, detail, isError = false }) {
  const box = $("#taskMapDataPlaceholder");
  if (!box) return;
  box.innerHTML = `<div class="empty-title">${escapeHtml(title ?? "Stav mapy")}</div><div class="muted small${isError ? "" : ""}">${escapeHtml(detail ?? "")}</div>`;
}

function updateViewportRectanglesVisibility(mapState, controls) {
  const rectangles = Array.isArray(mapState?.viewportRectangles) ? mapState.viewportRectangles : [];
  rectangles.forEach((rect) => {
    if (!rect) return;
    const isVisible = Boolean(controls?.showViewportRects) && Boolean(controls?.showAllViewportRects || rect.__isHovered);
    const style = { opacity: isVisible ? 0.95 : 0, fillOpacity: isVisible ? 0.1 : 0 };
    if (rect.setStyle) {
      rect.setStyle(style);
      return;
    }
    if (rect.eachLayer) {
      rect.eachLayer((child) => child?.setStyle?.(style));
    }
  });
}

function clearTaskMapData() {
  state.taskMap.pointsLayer?.clearLayers?.();
  state.taskMap.trajectoryLayer?.clearLayers?.();
  state.taskMap.trajectoryPointsLayer?.clearLayers?.();
  state.taskMap.endpointLayer?.clearLayers?.();
  state.taskMap.viewportLayer?.clearLayers?.();
  state.taskMap.viewportRectangles = [];
}

function ensureTaskMapInitialized() {
  if (state.taskMap.isInitialized) return;
  if (typeof L === "undefined") return;

  const mapEl = $("#taskLeafletMap");
  if (!mapEl) return;

  const leafletMap = L.map(mapEl, { center: [49.8175, 15.473], zoom: 7, zoomControl: true });

  const osmStandard = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const cartoVoyager = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  });
  const opentopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
  });
  osmStandard.addTo(leafletMap);

  const baseLayers = { "OpenStreetMap": osmStandard, "CARTO Voyager": cartoVoyager, "OpenTopoMap": opentopo };

  const pointsLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6, color: "#4cc9f0", fillColor: "#4cc9f0", fillOpacity: 0.9, weight: 1 }),
  }).addTo(leafletMap);

  const trajectoryLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, { style: { color: "#f72585", weight: 4, opacity: 0.9 } }).addTo(leafletMap);

  const trajectoryPointsLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color: "#f72585", fillColor: "#f72585", fillOpacity: 0.8, weight: 1 }),
  }).addTo(leafletMap);

  const endpointLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 8, color: "#ff9f1c", fillColor: "#ff9f1c", fillOpacity: 0.95, weight: 2 }),
  }).addTo(leafletMap);

  const viewportLayer = L.layerGroup().addTo(leafletMap);

  L.control.layers(baseLayers, {
    "Body": pointsLayer,
    "Trajektorie": trajectoryLayer,
    "Body trajektorie": trajectoryPointsLayer,
    "Začátek/konec": endpointLayer,
    "Viewport obdélníky": viewportLayer,
  }, { collapsed: false }).addTo(leafletMap);

  state.taskMap = {
    leafletMap,
    baseLayers,
    pointsLayer,
    trajectoryLayer,
    trajectoryPointsLayer,
    endpointLayer,
    viewportLayer,
    viewportRectangles: [],
    isInitialized: true,
  };
  applyTaskMapLayerStyles();
}

function fitTaskMapToRenderedData() {
  const map = state.taskMap.leafletMap;
  const pointsLayer = state.taskMap.pointsLayer;
  const trajectoryLayer = state.taskMap.trajectoryLayer;
  const trajectoryPointsLayer = state.taskMap.trajectoryPointsLayer;
  const endpointLayer = state.taskMap.endpointLayer;
  if (!map || !pointsLayer || !trajectoryLayer || !trajectoryPointsLayer || !endpointLayer) return;
  const group = L.featureGroup([pointsLayer, trajectoryLayer, trajectoryPointsLayer, endpointLayer]);
  const bounds = group.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
}

function renderTaskSpatialTraceToMap(spatialPayload) {
  ensureTaskMapInitialized();
  clearTaskMapData();

  const spatial = spatialPayload?.spatial ?? { track: { points: [] }, popups: [] };
  state.taskMap.pointsLayer?.addData?.(buildPointsFeatureCollection(spatial));
  state.taskMap.trajectoryLayer?.addData?.(buildTrackFeatureCollection(spatial));
  state.taskMap.trajectoryPointsLayer?.addData?.(buildTrackPointFeatureCollection(spatial));
  state.taskMap.endpointLayer?.addData?.(buildEndpointFeatureCollection(spatial));

  state.taskMap.viewportRectangles = [];
  const viewportLayer = state.taskMap.viewportLayer;
  if (viewportLayer?.clearLayers) viewportLayer.clearLayers();

  state.taskMap.pointsLayer?.eachLayer?.((layer) => {
    const name = layer?.feature?.properties?.name ?? "—";
    const ts = layer?.feature?.properties?.timestamp;
    const label = Number.isFinite(Number(ts)) ? `${name} (${Number(ts)})` : String(name);
    layer.bindTooltip(label, { direction: "top", offset: [0, -8] });
  });
  state.taskMap.endpointLayer?.eachLayer?.((layer) => {
    const kind = layer?.feature?.properties?.kind ?? "Bod";
    const ts = layer?.feature?.properties?.timestamp;
    const label = Number.isFinite(Number(ts)) ? `${kind} (${Number(ts)})` : String(kind);
    layer.bindTooltip(label, { direction: "top", offset: [0, -8] });
  });

  state.taskMap.trajectoryPointsLayer?.eachLayer?.((layer) => {
    const bounds = layer?.feature?.properties?.viewportBounds;
    const ts = layer?.feature?.properties?.timestamp;
    const zoom = layer?.feature?.properties?.zoom;
    const labelParts = [];
    if (Number.isFinite(Number(ts))) labelParts.push(`t=${Number(ts)}`);
    if (Number.isFinite(Number(zoom))) labelParts.push(`z=${Number(zoom)}`);
    layer.bindTooltip(labelParts.join(" · ") || "Bod trajektorie", { direction: "top", offset: [0, -8] });

    const rect = makeViewportRectangle(bounds);
    if (rect && viewportLayer?.addLayer) {
      rect.__isHovered = false;
      viewportLayer.addLayer(rect);
      state.taskMap.viewportRectangles.push(rect);
      layer.on("mouseover", () => {
        rect.__isHovered = true;
        updateViewportRectanglesVisibility(state.taskMap, getTaskMapControlsState());
      });
      layer.on("mouseout", () => {
        rect.__isHovered = false;
        updateViewportRectanglesVisibility(state.taskMap, getTaskMapControlsState());
      });
    }
  });

  applyTaskMapLayerStyles();
  fitTaskMapToRenderedData();

  const pointCount = Array.isArray(spatial?.popups) ? spatial.popups.length : 0;
  const trackCount = Array.isArray(spatial?.track?.points) ? spatial.track.points.length : 0;
  const viewportCount = Array.isArray(spatial?.track?.samples)
    ? spatial.track.samples.filter((p) => Array.isArray(p?.viewportBounds)).length
    : 0;
  const endpoints = spatial?.movementEndpoints ?? {};
  const endpointCount = (endpoints?.start ? 1 : 0) + (endpoints?.end ? 1 : 0);
  setTaskMapPlaceholderStatus({ title: "Data načtena", detail: `Body (popupopen): ${pointCount} · Body trajektorie (moveend): ${trackCount} · Začátek/konec: ${endpointCount} · Viewport obdélníky: ${viewportCount}` });
}

async function loadTaskSpatialTraceIntoMap(sessionId, taskId) {
  setTaskMapPlaceholderStatus({ title: "Načítám mapová data…", detail: "Probíhá příprava trajektorie a popup bodů pro úlohu." });
  const payload = await apiGetSessionSpatialTrace(sessionId, taskId);
  renderTaskSpatialTraceToMap(payload);
}

function renderTaskModalTabs() {
  $$("#taskModalTabs .tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === state.taskModalTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$("#taskMetricsModal [data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.panel !== state.taskModalTab);
  });

  if (state.taskModalTab === "map" && state.taskMap.leafletMap) {
    setTimeout(() => state.taskMap.leafletMap.invalidateSize(), 50);
  }
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

async function exportTimelineCsvForSelectedSession() {
  const s = state.selectedSession;
  if (!s?.session_id) return;

  const baseName = `gazeplotter_timeline_${s.session_id}`;
  const suggested = `${baseName}.csv`;
  const userInput = window.prompt("Název exportovaného souboru:", suggested);
  if (userInput === null) return;

  let fileName = String(userInput || "").trim() || suggested;
  if (!fileName.toLowerCase().endsWith(".csv")) fileName += ".csv";

  const btn = $("#exportTimelineCsvBtn");
  const originalLabel = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Exportuji…";
  }

  try {
    const res = await fetch(apiGetSessionEventsExportUrl(s.session_id));
    if (!res.ok) {
      let err = {};
      try { err = await res.json(); } catch { }
      throw new Error(err.detail ?? res.statusText);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    window.alert(`Export selhal: ${e?.message ?? e}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Export CSV (GazePlotter)";
    }
  }
}

function getMapControlsState() {
  return {
    showPoints: $("#mapShowPoints")?.checked ?? true,
    showTrajectory: $("#mapShowTrajectory")?.checked ?? true,
    showEndpoints: $("#mapShowEndpoints")?.checked ?? true,
    showViewportRects: $("#mapShowViewportRects")?.checked ?? false,
    showAllViewportRects: $("#mapShowAllViewportRects")?.checked ?? false,
    pointsColor: $("#mapPointsColorInput")?.value ?? "#4cc9f0",
    lineColor: $("#mapLineColorInput")?.value ?? "#f72585",
  };
}

function syncMapLegend() {
  const controls = getMapControlsState();
  const pointSwatch = $("#mapLegendPointSwatch");
  const lineSwatch = $("#mapLegendLineSwatch");
  const endpointSwatch = $("#mapLegendEndpointSwatch");
  const viewportSwatch = $("#mapLegendViewportSwatch");
  if (pointSwatch) {
    pointSwatch.style.background = controls.pointsColor;
    pointSwatch.style.opacity = controls.showPoints ? "1" : ".35";
  }
  if (lineSwatch) {
    lineSwatch.style.borderTopColor = controls.lineColor;
    lineSwatch.style.opacity = controls.showTrajectory ? "1" : ".35";
  }
  if (endpointSwatch) {
    endpointSwatch.style.opacity = controls.showEndpoints ? "1" : ".35";
  }
  if (viewportSwatch) {
    viewportSwatch.style.opacity = controls.showViewportRects ? "1" : ".35";
  }
}

function applyMapLayerStyles() {
  const controls = getMapControlsState();
  const pointsLayer = state.map.pointsLayer;
  const trajectoryLayer = state.map.trajectoryLayer;
  const trajectoryPointsLayer = state.map.trajectoryPointsLayer;
  const endpointLayer = state.map.endpointLayer;
  const viewportLayer = state.map.viewportLayer;
  const showAllEl = $("#mapShowAllViewportRects");
  if (showAllEl) {
    showAllEl.disabled = !controls.showViewportRects;
    if (!controls.showViewportRects) showAllEl.checked = false;
  }

  if (pointsLayer?.setStyle) {
    pointsLayer.setStyle({
      color: controls.pointsColor,
      fillColor: controls.pointsColor,
      fillOpacity: 0.9,
      radius: 6,
      weight: 1,
    });
  }

  if (trajectoryLayer?.setStyle) {
    trajectoryLayer.setStyle({
      color: controls.lineColor,
      weight: 4,
      opacity: 0.9,
    });
  }

  if (trajectoryPointsLayer?.setStyle) {
    trajectoryPointsLayer.setStyle({
      color: controls.lineColor,
      fillColor: controls.lineColor,
      fillOpacity: 0.8,
      radius: 5,
      weight: 1,
    });
  }

  if (endpointLayer?.setStyle) {
    endpointLayer.setStyle({
      color: "#ff9f1c",
      fillColor: "#ff9f1c",
      fillOpacity: 0.95,
      radius: 8,
      weight: 2,
    });
  }

  const map = state.map.leafletMap;
  if (map && pointsLayer) {
    const hasLayer = map.hasLayer(pointsLayer);
    if (controls.showPoints && !hasLayer) map.addLayer(pointsLayer);
    if (!controls.showPoints && hasLayer) map.removeLayer(pointsLayer);
  }

  if (map && trajectoryLayer) {
    const hasLayer = map.hasLayer(trajectoryLayer);
    if (controls.showTrajectory && !hasLayer) map.addLayer(trajectoryLayer);
    if (!controls.showTrajectory && hasLayer) map.removeLayer(trajectoryLayer);
  }

  if (map && endpointLayer) {
    const hasLayer = map.hasLayer(endpointLayer);
    if (controls.showEndpoints && !hasLayer) map.addLayer(endpointLayer);
    if (!controls.showEndpoints && hasLayer) map.removeLayer(endpointLayer);
  }
  
  if (map && trajectoryPointsLayer) {
    const hasLayer = map.hasLayer(trajectoryPointsLayer);
    if (controls.showTrajectory && !hasLayer) map.addLayer(trajectoryPointsLayer);
    if (!controls.showTrajectory && hasLayer) map.removeLayer(trajectoryPointsLayer);
  }

  if (map && viewportLayer) {
    const hasLayer = map.hasLayer(viewportLayer);
    if (controls.showViewportRects && !hasLayer) map.addLayer(viewportLayer);
    if (!controls.showViewportRects && hasLayer) map.removeLayer(viewportLayer);
  }

  updateViewportRectanglesVisibility(state.map, controls);

  syncMapLegend();
}

function setMapPlaceholderStatus({ title, detail, isError = false }) {
  const box = $("#mapDataPlaceholder");
  if (!box) return;
  box.innerHTML = `
    <div class="empty-title">${escapeHtml(title ?? "Stav mapy")}</div>
    <div class="muted small${isError ? "" : ""}">${escapeHtml(detail ?? "")}</div>
  `;
}

function clearSessionMapData() {
  state.map.pointsLayer?.clearLayers?.();
  state.map.trajectoryLayer?.clearLayers?.();
  state.map.trajectoryPointsLayer?.clearLayers?.();
  state.map.endpointLayer?.clearLayers?.();
  state.map.viewportLayer?.clearLayers?.();
  state.map.viewportRectangles = [];
}

function buildPointsFeatureCollection(spatial) {
  const popups = Array.isArray(spatial?.popups) ? spatial.popups : [];
  const features = popups
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)))
    .map((p) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [Number(p.lon), Number(p.lat)],
      },
      properties: {
        name: String(p?.name ?? "—"),
        timestamp: Number(p?.timestamp),
      },
    }));

  return { type: "FeatureCollection", features };
}

function buildTrackFeatureCollection(spatial) {
  const points = Array.isArray(spatial?.track?.points) ? spatial.track.points : [];
  if (points.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  const coordinates = points
    .filter((xy) => Array.isArray(xy) && xy.length >= 2)
    .map((xy) => [Number(xy[1]), Number(xy[0])])
    .filter((xy) => Number.isFinite(xy[0]) && Number.isFinite(xy[1]));

  if (coordinates.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates,
      },
      properties: {},
    }],
  };
}

function buildTrackPointFeatureCollection(spatial) {
  const samples = Array.isArray(spatial?.track?.samples) ? spatial.track.samples : [];
  const features = samples
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)))
    .map((p, idx) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [Number(p.lon), Number(p.lat)],
      },
      properties: {
        index: idx,
        timestamp: Number(p?.timestamp),
        zoom: Number.isFinite(Number(p?.zoom)) ? Number(p.zoom) : null,
        viewportBounds: Array.isArray(p?.viewportBounds) ? p.viewportBounds : null,
      },
    }));

  return { type: "FeatureCollection", features };
}

function makeViewportRectangle(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return null;
  const sw = bounds[0];
  const ne = bounds[1];
  if (!Array.isArray(sw) || !Array.isArray(ne) || sw.length < 2 || ne.length < 2) return null;
  const south = Number(sw[0]);
  const west = Number(sw[1]);
  const north = Number(ne[0]);
  const east = Number(ne[1]);
  if (![south, west, north, east].every(Number.isFinite)) return null;

  const rectangleStyle = {
    color: "#ff7800",
    weight: 1.5,
    fillOpacity: 0,
    opacity: 0,
    interactive: false,
  };

  // Crossing antimeridian: split into two rectangles, because L.rectangle cannot render wrap reliably.
  if (west > east) {
    return L.layerGroup([
      L.rectangle([[south, west], [north, 180]], rectangleStyle),
      L.rectangle([[south, -180], [north, east]], rectangleStyle),
    ]);
  }

  return L.rectangle([[south, west], [north, east]], rectangleStyle);
}

function buildEndpointFeatureCollection(spatial) {
  const endpoints = spatial?.movementEndpoints ?? {};
  const out = [];

  [
    ["Začátek", endpoints?.start],
    ["Konec", endpoints?.end],
  ].forEach(([kind, point]) => {
    if (!point) return;
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        kind,
        timestamp: Number(point.timestamp),
      },
    });
  });

  return { type: "FeatureCollection", features: out };
}

function fitMapToRenderedData() {
  const map = state.map.leafletMap;
  const pointsLayer = state.map.pointsLayer;
  const trajectoryLayer = state.map.trajectoryLayer;
  const trajectoryPointsLayer = state.map.trajectoryPointsLayer;
  const endpointLayer = state.map.endpointLayer;
  if (!map || !pointsLayer || !trajectoryLayer || !trajectoryPointsLayer || !endpointLayer) return;

  const group = L.featureGroup([pointsLayer, trajectoryLayer, trajectoryPointsLayer, endpointLayer]);
  const bounds = group.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
  }
}

function renderSpatialTraceToMap(spatialPayload) {
  ensureSessionMapInitialized();
  clearSessionMapData();

  const spatial = spatialPayload?.spatial ?? { track: { points: [] }, popups: [] };
  const pointsGeoJson = buildPointsFeatureCollection(spatial);
  const trackGeoJson = buildTrackFeatureCollection(spatial);
  const trackPointsGeoJson = buildTrackPointFeatureCollection(spatial);
  const endpointGeoJson = buildEndpointFeatureCollection(spatial);

  state.map.pointsLayer?.addData?.(pointsGeoJson);
  state.map.trajectoryLayer?.addData?.(trackGeoJson);
  state.map.trajectoryPointsLayer?.addData?.(trackPointsGeoJson);
  state.map.endpointLayer?.addData?.(endpointGeoJson);

  state.map.viewportRectangles = [];
  const viewportLayer = state.map.viewportLayer;
  if (viewportLayer?.clearLayers) viewportLayer.clearLayers();

  state.map.pointsLayer?.eachLayer?.((layer) => {
    const name = layer?.feature?.properties?.name ?? "—";
    const ts = layer?.feature?.properties?.timestamp;
    const label = Number.isFinite(Number(ts)) ? `${name} (${Number(ts)})` : String(name);
    layer.bindTooltip(label, { direction: "top", offset: [0, -8] });
  });

  state.map.endpointLayer?.eachLayer?.((layer) => {
    const kind = layer?.feature?.properties?.kind ?? "Bod";
    const ts = layer?.feature?.properties?.timestamp;
    const label = Number.isFinite(Number(ts)) ? `${kind} (${Number(ts)})` : String(kind);
    layer.bindTooltip(label, { direction: "top", offset: [0, -8] });
  });

  state.map.trajectoryPointsLayer?.eachLayer?.((layer) => {
    const bounds = layer?.feature?.properties?.viewportBounds;
    const ts = layer?.feature?.properties?.timestamp;
    const zoom = layer?.feature?.properties?.zoom;
    const labelParts = [];
    if (Number.isFinite(Number(ts))) labelParts.push(`t=${Number(ts)}`);
    if (Number.isFinite(Number(zoom))) labelParts.push(`z=${Number(zoom)}`);
    layer.bindTooltip(labelParts.join(" · ") || "Bod trajektorie", { direction: "top", offset: [0, -8] });

    const rect = makeViewportRectangle(bounds);
    if (rect && viewportLayer?.addLayer) {
      rect.__isHovered = false;
      viewportLayer.addLayer(rect);
      state.map.viewportRectangles.push(rect);
      layer.on("mouseover", () => {
        rect.__isHovered = true;
        updateViewportRectanglesVisibility(state.map, getMapControlsState());
      });
      layer.on("mouseout", () => {
        rect.__isHovered = false;
        updateViewportRectanglesVisibility(state.map, getMapControlsState());
      });
    }
  });

  applyMapLayerStyles();
  fitMapToRenderedData();

  const pointCount = Array.isArray(spatial?.popups) ? spatial.popups.length : 0;
  const trackCount = Array.isArray(spatial?.track?.points) ? spatial.track.points.length : 0;
  const viewportCount = Array.isArray(spatial?.track?.samples)
    ? spatial.track.samples.filter((p) => Array.isArray(p?.viewportBounds)).length
    : 0;
  const endpoints = spatial?.movementEndpoints ?? {};
  const endpointCount = (endpoints?.start ? 1 : 0) + (endpoints?.end ? 1 : 0);
  setMapPlaceholderStatus({
    title: "Data načtena",
    detail: `Body (popupopen): ${pointCount} · Body trajektorie (moveend): ${trackCount} · Začátek/konec: ${endpointCount} · Viewport obdélníky: ${viewportCount}`,
  });
}

async function loadSpatialTraceIntoMap(sessionId) {
  setMapPlaceholderStatus({ title: "Načítám mapová data…", detail: "Probíhá příprava trajektorie a popup bodů." });
  const payload = await apiGetSessionSpatialTrace(sessionId);
  renderSpatialTraceToMap(payload);
}

function ensureSessionMapInitialized() {
  if (state.map.isInitialized) return;
  if (typeof L === "undefined") return;

  const mapEl = $("#sessionLeafletMap");
  if (!mapEl) return;

  const leafletMap = L.map(mapEl, {
    center: [49.8175, 15.473],
    zoom: 7,
    zoomControl: true,
  });

  const osmStandard = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });

  const cartoVoyager = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  });

  const opentopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
  });

  osmStandard.addTo(leafletMap);

  const baseLayers = {
    "OpenStreetMap": osmStandard,
    "CARTO Voyager": cartoVoyager,
    "OpenTopoMap": opentopo,
  };

  const pointsLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
      radius: 6,
      color: "#4cc9f0",
      fillColor: "#4cc9f0",
      fillOpacity: 0.9,
      weight: 1,
    }),
  }).addTo(leafletMap);

  const trajectoryLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    style: {
      color: "#f72585",
      weight: 4,
      opacity: 0.9,
    },
  }).addTo(leafletMap);

  const trajectoryPointsLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
      radius: 5,
      color: "#f72585",
      fillColor: "#f72585",
      fillOpacity: 0.8,
      weight: 1,
    }),
  }).addTo(leafletMap);

  const endpointLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
      radius: 8,
      color: "#ff9f1c",
      fillColor: "#ff9f1c",
      fillOpacity: 0.95,
      weight: 2,
    }),
  }).addTo(leafletMap);

  const viewportLayer = L.layerGroup().addTo(leafletMap);

  L.control.layers(baseLayers, {
    "Body": pointsLayer,
    "Trajektorie": trajectoryLayer,
    "Body trajektorie": trajectoryPointsLayer,
    "Začátek/konec": endpointLayer,
    "Viewport obdélníky": viewportLayer,
  }, { collapsed: false }).addTo(leafletMap);

  state.map.leafletMap = leafletMap;
  state.map.baseLayers = baseLayers;
  state.map.pointsLayer = pointsLayer;
  state.map.trajectoryLayer = trajectoryLayer;
  state.map.trajectoryPointsLayer = trajectoryPointsLayer;
  state.map.endpointLayer = endpointLayer;
  state.map.viewportLayer = viewportLayer;
  state.map.viewportRectangles = [];
  state.map.isInitialized = true;

  applyMapLayerStyles();
}

function openSessionMapModal() {
  const subtitle = $("#sessionMapModalSubtitle");
  const s = state.selectedSession;
  if (subtitle) {
    subtitle.textContent = s?.session_id
      ? `Session: ${s.session_id} · user: ${s.user_id ?? "—"} · data: WGS84 (připraveno)`
      : "Připraveno pro data ve WGS84.";
  }

  show($("#sessionMapModal"));
  ensureSessionMapInitialized();
  clearSessionMapData();
  syncMapLegend();

  if (state.map.leafletMap) {
    setTimeout(() => state.map.leafletMap.invalidateSize(), 50);
  }

  if (!s?.session_id) {
    setMapPlaceholderStatus({ title: "Vyber session", detail: "Bez vybrané session nelze načíst mapová data." });
    return;
  }

  loadSpatialTraceIntoMap(s.session_id).catch((e) => {
    clearSessionMapData();
    setMapPlaceholderStatus({
      title: "Chyba při načítání dat",
      detail: e?.message ?? String(e),
      isError: true,
    });
  });
}

function closeSessionMapModal() {
  hide($("#sessionMapModal"));
}

async function refreshGroups() {
  const out = await apiListGroups(state.selectedTestId ?? "TEST");
  state.groups = out.groups ?? [];

  if (state.selectedGroupId && !state.groups.some((g) => g.id === state.selectedGroupId)) {
    state.selectedGroupId = null;
  }

  if (!state.selectedGroupId && state.groups.length) {
    state.selectedGroupId = state.groups[0].id;
  }
}

function getSelectedGroup() {
  return state.groups.find((g) => g.id === state.selectedGroupId) ?? null;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getTaskIdsForGroup(group) {
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const out = new Set();
  sessions.forEach((s) => {
    const taskIds = Array.isArray(s?.tasks) && s.tasks.length ? s.tasks : [s?.task ?? "unknown"];
    taskIds.forEach((taskId) => out.add(String(taskId)));
  });
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function getAllTaskIdsForGroups(groups) {
  const out = new Set();
  (groups ?? []).forEach((g) => getTaskIdsForGroup(g).forEach((taskId) => out.add(taskId)));
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function medianFromNumbers(values) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function buildGroupCompareRows(groups, taskId = null) {
  return (groups ?? []).map((group) => {
    let sessions = Array.isArray(group?.sessions) ? group.sessions : [];
    if (taskId) {
      sessions = sessions.filter((s) => {
        const taskIds = Array.isArray(s?.tasks) && s.tasks.length ? s.tasks : [s?.task ?? "unknown"];
        return taskIds.includes(taskId);
      });
    }

    const durations = sessions
      .map((s) => {
        if (taskId) return s?.stats?.tasks?.[taskId]?.duration_ms;
        return s?.stats?.session?.duration_ms;
      })
      .filter((v) => Number.isFinite(Number(v)))
      .map((v) => Number(v));

    const ages = sessions
      .map((s) => s?.stats?.session?.soc_demo?.age)
      .filter((v) => Number.isFinite(Number(v)))
      .map((v) => Number(v));

    const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const medianDurationMs = medianFromNumbers(durations);
    const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;

    const accuracies = sessions
      .map((s) => Number(s?.stats?.answers_eval?.summary?.accuracy))
      .filter((v) => Number.isFinite(v));
    const avgCorrectness = accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;

    return {
      groupId: group.id,
      groupName: group.name ?? "Bez názvu",
      avgDurationMs,
      medianDurationMs,
      avgCorrectness,
      avgAge,
      membersCount: sessions.length,
    };
  });
}

function compareValues(a, b, direction) {
  const dir = direction === "asc" ? 1 : -1;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b)) * dir;
  }
  return (Number(a) - Number(b)) * dir;
}

function sortRows(rows, sort) {
  const key = sort?.key ?? "avgDurationMs";
  const direction = sort?.direction ?? "desc";
  return [...rows].sort((r1, r2) => compareValues(r1[key], r2[key], direction));
}

function renderCompareTable({ rows, sort }) {
  const headers = [
    { key: "groupName", label: "Skupina" },
    { key: "avgDurationMs", label: "Průměrný čas" },
    { key: "medianDurationMs", label: "Medián času" },
    { key: "avgCorrectness", label: "Průměrná správnost" },
    { key: "avgAge", label: "Průměrný věk" },
  ];

  const sorted = sortRows(rows, sort);
  const arrows = (key) => {
    if (sort?.key !== key) return "↕";
    return sort?.direction === "asc" ? "↑" : "↓";
  };

  return `
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            ${headers.map((h) => `<th class="sortable-th" data-sort-key="${escapeHtml(h.key)}">${escapeHtml(h.label)} <span class="sort-indicator">${arrows(h.key)}</span></th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${sorted.map((row) => `
            <tr>
              <td>${escapeHtml(row.groupName)}</td>
              <td>${escapeHtml(fmtMs(row.avgDurationMs))}</td>
              <td>${escapeHtml(fmtMs(row.medianDurationMs))}</td>
              td>${escapeHtml(fmtPercent(row.avgCorrectness))}</td>
              <td>${escapeHtml(row.avgAge === null ? "—" : row.avgAge.toFixed(1))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function toggleSort(currentSort, key) {
  if (currentSort?.key === key) {
    return { key, direction: currentSort.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "desc" };
}

function computeNumericStats(values) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;

  return {
    count: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    avg: nums.reduce((acc, n) => acc + n, 0) / nums.length,
    median,
  };
}

function renderGroupStatMetric(label, value) {
  return `
    <div class="metric">
      <div class="k">${escapeHtml(label)}</div>
      <div class="v">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderGroupTimeStats(group) {
  const panel = $("#groupTimeStatsPanel");
  if (!panel) return;
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const stats = computeNumericStats(sessions.map((s) => s?.stats?.session?.duration_ms));

  panel.classList.remove("hidden");
  if (!stats) {
    panel.innerHTML = `<div class="title">Statistiky času řešení testu</div><div class="muted small">Nedostatek dat pro výpočet statistik.</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="title">Statistiky času řešení testu</div>
    <div class="metrics group-stats-grid" style="margin-top:10px;">
      ${renderGroupStatMetric("Průměr", fmtMs(stats.avg))}
      ${renderGroupStatMetric("Medián", fmtMs(stats.median))}
      ${renderGroupStatMetric("Minimum", fmtMs(stats.min))}
      ${renderGroupStatMetric("Maximum", fmtMs(stats.max))}
    </div>
  `;
}

function renderGroupCountsStats(group) {
  const panel = $("#groupCountsStatsPanel");
  if (!panel) return;
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const tasksStats = computeNumericStats(sessions.map((s) => s?.stats?.session?.tasks_count));
  const eventsStats = computeNumericStats(sessions.map((s) => s?.stats?.session?.events_total));

  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="title">Statistiky tasků a eventů</div>`;
  if (!tasksStats && !eventsStats) {
    panel.innerHTML += `<div class="muted small">Nedostatek dat pro výpočet statistik.</div>`;
    return;
  }

  if (tasksStats) {
    panel.innerHTML += `
      <div class="metrics group-stats-grid" style="margin-top:10px;">
        ${renderGroupStatMetric("Tasky – průměr", tasksStats.avg.toFixed(2))}
        ${renderGroupStatMetric("Tasky – medián", tasksStats.median.toFixed(2))}
        ${renderGroupStatMetric("Tasky – minimum", tasksStats.min)}
        ${renderGroupStatMetric("Tasky – maximum", tasksStats.max)}
      </div>
    `;
  }

  if (eventsStats) {
    panel.innerHTML += `
      <div class="metrics group-stats-grid" style="margin-top:10px;">
        ${renderGroupStatMetric("Eventy – průměr", eventsStats.avg.toFixed(2))}
        ${renderGroupStatMetric("Eventy – medián", eventsStats.median.toFixed(2))}
        ${renderGroupStatMetric("Eventy – minimum", eventsStats.min)}
        ${renderGroupStatMetric("Eventy – maximum", eventsStats.max)}
      </div>
    `;
  }
}

function renderGroupSocioStats(group) {
  const panel = $("#groupSocioPanel");
  if (!panel) return;

  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const socRows = sessions.map((s) => s?.stats?.session?.soc_demo ?? {});
  const ageStats = computeNumericStats(socRows.map((r) => r?.age));

  function distribution(key) {
    const counts = new Map();
    let total = 0;
    socRows.forEach((row) => {
      const val = String(row?.[key] ?? "").trim();
      if (!val) return;
      counts.set(val, (counts.get(val) ?? 0) + 1);
      total += 1;
    });
    if (!total) return "—";
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => `${escapeHtml(value)}: ${((count / total) * 100).toFixed(1)} %`)
      .join(" · ");
  }

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="title">Socioekonomické statistiky skupiny</div>
    <div class="metrics group-stats-grid" style="margin-top:10px;">
      ${renderGroupStatMetric("Průměrný věk", ageStats ? ageStats.avg.toFixed(1) : "—")}
      ${renderGroupStatMetric("Pohlaví", distribution("gender"))}
      ${renderGroupStatMetric("Zaměstnání", distribution("occupation"))}
      ${renderGroupStatMetric("Národnost", distribution("nationality"))}
    </div>
  `;
}

function renderMiniWordcloud(words = []) {
  if (!Array.isArray(words) || !words.length) {
    return `<div class="muted small">Zatím nejsou dostupná textová data odpovědí.</div>`;
  }
  const max = Math.max(...words.map((w) => Number(w.count) || 1), 1);
  return `<div class="wordcloud">${words.slice(0, 60).map((w) => {
    const count = Number(w.count) || 1;
    const ratio = count / max;
    const size = 12 + Math.round(ratio * 22);
    return `<span class="word" style="font-size:${size}px" title="${escapeHtml(String(count))}">${escapeHtml(w.text)}</span>`;
  }).join(" ")}</div>`;
}

async function renderGroupAnswersAndWordcloud(group) {
  const panel = $("#groupAnswersPanel");
  if (!panel) return;
  if (!group?.id) {
    panel.innerHTML = `<div class="title">Vyhodnocení odpovědí</div><div class="muted small">Vyber skupinu.</div>`;
    return;
  }

  panel.innerHTML = `<div class="title">Vyhodnocení odpovědí</div><div class="muted small">Načítám…</div>`;

  try {
    const answersPayload = await apiGetGroupAnswers(group.id);
    const tasks = Object.keys(answersPayload?.tasks ?? {}).sort((a, b) => a.localeCompare(b));
    const selectedTask = tasks[0] ?? null;
    const wordcloud = await apiGetGroupWordcloud(group.id, selectedTask);

    const selector = tasks.length
      ? `<label class="filter-field" style="max-width:320px;"><span>Úloha</span><select id="groupWordcloudTaskSelect">${tasks.map((taskId) => `<option value="${escapeHtml(taskId)}" ${taskId===selectedTask?"selected":""}>${escapeHtml(taskId)}</option>`).join("")}</select></label>`
      : `<div class="muted small">Skupina zatím nemá odpovědi navázané na úlohy.</div>`;

    const taskRecord = selectedTask ? answersPayload?.tasks?.[selectedTask] : null;
    const acc = taskRecord?.accuracy;
    const summary = taskRecord
      ? `Správně: ${taskRecord.correct_count}/${taskRecord.total_count}${Number.isFinite(acc) ? ` (${(acc*100).toFixed(1)} %)` : ""}`
      : "Bez odpovědí pro vybranou úlohu.";

    panel.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:end; gap:10px; flex-wrap:wrap;">
        <div>
          <div class="title">Vyhodnocení odpovědí + wordcloud</div>
          <div class="muted small">${escapeHtml(summary)}</div>
        </div>
        ${selector}
      </div>
      <div class="wordcloud-wrap" id="groupWordcloudWrap">${renderMiniWordcloud(wordcloud?.words ?? [])}</div>
    `;

    const select = $("#groupWordcloudTaskSelect");
    select?.addEventListener("change", async () => {
      const t = select.value || null;
      const cloud = await apiGetGroupWordcloud(group.id, t);
      const wrap = $("#groupWordcloudWrap");
      if (wrap) wrap.innerHTML = renderMiniWordcloud(cloud?.words ?? []);
    });
  } catch (e) {
    panel.innerHTML = `<div class="title">Vyhodnocení odpovědí</div><div class="muted small">Chyba načtení: ${escapeHtml(e?.message ?? e)}</div>`;
  }
}

function renderGroupCompareAnswersTab(groups) {
  const wrap = $("#groupsCompareWordcloudWrap");
  if (!wrap) return;
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">Nejsou vybrané skupiny</div></div>`;
    return;
  }

  const allTasks = getAllTaskIdsForGroups(groups);
  if (!state.selectedGroupCompareTaskId || !allTasks.includes(state.selectedGroupCompareTaskId)) {
    state.selectedGroupCompareTaskId = allTasks[0] ?? null;
  }

  const options = allTasks.map((taskId) => `<option value="${escapeHtml(taskId)}" ${taskId===state.selectedGroupCompareTaskId?"selected":""}>${escapeHtml(taskId)}</option>`).join("");
  wrap.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:end; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
      <div class="muted small">Odpovědi podle skupin pro stejnou úlohu.</div>
      <label class="filter-field" style="max-width:320px; margin:0;">
        <span>Úloha</span>
        <select id="groupsCompareWordcloudTaskSelect">${options}</select>
      </label>
    </div>
    <div class="wordcloud-grid" id="groupsCompareWordcloudGrid"><div class="muted small">Načítám…</div></div>
  `;

  const load = async () => {
    const taskId = $("#groupsCompareWordcloudTaskSelect")?.value || null;
    const [res, groupAnswers] = await Promise.all([
      apiCompareWordcloud(groups.map((g) => g.id), taskId),
      Promise.all(groups.map((g) => apiGetGroupAnswers(g.id).catch(() => null))),
    ]);

    const grid = $("#groupsCompareWordcloudGrid");
    if (!grid) return;

    const summaries = groupAnswers.filter(Boolean).map((payload, idx) => {
      const acc = Number(payload?.summary?.accuracy);
      return {
        groupId: groups[idx]?.id,
        groupName: groups[idx]?.name ?? groups[idx]?.id,
        accuracy: Number.isFinite(acc) ? acc : null,
      };
    });

    const validAcc = summaries.map((s) => s.accuracy).filter((v) => Number.isFinite(v));
    const globalAcc = validAcc.length ? validAcc.reduce((a, b) => a + b, 0) / validAcc.length : null;

    const byId = new Map((res?.groups ?? []).map((g) => [g.group_id, g.words ?? []]));
        const statsHtml = `
      <div class="card" style="padding:10px; margin-bottom:10px;">
        <div class="title">Průměrná správnost</div>
        <div class="muted small" style="margin-top:6px;">Globálně: <b>${escapeHtml(fmtPercent(globalAcc))}</b></div>
        <div class="muted small" style="margin-top:4px;">${summaries.map((s) => `${escapeHtml(s.groupName)}: ${escapeHtml(fmtPercent(s.accuracy))}`).join(" · ")}</div>
      </div>
    `;

    grid.innerHTML = statsHtml + groups.map((group) => `
      <div class="card" style="padding:10px;">
        <div class="title">${escapeHtml(group.name ?? group.id)}</div>
        <div class="muted small" style="margin-bottom:6px;">${escapeHtml(group.id)}</div>
        ${renderMiniWordcloud(byId.get(group.id) ?? [])}
      </div>
    `).join("");
  };

  load().catch((e) => {
    const grid = $("#groupsCompareWordcloudGrid");
    if (grid) grid.innerHTML = `<div class="muted small">Chyba načtení: ${escapeHtml(e?.message ?? e)}</div>`;
  });

  $("#groupsCompareWordcloudTaskSelect")?.addEventListener("change", () => {
    load().catch((e) => {
      const grid = $("#groupsCompareWordcloudGrid");
      if (grid) grid.innerHTML = `<div class="muted small">Chyba načtení: ${escapeHtml(e?.message ?? e)}</div>`;
    });
  });
}

function renderGroupsPage() {
  const groupsListEl = $("#groupsList");
  const usersListEl = $("#groupUsersList");
  const usersPanelEl = $("#groupUsersPanel");
  const usersToggleEl = $("#toggleGroupUsersBtn");
  const editBtn = $("#editGroupBtn");
  const timePanelEl = $("#groupTimeStatsPanel");
  const countsPanelEl = $("#groupCountsStatsPanel");
  const answersPanelEl = $("#groupAnswersPanel");
  const socioPanelEl = $("#groupSocioPanel");
  const searchQuery = normalizeSearchText(state.groupsSearchQuery);
  const compareBtn = $("#openGroupsCompareBtn");
  if (!groupsListEl || !usersListEl || !usersPanelEl || !usersToggleEl) return;

  const filteredGroups = state.groups.filter((g) => normalizeSearchText(g.name).includes(searchQuery));

  if (!state.groups.length) {
    groupsListEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Zatím nejsou vytvořené skupiny</div>
        <div class="muted small">Na stránce Sessions vyber uživatele a vytvoř první skupinu.</div>
      </div>
    `;
    usersListEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Vyber skupinu</div>
        <div class="muted small">Po vytvoření skupiny se zde zobrazí členové.</div>
      </div>
    `;
    usersListEl.style.display = "none";
    usersPanelEl.classList.add("hidden");
    timePanelEl?.classList.add("hidden");
    countsPanelEl?.classList.add("hidden");
    answersPanelEl?.classList.add("hidden");
    socioPanelEl?.classList.add("hidden");
    if (editBtn) editBtn.disabled = true;
    if (compareBtn) compareBtn.disabled = true;
    return;
  }

  if (!filteredGroups.length) {
    groupsListEl.innerHTML = `<div class="empty"><div class="empty-title">Žádná skupina neodpovídá filtru</div><div class="muted small">Zkus upravit hledaný text.</div></div>`;
  } else {
    groupsListEl.innerHTML = filteredGroups.map((g) => {
    const selected = g.id === state.selectedGroupId ? "is-selected" : "";
    const checked = (state.selectedGroupCompareIds ?? []).includes(g.id) ? "checked" : "";
    const count = Array.isArray(g.sessions) ? g.sessions.length : 0;
    return `
      <div class="list-item ${selected}" data-group="${escapeHtml(g.id)}">
        <div class="row">
          <label class="row" style="justify-content:flex-start; gap:10px;">
            <input type="checkbox" data-role="group-compare-select" data-group="${escapeHtml(g.id)}" ${checked} />
            <div class="title">${escapeHtml(g.name ?? "Bez názvu")}</div>
          </label>
          <span class="pill">${count} uživatelů</span>
        </div>
      </div>
    `;
  }).join("");
  }

  $$("#groupsList .list-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedGroupId = item.dataset.group;
      state.isGroupUsersExpanded = false;
      renderGroupsPage();
    });
  });

  $$("#groupsList input[data-role='group-compare-select']").forEach((input) => {
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", () => {
      const id = input.dataset.group;
      const set = new Set(state.selectedGroupCompareIds ?? []);
      if (input.checked) set.add(id);
      else set.delete(id);
      state.selectedGroupCompareIds = Array.from(set);
      if (compareBtn) compareBtn.disabled = state.selectedGroupCompareIds.length < 1;
    });
  });

  if (compareBtn) compareBtn.disabled = (state.selectedGroupCompareIds ?? []).length < 1;

  const group = getSelectedGroup();
  if (!group) {
    usersPanelEl.classList.add("hidden");
    usersListEl.innerHTML = `<div class="empty"><div class="empty-title">Vyber skupinu</div></div>`;
    usersListEl.style.display = "none";
    timePanelEl?.classList.add("hidden");
    countsPanelEl?.classList.add("hidden");
    answersPanelEl?.classList.add("hidden");
    socioPanelEl?.classList.add("hidden");
    if (editBtn) editBtn.disabled = true;
    if (compareBtn) compareBtn.disabled = (state.selectedGroupCompareIds ?? []).length < 1;
    return;
  }

  usersPanelEl.classList.remove("hidden");

  const sessions = Array.isArray(group.sessions) ? group.sessions : [];
  usersToggleEl.textContent = state.isGroupUsersExpanded
    ? `Sbalit uživatele ve skupině (${sessions.length})`
    : `Rozbalit uživatele ve skupině (${sessions.length})`;
  usersListEl.style.display = state.isGroupUsersExpanded ? "grid" : "none";
  if (!sessions.length) {
    usersListEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Skupina je prázdná</div>
        <div class="muted small">Použij tlačítko Editace skupiny pro přidání uživatelů.</div>
      </div>
    `;
  } else {
    usersListEl.innerHTML = sessions.map((s) => {
      const ss = s.stats?.session ?? {};
      return `
        <div class="list-item">
          <div class="row"><div class="title">${escapeHtml(s.user_id ?? "—")}</div></div>
          <div class="muted small">session: ${escapeHtml(s.session_id ?? "—")} · eventů: ${escapeHtml(ss.events_total ?? "—")} · délka: ${escapeHtml(fmtMs(ss.duration_ms))}</div>
        </div>
      `;
    }).join("");
  }

  if (answersPanelEl) answersPanelEl.classList.remove("hidden");
  renderGroupAnswersAndWordcloud(group);
  renderGroupTimeStats(group);
  renderGroupCountsStats(group);
  renderGroupSocioStats(group);

  if (editBtn) editBtn.disabled = false;
}


function openCreateGroupModal() {
  const selected = state.selectedSessionIds ?? [];
  const sessions = getSessionsForSelectedTest();
  const validSelected = selected.filter((sid) => sessions.some((s) => s.session_id === sid));
  const statusEl = $("#groupCreateStatus");
  if (!validSelected.length) {
    if (statusEl) statusEl.textContent = "Nejprve vyber aspoň jednu session.";
    return;
  }

  if (statusEl) statusEl.textContent = `Vybráno sessions: ${validSelected.length}`;
  const nameInput = $("#groupNameInput");
  if (nameInput) nameInput.value = "";
  show($("#groupCreateModal"));
}

function closeCreateGroupModal() {
  hide($("#groupCreateModal"));
}

async function saveCreatedGroup() {
  const nameInput = $("#groupNameInput");
  const statusEl = $("#groupCreateStatus");
  const name = String(nameInput?.value ?? "").trim();
  const sessions = getSessionsForSelectedTest();
  const validSelected = (state.selectedSessionIds ?? []).filter((sid) => sessions.some((s) => s.session_id === sid));

  if (!name) {
    if (statusEl) statusEl.textContent = "Vyplň název skupiny.";
    return;
  }
  if (!validSelected.length) {
    if (statusEl) statusEl.textContent = "Vyber aspoň jednu session.";
    return;
  }

  try {
    if (statusEl) statusEl.textContent = "Ukládám skupinu…";
    await apiCreateGroup({
      name,
      test_id: state.selectedTestId ?? "TEST",
      session_ids: validSelected,
    });
    await refreshGroups();
    renderGroupsPage();
    closeCreateGroupModal();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Chyba: ${e?.message ?? e}`;
  }
}

function renderGroupEditFilterControls(sessions) {
  const genderEl = $("#groupEditFilterGender");
  const occupationEl = $("#groupEditFilterOccupation");
  const nationalityEl = $("#groupEditFilterNationality");
  const ageMinEl = $("#groupEditFilterAgeMin");
  const ageMaxEl = $("#groupEditFilterAgeMax");
  const searchEl = $("#groupEditSearchInput");
  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !searchEl) return;

  const options = getSessionFilterOptions(sessions);
  const makeOptions = (values, emptyLabel) => {
    const base = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    return base.concat(values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  };

  genderEl.innerHTML = makeOptions(options.gender, "Vše");
  occupationEl.innerHTML = makeOptions(options.occupation, "Vše");
  nationalityEl.innerHTML = makeOptions(options.nationality, "Vše");

  genderEl.value = state.groupEditFilters.gender;
  occupationEl.value = state.groupEditFilters.occupation;
  nationalityEl.value = state.groupEditFilters.nationality;
  ageMinEl.value = state.groupEditFilters.ageMin;
  ageMaxEl.value = state.groupEditFilters.ageMax;
  searchEl.value = state.groupEditFilters.query;
}

function renderGroupEditSessionsList() {
  const listEl = $("#groupEditSessionsList");
  const summaryEl = $("#groupEditSummary");
  const sessions = getSessionsForSelectedTest();
  if (!listEl) return;

  renderGroupEditFilterControls(sessions);
  const filtered = applyGenericSessionFilters(sessions, state.groupEditFilters);
  const selectedSet = new Set(state.groupEditSessionIds ?? []);
  const sorted = filtered.slice().sort((a, b) => {
    const aSel = selectedSet.has(a.session_id) ? 1 : 0;
    const bSel = selectedSet.has(b.session_id) ? 1 : 0;
    if (aSel !== bSel) return bSel - aSel;
    return String(a.user_id ?? "").localeCompare(String(b.user_id ?? ""), "cs", { sensitivity: "base" });
  });

  const selectedCount = sessions.filter((x) => selectedSet.has(x.session_id)).length;
  if (summaryEl) summaryEl.textContent = `Zobrazeno ${sorted.length} z ${sessions.length} · Vybráno ${selectedCount}`;

  if (!sorted.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">Žádná session neodpovídá filtru</div></div>`;
    return;
  }

  listEl.innerHTML = sorted.map((s) => {
    const checked = selectedSet.has(s.session_id) ? "checked" : "";
    return `
      <label class="list-item" style="cursor:default;">
        <div class="row" style="justify-content:flex-start; gap:10px;">
          <input type="checkbox" data-role="group-edit-session" data-session="${escapeHtml(s.session_id)}" ${checked} />
          <div>
            <div class="title">${escapeHtml(s.user_id ?? "—")}</div>
            <div class="muted small">session: ${escapeHtml(s.session_id)}</div>
          </div>
        </div>
      </label>
    `;
  }).join("");

    $$("#groupEditSessionsList input[data-role='group-edit-session']").forEach((input) => {
    input.addEventListener("change", () => {
      const sid = input.dataset.session;
      if (!sid) return;
      const set = new Set(state.groupEditSessionIds ?? []);
      if (input.checked) set.add(sid);
      else set.delete(sid);
      state.groupEditSessionIds = Array.from(set);
      renderGroupEditSessionsList();
    });
  });
}

function wireGroupEditFilters() {
  const genderEl = $("#groupEditFilterGender");
  const occupationEl = $("#groupEditFilterOccupation");
  const nationalityEl = $("#groupEditFilterNationality");
  const ageMinEl = $("#groupEditFilterAgeMin");
  const ageMaxEl = $("#groupEditFilterAgeMax");
  const searchEl = $("#groupEditSearchInput");
  const selectAllBtn = $("#groupEditSelectAllBtn");
  const clearBtn = $("#groupEditClearFiltersBtn");

  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !searchEl || !selectAllBtn || !clearBtn) return;

  const update = () => {
    state.groupEditFilters.gender = genderEl.value;
    state.groupEditFilters.occupation = occupationEl.value;
    state.groupEditFilters.nationality = nationalityEl.value;
    state.groupEditFilters.ageMin = ageMinEl.value;
    state.groupEditFilters.ageMax = ageMaxEl.value;
    state.groupEditFilters.query = searchEl.value;
    renderGroupEditSessionsList();
  };

  [genderEl, occupationEl, nationalityEl].forEach((el) => el.addEventListener("change", update));
  [ageMinEl, ageMaxEl, searchEl].forEach((el) => el.addEventListener("input", update));

  selectAllBtn.addEventListener("click", () => {
    const sessions = getSessionsForSelectedTest();
    const filtered = applyGenericSessionFilters(sessions, state.groupEditFilters);
    const set = new Set(state.groupEditSessionIds ?? []);
    filtered.forEach((s) => set.add(s.session_id));
    state.groupEditSessionIds = Array.from(set);
    renderGroupEditSessionsList();
  });

  clearBtn.addEventListener("click", () => {
    state.groupEditFilters = { gender: "", ageMin: "", ageMax: "", occupation: "", nationality: "", query: "" };
    renderGroupEditSessionsList();
  });
}

function openGroupEditModal() {
  const group = getSelectedGroup();
  if (!group) return;

  const selected = new Set(group.session_ids ?? []);
  state.groupEditSessionIds = Array.from(selected);
  state.groupEditTab = "sessions";
  state.groupEditFilters = { gender: "", ageMin: "", ageMax: "", occupation: "", nationality: "", query: "" };

  const nameInput = $("#groupEditNameInput");
  if (nameInput) nameInput.value = group.name ?? "";
  const noteInput = $("#groupEditNoteInput");
  if (noteInput) noteInput.value = String(group.note ?? "");

  const statusEl = $("#groupEditStatus");
  if (statusEl) statusEl.textContent = "";
  renderGroupEditPanels();
  renderGroupEditSessionsList();
  show($("#groupEditModal"));
}

function renderGroupEditPanels() {
  $$("#groupEditTabs .tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === state.groupEditTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$("#groupEditModal [data-group-edit-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.groupEditPanel !== state.groupEditTab);
  });
}

function closeGroupEditModal() {
  hide($("#groupEditModal"));
}

function getGroupsForComparison() {
  const ids = new Set(state.selectedGroupCompareIds ?? []);
  return state.groups.filter((g) => ids.has(g.id));
}

function renderGroupCompareSummaryTab(groups) {
  const wrap = $("#groupsCompareTableWrap");
  if (!wrap) return;
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">Nejsou vybrané skupiny</div><div class="muted small">Na stránce Skupiny označ skupiny pro srovnání.</div></div>`;
    return;
  }

  const rows = buildGroupCompareRows(groups, null);
  wrap.innerHTML = renderCompareTable({ rows, sort: state.groupCompareSort });
  $$("#groupsCompareTableWrap .sortable-th[data-sort-key]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const key = cell.dataset.sortKey;
      state.groupCompareSort = toggleSort(state.groupCompareSort, key);
      renderGroupCompareModal();
    });
  });
}

function renderGroupCompareTaskTab(groups) {
  const taskListEl = $("#groupTaskList");
  const tableWrap = $("#groupTaskCompareTableWrap");
  if (!taskListEl || !tableWrap) return;

  const allTasks = getAllTaskIdsForGroups(groups);
  const q = normalizeSearchText(state.groupTaskSearchQuery);
  const filteredTasks = allTasks.filter((taskId) => normalizeSearchText(taskId).includes(q));

  if (!allTasks.length) {
    taskListEl.innerHTML = `<div class="empty"><div class="empty-title">Žádné úlohy</div><div class="muted small">Vybrané skupiny zatím neobsahují úlohy.</div></div>`;
    tableWrap.innerHTML = "";
    return;
  }

  if (!state.selectedGroupCompareTaskId || !allTasks.includes(state.selectedGroupCompareTaskId)) {
    state.selectedGroupCompareTaskId = allTasks[0];
  }

  taskListEl.innerHTML = filteredTasks.length
    ? filteredTasks.map((taskId) => {
      const selected = taskId === state.selectedGroupCompareTaskId ? "is-selected" : "";
      return `<div class="list-item ${selected}" data-role="compare-task-item" data-task="${escapeHtml(taskId)}"><div class="title">${escapeHtml(taskId)}</div></div>`;
    }).join("")
    : `<div class="empty"><div class="empty-title">Žádná úloha neodpovídá filtru</div></div>`;

  $$("#groupTaskList [data-role='compare-task-item']").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedGroupCompareTaskId = item.dataset.task;
      renderGroupCompareModal();
    });
  });

  if (!state.selectedGroupCompareTaskId) {
    tableWrap.innerHTML = "";
    return;
  }

  const rows = buildGroupCompareRows(groups, state.selectedGroupCompareTaskId);
  tableWrap.innerHTML = `
    <div class="muted small" style="margin-bottom:8px;">Úloha: <b>${escapeHtml(state.selectedGroupCompareTaskId)}</b></div>
    ${renderCompareTable({ rows, sort: state.groupTaskCompareSort })}
  `;
  $$("#groupTaskCompareTableWrap .sortable-th[data-sort-key]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const key = cell.dataset.sortKey;
      state.groupTaskCompareSort = toggleSort(state.groupTaskCompareSort, key);
      renderGroupCompareModal();
    });
  });
}

function renderGroupCompareModal() {
  const modal = $("#groupsCompareModal");
  if (!modal || modal.classList.contains("hidden")) return;

  const groups = getGroupsForComparison();
  const subtitle = $("#groupsCompareSubtitle");
  if (subtitle) subtitle.textContent = `Vybráno skupin: ${groups.length}`;

  $$("#groupsCompareTabs .tab-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === state.groupCompareTab);
    btn.setAttribute("aria-selected", btn.dataset.tab === state.groupCompareTab ? "true" : "false");
  });
  $$("#groupsCompareModal [data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.panel !== state.groupCompareTab);
  });

  renderGroupCompareSummaryTab(groups);
  renderGroupCompareTaskTab(groups);
  renderGroupCompareAnswersTab(groups);
}

function openGroupCompareModal() {
  if ((state.selectedGroupCompareIds ?? []).length < 1) return;
  state.groupCompareTab = "summary";
  show($("#groupsCompareModal"));
  renderGroupCompareModal();
}

function closeGroupCompareModal() {
  hide($("#groupsCompareModal"));
}

async function saveGroupEdit() {
  const group = getSelectedGroup();
  const statusEl = $("#groupEditStatus");
  if (!group) return;

  try {
    if (statusEl) statusEl.textContent = "Ukládám změny…";
    await apiUpdateGroup(group.id, {
      name: group.name,
      test_id: group.test_id,
      session_ids: state.groupEditSessionIds ?? [],
    });
    const updatedSettings = await apiUpdateGroupSettings(group.id, {
      name: String($("#groupEditNameInput")?.value ?? "").trim() || group.name,
      note: String($("#groupEditNoteInput")?.value ?? ""),
    });
    await refreshGroups();
    const idx = state.groups.findIndex((x) => x.id === group.id);
    if (idx >= 0 && updatedSettings?.group) state.groups[idx] = { ...state.groups[idx], ...updatedSettings.group };
    renderGroupsPage();
    closeGroupEditModal();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Chyba: ${e?.message ?? e}`;
  }
}

async function deleteCurrentGroup() {
  const group = getSelectedGroup();
  const statusEl = $("#groupEditStatus");
  if (!group) return;
  if (!window.confirm(`Opravdu chcete smazat skupinu „${group.name}“?`)) return;

  try {
    if (statusEl) statusEl.textContent = "Mažu skupinu…";
    await apiDeleteGroup(group.id);
    await refreshGroups();
    state.selectedGroupId = null;
    renderGroupsPage();
    closeGroupEditModal();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Chyba: ${e?.message ?? e}`;
  }
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
  saveSelectedTestToStorage(testId);
  updateBreadcrumbs();
  state.selectedSessionIds = loadGroupDraftSelectionForTest(testId);

const sessionsForTest = getSessionsForSelectedTest();
  if (state.selectedSessionId && !sessionsForTest.some(s => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = null;
    state.selectedSession = null;
  }
  

  $$("#testsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.test === testId);
  });

  renderTestAggMetrics();
  renderSessionsList();
  renderSessionMetrics();
  const validIds = new Set(getSessionsForSelectedTest().map((x) => x.session_id));
  state.selectedSessionIds = (state.selectedSessionIds ?? []).filter((sid) => validIds.has(sid));
  persistGroupDraftSelection();

  renderTasksList();

  if (!$("#view-settings")?.classList.contains("hidden")) {
    Promise.all([loadAnswersForSelectedTest(), loadTestSettingsForSelectedTest()]).then(() => renderSettingsPage());
  }

  if (!$("#view-groups")?.classList.contains("hidden")) {
    refreshGroups().then(() => renderGroupsPage());
  }
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
  syncTestsWithSessions(state.sessions);
  renderTestsList();

  if (state.selectedSessionId && !state.sessions.some(s => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = null;
    state.selectedSession = null;
  } else if (state.selectedSessionId) {
    state.selectedSession = state.sessions.find(s => s.session_id === state.selectedSessionId) ?? null;
  }

  const validIds = new Set(getSessionsForSelectedTest().map((x) => x.session_id));
  state.selectedSessionIds = (state.selectedSessionIds ?? []).filter((sid) => validIds.has(sid));
  persistGroupDraftSelection();

  if (!$("#view-groups")?.classList.contains("hidden")) {
    refreshGroups().then(() => renderGroupsPage());
  }
}

// ===== Events wiring =====
function wireNavButtons() {
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

  $("#backFromSettingsBtn")?.addEventListener("click", () => {
    setPage("dashboard");
    selectTest(state.selectedTestId ?? "TEST");
  });

  $("#openGroupsBtn")?.addEventListener("click", async () => {
    await refreshGroups();
    state.isGroupUsersExpanded = false;
    setPage("groups")
    const groupsSearchInput = $("#groupsSearchInput");
    if (groupsSearchInput) groupsSearchInput.value = state.groupsSearchQuery ?? "";
    renderGroupsPage();
  });

  $("#backFromGroupsBtn")?.addEventListener("click", () => {
    setPage("individual");
    renderSessionsList();
    renderSessionMetrics();
  });

  $("#createGroupBtn")?.addEventListener("click", () => {
    openCreateGroupModal();
  });

  $("#editGroupBtn")?.addEventListener("click", () => {
    openGroupEditModal();
  });
  
  $("#openGroupsCompareBtn")?.addEventListener("click", () => {
    openGroupCompareModal();
  });

  $("#groupsSearchInput")?.addEventListener("input", (e) => {
    state.groupsSearchQuery = e.target?.value ?? "";
    renderGroupsPage();
  });

  $("#toggleGroupUsersBtn")?.addEventListener("click", () => {
    state.isGroupUsersExpanded = !state.isGroupUsersExpanded;
    renderGroupsPage();
  });

  $("#settingsReloadBtn")?.addEventListener("click", async () => {
    await loadAnswersForSelectedTest();
    await loadTestSettingsForSelectedTest();
    renderSettingsPage();
  });

  $("#settingsTabs")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    const tab = btn.dataset.tab;
    state.settingsTab = (tab === "sessions" || tab === "user-test") ? tab : "answers";
    renderSettingsPage();
  });

  $("#settingsSaveUserTestBtn")?.addEventListener("click", saveUserTestSettings);
  $("#settingsDeleteUserTestBtn")?.addEventListener("click", () => {
    openSettingsDeleteConfirmModal("test");
  });

  $("#settingsDeleteSelectedBtn")?.addEventListener("click", () => {
    openSettingsDeleteConfirmModal("selected");
  });

  $("#settingsDeleteAllBtn")?.addEventListener("click", () => {
    openSettingsDeleteConfirmModal("all");
  });

  $("#groupsCompareTabs")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    state.groupCompareTab = btn.dataset.tab === "wordcloud" ? "answers" : btn.dataset.tab;
    renderGroupCompareModal();
  });

  $("#groupTaskSearchBtn")?.addEventListener("click", () => {
    renderGroupCompareModal();
  });

  $("#groupEditTabs")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    state.groupEditTab = btn.dataset.tab === "settings" ? "settings" : "sessions";
    renderGroupEditPanels();
  });

  $("#deleteGroupBtn")?.addEventListener("click", deleteCurrentGroup);

  //Timeline button (on "Úlohy v session" page, right column)
  $("#openTimelineBtn")?.addEventListener("click", () => {
    openTimelineModal();
  });

  $("#openMapModalBtn")?.addEventListener("click", () => {
    openSessionMapModal();
  });

  $("#taskModalTabs")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    state.taskModalTab = btn.dataset.tab === "map" ? "map" : "metrics";
    renderTaskModalTabs();
  });
}

function wireTestControls() {
  $("#addTestBtn")?.addEventListener("click", () => {
    const raw = window.prompt("Zadej název nového testu:");
    const testId = normalizeTestId(raw);
    if (!testId) return;

    if (!state.tests.includes(testId)) {
      state.tests.push(testId);
      state.tests = Array.from(new Set(state.tests));
      saveTestsToStorage(state.tests);
      renderTestsList();
    }

    selectTest(testId);
  });
}

function wireModal() {
  $("#closeTaskModalBtn")?.addEventListener("click", closeTaskModal);
  $("#closeTaskModalBtn2")?.addEventListener("click", closeTaskModal);
  $("#taskMetricsModal .modal-backdrop")?.addEventListener("click", closeTaskModal);

  // NEW: timeline modal close wiring (only if modal exists in HTML)
  $("#closeTimelineBtn")?.addEventListener("click", closeTimelineModal);
  $("#exportTimelineCsvBtn")?.addEventListener("click", exportTimelineCsvForSelectedSession);

  $("#closeGroupCreateBtn")?.addEventListener("click", closeCreateGroupModal);
  $("#cancelGroupCreateBtn")?.addEventListener("click", closeCreateGroupModal);
  $("#groupCreateBackdrop")?.addEventListener("click", closeCreateGroupModal);
  $("#saveGroupBtn")?.addEventListener("click", saveCreatedGroup);

  $("#closeGroupEditBtn")?.addEventListener("click", closeGroupEditModal);
  $("#cancelGroupEditBtn")?.addEventListener("click", closeGroupEditModal);
  $("#groupEditBackdrop")?.addEventListener("click", closeGroupEditModal);
  $("#saveGroupEditBtn")?.addEventListener("click", saveGroupEdit);
  $("#closeTimelineBtn2")?.addEventListener("click", closeTimelineModal);
  $("#timelineModalBackdrop")?.addEventListener("click", closeTimelineModal);

  $("#closeSessionMapBtn")?.addEventListener("click", closeSessionMapModal);
  $("#closeSessionMapBtn2")?.addEventListener("click", closeSessionMapModal);
  $("#sessionMapModalBackdrop")?.addEventListener("click", closeSessionMapModal);

  const mapControlIds = [
    "#mapShowPoints",
    "#mapShowTrajectory",
    "#mapShowEndpoints",
    "#mapShowViewportRects",
    "#mapShowAllViewportRects",
    "#mapPointsColorInput",
    "#mapLineColorInput",
  ];
  mapControlIds.forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    const evt = sel.includes("Color") ? "input" : "change";
    el.addEventListener(evt, applyMapLayerStyles);
  });

  const taskMapControlIds = [
    "#taskMapShowPoints",
    "#taskMapShowTrajectory",
    "#taskMapShowEndpoints",
    "#taskMapShowViewportRects",
    "#taskMapShowAllViewportRects",
    "#taskMapPointsColorInput",
    "#taskMapLineColorInput",
  ];
  taskMapControlIds.forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    const evt = sel.includes("Color") ? "input" : "change";
    el.addEventListener(evt, applyTaskMapLayerStyles);
  });

  $("#closeGroupsCompareBtn")?.addEventListener("click", closeGroupCompareModal);
  $("#closeGroupsCompareBtn2")?.addEventListener("click", closeGroupCompareModal);
  $("#groupsCompareBackdrop")?.addEventListener("click", closeGroupCompareModal);

  $("#settingsDeleteConfirmCloseBtn")?.addEventListener("click", closeSettingsDeleteConfirmModal);
  $("#settingsDeleteConfirmCancelBtn")?.addEventListener("click", closeSettingsDeleteConfirmModal);
  $("#settingsDeleteConfirmBackdrop")?.addEventListener("click", closeSettingsDeleteConfirmModal);
  $("#settingsDeleteConfirmOkBtn")?.addEventListener("click", confirmDeleteSettingsSessions);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal1 = $("#taskMetricsModal");
      if (modal1 && !modal1.classList.contains("hidden")) closeTaskModal();

      const modal2 = $("#timelineModal");
      if (modal2 && !modal2.classList.contains("hidden")) closeTimelineModal();


      const modal3 = $("#uploadTestModal");
      if (modal3 && !modal3.classList.contains("hidden")) closeUploadTestModal();
      
      const modalMap = $("#sessionMapModal");
      if (modalMap && !modalMap.classList.contains("hidden")) closeSessionMapModal();

      const modal4 = $("#groupCreateModal");
      if (modal4 && !modal4.classList.contains("hidden")) closeCreateGroupModal();

      const modal5 = $("#groupEditModal");
      if (modal5 && !modal5.classList.contains("hidden")) closeGroupEditModal();

      const modal6 = $("#groupsCompareModal");
      if (modal6 && !modal6.classList.contains("hidden")) closeGroupCompareModal();

      const modal7 = $("#settingsDeleteConfirmModal");
      if (modal7 && !modal7.classList.contains("hidden")) closeSettingsDeleteConfirmModal();
    }
  });
}

function openUploadTestModal(kind) {
  const modal = $("#uploadTestModal");
  const select = $("#uploadTestSelect");
  if (!modal || !select) return;

  select.innerHTML = state.tests.map((testId) => `
    <option value="${escapeHtml(testId)}">${escapeHtml(testId)}</option>
  `).join("");

  select.value = state.selectedTestId ?? state.tests[0] ?? "TEST";
  modal.dataset.kind = kind;
  show(modal);
}

function closeUploadTestModal() {
  hide($("#uploadTestModal"));
  const modal = $("#uploadTestModal");
  if (modal) delete modal.dataset.kind;
}

function wireUploadTestModal() {
  $("#uploadSingleBtn")?.addEventListener("click", () => openUploadTestModal("single"));
  $("#uploadBulkBtn")?.addEventListener("click", () => openUploadTestModal("bulk"));

  $("#closeUploadTestBtn")?.addEventListener("click", closeUploadTestModal);
  $("#cancelUploadTestBtn")?.addEventListener("click", closeUploadTestModal);
  $("#uploadTestModalBackdrop")?.addEventListener("click", closeUploadTestModal);

  $("#confirmUploadTestBtn")?.addEventListener("click", () => {
    const modal = $("#uploadTestModal");
    const select = $("#uploadTestSelect");
    if (!modal || !select) return;

    const testId = normalizeTestId(select.value) ?? "TEST";
    const kind = modal.dataset.kind;
    state.pendingUpload = { kind, testId };
    closeUploadTestModal();

    if (kind === "bulk") {
      $("#bulkCsvInput")?.click();
    } else {
      $("#csvInput")?.click();
    }
  });
}

function wireUpload() {
  const input = $("#csvInput");
  if (!input) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const testId = state.pendingUpload?.kind === "single"
      ? state.pendingUpload?.testId
      : (state.selectedTestId ?? "TEST");
    state.pendingUpload = null;
    
    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Nahrávám: ${file.name}…`;

    try {
      const out = await apiUpload(file, testId ?? "TEST");
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

    const testId = state.pendingUpload?.kind === "bulk"
      ? state.pendingUpload?.testId
      : (state.selectedTestId ?? "TEST");
    state.pendingUpload = null;

    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Nahrávám hromadné CSV: ${file.name}…`;

    try {
      const out = await apiUploadBulk(file, testId ?? "TEST");
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
  const selectAllBtn = $("#selectFilteredSessionsBtn");
  const clearSelectionBtn = $("#clearSessionSelectionBtn");

if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !userIdEl || !clearBtn || !selectAllBtn || !clearSelectionBtn) return;

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

  selectAllBtn.addEventListener("click", () => {
    const sessions = getSessionsForSelectedTest();
    const filteredSessions = applySessionFilters(sessions);
    if (!filteredSessions.length) return;

    const selected = new Set(state.selectedSessionIds ?? []);
    filteredSessions.forEach((session) => selected.add(session.session_id));
    state.selectedSessionIds = Array.from(selected);
    persistGroupDraftSelection();
    renderSessionsList();
  });

  clearSelectionBtn.addEventListener("click", () => {
    state.selectedSessionIds = [];
    persistGroupDraftSelection();
    renderSessionsList();
  });

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

function wireSettingsSessionFilters() {
  const genderEl = $("#settingsSessionFilterGender");
  const occupationEl = $("#settingsSessionFilterOccupation");
  const nationalityEl = $("#settingsSessionFilterNationality");
  const ageMinEl = $("#settingsSessionFilterAgeMin");
  const ageMaxEl = $("#settingsSessionFilterAgeMax");
  const userIdEl = $("#settingsSessionFilterUserId");
  const clearBtn = $("#settingsClearFiltersBtn");
  const selectAllBtn = $("#settingsSelectAllFilteredBtn");
  const clearSelectionBtn = $("#settingsClearSelectionBtn");

  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !userIdEl || !clearBtn || !selectAllBtn || !clearSelectionBtn) return;

  const updateAndRender = () => {
    state.settingsSessionFilters.gender = genderEl.value;
    state.settingsSessionFilters.occupation = occupationEl.value;
    state.settingsSessionFilters.nationality = nationalityEl.value;
    state.settingsSessionFilters.ageMin = ageMinEl.value;
    state.settingsSessionFilters.ageMax = ageMaxEl.value;
    state.settingsSessionFilters.userIdQuery = userIdEl.value;
    renderSettingsSessionsTab();
  };

  genderEl.addEventListener("change", updateAndRender);
  occupationEl.addEventListener("change", updateAndRender);
  nationalityEl.addEventListener("change", updateAndRender);
  ageMinEl.addEventListener("input", updateAndRender);
  ageMaxEl.addEventListener("input", updateAndRender);
  userIdEl.addEventListener("input", updateAndRender);

  selectAllBtn.addEventListener("click", () => {
    const sessions = getSessionsForSelectedTest();
    const filtered = applySettingsSessionFilters(sessions);
    const selected = new Set(state.settingsSessionSelection ?? []);
    filtered.forEach((session) => selected.add(session.session_id));
    state.settingsSessionSelection = Array.from(selected);
    renderSettingsSessionsTab();
  });

  clearSelectionBtn.addEventListener("click", () => {
    state.settingsSessionSelection = [];
    renderSettingsSessionsTab();
  });

  clearBtn.addEventListener("click", () => {
    state.settingsSessionFilters = {
      gender: "",
      ageMin: "",
      ageMax: "",
      occupation: "",
      nationality: "",
      userIdQuery: "",
    };
    renderSettingsSessionsTab();
  });
}

// ===== Init =====
async function init() {
  wireNavButtons();
  wireTestControls();
  wireModal();
  wireUploadTestModal();
  wireUpload();
  wireBulkUpload();
  wireSessionFilters();
  wireSettingsSessionFilters();
  wireGroupEditFilters();

  state.tests = loadTestsFromStorage();
  state.selectedTestId = loadSelectedTestFromStorage(state.tests);
  renderTestsList();

  try {
    await refreshSessions();
  } catch (e) {
    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Backend nedostupný: ${e?.message ?? e}`;
  }

  selectTest(state.selectedTestId ?? "TEST");
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