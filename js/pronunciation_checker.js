/* ================= Голосовий движок (Google TTS + системний голос) =================
   Використовує публічний endpoint translate.googleapis.com/translate_tts (неофіційний, без ключа).
   Працює в будь-якому браузері, що вміє відтворювати <audio>. Потрібен <meta name="referrer" content="no-referrer">.
   Якщо Google не відповідає після кількох спроб - автоматичний перехід на speechSynthesis. */
const GOOGLE_VOICES=[{id:'google-en-US',label:'Google (American English)',locale:'en-US'}];
const TTS_MAX_CHUNK=110, TTS_RETRY_DELAY=1000, TTS_STALL_MIN=8000, TTS_STALL_MAX=25000, TTS_MAX_RETRIES=6;

class VoiceEngine{
  constructor(){this.voiceId=GOOGLE_VOICES[0].id;this.rate=1;this.volume=1;this._audio=null;this._cancel=null;}
  setVoice(id){this.voiceId=id;}
  isGoogle(){return GOOGLE_VOICES.some(v=>v.id===this.voiceId);}
  split(text,max=TTS_MAX_CHUNK){
    let r=text.trim();if(r.length<=max)return r?[r]:[];
    const parts=[];
    while(r.length>max){
      let ix=-1;
      for(const d of['. ','! ','? ',', ',' ']){const k=r.lastIndexOf(d,max);if(k>0){ix=k+d.length;break}}
      if(ix===-1)ix=max;
      parts.push(r.slice(0,ix).trim());r=r.slice(ix).trim();
    }
    if(r)parts.push(r);return parts;
  }
  url(locale,text,retry=0){
    return 'https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl='+encodeURIComponent(locale)+
      '&q='+encodeURIComponent(text)+(retry?'&retry='+Date.now()+'-'+retry:'');
  }
  stallDelay(t){return Math.min(TTS_STALL_MAX,Math.max(TTS_STALL_MIN,Math.ceil(t.length/12*1000/this.rate+4000)));}
  /** speak(text,{lang:'en'|'de'|..., onEnd}) */
  speak(text,opts={}){
    const now=Date.now(),key=text+'|'+(opts.lang||'');
    if(key===this._lastKey&&now-this._lastAt<400)return; // подвійний клік/тап
    this._lastKey=key;this._lastAt=now;
    this.stop();
    const lang=opts.lang||null;
    if(this.isGoogle()){
      const v=GOOGLE_VOICES.find(x=>x.id===this.voiceId);
      this._google(text,lang||v.locale,opts.onEnd);
    }else this._system(text,lang?lang:'en-US',opts.onEnd);
  }
  _system(text,lang,onEnd){
    if(!('speechSynthesis' in window)){if(onEnd)onEnd();return}
    const u=new SpeechSynthesisUtterance(text);
    u.lang=lang;u.rate=this.rate;u.volume=this.volume;
    u.onend=()=>{if(onEnd)onEnd()};
    speechSynthesis.speak(u);
  }
  _google(text,locale,onEnd){
    const queue=this.split(text);
    if(!queue.length){if(onEnd)onEnd();return}
    const rate=this.rate>0?this.rate:1;
    const audio=new Audio();this._audio=audio;
    audio.referrerPolicy='no-referrer';audio.setAttribute('referrerpolicy','no-referrer');
    audio.preload='auto';audio.volume=this.volume;audio.defaultPlaybackRate=rate;audio.playbackRate=rate;
    let cancelled=false,timer=null,chunk=null,retryChunk=0,retryTotal=0,started=false;
    const clear=()=>{clearTimeout(timer);timer=null};
    this._cancel=()=>{cancelled=true;clear()};
    const finish=()=>{clear();this._audio=null;if(onEnd)onEnd()};
    const fallback=()=>{
      if(cancelled)return;clear();this._audio=null;
      console.log('Google TTS недоступний, використовую системний голос');
      this._system(text,locale,onEnd);
    };
    const load=()=>{
      started=false;audio.src=this.url(locale,chunk,retryChunk);audio.playbackRate=rate;
      clear();timer=setTimeout(retry,this.stallDelay(chunk));
      audio.play().then(()=>{audio.playbackRate=rate}).catch(()=>{clear();timer=setTimeout(retry,TTS_RETRY_DELAY)});
    };
    const retry=()=>{
      if(cancelled||!chunk||started)return; // вже грає - повторний запит дав би другий відтворений дубль
      if(++retryTotal>TTS_MAX_RETRIES){fallback();return}
      retryChunk++;audio.pause();load();
    };
    const next=()=>{
      if(cancelled)return;
      if(!queue.length){finish();return}
      chunk=queue.shift();retryChunk=0;load();
    };
    audio.addEventListener('ended',()=>{if(cancelled)return;clear();chunk=null;next()});
    audio.addEventListener('playing',()=>{started=true;clear()});
    audio.addEventListener('error',retry);
    next();
  }
  stop(){
    if('speechSynthesis' in window)speechSynthesis.cancel();
    if(this._cancel){this._cancel();this._cancel=null}
    if(this._audio){
      try{this._audio.pause();this._audio.removeAttribute('src');this._audio.load()}catch(e){}
      this._audio=null;
    }
  }
}
const voiceEngine=new VoiceEngine();

