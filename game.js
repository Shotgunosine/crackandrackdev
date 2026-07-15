"use strict";

/* ============================================================
   Crack & Rack — trad gear sizing trainer
   ============================================================ */

// ISO/IEC 7810 ID-1 card, shown in PORTRAIT (short side across, long side tall).
const CARD_SHORT_MM = 53.98;         // horizontal dimension in portrait
const CARD_LONG_MM = 85.6;           // vertical dimension in portrait
const DEFAULT_PX_PER_MM = 96 / 25.4; // ~3.78, a 96-dpi guess used only if uncalibrated
const LS_KEY = "cc_pxPerMm";
const LS_RACK = "cc_rackIndex";
const LS_SEEN_INTRO = "cc_seenIntro"; // "1" once the visitor has seen the intro view
const LS_PINNED = "cc_pinnedCams";    // JSON array of cams retained on the Study page

// All cam sets, loaded once from data/cams.json (the single source of truth).
let CAM_SETS = [];

// The active rack's derived data. Rebuilt by loadRack() whenever the set changes.
let CAMS = [];              // cams of the current set, augmented with center/label
let RACK_MIN = 0, RACK_MAX = 0;
let BYCAM = { easy: [], hard: [] };
let ACHIEVABLE = { easy: [], hard: [] };

const state = {
  pxPerMm: null,        // null => uncalibrated
  calMethod: "card",
  view: "calibrate",
  difficulty: "easy",
  rackIndex: 0,         // index into CAM_SETS (the active Play rack)
  studyIndex: 0,        // index into CAM_SETS (the set shown on the Study page)
  pinned: [],           // cams retained for comparison: {setName,size,color,colorHex,min,max,label}
  score: 0,
  streak: 0,
  target: null,         // { width, fitting:[cam], best:cam, angle }
  answered: false,
  lastBestIdx: -1,      // index (into CAMS) of the previous round's best cam
  simRun: 0,            // how many consecutive rounds have been "similar" size
  counts: [],           // times each cam (by index) has been the answer this session
};

// Anti-repetition: allow a short run of similar sizes, then force a jump.
const SIMILAR_SPREAD = 1;    // cams within this many indices count as "similar"
const MAX_SIMILAR_RUN = 3;   // most consecutive similar rounds before we force variety
const HARD_ANGLE_MAX = 35;   // hard-mode cracks tilt up to ±this many degrees
const DISPLAY_MARGIN = 0.82; // fraction of the wall a crack may span (leaves rock on both edges)

// Streak "heats up" like a blackbody: dark → dull red → orange → yellow → white-hot,
// indexed by streak (clamped to 10). At 10 a flame appears. [bg, dark-text?]
const STREAK_HEAT = [
  ["rgba(0,0,0,0.45)", false], // 0  (neutral, matches other HUD pills)
  ["#4a0f0f", false],          // 1  ember
  ["#701600", false],          // 2
  ["#93200a", false],          // 3  dull red
  ["#bd3500", false],          // 4
  ["#dd5600", false],          // 5  orange
  ["#f2760f", true],           // 6
  ["#ff961f", true],           // 7  bright orange
  ["#ffb84d", true],           // 8  amber-yellow
  ["#ffd982", true],           // 9  yellow-white
  ["#fff1c4", true],           // 10 white-hot 🔥
];

/* ---------- tiny DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------- cam fit logic ---------- */
function fittingCams(width) {
  return CAMS.filter((c) => width >= c.min && width <= c.max);
}
// "best fit": crack nearest the middle of the cam's range (normalised).
function bestCam(width) {
  const fits = fittingCams(width);
  const pool = fits.length ? fits : CAMS;
  let best = pool[0];
  let bestScore = Infinity;
  for (const c of pool) {
    const half = (c.max - c.min) / 2;
    const d = Math.abs(width - c.center) / half; // 0 = dead centre
    if (d < bestScore) { bestScore = d; best = c; }
  }
  return best;
}

/* ---------- precompute per-difficulty width pools ---------- */
// Sample the rack at 0.1 mm, group each width under the cam that is its answer.
//  - hard: every width across the whole rack (edges included → tougher, plus tilt).
//  - easy: only widths near the MIDDLE of the answer cam's range (the clear cases).
//    Note this puts small-cam centres (0.3 blue, 0.4 silver) inside overlap zones,
//    which is expected — the middle of their range simply is shared with a neighbour.
const EASY_MARGIN = 0.3; // easy widths lie within the central (1 - 2*margin) of a range
function buildPools() {
  const easy = CAMS.map(() => []);
  const hard = CAMS.map(() => []);
  for (let w = RACK_MIN; w <= RACK_MAX; w = round1(w + 0.1)) {
    const idx = CAMS.indexOf(bestCam(w));
    hard[idx].push(w);
    const c = CAMS[idx];
    const R = c.max - c.min;
    if (w >= c.min + EASY_MARGIN * R && w <= c.max - EASY_MARGIN * R) easy[idx].push(w);
  }
  return { easy, hard };
}

// Switch the active cam set: augment its cams, recompute rack range + pools, and
// reset the per-session selection bookkeeping. Persists the choice.
function loadRack(index) {
  index = Math.max(0, Math.min(index, CAM_SETS.length - 1));
  state.rackIndex = index;
  CAMS = CAM_SETS[index].cams.map((c) => ({
    ...c, center: (c.min + c.max) / 2, label: "#" + c.size,
  }));
  RACK_MIN = Math.min(...CAMS.map((c) => c.min));
  RACK_MAX = Math.max(...CAMS.map((c) => c.max));
  BYCAM = buildPools();
  ACHIEVABLE = {
    easy: BYCAM.easy.map((l, i) => (l.length ? i : -1)).filter((i) => i >= 0),
    hard: BYCAM.hard.map((l, i) => (l.length ? i : -1)).filter((i) => i >= 0),
  };
  state.counts = CAMS.map(() => 0);
  state.lastBestIdx = -1;
  state.simRun = 0;
  localStorage.setItem(LS_RACK, String(index));
}

/* ============================================================
   Calibration
   ============================================================ */
