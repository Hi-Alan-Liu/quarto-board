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
const LS_RULES_KEY = "quarto_rules_open";

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

/** 屬性的文字說明（給 aria-label / title 用，索引 = 屬性值 0/1） */
const ATTR_LABELS = {
  color:  ["粉紅", "粉藍"],
  height: ["矮",   "高"],
  shape:  ["圓柱", "方塊"],
  hollow: ["實心", "中空"],
};

/** 把一顆棋子描述成文字，例如「粉藍 高 方塊 中空」 */
function pieceLabel(p){
  return [
    ATTR_LABELS.color[p.color],
    ATTR_LABELS.height[p.height],
    ATTR_LABELS.shape[p.shape],
    ATTR_LABELS.hollow[p.hollow],
  ].join(" ");
}

/** 棋盤格的位置描述，例如「第2列第3行」 */
function cellLabel(i){
  return `第${Math.floor(i/4)+1}列第${(i%4)+1}行`;
}

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

// 規則說明摺疊區
const $rules = document.getElementById("rules");

/**
 * 使用者現在是用鍵盤還是滑鼠？
 * 只有鍵盤使用者需要在重繪後把焦點接回來；滑鼠使用者被移動焦點會莫名其妙。
 * 判斷方式與 :focus-visible 一致：看最後一次輸入是鍵盤還是指標。
 */
let keyboardActive = false;
document.addEventListener("keydown", (e) => {
  if(e.key === "Tab" || e.key === "Enter" || e.key === " ") keyboardActive = true;
});
document.addEventListener("pointerdown", () => { keyboardActive = false; });

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

  // ✅ 兩種形狀共用同一個 viewBox，並對齊同一條地平線：
  //    「高 / 矮」才會是可以互相比較的視覺差異，高棋子也不會超出邊界被裁切。
  const GROUND = 90;

  // 圓柱
  if (p.shape === 0) {
    const h = p.height ? 64 : 30;
    const cx = 50;
    const rx = 28;
    const ry = 10;
    const bottomY = GROUND - ry;   // 底部橢圓最低點恰好落在地平線
    const topY = bottomY - h;

    return `
<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
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
  const BASE_Y = GROUND - 14;      // 前方下緣頂點恰好落在地平線
  const TOP_Y = BASE_Y - HEIGHT;

  return `
<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
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
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell"
      + (pid!==null ? " filled" : "")
      + (i===lastMoveIndex ? " last-move" : "")
      + (winCells.includes(i) ? " win" : "");

    if(pid !== null) cell.innerHTML = pieceSVG(pieces[pid]);

    // 無障礙：格子念出「位置 + 內容」
    const desc = pid !== null
      ? `${cellLabel(i)}，${pieceLabel(pieces[pid])}`
      : `${cellLabel(i)}，空格`;
    cell.setAttribute("aria-label", desc
      + (i===lastMoveIndex ? "，最後一手" : "")
      + (winCells.includes(i) ? "，勝利線" : ""));
    cell.title = desc;

    // 只有「玩家放棋」階段的空格可以按
    cell.disabled = gameOver || phase !== 3 || pid !== null;

    cell.addEventListener("click", ()=>onBoard(i));
    $board.appendChild(cell);
  });

  // 棋子池
  $pieces.innerHTML = "";
  pieces.forEach(p=>{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pieceBtn"
      + (used[p.id] ? " used" : "")
      + (p.id===selected ? " selected" : "");

    btn.innerHTML = pieceSVG(p);

    // 無障礙：棋子念出 4 個屬性，顏色之外也聽得出差異
    let desc = pieceLabel(p);
    if(used[p.id]) desc += "（已放到棋盤上）";
    else if(p.id === selected) desc += "（AI 指定給你的棋子）";
    btn.setAttribute("aria-label", desc);
    btn.title = desc;

    // 只有「玩家選棋給 AI」階段的未使用棋子可以按
    btn.disabled = gameOver || used[p.id] || phase !== 0;

    btn.addEventListener("click", ()=>onPiece(p.id));
    $pieces.appendChild(btn);
  });

  // 每次重繪都會銷毀原本聚焦的元素，AI 回合期間更會連續重繪好幾次。
  // 只有鍵盤使用者需要把焦點接回來，否則他每一手都得重新 Tab 一輪。
  if(keyboardActive && !gameOver) restoreFocus();
}

/** 把焦點移到現在真正能操作的區域（preventScroll：不要把畫面捲走） */
function restoreFocus(){
  const zone = phase === 3 ? $board : $pieces;
  const target = zone.querySelector("button:not([disabled])");
  if(target) target.focus({ preventScroll:true });
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

  // ⚠️ 順序很重要：棋格/棋子的 disabled 是依 phase 計算的，
  //    所以一定要先更新 phase 再 render()，否則玩家放完棋之後
  //    棋子區會維持上一個 phase 的 disabled 狀態而整盤鎖死。
  if(checkWin("你")){
    render();   // 勝負已定（含平手）：確保最後一手畫得出來
    return;
  }

  phase = 0;
  updateTurnHint();
  render();
}

/* =========================
   10) AI：放置（normal / hardcore 分流）
   ========================= */

