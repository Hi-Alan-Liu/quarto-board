/**
 * Quarto｜你 vs AI
 * - 玩法：你選一顆棋子給 AI 放；AI 再選一顆棋子給你放。
 * - 勝利：同一條線上 4 顆棋子具備任一相同屬性（顏色/高度/形狀/空心）
 * - 戰績：localStorage 保存（清除戰績可歸零）
 * - UI：回合提示（含小徽章）＋ 勝利線高亮
 * - 計時：本局計時（mm:ss），開局啟動、結束停止、重開歸零
 *
 * 支援兩套 AI：
 * - normal：原本放水/有變化（心情、抽樣、TopK 隨機、偶爾犯錯）
 * - hardcore：能贏就贏（不抽樣、不隨機、不犯錯、強防守）
 *
 * 需要的 DOM：
 * - #board #pieces #status
 * - #overlay #modalTitle #modalDesc
 * - #scoreText #btnResetScore #btnResetGame #btnCloseModal
 * - #timerText（本局計時顯示）
 * - (可選) #aiMode  (select，value = normal / hardcore)
 */

/* =========================
   0) 常數與工具
   ========================= */

const LS_SCORE_KEY = "quarto_score";
const LS_AI_KEY = "quarto_ai_mode";

/** 4x4 盤面勝利線（4橫 + 4直 + 2斜） */
const WIN_LINES = [
  [0,1,2,3,"第1橫列"], [4,5,6,7,"第2橫列"], [8,9,10,11,"第3橫列"], [12,13,14,15,"第4橫列"],
  [0,4,8,12,"第1直行"], [1,5,9,13,"第2直行"], [2,6,10,14,"第3直行"], [3,7,11,15,"第4直行"],
  [0,5,10,15,"左上 → 右下"], [3,6,9,12,"右上 → 左下"],
];