function loadCalibration() {
  const saved = parseFloat(localStorage.getItem(LS_KEY));
  if (saved && saved > 0) state.pxPerMm = saved;
}
function saveCalibration(pxPerMm) {
  state.pxPerMm = pxPerMm;
  localStorage.setItem(LS_KEY, String(pxPerMm));
  refreshCalStatus();
}
function effectivePxPerMm() {
  return state.pxPerMm || DEFAULT_PX_PER_MM;
}
function refreshCalStatus() {
  $("calBanner").hidden = !!state.pxPerMm;
}

// live px/mm computed from whichever calibration control is active
let pendingPxPerMm = null;
function updateCardPreview() {
  const widthPx = parseInt($("cardSlider").value, 10); // portrait: short side across
  const card = $("creditCard");
  card.style.width = widthPx + "px";
  card.style.height = Math.round(widthPx * (CARD_LONG_MM / CARD_SHORT_MM)) + "px";
  pendingPxPerMm = widthPx / CARD_SHORT_MM;
  showPending();
}
function updateRulerPreview() {
  const widthPx = parseInt($("rulerSlider").value, 10);
  const lenMm = Math.max(1, parseFloat($("rulerLen").value) || 100);
  $("rulerLine").style.width = widthPx + "px";
  pendingPxPerMm = widthPx / lenMm;
  showPending();
}
function showPending() {
  $("pxPerMmOut").textContent = round1(pendingPxPerMm);
  $("dpiOut").textContent = "(≈ " + Math.round(pendingPxPerMm * 25.4) + " dpi)";
}

// Cap the card slider so the true-size card can never grow wider than the viewport
// (a real 54 mm card always fits, so this only prevents it running off-screen and
// appearing to grow only vertically). Returns the clamped value.
function clampCardSlider() {
  const s = $("cardSlider");
  const max = Math.max(120, Math.min(600, Math.floor(window.innerWidth - 8)));
  s.max = String(max);
  if (parseInt(s.value, 10) > max) s.value = String(max);
}
// Nudge the card slider by delta px (used by the ‹ Smaller / Bigger › buttons).
function stepCard(delta) {
  const s = $("cardSlider");
  const min = parseInt(s.min, 10), max = parseInt(s.max, 10);
  s.value = String(Math.max(min, Math.min(max, parseInt(s.value, 10) + delta)));
  updateCardPreview();
}
// Press-and-hold repeat: one step on tap, then accelerates while held.
function holdRepeat(btn, delta) {
  let toStart = null, iv = null;
  const stop = () => { clearTimeout(toStart); clearInterval(iv); toStart = iv = null; };
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stepCard(delta);
    toStart = setTimeout(() => { iv = setInterval(() => stepCard(delta), 60); }, 350);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
    btn.addEventListener(ev, stop));
}

function initCalibration() {
  // method switcher
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.calMethod = b.dataset.method;
      const card = state.calMethod === "card";
      $("method-card").hidden = !card;
      $("method-ruler").hidden = card;
      card ? updateCardPreview() : updateRulerPreview();
    });
  });
  $("cardSlider").addEventListener("input", updateCardPreview);
  $("rulerSlider").addEventListener("input", updateRulerPreview);
  $("rulerLen").addEventListener("input", updateRulerPreview);
  holdRepeat($("cardSmaller"), -2);
  holdRepeat($("cardBigger"), 2);

  $("saveCal").addEventListener("click", () => {
    if (pendingPxPerMm > 0) {
      saveCalibration(pendingPxPerMm);
      setView("play"); // jump straight into the game after saving
    }
  });
  $("resetCal").addEventListener("click", () => {
    localStorage.removeItem(LS_KEY);
    state.pxPerMm = null;
    refreshCalStatus();
  });

  clampCardSlider();
  updateCardPreview();
}

/* ============================================================
   View switching
   ============================================================ */
function setView(name) {
  if (state.view === "adventure" && name !== "adventure") stopStamina();
  state.view = name;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === name));
  ["intro", "play", "adventure", "rack", "study", "calibrate"].forEach((v) =>
    ($("view-" + v).hidden = v !== name));
  if (name === "rack") renderRackMenu();
  if (name === "study") renderStudy();
  if (name === "play" && !state.target) newRound();
  if (name === "adventure") enterAdventure();
}
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setView(t.dataset.view)));
  document.querySelectorAll("[data-goto]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); setView(a.dataset.goto); }));
}

/* ============================================================
   Rounds
   ============================================================ */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Largest crack (mm) whose full width fits the wall with rock visible on both edges.
// Returns Infinity if the wall isn't laid out yet (e.g. play view hidden).
function maxDisplayableMm() {
  const wallPx = $("crack").parentElement.clientWidth;
  if (!wallPx) return Infinity;
  return (wallPx * DISPLAY_MARGIN) / effectivePxPerMm();
}
// A cam is "in play" on this screen if any of its answer-widths fits the wall.
function camDisplayable(camIdx, maxMm) {
  return BYCAM[state.difficulty][camIdx].some((w) => w <= maxMm);
}

// Weighted-random cam index, biased toward the least-shown sizes (1/(count+1)).
// This self-balances over a session while still allowing occasional repeats.
function weightedCam(achievable) {
  let total = 0;
  const w = achievable.map((i) => { const x = 1 / (state.counts[i] + 1); total += x; return x; });
  let r = Math.random() * total;
  for (let k = 0; k < achievable.length; k++) { r -= w[k]; if (r <= 0) return achievable[k]; }
  return achievable[achievable.length - 1];
}

