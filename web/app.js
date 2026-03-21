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
  hide($("#view-group-edit"));
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

function normalizeBooleanLike(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return null;
}

function formatBooleanCharacteristic(value) {
  const normalized = normalizeBooleanLike(value);
  if (normalized === true) return "Yes";
  if (normalized === false) return "No";
  return value ?? "—";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeFileNamePart(value, fallback = "export") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function downloadGeoJsonFile(featureCollection, suggestedBaseName) {
  const blob = new Blob([JSON.stringify(featureCollection, null, 2)], { type: "application/geo+json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFileNamePart(suggestedBaseName, "export")}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isCoordinateLike(s) {
  if (!s) return false;
  return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(String(s).trim());
}

const INTERVAL_EVENT_OPTIONS = [
  { key: "move", label: "Move", color: "#4F8EF7" },
  { key: "zoom", label: "Zoom", color: "#8B5CF6" },
  { key: "popup", label: "Popup", color: "#14B8A6" },
];
const INTERVAL_OTHER_OPTION = { key: "other", label: "Other", color: "#94A3B8" };

const TESTS_STORAGE_KEY = "maptrack_tests";
const SELECTED_TEST_STORAGE_KEY = "maptrack_selected_test";
const GROUP_DRAFT_SELECTION_KEY = "maptrack_group_selection";


// ===== App State =====
const state = {
  selectedTestId: "TEST",
  selectedSessionId: null,
  selectedSession: null,
  selectedTaskId: null,
  intervalRatiosSelection: {
    taskKey: "ALL_TASKS",
    visibleEventKeys: INTERVAL_EVENT_OPTIONS.map((option) => option.key),
  },
  selectedSessionIds: [],
  sessions: [],
  tests: [],
  groups: [],
  selectedGroupId: null,
  selectedGroupCompareIds: [],
  groupsSearchQuery: "",
  groupCompareTab: "summary",
  groupCompareChartDimension: "nationality",
  groupCompareChartSortMode: "overall",
  groupCompareChartReferenceGroupId: null,
  groupCompareChartColors: {},
  groupTaskSearchQuery: "",
  selectedGroupCompareTaskId: null,
  isGroupUsersExpanded: false,
  groupEditSessionIds: [],
  groupEditFlaggedSessionIds: [],
  groupEditSelectedSessionId: null,
  groupEditTab: "sessions",
  groupEditShowOnlyFlagged: false,
  groupEditMetrics: ["tasks", "events", "duration", "accuracy", "age", "gender"],
  sessionMetrics: ["tasks", "events", "duration", "accuracy", "age", "gender"],
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
    currentSpatialPayload: null,
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
  return tests[0] ?? null;
}

function saveSelectedTestToStorage(testId) {
  try {
    if (testId === null || testId === undefined) localStorage.removeItem(SELECTED_TEST_STORAGE_KEY);
    else localStorage.setItem(SELECTED_TEST_STORAGE_KEY, testId);
  } catch {
    /* ignore */
  }
}

function syncTestsWithSessions(sessions) {
  const seen = new Set(state.tests);
  sessions.forEach((s) => {
    const testId = normalizeTestId(s.test_id);
    if (!testId || seen.has(testId)) return;
    seen.add(testId);
    state.tests.push(testId);
  });
  state.tests = Array.from(new Set(state.tests));
  saveTestsToStorage(state.tests);
}

function getSessionsForSelectedTest() {
  const testId = normalizeTestId(state.selectedTestId);
  if (!testId) return [];
  return state.sessions.filter((s) => normalizeTestId(s.test_id) === testId);
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

function redirectToLogin() {
  if (window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

async function parseApiError(res) {
  let err = {};
  try { err = await res.json(); } catch { }
  return err?.detail ?? res.statusText;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  return res;
}

async function apiGet(path) {
  const res = await apiFetch(path);
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiPostJson(path, payload = {}) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiLogout() {
  try {
    await apiPostJson("/api/auth/logout", {});
  } catch (error) {
    if (String(error?.message ?? error) !== "Unauthorized") {
      throw error;
    }
  }
}

async function apiListTests() {
  return apiGet("/api/tests");
}

async function apiCreateTest(payload) {
  return apiPostJson("/api/tests", payload);
}

async function apiUpload(file, testId) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("test_id", testId);
  const res = await apiFetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiUploadBulk(file, testId) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("test_id", testId);
  const res = await apiFetch("/api/upload/bulk", { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiGetUploadJob(jobId) {
  return apiGet(`/api/upload/jobs/${encodeURIComponent(jobId)}`);
}

async function apiGetTestAnswers(testId) {
  return apiGet(`/api/tests/${encodeURIComponent(testId)}/answers`);
}

async function apiPutTestAnswer(testId, taskName, answerOrNull) {
  const res = await apiFetch(
    `/api/tests/${encodeURIComponent(testId)}/answers/${encodeURIComponent(taskName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: answerOrNull }),
    }
  );

  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

function apiGetTestAnswersExportCsvUrl(testId) {
  return `/api/tests/${encodeURIComponent(testId)}/answers/export-csv`;
}

function apiGetTestAnswersTemplateCsvUrl(testId) {
  return `/api/tests/${encodeURIComponent(testId)}/answers/template-csv`;
}

async function apiUploadTestAnswersCsv(testId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/tests/${encodeURIComponent(testId)}/answers/upload-csv`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiDeleteSessions(testId, sessionIds) {
  const res = await apiFetch(`/api/tests/${encodeURIComponent(testId)}/sessions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_ids: sessionIds }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiDeleteAllSessions(testId) {
  const res = await apiFetch(`/api/tests/${encodeURIComponent(testId)}/sessions/all`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiGetTestSettings(testId) {
  return apiGet(`/api/tests/${encodeURIComponent(testId)}/settings`);
}

async function apiUpdateTestSettings(testId, payload) {
  const res = await apiFetch(`/api/tests/${encodeURIComponent(testId)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiDeleteTest(testId) {
  const res = await apiFetch(`/api/tests/${encodeURIComponent(testId)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
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
  return apiPostJson("/api/groups", payload);
}

async function apiUpdateGroup(groupId, payload) {
  const res = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiUpdateGroupSettings(groupId, payload) {
  const res = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return res.json();
}

async function apiDeleteGroup(groupId) {
  const res = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
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

function apiGetGroupExportCsvUrl(groupId) {
  return `/api/groups/${encodeURIComponent(groupId)}/export-csv`;
}

async function apiCompareWordcloud(groupIds, taskId = null) {
  const res = await apiFetch(`/api/groups/compare/wordcloud`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_ids: groupIds, task_id: taskId }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
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
        <div class="empty-title">Nothing yet</div>
        <div class="muted small">No data available.</div>
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
        <div class="empty-title">No user experiments yet</div>
        <div class="muted small">Click “Add user experiment” to create a new user experiment.</div>
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
        <div class="muted small"></div>
        <div class="row actions">
          <button class="btn btn-ghost" data-action="settings" type="button">Settings</button>
          <button class="btn" data-action="open" type="button">Open user experiment</button>
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
        <div class="empty-title">No data yet</div>
        <div class="muted small">
          Upload one or more sessions (CSV). The number of sessions in the experiment will then be shown here.
        </div>
      </div>
    `;
    return;
  }

  renderMetricGrid(
    { "Number of sessions in the user experiment": sessions.length },
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

  genderEl.innerHTML = makeOptions(options.gender, "All");
  occupationEl.innerHTML = makeOptions(options.occupation, "All");
  nationalityEl.innerHTML = makeOptions(options.nationality, "All");

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
    if (summaryEl) summaryEl.textContent = "Showing 0 of 0";
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">No sessions</div>
        <div class="muted small">Upload a CSV file on the dashboard to see sessions here.</div>
      </div>
    `;
    return;
  }

  const filteredSessions = applySessionFilters(sessions);
  if (summaryEl) {
    const selectedCount = (state.selectedSessionIds ?? []).filter((sid) => sessions.some((s) => s.session_id === sid)).length;
    summaryEl.textContent = `Showing ${filteredSessions.length} z ${sessions.length} · Selected ${selectedCount}`;
  }

  if (!filteredSessions.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">No sessions match the filter</div>
        <div class="muted small">Adjust the filters or clear them using the "Clear filter" button.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = filteredSessions.map((s) => {
    const selected = s.session_id === state.selectedSessionId ? "is-selected" : "";
    const checked = (state.selectedSessionIds ?? []).includes(s.session_id) ? "checked" : "";

    return `
      <div class="list-item ${selected}" data-session="${escapeHtml(s.session_id)}" style="cursor:default;">
        <div class="row" style="justify-content:flex-start; gap:10px; cursor:default;">
          <input type="checkbox" data-role="group-select" data-session="${escapeHtml(s.session_id)}" ${checked} />
          <div>
            <div class="title">${escapeHtml(s.user_id ?? "—")}</div>
            <div class="muted small">session: ${escapeHtml(s.session_id)}</div>
          </div>
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

function renderSessionMetricsPicker() {
  const el = $("#sessionMetricsPicker");
  if (!el) return;

  const selected = new Set(state.sessionMetrics ?? []);
  el.innerHTML = SESSION_METRIC_OPTIONS.map((m) => {
    const isSelected = selected.has(m.key);
    const active = isSelected ? "is-selected" : "is-unselected";
    return `<button class="chip group-edit-metric-chip ${active}" type="button" aria-pressed="${isSelected ? "true" : "false"}" data-role="session-metric" data-key="${escapeHtml(m.key)}">${escapeHtml(m.label)}</button>`;
  }).join("");

  $$("#sessionMetricsPicker [data-role='session-metric']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const set = new Set(state.sessionMetrics ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      state.sessionMetrics = SESSION_METRIC_OPTIONS.map((x) => x.key).filter((k) => set.has(k));
      renderSessionMetricsPicker();
      renderSessionMetrics();
    });
  });
}

function renderSessionMetrics() {
  const el = $("#sessionMetrics");
  const btn = $("#openSessionBtn");
  renderSessionMetricsPicker();
  if (!el) return;

  if (!state.selectedSession) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-title">Select a session</div>
        <div class="muted small">Click a session on the left to display its metrics here.</div>
      </div>
    `;
    renderSessionDeviceInfo();
    if (btn) btn.disabled = true;
    return;
  }

  const s = state.selectedSession;
  const sessionStats = s.stats?.session ?? {};
  const soc = sessionStats.soc_demo ?? {};
  const answersSummary = s.stats?.answers_eval?.summary ?? {};
  const mapping = {
    tasks: ["Number of tasks", sessionStats.tasks_count ?? (Array.isArray(s.tasks) ? s.tasks.length : "—")],
    events: ["Number of events", sessionStats.events_total ?? "—"],
    duration: ["Total completion time", fmtMs(sessionStats.duration_ms)],
    accuracy: ["Average answer accuracy", fmtPercent(answersSummary.accuracy)],
    age: ["Age", soc.age ?? "—"],
    gender: ["Gender", soc.gender ?? "—"],
    occupation: ["Occupation", soc.occupation ?? "—"],
    nationality: ["Nationality", soc.nationality ?? "—"],
    education: ["Education", soc.education ?? "—"],
    device: ["Device", soc.device ?? "—"],
    confidence: ["Confidence", formatBooleanCharacteristic(soc.confidence)],
    paper_maps: ["Paper maps", formatBooleanCharacteristic(soc.paper_maps)],
    computer_maps: ["Computer maps", formatBooleanCharacteristic(soc.computer_maps)],
    mobile_maps: ["Mobile maps", formatBooleanCharacteristic(soc.mobile_maps)],
  };

  const rows = { UserID: s.user_id ?? "—" };
  for (const key of (state.sessionMetrics ?? [])) {
    const metric = mapping[key];
    if (metric) rows[metric[0]] = metric[1];
  }
  renderMetricGrid(rows, el);
  renderSessionDeviceInfo();

  if (btn) btn.disabled = false;
}

function renderSessionDeviceInfo() {
  const el = $("#sessionDeviceInfoPanel");
  if (!el) return;

  const session = state.selectedSession;
  if (!session) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-title">Select a session</div>
        <div class="muted small">Device information will appear here for the currently selected session.</div>
      </div>
    `;
    return;
  }

  const soc = session?.stats?.session?.soc_demo ?? {};
  renderMetricGrid({
    "Screen resolution": soc.screenResolution ?? "—",
    "Viewport size": soc.viewportSize ?? "—",
    "Browser": soc.browser ?? "—",
    "Browser version": soc.browserVersion ?? "—",
    "Device": soc.device ?? "—",
    "Operating system": soc.os ?? "—",
    "IP address": soc.ip ?? "—",
  }, el);
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
    renderSettingsStatus("Loading saved answers…");
    const out = await apiGetTestAnswers(testId);
    state.correctAnswers[testId] = out.answers ?? {};
    renderSettingsStatus("Loaded.");
  } catch (e) {
    renderSettingsStatus(`Error loading: ${e?.message ?? e}`);
    state.correctAnswers[testId] = state.correctAnswers[testId] ?? {};
  }
}

async function loadAllTestSettings() {
  const testIds = Array.from(new Set(state.tests ?? []));
  await Promise.all(testIds.map(async (testId) => {
    try {
      const out = await apiGetTestSettings(testId);
      state.testSettings[testId] = {
        name: String(out?.name ?? "").trim(),
        note: String(out?.note ?? ""),
      };
    } catch {
      state.testSettings[testId] = state.testSettings[testId] ?? { name: "", note: "" };
    }
  }));
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

async function loadTestsCatalogFromBackend() {
  try {
    const out = await apiListTests();
    const tests = Array.isArray(out?.tests) ? out.tests : [];
    const ids = tests
      .map((row) => normalizeTestId(row?.id))
      .filter(Boolean);

    state.tests = Array.from(new Set(ids));
    saveTestsToStorage(state.tests);

    if (!state.tests.includes(state.selectedTestId)) {
      state.selectedTestId = state.tests[0] ?? null;
      saveSelectedTestToStorage(state.selectedTestId);
    }

    tests.forEach((row) => {
      const testId = normalizeTestId(row?.id);
      if (!testId) return;
      state.testSettings[testId] = {
        name: String(row?.name ?? "").trim(),
        note: String(row?.note ?? ""),
      };
    });
  } catch {
    // fallback to local storage + per-test loading
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
    renderSettingsStatus("Saving...");
    const result = await apiPutTestAnswer(testId, taskId, answerTextOrNull);
    await refreshSessions();
    await refreshGroups();
    renderSettingsPage();
    renderSessionsList();
    renderTestAggMetrics();

    const recalculation = result?.recalculation;
    if (recalculation && Number.isFinite(Number(recalculation.matched))) {
      renderSettingsStatus(`Saved. Recalculated sessions: ${Number(recalculation.updated)}/${Number(recalculation.matched)}.`);
    } else {
      renderSettingsStatus("Saved.");
    }
  } catch (e) {
    renderSettingsStatus(`Error saving: ${e?.message ?? e}`);
  }
}

async function downloadSettingsAnswersCsv(kind = "answers") {
  const testId = state.selectedTestId ?? "TEST";
  const isTemplate = kind === "template";
  const btn = isTemplate ? $("#settingsDownloadTemplateCsvBtn") : $("#settingsDownloadAnswersCsvBtn");
  const originalLabel = btn?.textContent;

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Downloading…";
    }

    const url = isTemplate
      ? apiGetTestAnswersTemplateCsvUrl(testId)
      : apiGetTestAnswersExportCsvUrl(testId);

    const res = await apiFetch(url);
    if (!res.ok) {
      throw new Error(await parseApiError(res));
    }

    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = isTemplate ? `test_${testId}_answers_template.csv` : `test_${testId}_answers.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    renderSettingsStatus(isTemplate ? "Template CSV downloaded." : "Correct answers CSV downloaded.");
  } catch (e) {
    renderSettingsStatus(`Error downloading CSV: ${e?.message ?? e}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || (isTemplate ? "Download template CSV" : "Download CSV");
    }
  }
}

async function uploadSettingsAnswersCsv(file) {
  if (!file) return;
  const testId = state.selectedTestId ?? "TEST";
  renderSettingsStatus("Uploading CSV with correct answers…");

  try {
    const out = await apiUploadTestAnswersCsv(testId, file);
    state.correctAnswers[testId] = out?.answers ?? {};
    await refreshSessions();
    await refreshGroups();
    renderSettingsPage();
    renderSessionsList();
    renderTestAggMetrics();

    const recalculation = out?.recalculation;
    const recalcText = recalculation && Number.isFinite(Number(recalculation.matched))
      ? ` Recalculated sessions: ${Number(recalculation.updated)}/${Number(recalculation.matched)}.`
      : "";

    renderSettingsStatus(`CSV uploaded. Processed rows: ${Number(out?.rows_valid ?? 0)}.${recalcText}`);
  } catch (e) {
    renderSettingsStatus(`Error uploading CSV: ${e?.message ?? e}`);
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

  genderEl.innerHTML = makeOptions(options.gender, "All");
  occupationEl.innerHTML = makeOptions(options.occupation, "All");
  nationalityEl.innerHTML = makeOptions(options.nationality, "All");

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

  if (summaryEl) summaryEl.textContent = `Showing ${filtered.length} of ${sessions.length} · Selected ${selectedSet.size}`;
  if (statusEl && !statusEl.textContent) statusEl.textContent = "—";

  if (!sessions.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">There are no sessions in this test yet</div></div>`;
    return;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">No sessions match the filter</div></div>`;
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
          <div class="empty-title">No tasks yet</div>
          <div class="muted small">Upload at least one session (CSV) to load task names.</div>
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
                <div class="muted small">Correct Answer (text)</div>
              </div>

              <input
                type="text"
                inputmode="text"
                value="${escapeHtml(valueAttr)}"
                placeholder="e.g., Prague"
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
      textEl.textContent = "You are about to delete the entire user experiment including all sessions, groups, answers and other linked data. Do you really want to continue?";
    }
    show($("#settingsDeleteConfirmModal"));
    return;
  }

  if (!count) {
    const statusEl = $("#settingsSessionStatus");
    if (statusEl) statusEl.textContent = mode === "all" ? "There are no sessions to delete in this experiment." : "Select at least one session first.";
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
    textEl.textContent = `You are about to delete ${count} sessions. This will remove them from the database. Do you really want to continue?`;
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
      if (statusEl) statusEl.textContent = "Deleting user experiment";
      await apiDeleteTest(deletingTestId);
      delete state.testSettings[deletingTestId];
      delete state.correctAnswers[deletingTestId];
      await loadTestsCatalogFromBackend();
      state.tests = (state.tests ?? []).filter((id) => id !== deletingTestId);
      saveTestsToStorage(state.tests);
      const nextTestId = state.tests[0] ?? null;
      selectTest(nextTestId);
      setPage("dashboard");
      await refreshSessions();
      if (state.selectedTestId) await refreshGroups();
      else {
        state.groups = [];
        state.selectedGroupId = null;
      }
      renderTestsList();
      renderSettingsPage();
      renderSessionsList();
      renderTestAggMetrics();
      if (statusEl) statusEl.textContent = "User experiment deleted.";
      return;
    }

    if (statusEl) statusEl.textContent = "Deleting sessions…";
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
    if (statusEl) statusEl.textContent = `Deleted: ${target.count} sessions.`;
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error deleting: ${e?.message ?? e}`;
  } finally {
    closeSettingsDeleteConfirmModal();
  }
}

async function saveUserTestSettings() {
  const previousTestId = state.selectedTestId ?? "TEST";
  const nameInput = $("#settingsUserTestNameInput");
  const noteInput = $("#settingsUserTestNoteInput");
  const statusEl = $("#settingsUserTestStatus");

  const name = String(nameInput?.value ?? "").trim();
  const note = String(noteInput?.value ?? "");

  try {
    if (statusEl) statusEl.textContent = "Saving experiment settings…";
    const out = await apiUpdateTestSettings(previousTestId, { name, note });
    const updatedTestId = normalizeTestId(out?.test_id) ?? previousTestId;

    if (updatedTestId !== previousTestId) {
      state.tests = (state.tests ?? []).map((id) => (id === previousTestId ? updatedTestId : id));
      state.tests = Array.from(new Set(state.tests));
      saveTestsToStorage(state.tests);

      if (state.correctAnswers?.[previousTestId]) {
        state.correctAnswers[updatedTestId] = state.correctAnswers[previousTestId];
        delete state.correctAnswers[previousTestId];
      }
      if (state.testSettings?.[previousTestId]) {
        state.testSettings[updatedTestId] = state.testSettings[previousTestId];
        delete state.testSettings[previousTestId];
      }

      state.selectedTestId = updatedTestId;
      saveSelectedTestToStorage(updatedTestId);
      await refreshSessions();
      await refreshGroups();
    }

    state.testSettings[updatedTestId] = { name: String(out?.name ?? ""), note: String(out?.note ?? "") };
    renderTestsList();
    renderSettingsPage();
    if (statusEl) {
      statusEl.textContent = updatedTestId === previousTestId
        ? "Saved."
        : `Saved. Experiment ID changed to: ${updatedTestId}`;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error saving: ${e?.message ?? e}`;
  }
}

// ===== Tasks page =====
function inferTasksForSelectedSession() {
  const s = state.selectedSession;
  if (!s) return [];
  if (Array.isArray(s.tasks) && s.tasks.length) return s.tasks;
  return [s.task ?? "unknown"];
}

function getSelectedSessionIntervalRatios() {
  return state.selectedSession?.stats?.interval_event_ratios ?? null;
}

function getIntervalRatioTaskOptions() {
  const payload = getSelectedSessionIntervalRatios();
  const sessionTasks = inferTasksForSelectedSession();
  const byTask = payload?.by_task ?? {};
  const options = [{ key: "ALL_TASKS", label: "All tasks" }];

  sessionTasks.forEach((taskId) => {
    if (taskId in byTask) {
      options.push({ key: taskId, label: taskId });
    }
  });

  Object.keys(byTask).forEach((taskId) => {
    if (!options.some((option) => option.key === taskId)) {
      options.push({ key: taskId, label: taskId });
    }
  });

  return options;
}

function getSelectedIntervalRatioScopePayload() {
  const payload = getSelectedSessionIntervalRatios();
  if (!payload) return null;

  const selectedKey = state.intervalRatiosSelection?.taskKey ?? "ALL_TASKS";
  if (selectedKey === "ALL_TASKS") return payload.all_tasks ?? null;
  return payload.by_task?.[selectedKey] ?? null;
}

function renderIntervalRatiosModal() {
  const subtitle = $("#intervalRatiosModalSubtitle");
  const taskSelect = $("#intervalRatiosTaskSelect");
  const togglesEl = $("#intervalRatiosEventToggles");
  const contentEl = $("#intervalRatiosContent");
  const session = state.selectedSession;
  const payload = getSelectedSessionIntervalRatios();

  if (subtitle) {
    subtitle.textContent = session?.session_id
      ? `Session: ${session.session_id} · User: ${session.user_id ?? "—"}`
      : "—";
  }

  if (!taskSelect || !togglesEl || !contentEl) return;

  const taskOptions = getIntervalRatioTaskOptions();
  if (!taskOptions.some((option) => option.key === state.intervalRatiosSelection.taskKey)) {
    state.intervalRatiosSelection.taskKey = "ALL_TASKS";
  }

  taskSelect.innerHTML = taskOptions
    .map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`)
    .join("");
  taskSelect.value = state.intervalRatiosSelection.taskKey;

  const selectedVisible = new Set(state.intervalRatiosSelection.visibleEventKeys ?? []);
  togglesEl.innerHTML = INTERVAL_EVENT_OPTIONS.map((option) => `
    <label class="interval-ratios-toggle">
      <input type="checkbox" data-role="interval-ratio-toggle" value="${escapeHtml(option.key)}" ${selectedVisible.has(option.key) ? "checked" : ""} />
      <span class="interval-ratios-dot" style="background:${option.color};"></span>
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("");

  const scopePayload = getSelectedIntervalRatioScopePayload();
  if (!session || !payload || !scopePayload) {
    contentEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">No interval ratios available</div>
        <div class="muted small">Select a session with computed task durations and interval events.</div>
      </div>
    `;
  } else {
    const visibleOptions = INTERVAL_EVENT_OPTIONS.filter((option) => selectedVisible.has(option.key));
    const scopeLabel = state.intervalRatiosSelection.taskKey === "ALL_TASKS" ? "All tasks" : state.intervalRatiosSelection.taskKey;
    const taskDurationMs = Math.max(0, safeNum(scopePayload.task_duration_ms) ?? 0);
    const visibleDurationMs = visibleOptions.reduce((sum, option) => {
      const durationMs = safeNum(scopePayload.events?.[option.key]?.duration_ms) ?? 0;
      return sum + Math.max(0, durationMs);
    }, 0);
    const otherDurationMs = Math.max(0, taskDurationMs - visibleDurationMs);
    const otherRatio = taskDurationMs > 0 ? (otherDurationMs / taskDurationMs) : 0;
    const dominantBehavior = scopePayload?.dominant_behavior ?? null;

    const chartRows = [
      ...visibleOptions.map((option) => {
        const eventPayload = scopePayload.events?.[option.key] ?? {};
        const ratio = safeNum(eventPayload.ratio);
        const durationMs = safeNum(eventPayload.duration_ms) ?? 0;
        const width = Math.max(0, Math.min(100, (ratio ?? 0) * 100));
        return `
          <div class="interval-ratios-row">
            <div class="interval-ratios-label">
              <span class="interval-ratios-dot" style="background:${option.color};"></span>
              <span>${escapeHtml(option.label)}</span>
            </div>
            <div class="interval-ratios-bar-track">
              <div class="interval-ratios-bar-fill" style="width:${width}%; background:${option.color};"></div>
              <div class="interval-ratios-bar-text">${fmtPercent(ratio ?? 0)}</div>
            </div>
            <div class="interval-ratios-value">${fmtMs(durationMs)}</div>
          </div>
        `;
      }),
      `
        <div class="interval-ratios-row">
          <div class="interval-ratios-label">
            <span class="interval-ratios-dot" style="background:${INTERVAL_OTHER_OPTION.color};"></span>
            <span>${escapeHtml(INTERVAL_OTHER_OPTION.label)}</span>
          </div>
          <div class="interval-ratios-bar-track">
            <div class="interval-ratios-bar-fill" style="width:${Math.max(0, Math.min(100, otherRatio * 100))}%; background:${INTERVAL_OTHER_OPTION.color};"></div>
            <div class="interval-ratios-bar-text">${fmtPercent(otherRatio)}</div>
          </div>
          <div class="interval-ratios-value">${fmtMs(otherDurationMs)}</div>
        </div>
      `,
    ].join("");

    const dominantBehaviorColor = (INTERVAL_EVENT_OPTIONS.find((option) => option.key === dominantBehavior?.event_key) ?? INTERVAL_OTHER_OPTION).color;

    const dominantBehaviorMarkup = dominantBehavior?.event_key ? `
      <div class="interval-ratios-summary">
        <div class="interval-ratios-summary-label">Dominant behavior</div>
        <div class="interval-ratios-summary-main">
          <span class="interval-ratios-dot" style="background:${dominantBehaviorColor};"></span>
          <span>${escapeHtml(dominantBehavior.label ?? dominantBehavior.event_key ?? "—")}</span>
        </div>
        <div class="interval-ratios-summary-sub">${fmtPercent(safeNum(dominantBehavior.ratio) ?? 0)} · ${fmtMs(safeNum(dominantBehavior.duration_ms) ?? 0)}</div>
      </div>
    ` : `
      <div class="interval-ratios-summary">
        <div class="interval-ratios-summary-label">Dominant behavior</div>
        <div class="interval-ratios-summary-main">—</div>
        <div class="interval-ratios-summary-sub">No MOVE / ZOOM / POPUP interval recorded for this scope.</div>
      </div>
    `;

      contentEl.innerHTML = `
      <div class="interval-ratios-panel">
        <div class="interval-ratios-title">${escapeHtml(scopeLabel)}</div>
        <div class="interval-ratios-subtitle">100% = total completion time of the selected task scope (${fmtMs(taskDurationMs)}).</div>
        ${dominantBehaviorMarkup}
        <div class="interval-ratios-chart-card">
          <div class="interval-ratios-chart">${chartRows}</div>
        </div>
        <div class="interval-ratios-footnote">Right column shows summed duration. “Other” is the remaining task time that is not currently displayed in Move / Zoom / Popup, so the chart always sums to 100%.</div>
      </div>
    `;
  }

  taskSelect.onchange = () => {
    state.intervalRatiosSelection.taskKey = taskSelect.value || "ALL_TASKS";
    renderIntervalRatiosModal();
  };

  $$(`#intervalRatiosEventToggles [data-role='interval-ratio-toggle']`).forEach((input) => {
    input.addEventListener("change", () => {
      state.intervalRatiosSelection.visibleEventKeys = $$(`#intervalRatiosEventToggles [data-role='interval-ratio-toggle']:checked`)
        .map((checkbox) => checkbox.value);
      renderIntervalRatiosModal();
    });
  });
}

function openIntervalRatiosModal() {
  if (!state.selectedSession) return;
  const taskOptions = getIntervalRatioTaskOptions();
  if (!taskOptions.some((option) => option.key === state.intervalRatiosSelection.taskKey)) {
    state.intervalRatiosSelection.taskKey = "ALL_TASKS";
  }
  show($("#intervalRatiosModal"));
  renderIntervalRatiosModal();
}

function closeIntervalRatiosModal() {
  hide($("#intervalRatiosModal"));
}

function renderTasksList() {
  const listEl = $("#tasksList");
  if (!listEl) return;

  if (!state.selectedSession) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Select a session first</div>
        <div class="muted small">Tasks will be loaded once you select a session in the previous step.</div>
      </div>
    `;
    renderSessionDeviceInfo();
    return;
  }

  const tasks = inferTasksForSelectedSession();
  renderSessionDeviceInfo();

  listEl.innerHTML = tasks.map(t => `
    <div class="list-item" data-task="${escapeHtml(t)}">
      <div class="row">
        <div class="title">${escapeHtml(t)}</div>
        <span class="pill">task</span>
      </div>
      <div class="muted small">Click for metrics (pop-up).</div>
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
    subtitle.textContent = `Session: ${s?.session_id ?? "—"} · Task: ${taskId}`;
  }

  if (metrics) {
    metrics.innerHTML = `
      <div class="empty">
        <div class="empty-title">Loading metrics…</div>
        <div class="muted small">Please wait.</div>
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
    setTaskMapPlaceholderStatus({ title: "Select a session", detail: "Without a selected session, spatial data cannot be loaded." });
    return;
  }

  loadTaskSpatialTraceIntoMap(s.session_id, taskId).catch((e) => {
    clearTaskMapData();
    setTaskMapPlaceholderStatus({ title: "Error loading data", detail: e?.message ?? String(e), isError: true });
  });

  try {
    const m = await apiGetTaskMetrics(s.session_id, taskId);

    renderMetricGrid({
      "Task Duration": fmtMs(m.duration_ms),
      "Event Count": m.events_total ?? "—",
      "User Answer": m.answer ?? "—",
      "Correct Answer": m.correct_answer ?? "—",
      "Correctly": m.is_correct === true ? "YES" : (m.is_correct === false ? "NO" : "—"),
    }, metrics);
  } catch (e) {
    if (metrics) {
      metrics.innerHTML = `
        <div class="empty">
          <div class="empty-title">Error</div>
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
    "Points (pop-ups)": pointsLayer,
    "Trajectory": trajectoryLayer,
    "Trajectory Points": trajectoryPointsLayer,
    "Start/End": endpointLayer,
    "Viewports": viewportLayer,
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
    const kind = layer?.feature?.properties?.kind ?? "Point";
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
    layer.bindTooltip(labelParts.join(" · ") || "Trajectory point", { direction: "top", offset: [0, -8] });

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
  setTaskMapPlaceholderStatus({ title: "Data loaded", detail: `Points (pop-ups): ${pointCount} · Trajectory: ${trackCount} · Start/End: ${endpointCount} · Viewports: ${viewportCount}` });
}

async function loadTaskSpatialTraceIntoMap(sessionId, taskId) {
  setTaskMapPlaceholderStatus({ title: "Loading map data…", detail: "Preparing trajectory and points for the task." });
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

    if (name === "setting task" && openPopup) {
      items.push({
        type: "interval",
        name: "POPUP",
        startTs: openPopup.startTs,
        endTs: ts,
        details: openPopup.details,
      });
      openPopup = null;
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
        <div class="empty-title">No events</div>
        <div class="muted small">Failed to load events for this session.</div>
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
      details: ["time before the first event (reading instructions)"],
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

      const tipText = `${it.name}\nduration: ${fmtSec(durSec)}${detailLines}`;

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
      const tipText = `${it.name}\ntime: ${fmtSec(relSec)}${it.detail ? `\n${it.detail}` : ""}`;

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
          <div class="muted small" style="min-width:80px;">Time</div>
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
              <div class="k">Time</div>
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
        Hover: shows event type + duration/time + text from <b>event_detail</b> (if available).
        Slider: same for a specific time.
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
        det = `duration ${fmtSec(d)}${dLines ? ` · ${dLines}` : ""}`;
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
            <div class="k">Time</div>
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
        <div class="empty-title">Loading Timeline…</div>
        <div class="muted small">Please wait.</div>
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
          <div class="empty-title">Error</div>
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
  const userInput = window.prompt("Exported file name:", suggested);
  if (userInput === null) return;

  let fileName = String(userInput || "").trim() || suggested;
  if (!fileName.toLowerCase().endsWith(".csv")) fileName += ".csv";

  const btn = $("#exportTimelineCsvBtn");
  const originalLabel = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Exporting…";
  }

  try {
    const res = await apiFetch(apiGetSessionEventsExportUrl(s.session_id));
    if (!res.ok) {
      throw new Error(await parseApiError(res));
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
    window.alert(`Export failed: ${e?.message ?? e}`);
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
    <div class="empty-title">${escapeHtml(title ?? "Map status")}</div>
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
  state.map.currentSpatialPayload = null;
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

function buildViewportPolygonCoordinates(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return [];
  const sw = bounds[0];
  const ne = bounds[1];
  if (!Array.isArray(sw) || !Array.isArray(ne) || sw.length < 2 || ne.length < 2) return [];

  const south = Number(sw[0]);
  const west = Number(sw[1]);
  const north = Number(ne[0]);
  const east = Number(ne[1]);
  if (![south, west, north, east].every(Number.isFinite)) return [];

  const buildRing = (ringWest, ringEast) => ([[ringWest, south], [ringEast, south], [ringEast, north], [ringWest, north], [ringWest, south]]);

  if (west > east) {
    return [buildRing(west, 180), buildRing(-180, east)];
  }

  return [buildRing(west, east)];
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
    ["Start", endpoints?.start],
    ["End", endpoints?.end],
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

  state.map.currentSpatialPayload = spatialPayload ?? null;
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
    const kind = layer?.feature?.properties?.kind ?? "Point";
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
    layer.bindTooltip(labelParts.join(" · ") || "Trajectory point", { direction: "top", offset: [0, -8] });

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
    title: "Data loaded",
    detail: `Points (pop-ups): ${pointCount} · Trajectory points: ${trackCount} · Start/End: ${endpointCount} · Viewports: ${viewportCount}`,
  });
}

async function loadSpatialTraceIntoMap(sessionId) {
  setMapPlaceholderStatus({ title: "Loading map data…", detail: "Preparing trajectory and points." });
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
    "Points": pointsLayer,
    "Trajectory": trajectoryLayer,
    "Trajectory Points": trajectoryPointsLayer,
    "Start/End": endpointLayer,
    "Viewports": viewportLayer,
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
      ? `Session: ${s.session_id} · user: ${s.user_id ?? "—"} · data: WGS84`
      : "";
  }

  show($("#sessionMapModal"));
  ensureSessionMapInitialized();
  clearSessionMapData();
  syncMapLegend();

  if (state.map.leafletMap) {
    setTimeout(() => state.map.leafletMap.invalidateSize(), 50);
  }

  if (!s?.session_id) {
    setMapPlaceholderStatus({ title: "Select a session", detail: "Map data cannot be loaded without a selected session." });
    return;
  }

  loadSpatialTraceIntoMap(s.session_id).catch((e) => {
    clearSessionMapData();
    setMapPlaceholderStatus({
      title: "Error loading data",
      detail: e?.message ?? String(e),
      isError: true,
    });
  });
}

function buildSessionTrajectoryExportGeoJson(payload) {
  const spatial = payload?.spatial ?? {};
  const coordinates = Array.isArray(spatial?.track?.points)
    ? spatial.track.points
      .filter((xy) => Array.isArray(xy) && xy.length >= 2)
      .map((xy) => [Number(xy[1]), Number(xy[0])])
      .filter((xy) => Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
    : [];

  return {
    type: "FeatureCollection",
    features: coordinates.length >= 2 ? [{
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        session_id: payload?.session_id ?? null,
        user_id: payload?.user_id ?? null,
      },
    }] : [],
  };
}

function buildSessionTrajectoryPointsExportGeoJson(payload) {
  const spatial = payload?.spatial ?? {};
  const samples = Array.isArray(spatial?.track?.samples) ? spatial.track.samples : [];
  const endpoints = spatial?.movementEndpoints ?? {};
  const endpointItems = [
    { kind: "Start", point: endpoints?.start },
    { kind: "End", point: endpoints?.end },
  ];

  const features = samples
    .filter((sample) => Number.isFinite(Number(sample?.lat)) && Number.isFinite(Number(sample?.lon)))
    .map((sample, index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(sample.lon), Number(sample.lat)] },
      properties: {
        point_type: "trajectory_point",
        index,
        t: Number.isFinite(Number(sample?.timestamp)) ? Number(sample.timestamp) : null,
        z: Number.isFinite(Number(sample?.zoom)) ? Number(sample.zoom) : null,
        task: sample?.task ?? null,
      },
    }));

  endpointItems.forEach(({ kind, point }) => {
    if (!Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lon))) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(point.lon), Number(point.lat)] },
      properties: {
        point_type: kind.toLowerCase(),
        t: Number.isFinite(Number(point?.timestamp)) ? Number(point.timestamp) : null,
        z: null,
        task: point?.task ?? null,
      },
    });
  });

  return { type: "FeatureCollection", features };
}