/* ================= Основний додаток ================= */
const $=s=>document.querySelector(s),AU=$('#au');
let S=null,peaks=null,stopAt=null,url=null,currentWordIndex=null,uploadStarted=false;
let ttsOnlyMode=false; // false - INFO (модальне вікно), true - TTS
const sc=p=>p.score_max, avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const SESSION_DB='pronunciation-checker-session';
const SESSION_STORE='uploads';
function openSessionDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(SESSION_DB,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(SESSION_STORE))request.result.createObjectStore(SESSION_STORE,{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function saveSession(data,blob){
  const db=await openSessionDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(SESSION_STORE,'readwrite');
    tx.objectStore(SESSION_STORE).put({id:'current',data,blob,savedAt:Date.now()});
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  }).finally(()=>db.close());
}
async function loadSession(){
  const db=await openSessionDb();
  try{
    return await new Promise((resolve,reject)=>{
      const request=db.transaction(SESSION_STORE,'readonly').objectStore(SESSION_STORE).get('current');
      request.onsuccess=()=>resolve(request.result||null);
      request.onerror=()=>reject(request.error);
    });
  }finally{db.close()}
}

const getWordStyle = v => {
  const p = Math.round(v * 100);
  if (p >= 85) return `background-color: var(--green); border-color: var(--green-border); color: var(--green-text);`;
  if (p >= 70) return `background-color: var(--good); border-color: var(--good-border); color: var(--good-text);`;
  if (p >= 40) return `background-color: var(--yellow); border-color: var(--yellow-border); color: var(--yellow-text);`;
  return `background-color: var(--red); border-color: var(--red-border); color: var(--red-text);`;
};
const pc=v=>Math.round(v*100)+'%';

/* ================= Таблиця фонем =================
   Модель facebook/wav2vec2-xlsr-53-espeak-cv-ft - багатомовна: її словник - це IPA-символи espeak
   для 50+ мов. Нижче: усі символи, що трапляються в англійській (espeak en-us/en-gb), та решта
   поширених IPA-символів словника з прикладами в інших мовах (поле l = мова для TTS).
   Формат: [символ, слово, виділені літери, мова(необов'язково)] */
const PHONEME_GROUPS=[
 {title:'Голосні (англійська)',items:[
  ['iː','sheep','ee'],['ɪ','ship','i'],['ʊ','good','oo'],['uː','shoot','oo'],
  ['ɛ','bed','e'],['ə','teacher','er'],['ɜː','bird','ir'],['ɔː','door','oor'],
  ['æ','cat','a'],['ʌ','up','u'],['ɑː','father','a'],['ɒ','on','o'],
  ['ɐ','about','a'],['ɚ','butter','er'],['ᵻ','rabbit','i'],['ɑːɹ','car','ar'],['ɔːɹ','more','or'],['ɛɹ','care','are']
 ]},
 {title:'Дифтонги (англійська)',items:[
  ['eɪ','face','a'],['aɪ','my','y'],['ɔɪ','boy','oy'],['oʊ','hello','o'],['əʊ','go','o'],
  ['aʊ','now','ow'],['ɪə','near','ear'],['ʊə','tour','our'],['eə','hair','air']
 ]},
 {title:'Приголосні (англійська)',items:[
  ['p','pen','p'],['b','bag','b'],['t','tea','t'],['d','dog','d'],
  ['tʃ','chair','ch'],['dʒ','jump','j'],['k','cat','c'],['ɡ','get','g'],
  ['f','fall','f'],['v','voice','v'],['θ','think','th'],['ð','this','th'],
  ['s','see','s'],['z','zoo','z'],['ʃ','shoe','sh'],['ʒ','television','s'],
  ['h','hat','h'],['m','man','m'],['n','now','n'],['ŋ','sing','ng'],
  ['l','leg','l'],['ɹ','red','r'],['j','yes','y'],['w','win','w'],
  ['ɾ','butter','tt'],['ʔ','uh-oh','-'],['ɫ','full','ll'],['ts','cats','ts'],['dz','adds','ds']
 ]},
 {title:'Інші мови',items:[
  ['y','kyllä','y','fi-FI'],['ʎ','aglio','gli','it-IT'],['ɭ','karl','rl','sv-SE'],['ɕ','środa','ś','pl-PL'],
  ['o','como','o','es-ES'],['oː','Brot','o','de-DE'],['a','casa','a','es-ES'],['eː','See','ee','de-DE'],
  ['ɨ','мы','ы','ru-RU'],['e','mes','e','es-ES'],['x','Bach','ch','de-DE'],['ʁ','rouge','r','fr-FR']
 ]}
];

