
// =====================================
// Seating Planner — pure client-side JS
// =====================================

// --------- Utilities ---------
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function toast(msg){
const t = $("toast");
t.textContent = msg;
t.classList.add("show");
clearTimeout(toast._tm);
toast._tm = setTimeout(()=>t.classList.remove("show"), 1400);
}

function stableStringify(obj){
// Stable-ish stringify for localStorage diff friendliness
return JSON.stringify(obj, Object.keys(obj).sort(), 2);
}

// --------- Distance metrics ---------
const dist = {
manhattan: (a,b) => Math.abs(a.r-b.r) + Math.abs(a.c-b.c),
chebyshev: (a,b) => Math.max(Math.abs(a.r-b.r), Math.abs(a.c-b.c)),
euclidean2: (a,b) => { const dr=a.r-b.r, dc=a.c-b.c; return dr*dr + dc*dc; },
};

// --------- Model ---------
const MODEL_VERSION = 1;

const state = {
room: {
    rows: 8,
    cols: 10,
    cell: 42,
    blocked: new Set(),
    teacher: new Set(),
    // seats: Map key "r,c" => seatId string
    seats: new Map(),
},
pupils: [],  // [{id, tags:[], fixed:null|{seat}|{r,c}}]
rules: [],   // rule objects
assignment: {}, // pupilId -> seatId
tool: "seat",
};

function keyRC(r,c){ return `${r},${c}`; }

function seatIdFor(r,c){ return `S${String(r).padStart(2,"0")}_${String(c).padStart(2,"0")}`; }

function parseJSONText(text, fallback){
try{ return JSON.parse(text); }catch(e){ return fallback; }
}

function saveLocal(){
const payload = exportJSON();
localStorage.setItem("seating_planner_v"+MODEL_VERSION, JSON.stringify(payload));
}

function loadLocal(){
const raw = localStorage.getItem("seating_planner_v"+MODEL_VERSION);
if(!raw) return false;
try{
    importJSON(JSON.parse(raw));
    return true;
}catch(e){
    console.warn(e);
    return false;
}
}

// --------- Room helpers ---------
function isBlocked(r,c){ return state.room.blocked.has(keyRC(r,c)); }
function isTeacher(r,c){ return state.room.teacher.has(keyRC(r,c)); }
function isSeat(r,c){ return state.room.seats.has(keyRC(r,c)); }

function ensureSeat(r,c){
const k = keyRC(r,c);
if(isBlocked(r,c)) state.room.blocked.delete(k);
state.room.seats.set(k, seatIdFor(r,c));
}
function ensureBlocked(r,c){
const k = keyRC(r,c);
state.room.seats.delete(k);
state.room.teacher.delete(k);
state.room.blocked.add(k);
}
function ensureTeacher(r,c){
const k = keyRC(r,c);
if(isBlocked(r,c)) state.room.blocked.delete(k);
state.room.teacher.add(k);
}
function ensureEmpty(r,c){
const k = keyRC(r,c);
state.room.seats.delete(k);
state.room.teacher.delete(k);
state.room.blocked.delete(k);
}

function allSeatIds(){
return Array.from(state.room.seats.values());
}

function seatPosById(seatId){
// seatId format: Srr_cc
const m = /^S(\d{2})_(\d{2})$/.exec(seatId);
if(!m) return null;
return {r: parseInt(m[1],10), c: parseInt(m[2],10)};
}

