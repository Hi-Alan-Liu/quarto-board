/**
 * Quarto｜你 vs AI
 * - 玩法：你選一顆棋子給 AI 放；AI 再選一顆棋子給你放。
 * - 勝利：同一條線上 4 顆棋子具備任一相同屬性（顏色/高度/形狀/空心）
 * - 戰績：localStorage 保存（清除戰績可歸零）
 */

/* =========================
   0) 常數與工具
   ========================= */

const LS_SCORE_KEY = "quarto_score";

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

function getEmptyCells(board){
  const res = [];
  for(let i=0;i<board.length;i++){
    if(board[i] === null) res.push(i);
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
   2) AI 難度（含每局心情）
   ========================= */

const AI_PRESET = {
  chill:  { winProb: 0.85, defenseProb: 0.55, mistakeProb: 0.25, samplePieces: 5,  topK: 5 },
  normal: { winProb: 0.95, defenseProb: 0.75, mistakeProb: 0.12, samplePieces: 8,  topK: 4 },
  hard:   { winProb: 1.00, defenseProb: 0.92, mistakeProb: 0.05, samplePieces: 12, topK: 3 },
};

let AI = { ...AI_PRESET.normal };

/** 每局隨機一個心情：同樣難度也會有變化 */
function rollAIMood(){
  const moods = [
    { name:"serious", defenseBoost:+0.12, mistakeBoost:-0.03 },
    { name:"playful", defenseBoost:-0.18, mistakeBoost:+0.10 },
    { name:"chaos",   defenseBoost:-0.30, mistakeBoost:+0.18 },
  ];
  const m = moods[(Math.random()*moods.length)|0];
  AI._mood = m.name;
  AI._defense = clamp01(AI.defenseProb + m.defenseBoost);
  AI._mistake = clamp01(AI.mistakeProb + m.mistakeBoost);
}

/** 你之後若要做 UI 切換難度，呼叫這個即可 */
function setDifficulty(name){
  AI = { ...AI_PRESET[name] };
  rollAIMood();
  console.log("AI difficulty:", name, "mood:", AI._mood, AI);
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
   6) SVG 繪製（棋子外觀）
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
   7) Render（棋盤 / 棋子）
   ========================= */

function render(){
  // 棋盤
  $board.innerHTML = "";
  board.forEach((pid,i)=>{
    const cell = document.createElement("div");
    cell.className = "cell"
      + (pid!==null ? " filled" : "")
      + (i===lastMoveIndex ? " last-move" : "");

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
   8) 玩家操作
   ========================= */

function onPiece(id){
  if(gameOver || used[id] || phase !== 0) return;

  selected = id;
  phase = 1;
  $status.textContent = "事件｜AI 正在放置你選的棋子…";

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
  $status.textContent = "事件｜請選一顆棋子給 AI";
}

/* =========================
   9) AI：放置
   - 仍會贏，但不再每次都完美堵死（有變化）
   ========================= */

function estimateDangerAfterPlace(placeIndex){
  const test = [...board];
  test[placeIndex] = selected;

  const empties = getEmptyCells(test);

  // 抽樣玩家可用棋（難度越高 samplePieces 越多）
  const oppAll = pieces.filter(p=>!used[p.id] && p.id!==selected);
  const opp = shuffle(oppAll).slice(0, Math.min(AI.samplePieces, oppAll.length));

  // danger = 抽樣棋中，有幾顆能讓玩家「下一手直接贏」
  let danger = 0;
  for(const p of opp){
    if(empties.some(e=>wouldWin(test, e, p.id))) danger++;
  }
  return danger;
}

function cellBonus(i){
  // 小小偏好：中心 > 角落 > 其他
  const center = [5,6,9,10];
  const corners = [0,3,12,15];
  if(center.includes(i)) return 2;
  if(corners.includes(i)) return 1;
  return 0;
}

function aiPlace(){
  const empty = getEmptyCells(board);

  // 1) AI 有立即勝利：高機率直接拿
  const winningMoves = empty.filter(i=>wouldWin(board, i, selected));
  if(winningMoves.length && Math.random() < AI.winProb){
    placeAt(pickOne(winningMoves));
    return;
  }

  // 2) 位置評分：danger（防守）+ bonus（人味）
  const moves = empty.map(i=>{
    return {
      i,
      danger: estimateDangerAfterPlace(i),
      bonus: cellBonus(i),
      r: Math.random()
    };
  });

  // 不是每次都開啟「超嚴格防守」
  const defenseOn = Math.random() < (AI._defense ?? AI.defenseProb);

  moves.sort((a,b)=>{
    if(defenseOn && a.danger !== b.danger) return a.danger - b.danger; // 越安全越前
    if(a.bonus !== b.bonus) return b.bonus - a.bonus;                 // 偏好中心/角落
    return a.r - b.r;                                                 // 隨機打散
  });

  // 3) TopK 隨機 + 偶爾犯錯
  const topK = Math.min(AI.topK, moves.length);
  const mistake = Math.random() < (AI._mistake ?? AI.mistakeProb);

  let pick;
  if(!mistake){
    pick = moves[(Math.random()*topK)|0];
  }else{
    // 往後挑：造成「偶爾漏防」更有趣
    const start = topK;
    const end = Math.min(moves.length, topK + 4);
    pick = moves[start + ((Math.random()*Math.max(1,end-start))|0)] || moves[moves.length-1];
  }

  placeAt(pick.i);
}

function placeAt(i){
  board[i] = selected;
  used[selected] = true;
  lastMoveIndex = i;
  selected = null;

  render();

  if(checkWin("AI")) return;

  phase = 2;
  setTimeout(aiSelect, 300);
}

/* =========================
   10) AI：選棋給玩家
   - 你可以再加「偶爾送好棋」讓更刺激
   ========================= */

function aiSelect(){
  const candidates = pieces.filter(p=>!used[p.id]);
  const empties = getEmptyCells(board);

  // 1) 安全棋：避免你一放就贏（你若想更有戲可做機率式放行）
  const safe = candidates.filter(p => !empties.some(i=>wouldWin(board, i, p.id)));

  // 2) 屬性分散的棋優先（看起來更像在下棋）
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
  $status.textContent = "事件｜請把右側被框起來的棋子放上棋盤";
  render();
}

/* =========================
   11) 勝負判斷
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

        // ✅ 更新戰績
        if(who === "你") score.youWin++;
        else if(who === "AI") score.aiWin++;
        saveScore();
        renderScore();

        showModal(
          `${who} 獲勝 🎉`,
          `
            <div style="line-height:1.7">
              <strong>獲勝屬性：</strong>${name}<br>
              <strong>獲勝位置：</strong>${line[4]}
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

    score.draw++;
    saveScore();
    renderScore();

    showModal("平手 🤝", "棋子已全部用完，雙方勢均力敵！");
    return true;
  }

  return false;
}

/* =========================
   12) Modal / Reset
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

  rollAIMood(); // ✅ 每局心情不同
  $status.textContent = "事件｜請選一顆棋子給 AI";
  render();
}

/* =========================
   13) 事件綁定與初始化
   ========================= */

$btnResetScore.addEventListener("click", resetScore);
$btnResetGame.addEventListener("click", resetGame);
$btnCloseModal.addEventListener("click", closeModal);

// 點 overlay 黑幕也關閉（可選）
$overlay.addEventListener("click", (e)=>{
  if(e.target === $overlay) closeModal();
});

// 初始
rollAIMood();
$status.textContent = "事件｜請選一顆棋子給 AI";
render();