const ATTRS = [
  ["color","顏色"],
  ["height","高度"],
  ["shape","形狀"],
  ["hollow","空心 / 實心"],
];

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function shuffle(arr){
  const a = [...arr];
  for(let i=a.length-1;i>0;i--){
    const j = (Math.random()*(i+1))|0;
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function pickOne(arr){ return arr[(Math.random()*arr.length)|0]; }

function getEmptyCells(bd){
  const res = [];
  for(let i=0;i<bd.length;i++){
    if(bd[i] === null) res.push(i);
  }
  return res;
}

/* =========================
   1) 棋子資料（16 顆）
   ========================= */

const pieces = [...Array(16)].map((_,i)=>({
  id: i,
  color:  (i>>3)&1,  // 0/1
  height: (i>>2)&1,  // 0/1
  shape:  (i>>1)&1,  // 0/1
  hollow:  i&1       // 0/1
}));

/* =========================
   2) AI 模式（normal / hardcore）
   ========================= */

const AI_PRESET = {
  // ✅ 放水/有變化
  normal: {
    winProb: 0.95,
    defenseProb: 0.75,
    mistakeProb: 0.12,
    samplePieces: 8,
    topK: 4,
    deterministic: false
  },
  // ✅ 能贏就贏（不放水）
  hardcore: {
    winProb: 1.00,
    defenseProb: 1.00,
    mistakeProb: 0.00,
    samplePieces: 16,
    topK: 1,
    deterministic: true
  }
};

let AI = { ...AI_PRESET.normal };

/** 每局隨機一個心情：同樣難度也會有變化（hardcore 不受影響） */
function rollAIMood(){
  // Hardcore：鎖死（不放水）
  if (AI.deterministic) {
    AI._mood = "locked";
    AI._defense = 1;
    AI._mistake = 0;
    return;
  }

  // Normal：保留你的心情變化
  const moods = [
    { name:"serious", defenseBoost:+0.12, mistakeBoost:-0.03 },
    { name:"playful", defenseBoost:-0.18, mistakeBoost:+0.10 },
    { name:"chaos",   defenseBoost:-0.30, mistakeBoost:+0.18 },
  ];
  const m = moods[(Math.random() * moods.length) | 0];
  AI._mood = m.name;
  AI._defense = clamp01(AI.defenseProb + m.defenseBoost);
  AI._mistake = clamp01(AI.mistakeProb + m.mistakeBoost);
}

/** 切換 AI 模式（normal / hardcore） */
function setDifficulty(name){
  const key = AI_PRESET[name] ? name : "normal";
  AI = { ...AI_PRESET[key] };
  localStorage.setItem(LS_AI_KEY, key);
  rollAIMood();
}

/* =========================
   3) 遊戲狀態
   phase:
   0 = 玩家選棋子給 AI
   1 = AI 放置玩家選的棋子
   2 = AI 選棋子給玩家
   3 = 玩家放置 AI 選的棋子
   ========================= */

let board = Array(16).fill(null);
let used  = Array(16).fill(false);

let phase = 0;
let selected = null;
let gameOver = false;
let lastMoveIndex = null;
let winCells = [];

/* =========================
   4) DOM
   ========================= */

const $board   = document.getElementById("board");
const $pieces  = document.getElementById("pieces");
const $status  = document.getElementById("status");

const $overlay    = document.getElementById("overlay");
const $modalTitle = document.getElementById("modalTitle");
const $modalDesc  = document.getElementById("modalDesc");

const $scoreText = document.getElementById("scoreText");
const $btnResetScore = document.getElementById("btnResetScore");
const $btnResetGame  = document.getElementById("btnResetGame");
const $btnCloseModal = document.getElementById("btnCloseModal");

const $timerText = document.getElementById("timerText");

// 可選：AI 模式切換（沒有也不會壞）
const $aiMode = document.getElementById("aiMode");

/* =========================
   5) 戰績（localStorage）
   ========================= */

let score = loadScore();
renderScore(); // ✅ 一開始就顯示（若無資料就是 0/0/0）

function loadScore(){
  try{
    return JSON.parse(localStorage.getItem(LS_SCORE_KEY))
      || { youWin:0, aiWin:0, draw:0 };
  }catch{
    return { youWin:0, aiWin:0, draw:0 };
  }
}

function saveScore(){
  localStorage.setItem(LS_SCORE_KEY, JSON.stringify(score));
}

function renderScore(){
  $scoreText.textContent = `戰績｜你 ${score.youWin} 勝 · AI ${score.aiWin} 勝 · ${score.draw} 平手`;
}

function resetScore(){
  score = { youWin:0, aiWin:0, draw:0 };
  saveScore();
  renderScore();
}

/* =========================
   5.5) 計時器（本局計時）
   - 開局 startTimer()
   - 結束 stopTimer()
   - 新局 resetGame() 會重開
   ========================= */

let gameStartAt = null; // ms
let timerId = null;
let elapsedMs = 0;

function formatMMSS(ms){
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function renderTimer(){
  if(!$timerText) return;
  $timerText.textContent = `本局計時｜${formatMMSS(elapsedMs)}`;
}

function startTimer(){
  stopTimer(); // 避免重複啟動
  gameStartAt = Date.now();
  elapsedMs = 0;
  renderTimer();

  timerId = setInterval(() => {
    elapsedMs = Date.now() - gameStartAt;
    renderTimer();
  }, 250);
}

function stopTimer(){
  if(timerId){
    clearInterval(timerId);
    timerId = null;
  }
}

/* =========================
   6) 回合提示（統一管理 + 小徽章）
   ========================= */

function badgeText(){
  if(gameOver) return "【結束】";
  if(phase === 0 || phase === 3) return "【你的回合】";
  if(phase === 1 || phase === 2) return "【AI 回合】";
  return "【提示】";
}

function setStatus(message){
  const mode = AI.deterministic ? "困難模式" : "一般模式";
  $status.textContent = `${badgeText()}（${mode}） ${message}`;
}

function updateTurnHint(){
  if(gameOver){
    setStatus("本局已結束，可按「再來一局」重新開始");
    return;
  }
  switch(phase){
    case 0: setStatus("請選一顆棋子交給 AI 放置"); break;
    case 1: setStatus("AI 正在放置你選的棋子…"); break;
    case 2: setStatus("AI 正在挑選一顆棋子給你…"); break;
    case 3: setStatus("請把右側「被框起來」的棋子放到棋盤上"); break;
    default:setStatus("狀態異常，建議按「再來一局」"); break;
  }
}

/* =========================
   7) SVG 繪製（棋子外觀）
   ========================= */

function pieceSVG(p, size = 56) {
  const topColor  = p.color ? "#6bb7ff" : "#ff7ab6";
  const bodyColor = p.color ? "#9fd0ff" : "#ffb2d6";
  const sideDark  = p.color ? "#3a6fa8" : "#d15b93";
  const sideLight = p.color ? "#8fc3ff" : "#ff9fc9";

  // 圓柱
  if (p.shape === 0) {
    const h = p.height ? 64 : 30;
    const cx = 50;
    const rx = 28;
    const ry = 10;
    const topY = 26;
    const bottomY = topY + h;

    return `
<svg width="${size}" height="${size}" viewBox="0 0 100 100">
  <path fill="${bodyColor}" d="M ${cx - rx},${topY} A ${rx},${ry} 0 0 0 ${cx + rx},${topY}
                              L ${cx + rx},${bottomY}
                              A ${rx},${ry} 0 0 1 ${cx - rx},${bottomY} Z"/>
  <path fill="${topColor}" d="M ${cx - rx},${topY} A ${rx},${ry} 0 0 1 ${cx + rx},${topY}
                             A ${rx},${ry} 0 0 1 ${cx - rx},${topY} Z"/>
  ${
    p.hollow
      ? `<path fill="#ffffff"
              d="M ${cx - 16},${topY} A 16,7 0 0 1 ${cx + 16},${topY}
                 A 16,7 0 0 1 ${cx - 16},${topY} Z"/>`
      : ""
  }
</svg>`;
  }

  // 立方體
  const HEIGHT = p.height ? 52 : 22;
  const TOP_Y = 24;
  const BASE_Y = TOP_Y + HEIGHT;

  return `
<svg width="${size}" height="${size}" viewBox="0 0 100 80">
  <path fill="${topColor}" d="M 20 ${TOP_Y} L 50 ${TOP_Y - 14} L 80 ${TOP_Y} L 50 ${TOP_Y + 14} Z"/>
  <path fill="${sideDark}" d="M 20 ${TOP_Y} L 50 ${TOP_Y + 14} L 50 ${BASE_Y + 14} L 20 ${BASE_Y} Z"/>
  <path fill="${sideLight}" d="M 50 ${TOP_Y + 14} L 80 ${TOP_Y} L 80 ${BASE_Y} L 50 ${BASE_Y + 14} Z"/>
  ${
    p.hollow
      ? `<path fill="#ffffff"
              d="M 50 ${TOP_Y - 6} L 62 ${TOP_Y} L 50 ${TOP_Y + 6} L 38 ${TOP_Y} Z"/>`
      : ""
  }
</svg>`;
}

/* =========================
   8) Render（棋盤 / 棋子）
   ========================= */

function render(){
  // 棋盤
  $board.innerHTML = "";
  board.forEach((pid,i)=>{
    const cell = document.createElement("div");
    cell.className = "cell"
      + (pid!==null ? " filled" : "")
      + (i===lastMoveIndex ? " last-move" : "")
      + (winCells.includes(i) ? " win" : "");

    if(pid !== null) cell.innerHTML = pieceSVG(pieces[pid]);

    cell.addEventListener("click", ()=>onBoard(i));
    $board.appendChild(cell);
  });

  // 棋子池
  $pieces.innerHTML = "";
  pieces.forEach(p=>{
    const btn = document.createElement("div");
    btn.className = "pieceBtn"
      + (used[p.id] ? " used" : "")
      + (p.id===selected ? " selected" : "");

    btn.innerHTML = pieceSVG(p);
    btn.addEventListener("click", ()=>onPiece(p.id));
    $pieces.appendChild(btn);
  });
}

/* =========================
   9) 玩家操作
   ========================= */

function onPiece(id){
  if(gameOver || used[id] || phase !== 0) return;

  selected = id;
  phase = 1;
  updateTurnHint();

  render();
  setTimeout(aiPlace, 400);
}

function onBoard(index){
  if(gameOver || phase !== 3 || board[index] != null) return;

  board[index] = selected;
  used[selected] = true;

  lastMoveIndex = index;
  selected = null;

  render();

  if(checkWin("你")) return;

  phase = 0;
  updateTurnHint();
}

/* =========================
   10) AI：放置（normal / hardcore 分流）
   ========================= */

function estimateDangerAfterPlace(placeIndex){
  const test = [...board];
  test[placeIndex] = selected;

  const empties = getEmptyCells(test);

  // ✅ hardcore：使用全部可用棋；normal：抽樣
  const oppAll = pieces.filter(p=>!used[p.id] && p.id!==selected);
  const opp =
    (AI.deterministic || AI.samplePieces >= oppAll.length)
      ? oppAll
      : shuffle(oppAll).slice(0, Math.min(AI.samplePieces, oppAll.length));

  // danger = 有多少顆「對手拿到後可以下一手直接贏」
  let danger = 0;
  for(const p of opp){
    if(empties.some(e=>wouldWin(test, e, p.id))) danger++;
  }
  return danger;
}

function cellBonus(i){
  const center = [5,6,9,10];
  const corners = [0,3,12,15];
  if(center.includes(i)) return 2;
  if(corners.includes(i)) return 1;
  return 0;
}

/** ✅ 不放水：能贏就贏，否則選最安全的（完全 deterministic） */
function aiPlaceHardcore(){
  const empty = getEmptyCells(board);

  // 1) 能贏就贏
  for (const i of empty){
    if (wouldWin(board, i, selected)) {
      placeAt(i);
      return;
    }
  }

  // 2) 選最安全的位置
  const moves = empty.map(i => ({
    i,
    danger: estimateDangerAfterPlace(i),
    bonus: cellBonus(i),
  }));

  moves.sort((a,b)=>{
    if (a.danger !== b.danger) return a.danger - b.danger;
    if (a.bonus !== b.bonus) return b.bonus - a.bonus;
    return a.i - b.i;
  });

  placeAt(moves[0].i);
}

/** ✅ 放水版：保留你原本的變化（TopK 隨機＋偶爾犯錯） */
function aiPlaceNormal(){
  const empty = getEmptyCells(board);

  // 1) AI 有立即勝利：高機率直接拿
  const winningMoves = empty.filter(i=>wouldWin(board, i, selected));
  if(winningMoves.length && Math.random() < AI.winProb){
    placeAt(pickOne(winningMoves));
    return;
  }

  // 2) 位置評分：danger（防守）+ bonus（人味）
  const moves = empty.map(i=>({
    i,
    danger: estimateDangerAfterPlace(i),
    bonus: cellBonus(i),
    r: Math.random()
  }));

  const defenseOn = Math.random() < (AI._defense ?? AI.defenseProb);

  moves.sort((a,b)=>{
    if(defenseOn && a.danger !== b.danger) return a.danger - b.danger;
    if(a.bonus !== b.bonus) return b.bonus - a.bonus;
    return a.r - b.r;
  });

  const topK = Math.min(AI.topK, moves.length);
  const mistake = Math.random() < (AI._mistake ?? AI.mistakeProb);

  let pick;
  if(!mistake){
    pick = moves[(Math.random()*topK)|0];
  }else{
    const start = topK;
    const end = Math.min(moves.length, topK + 4);
    pick = moves[start + ((Math.random()*Math.max(1,end-start))|0)] || moves[moves.length-1];
  }

  placeAt(pick.i);
}

function aiPlace(){
  if (AI.deterministic) return aiPlaceHardcore();
  return aiPlaceNormal();
}

function placeAt(i){
  board[i] = selected;
  used[selected] = true;
  lastMoveIndex = i;
  selected = null;

  render();

  if(checkWin("AI")) return;

  phase = 2;
  updateTurnHint();
  setTimeout(aiSelect, 300);
}

/* =========================
   11) AI：選棋給玩家（normal / hardcore 分流）
   ========================= */

function aiSelectHardcore(){
  const candidates = pieces.filter(p => !used[p.id]);
  const empties = getEmptyCells(board);

  function immediateWinCount(pieceId){
    let c = 0;
    for(const i of empties){
      if (wouldWin(board, i, pieceId)) c++;
    }
    return c;
  }

  function similarityScore(piece){
    let s = 0;
    for(const [a] of ATTRS){
      const values = board
        .filter(v => v !== null)
        .map(id => pieces[id][a]);
      if(values.includes(piece[a])) s++;
    }
    return s;
  }

  candidates.sort((p1, p2) => {
    const w1 = immediateWinCount(p1.id);
    const w2 = immediateWinCount(p2.id);
    if (w1 !== w2) return w1 - w2;

    const s1 = similarityScore(p1);
    const s2 = similarityScore(p2);
    if (s1 !== s2) return s1 - s2;

    return p1.id - p2.id;
  });

  selected = candidates[0].id;
  phase = 3;
  updateTurnHint();
  render();
}

function aiSelectNormal(){
  const candidates = pieces.filter(p=>!used[p.id]);
  const empties = getEmptyCells(board);

  const safe = candidates.filter(p => !empties.some(i=>wouldWin(board, i, p.id)));

  function scorePiece(p){
    let s = 0;
    for(const [a] of ATTRS){
      const values = board
        .filter(v=>v!==null)
        .map(id=>pieces[id][a]);
      if(values.includes(p[a])) s++;
    }
    return s;
  }

  const pool = safe.length ? safe : candidates;
  pool.sort((a,b)=>scorePiece(b) - scorePiece(a));

  selected = pool[0].id;
  phase = 3;
  updateTurnHint();
  render();
}

function aiSelect(){
  if (AI.deterministic) return aiSelectHardcore();
  return aiSelectNormal();
}

/* =========================
   12) 勝負判斷
   ========================= */

function simulateWin(testBoard){
  for(const line of WIN_LINES){
    const idx = line.slice(0,4);
    const ids = idx.map(i=>testBoard[i]);
    if(ids.some(v=>v===null)) continue;

    const ps = ids.map(id=>pieces[id]);
    for(const [a] of ATTRS){
      if(ps.every(p=>p[a]===ps[0][a])) return true;
    }
  }
  return false;
}

function wouldWin(boardState, index, pieceId){
  const copy = [...boardState];
  copy[index] = pieceId;
  return simulateWin(copy);
}

function checkWin(who){
  // 勝利
  for(const line of WIN_LINES){
    const idx = line.slice(0,4);
    const ids = idx.map(i=>board[i]);
    if(ids.some(v=>v===null)) continue;

    const ps = ids.map(id=>pieces[id]);

    for(const [attr, name] of ATTRS){
      if(ps.every(p=>p[attr]===ps[0][attr])){
        gameOver = true;
        stopTimer(); // ✅ 結束停表
        winCells = line.slice(0,4);

        if(who === "你") score.youWin++;
        else if(who === "AI") score.aiWin++;
        saveScore();
        renderScore();

        updateTurnHint();

        showModal(
          `${who} 獲勝 🎉`,
          `
            <div style="line-height:1.7">
              <strong>獲勝屬性：</strong>${name}<br>
              <strong>獲勝位置：</strong>${line[4]}<br>
              <strong>本局耗時：</strong>${formatMMSS(elapsedMs)}
            </div>
          `
        );

        render();
        return true;
      }
    }
  }

  // 平手（棋子用完）
  if(used.every(v=>v)){
    gameOver = true;
    stopTimer(); // ✅ 結束停表

    score.draw++;
    saveScore();
    renderScore();

    updateTurnHint();

    showModal(
      "平手 🤝",
      `棋子已全部用完，雙方勢均力敵！<br><strong>本局耗時：</strong>${formatMMSS(elapsedMs)}`
    );
    return true;
  }

  return false;
}

/* =========================
   13) Modal / Reset
   ========================= */

function showModal(title, html){
  $modalTitle.textContent = title;
  $modalDesc.innerHTML = html;
  $overlay.classList.add("show");
  $overlay.setAttribute("aria-hidden", "false");
}

function closeModal(){
  $overlay.classList.remove("show");
  $overlay.setAttribute("aria-hidden", "true");
}

function resetGame(){
  closeModal();

  board = Array(16).fill(null);
  used  = Array(16).fill(false);

  phase = 0;
  selected = null;
  gameOver = false;
  lastMoveIndex = null;
  winCells = [];

  rollAIMood();
  updateTurnHint();
  render();

  startTimer(); // ✅ 新局開始計時（歸零+跑）
}

/* =========================
   14) 事件綁定與初始化
   ========================= */

$btnResetScore?.addEventListener("click", resetScore);
$btnResetGame?.addEventListener("click", resetGame);
$btnCloseModal?.addEventListener("click", closeModal);

$overlay?.addEventListener("click", (e)=>{
  if(e.target === $overlay) closeModal();
});

// AI 模式切換（可選）
if ($aiMode) {
  $aiMode.addEventListener("change", () => {
    setDifficulty($aiMode.value);
    resetGame(); // 切換模式直接開新局
  });
}

// 初始：讀取上次選的 AI 模式（預設 normal）
const savedMode = localStorage.getItem(LS_AI_KEY) || "normal";
if ($aiMode) $aiMode.value = savedMode;
setDifficulty(savedMode);

updateTurnHint();
render();
startTimer(); // ✅ 一進頁面就開始本局計時