// --------- Assignment ---------
function buildInitialAssignment(seed){
const rng = mulberry32(seed >>> 0);
const pupils = getPupils();
const seats = allSeatIds();

// fixed placements
const used = new Set();
const assign = {};

// helper: fixed rc -> seat id
function rcToSeatId(r,c){
    const k = keyRC(r,c);
    if(!state.room.seats.has(k)) throw new Error(`fixed r,c (${r},${c}) is not a seat`);
    return state.room.seats.get(k);
}

for(const p of pupils){
    if(p.fixed && p.fixed.seat){
    const sid = p.fixed.seat;
    if(!seats.includes(sid)) throw new Error(`fixed seat ${sid} not in map`);
    if(used.has(sid)) throw new Error(`seat ${sid} fixed twice`);
    assign[p.id]=sid; used.add(sid);
    } else if(p.fixed && ("r" in p.fixed) && ("c" in p.fixed)){
    const sid = rcToSeatId(p.fixed.r, p.fixed.c);
    if(used.has(sid)) throw new Error(`seat ${sid} fixed twice`);
    assign[p.id]=sid; used.add(sid);
    }
}

// remaining seats
const free = seats.filter(s=>!used.has(s));

// Split pupils:
//  - tagged pupils (any tags) are placed first (uniform random over remaining seats)
//  - then all other pupils are placed with a FRONT-BIASED random (more likely near the top/front)
const remainingPupils = pupils.filter(p=>!assign[p.id]);
const tagged = remainingPupils.filter(p => Array.isArray(p.tags) && p.tags.length>0).map(p=>p.id);
const untagged = remainingPupils.filter(p => !(Array.isArray(p.tags) && p.tags.length>0)).map(p=>p.id);

if((tagged.length + untagged.length) > free.length){
    throw new Error(`Not enough seats (${seats.length}) for pupils (${pupils.length})`);
}

// 1) Place tagged pupils (uniform random)
shuffleInPlace(free, rng);
let idx = 0;
for(const pid of tagged){
    assign[pid] = free[idx++];
}

// 2) Place untagged pupils (front-to-back flood fill)
// Classroom-style fill: after priority placements, fill the remaining seats
// starting from the front row (row 0) moving backwards.
// Optional: keep a little randomness *within the same row* so it doesn't look too artificial.

const free2 = free.slice(idx);

// Sort seats by row asc (front->back), then col asc (left->right)
free2.sort((sa, sb) => {
    const a = seatPosById(sa);
    const b = seatPosById(sb);
    if(!a && !b) return 0;
    if(!a) return 1;
    if(!b) return -1;
    if(a.r !== b.r) return a.r - b.r;
    return a.c - b.c;
});

// Mild within-row shuffle toggle (set to 0 for strict left-to-right)
const WITHIN_ROW_SHUFFLE = 1;

if(WITHIN_ROW_SHUFFLE){
    // Group seats by row, shuffle each row block to mimic "fill tables" feel
    let i0 = 0;
    while(i0 < free2.length){
    const p0 = seatPosById(free2[i0]);
    let i1 = i0 + 1;
    while(i1 < free2.length){
        const p1 = seatPosById(free2[i1]);
        if(!p0 || !p1 || p1.r !== p0.r) break;
        i1++;
    }
    // shuffle [i0, i1)
    const slice = free2.slice(i0, i1);
    shuffleInPlace(slice, rng);
    for(let k=0;k<slice.length;k++) free2[i0+k] = slice[k];
    i0 = i1;
    }
}

// Assign sequentially (flood fill)
for(let i=0; i<untagged.length; i++){
    assign[untagged[i]] = free2[i];
}

return assign;
}

function isFixedPupil(p){
return !!(p.fixed && (p.fixed.seat || ("r" in p.fixed)));
}

function invertAssignment(assign){
const inv = {};
for(const [pid,sid] of Object.entries(assign)) inv[sid]=pid;
return inv;
}

// --------- Constraints / rules engine ---------
const HARD_MULT = 1_000_000;