// Нормалізація символів моделі до ключа таблиці
const normSym=s=>String(s||'').replace(/[͜͡]/g,'').replace(/:/g,'ː').replace(/g/g,'ɡ').replace(/[ˈˌ]/g,'').trim();
const PH_MAP=new Map();
PHONEME_GROUPS.forEach(g=>g.items.forEach(([s,w,t,l])=>{const k=normSym(s);if(!PH_MAP.has(k))PH_MAP.set(k,{s,w,t,l})}));
function lookupPhoneme(sym){
  const k=normSym(sym);
  if(PH_MAP.has(k))return PH_MAP.get(k);
  if(PH_MAP.has(k+'ː'))return PH_MAP.get(k+'ː');
  if(k.endsWith('ː')&&PH_MAP.has(k.slice(0,-1)))return PH_MAP.get(k.slice(0,-1));
  if(k==='r'&&PH_MAP.has('ɹ'))return PH_MAP.get('ɹ');
  return null;
}

function getHighlightedWordHTML(word,target){
  if(!target)return esc(word);
  const i=word.toLowerCase().indexOf(target.toLowerCase());
  if(i<0)return esc(word);
  return esc(word.slice(0,i))+`<span class="highlight-target">${esc(word.slice(i,i+target.length))}</span>`+esc(word.slice(i+target.length));
}

// Символи з завантаженого аналізу, яких немає в таблиці
let extraSymbols=[];
function collectExtraSymbols(){
  const set=new Set();
  if(S)S.words.forEach(w=>w.phonemes.forEach(p=>{
    [p.symbol,p.heard,...(p.alternatives||[]).map(a=>a.symbol)].forEach(x=>{if(x&&!lookupPhoneme(x))set.add(x)});
  }));
  extraSymbols=[...set];
}
function buildPhonemeGrid(){
  const cell=(s,w,t,l,key)=>`<div class="phoneme-grid-item" data-sym="${esc(key)}">
      <span class="grid-symbol">${esc(s)}</span>
      <span class="grid-word">${getHighlightedWordHTML(w,t)}</span></div>`;
  let h=PHONEME_GROUPS.map(g=>g.items.map(([s,w,t,l])=>cell(s,w,t,l,s)).join('')).join('')+
    extraSymbols.map(s=>`<div class="phoneme-grid-item no-example"><span class="grid-symbol">${esc(s)}</span><span class="grid-word">—</span></div>`).join('');
  $('#phonemesGridContainer').innerHTML=h;
}

/* ================= Мале вікно прикладу фонеми ================= */
let phExample=null;
function speakExample(){
  if(!phExample)return;
  voiceEngine.speak(phExample.w,{lang:phExample.l||null});
}
function openPhonemeExample(sym,kind){
  const e=lookupPhoneme(sym);
  $('#phExKind').textContent=kind||'Фонема';
  $('#phExSymbol').textContent=sym;
  if(e){
    phExample=e;
    $('#phExWord').innerHTML=getHighlightedWordHTML(e.w,e.t);
    $('#phExNote').textContent=e.l?'Приклад мовою: '+e.l.toUpperCase():(normSym(e.s)!==normSym(sym)?'Схожий звук: '+e.s:'');
    $('#phExPlay').style.display='';
    $('#phExampleOverlay').classList.add('active');
    speakExample();
  }else{
    phExample=null;
    $('#phExWord').textContent='—';
    $('#phExNote').textContent='Для цього символу немає прикладу в таблиці.';
    $('#phExPlay').style.display='none';
    $('#phExampleOverlay').classList.add('active');
  }
}
function closePhonemeExample(){$('#phExampleOverlay').classList.remove('active');voiceEngine.stop()}
$('#phExampleClose').onclick=closePhonemeExample;
$('#phExampleOverlay').onclick=e=>{if(e.target===$('#phExampleOverlay'))closePhonemeExample()};
$('#phExPlay').onclick=speakExample;