// Size-balanced selection: choose the cam first, then a width within its band.
// The run rule still caps consecutive similar sizes at MAX_SIMILAR_RUN; the first
// draw is kept as a guaranteed fallback so the loop always terminates.
function chooseTarget(diff) {
  // Restrict to widths that actually fit the wall; fall back to the unrestricted
  // pool only if the screen is too small to show even the narrowest crack.
  const maxMm = maxDisplayableMm();
  let pools = BYCAM[diff].map((list) => list.filter((w) => w <= maxMm));
  let achievable = pools.map((l, i) => (l.length ? i : -1)).filter((i) => i >= 0);
  if (!achievable.length) { pools = BYCAM[diff]; achievable = ACHIEVABLE[diff]; }
  let camIdx = null, run = 1, fbIdx = null, fbRun = 1;
  for (let tries = 0; tries < 60; tries++) {
    const i = weightedCam(achievable);
    const similar = state.lastBestIdx >= 0 &&
      Math.abs(i - state.lastBestIdx) <= SIMILAR_SPREAD;
    const r = similar ? state.simRun + 1 : 1;
    if (fbIdx === null) { fbIdx = i; fbRun = r; }
    if (r <= MAX_SIMILAR_RUN) { camIdx = i; run = r; break; }
  }
  if (camIdx === null) { camIdx = fbIdx; run = fbRun; }
  state.lastBestIdx = camIdx;
  state.simRun = run;
  state.counts[camIdx] += 1;
  const width = pick(pools[camIdx]);
  const angle = diff === "hard" ? (Math.random() * 2 - 1) * HARD_ANGLE_MAX : 0;
  return { width, best: CAMS[camIdx], angle };
}

function newRound() {
  state.answered = false;
  state.difficulty = $("difficulty").value;
  const { width, best, angle } = chooseTarget(state.difficulty);
  state.target = {
    width,
    fitting: fittingCams(width),
    best,
    angle,
  };
  renderCrack();
  renderGear();
  $("feedback").hidden = true;
  $("verdict").hidden = true;
  $("wallNext").hidden = true;
  hideGearNote();
}

function answer(cam) {
  if (state.answered) return;
  state.answered = true;
  const { width, fitting, best } = state.target;
  const fits = fitting.includes(cam);
  const isBest = cam === best;

  // Any cam that actually fits the crack earns full points and keeps the streak;
  // the "best" fit just gets a slightly different message.
  let pts = 0, tag = "wrong", label = "Not a fit";
  if (fits) {
    pts = 10; tag = "full"; state.streak += 1;
    label = isBest ? "Best fit! +10" : "It fits! +10";
  } else {
    pts = 0; tag = "wrong"; label = "Won't hold — wrong size"; state.streak = 0;
  }

  state.score += pts;
  $("score").textContent = state.score;
  updateStreak();

  renderGear(cam);       // lock buttons + colour them
  showVerdict(tag);      // ✓ / ✗ over the crack + in-wall next arrow
  showFeedback(cam, tag, label);
}

// Paint the streak badge along the blackbody ramp; add a flame at 10.
function updateStreak() {
  const s = state.streak;
  const [bg, darkText] = STREAK_HEAT[Math.min(s, STREAK_HEAT.length - 1)];
  const badge = $("streakBadge");
  $("streak").textContent = s;
  badge.style.background = bg;
  badge.style.color = darkText ? "#1a1a1a" : "rgba(255,255,255,0.9)";
  // Glow ramps up with heat; flame + pulse at the top of the scale.
  badge.style.boxShadow = s >= 4
    ? `0 0 ${s * 1.6}px ${Math.floor(s / 4)}px rgba(255, ${90 + s * 14}, 0, 0.65)`
    : "none";
  $("streakFlame").textContent = s >= 10 ? " 🔥" : "";
  badge.classList.toggle("streak-max", s >= 10);
}

// Big check / cross over the crack, plus the yellow next arrow, so a phone user
// gets the result and can advance without scrolling past the cam chart.
function showVerdict(tag) {
  const v = $("verdict");
  v.textContent = tag === "wrong" ? "✗" : "✓";
  v.className = "verdict " + tag;
  v.hidden = false;
  $("wallNext").hidden = false;
}

/* ============================================================
   Rendering — crack
   ============================================================ */
function renderCrack() {
  const px = state.target.width * effectivePxPerMm();
  const crack = $("crack");
  crack.style.width = Math.max(2, px) + "px";
  // Rotating a rectangle preserves its short dimension, so the true perpendicular
  // gap (px) is unchanged by the tilt — only the orientation differs.
  crack.style.transform =
    `translate(-50%, -50%) rotate(${state.target.angle}deg)`;
}

/* ---------- gear buttons ---------- */
function renderGear(chosen) {
  const grid = $("gearGrid");
  grid.innerHTML = "";
  const { fitting, best } = state.target;
  const maxMm = maxDisplayableMm();
  CAMS.forEach((cam, i) => {
    const btn = el("button", "gear-btn");
    // Grey out cams too large to display on this screen — they're never an answer.
    const unavailable = !camDisplayable(i, maxMm);
    btn.title = cam.color;
    btn.innerHTML =
      `<span class="swatch" style="background:${cam.colorHex}"></span>` +
      `<span class="gsize">#${cam.size}</span>`;
    if (unavailable) {
      // Not truly disabled (disabled buttons swallow hover/click), so we can
      // explain why on hover or tap instead of just ignoring the press.
      btn.classList.add("unavailable");
      btn.setAttribute("aria-disabled", "true");
      const msg = `#${cam.size} (${cam.color}) won't fit on this screen at true size — ` +
        `rotate to landscape or use a wider window to include it.`;
      btn.addEventListener("mouseenter", () => showGearNote(msg));
      btn.addEventListener("mouseleave", hideGearNote);
      btn.addEventListener("click", () => showGearNote(msg, true));
    } else if (state.answered) {
      btn.disabled = true;
      if (cam === best) btn.classList.add("correct");
      else if (fitting.includes(cam)) btn.classList.add("fits");
      if (cam === chosen && cam !== best && !fitting.includes(cam))
        btn.classList.add("chosen-bad");
    } else {
      btn.addEventListener("click", () => answer(cam));
    }
    grid.appendChild(btn);
  });
}

// Explanation shown when an unavailable (too-large) cam is hovered or tapped.
let gearNoteTimer = null;
function showGearNote(msg, autoHide) {
  clearTimeout(gearNoteTimer);
  const note = $("gearNote");
  note.textContent = "ℹ " + msg;
  note.hidden = false;
  // On tap (no hover-out on touch) auto-dismiss after a few seconds.
  if (autoHide) gearNoteTimer = setTimeout(hideGearNote, 4000);
}
function hideGearNote() {
  clearTimeout(gearNoteTimer);
  $("gearNote").hidden = true;
}