/**
 * 評估「把 selected 放在 placeIndex」之後的局面。
 *
 * ⚠️ 關鍵觀念：AI 放完棋之後，是 AI 自己挑一顆棋交給對手。
 * 所以「有幾顆棋會讓對手直接獲勝」本身並不危險 —— 只要還剩一顆安全棋，就避得開。
 * 真正會輸的只有一種情況：剩下的每一顆棋，交出去對手都能立刻獲勝（trapped）。
 *
 * 舊版把 danger 的「數量」當成要最小化的目標，會讓 AI 不敢製造任何威脅
 * （製造威脅必然抬高 danger），結果只會自保、從不進攻。
 *
 * @returns {{trapped:boolean, safe:number, danger:number}}
 *   trapped - 放完之後無棋可安全交出 → 下一手必敗
 *   safe    - 還有幾顆棋可以安全交給對手
 *   danger  - 有幾顆棋交出去會讓對手立刻獲勝
 */
function evaluatePlace(placeIndex){
  const test = [...board];
  test[placeIndex] = selected;

  const empties = getEmptyCells(test);

  // 放完這手之後，手上還能交給對手的棋
  const rest = pieces.filter(p => !used[p.id] && p.id !== selected);

  // 棋子剛好用完 → 這手下完就平手，既不安全也不致命
  if(rest.length === 0){
    return { trapped:false, safe:0, danger:0 };
  }

  // hardcore：全部評估；normal：抽樣（維持放水與變化）
  const pool =
    (AI.deterministic || AI.samplePieces >= rest.length)
      ? rest
      : shuffle(rest).slice(0, Math.min(AI.samplePieces, rest.length));

  let danger = 0;
  for(const p of pool){
    if(empties.some(e => wouldWin(test, e, p.id))) danger++;
  }

  return {
    trapped: danger === pool.length,
    safe: pool.length - danger,
    danger
  };
}

function cellBonus(i){
  const center = [5,6,9,10];
  const corners = [0,3,12,15];
  if(center.includes(i)) return 2;
  if(corners.includes(i)) return 1;
  return 0;
}

/** ✅ 不放水：能贏就贏，否則走對自己最有利的一手（完全 deterministic） */
function aiPlaceHardcore(){
  const empty = getEmptyCells(board);

  // 1) 能贏就贏
  for (const i of empty){
    if (wouldWin(board, i, selected)) {
      placeAt(i);
      return;
    }
  }

  // 2) 評估每個位置
  const moves = empty.map(i => {
    const ev = evaluatePlace(i);
    return {
      i,
      trapped: ev.trapped ? 1 : 0,
      safe: ev.safe,
      bonus: cellBonus(i),
    };
  });

  moves.sort((a,b)=>{
    // 2-1) 絕不把自己走進「每顆棋交出去都會輸」的死局
    if (a.trapped !== b.trapped) return a.trapped - b.trapped;
    // 2-2) 在安全的前提下，自己剩的安全棋越少越好：
    //      代表盤面上的威脅越多，輪到對手回送時越容易被逼死。
    //      （AI 先挑棋，所以那顆僅存的安全棋一定拿得到）
    if (a.safe !== b.safe) return a.safe - b.safe;
    if (a.bonus !== b.bonus) return b.bonus - a.bonus;
    return a.i - b.i;
  });

  placeAt(moves[0].i);
}

/** ✅ 放水版：會自保但不主動進攻，保留原本的變化（TopK 隨機＋偶爾犯錯） */
function aiPlaceNormal(){
  const empty = getEmptyCells(board);

  // 1) AI 有立即勝利：高機率直接拿
  const winningMoves = empty.filter(i=>wouldWin(board, i, selected));
  if(winningMoves.length && Math.random() < AI.winProb){
    placeAt(pickOne(winningMoves));
    return;
  }

  // 2) 位置評分：trapped（防守）+ bonus（人味）
  const moves = empty.map(i=>{
    const ev = evaluatePlace(i);
    return {
      i,
      trapped: ev.trapped ? 1 : 0,
      bonus: cellBonus(i),
      r: Math.random()
    };
  });

  const defenseOn = Math.random() < (AI._defense ?? AI.defenseProb);

  moves.sort((a,b)=>{
    // 只避開必敗，不做 hardcore 的「壓縮對手選項」→ 自保但不獵殺
    if(defenseOn && a.trapped !== b.trapped) return a.trapped - b.trapped;
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
  $btnCloseModal?.focus(); // 鍵盤使用者可直接按 Enter 關閉
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

/* =========================
   15) 規則說明 / 鍵盤無障礙
   ========================= */

/** localStorage 在無痕模式會丟異常，這裡一律包起來 */
function lsSet(key, value){
  try{ localStorage.setItem(key, value); }catch{ /* 忽略：不影響遊戲 */ }
}

// 規則區塊：第一次造訪預設展開，之後記住使用者的選擇
if ($rules) {
  let saved = null;
  try{ saved = localStorage.getItem(LS_RULES_KEY); }catch{ saved = null; }
  $rules.open = (saved === null) ? true : (saved === "1");
  $rules.addEventListener("toggle", () => {
    lsSet(LS_RULES_KEY, $rules.open ? "1" : "0");
  });
}

// 結果彈窗：開啟時把焦點移到 OK，並支援 Esc 關閉
// （否則只用鍵盤的人每局結束都會被困在彈窗裡）
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && $overlay?.classList.contains("show")){
    closeModal();
  }
});
