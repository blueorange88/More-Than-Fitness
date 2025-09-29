<script type="module">
// mtf-widgets.js
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, runTransaction,
         serverTimestamp, collection, query, where, getDocs, increment, limit } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";

/* ===== Firebase boot ===== */
const firebaseConfig = {
  apiKey:"AIzaSyCjdyveDx0qFPUzmaChnEy9Ni0VjTysYnM",
  authDomain:"more-than-fitness-f6adb.firebaseapp.com",
  projectId:"more-than-fitness-f6adb",
  storageBucket:"more-than-fitness-f6adb.appspot.com",
  messagingSenderId:"993248877411",
  appId:"1:993248877411:web:c0e6785162cf252fbcd156",
  measurementId:"G-MK0RVFG296"
};
function ensureFirebase(){
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);
  onAuthStateChanged(auth, (u)=>{ if(!u) signInAnonymously(auth).catch(console.error); });
  return { db, auth };
}
const { db } = ensureFirebase();

/* ===== Helpers ===== */
const p2 = n => String(n).padStart(2,'0');
const add60 = (t)=>{ const [hh,mm]=t.split(':').map(Number); const m=hh*60+(mm||0)+60; return `${p2(Math.floor(m/60)%24)}:${p2(m%60)}`; };
function isoFromDi(di, weekOffset=0){
  const now=new Date();
  const monday=new Date(now);
  const offset=(now.getDay()+6)%7;
  monday.setDate(now.getDate()-offset + weekOffset*7);
  const d=new Date(monday);
  d.setDate(monday.getDate()+(di-1));
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
}
const COLORS = ['#6b5bd2','#60a5fa','#10b981','#f59e0b','#ef4444','#ec4899','#22c55e'];
function colorForName(name=''){ let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))>>>0; return COLORS[h % COLORS.length]; }