/* ---------- feedback + range chart ---------- */
function showFeedback(chosen, tag, label) {
  const { width, best } = state.target;
  $("feedbackText").innerHTML =
    `<span class="tag ${tag}">${label}.</span> ` +
    `The crack is <strong>${round1(width)} mm</strong>. ` +
    `Best fit is <strong>#${best.size} ${best.color}</strong> ` +
    `(range ${best.min}–${best.max} mm).`;
  renderRangeChart($("rangeChart"), width, best);
  $("feedback").hidden = false;
}

// Low-level bar renderer. `rows` = [{ label, colorHex, min, max, isBest?, pinned? }];
// bars are positioned as a % of the shared [min, max] span so different sets can
// be compared on one axis. `opts.marker` (mm) draws the crack-width line.
function drawRangeBars(container, rows, min, max, opts = {}) {
  container.innerHTML = "";
  const span = (max - min) || 1;
  const pct = (mm) => ((mm - min) / span) * 100;
  for (const r of rows) {
    const row = el("div", "rc-row" +
      (r.isBest ? " is-best" : "") + (r.pinned ? " is-pinned" : ""));
    row.appendChild(el("div", "rc-label",
      `<span class="swatch" style="background:${r.colorHex}"></span>${r.label}`));
    const track = el("div", "rc-track");
    const bar = el("div", "rc-bar");
    bar.style.left = pct(r.min) + "%";
    bar.style.width = (pct(r.max) - pct(r.min)) + "%";
    bar.style.background = r.colorHex;
    track.appendChild(bar);
    if (opts.marker != null && opts.marker >= r.min - span && opts.marker <= r.max + span) {
      const m = el("div", "rc-marker");
      m.style.left = pct(opts.marker) + "%";
      track.appendChild(m);
    }
    row.appendChild(track);
    container.appendChild(row);
  }
}

// In-game / active-rack range chart (scaled to the current rack's own span).
function renderRangeChart(container, marker, best) {
  const rows = CAMS.map((cam) => ({
    label: "#" + cam.size, colorHex: cam.colorHex,
    min: cam.min, max: cam.max, isBest: cam === best,
  }));
  drawRangeBars(container, rows, RACK_MIN, RACK_MAX, { marker });
}

/* ============================================================
   Rack selection
   ============================================================ */
function updateRackName() {
  $("rackName").textContent = CAM_SETS[state.rackIndex].displayname;
}
function renderRackMenu() {
  const list = $("rackList");
  list.innerHTML = "";
  CAM_SETS.forEach((set, i) => {
    const lo = Math.min(...set.cams.map((c) => c.min));
    const hi = Math.max(...set.cams.map((c) => c.max));
    const btn = el("button", "rack-item" + (i === state.rackIndex ? " active" : ""));
    btn.innerHTML =
      `<span class="rack-item-name">${set.displayname}</span>` +
      `<span class="rack-item-meta">${set.brand} · ${set.cams.length} cams · ` +
      `${round1(lo)}–${round1(hi)} mm</span>`;
    btn.addEventListener("click", () => selectRack(i));
    list.appendChild(btn);
  });
}
function selectRack(i) {
  loadRack(i);
  updateRackName();
  state.target = null;   // force a fresh round with the new set
  setView("play");
}

/* ============================================================
   Study mode + cam comparison
   ============================================================ */
function loadPinned() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_PINNED));
    state.pinned = Array.isArray(v) ? v : [];
  } catch { state.pinned = []; }
}
function savePinned() {
  localStorage.setItem(LS_PINNED, JSON.stringify(state.pinned));
}
const pinKey = (setName, size) => setName + " #" + size;
function isPinned(setName, size) {
  return state.pinned.some((p) => pinKey(p.setName, p.size) === pinKey(setName, size));
}
function togglePin(cam, setName) {
  const key = pinKey(setName, cam.size);
  const i = state.pinned.findIndex((p) => pinKey(p.setName, p.size) === key);
  if (i >= 0) state.pinned.splice(i, 1);
  else state.pinned.push({
    setName, size: cam.size, color: cam.color, colorHex: cam.colorHex,
    min: cam.min, max: cam.max, label: setName + " #" + cam.size,
  });
  savePinned();
  renderStudy();
}

function renderStudy() {
  const set = CAM_SETS[state.studyIndex];
  const setName = set.displayname;
  const studyCams = set.cams.map((c) => ({ ...c, center: (c.min + c.max) / 2 }));
  const smin = Math.min(...studyCams.map((c) => c.min));
  const smax = Math.max(...studyCams.map((c) => c.max));

  $("studyTitle").textContent = setName + " — reference";

  // set picker + "make current rack" (disabled when already the active rack)
  $("studySet").innerHTML = CAM_SETS.map((s, i) =>
    `<option value="${i}"${i === state.studyIndex ? " selected" : ""}>${s.displayname}</option>`
  ).join("");
  const isCurrentRack = state.studyIndex === state.rackIndex;
  const useBtn = $("studyUseRack");
  useBtn.disabled = isCurrentRack;
  useBtn.textContent = isCurrentRack ? "✓ Current rack" : "Make current rack";
  useBtn.classList.toggle("is-current", isCurrentRack);

  // range chart, scaled to this set's own span
  drawRangeBars($("studyChart"),
    studyCams.map((c) => ({ label: "#" + c.size, colorHex: c.colorHex, min: c.min, max: c.max })),
    smin, smax);

  // table with a per-cam pin toggle
  const table = $("camTable");
  table.innerHTML =
    "<tr><th>Size</th><th>Colour</th><th>Range (mm)</th><th>Sweet spot</th><th>Compare</th></tr>";
  for (const cam of studyCams) {
    const pinned = isPinned(setName, cam.size);
    const tr = el("tr", null,
      `<td><strong>#${cam.size}</strong></td>` +
      `<td><span class="swatch" style="background:${cam.colorHex}"></span>${cam.color}</td>` +
      `<td>${cam.min} – ${cam.max}</td>` +
      `<td>${round1(cam.center)} mm</td>` +
      `<td></td>`);
    const btn = el("button", "pin-btn" + (pinned ? " active" : ""), pinned ? "📌" : "＋");
    btn.title = pinned ? "Remove from comparison" : "Pin for comparison";
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", () => togglePin(cam, setName));
    tr.lastElementChild.appendChild(btn);
    table.appendChild(tr);
  }

  renderCompare();
}