function buildSessionViewportExportGeoJson(payload) {
  const spatial = payload?.spatial ?? {};
  const samples = Array.isArray(spatial?.track?.samples) ? spatial.track.samples : [];
  const features = samples
    .map((sample, index) => {
      const rings = buildViewportPolygonCoordinates(sample?.viewportBounds);
      if (!rings.length) return null;
      return {
        type: "Feature",
        geometry: {
          type: rings.length > 1 ? "MultiPolygon" : "Polygon",
          coordinates: rings.length > 1 ? rings.map((ring) => [ring]) : [rings[0]],
        },
        properties: {
          point_index: index,
          t: Number.isFinite(Number(sample?.timestamp)) ? Number(sample.timestamp) : null,
          z: Number.isFinite(Number(sample?.zoom)) ? Number(sample.zoom) : null,
          task: sample?.task ?? null,
        },
      };
    })
    .filter(Boolean);

  return { type: "FeatureCollection", features };
}

function exportCurrentSessionMapGeoJson(kind) {
  const payload = state.map.currentSpatialPayload;
  const sessionId = state.selectedSession?.session_id ?? payload?.session_id ?? "session";
  if (!payload) {
    window.alert("No map data is loaded yet.");
    return;
  }

  const exporters = {
    trajectory: {
      build: buildSessionTrajectoryExportGeoJson,
      fileName: `session_${sessionId}_trajectory`,
      emptyMessage: "No trajectory is available for export.",
    },
    trajectoryPoints: {
      build: buildSessionTrajectoryPointsExportGeoJson,
      fileName: `session_${sessionId}_trajectory_points`,
      emptyMessage: "No trajectory points are available for export.",
    },
    viewports: {
      build: buildSessionViewportExportGeoJson,
      fileName: `session_${sessionId}_viewports`,
      emptyMessage: "No viewports are available for export.",
    },
  };

  const selected = exporters[kind];
  if (!selected) return;

  const geojson = selected.build(payload);
  if (!Array.isArray(geojson?.features) || !geojson.features.length) {
    window.alert(selected.emptyMessage);
    return;
  }

  downloadGeoJsonFile(geojson, selected.fileName);
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

function quantileFromSortedNumbers(sortedNums, q) {
  if (!Array.isArray(sortedNums) || !sortedNums.length) return null;
  if (!Number.isFinite(q)) return null;
  if (sortedNums.length === 1) return sortedNums[0];

  const pos = (sortedNums.length - 1) * Math.max(0, Math.min(1, q));
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sortedNums[base];
  const upper = sortedNums[Math.min(base + 1, sortedNums.length - 1)];
  return lower + rest * (upper - lower);
}

function buildBoxplotStats(values) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const q1 = quantileFromSortedNumbers(nums, 0.25);
  const median = quantileFromSortedNumbers(nums, 0.5);
  const q3 = quantileFromSortedNumbers(nums, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const inside = nums.filter((v) => v >= lowerFence && v <= upperFence);
  const outliers = nums.filter((v) => v < lowerFence || v > upperFence);

  return {
    min: nums[0],
    max: nums[nums.length - 1],
    q1,
    median,
    q3,
    iqr,
    lowerFence,
    upperFence,
    whiskerLow: inside.length ? inside[0] : nums[0],
    whiskerHigh: inside.length ? inside[inside.length - 1] : nums[nums.length - 1],
    outliers,
    average: nums.reduce((sum, val) => sum + val, 0) / nums.length,
    count: nums.length,
  };
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
    
    const accuracies = sessions
    .map((s) => {
      if (taskId) {
        const evalTask = s?.stats?.answers_eval?.by_task?.[taskId];
        if (typeof evalTask?.is_correct === "boolean") {
          return evalTask.is_correct ? 1 : 0;
        }
        const taskAccuracy = Number(s?.stats?.tasks?.[taskId]?.accuracy);
        return Number.isFinite(taskAccuracy) ? taskAccuracy : null;
      }
      const sessionAccuracy = Number(s?.stats?.answers_eval?.summary?.accuracy);
      return Number.isFinite(sessionAccuracy) ? sessionAccuracy : null;
    })
    .filter((v) => Number.isFinite(v));

    const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const medianDurationMs = medianFromNumbers(durations);
    const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
    const avgCorrectness = accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;

    return {
      groupId: group.id,
      groupName: group.name ?? "No name",
      avgDurationMs,
      medianDurationMs,
      avgCorrectness,
      avgAge,
      membersCount: sessions.length,
    };
  });
}