/* ================= Завантаження та відображення ================= */
async function loadFiles(fl){
  uploadStarted=true;
  fl=[...fl];
  const j=fl.find(f=>/\.json$/i.test(f.name)), a=fl.find(f=>!/\.json$/i.test(f.name));
  if(!j||!a)return alert('Оберіть разом JSON і аудіофайл');
  const data=JSON.parse(await j.text());
  await show({data, blob:a});
}

async function show(e,persist=true){
  if(persist){
    try{await saveSession(e.data,e.blob)}
    catch(error){console.error('Не вдалося зберегти завантажені дані:',error);alert('Файли завантажені, але браузер не зміг зберегти їх для наступного відвідування.')}
  }
  S=e.data;
  if(url)URL.revokeObjectURL(url);
  AU.src=url=URL.createObjectURL(e.blob);
  $('#drop').style.display='none';
  $('#view').hidden=false;
  collectExtraSymbols();buildPhonemeGrid();
  mkPeaks(e.blob);
  render();
}

async function mkPeaks(b){
  peaks=null;
  try{
    const ac=new(window.AudioContext||window.webkitAudioContext)(),buf=await ac.decodeAudioData(await b.arrayBuffer()),ch=buf.getChannelData(0),n=1000,st=Math.max(1,Math.floor(ch.length/n));
    peaks=[];
    for(let i=0;i<n;i++){let m=0;for(let k=i*st;k<(i+1)*st&&k<ch.length;k++)m=Math.max(m,Math.abs(ch[k]));peaks.push(m)}
    ac.close();
  }catch(e){}
  draw();
}

function draw(){
  if(!S)return;
  const c=$('#cv'),r=devicePixelRatio||1,W=c.width=c.clientWidth*r,H=c.height=110*r,g=c.getContext('2d'),D=S.duration;
  S.words.forEach(w=>{
    const v=avg(w.phonemes.map(sc));
    g.fillStyle=v>=0.7?'#86efac':v>=0.4?'#fde047':'#f87171';
    g.fillRect(w.segment_start/D*W,0,(w.segment_end-w.segment_start)/D*W,H);
  });
  if(peaks){
    const mx=Math.max(...peaks)||1;
    g.fillStyle='#64748b';
    peaks.forEach((v,i)=>{const h=v/mx*H*.85;g.fillRect(i/peaks.length*W,(H-h)/2,W/peaks.length+1,h)});
  }
  g.fillStyle='#f8fafc';
  g.font=12*r+'px sans-serif';
  S.words.forEach(w=>g.fillText(w.word,w.segment_start/D*W+3,14*r));
  g.fillStyle='#dc2626';
  g.fillRect(AU.currentTime/D*W,0,2*r,H);
}

function play(a,b){voiceEngine.stop();AU.currentTime=a;stopAt=b;AU.play()}
const playW=i=>play(S.words[i].segment_start,S.words[i].segment_end);

(function loop(){
  if(stopAt!=null&&AU.currentTime>=stopAt){AU.pause();stopAt=null}
  if(!AU.paused)draw();
  requestAnimationFrame(loop);
})();

$('#cv').onclick=e=>{
  const t=e.offsetX/$('#cv').clientWidth*S.duration,i=S.words.findIndex(w=>t>=w.segment_start&&t<=w.segment_end);
  i>=0?playW(i):play(t,null);
};

function playTts(text){
  AU.pause();stopAt=null;
  voiceEngine.speak(text);
}

function handleWordClick(i){
  if(ttsOnlyMode){
    playTts(S.words[i].word);
  } else {
    openModal(i);
  }
}