// Editable list of pinned cams + the shared-scale comparison chart.
function renderCompare() {
  const panel = $("comparePanel");
  panel.hidden = state.pinned.length === 0;
  if (panel.hidden) { $("pinnedList").innerHTML = ""; $("compareChart").innerHTML = ""; return; }

  const list = $("pinnedList");
  list.innerHTML = "";
  state.pinned.forEach((p, i) => {
    const rowEl = el("div", "pinned-row");
    const sw = el("span", "swatch");
    sw.style.background = p.colorHex;
    rowEl.appendChild(sw);
    const input = el("input", "pinned-label");
    input.type = "text";
    input.value = p.label;
    input.addEventListener("input", () => {
      state.pinned[i].label = input.value;
      savePinned();
      refreshCompareChart();
    });
    rowEl.appendChild(input);
    rowEl.appendChild(el("span", "pinned-src", `${p.setName} · ${p.min}–${p.max} mm`));
    const rm = el("button", "pin-remove", "×");
    rm.title = "Remove";
    rm.setAttribute("aria-label", "Remove " + p.label);
    rm.addEventListener("click", () => { state.pinned.splice(i, 1); savePinned(); renderStudy(); });
    rowEl.appendChild(rm);
    list.appendChild(rowEl);
  });

  refreshCompareChart();
}

// Pinned cams + the current Study set, drawn on one shared mm scale.
function refreshCompareChart() {
  const setRows = CAM_SETS[state.studyIndex].cams.map((c) => ({
    label: "#" + c.size, colorHex: c.colorHex, min: c.min, max: c.max,
  }));
  const pinRows = state.pinned.map((p) => ({
    label: p.label, colorHex: p.colorHex, min: p.min, max: p.max, pinned: true,
  }));
  const rows = pinRows.concat(setRows);
  const min = Math.min(...rows.map((r) => r.min));
  const max = Math.max(...rows.map((r) => r.max));
  drawRangeBars($("compareChart"), rows, min, max);
  // Dashed separator between the retained cams and the current set's cams.
  if (pinRows.length && setRows.length) {
    $("compareChart").children[pinRows.length - 1].classList.add("pin-sep");
  }
}

/* ============================================================
   Adventure mode — ascend a 100ft climb, place gear, manage stamina
   ============================================================ */
const ADV_TOP = 100;              // climb height, feet
const ADV_START_STAMINA = 100;
const ADV_DRAIN = { Easy: 0.05, Hard: 0.1 }; // stamina/sec by stance
const ADV_WRONG_PENALTY = 5;      // for a cam that doesn't fit
const ADV_MOVE_COST = 0.1;        // stamina per foot climbed between cracks
const ADV_SCARE_K = 0.15;          // extra drain/sec = K * fallDistance when scared
const ADV_SCARE_MARGIN = 5;       // ft of clearance below which you're "scared"
const ADV_ROPE_STRETCH = 0.15;    // fall = 2*runout + STRETCH*height
const ADV_WHIP_MIN = 10;          // clean fall beyond this = "Nice whip"

let adv = null;                   // { climb, ci, height, stamina, placed:[], used:Set, over, sent, fall }

function advHeight() {
  return adv.ci < adv.climb.cracks.length ? adv.climb.cracks[adv.ci].h : ADV_TOP;
}

/* ---------- climb generation (safe by construction) ---------- */
function pickStance() {
  return Math.random() < 0.5 ? "Easy" : "Hard";
}
function keyWidthForCam(camIdx) {
  const pool = BYCAM.hard[camIdx];
  return pool && pool.length ? pick(pool) : round1(CAMS[camIdx].center);
}
function pickUnusedCamForKey(used) {
  const avail = CAMS.map((_, i) => i)
    .filter((i) => !used.has(i) && BYCAM.hard[i] && BYCAM.hard[i].length);
  return avail.length ? pick(avail) : null;
}
function fillerWidth() {
  if (Math.random() < 0.5) {                       // protectable-but-optional
    const c = pick(CAMS);
    return round1(c.min + Math.random() * (c.max - c.min));
  }
  return Math.random() < 0.5                        // deliberately unprotectable
    ? round1(Math.max(2, RACK_MIN * (0.5 + Math.random() * 0.35)))  // too small
    : round1(RACK_MAX * (1.05 + Math.random() * 0.3));             // too big
}
function generateClimb() {
  // 1) lay cracks at 4-8ft gaps; assign an Easy/Hard stance to each
  const cracks = [];
  let h = 4 + Math.random() * 3;
  while (h < ADV_TOP - 2) {
    cracks.push({ h: round1(h), stance: pickStance(), width: null, angle: 0, key: false });
    h += 4 + Math.random() * 4;
  }
  // 2) protected skeleton: place a distinct cam whenever an unprotected fall from
  //    this crack would land within the scare margin of the ground.
  const used = new Set();
  let lastGearH = null;
  for (const c of cracks) {
    const runout = c.h - (lastGearH ?? 0);
    const fall = 2 * runout + ADV_ROPE_STRETCH * c.h;
    const landing = c.h - fall;
    const safe = lastGearH != null && landing > ADV_SCARE_MARGIN + 1;
    if (!safe) {
      const camIdx = pickUnusedCamForKey(used);  // null => out of cams (best effort)
      if (camIdx != null) {
        c.width = keyWidthForCam(camIdx);
        c.key = true;
        used.add(camIdx);
        lastGearH = c.h;
      }
    }
  }
  // 3) filler widths for the rest (some fit unused cams, some unprotectable) + tilt
  for (const c of cracks) {
    if (c.width == null) c.width = fillerWidth();
    c.angle = (Math.random() * 2 - 1) * HARD_ANGLE_MAX;
  }
  return { cracks, top: ADV_TOP, attempts: 0 };
}