function renderCompareTable({ rows }) {
  const sorted = [...rows].sort((a, b) => String(a.groupName).localeCompare(String(b.groupName), "cs"));
  const metrics = [
    { label: "Average time", render: (row) => fmtMs(row.avgDurationMs) },
    { label: "Median time", render: (row) => fmtMs(row.medianDurationMs) },
    { label: "Average correctness", render: (row) => fmtPercent(row.avgCorrectness) },
    { label: "Average age", render: (row) => (row.avgAge === null ? "—" : row.avgAge.toFixed(1)) },
  ];

  return `
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th>Metric</th>
            ${sorted.map((row) => `<th>${escapeHtml(row.groupName)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${metrics.map((metric) => `
            <tr>
              <td><b>${escapeHtml(metric.label)}</b></td>
              ${sorted.map((row) => `<td>${escapeHtml(metric.render(row))}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderGroupCompareBoxplotTab(groups) {
  const wrap = $("#groupsCompareBoxplotWrap");
  if (!wrap) return;
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No groups selected</div><div class="muted small">Select groups for comparison on the Groups page.</div></div>`;
    return;
  }
  const statsByGroup = groups
    .map((group, index) => {
      const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
      const durations = sessions
        .map((s) => Number(s?.stats?.session?.duration_ms))
        .filter((v) => Number.isFinite(v));
      const stats = buildBoxplotStats(durations);
      if (!stats) return null;
      return {
        id: group.id,
        name: group.name ?? group.id,
        color: getGroupCompareColor(group.id, index),
        stats,
      };
    })
    .filter(Boolean);

  if (!statsByGroup.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">Not enough data to render</div><div class="muted small">The selected groups do not have completion times available.</div></div>`;
    return;
  }

  const allValues = statsByGroup.flatMap((item) => [
    item.stats.min,
    item.stats.max,
    ...item.stats.outliers,
  ]).filter((v) => Number.isFinite(v));

  const valueMin = Math.min(...allValues);
  const valueMax = Math.max(...allValues);
  const padding = Math.max((valueMax - valueMin) * 0.08, 1000);
  const domainMin = Math.max(0, valueMin - padding);
  const domainMax = valueMax + padding;
  const range = Math.max(1, domainMax - domainMin);

  const width = 560;
  const height = 330;
  const margin = { top: 32, right: 20, bottom: 56, left: 72 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const valueToY = (value) => {
    const clamped = Math.max(domainMin, Math.min(domainMax, value));
    return margin.top + ((domainMax - clamped) / range) * innerH;
  };

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => domainMin + ((domainMax - domainMin) * i) / (tickCount - 1));

  wrap.innerHTML = `
    <div class="compare-chart-legend" id="groupCompareBoxplotLegend">
      ${statsByGroup.map((item) => `
        <div class="compare-chart-legend-item">
          <span class="compare-chart-legend-line" style="background:${escapeHtml(item.color)}"></span>
          <span>${escapeHtml(item.name)}</span>
        </div>
      `).join("")}
    </div>
    <div class="boxplot-meaning-legend">
      <span><span class="boxplot-legend-mark box"></span>Box (Q1–Q3)</span>
      <span><span class="boxplot-legend-mark median"></span>Median</span>
      <span><span class="boxplot-legend-mark whisker"></span>Whiskers</span>
      <span><span class="boxplot-legend-mark average"></span>Average</span>
      <span><span class="boxplot-legend-mark outlier"></span>Outliers</span>
    </div>
    <div class="group-boxplot-grid">
      ${statsByGroup.map((item) => {
        const cx = margin.left + innerW / 2;
        const boxHalfWidth = Math.max(26, Math.min(64, innerW * 0.22));
        const boxLeft = cx - boxHalfWidth;
        const boxWidth = boxHalfWidth * 2;

        const yQ1 = valueToY(item.stats.q1);
        const yQ3 = valueToY(item.stats.q3);
        const yMedian = valueToY(item.stats.median);
        const yLow = valueToY(item.stats.whiskerLow);
        const yHigh = valueToY(item.stats.whiskerHigh);
        const yAverage = valueToY(item.stats.average);

        return `
          <article class="group-boxplot-card">
            <div class="group-boxplot-title">${escapeHtml(item.name)}</div>
            <div class="compare-chart-canvas-wrap boxplot-canvas-wrap">
              <svg viewBox="0 0 ${width} ${height}" class="compare-chart-svg boxplot-svg" role="img" aria-label="Group boxplot ${escapeHtml(item.name)}">
                <text x="${width / 2}" y="20" class="compare-chart-title">Completion times</text>
                ${ticks.map((tick) => {
                  const y = valueToY(tick);
                  return `
                    <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" class="compare-chart-grid" />
                    <text x="${margin.left - 10}" y="${y + 4}" class="compare-chart-y-label">${escapeHtml(fmtMs(tick))}</text>
                  `;
                }).join("")}
                <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="compare-chart-axis" />
                <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="compare-chart-axis" />

                <line x1="${cx}" y1="${yHigh}" x2="${cx}" y2="${yQ3}" stroke="${escapeHtml(item.color)}" stroke-width="2" />
                <line x1="${cx}" y1="${yQ1}" x2="${cx}" y2="${yLow}" stroke="${escapeHtml(item.color)}" stroke-width="2" />
                <line x1="${cx - boxHalfWidth * 0.55}" y1="${yHigh}" x2="${cx + boxHalfWidth * 0.55}" y2="${yHigh}" stroke="${escapeHtml(item.color)}" stroke-width="2.2" />
                <line x1="${cx - boxHalfWidth * 0.55}" y1="${yLow}" x2="${cx + boxHalfWidth * 0.55}" y2="${yLow}" stroke="${escapeHtml(item.color)}" stroke-width="2.2" />

                <rect x="${boxLeft}" y="${Math.min(yQ3, yQ1)}" width="${boxWidth}" height="${Math.max(2, Math.abs(yQ1 - yQ3))}" fill="${escapeHtml(item.color)}22" stroke="${escapeHtml(item.color)}" stroke-width="2.2" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="IQR (Q1–Q3)" data-value="${escapeHtml(`${fmtMs(item.stats.q1)} to ${fmtMs(item.stats.q3)}`)}" data-extra="IQR: ${escapeHtml(fmtMs(item.stats.iqr))}" data-plot-x="${cx}" data-plot-y="${(yQ1 + yQ3) / 2}" />

                <line x1="${boxLeft}" y1="${yMedian}" x2="${boxLeft + boxWidth}" y2="${yMedian}" stroke="${escapeHtml(item.color)}" stroke-width="3" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="Median" data-value="${escapeHtml(fmtMs(item.stats.median))}" data-plot-x="${cx}" data-plot-y="${yMedian}" />

                <line x1="${cx}" y1="${yHigh}" x2="${cx}" y2="${yLow}" stroke="transparent" stroke-width="18" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="Whisker range" data-value="${escapeHtml(`${fmtMs(item.stats.whiskerLow)} to ${fmtMs(item.stats.whiskerHigh)}`)}" data-extra="Lower whisker: ${escapeHtml(fmtMs(item.stats.whiskerLow))}, upper whisker ${escapeHtml(fmtMs(item.stats.whiskerHigh))}" data-plot-x="${cx}" data-plot-y="${(yLow + yHigh) / 2}" />

                <line x1="${cx - 8}" y1="${yAverage - 8}" x2="${cx + 8}" y2="${yAverage + 8}" stroke="#0f172a" stroke-width="2" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="Average" data-value="${escapeHtml(fmtMs(item.stats.average))}" data-plot-x="${cx}" data-plot-y="${yAverage}" />
                <line x1="${cx - 8}" y1="${yAverage + 8}" x2="${cx + 8}" y2="${yAverage - 8}" stroke="#0f172a" stroke-width="2" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="Average" data-value="${escapeHtml(fmtMs(item.stats.average))}" data-plot-x="${cx}" data-plot-y="${yAverage}" />

                ${item.stats.outliers.map((val, outIdx) => {
                  const outX = cx + ((outIdx % 2 === 0 ? -1 : 1) * (10 + ((outIdx % 3) * 6)));
                  const outY = valueToY(val);
                  return `<circle cx="${outX}" cy="${outY}" r="4" fill="${escapeHtml(item.color)}" stroke="#111827" stroke-width="1" class="boxplot-hover-target" data-group="${escapeHtml(item.name)}" data-metric="Outlier" data-value="${escapeHtml(fmtMs(val))}" data-plot-x="${outX}" data-plot-y="${outY}" />`;
                }).join("")}

                <text x="${width / 2}" y="${height - 22}" class="compare-chart-x-label">n = ${item.stats.count}</text>
              </svg>
              <div class="compare-chart-tooltip hidden" data-role="boxplot-tooltip"></div>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;

  $$(".boxplot-canvas-wrap").forEach((canvasWrap) => {
    const tooltip = canvasWrap.querySelector("[data-role='boxplot-tooltip']");
    const svgEl = canvasWrap.querySelector(".boxplot-svg");
    if (!tooltip || !svgEl) return;

    const positionTooltip = (target) => {
      const chartRect = canvasWrap.getBoundingClientRect();
      const svgRect = svgEl.getBoundingClientRect();
      const plotX = Number(target.dataset.plotX);
      const plotY = Number(target.dataset.plotY);
      if (!Number.isFinite(plotX) || !Number.isFinite(plotY)) return;

      const scaleX = svgRect.width / width;
      const scaleY = svgRect.height / height;
      const left = (svgRect.left - chartRect.left) + (plotX * scaleX) + 10;
      const top = (svgRect.top - chartRect.top) + (plotY * scaleY) - 16;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
    };

    canvasWrap.querySelectorAll(".boxplot-hover-target").forEach((target) => {
      target.addEventListener("mouseenter", () => {
        tooltip.classList.remove("hidden");
        tooltip.innerHTML = `
          <div><strong>${escapeHtml(target.dataset.group ?? "")}</strong></div>
          <div>${escapeHtml(target.dataset.metric ?? "")}: <strong>${escapeHtml(target.dataset.value ?? "")}</strong></div>
          ${target.dataset.extra ? `<div class="muted small">${escapeHtml(target.dataset.extra)}</div>` : ""}
        `;
        positionTooltip(target);
      });
      target.addEventListener("mousemove", () => positionTooltip(target));
      target.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
    });
  });
}

const GROUP_COMPARE_DIMENSIONS = {
  nationality: { label: "Nationality", key: "nationality" },
};

const GROUP_COMPARE_COLOR_PALETTE = [
  "#4cc9f0", "#f72585", "#4361ee", "#f77f00", "#2a9d8f",
  "#ff006e", "#06d6a0", "#ffd166", "#8338ec", "#ef476f",
  "#00bbf9", "#90be6d", "#fb5607", "#7209b7", "#3a86ff",
];

function getGroupCompareColor(groupId, index = 0) {
  if (!groupId) return GROUP_COMPARE_COLOR_PALETTE[index % GROUP_COMPARE_COLOR_PALETTE.length];
  const saved = state.groupCompareChartColors?.[groupId];
  if (saved) return saved;
  return GROUP_COMPARE_COLOR_PALETTE[index % GROUP_COMPARE_COLOR_PALETTE.length];
}

function getGroupDimensionAccuracyMap(group, dimensionKey) {
  const map = new Map();
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];

  sessions.forEach((session) => {
    const soc = session?.stats?.session?.soc_demo ?? {};
    const rawCategory = soc?.[dimensionKey];
    const accuracy = Number(session?.stats?.answers_eval?.summary?.accuracy);
    if (!Number.isFinite(accuracy)) return;

    const category = String(rawCategory ?? "Unspecified").trim() || "Unspecified";
    if (!map.has(category)) map.set(category, []);
    map.get(category).push(accuracy * 100);
  });

  return new Map(Array.from(map.entries()).map(([category, values]) => {
    const avg = values.length ? values.reduce((sum, val) => sum + val, 0) / values.length : null;
    return [category, avg];
  }));
}

function buildGroupCompareChartData(groups) {
  const dimensionCfg = GROUP_COMPARE_DIMENSIONS[state.groupCompareChartDimension] ?? GROUP_COMPARE_DIMENSIONS.nationality;
  const categorySet = new Set();
  const series = (groups ?? []).map((group, index) => {
    const pointsByCategory = getGroupDimensionAccuracyMap(group, dimensionCfg.key);
    Array.from(pointsByCategory.keys()).forEach((category) => categorySet.add(category));
    return {
      groupId: group.id,
      groupName: group.name ?? group.id,
      color: getGroupCompareColor(group.id, index),
      pointsByCategory,
    };
  });

  const categories = Array.from(categorySet);
  const sortBy = state.groupCompareChartSortMode;
  const refGroupId = state.groupCompareChartReferenceGroupId;

  const scoreForCategory = (category) => {
    if (sortBy === "reference" && refGroupId) {
      const refSeries = series.find((s) => s.groupId === refGroupId);
      const refValue = refSeries?.pointsByCategory?.get(category);
      if (Number.isFinite(refValue)) return refValue;
    }
    const vals = series
      .map((s) => s.pointsByCategory.get(category))
      .filter((v) => Number.isFinite(v));
    if (!vals.length) return -Infinity;
    return vals.reduce((sum, val) => sum + val, 0) / vals.length;
  };

  categories.sort((a, b) => {
    const scoreDiff = scoreForCategory(b) - scoreForCategory(a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.localeCompare(b, "en");
  });

  return {
    xAxisLabel: dimensionCfg.label,
    categories,
    series,
  };
}

function computeSnappedOffsets(series, categories) {
  const result = new Map();
  const tolerance = 0.2;
  const step = 1;

  categories.forEach((category) => {
    const entries = series.map((item) => {
      const value = item.pointsByCategory.get(category);
      return { groupId: item.groupId, value };
    }).filter((entry) => Number.isFinite(entry.value));

    entries.sort((a, b) => a.value - b.value);
    const clusters = [];
    entries.forEach((entry) => {
      const lastCluster = clusters[clusters.length - 1];
      if (!lastCluster || Math.abs(lastCluster.base - entry.value) > tolerance) {
        clusters.push({ base: entry.value, entries: [entry] });
      } else {
        lastCluster.entries.push(entry);
      }
    });

    clusters.forEach((cluster) => {
      const size = cluster.entries.length;
      cluster.entries.forEach((entry, idx) => {
        const relative = idx - (size - 1) / 2;
        const offset = size > 1 ? relative * step : 0;
        result.set(`${entry.groupId}::${category}`, offset);
      });
    });
  });

  return result;
}

function renderGroupCompareChartTab(groups) {
  const wrap = $("#groupsCompareChartWrap");
  if (!wrap) return;

  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No groups selected</div><div class="muted small">Select groups for comparison on the Groups page.</div></div>`;
    return;
  }

  if (!groups.some((g) => g.id === state.groupCompareChartReferenceGroupId)) {
    state.groupCompareChartReferenceGroupId = groups[0]?.id ?? null;
  }

  const chartData = buildGroupCompareChartData(groups);

  if (!chartData.categories.length || !chartData.series.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">Not enough data to render</div><div class="muted small">Choose different groups or a different X-axis dimension.</div></div>`;
    return;
  }

  const controlsHtml = `
    <div class="compare-chart-controls">
      <label class="filter-field" style="min-width:220px; margin:0;">
        <span>Dimenze osy X</span>
        <select id="groupCompareChartDimensionSelect">
          ${Object.entries(GROUP_COMPARE_DIMENSIONS).map(([key, cfg]) => `<option value="${escapeHtml(key)}" ${state.groupCompareChartDimension === key ? "selected" : ""}>${escapeHtml(cfg.label)}</option>`).join("")}
        </select>
      </label>
      <label class="filter-field" style="min-width:220px; margin:0;">
        <span>X-axis ordering</span>
        <select id="groupCompareChartSortModeSelect">
          <option value="overall" ${state.groupCompareChartSortMode === "overall" ? "selected" : ""}>By average of all groups</option>
          <option value="reference" ${state.groupCompareChartSortMode === "reference" ? "selected" : ""}>By reference group</option>
        </select>
      </label>
      <label class="filter-field" style="min-width:220px; margin:0; ${state.groupCompareChartSortMode === "reference" ? "" : "opacity:.55;"}">
        <span>Reference group</span>
        <select id="groupCompareChartReferenceSelect" ${state.groupCompareChartSortMode === "reference" ? "" : "disabled"}>
          ${groups.map((group) => `<option value="${escapeHtml(group.id)}" ${state.groupCompareChartReferenceGroupId === group.id ? "selected" : ""}>${escapeHtml(group.name ?? group.id)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="compare-chart-group-controls" id="groupCompareSeriesControls">
      ${chartData.series.map((item) => {
        return `
          <label class="compare-chart-series-control" data-group-id="${escapeHtml(item.groupId)}">
            <span>${escapeHtml(item.groupName)}</span>
            <input type="color" data-role="series-color" data-group-id="${escapeHtml(item.groupId)}" value="${escapeHtml(item.color)}" />
          </label>
        `;
      }).join("")}
    </div>
  `;

  const width = 700;
  const height = 300;
  const margin = { top: 28, right: 14, bottom: 70, left: 50 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const xStep = chartData.categories.length > 1 ? innerW / (chartData.categories.length - 1) : 0;

  const xForIndex = (index) => margin.left + (chartData.categories.length === 1 ? innerW / 2 : index * xStep);
  const yForValue = (value) => margin.top + ((100 - Math.max(0, Math.min(100, value))) / 100) * innerH;
  const offsets = computeSnappedOffsets(chartData.series, chartData.categories);

  const gridLines = [0, 25, 50, 75, 100].map((value) => {
    const y = yForValue(value);
    return `
      <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" class="compare-chart-grid" />
      <text x="${margin.left - 10}" y="${y + 4}" class="compare-chart-y-label">${value} %</text>
    `;
  }).join("");

  const seriesSvg = chartData.series.map((item) => {
    const pathParts = [];
    const points = [];
    chartData.categories.forEach((category, idx) => {
      const baseValue = item.pointsByCategory.get(category);
      if (!Number.isFinite(baseValue)) return;
      const offset = offsets.get(`${item.groupId}::${category}`) ?? 0;
      const yValue = baseValue + offset;
      const x = xForIndex(idx);
      const y = yForValue(yValue);
      pathParts.push(`${pathParts.length ? "L" : "M"} ${x} ${y}`);
      points.push({ x, y, baseValue, category, offset });
    });

    if (!points.length) return "";

    return `
      <g>
        <path d="${pathParts.join(" ")}" fill="none" stroke="${escapeHtml(item.color)}" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round" />
        ${points.map((p) => `
          <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${escapeHtml(item.color)}" class="compare-chart-point" data-group="${escapeHtml(item.groupName)}" data-category="${escapeHtml(p.category)}" data-value="${escapeHtml(`${p.baseValue.toFixed(1)} %`)}" data-offset="${escapeHtml(p.offset ? `${p.offset > 0 ? "+" : ""}${p.offset.toFixed(2)} pp` : "0.00 pp")}" data-plot-x="${p.x}" data-plot-y="${p.y}" />
        `).join("")}
      </g>
    `;
  }).join("");

  const xLabels = chartData.categories.map((category, idx) => {
    const x = xForIndex(idx);
    return `<text x="${x}" y="${height - 22}" class="compare-chart-x-label">${escapeHtml(category)}</text>`;
  }).join("");

  wrap.innerHTML = `
    ${controlsHtml}
    <div class="compare-chart-legend" id="groupCompareChartLegend">
      ${chartData.series.map((item) => `
        <div class="compare-chart-legend-item" title="${escapeHtml(item.groupName)}">
          <span class="compare-chart-legend-line" style="background:${escapeHtml(item.color)}"></span>
          <span>${escapeHtml(item.groupName)}</span>
        </div>
      `).join("")}
    </div>
    <div class="compare-chart-canvas-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="compare-chart-svg" role="img" aria-label="Comparison of answer accuracy between groups">
        <text x="${width / 2}" y="18" class="compare-chart-title">Answer correctness (%)</text>
        ${gridLines}
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="compare-chart-axis" />
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="compare-chart-axis" />
        ${seriesSvg}
        ${xLabels}
      </svg>
      <div class="compare-chart-tooltip hidden" id="groupCompareChartTooltip"></div>
    </div>
    <div class="muted small">Identical (or nearly identical) values are automatically grouped and given a slight visual offset so the points do not overlap.</div>
  `;

  const rerender = () => renderGroupCompareModal();
  $("#groupCompareChartDimensionSelect")?.addEventListener("change", (e) => {
    state.groupCompareChartDimension = e.target.value;
    rerender();
  });
  $("#groupCompareChartSortModeSelect")?.addEventListener("change", (e) => {
    state.groupCompareChartSortMode = e.target.value;
    rerender();
  });
  $("#groupCompareChartReferenceSelect")?.addEventListener("change", (e) => {
    state.groupCompareChartReferenceGroupId = e.target.value;
    rerender();
  });

  $$("#groupCompareSeriesControls [data-role='series-color']").forEach((input) => {
    input.addEventListener("change", () => {
      const groupId = input.dataset.groupId;
      if (!groupId) return;
      state.groupCompareChartColors = { ...state.groupCompareChartColors, [groupId]: input.value };
      rerender();
    });
  });

  const tooltip = $("#groupCompareChartTooltip");
  const chartWrap = $(".compare-chart-canvas-wrap");
  const svgEl = chartWrap?.querySelector(".compare-chart-svg");

  const positionTooltipNearPoint = (pointEl) => {
    if (!tooltip || !chartWrap || !svgEl || !pointEl) return;
    const chartRect = chartWrap.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    const px = Number(pointEl.dataset.plotX);
    const py = Number(pointEl.dataset.plotY);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;

    const scaleX = svgRect.width / width;
    const scaleY = svgRect.height / height;
    const left = (svgRect.left - chartRect.left) + (px * scaleX) + 12;
    const top = (svgRect.top - chartRect.top) + (py * scaleY) - 16;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  };

  $$(".compare-chart-point").forEach((point) => {
    point.addEventListener("mouseenter", () => {
      if (!tooltip || !chartWrap) return;
      tooltip.classList.remove("hidden");
      tooltip.innerHTML = `
        <div><strong>${escapeHtml(point.dataset.group ?? "")}</strong></div>
        <div>${escapeHtml(point.dataset.category ?? "")}: <strong>${escapeHtml(point.dataset.value ?? "")}</strong></div>
        <div class="muted small">Offset (snapping): ${escapeHtml(point.dataset.offset ?? "0.00 pp")}</div>
      `;
      positionTooltipNearPoint(point);
    });
    point.addEventListener("mousemove", () => {
      positionTooltipNearPoint(point);
    });
    point.addEventListener("mouseleave", () => {
      tooltip?.classList.add("hidden");
    });
  });
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
    panel.innerHTML = `<div class="title">Experiment completion time statistics</div><div class="muted small">Not enough data to compute statistics.</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="title">Experiment completion time statistics</div>
    <div class="metrics group-stats-grid" style="margin-top:10px;">
      ${renderGroupStatMetric("Average", fmtMs(stats.avg))}
      ${renderGroupStatMetric("Median", fmtMs(stats.median))}
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
  panel.innerHTML = `<div class="title">Task and event statistics</div>`;
  if (!tasksStats && !eventsStats) {
    panel.innerHTML += `<div class="muted small">Not enough data to compute statistics.</div>`;
    return;
  }

  if (tasksStats) {
    panel.innerHTML += `
      <div class="metrics group-stats-grid" style="margin-top:10px;">
        ${renderGroupStatMetric("Tasks – average", tasksStats.avg.toFixed(2))}
        ${renderGroupStatMetric("Tasks – median", tasksStats.median.toFixed(2))}
        ${renderGroupStatMetric("Tasks – minimum", tasksStats.min)}
        ${renderGroupStatMetric("Tasks – maximum", tasksStats.max)}
      </div>
    `;
  }

  if (eventsStats) {
    panel.innerHTML += `
      <div class="metrics group-stats-grid" style="margin-top:10px;">
        ${renderGroupStatMetric("Events – average", eventsStats.avg.toFixed(2))}
        ${renderGroupStatMetric("Events – median", eventsStats.median.toFixed(2))}
        ${renderGroupStatMetric("Events – minimum", eventsStats.min)}
        ${renderGroupStatMetric("Events – maximum", eventsStats.max)}
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
      ${renderGroupStatMetric("Average age", ageStats ? ageStats.avg.toFixed(1) : "—")}
      ${renderGroupStatMetric("Gender", distribution("gender"))}
      ${renderGroupStatMetric("Occupation", distribution("occupation"))}
      ${renderGroupStatMetric("Nationality", distribution("nationality"))}
    </div>
  `;
}

function renderMiniWordcloud(words = []) {
  if (!Array.isArray(words) || !words.length) {
    return `<div class="muted small">No answer data available yet.</div>`;
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
    panel.innerHTML = `<div class="title">Answer evaluation</div><div class="muted small">Select a group.</div>`;
    return;
  }

  panel.innerHTML = `<div class="title">Answer evaluation</div><div class="muted small">Loading…</div>`;

  try {
    const answersPayload = await apiGetGroupAnswers(group.id);
    const tasks = Object.keys(answersPayload?.tasks ?? {}).sort((a, b) => a.localeCompare(b));
    const selectedTask = tasks[0] ?? null;
    const wordcloud = await apiGetGroupWordcloud(group.id, selectedTask);

    const selector = tasks.length
      ? `<label class="filter-field" style="max-width:320px;"><span>Task</span><select id="groupWordcloudTaskSelect">${tasks.map((taskId) => `<option value="${escapeHtml(taskId)}" ${taskId===selectedTask?"selected":""}>${escapeHtml(taskId)}</option>`).join("")}</select></label>`
      : `<div class="muted small">Group has no answers linked to tasks yet.</div>`;

    const taskRecord = selectedTask ? answersPayload?.tasks?.[selectedTask] : null;
    const acc = taskRecord?.accuracy;
    const summary = taskRecord
      ? `Correct: ${taskRecord.correct_count}/${taskRecord.total_count}${Number.isFinite(acc) ? ` (${(acc*100).toFixed(1)} %)` : ""}`
      : "No answers for the selected task.";

    panel.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:end; gap:10px; flex-wrap:wrap;">
        <div>
          <div class="title">Answer evaluation + wordcloud</div>
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
    panel.innerHTML = `<div class="title">Answer evaluation</div><div class="muted small">Loading error: ${escapeHtml(e?.message ?? e)}</div>`;
  }
}

function renderGroupCompareAnswersTab(groups) {
  const wrap = $("#groupsCompareWordcloudWrap");
  if (!wrap) return;
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No groups selected</div></div>`;
    return;
  }

  const allTasks = getAllTaskIdsForGroups(groups);
  if (!state.selectedGroupCompareTaskId || !allTasks.includes(state.selectedGroupCompareTaskId)) {
    state.selectedGroupCompareTaskId = allTasks[0] ?? null;
  }

  const options = allTasks.map((taskId) => `<option value="${escapeHtml(taskId)}" ${taskId===state.selectedGroupCompareTaskId?"selected":""}>${escapeHtml(taskId)}</option>`).join("");
  wrap.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:end; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
      <div class="muted small">Answers by group for the same task.</div>
      <label class="filter-field" style="max-width:320px; margin:0;">
        <span>Task</span>
        <select id="groupsCompareWordcloudTaskSelect">${options}</select>
      </label>
    </div>
    <div class="wordcloud-grid" id="groupsCompareWordcloudGrid"><div class="muted small">Loading…</div></div>
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
        <div class="title">Average correctness</div>
        <div class="muted small" style="margin-top:6px;">Overall: <b>${escapeHtml(fmtPercent(globalAcc))}</b></div>
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
    if (grid) grid.innerHTML = `<div class="muted small">Loading error: ${escapeHtml(e?.message ?? e)}</div>`;
  });

  $("#groupsCompareWordcloudTaskSelect")?.addEventListener("change", () => {
    load().catch((e) => {
      const grid = $("#groupsCompareWordcloudGrid");
      if (grid) grid.innerHTML = `<div class="muted small">Loading error: ${escapeHtml(e?.message ?? e)}</div>`;
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
        <div class="empty-title">No groups created yet</div>
        <div class="muted small">On the Sessions page, select users and create your first group.</div>
      </div>
    `;
    usersListEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Select a group</div>
        <div class="muted small">Once you create a group, members will be displayed here.</div>
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
    groupsListEl.innerHTML = `<div class="empty"><div class="empty-title">No groups match the filter</div><div class="muted small">Try adjusting the search text.</div></div>`;
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
            <div class="title">${escapeHtml(g.name ?? "Untitled")}</div>
          </label>
          <span class="pill">${count} users</span>
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
    usersListEl.innerHTML = `<div class="empty"><div class="empty-title">Select a group</div></div>`;
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
    ? `Collapse users in group (${sessions.length})`
    : `Expand users in group (${sessions.length})`;
  usersListEl.style.display = state.isGroupUsersExpanded ? "grid" : "none";
  if (!sessions.length) {
    usersListEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Group is empty</div>
        <div class="muted small">Use the group edit button to add users.</div>
      </div>
    `;
  } else {
    usersListEl.innerHTML = sessions.map((s) => {
      const ss = s.stats?.session ?? {};
      return `
        <div class="list-item">
          <div class="row"><div class="title">${escapeHtml(s.user_id ?? "—")}</div></div>
          <div class="muted small">session: ${escapeHtml(s.session_id ?? "—")} · events: ${escapeHtml(ss.events_total ?? "—")} · duration: ${escapeHtml(fmtMs(ss.duration_ms))}</div>
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
    if (statusEl) statusEl.textContent = "Select at least one session first.";
    return;
  }

  if (statusEl) statusEl.textContent = `Selected sessions: ${validSelected.length}`;
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
    if (statusEl) statusEl.textContent = "Enter the group name.";
    return;
  }
  if (!validSelected.length) {
    if (statusEl) statusEl.textContent = "Select at least one session first.";
    return;
  }

  try {
    if (statusEl) statusEl.textContent = "Saving group…";
    await apiCreateGroup({
      name,
      test_id: state.selectedTestId ?? "TEST",
      session_ids: validSelected,
    });
    await refreshGroups();
    renderGroupsPage();
    closeCreateGroupModal();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e?.message ?? e}`;
  }
}

function getGroupEditCurrentGroupSessions() {
  const group = getSelectedGroup();
  if (!group) return [];
  const ids = new Set(group.session_ids ?? []);
  return getSessionsForSelectedTest().filter((s) => ids.has(s.session_id));
}

function getGroupEditFilteredSessions() {
  const sessions = getGroupEditCurrentGroupSessions();
  let filtered = applyGenericSessionFilters(sessions, state.groupEditFilters);
  if (state.groupEditShowOnlyFlagged) {
    const flagged = new Set(state.groupEditFlaggedSessionIds ?? []);
    filtered = filtered.filter((s) => flagged.has(s.session_id));
  }
  return filtered;
}

function renderGroupEditFilterControls(sessions) {
  const genderEl = $("#groupEditFilterGender");
  const occupationEl = $("#groupEditFilterOccupation");
  const nationalityEl = $("#groupEditFilterNationality");
  const ageMinEl = $("#groupEditFilterAgeMin");
  const ageMaxEl = $("#groupEditFilterAgeMax");
  const searchEl = $("#groupEditSearchInput");
  const onlyFlaggedEl = $("#groupEditOnlyFlagged");
  if (!genderEl || !occupationEl || !nationalityEl || !ageMinEl || !ageMaxEl || !searchEl || !onlyFlaggedEl) return;

  const options = getSessionFilterOptions(sessions);
  const makeOptions = (values, emptyLabel) => {
    const base = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    return base.concat(values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  };

  genderEl.innerHTML = makeOptions(options.gender, "All");
  occupationEl.innerHTML = makeOptions(options.occupation, "All");
  nationalityEl.innerHTML = makeOptions(options.nationality, "All");

  genderEl.value = state.groupEditFilters.gender;
  occupationEl.value = state.groupEditFilters.occupation;
  nationalityEl.value = state.groupEditFilters.nationality;
  ageMinEl.value = state.groupEditFilters.ageMin;
  ageMaxEl.value = state.groupEditFilters.ageMax;
  searchEl.value = state.groupEditFilters.query;
  onlyFlaggedEl.checked = !!state.groupEditShowOnlyFlagged;
}

const SESSION_METRIC_OPTIONS = [
  { key: "tasks", label: "Number of tasks" },
  { key: "events", label: "Number of events" },
  { key: "duration", label: "Total completion time" },
  { key: "accuracy", label: "Average answer correctness" },
  { key: "age", label: "Age" },
  { key: "gender", label: "Gender" },
  { key: "occupation", label: "Occupation" },
  { key: "nationality", label: "Nationality" },
  { key: "education", label: "Education" },
  { key: "device", label: "Device" },
  { key: "confidence", label: "Confidence" },
  { key: "paper_maps", label: "Paper maps" },
  { key: "computer_maps", label: "Computer maps" },
  { key: "mobile_maps", label: "Mobile maps" },
];

const GROUP_EDIT_METRIC_OPTIONS = SESSION_METRIC_OPTIONS;

function renderGroupEditMetricsPicker() {
  const el = $("#groupEditMetricsPicker");
  if (!el) return;
  const selected = new Set(state.groupEditMetrics ?? []);
  el.innerHTML = GROUP_EDIT_METRIC_OPTIONS.map((m) => {
    const isSelected = selected.has(m.key);
    const active = isSelected ? "is-selected" : "is-unselected";
    return `<button class="chip group-edit-metric-chip ${active}" type="button" aria-pressed="${isSelected ? "true" : "false"}" data-role="group-edit-metric" data-key="${escapeHtml(m.key)}">${escapeHtml(m.label)}</button>`;
  }).join("");

  $$("#groupEditMetricsPicker [data-role='group-edit-metric']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const set = new Set(state.groupEditMetrics ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      state.groupEditMetrics = GROUP_EDIT_METRIC_OPTIONS.map((x) => x.key).filter((k) => set.has(k));
      renderGroupEditMetricsPicker();
      renderGroupEditSessionMetrics();
    });
  });
}

function renderGroupEditSessionMetrics() {
  const el = $("#groupEditSessionMetrics");
  if (!el) return;

  const sessions = getGroupEditCurrentGroupSessions();
  const selectedId = state.groupEditSelectedSessionId;
  const selected = sessions.find((s) => s.session_id === selectedId) ?? null;
  if (!selected) {
    el.innerHTML = `<div class="empty"><div class="empty-title">Select a session on the left</div></div>`;
    return;
  }

  const st = selected.stats?.session ?? {};
  const soc = st.soc_demo ?? {};
  const answersSummary = selected.stats?.answers_eval?.summary ?? {};
  const mapping = {
    tasks: ["Number of tasks", st.tasks_count ?? (Array.isArray(selected.tasks) ? selected.tasks.length : "—")],
    events: ["Number of events", st.events_total ?? "—"],
    duration: ["Total completion time", fmtMs(st.duration_ms)],
    accuracy: ["Average answer correctness", fmtPercent(answersSummary.accuracy)],
    age: ["Age", soc.age ?? "—"],
    gender: ["Gender", soc.gender ?? "—"],
    occupation: ["Occupation", soc.occupation ?? "—"],
    nationality: ["Nationality", soc.nationality ?? "—"],
    education: ["Education", soc.education ?? "—"],
    device: ["Device", soc.device ?? "—"],
    confidence: ["Confidence", formatBooleanCharacteristic(soc.confidence)],
    paper_maps: ["Paper maps", formatBooleanCharacteristic(soc.paper_maps)],
    computer_maps: ["Computer maps", formatBooleanCharacteristic(soc.computer_maps)],
    mobile_maps: ["Mobile maps", formatBooleanCharacteristic(soc.mobile_maps)],
  };

  const rows = { UserID: selected.user_id ?? "—" };
  for (const key of (state.groupEditMetrics ?? [])) {
    const metric = mapping[key];
    if (metric) rows[metric[0]] = metric[1];
  }
  renderMetricGrid(rows, el);
}

function renderGroupEditSessionsList() {
  const listEl = $("#groupEditSessionsList");
  const summaryEl = $("#groupEditSummary");
  if (!listEl) return;

  const sessions = getGroupEditCurrentGroupSessions();
  renderGroupEditFilterControls(sessions);
  const filtered = getGroupEditFilteredSessions();
  const selectedSet = new Set(state.groupEditSessionIds ?? []);
  const flaggedSet = new Set(state.groupEditFlaggedSessionIds ?? []);

  if (summaryEl) {
    const selectedCount = sessions.filter((x) => selectedSet.has(x.session_id)).length;
    const flaggedCount = sessions.filter((x) => flaggedSet.has(x.session_id)).length;
    summaryEl.textContent = `Showing ${filtered.length} of ${sessions.length} · Selected ${selectedCount} · Flagged ! ${flaggedCount}`;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty"><div class="empty-title">No sessions match the filter</div></div>`;
    renderGroupEditSessionMetrics();
    return;
  }

  listEl.innerHTML = filtered.map((s) => {
    const checked = selectedSet.has(s.session_id) ? "checked" : "";
    const flagged = flaggedSet.has(s.session_id) ? "is-flagged" : "";
    const active = state.groupEditSelectedSessionId === s.session_id ? "is-selected" : "";
    return `
      <div class="list-item ${active}" data-role="group-edit-item" data-session="${escapeHtml(s.session_id)}" style="cursor:default;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:8px;">
          <label class="row" style="justify-content:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" data-role="group-edit-session" data-session="${escapeHtml(s.session_id)}" ${checked} />
            <div>
              <div class="title">${escapeHtml(s.user_id ?? "—")}</div>
              <div class="muted small">session: ${escapeHtml(s.session_id)}</div>
            </div>
          </label>
          <button class="btn btn-ghost group-edit-flag ${flagged}" aria-pressed="${flaggedSet.has(s.session_id) ? "true" : "false"}" data-role="group-edit-flag" data-session="${escapeHtml(s.session_id)}" type="button" title="Flag">!</button>
        </div>
      </div>
    `;
  }).join("");

    $$("#groupEditSessionsList [data-role='group-edit-item']").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target?.closest?.("input,button")) return;
      state.groupEditSelectedSessionId = item.dataset.session ?? null;
      renderGroupEditSessionsList();
    });
  });

  $$("#groupEditSessionsList input[data-role='group-edit-session']").forEach((input) => {
    input.addEventListener("change", () => {
      const sid = input.dataset.session;
      const set = new Set(state.groupEditSessionIds ?? []);
      if (input.checked) set.add(sid); else set.delete(sid);
      state.groupEditSessionIds = Array.from(set);
      renderGroupEditSessionsList();
    });
  });

  $$("#groupEditSessionsList button[data-role='group-edit-flag']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sid = btn.dataset.session;
      const set = new Set(state.groupEditFlaggedSessionIds ?? []);
      if (set.has(sid)) set.delete(sid); else set.add(sid);
      state.groupEditFlaggedSessionIds = Array.from(set);
      renderGroupEditSessionsList();
    });
  });

  renderGroupEditSessionMetrics();
}