function rulePenalty(rule, assign, pupilsById, teacherTiles){
const type = rule.type;
const hard = !!rule.hard;
const weight = Math.max(1, rule.weight|0);

function posOf(pid){
    const sid = assign[pid];
    if(!sid) return null;
    return seatPosById(sid);
}

let p = 0;

if(type === "MinDistance"){
    const a=rule.a, b=rule.b, dNeed=rule.d|0, metric=rule.metric||"manhattan";
    const pa=posOf(a), pb=posOf(b);
    if(!pa||!pb) p=0;
    else{
    const d = dist[metric](pa,pb);
    p = d>=dNeed ? 0 : (dNeed - d);
    }
}
else if(type === "MaxDistance"){
    const a=rule.a, b=rule.b, dMax=rule.d|0, metric=rule.metric||"manhattan";
    const pa=posOf(a), pb=posOf(b);
    if(!pa||!pb) p=0;
    else{
    const d = dist[metric](pa,pb);
    p = d<=dMax ? 0 : (d - dMax);
    }
}
else if(type === "NotAdjacent"){
    const a=rule.a, b=rule.b;
    const pa=posOf(a), pb=posOf(b);
    if(!pa||!pb) p=0;
    else p = dist.chebyshev(pa,pb) >= 2 ? 0 : 1;
}
else if(type === "PreferFront"){
    // Soft: prefer in first k rows (front=top)
    const pid=rule.pupil_id, k=rule.k|0;
    const pp=posOf(pid);
    if(!pp) p=0;
    else p = (pp.r < k) ? 0 : 1;
}
else if(type === "PreferAwayFromTeacher"){
    const pid=rule.pupil_id, minD=rule.min_d|0, metric=rule.metric||"manhattan";
    const pp=posOf(pid);
    if(!pp || teacherTiles.length===0) p=0;
    else{
    let best = Infinity;
    for(const t of teacherTiles){
        best = Math.min(best, dist[metric](pp, t));
    }
    p = best >= minD ? 0 : (minD - best);
    }
}
else if(type === "MustBeInRows"){
    const pid=rule.pupil_id, rMin=rule.r_min|0, rMax=rule.r_max|0;
    const pp=posOf(pid);
    if(!pp) p=0;
    else p = (pp.r>=rMin && pp.r<=rMax) ? 0 : 1;
}
else if(type === "MustBeInSeats"){
    const pid=rule.pupil_id;
    const allowed = new Set(rule.allowed_seat_ids||[]);
    const sid = assign[pid];
    if(!sid) p=0;
    else p = allowed.has(sid) ? 0 : 1;
}
else if(type === "TagSeparation"){
    const tag = rule.tag;
    const minD = rule.min_d|0;
    const metric = rule.metric||"manhattan";
    const tagged = [];
    for(const p0 of Object.values(pupilsById)){
    if((p0.tags||[]).includes(tag) && assign[p0.id]) tagged.push(p0.id);
    }
    let pen = 0;
    for(let i=0;i<tagged.length;i++){
    for(let j=i+1;j<tagged.length;j++){
        const pa=posOf(tagged[i]);
        const pb=posOf(tagged[j]);
        if(!pa||!pb) continue;
        const d = dist[metric](pa,pb);
        if(d < minD) pen += (minD - d);
    }
    }
    p = pen;
}
else {
    // Unknown rule type => ignore (safe)
    p = 0;
}

if(p<=0) return 0;
return hard ? (p * HARD_MULT) : (p * weight);
}

function scoreAssignment(assign){
const pupils = getPupils();
const pupilsById = Object.fromEntries(pupils.map(p=>[p.id,p]));

const teacherTiles = Array.from(state.room.teacher).map(k=>{
    const [r,c]=k.split(",").map(Number);
    return {r,c};
});

let total = 0;
let hardBreaks = 0;
for(const rule of getRules()){
    const rawType = rule.type;
    const pen = rulePenalty(rule, assign, pupilsById, teacherTiles);
    total += pen;
    if(pen>=HARD_MULT && rule.hard) hardBreaks += 1;
    // (Note: hardBreaks counts rule objects violated, not magnitude)
}
return { total, hardBreaks };
}

// --------- Solver (Simulated Annealing + restarts) ---------

function solve({restarts, itersPerRestart, t0, t1, seed, progressCb}){
const pupils = getPupils();
if(pupils.length === 0) throw new Error("No pupils.");
const seats = allSeatIds();
if(seats.length === 0) throw new Error("No seats in map.");
if(pupils.length > seats.length) throw new Error(`Not enough seats (${seats.length}) for pupils (${pupils.length}).`);

const fixedSet = new Set(pupils.filter(isFixedPupil).map(p=>p.id));

let bestGlobal = null;
let bestScore = Infinity;
let bestHard = Infinity;

const masterRng = mulberry32(seed >>> 0);

for(let r=0;r<restarts;r++){
    const restartSeed = Math.floor(masterRng()*0xFFFFFFFF) >>> 0;
    const rng = mulberry32(restartSeed);

    let cur = buildInitialAssignment(restartSeed);
    let curSc = scoreAssignment(cur);

    let bestLocal = cur;
    let bestLocalSc = curSc;

    const ratio = itersPerRestart>1 ? Math.pow(t1 / t0, 1/(itersPerRestart-1)) : 1;
    let T = t0;

    for(let i=0;i<itersPerRestart;i++){
    // propose a swap between two non-fixed pupils
    const movable = pupils.filter(p=>!fixedSet.has(p.id)).map(p=>p.id);
    if(movable.length < 2) break;

    const a = movable[Math.floor(rng()*movable.length)];
    let b = a;
    while(b===a) b = movable[Math.floor(rng()*movable.length)];

    const next = {...cur};
    const sa = next[a], sb = next[b];
    next[a] = sb; next[b] = sa;

    const nextSc = scoreAssignment(next);
    const delta = nextSc.total - curSc.total;

    let accept = false;
    if(delta <= 0) accept = true;
    else {
        const p = Math.exp(-delta / Math.max(1e-9, T));
        accept = (rng() < p);
    }

    if(accept){
        cur = next;
        curSc = nextSc;
        if(curSc.total < bestLocalSc.total){
        bestLocal = cur;
        bestLocalSc = curSc;
        if(bestLocalSc.total === 0) break;
        }
    }

    T *= ratio;
    }

    // keep global best
    if(bestLocalSc.total < bestScore){
    bestScore = bestLocalSc.total;
    bestHard = bestLocalSc.hardBreaks;
    bestGlobal = bestLocal;
    }

    progressCb?.({restart: r+1, restarts, bestScore, bestHard});
    if(bestScore === 0) break;
}

return { assignment: bestGlobal, bestScore, bestHard };
}