/* ---------- fall math ---------- */
function computeAdvFall() {
  const h = advHeight();
  const gearHs = adv.placed.map((p) => p.h).filter((ph) => ph <= h + 0.001);
  const lastGearH = gearHs.length ? Math.max(...gearHs) : null;
  const isProtected = lastGearH != null;
  const runout = h - (lastGearH ?? 0);
  const rawFall = 2 * runout + ADV_ROPE_STRETCH * h; // rope-limited fall if unobstructed
  const landing = h - rawFall;
  const hazardDist = h; // the ground is the only fall hazard
  // Not scared if the ground is a short (<5ft) fall away, or you're protected and
  // would be caught clear of it.
  const scared = hazardDist >= ADV_SCARE_MARGIN
    && (!isProtected || landing <= ADV_SCARE_MARGIN);
  // You can't fall past the ground.
  const fallDistance = Math.min(rawFall, hazardDist);
  const stopHeight = h - fallDistance;
  return { h, isProtected, runout, rawFall, landing, hazardDist, scared, fallDistance, stopHeight };
}
function fallOutcome(f) {
  if (f.landing <= 0) return { kind: "ground", msg: "Oof, ground fall" };
  return f.fallDistance > ADV_WHIP_MIN
    ? { kind: "whip", msg: "Nice whip! 🧗" }
    : { kind: "caught", msg: "Whew, caught." };
}

/* ---------- stamina loop (requestAnimationFrame) ---------- */
let advRAF = null, advLast = null;
function stopStamina() { if (advRAF) cancelAnimationFrame(advRAF); advRAF = null; }
function startStamina() { stopStamina(); advLast = null; advRAF = requestAnimationFrame(staminaTick); }
function staminaTick(now) {
  if (!adv || adv.over) { advRAF = null; return; }
  if (advLast == null) { advLast = now; advRAF = requestAnimationFrame(staminaTick); return; }
  const dt = Math.min(0.1, (now - advLast) / 1000);
  advLast = now;
  const stance = adv.climb.cracks[Math.min(adv.ci, adv.climb.cracks.length - 1)].stance;
  let rate = ADV_DRAIN[stance] || 0.05;
  if (adv.fall && adv.fall.scared) rate += ADV_SCARE_K * adv.fall.fallDistance;
  adv.stamina = Math.max(0, adv.stamina - rate * dt);
  setStaminaBar();
  if (adv.stamina <= 0) { triggerFall(); return; }
  advRAF = requestAnimationFrame(staminaTick);
}

/* ---------- actions ---------- */
function enterAdventure() {
  if (!adv) { newClimb(); return; }
  renderAdventure();
  if (!adv.over) startStamina();
}
function newClimb() {
  const climb = generateClimb();
  climb.attempts = 1;
  adv = { climb, ci: 0, stamina: ADV_START_STAMINA, placed: [], used: new Set(),
          over: false, sent: false, fall: null };
  hideOutcome();
  hideCamAnim(); hideFitMsg();
  renderAdventure();
  startStamina();
}
function retryClimb() {
  adv.climb.attempts += 1;
  Object.assign(adv, { ci: 0, stamina: ADV_START_STAMINA, placed: [], used: new Set(),
                       over: false, sent: false, fall: null });
  hideOutcome();
  hideCamAnim(); hideFitMsg();
  renderAdventure();
  startStamina();
}
function placeGear(camIdx) {
  if (!adv || adv.over || adv.used.has(camIdx)) return;
  const crack = adv.climb.cracks[adv.ci];
  const cam = CAMS[camIdx];
  const fits = crack.width >= cam.min && crack.width <= cam.max;
  if (!fits) {
    adv.stamina = Math.max(0, adv.stamina - ADV_WRONG_PENALTY);
    // crack wider than the cam's max = cam too small; narrower than its min = too big
    showFitMsg(crack.width > cam.max ? "Too small" : "Too big");
    setStaminaBar();
    if (adv.stamina <= 0) triggerFall();
    return;
  }
  hideFitMsg();
  adv.used.add(camIdx);
  adv.placed.push({ h: crack.h, camIdx, colorHex: cam.colorHex, size: cam.size });
  showAdvNote(`Placed #${cam.size} ${cam.color}.`, true);
  playCamAnim(cam.colorHex);
  renderAdventure();
}
function climbOn() {
  if (!adv || adv.over) return;
  hideCamAnim(); hideFitMsg();               // leaving this stance — the placed cam is now below you
  const cur = advHeight();
  const nextIdx = adv.ci + 1;
  const nextH = nextIdx < adv.climb.cracks.length ? adv.climb.cracks[nextIdx].h : ADV_TOP;
  adv.stamina = Math.max(0, adv.stamina - ADV_MOVE_COST * (nextH - cur));
  if (adv.stamina <= 0) { setStaminaBar(); triggerFall(); return; }
  if (nextIdx >= adv.climb.cracks.length) { adv.ci = nextIdx; sendClimb(); return; }
  adv.ci = nextIdx;
  renderAdventure();
}
function sendClimb() {
  adv.over = true; adv.sent = true;
  stopStamina();
  const flash = adv.climb.attempts === 1;
  renderAdventure();        // refresh HUD to topped-out (100 ft), clear scared, disable gear
  $("advCrack").hidden = true;
  hideCamAnim(); hideFitMsg();
  showOutcome(flash ? "FLASH! 🎉" : "Nice Send 👊", flash ? "send-flash" : "send");
  bumpAdvCounter("cc_advSends");
  if (flash) { bumpAdvCounter("cc_advFlashes"); confettiBurst(); }
}
function triggerFall() {
  if (!adv || adv.over) return;
  adv.over = true;
  stopStamina();
  setStaminaBar();
  hideCamAnim(); hideFitMsg();
  const out = fallOutcome(computeAdvFall());
  showOutcome(out.msg, "fall");
}