function wireGroupEditFilters() {
  const ids = ["#groupEditFilterGender", "#groupEditFilterOccupation", "#groupEditFilterNationality", "#groupEditFilterAgeMin", "#groupEditFilterAgeMax", "#groupEditSearchInput"];
  const selectAllBtn = $("#groupEditSelectAllBtn");
  const clearBtn = $("#groupEditClearFiltersBtn");

  const onlyFlagged = $("#groupEditOnlyFlagged");

  const update = () => {
    state.groupEditFilters.gender = $("#groupEditFilterGender")?.value ?? "";
    state.groupEditFilters.occupation = $("#groupEditFilterOccupation")?.value ?? "";
    state.groupEditFilters.nationality = $("#groupEditFilterNationality")?.value ?? "";
    state.groupEditFilters.ageMin = $("#groupEditFilterAgeMin")?.value ?? "";
    state.groupEditFilters.ageMax = $("#groupEditFilterAgeMax")?.value ?? "";
    state.groupEditFilters.query = $("#groupEditSearchInput")?.value ?? "";
    state.groupEditShowOnlyFlagged = !!onlyFlagged?.checked;
    renderGroupEditSessionsList();
  };

  ids.forEach((sel) => $(sel)?.addEventListener(sel.includes("Age") || sel.includes("Search") ? "input" : "change", update));
  onlyFlagged?.addEventListener("change", update);

  selectAllBtn?.addEventListener("click", () => {
    const set = new Set(state.groupEditSessionIds ?? []);
    getGroupEditFilteredSessions().forEach((s) => set.add(s.session_id));
    state.groupEditSessionIds = Array.from(set);
    renderGroupEditSessionsList();
  });

  clearBtn?.addEventListener("click", () => {
    state.groupEditFilters = { gender: "", ageMin: "", ageMax: "", occupation: "", nationality: "", query: "" };
    state.groupEditShowOnlyFlagged = false;
    renderGroupEditSessionsList();
  });
}