/* ===== Firestore I/O (공통) ===== */
async function upsertScheduleByKey(i, weekOffset=0){
  const date = isoFromDi(i.di, weekOffset);
  const id   = `${date}-${i.di}-${i.time}`;
  const ref  = doc(db,"schedules",id);
  const payload={
    date, di:i.di, start:i.time, end:add60(i.time),
    name:i.name||"", cap:i.cap||0, enrolled:i.enrolled||0,
    trainer:"트레이너 A",
    memberId:i.memberId||null,
    updatedAt:serverTimestamp()
  };
  const ex = await getDoc(ref);
  if(!ex.exists()){
    await setDoc(ref, { ...payload, createdAt: serverTimestamp() }, { merge:true });
  }else{
    await setDoc(ref, payload, { merge:true });
  }
  return id;
}
async function deleteScheduleByKey({di,time}, weekOffset=0){
  const date = isoFromDi(di, weekOffset);
  const id   = `${date}-${di}-${time}`;
  await deleteDoc(doc(db,"schedules",id));
}
async function consumeAdjust({memberId, deltaRemain, type, sched}){
  // type: 'consume'|'consume.undo'|'noshow'|'noshow.undo'
  const toast = (root, msg)=>{ const t=root.querySelector('.mtf-toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1500); };
  try{
    if(memberId){
      await updateDoc(doc(db,"members",memberId),{
        remainingSessions: increment(deltaRemain),
        ...(type.startsWith('noshow') ? { noShowDeducted: increment(type==='noshow'?+1:-1) } : {})
      }).catch(()=>{});
      await addDoc(collection(db,'session_ledger'),{
        memberId, scheduleId:sched.id, type, delta: deltaRemain, date:sched.date, time:sched.start, createdAt:serverTimestamp()
      }).catch(()=>{});
      await addDoc(collection(db,'members',memberId,'history'),{
        kind:type, note:`${sched.date} ${sched.start}`, createdAt: serverTimestamp()
      }).catch(()=>{});
    }
    await updateDoc(doc(db,"schedules",sched.id),{
      ...(type.startsWith('consume') ? { consumed: type==='consume', consumedAt:serverTimestamp() } : {}),
      ...(type.startsWith('noshow')  ? { noShowDeducted: type==='noshow', noShowDeductedAt:serverTimestamp() } : {}),
    }).catch(()=>{});
    return true;
  }catch(e){ console.error(e); return false; }
}

/* =========================================================
   <mtf-next-lessons limit="2">
   - 오늘 날짜의 금일 이후 스케줄을 Firestore에서 불러와 상위 N개 표시
   ========================================================= */
class MtfNextLessons extends HTMLElement{
  #root;
  constructor(){ super(); this.#root=this.attachShadow({mode:'open'}); }
  connectedCallback(){
    const limitCount = parseInt(this.getAttribute('limit')||'2',10);
    this.#root.innerHTML = `
      <style>
        :host{display:block}
        .card{background:#fff;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.08);padding:10px}
        .title{font-weight:800;margin:4px 0 8px}
        ul{margin:0;padding-left:16px}
        .dim{color:#64748b;font-size:12px}
      </style>
      <div class="card">
        <div class="title">오늘 다음 레슨</div>
        <ul class="list"></ul>
        <div class="dim hint"></div>
      </div>
    `;
    this.load(limitCount);
  }
  async load(limitCount){
    const ul=this.#root.querySelector('.list');
    const hint=this.#root.querySelector('.hint');
    const now=new Date();
    const day=(now.getDay()||7); // Sun→7
    const dateISO=isoFromDi(day,0);
    const hh=p2(now.getHours()), mm=p2(now.getMinutes());
    const nowStr = `${hh}:${mm}`;
    try{
      const snap = await getDocs(query(collection(db,'schedules'), where('date','==',dateISO)));
      const arr=[];
      snap.forEach(d=>{
        const v=d.data(); if((v.start||'') >= nowStr){
          const nm = v.name || (v.memberId ? `[${v.memberId}]` : '—');
          arr.push({ t:v.start, text:`${v.start} ${nm} (${v.enrolled||0}/${v.cap||0})` });
        }
      });
      arr.sort((a,b)=> a.t.localeCompare(b.t));
      ul.innerHTML='';
      arr.slice(0,limitCount).forEach(i=>{
        const li=document.createElement('li'); li.textContent=i.text; ul.appendChild(li);
      });
      hint.textContent = arr.length===0 ? '예정된 레슨이 없습니다.' : '';
    }catch(e){
      console.error(e); ul.innerHTML='<li class="dim">불러오기 실패</li>';
    }
  }
}
customElements.define('mtf-next-lessons', MtfNextLessons);

/* =========================================================
   <mtf-schedule week-offset="0" start="06" end="21">
   - 자체 팝업/액션시트 포함한 독립 스케줄 위젯
   - LocalStorage(+ Firestore) 동시 사용
   ========================================================= */
const SCHED_STYLE = `
:host{display:block}
.wrapper{background:#fff;padding:8px;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.08);margin-bottom:14px}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
thead th{position:sticky;top:0;background:#0d1b2a;color:#fff;z-index:1}
th,td{border:1px solid #e5e7eb;text-align:center;vertical-align:top;position:relative}
th{padding:6px} td{padding:2px}
.time{width:12vw;max-width:12vw;background:#f8fafc;white-space:nowrap}
td.filled{color:#fff;font-weight:800}
td.filled .label{display:block;padding:4px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.today-col{background:rgba(212,175,55,.12)}
.line{position:absolute;left:0;right:0;height:2px;background:#FF3B30;animation:pulse 5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}

.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:10000}
.overlay.open{display:block}
.popup{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:14px;border-radius:10px;width:340px;max-width:92%;max-height:84vh;overflow:auto;display:none;z-index:10001}
.popup.open{display:block}
.popup h3{font-size:16px;margin-bottom:8px}
.popup input,.popup select{width:100%;padding:9px;border:1px solid #e5e7eb;border-radius:8px;margin:6px 0}
.btnrow{display:flex;gap:8px;margin-top:8px}
.btnrow button{flex:1;padding:10px;background:#f5f0e8;border:1px solid #ddd;border-radius:8px;cursor:pointer}
.btn-primary{background:#0d1b2a!important;color:#fff!important;border:none!important}

.sheet{position:fixed;background:#111;color:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:8px;z-index:10002;display:none;min-width:220px}
.sheet button{display:block;width:100%;text-align:left;background:transparent;border:none;color:#fff;padding:10px;border-bottom:1px solid rgba(255,255,255,.1);cursor:pointer;font-size:13px}
.sheet button:last-child{border-bottom:none}
.sheet .danger{color:#ffb4b4}

.mtf-toast{position:fixed;top:58px;left:50%;transform:translateX(-50%);background:#0d1b2a;color:#fff;padding:8px 12px;border-radius:14px;opacity:0;transition:opacity .2s;z-index:10005;font-size:12px}
.mtf-toast.show{opacity:1}
`;

const SCHED_HTML = `
<div class="wrapper">
  <table>
    <thead>
      <tr>
        <th class="time-h">시간</th>
        <th>월</th><th>화</th><th>수</th><th>목</th><th>금</th><th>토</th><th>일</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
</div>

<div class="overlay"></div>

<div class="popup popup-edit" role="dialog" aria-modal="true">
  <h3>레슨 정보 <span class="slot-hint" style="font-size:12px;color:#64748b"></span></h3>
  <input class="inp-name" placeholder="회원 이름" />
  <div style="display:flex;gap:8px">
    <input class="inp-enrolled" type="number" placeholder="회차" />
    <input class="inp-cap" type="number" placeholder="총" />
  </div>
  <input class="inp-member" placeholder="회원ID(전화, 선택)" />
  <div class="btnrow">
    <button class="btn-primary btn-save">저장</button>
    <button class="btn-del">삭제</button>
  </div>
</div>

<div class="sheet">
  <button class="s-consume">✅ 소진 처리(–1)</button>
  <button class="s-consume-undo">↩️ 소진 취소(+1)</button>
  <button class="s-noshow danger">🚫 노쇼 차감(–1)</button>
  <button class="s-noshow-undo">🧺 노쇼 취소(+1)</button>
  <button class="s-profile">👤 프로필 열기</button>
  <button class="s-close">닫기</button>
</div>

<div class="mtf-toast"></div>
`;

class MtfSchedule extends HTMLElement{
  #root; #tbody; #overlay; #popup; #sheet; #toast;
  #weekOffset=0; #start=6; #end=21;
  #currentCell=null; #lpTimer=null; #lpFired=false;

  constructor(){
    super(); this.#root=this.attachShadow({mode:'open'});
    const style=document.createElement('style'); style.textContent=SCHED_STYLE;
    this.#root.append(style); this.#root.innerHTML += SCHED_HTML;
  }

  connectedCallback(){
    this.#weekOffset = parseInt(this.getAttribute('week-offset')||'0',10);
    this.#start = Math.max(0, Math.min(23, parseInt(this.getAttribute('start')||'6',10)));
    this.#end   = Math.max(1, Math.min(24, parseInt(this.getAttribute('end')||'21',10)));
    if(this.#end<=this.#start) this.#end=this.#start+12;

    this.#tbody = this.#root.querySelector('tbody');
    this.#overlay = this.#root.querySelector('.overlay');
    this.#popup = this.#root.querySelector('.popup-edit');
    this.#sheet = this.#root.querySelector('.sheet');
    this.#toast = this.#root.querySelector('.mtf-toast');

    this.build();
    this.loadLocal();
    this.wire();
    this.highlightTodayIfNeeded();
    this.updateTimeLineIfNeeded();
    if(this.#weekOffset===0) setInterval(()=>this.updateTimeLineIfNeeded(), 60000);
  }

  LS_KEY(){ return `scheduleData_${this.#weekOffset}`; }

  build(){
    this.#tbody.innerHTML='';
    for(let h=this.#start; h<this.#end; h++){
      const hh=p2(h%24);
      const tr=document.createElement('tr');
      const td0=document.createElement('td'); td0.textContent=`${hh}:00`; td0.className='time';
      tr.appendChild(td0);
      for(let i=0;i<7;i++){
        const td=document.createElement('td'); td.dataset.weekcol=String(i+1); tr.appendChild(td);
      }
      this.#tbody.appendChild(tr);
    }
  }

  wire(){
    const closeAll=()=>{ this.#overlay.classList.remove('open'); this.#popup.classList.remove('open'); this.#sheet.style.display='none'; };
    this.#overlay.addEventListener('click', closeAll);
    this.#root.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeAll(); });

    const tb=this.#tbody;
    tb.addEventListener('pointerdown',(e)=>{
      const td=e.target.closest('td'); if(!td || td.cellIndex===0) return;
      this.#lpFired=false;
      this.#lpTimer=setTimeout(()=>{ this.#lpFired=true; this.openSheet(td); }, 600);
    }, {passive:true});
    ['pointerup','pointerleave','pointercancel'].forEach(ev=>{
      tb.addEventListener(ev,()=>{ clearTimeout(this.#lpTimer); this.#lpTimer=null; }, {passive:true});
    });
    tb.addEventListener('click',(e)=>{
      const td=e.target.closest('td'); if(!td || td.cellIndex===0) return;
      if(this.#lpFired){ this.#lpFired=false; return; }
      this.openPopup(td);
    });

    // popup buttons
    this.#popup.querySelector('.btn-save').addEventListener('click', ()=>this.saveFromPopup());
    this.#popup.querySelector('.btn-del').addEventListener('click', ()=>this.deleteFromPopup());

    // sheet buttons
    this.#sheet.querySelector('.s-close').addEventListener('click', ()=>{ this.#sheet.style.display='none'; });
    this.#sheet.querySelector('.s-profile').addEventListener('click', ()=>{
      const info = this.#currentCell?.dataset.info ? JSON.parse(this.#currentCell.dataset.info) : null;
      if(info?.memberId) window.location.href = `/member-registration.html?id=${info.memberId}`;
      else this.toast('회원ID가 없습니다');
    });
    this.#sheet.querySelector('.s-consume').addEventListener('click', ()=>this.consumeAction(-1,'consume'));
    this.#sheet.querySelector('.s-consume-undo').addEventListener('click', ()=>this.consumeAction(+1,'consume.undo'));
    this.#sheet.querySelector('.s-noshow').addEventListener('click', ()=>this.consumeAction(-1,'noshow'));
    this.#sheet.querySelector('.s-noshow-undo').addEventListener('click', ()=>this.consumeAction(+1,'noshow.undo'));
  }

  rowTime(td){ return td?.parentElement?.firstElementChild?.textContent || '00:00'; }
  cellBy(di,time){
    const rows=[...this.#tbody.querySelectorAll('tr')];
    const row = rows.find(r => (r.firstElementChild?.textContent||'')===time);
    return row ? row.children[di] : null;
  }
  renderCell(td, info){
    const labelFull = info.name || (info.memberId ? `[${info.memberId}]` : '—');
    const short = labelFull.slice(0,4);
    td.classList.add('filled');
    td.style.background = colorForName(labelFull);
    td.innerHTML = `<span class="label" title="${labelFull}">${short}</span>`;
    td.dataset.info = JSON.stringify(info);
  }

  /* ===== Local load/save ===== */
  loadLocal(){
    const data = JSON.parse(localStorage.getItem(this.LS_KEY())||'[]');
    const rows=[...this.#tbody.querySelectorAll('tr')];
    data.forEach(i=>{
      const row = rows.find(r => (r.firstElementChild?.textContent||'') === i.time);
      if(row){ const c=row.children[i.di]; if(c) this.renderCell(c, i); }
    });
  }
  saveLocalReplace(infos){
    let data = JSON.parse(localStorage.getItem(this.LS_KEY())||'[]');
    infos.forEach(i=>{
      data = data.filter(x=> !(x.time===i.time && x.di===i.di));
      data.push(i);
    });
    localStorage.setItem(this.LS_KEY(), JSON.stringify(data));
  }
  deleteLocal({time, days}){
    let arr = JSON.parse(localStorage.getItem(this.LS_KEY())||'[]');
    days.forEach(di=>{ arr = arr.filter(x => !(x.time===time && x.di===di)); });
    localStorage.setItem(this.LS_KEY(), JSON.stringify(arr));
  }

  /* ===== Popup ===== */
  openPopup(td){
    this.#currentCell = td;
    const di=+td.dataset.weekcol;
    const time=this.rowTime(td);
    const d = td.dataset.info ? JSON.parse(td.dataset.info) : {};
    this.#popup.querySelector('.slot-hint').textContent = ` ${'월화수목금토일'.charAt(di-1)} ${time}`;
    this.#popup.querySelector('.inp-name').value = d.name||'';
    this.#popup.querySelector('.inp-enrolled').value = d.enrolled||'';
    this.#popup.querySelector('.inp-cap').value = d.cap||'';
    this.#popup.querySelector('.inp-member').value = d.memberId||'';
    this.#overlay.classList.add('open');
    this.#popup.classList.add('open');
  }
  async saveFromPopup(){
    const td=this.#currentCell; if(!td) return;
    const di=+td.dataset.weekcol;
    const time=this.rowTime(td);
    const name=(this.#popup.querySelector('.inp-name').value||'').trim();
    const enrolled=+this.#popup.querySelector('.inp-enrolled').value||0;
    const cap=+this.#popup.querySelector('.inp-cap').value||0;
    const memberId=(this.#popup.querySelector('.inp-member').value||'').replace(/\D/g,'')||null;

    const info={ name, enrolled, cap, time, di, memberId };
    this.renderCell(td, info);
    this.saveLocalReplace([info]);

    try{
      await upsertScheduleByKey(info, this.#weekOffset);
      this.toast('저장 완료');
    }catch(e){ console.error(e); this.toast('저장 실패'); }
    this.#overlay.classList.remove('open'); this.#popup.classList.remove('open');
  }
  async deleteFromPopup(){
    const td=this.#currentCell; if(!td) return;
    const di=+td.dataset.weekcol;
    const time=this.rowTime(td);

    td.innerHTML=''; td.classList.remove('filled'); td.style.background=''; delete td.dataset.info;
    this.deleteLocal({time, days:[di]});
    try{
      await deleteScheduleByKey({di,time}, this.#weekOffset);
      this.toast('삭제 완료');
    }catch(e){ console.error(e); this.toast('삭제 실패'); }
    this.#overlay.classList.remove('open'); this.#popup.classList.remove('open');
  }

  /* ===== Sheet (long press) ===== */
  openSheet(td){
    this.#currentCell = td;
    const rect=td.getBoundingClientRect();
    const s=this.#sheet;
    s.style.left = Math.min(window.innerWidth-240, Math.max(8, rect.left))+'px';
    s.style.top  = Math.min(window.innerHeight-10, rect.bottom+6)+'px';
    s.style.display='block';
  }
  async consumeAction(delta, mode){
    const info = this.#currentCell?.dataset.info ? JSON.parse(this.#currentCell.dataset.info) : null;
    if(!info){ this.toast('먼저 저장하세요'); return; }
    const date = isoFromDi(info.di, this.#weekOffset);
    const schedId = `${date}-${info.di}-${info.time}`;
    const ok = await consumeAdjust({
      memberId: info.memberId || null,
      deltaRemain: delta,
      type: mode,
      sched: { id: schedId, date, start: info.time }
    });
    this.#sheet.style.display='none';
    this.toast(ok ? (mode.includes('undo')?'취소 완료':'처리 완료') : '처리 실패');
  }

  /* ===== Today highlight & timeline (week 0만) ===== */
  highlightTodayIfNeeded(){
    if(this.#weekOffset!==0) return;
    const di=new Date().getDay()||7;
    this.#tbody.querySelectorAll('tr').forEach(r=>{
      const c=r.children[di]; if(c) c.classList.add('today-col');
    });
  }
  updateTimeLineIfNeeded(){
    if(this.#weekOffset!==0) return;
    this.#tbody.querySelectorAll('.line').forEach(e=>e.remove());
    const now=new Date(); const dayIdx=(now.getDay()||7);
    const rows=[...this.#tbody.querySelectorAll('tr')];
    rows.forEach(r=>{
      const t=r.firstElementChild?.textContent||'00:00';
      const [hh,mm]=t.split(':').map(Number);
      const rowMin=hh*60+(mm||0);
      const nv=now.getHours()*60+now.getMinutes();
      if(nv>=rowMin && nv<rowMin+60){
        const pct=((nv-rowMin)/60)*100;
        const cell=r.children[dayIdx]; if(!cell) return;
        const line=document.createElement('div'); line.className='line'; line.style.top=`${pct}%`; cell.appendChild(line);
      }
    });
  }

  toast(msg){ const t=this.#toast; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1500); }
}
customElements.define('mtf-schedule', MtfSchedule);
</script>