/* ---------- render ---------- */
function setStaminaBar() {
  const bar = $("advStaminaBar");
  if (!bar || !adv) return;
  bar.style.width = adv.stamina + "%";
  const hue = Math.max(0, Math.min(120, (adv.stamina / 100) * 120)); // 120 green → 0 red
  bar.style.background = `hsl(${hue}, 65%, 45%)`;
}
function renderAdventure() {
  if (!adv) return;
  adv.fall = computeAdvFall();
  const atCrack = adv.ci < adv.climb.cracks.length;
  const crack = adv.climb.cracks[Math.min(adv.ci, adv.climb.cracks.length - 1)];
  const cd = $("advCrack");
  if (atCrack && !adv.over) {
    cd.hidden = false;
    cd.style.width = Math.max(2, crack.width * effectivePxPerMm()) + "px";
    cd.style.transform = `translate(-50%, -50%) rotate(${crack.angle}deg)`;
  }
  $("advHeight").innerHTML = `${Math.round(adv.fall.h)} ft`;
  $("advStance").textContent = atCrack && !adv.over ? crack.stance : "—";
  setStaminaBar();
  renderAdvReadouts();
  renderAdvGear();
  renderRouteGauge();
  $("advControls").hidden = adv.over;
  $("advOutcome").hidden = !adv.over;
  $("advWall").classList.toggle("scared", !!adv.fall.scared && !adv.over);
}
function renderAdvReadouts() {
  const f = adv.fall;
  const chips = [
    ["Height", `${Math.round(f.h)} ft`],
    ["Above gear", f.isProtected ? `${Math.round(f.runout)} ft` : "—"],
    ["Fall", `${Math.round(f.fallDistance)} ft`],
    ["Gear left", `${CAMS.length - adv.used.size}`],
  ];
  $("advReadouts").innerHTML =
    chips.map(([k, v]) => `<span class="adv-chip"><span class="k">${k}</span><span class="v">${v}</span></span>`).join("") +
    (f.scared && !adv.over ? `<span class="adv-chip scared">⚠ Scared</span>` : "");
}
function renderAdvGear() {
  const grid = $("advGear");
  grid.innerHTML = "";
  CAMS.forEach((cam, i) => {
    const btn = el("button", "gear-btn");
    btn.title = cam.color;
    btn.innerHTML =
      `<span class="swatch" style="background:${cam.colorHex}"></span>` +
      `<span class="gsize">#${cam.size}</span>`;
    if (adv.used.has(i)) { btn.classList.add("used"); btn.disabled = true; }
    else if (adv.over) { btn.disabled = true; }
    else { btn.addEventListener("click", () => placeGear(i)); }
    grid.appendChild(btn);
  });
}
function renderRouteGauge() {
  const g = $("routeGauge");
  g.innerHTML = "";
  const f = adv.fall;
  const y = (ft) => (100 - (ft / ADV_TOP) * 100) + "%";  // 0ft at bottom (DOM overlays)

  // Crack-width profile (thick/thin along the route) + stance-colored bands, drawn
  // as a stretched SVG behind the markers. viewBox x:0-100, y:0-1000 (10 units/ft).
  const sorted = [...adv.climb.cracks].sort((a, b) => b.h - a.h); // top (high) first
  const half = (w) => Math.max(6, Math.min(44, (w / RACK_MAX) * 44)); // mm → half-width
  const vy = (ft) => ((ADV_TOP - ft) * 10).toFixed(0);
  const first = sorted[0], last = sorted[sorted.length - 1];
  let d = `M ${(50 + half(first.width)).toFixed(1)} 0`;
  sorted.forEach((c) => { d += ` L ${(50 + half(c.width)).toFixed(1)} ${vy(c.h)}`; });
  d += ` L ${(50 + half(last.width)).toFixed(1)} 1000 L ${(50 - half(last.width)).toFixed(1)} 1000`;
  [...sorted].reverse().forEach((c) => { d += ` L ${(50 - half(c.width)).toFixed(1)} ${vy(c.h)}`; });
  d += ` L ${(50 - half(first.width)).toFixed(1)} 0 Z`;
  const bands = adv.climb.cracks.map((c) => {
    const hw = half(c.width), col = c.stance === "Hard" ? "#e0a91b" : "#3f9b46";
    return `<rect x="${(50 - hw).toFixed(1)}" y="${(+vy(c.h) - 7)}" width="${(2 * hw).toFixed(1)}" height="14" fill="${col}" opacity="0.8"/>`;
  }).join("");
  g.insertAdjacentHTML("beforeend",
    `<svg class="gauge-svg" viewBox="0 0 100 1000" preserveAspectRatio="none" aria-hidden="true">` +
    `<path d="${d}" fill="#0b0d10"/>${bands}</svg>`);

  // fall zone (current → the ground)
  if (!adv.over) {
    const zone = el("div", "gauge-fall" + (f.scared ? " danger" : ""));
    zone.style.top = y(f.h);
    zone.style.height = Math.max(0, f.fallDistance / ADV_TOP * 100) + "%";
    g.appendChild(zone);
  }
  adv.placed.forEach((p) => {
    const gd = el("div", "gauge-gear"); gd.style.top = y(p.h); gd.style.background = p.colorHex; g.appendChild(gd);
  });
  const climber = el("div", "gauge-climber"); climber.style.top = y(f.h); g.appendChild(climber);
}