function openGroupEditModal() {
  const group = getSelectedGroup();
  if (!group) return;

  state.groupEditSessionIds = [];
  state.groupEditFlaggedSessionIds = [];
  state.groupEditSelectedSessionId = (group.session_ids ?? [])[0] ?? null;
  state.groupEditTab = "sessions";
  state.groupEditFilters = { gender: "", ageMin: "", ageMax: "", occupation: "", nationality: "", query: "" };
  state.groupEditShowOnlyFlagged = false;

  const nameInput = $("#groupEditNameInput");
  if (nameInput) nameInput.value = group.name ?? "";
  const noteInput = $("#groupEditNoteInput");
  if (noteInput) noteInput.value = String(group.note ?? "");
  const subtitle = $("#groupEditPageSubtitle");
  if (subtitle) subtitle.textContent = `Group: ${group.name ?? "—"} (${(group.session_ids ?? []).length} sessions)`;

  const statusEl = $("#groupEditStatus");
  if (statusEl) statusEl.textContent = "";
  renderGroupEditPanels();
  renderGroupEditMetricsPicker();
  renderGroupEditSessionsList();
  setPage("group-edit");
}

function renderGroupEditPanels() {
  $$("#groupEditTabs .tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === state.groupEditTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$("#view-group-edit [data-group-edit-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.groupEditPanel !== state.groupEditTab);
  });
}