function render(){
  const tot=avg(S.words.map(w=>avg(w.phonemes.map(sc))));
  const tc=tot>=0.7?'#86efac':tot>=0.4?'#fde047':'#f87171';
  $('#info').innerHTML=`<div style="font-size:1.6rem;font-weight:700;text-align:center;color:${tc}">Загальна оцінка: ${pc(tot)}</div>`;
  $('#textModalBody').textContent=S.text||'';
  
  $('#words').innerHTML=S.words.map((w,i)=>{
    const ws=avg(w.phonemes.map(sc));
    return `<span class="word-token" style="${getWordStyle(ws)}" onclick="handleWordClick(${i})">${esc(w.word)}</span>`;
  }).join(' ');
}

// Логіка модального вікна деталей слова
const chip=(sym,cls,kind)=>`<button class="ph-chip ${cls||''}" data-sym="${esc(sym)}" data-kind="${esc(kind)}" title="Послухати приклад">${esc(sym)}</button>`;

function openModal(i){
  currentWordIndex=i;
  const w=S.words[i];
  const ws=avg(w.phonemes.map(sc));
  
  $('#mWordTitle').textContent=w.word;
  $('#mWordScoreContainer').innerHTML=`<div class="modal-score-badge" style="${getWordStyle(ws)}">${pc(ws)}</div>`;
  
  $('#mPhonemesList').innerHTML=w.phonemes.map(p=>{
    const s=sc(p);
    let alternativesText = '';
    if(p.alternatives && p.alternatives.length > 0){
      alternativesText = ` <span class="ph-meta">· Варіанти: ${p.alternatives.map(a=>`${chip(a.symbol,'alt','Модель почула')} ${pc(a.prob)}`).join(' ')}</span>`;
    }
    
    let correctionInfo = '';
    if(s < 0.7 && p.heard && p.heard !== p.symbol){
      correctionInfo = ` <span style="color:var(--red-text); font-weight:700;">(почула: ${chip(p.heard,'heard','Модель почула')})</span>`;
    }

    return `<div class="phoneme-item">
      ${chip(p.symbol,'','Очікувана фонема')} <span class="badge" style="${getWordStyle(s)}">${pc(s)}</span>${correctionInfo}${alternativesText}
    </div>`;
  }).join('');
  
  updateFavBtn();
  $('#modalOverlay').classList.add('active');
}

$('#mPhonemesList').onclick=e=>{
  const b=e.target.closest('.ph-chip');
  if(b)openPhonemeExample(b.dataset.sym,b.dataset.kind);
};

function closeModal(){
  $('#modalOverlay').classList.remove('active');
  currentWordIndex=null;
  voiceEngine.stop();
}

$('#modalClose').onclick=closeModal;
$('#modalOverlay').onclick=e=>{if(e.target===$('#modalOverlay'))closeModal()};

// Таблиця фонем
buildPhonemeGrid();
$('#phonemesGridContainer').onclick=e=>{
  const it=e.target.closest('.phoneme-grid-item[data-sym]');
  if(!it)return;
  const en=lookupPhoneme(it.dataset.sym);
  if(en)voiceEngine.speak(en.w,{lang:en.l||null});
};

// Модальне вікно з оригінальним текстом
$('#openTextModal').onclick=()=>$('#textModalOverlay').classList.add('active');
$('#textModalClose').onclick=()=>$('#textModalOverlay').classList.remove('active');
$('#textModalOverlay').onclick=e=>{if(e.target===$('#textModalOverlay'))$('#textModalOverlay').classList.remove('active')};

// Управління модальним вікном фонем
$('#openPhonemesModal').onclick = () => $('#phonemesModalOverlay').classList.add('active');
const closePhonemes=()=>{$('#phonemesModalOverlay').classList.remove('active');voiceEngine.stop()};
$('#phonemesModalClose').onclick = closePhonemes;
$('#phonemesModalOverlay').onclick = e => { if(e.target === $('#phonemesModalOverlay')) closePhonemes(); };

// Перемикач режимів INFO / TTS
$('#modeToggle').onclick=()=>{
  ttsOnlyMode=!ttsOnlyMode;
  if(ttsOnlyMode){
    $('#modeToggle').textContent='TTS';
    $('#modeToggle').classList.add('active');
  } else {
    $('#modeToggle').textContent='INFO';
    $('#modeToggle').classList.remove('active');
  }
};

// Кнопки в модальному вікні слова
$('#btnPlayAudio').onclick=()=>{
  if(currentWordIndex!==null){
    playW(currentWordIndex);
  }
};