/* ---------- small UI helpers ---------- */
let advNoteTimer = null;
function showAdvNote(msg, autoHide) {
  clearTimeout(advNoteTimer);
  const n = $("advNote"); n.textContent = "ℹ " + msg; n.hidden = false;
  if (autoHide) advNoteTimer = setTimeout(() => { n.hidden = true; }, 3000);
}
// "Too big" / "Too small" over the crack window on a misfit placement.
let advFitTimer = null;
function showFitMsg(txt) {
  clearTimeout(advFitTimer);
  const m = $("advFitMsg"); m.textContent = txt; m.hidden = false;
  advFitTimer = setTimeout(() => { m.hidden = true; }, 1400);
}
function hideFitMsg() { clearTimeout(advFitTimer); $("advFitMsg").hidden = true; }
// A colored cam, sized to the crack, rises in with lobes retracted then settles at
// an intermediate spread. It stays placed until the climber moves on.
function playCamAnim(colorHex) {
  const a = $("camAnim");
  if (!a || adv.ci >= adv.climb.cracks.length) return;
  const crack = adv.climb.cracks[adv.ci];
  const crackPx = crack.width * effectivePxPerMm();
  // At the settled spread the lobes span ~0.415 of the sprite, so size it so those
  // lobe edges meet the crack walls (crackPx). High cap lets big cams reach the edges.
  const size = Math.max(40, Math.min(1400, crackPx / 0.415));
  a.style.width = size + "px";
  a.style.height = size + "px";
  a.style.color = colorHex;
  a.style.transform = `translate(-50%, -50%) rotate(${crack.angle || 0}deg)`;
  // The lobes sit at 25% down the sprite; shift it down so they land on the crack
  // centre (keeps the lobes on screen even when the sprite is large).
  const svg = a.querySelector("svg");
  if (svg) svg.style.transform = `translateY(${(0.25 * size).toFixed(1)}px)`;
  a.hidden = false;
  a.classList.remove("play");
  void a.offsetWidth;            // force reflow so the animation restarts each time
  a.classList.add("play");
}
function hideCamAnim() {
  const a = $("camAnim");
  if (a) { a.hidden = true; a.classList.remove("play"); }
}
function showOutcome(msg, cls) {
  $("advOutcomeMsg").textContent = msg;
  $("advOutcomeMsg").className = "adv-outcome-msg " + cls;
  $("advOutcome").hidden = false;
  $("advControls").hidden = true;
}
function hideOutcome() { $("advOutcome").hidden = true; $("advControls").hidden = false; }
function bumpAdvCounter(key) {
  localStorage.setItem(key, String((parseInt(localStorage.getItem(key), 10) || 0) + 1));
}
function confettiBurst() {
  const box = $("advConfetti");
  box.innerHTML = "";
  const colors = ["#e0a91b", "#3f9b46", "#cc3333", "#2f6fb0", "#7a4fb0", "#e8ebef"];
  for (let i = 0; i < 90; i++) {
    const p = el("span", "confetti-bit");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.4) + "s";
    p.style.setProperty("--rot", Math.floor(Math.random() * 360) + "deg");
    p.style.setProperty("--drift", (Math.random() * 40 - 20) + "px");
    box.appendChild(p);
  }
  setTimeout(() => { box.innerHTML = ""; }, 2800);
}

/* ============================================================
   Boot
   ============================================================ */
function init() {
  loadCalibration();
  loadRack(parseInt(localStorage.getItem(LS_RACK), 10) || 0);
  state.studyIndex = state.rackIndex;
  loadPinned();
  updateRackName();
  refreshCalStatus();
  updateStreak();
  initCalibration();
  initTabs();
  $("difficulty").addEventListener("change", () => {
    // Fresh coverage sweep + run state when switching difficulty.
    state.counts = CAMS.map(() => 0);
    state.lastBestIdx = -1;
    state.simRun = 0;
    newRound();
  });
  $("nextRound").addEventListener("click", newRound);
  $("wallNext").addEventListener("click", newRound);
  // Adventure controls
  $("advClimbOn").addEventListener("click", climbOn);
  $("advRetry").addEventListener("click", retryClimb);
  $("advNew").addEventListener("click", newClimb);
  // Study page: set picker, promote-to-rack, clear comparison.
  $("studySet").addEventListener("change", (e) => {
    state.studyIndex = parseInt(e.target.value, 10) || 0;
    renderStudy();
  });
  $("studyUseRack").addEventListener("click", () => {
    loadRack(state.studyIndex);
    updateRackName();
    state.target = null;   // force a fresh Play round with the new rack
    renderStudy();
  });
  $("clearPinned").addEventListener("click", () => {
    state.pinned = [];
    savePinned();
    renderStudy();
  });
  window.addEventListener("resize", handleResize);
  initHeaderCollapse();
  // First-ever visit sees the intro; afterwards go to calibration if never
  // calibrated, otherwise straight to play.
  if (localStorage.getItem(LS_SEEN_INTRO) !== "1") {
    localStorage.setItem(LS_SEEN_INTRO, "1");
    setView("intro");
  } else {
    setView(state.pxPerMm ? "play" : "calibrate");
  }
}

// Keep the crack and gear consistent with the current wall size. If a resize
// leaves the current (unanswered) crack too big to show, draw a fresh round.
let resizeTimer = null;
function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    clampCardSlider();
    if (state.view === "calibrate" && state.calMethod === "card") updateCardPreview();
    if (state.view === "adventure") { if (adv) renderAdventure(); return; }
    if (state.view !== "play" || !state.target) return;
    if (!state.answered && state.target.width > maxDisplayableMm()) { newRound(); return; }
    renderCrack();
    if (!state.answered) renderGear();
  }, 120);
}

/* ---------- collapsible header ---------- */
const LS_HEADER = "cc_headerCollapsed";
function setHeaderCollapsed(collapsed) {
  document.body.classList.toggle("header-collapsed", collapsed);
  localStorage.setItem(LS_HEADER, collapsed ? "1" : "0");
}
function initHeaderCollapse() {
  $("collapseBtn").addEventListener("click", () => setHeaderCollapsed(true));
  $("expandBtn").addEventListener("click", () => setHeaderCollapsed(false));
  setHeaderCollapsed(localStorage.getItem(LS_HEADER) === "1");
}
// Load the cam data (single source of truth) from data/cams.json, then boot.
// Must be served over http(s); opening index.html as a bare file:// will fail
// the fetch and show the message below.
async function boot() {
  try {
    const res = await fetch("data/cams.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    CAM_SETS = await res.json();
  } catch (e) {
    document.body.innerHTML =
      '<p style="color:#e8ebef;font-family:sans-serif;padding:2rem;line-height:1.5">' +
      "Couldn't load cam data (<code>data/cams.json</code>): " + e.message +
      ".<br>If you opened this page as a file, serve it over http instead " +
      "(e.g. <code>python3 -m http.server</code>).</p>";
    return;
  }
  init();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