function closeGroupEditModal() {
  setPage("groups");
}

async function exportCurrentGroupCsv() {
  const group = getSelectedGroup();
  const statusEl = $("#groupEditStatus");
  if (!group?.id) {
    if (statusEl) statusEl.textContent = "Please select a group first.";
    return;
  }

  try {
    const res = await apiFetch(apiGetGroupExportCsvUrl(group.id));
    if (!res.ok) {
      throw new Error(await parseApiError(res));
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disposition = res.headers.get("Content-Disposition") || "";
    const fallback = `group_export_${group.id}.csv`;
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = (match && match[1]) ? match[1] : fallback;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (statusEl) statusEl.textContent = `CSV export complete (${filename}).`;
  } catch (e) {
    if (statusEl) statusEl.textContent = `CSV export failed: ${e.message}`;
  }
}

function openGroupSplitModal() {
  const statusEl = $("#groupSplitStatus");
  const selected = state.groupEditSessionIds ?? [];
  if (!selected.length) {
    const mainStatus = $("#groupEditStatus");
    if (mainStatus) mainStatus.textContent = "Please select at least one session for the new group.";
    return;
  }
  if (statusEl) statusEl.textContent = `Selected sessions: ${selected.length}`;
  const input = $("#groupSplitNameInput");
  if (input) input.value = "";
  show($("#groupSplitModal"));
}

function closeGroupSplitModal() {
  hide($("#groupSplitModal"));
}

async function createGroupFromEditSelection() {
  const group = getSelectedGroup();
  const name = String($("#groupSplitNameInput")?.value ?? "").trim();
  const statusEl = $("#groupSplitStatus");
  const selected = state.groupEditSessionIds ?? [];
  if (!group || !name || !selected.length) {
    if (statusEl) statusEl.textContent = "Please fill in the name and select sessions.";
    return;
  }
  try {
    if (statusEl) statusEl.textContent = "Creating group…";
    await apiCreateGroup({ name, test_id: group.test_id, session_ids: selected });
    await refreshGroups();
    if (statusEl) statusEl.textContent = "Complete";
    closeGroupSplitModal();
    renderGroupsPage();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e?.message ?? e}`;
  }
}

async function deleteFlaggedFromGroup() {
  const group = getSelectedGroup();
  const statusEl = $("#groupEditStatus");
  if (!group) return;
  const flagged = new Set(state.groupEditFlaggedSessionIds ?? []);
  if (!flagged.size) {
    if (statusEl) statusEl.textContent = "No sessions are flagged !.";
    return;
  }
  const remaining = (group.session_ids ?? []).filter((sid) => !flagged.has(sid));
  try {
    if (statusEl) statusEl.textContent = "Removing flagged sessions from the group…";
    await apiUpdateGroup(group.id, { name: group.name, test_id: group.test_id, session_ids: remaining });
    await refreshGroups();
    state.groupEditFlaggedSessionIds = [];
    state.groupEditSelectedSessionId = remaining[0] ?? null;
    renderGroupEditSessionsList();
    if (statusEl) statusEl.textContent = "Removed from group.";
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e?.message ?? e}`;
  }
}

