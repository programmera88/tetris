"use strict";

/* ---------- Константи ---------- */
const COLS = 10;
const ROWS = 20;
const CELL = 30;

const SHAPES = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O: [[1,1],[1,1]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
};

const COLORS = {
  I: "#4fb3bf",
  O: "#e0b84a",
  T: "#a37bc4",
  S: "#6bb56a",
  Z: "#d4635a",
  J: "#5a7fd1",
  L: "#e08f4a",
};

// Зсуви для повороту біля стін і підлоги (dx, dy; dy < 0 — вгору).
const KICKS = [[0,0],[-1,0],[1,0],[0,-1],[-2,0],[2,0],[-1,-1],[1,-1]];

const LINE_POINTS = [0, 100, 300, 500, 800];
const DAS = 150;          // затримка автоповтору, мс
const ARR = 40;           // інтервал автоповтору, мс
const SOFT_DROP_MS = 45;
const LOCK_DELAY = 500;
const MAX_LOCK_RESETS = 15;
const CLEAR_ANIM_MS = 260;

/* ---------- Елементи ---------- */
const $ = (id) => document.getElementById(id);
const boardCanvas = $("board");
const holdCanvas = $("hold");
const nextCanvas = $("next");
const overlay = $("overlay");
const overlayTitle = $("overlayTitle");
const overlayText = $("overlayText");
const overlayBtn = $("overlayBtn");
const pauseBtn = $("pauseBtn");

function setupCanvas(cv, w, h) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return c;
}
const bctx = setupCanvas(boardCanvas, COLS * CELL, ROWS * CELL);
const hctx = setupCanvas(holdCanvas, 96, 72);
const nctx = setupCanvas(nextCanvas, 96, 216);

/* ---------- Стан гри ---------- */
let board, cur, holdType, canHold, bag, queue;
let score, lines, level, best;
let state = "idle"; // idle | playing | paused | clearing | over
let gravTimer, lockTime, lockResets;
let clearRows = [], clearTimer = 0;
const held = { left: false, right: false, down: false };
let dasDir = 0, dasTimer = 0;

try { best = parseInt(localStorage.getItem("tetris-best") || "0", 10) || 0; } catch (e) { best = 0; }

const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null));
const clone = (m) => m.map((r) => r.slice());

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function refillQueue() {
  while (queue.length < 6) queue.push(...shuffle(Object.keys(SHAPES)));
}

function gravityMs() {
  return Math.max(60, 800 * Math.pow(0.84, level - 1));
}

/* ---------- Логіка ---------- */
function collide(m, x, y) {
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m[r].length; c++) {
      if (!m[r][c]) continue;
      const nx = x + c, ny = y + r;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
  }
  return false;
}

function rotateMatrix(m, dir) {
  const n = m.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (dir > 0) out[c][n - 1 - r] = m[r][c];
      else out[n - 1 - c][r] = m[r][c];
    }
  }
  return out;
}

function spawn(type) {
  const m = clone(SHAPES[type]);
  cur = { type, m, x: Math.floor((COLS - m.length) / 2), y: type === "I" ? -1 : 0 };
  gravTimer = 0;
  lockTime = 0;
  lockResets = 0;
  if (collide(cur.m, cur.x, cur.y)) gameOver();
}

function spawnNext() {
  refillQueue();
  spawn(queue.shift());
  canHold = true;
  refillQueue();
}

function isGrounded() {
  return collide(cur.m, cur.x, cur.y + 1);
}

function touchedWhileGrounded() {
  if (isGrounded() && lockResets < MAX_LOCK_RESETS) {
    lockTime = 0;
    lockResets++;
  }
}

function move(dx, dy) {
  if (collide(cur.m, cur.x + dx, cur.y + dy)) return false;
  cur.x += dx;
  cur.y += dy;
  return true;
}

function rotate(dir) {
  if (state !== "playing" || cur.type === "O") return;
  const nm = rotateMatrix(cur.m, dir);
  for (const [dx, dy] of KICKS) {
    if (!collide(nm, cur.x + dx, cur.y + dy)) {
      cur.m = nm;
      cur.x += dx;
      cur.y += dy;
      touchedWhileGrounded();
      return;
    }
  }
}