function quickImprove({iters, t0, t1, seed, progressCb}){
// One restart, starting from current assignment if available.
const pupils = getPupils();
const fixedSet = new Set(pupils.filter(isFixedPupil).map(p=>p.id));

let cur = Object.keys(state.assignment||{}).length ? {...state.assignment} : buildInitialAssignment(seed);
// ensure assignment covers all pupils (e.g., after edits)
cur = repairAssignment(cur, seed);

let curSc = scoreAssignment(cur);
let best = cur;
let bestSc = curSc;

const rng = mulberry32(seed >>> 0);
const ratio = iters>1 ? Math.pow(t1/t0, 1/(iters-1)) : 1;
let T = t0;

const movable = pupils.filter(p=>!fixedSet.has(p.id)).map(p=>p.id);
for(let i=0;i<iters;i++){
    if(movable.length < 2) break;
    const a = movable[Math.floor(rng()*movable.length)];
    let b=a; while(b===a) b = movable[Math.floor(rng()*movable.length)];

    const next = {...cur};
    const sa=next[a], sb=next[b];
    next[a]=sb; next[b]=sa;

    const nextSc = scoreAssignment(next);
    const delta = nextSc.total - curSc.total;
    let accept=false;
    if(delta<=0) accept=true;
    else accept = (rng() < Math.exp(-delta/Math.max(1e-9,T)));

    if(accept){
    cur = next; curSc = nextSc;
    if(curSc.total < bestSc.total){ best = cur; bestSc = curSc; }
    }
    T *= ratio;
    if(i % 200 === 0) progressCb?.({i, iters, bestScore: bestSc.total, hard: bestSc.hardBreaks});
}

return { assignment: best, bestScore: bestSc.total, bestHard: bestSc.hardBreaks };
}

function repairAssignment(assign, seed){
// Ensure all pupils have seats and no duplicates; respects fixed.
const rng = mulberry32(seed >>> 0);
const pupils = getPupils();
const seats = allSeatIds();

const used = new Set();
const fixed = new Map();

// apply fixed
for(const p of pupils){
    if(p.fixed?.seat){ fixed.set(p.id, p.fixed.seat); }
    else if(p.fixed && ("r" in p.fixed) && ("c" in p.fixed)){
    const k = keyRC(p.fixed.r, p.fixed.c);
    if(!state.room.seats.has(k)) throw new Error(`fixed r,c (${p.fixed.r},${p.fixed.c}) is not a seat`);
    fixed.set(p.id, state.room.seats.get(k));
    }
}

// clear duplicates & invalid seats
const clean = {};
for(const p of pupils){
    const pid = p.id;
    if(fixed.has(pid)){
    const sid = fixed.get(pid);
    if(used.has(sid)) throw new Error(`seat ${sid} fixed twice`);
    clean[pid]=sid; used.add(sid);
    } else {
    const sid = assign[pid];
    if(sid && seats.includes(sid) && !used.has(sid)){
        clean[pid]=sid; used.add(sid);
    }
    }
}

// fill rest
const free = seats.filter(s=>!used.has(s));
shuffleInPlace(free, rng);
let idx=0;
for(const p of pupils){
    if(clean[p.id]) continue;
    if(idx>=free.length) throw new Error("Not enough seats to repair assignment");
    clean[p.id]=free[idx++];
}

return clean;
}