function getGroupsForComparison() {
  const ids = new Set(state.selectedGroupCompareIds ?? []);
  return state.groups.filter((g) => ids.has(g.id));
}

function renderGroupCompareSummaryTab(groups) {
  const wrap = $("#groupsCompareTableWrap");
  if (!wrap) return;
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No groups selected</div><div class="muted small">Select groups to compare on the Groups page.</div></div>`;
    return;
  }

  const rows = buildGroupCompareRows(groups, null);
  wrap.innerHTML = renderCompareTable({ rows });
}

function renderGroupCompareTaskTab(groups) {
  const taskListEl = $("#groupTaskList");
  const tableWrap = $("#groupTaskCompareTableWrap");
  if (!taskListEl || !tableWrap) return;

  const allTasks = getAllTaskIdsForGroups(groups);
  const q = normalizeSearchText(state.groupTaskSearchQuery);
  const filteredTasks = allTasks.filter((taskId) => normalizeSearchText(taskId).includes(q));

  if (!allTasks.length) {
    taskListEl.innerHTML = `<div class="empty"><div class="empty-title">No tasks</div><div class="muted small">The selected groups do not contain any tasks yet.</div></div>`;
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
    : `<div class="empty"><div class="empty-title">No task matches the filter</div></div>`;

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
    <div class="muted small" style="margin-bottom:8px;">Task: <b>${escapeHtml(state.selectedGroupCompareTaskId)}</b></div>
    ${renderCompareTable({ rows })}
  `;
}