function shiftHorizontal(dir) {
  if (state !== "playing") return false;
  if (move(dir, 0)) {
    touchedWhileGrounded();
    return true;
  }
  return false;
}

function hardDrop() {
  if (state !== "playing") return;
  let dist = 0;
  while (move(0, 1)) dist++;
  score += dist * 2;
  lockPiece();
}

function holdPiece() {
  if (state !== "playing" || !canHold) return;
  const type = cur.type;
  if (holdType) {
    const swap = holdType;
    holdType = type;
    spawn(swap);
  } else {
    holdType = type;
    spawnNext();
  }
  canHold = false;
}

function lockPiece() {
  let toppedOut = false;
  for (let r = 0; r < cur.m.length; r++) {
    for (let c = 0; c < cur.m[r].length; c++) {
      if (!cur.m[r][c]) continue;
      const ny = cur.y + r, nx = cur.x + c;
      if (ny < 0) toppedOut = true;
      else board[ny][nx] = cur.type;
    }
  }
  if (toppedOut) { gameOver(); return; }

  const full = [];
  for (let r = 0; r < ROWS; r++) {
    if (board[r].every(Boolean)) full.push(r);
  }

  if (full.length === 0) {
    spawnNext();
    return;
  }

  score += LINE_POINTS[full.length] * level;
  lines += full.length;
  level = Math.floor(lines / 10) + 1;
  clearRows = full;
  clearTimer = 0;
  cur = null;
  state = "clearing";
  updateHud();
}

function finishClear() {
  for (const r of clearRows) {
    board.splice(r, 1);
    board.unshift(Array(COLS).fill(null));
  }
  clearRows = [];
  state = "playing";
  spawnNext();
}

function gameOver() {
  state = "over";
  cur = cur || null;
  if (score > best) {
    best = score;
    try { localStorage.setItem("tetris-best", String(best)); } catch (e) { /* ігноруємо */ }
  }
  updateHud();
  showOverlay("Гру завершено", "Рахунок: " + score + (score >= best && score > 0 ? " — новий рекорд!" : ""), "Грати знову");
}

function startGame() {
  board = emptyBoard();
  bag = [];
  queue = [];
  holdType = null;
  canHold = true;
  score = 0;
  lines = 0;
  level = 1;
  clearRows = [];
  dasDir = 0;
  dasTimer = 0;
  held.left = held.right = held.down = false;
  state = "playing";
  hideOverlay();
  spawnNext();
  updateHud();
}

function togglePause() {
  if (state === "playing") {
    state = "paused";
    held.left = held.right = held.down = false;
    dasDir = 0;
    showOverlay("Пауза", "Гра зупинена.", "Продовжити");
  } else if (state === "paused") {
    state = "playing";
    hideOverlay();
  }
}

/* ---------- Інтерфейс ---------- */
function showOverlay(title, text, btn) {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlayBtn.textContent = btn;
  overlay.hidden = false;
  overlayBtn.focus({ preventScroll: true });
}
function hideOverlay() {
  overlay.hidden = true;
  if (document.activeElement === overlayBtn) overlayBtn.blur();
}

function updateHud() {
  $("score").textContent = score.toLocaleString("uk-UA");
  $("level").textContent = level;
  $("lines").textContent = lines;
  $("best").textContent = Math.max(best, score || 0).toLocaleString("uk-UA");
}

function primaryAction() {
  if (state === "paused") togglePause();
  else if (state === "idle" || state === "over") startGame();
}

overlayBtn.addEventListener("click", primaryAction);
pauseBtn.addEventListener("click", () => { pauseBtn.blur(); togglePause(); });

/* ---------- Керування ---------- */
function setHeld(name, down) {
  if (state !== "playing" && down) return;
  held[name] = down;
  if (name === "left" || name === "right") {
    const dir = name === "left" ? -1 : 1;
    if (down) {
      dasDir = dir;
      dasTimer = 0;
      shiftHorizontal(dir);
    } else if (dasDir === dir) {
      dasDir = held.left ? -1 : held.right ? 1 : 0;
      dasTimer = 0;
    }
  }
}