$('#btnPlayTts').onclick=()=>{
  if(currentWordIndex!==null){
    playTts(S.words[currentWordIndex].word);
  }
};

/* ================= Обрані слова (localStorage) ================= */
const FAV_KEY='pronunciationChecker.favorites';
let favorites=[];
function loadFavorites(){
  try{
    const raw=localStorage.getItem(FAV_KEY);
    const arr=raw?JSON.parse(raw):[];
    favorites=Array.isArray(arr)?arr.filter(x=>typeof x==='string'&&x):[];
  }catch(e){favorites=[]}
}
function saveFavorites(){
  try{
    if(favorites.length)localStorage.setItem(FAV_KEY,JSON.stringify(favorites));
    else localStorage.removeItem(FAV_KEY);
  }catch(e){}
}
const favIndex=w=>favorites.findIndex(x=>x.toLowerCase()===String(w).toLowerCase());
function updateListBtn(){$('#openListBtn').hidden=favorites.length===0}
function updateFavBtn(){
  if(currentWordIndex===null)return;
  const on=favIndex(S.words[currentWordIndex].word)>=0,b=$('#favBtn');
  b.classList.toggle('active',on);
  b.setAttribute('aria-pressed',on);
  b.title=on?'Видалити з обраних':'Додати до обраних';
}
function renderFavList(){
  $('#favListBody').innerHTML=favorites.map(w=>`<div class="fav-item" role="button" tabindex="0" data-word="${esc(w)}">${esc(w)}</div>`).join('');
}
function closeListModal(){$('#listModalOverlay').classList.remove('active')}

$('#favBtn').onclick=()=>{
  if(currentWordIndex===null)return;
  const w=S.words[currentWordIndex].word,i=favIndex(w);
  if(i>=0)favorites.splice(i,1);else favorites.push(w);
  saveFavorites();updateFavBtn();updateListBtn();
};
$('#openListBtn').onclick=()=>{renderFavList();$('#listModalOverlay').classList.add('active')};
$('#listModalClose').onclick=closeListModal;
$('#listModalOverlay').onclick=e=>{if(e.target===$('#listModalOverlay'))closeListModal()};
$('#favListBody').onclick=e=>{
  const item=e.target.closest('.fav-item');
  if(item)voiceEngine.speak(item.dataset.word);
};
$('#favListBody').onkeydown=e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.matches('.fav-item')){
    e.preventDefault();
    voiceEngine.speak(e.target.dataset.word);
  }
};

$('#favCopy').onclick=async()=>{
  const text=favorites.join('\n');
  let ok=false;
  try{await navigator.clipboard.writeText(text);ok=true}catch(e){
    const ta=document.createElement('textarea');
    ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{ok=document.execCommand('copy')}catch(_){}
    ta.remove();
  }
  const b=$('#favCopy');
  if(ok){b.classList.add('copied');setTimeout(()=>b.classList.remove('copied'),1200)}
};
$('#favClear').onclick=()=>{
  favorites=[];
  saveFavorites();
  closeListModal();
  updateListBtn();
  updateFavBtn();
  $('#favListBody').innerHTML='';
};

loadFavorites();updateListBtn();

$('#f').onchange=e=>loadFiles(e.target.files);
document.body.ondragover=e=>e.preventDefault();
document.body.ondrop=e=>{e.preventDefault();loadFiles(e.dataTransfer.files)};
async function restoreSession(){
  try{
    const saved=await loadSession();
    if(!uploadStarted&&saved?.data&&saved?.blob instanceof Blob)await show({data:saved.data,blob:saved.blob},false);
  }catch(error){console.error('Не вдалося відновити завантажені дані:',error)}
}
restoreSession();

(()=>{
  const root=document.documentElement;
  const button=document.getElementById('theme-toggle');
  const updateThemeButton=()=>{
    const dark=root.dataset.theme!=='light';
    const next=dark?'light':'dark';
    button.setAttribute('aria-label',`Switch to ${next} theme`);
    button.title=`Switch to ${next} theme`;
    button.setAttribute('aria-pressed',String(!dark));
  };
  updateThemeButton();
  button.addEventListener('click',()=>{
    const next=root.dataset.theme==='dark'?'light':'dark';
    root.dataset.theme=next;
    try{localStorage.setItem('speaking-analyzer-theme',next)}catch{}
    updateThemeButton();
  });
})();