function renderGroupCompareModal() {
  const modal = $("#groupsCompareModal");
  if (!modal || modal.classList.contains("hidden")) return;

  const groups = getGroupsForComparison();
  const subtitle = $("#groupsCompareSubtitle");
  if (subtitle) subtitle.textContent = `Groups selected: ${groups.length}`;

  $$("#groupsCompareTabs .tab-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === state.groupCompareTab);
    btn.setAttribute("aria-selected", btn.dataset.tab === state.groupCompareTab ? "true" : "false");
  });
  $$("#groupsCompareModal [data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.panel !== state.groupCompareTab);
  });

  renderGroupCompareSummaryTab(groups);
  renderGroupCompareChartTab(groups);
  renderGroupCompareBoxplotTab(groups);
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
    if (statusEl) statusEl.textContent = "Saving changes…";
    const current = getSelectedGroup();
    await apiUpdateGroup(group.id, {
      name: group.name,
      test_id: group.test_id,
      session_ids: current?.session_ids ?? group.session_ids ?? [],
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
    if (statusEl) statusEl.textContent = `Error: ${e?.message ?? e}`;
  }
}

async function deleteCurrentGroup() {
  const group = getSelectedGroup();
  const statusEl = $("#groupEditStatus");
  if (!group) return;
  if (!window.confirm(`Do you really want to delete the group „${group.name}“?`)) return;

  try {
    if (statusEl) statusEl.textContent = "Deleting group…";
    closeGroupEditModal();
    await apiDeleteGroup(group.id);
    await refreshGroups();
    renderGroupsPage();
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e?.message ?? e}`;
  }
}


// ===== Selection + Breadcrumbs =====
function updateBreadcrumbs() {
  const testEl = $("#crumb-test");
  const sessionEl = $("#crumb-session");

  if (testEl) testEl.textContent = getCurrentTestDisplayName() || "—";
  if (sessionEl) sessionEl.textContent = state.selectedSessionId ?? "—";

  if (testEl) testEl.classList.toggle("muted", !state.selectedTestId);
  if (sessionEl) sessionEl.classList.toggle("muted", !state.selectedSessionId);
}

function selectTest(testId) {
  const normalizedTestId = normalizeTestId(testId);
  state.selectedTestId = normalizedTestId;
  saveSelectedTestToStorage(normalizedTestId);
  updateBreadcrumbs();

if (!normalizedTestId) {
    state.selectedSessionIds = [];
    state.selectedSessionId = null;
    state.selectedSession = null;
    renderTestAggMetrics();
    renderSessionsList();
    renderSessionMetrics();
    renderTasksList();
    if (!$("#view-settings")?.classList.contains("hidden")) {
      renderSettingsPage();
    }
    if (!$("#view-groups")?.classList.contains("hidden")) {
      refreshGroups().then(() => renderGroupsPage());
    }
    return;
  }

  state.selectedSessionIds = loadGroupDraftSelectionForTest(normalizedTestId);

  const sessionsForTest = getSessionsForSelectedTest();
  if (state.selectedSessionId && !sessionsForTest.some(s => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = null;
    state.selectedSession = null;
  }

  $$("#testsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.test === normalizedTestId);
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

  if (!$("#intervalRatiosModal")?.classList.contains("hidden")) {
    renderIntervalRatiosModal();
  }
}


function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.selectedSession = state.sessions.find(s => s.session_id === sessionId) ?? null;
  state.intervalRatiosSelection.taskKey = "ALL_TASKS";
  updateBreadcrumbs();

  $$("#sessionsList .list-item").forEach(item => {
    item.classList.toggle("is-selected", item.dataset.session === sessionId);
  });

  renderSessionMetrics();
  if (!$("#intervalRatiosModal")?.classList.contains("hidden")) {
    renderIntervalRatiosModal();
  }
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

function resetClientStateForLogout() {
  state.selectedTestId = "TEST";
  state.selectedSessionId = null;
  state.selectedSession = null;
  state.selectedSessionIds = [];
  state.sessions = [];
  state.tests = [];
  state.groups = [];
  state.correctAnswers = {};
  state.groupSettings = {};
  state.testSettings = {};

  try { localStorage.removeItem(TESTS_STORAGE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(SELECTED_TEST_STORAGE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(GROUP_DRAFT_SELECTION_KEY); } catch { /* ignore */ }
}

function wireNavButtons() {
  $("#backToTestsBtn")?.addEventListener("click", () => {
    setPage("dashboard");
    selectTest(state.selectedTestId ?? state.tests[0] ?? null);
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
    selectTest(state.selectedTestId ?? state.tests[0] ?? null);
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

  $("#backFromGroupEditBtn")?.addEventListener("click", () => {
    setPage("groups");
    renderGroupsPage();
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

  $("#logoutBtn")?.addEventListener("click", async () => {
    const btn = $("#logoutBtn");
    const originalLabel = btn?.textContent;
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Logging out…";
      }
      await apiLogout();
    } catch (error) {
      window.alert(`Logout failed: ${error?.message ?? error}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel || "Logout";
      }
      return;
    }

    resetClientStateForLogout();
    redirectToLogin();
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

  $("#settingsDownloadAnswersCsvBtn")?.addEventListener("click", async () => {
    await downloadSettingsAnswersCsv("answers");
  });

  $("#settingsDownloadTemplateCsvBtn")?.addEventListener("click", async () => {
    await downloadSettingsAnswersCsv("template");
  });

  $("#settingsUploadAnswersCsvBtn")?.addEventListener("click", () => {
    $("#settingsAnswersCsvInput")?.click();
  });

  $("#settingsAnswersCsvInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadSettingsAnswersCsv(file);
    e.target.value = "";
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
  $("#groupEditCreateGroupFromSelectedBtn")?.addEventListener("click", openGroupSplitModal);
  $("#groupEditDeleteFlaggedBtn")?.addEventListener("click", deleteFlaggedFromGroup);
  $("#groupEditExportCsvBtn")?.addEventListener("click", exportCurrentGroupCsv);

  //Timeline button (on "Tasks in session" page, right column)
  $("#openTimelineBtn")?.addEventListener("click", () => {
    openTimelineModal();
  });

  $("#openIntervalRatiosBtn")?.addEventListener("click", () => {
    openIntervalRatiosModal();
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
  $("#addTestBtn")?.addEventListener("click", async () => {
    const raw = window.prompt("Enter the name of the new user experiment:");
    const testId = normalizeTestId(raw);
    if (!testId) return;

    try {
      await apiCreateTest({ test_id: testId });
    } catch (e) {
      if (String(e?.message ?? "").toLowerCase().includes("already exists")) {
      } else {
        window.alert(`Failed to create user experiment: ${e?.message ?? e}`);
        return;
      }
    }

    await loadTestsCatalogFromBackend();
    renderTestsList();

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
  $("#closeIntervalRatiosBtn")?.addEventListener("click", closeIntervalRatiosModal);
  $("#closeIntervalRatiosBtn2")?.addEventListener("click", closeIntervalRatiosModal);
  $("#intervalRatiosModalBackdrop")?.addEventListener("click", closeIntervalRatiosModal);

  $("#closeGroupCreateBtn")?.addEventListener("click", closeCreateGroupModal);
  $("#cancelGroupCreateBtn")?.addEventListener("click", closeCreateGroupModal);
  $("#groupCreateBackdrop")?.addEventListener("click", closeCreateGroupModal);
  $("#saveGroupBtn")?.addEventListener("click", saveCreatedGroup);
  $("#saveGroupEditBtn")?.addEventListener("click", saveGroupEdit);
  $("#closeGroupSplitBtn")?.addEventListener("click", closeGroupSplitModal);
  $("#cancelGroupSplitBtn")?.addEventListener("click", closeGroupSplitModal);
  $("#groupSplitBackdrop")?.addEventListener("click", closeGroupSplitModal);
  $("#confirmGroupSplitBtn")?.addEventListener("click", createGroupFromEditSelection);
  
  $("#closeTimelineBtn2")?.addEventListener("click", closeTimelineModal);
  $("#timelineModalBackdrop")?.addEventListener("click", closeTimelineModal);

  $("#closeSessionMapBtn")?.addEventListener("click", closeSessionMapModal);
  $("#closeSessionMapBtn2")?.addEventListener("click", closeSessionMapModal);
  $("#sessionMapModalBackdrop")?.addEventListener("click", closeSessionMapModal);
  $("#exportSessionTrajectoryBtn")?.addEventListener("click", () => exportCurrentSessionMapGeoJson("trajectory"));
  $("#exportSessionTrajectoryPointsBtn")?.addEventListener("click", () => exportCurrentSessionMapGeoJson("trajectoryPoints"));
  $("#exportSessionViewportsBtn")?.addEventListener("click", () => exportCurrentSessionMapGeoJson("viewports"));

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

      const modalRatios = $("#intervalRatiosModal");
      if (modalRatios && !modalRatios.classList.contains("hidden")) closeIntervalRatiosModal();

      const modal3 = $("#uploadTestModal");
      if (modal3 && !modal3.classList.contains("hidden")) closeUploadTestModal();
      
      const modalMap = $("#sessionMapModal");
      if (modalMap && !modalMap.classList.contains("hidden")) closeSessionMapModal();

      const modal4 = $("#groupCreateModal");
      if (modal4 && !modal4.classList.contains("hidden")) closeCreateGroupModal();

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

async function pollUploadJob(jobId, {
  statusEl,
  processingMessage = "Processing CSV... this might take a while for large files.",
  onCompleted,
}) {
  if (!jobId) throw new Error("Missing upload job ID.");

  while (true) {
    const job = await apiGetUploadJob(jobId);

    if (job.status === "uploaded" || job.status === "processing") {
      if (statusEl) statusEl.textContent = job.status === "uploaded"
        ? (job.message ?? "Upload successful.")
        : (job.message ?? processingMessage);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }

    if (job.status === "failed") {
      throw new Error(job.error ?? job.message ?? "CSV processing failed.");
    }

    if (job.status === "completed") {
      if (statusEl) statusEl.textContent = job.message ?? "CSV processing finished.";
      await onCompleted(job.result ?? {});
      return job.result ?? {};
    }

    throw new Error(`Unknown upload job status: ${job.status}`);
  }
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
    if (statusEl) statusEl.textContent = `Uploading: ${file.name}…`;

    try {
      const upload = await apiUpload(file, testId ?? "TEST");
      if (statusEl) statusEl.textContent = upload.message ?? "Upload successful.";

      await pollUploadJob(upload.job_id, {
        statusEl,
        onCompleted: async (result) => {
          await refreshSessions();
          renderTestAggMetrics();

          if (!state.selectedSessionId && result.session_id) {
            state.selectedSessionId = result.session_id;
          }
          if (result.session_id) {
            state.selectedSession = state.sessions.find(s => s.session_id === result.session_id) ?? null;
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

          if (statusEl) {
            statusEl.textContent = `Done: ${result.session_id ?? file.name} (user: ${result.user_id ?? "—"})`;
          }
        },
      });

    } catch (ex) {
      if (statusEl) statusEl.textContent = `Error: ${ex?.message ?? ex}`;
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
    if (statusEl) statusEl.textContent = `Uploading bulk CSV: ${file.name}…`;

    try {
      const upload = await apiUploadBulk(file, testId ?? "TEST");
      if (statusEl) statusEl.textContent = upload.message ?? "Upload successful.";

      await pollUploadJob(upload.job_id, {
        statusEl,
        onCompleted: async (result) => {
          await refreshSessions();
          renderTestAggMetrics();

          const firstSessionId = result.first_session_id ?? result.sessions?.[0]?.session_id ?? null;
          if (!state.selectedSessionId && firstSessionId) {
            state.selectedSessionId = firstSessionId;
          }
          if (firstSessionId) {
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

          if (statusEl) {
            statusEl.textContent = `Done: bulk CSV processed (${result.count ?? 0} sessions).`;
          }
        },
      });
    } catch (ex) {
      if (statusEl) statusEl.textContent = `Error: ${ex?.message ?? ex}`;
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

  try {
    await refreshSessions();
    await loadTestsCatalogFromBackend();
  } catch (e) {
    const statusEl = $("#uploadStatus");
    if (statusEl) statusEl.textContent = `Backend unavailable: ${e?.message ?? e}`;
  }

  renderTestsList();

  selectTest(state.selectedTestId ?? state.tests[0] ?? null);
  setPage("dashboard");
  updateBreadcrumbs();
  renderTestAggMetrics();

  (async () => {
    try {
      const selectedTestId = normalizeTestId(state.selectedTestId);
      if (!selectedTestId) return;
      const out = await apiGetTestAnswers(selectedTestId);
      state.correctAnswers[selectedTestId] = out.answers ?? {};
    } catch { /* ignore */ }
  })();
  
}

init();