const KEY_HELD = {
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  ArrowDown: "down", KeyS: "down",
};

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const code = e.code;

  if (code === "Enter") {
    if (state === "idle" || state === "over") { e.preventDefault(); startGame(); }
    else if (state === "paused") { e.preventDefault(); togglePause(); }
    return;
  }
  if (code === "KeyP" || code === "Escape") {
    if (state === "playing" || state === "paused") { e.preventDefault(); togglePause(); }
    return;
  }
  if (state !== "playing") return;

  if (KEY_HELD[code]) {
    e.preventDefault();
    if (!e.repeat) setHeld(KEY_HELD[code], true);
    return;
  }
  if (e.repeat) {
    if (code === "Space" || code === "ArrowUp") e.preventDefault();
    return;
  }
  switch (code) {
    case "ArrowUp": case "KeyX": case "KeyW": e.preventDefault(); rotate(1); break;
    case "KeyZ": e.preventDefault(); rotate(-1); break;
    case "Space": e.preventDefault(); hardDrop(); break;
    case "KeyC": case "ShiftLeft": case "ShiftRight": e.preventDefault(); holdPiece(); break;
  }
});

document.addEventListener("keyup", (e) => {
  if (KEY_HELD[e.code]) setHeld(KEY_HELD[e.code], false);
});

// Кнопка, що лишилась натиснутою, не повинна «залипати», коли вкладка втрачає фокус.
window.addEventListener("blur", () => {
  held.left = held.right = held.down = false;
  dasDir = 0;
  if (state === "playing") togglePause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === "playing") togglePause();
});

// Сенсорні кнопки
document.querySelectorAll(".touch button").forEach((btn) => {
  const act = btn.dataset.act;
  const press = (e) => {
    e.preventDefault();
    if (state !== "playing") return;
    try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ігноруємо */ }
    if (act === "left" || act === "right" || act === "down") setHeld(act, true);
    else if (act === "rotate") rotate(1);
    else if (act === "drop") hardDrop();
    else if (act === "hold") holdPiece();
  };
  const release = (e) => {
    e.preventDefault();
    if (act === "left" || act === "right" || act === "down") setHeld(act, false);
  };
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
});

/* ---------- Оновлення ---------- */
function update(dt) {
  if (dasDir) {
    dasTimer += dt;
    while (dasTimer >= DAS) {
      if (!shiftHorizontal(dasDir)) { dasTimer = DAS; break; }
      dasTimer -= ARR;
    }
  }

  const interval = held.down ? Math.min(gravityMs(), SOFT_DROP_MS) : gravityMs();
  gravTimer += dt;
  while (gravTimer >= interval) {
    gravTimer -= interval;
    if (move(0, 1)) {
      lockResets = 0;
      lockTime = 0;
      if (held.down) score += 1;
    } else {
      gravTimer = 0;
      break;
    }
  }

  if (state === "playing" && cur) {
    if (isGrounded()) {
      lockTime += held.down ? dt * 4 : dt;
      if (lockTime >= LOCK_DELAY) lockPiece();
    } else {
      lockTime = 0;
    }
  }
  updateHud();
}

/* ---------- Малювання ---------- */
function drawCell(c, x, y, s, color, alpha) {
  const b = s > 24 ? 3 : 2;
  c.globalAlpha = alpha === undefined ? 1 : alpha;
  c.fillStyle = color;
  c.fillRect(x + 1, y + 1, s - 2, s - 2);
  c.fillStyle = "rgba(255,255,255,0.22)";
  c.fillRect(x + 1, y + 1, s - 2, b);
  c.fillRect(x + 1, y + 1, b, s - 2);
  c.fillStyle = "rgba(0,0,0,0.26)";
  c.fillRect(x + 1, y + s - 1 - b, s - 2, b);
  c.fillRect(x + s - 1 - b, y + 1, b, s - 2);
  c.globalAlpha = 1;
}