// --------- Random helpers ---------
function mulberry32(a){
return function(){
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}

function shuffleInPlace(arr, rng){
for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(rng() * (i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
}
}

// Weighted random pick (index) from an array, given a weight function.
// Uses roulette-wheel selection; weights do not need to sum to 1.
function weightedPickIndex(arr, weightFn, rng){
let total = 0;
const w = new Array(arr.length);
for(let i=0;i<arr.length;i++){
    const wi = Math.max(0, Number(weightFn(arr[i], i)) || 0);
    w[i] = wi;
    total += wi;
}
if(total <= 0){
    // fall back to uniform
    return Math.floor(rng() * arr.length);
}
let r = rng() * total;
for(let i=0;i<w.length;i++){
    r -= w[i];
    if(r <= 0) return i;
}
return w.length - 1;
}

// --------- UI binding ---------
function setTool(tool){
state.tool = tool;
for(const btn of document.querySelectorAll(".toolBtn")){
    const on = btn.dataset.tool === tool;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
}
}

function rebuildMap(){
const map = $("map");
map.style.setProperty("--cols", String(state.room.cols));
map.style.setProperty("--cell", state.room.cell + "px");
map.innerHTML = "";

const inv = invertAssignment(state.assignment||{});

for(let r=0;r<state.room.rows;r++){
    for(let c=0;c<state.room.cols;c++){
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.r = String(r);
    cell.dataset.c = String(c);

    const k = keyRC(r,c);
    const seatId = state.room.seats.get(k);

    if(isBlocked(r,c)) cell.classList.add("blocked");
    if(isTeacher(r,c)) cell.classList.add("teacher");
    if(isSeat(r,c)) cell.classList.add("seat");

    // badge label
    if(isSeat(r,c)){
    //   const b = document.createElement("div");
    //   b.className = "badge";
    //   b.textContent = seatId.replace(/^S/,"");
    //   cell.appendChild(b);

        const occ = inv[seatId];
        if(occ){
        const o = document.createElement("div");
        o.className = "occ";
        o.textContent = occ;
        cell.appendChild(o);
        }
    } else if(isTeacher(r,c)){
        cell.textContent = "T";
    } else if(isBlocked(r,c)){
        cell.textContent = "";
    } else {
        cell.textContent = "";
    }

    cell.addEventListener("click", onCellClick);
    map.appendChild(cell);
    }
}

updateKPIs();
}

function onCellClick(e){
const r = parseInt(e.currentTarget.dataset.r,10);
const c = parseInt(e.currentTarget.dataset.c,10);

if(state.tool === "seat") ensureSeat(r,c);
else if(state.tool === "blocked") ensureBlocked(r,c);
else if(state.tool === "teacher") ensureTeacher(r,c);
else ensureEmpty(r,c);

// After map change, repair assignment so it's always valid
try{
    state.assignment = repairAssignment(state.assignment||{}, Number($("inpSeed").value||12345));
}catch(err){
    // If repair fails (e.g., no seats), clear assignment
    state.assignment = {};
}

syncTextAreas();
rebuildMap();
saveLocal();
}

function updateKPIs(msg){
const seats = allSeatIds().length;
const pupils = getPupils().length;
$("kpiSeats").textContent = String(seats);
$("kpiPupils").textContent = String(pupils);

const sc = (Object.keys(state.assignment||{}).length) ? scoreAssignment(state.assignment) : {total:0, hardBreaks:0};
$("kpiHard").textContent = String(sc.hardBreaks);
$("kpiScore").textContent = String(sc.total);
$("kpiMsg").textContent = msg || (sc.total===0 && pupils>0 ? "Perfect score." : "Ready.");
}

function getPupils(){
// authoritative from textarea
const raw = $("txtPupils").value.trim();
const parsed = parseJSONText(raw, []);
const pupils = Array.isArray(parsed) ? parsed : [];
// normalise
return pupils.map(p => ({
    id: String(p.id||p.pupil_id||""),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    fixed: p.fixed ?? null,
})).filter(p => p.id.length>0);
}

function getRules(){
const raw = $("txtRules").value.trim();
const parsed = parseJSONText(raw, []);
const rules = Array.isArray(parsed) ? parsed : [];
return rules.map(r => ({
    type: String(r.type||""),
    name: r.name ?? r.type,
    hard: !!r.hard,
    weight: (r.weight==null ? 1 : (r.weight|0)),
    ...r,
})).filter(r => r.type.length>0);
}

function syncTextAreas(){
// Pupils
if(!$("txtPupils").dataset.dirty){
    $("txtPupils").value = JSON.stringify(state.pupils, null, 2);
}
if(!$("txtRules").dataset.dirty){
    $("txtRules").value = JSON.stringify(state.rules, null, 2);
}
}

function readTextAreasIntoState(){
state.pupils = getPupils();
state.rules = getRules();
}

// --------- Export / Import ---------
function exportJSON(){
readTextAreasIntoState();

// serialise sets/maps
const room = {
    rows: state.room.rows,
    cols: state.room.cols,
    cell: state.room.cell,
    blocked: Array.from(state.room.blocked),
    teacher: Array.from(state.room.teacher),
    seats: Array.from(state.room.seats.entries()),
};

return {
    version: MODEL_VERSION,
    room,
    pupils: state.pupils,
    rules: state.rules,
    assignment: state.assignment,
};
}

function importJSON(obj){
if(!obj || typeof obj !== "object") throw new Error("Invalid JSON");

const room = obj.room || {};
state.room.rows = clamp(room.rows|0 || 8, 1, 40);
state.room.cols = clamp(room.cols|0 || 10, 1, 40);
state.room.cell = clamp(room.cell|0 || 42, 28, 64);

state.room.blocked = new Set(Array.isArray(room.blocked) ? room.blocked : []);
state.room.teacher = new Set(Array.isArray(room.teacher) ? room.teacher : []);

state.room.seats = new Map();
if(Array.isArray(room.seats)){
    for(const [k,v] of room.seats){
    state.room.seats.set(String(k), String(v));
    }
}

state.pupils = Array.isArray(obj.pupils) ? obj.pupils : [];
state.rules = Array.isArray(obj.rules) ? obj.rules : [];
state.assignment = obj.assignment && typeof obj.assignment === "object" ? obj.assignment : {};

// Push to inputs
$("inpRows").value = String(state.room.rows);
$("inpCols").value = String(state.room.cols);
$("inpCell").value = String(state.room.cell);

$("txtPupils").dataset.dirty = "";
$("txtRules").dataset.dirty = "";
$("txtPupils").value = JSON.stringify(state.pupils, null, 2);
$("txtRules").value = JSON.stringify(state.rules, null, 2);

// repair assignment
try{ state.assignment = repairAssignment(state.assignment, Number($("inpSeed").value||12345)); }
catch{ state.assignment = {}; }

rebuildMap();
saveLocal();
}

// --------- Rule templates ---------
function addRuleTemplate(){
const tpl = $("selRuleTpl").value;
const rules = getRules();

const pupils = getPupils().map(p=>p.id);
const a = pupils[0] || "A";
const b = pupils[1] || "B";

let rule;
if(tpl === "mindist") rule = {type:"MinDistance", name:"A far from B", hard:true, a, b, d:3, metric:"manhattan"};
if(tpl === "maxdist") rule = {type:"MaxDistance", name:"A near B", hard:false, weight:2, a, b, d:3, metric:"manhattan"};
if(tpl === "notadj") rule = {type:"NotAdjacent", name:"Not adjacent", hard:true, a, b};
if(tpl === "preferfront") rule = {type:"PreferFront", name:"Prefer front", hard:false, weight:3, pupil_id:a, k:2};
if(tpl === "awayteacher") rule = {type:"PreferAwayFromTeacher", name:"Away from teacher", hard:false, weight:2, pupil_id:a, min_d:3, metric:"manhattan"};
if(tpl === "tagsep") rule = {type:"TagSeparation", name:"Spread tag", hard:false, weight:5, tag:"talkative", min_d:4, metric:"manhattan"};
if(tpl === "mustrows") rule = {type:"MustBeInRows", name:"Must be in rows", hard:true, pupil_id:a, r_min:0, r_max:1};

rules.push(rule);
$("txtRules").dataset.dirty = "";
$("txtRules").value = JSON.stringify(rules, null, 2);
readTextAreasIntoState();
updateKPIs("Rule added.");
saveLocal();
}

// --------- Demo content ---------
function demoFill(){
const pupils = [
    {id:"A", tags:["needs_front"], fixed:null},
    {id:"B", tags:["talkative"], fixed:null},
    {id:"C", tags:["talkative"], fixed:null},
    {id:"D", tags:[], fixed:null},
    {id:"E", tags:[], fixed:{r:1,c:0}},
    {id:"F", tags:[], fixed:null},
    {id:"G", tags:[], fixed:null},
    {id:"H", tags:[], fixed:null}
];

const rules = [
    {type:"MinDistance", name:"A far from B", hard:true, a:"A", b:"B", d:3, metric:"manhattan"},
    {type:"NotAdjacent", name:"B not adjacent C", hard:true, a:"B", b:"C"},
    {type:"TagSeparation", name:"Spread talkative", hard:false, weight:5, tag:"talkative", min_d:4, metric:"manhattan"},
    {type:"PreferFront", name:"A prefers front", hard:false, weight:3, pupil_id:"A", k:2},
    {type:"PreferAwayFromTeacher", name:"B away from teacher", hard:false, weight:2, pupil_id:"B", min_d:3, metric:"manhattan"}
];

state.pupils = pupils;
state.rules = rules;

$("txtPupils").dataset.dirty = "";
$("txtRules").dataset.dirty = "";
$("txtPupils").value = JSON.stringify(pupils, null, 2);
$("txtRules").value = JSON.stringify(rules, null, 2);

try{
    state.assignment = buildInitialAssignment(Number($("inpSeed").value||12345));
}catch{ state.assignment = {}; }

rebuildMap();
saveLocal();
toast("Demo loaded");
}

// --------- Wire up events ---------
for(const btn of document.querySelectorAll(".toolBtn")){
btn.addEventListener("click", () => setTool(btn.dataset.tool));
}

$("inpRows").addEventListener("change", () => {});
$("inpCols").addEventListener("change", () => {});
$("inpCell").addEventListener("change", () => {
state.room.cell = clamp(Number($("inpCell").value||42), 28, 64);
rebuildMap();
saveLocal();
});

$("btnResize").addEventListener("click", () => {
const newR = clamp(Number($("inpRows").value||8), 1, 40);
const newC = clamp(Number($("inpCols").value||10), 1, 40);

// Prune tiles that are out of bounds
function inBoundsKey(k){
    const [r,c] = k.split(",").map(Number);
    return r>=0 && r<newR && c>=0 && c<newC;
}
state.room.blocked = new Set(Array.from(state.room.blocked).filter(inBoundsKey));
state.room.teacher = new Set(Array.from(state.room.teacher).filter(inBoundsKey));

const newSeats = new Map();
for(const [k,v] of state.room.seats.entries()){
    if(inBoundsKey(k)) newSeats.set(k, v);
}
state.room.seats = newSeats;

state.room.rows = newR;
state.room.cols = newC;

// repair assignment
try{ state.assignment = repairAssignment(state.assignment||{}, Number($("inpSeed").value||12345)); }
catch{ state.assignment = {}; }

rebuildMap();
saveLocal();
toast("Grid resized");
});

$("txtPupils").addEventListener("input", () => { $("txtPupils").dataset.dirty = "1"; updateKPIs("Pupils edited."); });
$("txtRules").addEventListener("input", () => { $("txtRules").dataset.dirty = "1"; updateKPIs("Rules edited."); });

$("btnAddPupil").addEventListener("click", () => {
const id = $("inpPupilId").value.trim();
if(!id){ toast("Enter pupil ID"); return; }
const tags = $("inpPupilTags").value.split(",").map(s=>s.trim()).filter(Boolean);
const pupils = getPupils();
if(pupils.some(p=>p.id===id)){ toast("ID exists"); return; }
pupils.push({id, tags, fixed:null});
$("txtPupils").dataset.dirty = "";
$("txtPupils").value = JSON.stringify(pupils, null, 2);
readTextAreasIntoState();
try{ state.assignment = repairAssignment(state.assignment||{}, Number($("inpSeed").value||12345)); }catch{}
rebuildMap();
saveLocal();
toast("Pupil added");
});

$("btnAutoFill").addEventListener("click", demoFill);
$("btnAddRule").addEventListener("click", addRuleTemplate);

$("btnShuffle").addEventListener("click", () => {
readTextAreasIntoState();
try{
    const seed = Number($("inpSeed").value||12345);
    state.assignment = buildInitialAssignment(seed);
    rebuildMap();
    saveLocal();
    toast("Shuffled");
}catch(e){ toast(String(e.message||e)); }
});

$("btnStep").addEventListener("click", () => {
readTextAreasIntoState();
try{
    const seed = Number($("inpSeed").value||12345);
    const out = quickImprove({
    iters: 4000,
    t0: 2.5,
    t1: 0.05,
    seed,
    progressCb: (p) => {
        if(p.i % 800 === 0) updateKPIs(`Improving… best=${p.bestScore}`);
    }
    });
    state.assignment = out.assignment;
    rebuildMap();
    updateKPIs(out.bestScore===0 ? "Perfect score." : `Improved. score=${out.bestScore}`);
    saveLocal();
    toast("Improved");
}catch(e){
    toast(String(e.message||e));
}
});

$("btnSolve").addEventListener("click", async () => {
readTextAreasIntoState();
try{
    const restarts = clamp(Number($("inpRestarts").value||25), 1, 80);
    const iters = clamp(Number($("inpIters").value||25000), 100, 300000);
    const t0 = Math.max(0.05, Number($("inpT0").value||6.0));
    const t1 = Math.max(0.001, Number($("inpT1").value||0.05));
    const seed = Number($("inpSeed").value||12345);

    // prevent UI freeze: yield between restarts using a microtask
    let lastMsg = 0;
    const out = solve({
    restarts,
    itersPerRestart: iters,
    t0,
    t1,
    seed,
    progressCb: (p) => {
        const now = performance.now();
        if(now - lastMsg > 120){
        updateKPIs(`Solving… restart ${p.restart}/${p.restarts} · best=${p.bestScore}`);
        lastMsg = now;
        }
    }
    });

    state.assignment = out.assignment || {};
    rebuildMap();
    updateKPIs(out.bestScore===0 ? "Perfect score." : `Done. score=${out.bestScore}`);
    saveLocal();
    toast(out.bestScore===0 ? "Solved" : "Done");
}catch(e){
    toast(String(e.message||e));
    updateKPIs("Error: " + String(e.message||e));
}
});

$("btnExport").addEventListener("click", async () => {
try{
    const data = exportJSON();
    const txt = JSON.stringify(data, null, 2);
    await navigator.clipboard.writeText(txt);
    toast("Copied JSON");
}catch(e){
    // Clipboard may fail on some embedded browsers; fallback prompt
    const txt = JSON.stringify(exportJSON(), null, 2);
    prompt("Copy JSON:", txt);
}
});

$("btnImport").addEventListener("click", () => {
const txt = prompt("Paste JSON to import:");
if(!txt) return;
try{ importJSON(JSON.parse(txt)); toast("Imported"); }
catch(e){ toast("Import failed"); }
});

$("btnReset").addEventListener("click", () => {
if(!confirm("Reset everything?")) return;
localStorage.removeItem("seating_planner_v"+MODEL_VERSION);
location.reload();
});

$("btnEink").addEventListener("click", () => {
document.body.classList.toggle("eink");
toast(document.body.classList.contains("eink") ? "E‑Ink preview on" : "E‑Ink preview off");
});

// --------- Boot ---------
function initDefaultMap(){
// Minimal demo room: teacher tiles at top center, aisle in col 5, seats rows 1..6.
state.room.rows = Number($("inpRows").value||8);
state.room.cols = Number($("inpCols").value||10);
state.room.cell = Number($("inpCell").value||42);

// teacher
state.room.teacher.add(keyRC(0,4));
state.room.teacher.add(keyRC(0,5));

// seats
for(let r=1;r<=6;r++){
    for(let c=0;c<state.room.cols;c++){
    if(c===5) continue; // aisle
    ensureSeat(r,c);
    }
}

// blocked back wall row
for(let c=0;c<state.room.cols;c++) ensureBlocked(7,c);

// baseline pupils/rules
state.pupils = [];
state.rules = [];

$("txtPupils").value = JSON.stringify(state.pupils, null, 2);
$("txtRules").value = JSON.stringify(state.rules, null, 2);

state.assignment = {};
}

(function boot(){
setTool("seat");

if(!loadLocal()){
    initDefaultMap();
    demoFill();
} else {
    // ensure inputs reflect loaded
    $("inpRows").value = String(state.room.rows);
    $("inpCols").value = String(state.room.cols);
    $("inpCell").value = String(state.room.cell);

    // set textareas
    $("txtPupils").dataset.dirty = "";
    $("txtRules").dataset.dirty = "";
    $("txtPupils").value = JSON.stringify(state.pupils, null, 2);
    $("txtRules").value = JSON.stringify(state.rules, null, 2);
}

// repair assignment after any load
try{ state.assignment = repairAssignment(state.assignment||{}, Number($("inpSeed").value||12345)); }
catch{ state.assignment = {}; }

rebuildMap();
updateKPIs("Ready.");
})();