function drawGrid(c) {
  c.fillStyle = "#101216";
  c.fillRect(0, 0, COLS * CELL, ROWS * CELL);
  c.strokeStyle = "rgba(255,255,255,0.045)";
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 1; x < COLS; x++) { c.moveTo(x * CELL + 0.5, 0); c.lineTo(x * CELL + 0.5, ROWS * CELL); }
  for (let y = 1; y < ROWS; y++) { c.moveTo(0, y * CELL + 0.5); c.lineTo(COLS * CELL, y * CELL + 0.5); }
  c.stroke();
}

function ghostY() {
  let y = cur.y;
  while (!collide(cur.m, cur.x, y + 1)) y++;
  return y;
}

function drawBoard() {
  drawGrid(bctx);
  if (!board) return;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c]) drawCell(bctx, c * CELL, r * CELL, CELL, COLORS[board[r][c]]);
    }
  }

  if (cur && (state === "playing" || state === "paused")) {
    const gy = ghostY();
    if (gy !== cur.y) {
      bctx.strokeStyle = COLORS[cur.type];
      bctx.globalAlpha = 0.5;
      bctx.lineWidth = 2;
      for (let r = 0; r < cur.m.length; r++) {
        for (let c = 0; c < cur.m[r].length; c++) {
          if (cur.m[r][c] && gy + r >= 0) {
            bctx.strokeRect((cur.x + c) * CELL + 3, (gy + r) * CELL + 3, CELL - 6, CELL - 6);
          }
        }
      }
      bctx.globalAlpha = 1;
    }
    for (let r = 0; r < cur.m.length; r++) {
      for (let c = 0; c < cur.m[r].length; c++) {
        if (cur.m[r][c] && cur.y + r >= 0) {
          drawCell(bctx, (cur.x + c) * CELL, (cur.y + r) * CELL, CELL, COLORS[cur.type]);
        }
      }
    }
  }

  if (state === "clearing") {
    const k = clearTimer / CLEAR_ANIM_MS;
    const a = 0.85 * (1 - k) + 0.1;
    bctx.fillStyle = "rgba(255,250,235," + a.toFixed(3) + ")";
    for (const r of clearRows) bctx.fillRect(0, r * CELL, COLS * CELL, CELL);
  }
}

function drawPreview(c, type, cx, cy, size) {
  const m = SHAPES[type];
  let minR = 9, maxR = -1, minC = 9, maxC = -1;
  for (let r = 0; r < m.length; r++) {
    for (let k = 0; k < m[r].length; k++) {
      if (!m[r][k]) continue;
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minC = Math.min(minC, k); maxC = Math.max(maxC, k);
    }
  }
  const w = (maxC - minC + 1) * size;
  const h = (maxR - minR + 1) * size;
  const ox = cx - w / 2, oy = cy - h / 2;
  for (let r = minR; r <= maxR; r++) {
    for (let k = minC; k <= maxC; k++) {
      if (m[r][k]) drawCell(c, ox + (k - minC) * size, oy + (r - minR) * size, size, COLORS[type]);
    }
  }
}

function drawSide() {
  hctx.clearRect(0, 0, 96, 72);
  if (holdType) {
    hctx.globalAlpha = canHold ? 1 : 0.4;
    drawPreview(hctx, holdType, 48, 36, 20);
    hctx.globalAlpha = 1;
  }
  nctx.clearRect(0, 0, 96, 216);
  if (queue) {
    for (let i = 0; i < 3 && i < queue.length; i++) {
      drawPreview(nctx, queue[i], 48, 36 + i * 72, 20);
    }
  }
}

/* ---------- Цикл ---------- */
let last = performance.now();
function frame(t) {
  const dt = Math.min(50, t - last);
  last = t;

  if (state === "playing") update(dt);
  else if (state === "clearing") {
    clearTimer += dt;
    if (clearTimer >= CLEAR_ANIM_MS) finishClear();
  }

  drawBoard();
  drawSide();
  requestAnimationFrame(frame);
}

/* ---------- Старт ---------- */
board = emptyBoard();
queue = [];
score = 0; lines = 0; level = 1;
updateHud();
showOverlay("Тетріс", "Збирайте суцільні лінії, щоб очистити поле.", "Грати");
requestAnimationFrame(frame);
