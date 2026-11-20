const APP_RELEASE='0.1.12';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeLink = s => {try {const u=new URL(s);return u.protocol==='https:'?u.href:null}catch{return null}};
const plain = s => String(s || '').replace(/```[\s\S]*?```/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/(?:^|\n)\s*#{1,6}\s*/g,'').replace(/\s+/g,' ').trim();
function read(k,f){try{return JSON.parse(localStorage.getItem('ns:'+k))??f}catch{return f}}
function write(k,v){try{localStorage.setItem('ns:'+k,JSON.stringify(v));return true}catch{toast('裝置儲存空間不足，變更未保存');return false}}
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').hidden=true,4000)}
let state={view:'edition',edition:'morning',editionPicked:false,selected:'',topic:'全部',query:'',showTechnical:false,items:[],sources:[],collectedAt:null,loading:false,error:'',saved:read('saved',[]),read:read('read',[]),editions:read('editions',[]),published:[],publicationLoading:true,publicationError:'',nextBefore:null,archiveLoading:false,archiveError:'',refreshingEdition:false,editionRefreshStatus:''};
const NAV=[['edition','▤','新聞重點'],['inbox','◉','來源工作區'],['saved','♧','我的收藏'],['sources','◫','來源狀態'],['settings','⚙','設定']];
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function date(s,full=false){if(!s)return '日期未提供';let d=new Date(s);return Number.isNaN(+d)?'日期未提供':d.toLocaleString('zh-TW',{timeZone:'Asia/Taipei',...(full?{year:'numeric'}:{}),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}
function sourceDate(r){if(r.source_published_precision==='date'){return new Date(r.date).toLocaleDateString('zh-TW',{timeZone:r.date.slice(-6)==='-08:00'?'America/Los_Angeles':'Asia/Taipei',month:'2-digit',day:'2-digit'})+'（來源日期）'}return date(r.date)}
function available(){return [...state.published,...state.editions.filter(e=>!state.published.some(p=>p.id===e.id))].filter(e=>e.edition===state.edition&&Date.parse(e.published_at)<=Date.now()).sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))}
function current(){const editions=available();return editions.find(e=>e.id===state.selected)||editions[0]}
const isEdited = r=>r.status==='edited'&&Array.isArray(r.facts)&&r.speech_script;
function savedArticles(){
 if(!state.saved.length)return [];
 const articles=new Map();
 for(const issue of [...state.published].sort((a,b)=>Date.parse(a.published_at)-Date.parse(b.published_at))){
  for(const article of issue.articles)articles.set(article.id,article);
 }
 return state.saved.map(saved=>articles.get(saved.id)||saved);
}
function items(){let rows=state.view==='saved'?savedArticles():state.view==='inbox'?state.items.filter(r=>state.showTechnical||r.lane==='review'):current()?.articles||[];return rows.filter(r=>(state.topic==='全部'||r.topic===state.topic)&&(!state.query||[r.title,r.excerpt,r.product_context?.intro,r.source,...(r.facts||[])].join(' ').toLowerCase().includes(state.query.toLowerCase())))}
function go(v){state.view=v;state.topic='全部';state.query='';render();if((v==='inbox'||v==='sources')&&!state.sources.length&&!state.loading)loadSources()}
function publishedEditionFor(article,preferredId){
 const canonical=state.published.find(edition=>edition.articles.includes(article));
 if(canonical)return canonical;
 const contains=edition=>edition.articles.some(entry=>entry.id===article.id);
 const preferred=state.published.find(edition=>edition.id===preferredId);
 return preferred&&contains(preferred)?preferred:state.published.find(contains);
}
function editionVoiceControl(edition){
 if(cloud.loading)return {action:'neural-play',text:'載入播音設定中…',disabled:true};
 if(!edition)return {action:'neural-play',text:'▶ 聽本期重點',disabled:true};
 if(cloud.ready&&state.published.some(entry=>entry.id===edition.id))return {action:'neural-play',text:'▶ '+cloud.voice+' 播報本期',disabled:false};
 return {action:'speak',text:'▶ 裝置朗讀',disabled:false};
}
function editionVoiceButton(edition){
 const control=editionVoiceControl(edition);
 return '<button class="primary" data-action="'+control.action+'" '+(control.disabled?'disabled':'')+'>'+esc(control.text)+'</button>';
}
function articleVoiceButtons(article,i,primary=false){
 const voiceAvailable=cloud.ready&&publishedEditionFor(article,current()?.id);
 const leadingClass=primary?' class="primary"':'';
 const ai=voiceAvailable?'<button'+leadingClass+' data-neural="'+i+'">▷ '+esc(cloud.voice)+' 播報</button>':'';
 return ai+'<button'+(ai?'':leadingClass)+' data-speak="'+i+'">▷ 裝置朗讀</button>';
}
function voiceNote(){
 if(cloud.loading)return '';
 if(!cloud.ready)return cloud.error||'AI 語音尚未設定，可使用裝置朗讀。';
 return 'OpenAI 合成語音，按播放後逐則產生，整期播報會預先準備下一則。';
}
function render(){
 const control=editionVoiceControl(current());
 document.querySelectorAll('[data-hero-audio]').forEach(button=>{
  button.dataset.action=control.action;button.textContent=control.text;button.disabled=control.disabled;
 });
 document.querySelectorAll('[data-hero-audio-note]').forEach(label=>{label.textContent=voiceNote()});
 for(let id of ['#nav','#mobile-nav'])$(id).innerHTML=NAV.map(([v,i,t])=>'<button class="'+(id==='#nav'?'nav ':'')+(state.view===v?'active':'')+'" data-view="'+v+'"><b>'+i+'</b>'+t+'</button>').join('');
 $('#date').textContent=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date())+' · TAIPEI';
 $('#title').innerHTML=({edition:'今天，值得知道<span>。</span>',inbox:'新聞之前，先看來源<span>。</span>',saved:'留給之後的自己<span>。</span>',sources:'每一則，都有來處<span>。</span>',settings:'你的閱讀節奏<span>。</span>'})[state.view];
 $('#subtitle').textContent=({edition:'先看發生什麼，再理解為何重要。',inbox:'這裡是待選稿素材；原文與例行版本紀錄不會自動進入新聞重點。',saved:'收藏與已讀保存在這台裝置，可於設定匯出備份。',sources:'來源可擷取不等於內容已完成查證。',settings:'文字與口播稿分開編寫，保留來源和限制。'})[state.view];
 $('#editions').hidden=state.view!=='edition';
 document.querySelectorAll('[data-edition]').forEach(b=>b.classList.toggle('on',b.dataset.edition===state.edition));
 if(state.view==='settings'){renderSettings();return}
 if(state.view==='sources'){renderSources();return}
 let ed=current();let top='';
 if(state.view==='edition'){
  const older=ed&&ed.date!==today();
  top='<div class="ribbon"><span class="symbol">'+(state.edition==='morning'?'☀':'☾')+'</span><div><strong>'+(ed?esc(ed.date)+' '+(state.edition==='morning'?'晨報':'晚報')+' · '+esc(ed.label||'編輯版'):(state.publicationLoading?'讀取編輯版…':'本期尚未發布'))+'</strong><p>'+(ed?'發布 '+esc(date(ed.published_at,true))+' · 截止 '+esc(date(ed.cutoff_at,true))+'（台北）':'不以原始候選填充新聞。')+'</p></div></div>';
  top+='<div class="toolbar edition-refresh"><button class="secondary" data-action="refresh-edition" aria-describedby="edition-refresh-status" '+(state.refreshingEdition||state.publicationLoading||state.archiveLoading?'disabled':'')+'>'+(state.refreshingEdition?'更新中…':'更新新聞')+'</button><span id="edition-refresh-status" class="label" role="status" aria-live="polite">'+esc(state.editionRefreshStatus)+'</span></div>';
  if(ed){top+='<p class="footer-note">'+(older?(state.selected&&available()[0]?.id!==ed.id?'正在閱讀歷史期刊。<br>':'目前顯示本版最近一期。<br>'):'')+esc(ed.coverage_note||'')+'<br>各期保留原始發布日期。</p><div class="player">'+editionVoiceButton(ed)+(editionVoiceControl(ed).action==='neural-play'?'<button class="secondary" data-action="speak">▶ 裝置朗讀</button>':'')+'<button data-action="pause">暫停／繼續</button><button data-action="stop">停止</button><span class="player-label" data-player-status></span><label>倍速 <select data-speed aria-label="朗讀倍速">'+speedOptions()+'</select></label></div>'}
  if(available().length>1)top+='<select class="archive-select" id="edition-archive" aria-label="選擇期刊">'+available().map(e=>'<option value="'+esc(e.id)+'" '+(e.id===ed?.id?'selected':'')+'>'+esc(e.date)+' · '+esc(e.label||'編輯版')+'</option>').join('')+'</select>';
  if(state.nextBefore){
   const label=state.archiveLoading?'載入中…':state.archiveError?'重試載入較早期刊':'載入較早期刊';
   top+='<button class="secondary" data-action="older-editions" '+(state.archiveLoading||state.refreshingEdition?'disabled':'')+'>'+label+'</button>';
  }
  if(state.archiveError)top+='<p class="notice" role="status">'+esc(state.archiveError)+'</p>';
  if(state.publicationError)top+='<div class="notice">'+esc(state.publicationError)+'<button data-action="retry-editions" '+(state.refreshingEdition?'disabled':'')+'>重新載入</button></div>';
 }
 if(state.view==='inbox')top+=sourceRefreshButton()+'<div class="notice">預設只列待評估的新聞來源。例行 SDK／軟體版本更新已移至技術參考；尚未編輯的素材不提供新聞朗讀。</div><label class="source-toggle"><input type="checkbox" id="technical" '+(state.showTechnical?'checked':'')+'> 顯示技術參考與排除素材（'+state.items.filter(r=>r.lane!=='review').length+'）</label>';
 $('#body').innerHTML=top+'<div class="toolbar"><div class="tabs">'+['全部','AI','IT','資安','環境','綜合'].map(t=>'<button data-topic="'+t+'" class="'+(state.topic===t?'active':'')+'">'+t+'</button>').join('')+'</div></div><input class="search" type="search" placeholder="搜尋標題、重點、來源…" aria-label="搜尋新聞" value="'+esc(state.query)+'"><div class="list-head"><span>'+(state.view==='inbox'?'EDITORIAL WORKSPACE':state.view==='saved'?'YOUR READING LIST':'HUMAN-READABLE BRIEFING')+'</span><span id="total"></span></div><div id="list"></div><div class="footer-note">事實附來源 · 判讀獨立標記 · 不為篇數湊稿</div>';
 drawList();updatePlayer();
}
function productIntro(article,includeSource=false){
 const context=article.product_context;
 if(typeof context?.intro!=='string'||!context.intro.trim())return '';
 const url=includeSource&&safeLink(context.source_url);
 const link=url?'<small><a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(context.source_label||'官方產品說明')+' ↗</a></small>':'';
 return '<p class="product-intro">'+esc(context.intro)+(link?' '+link:'')+'</p>';
}
function drawList(){
 let rows=items();$('#total').textContent=rows.length+' 則'+(state.view==='inbox'?'素材':'重點');
 if((state.loading&&state.view==='inbox')||(state.publicationLoading&&state.view==='edition'&&!current())){$('#list').innerHTML='<div class="loading" role="status">正在讀取內容…</div>';return}
 if(state.error&&state.view==='inbox'){$('#list').innerHTML='<div class="notice">'+esc(state.error)+'</div>';return}
 if(!rows.length){$('#list').innerHTML='<div class="empty"><div class="empty-icon">▤</div><h2>'+(state.query||state.topic!=='全部'?'沒有符合條件的重點':state.view==='saved'?'把值得讀的事，留在這裡':state.view==='inbox'?'目前沒有可用素材':'這一期尚未發布')+'</h2><p>'+(state.query||state.topic!=='全部'?'試試其他關鍵字或分類。':state.view==='saved'?'點選新聞旁的收藏符號，稍後繼續閱讀。':state.view==='inbox'?'可重新擷取或檢查來源狀態。':'正式重點需經過選稿、繁中編輯與來源核對；來源素材不會自動當成新聞。')+'</p>'+(state.view==='edition'?'<button class="primary" data-edition="'+(state.edition==='morning'?'evening':'morning')+'">查看另一版</button>':'')+'</div>';return}
 $('#list').innerHTML=rows.map((r,i)=>{const edited=isEdited(r);const technical=r.lane==='technical';const title=technical?r.source+' 技術參考：'+r.title:r.title;return '<article class="article '+(state.read.includes(r.id)?'read':'')+'"><div class="meta"><span class="badge">'+esc(r.topic)+'</span><span class="badge '+(edited?'':'pending')+'">'+(edited?(r.verification_status==='corroborated'?'多來源核對':r.verification_status==='attributed_report'?'單一來源報導':'已核對官方聲明'):technical?'技術參考':r.lane==='excluded'?'已排除':'待選稿')+'</span><span>'+esc(sourceDate(r))+'</span></div><h2><button class="headline" data-open="'+i+'">'+esc(title)+'</button></h2><button class="bookmark '+(state.saved.some(s=>s.id===r.id)?'saved':'')+'" aria-label="'+(state.saved.some(s=>s.id===r.id)?'取消收藏':'收藏')+'" data-save="'+i+'">'+(state.saved.some(s=>s.id===r.id)?'▣':'♧')+'</button>'+(edited?productIntro(r)+'<p class="excerpt" style="display:block">'+esc(r.excerpt)+'</p><ul class="brief-facts">'+r.facts.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul><div class="why"><b>為何重要 · AI 判讀</b>'+esc(r.analysis)+'</div><p class="uncertainty">'+esc(r.uncertainty)+'</p>':'<p class="sub">'+esc(r.reason||'原始來源素材，尚未整理成新聞摘要。')+'</p>')+'<div class="bottom"><span>'+esc(r.source)+'</span><div>'+(edited?articleVoiceButtons(r,i):'')+'<button data-open="'+i+'">'+(state.read.includes(r.id)?'已讀 · ':'')+(edited?'查閱來源':'檢視素材')+' ↗</button></div></div></article>'}).join('');
}
function sourceRefreshButton(){
 const status = state.collectedAt ? '最近擷取 '+esc(date(state.collectedAt,true))+'（台北）' : '';
 return '<div class="toolbar"><button class="secondary" data-action="refresh" '+(state.loading?'disabled':'')+'>'+(state.loading?'擷取中…':'重新擷取來源')+'</button><span class="label" role="status">'+status+'</span></div>';
}
function renderSources(){
 $('#body').innerHTML=sourceRefreshButton()+(state.error?'<div class="notice">'+esc(state.error)+'</div>':'')+state.sources.map(s=>'<div class="source-row"><span class="badge">'+esc(s.topic)+'</span> <a href="'+esc(safeLink(s.home)||'#')+'" target="_blank" rel="noopener noreferrer">'+esc(s.source)+' ↗</a><small>'+(s.ok?'● '+esc(s.candidates ?? 0)+' 則候選 · '+esc(s.unique_events ?? 0)+' 個事件':'○ 擷取失敗：'+esc(s.error || '已達本輪上限'))+' · '+date(s.checked_at)+'（台北）</small></div>').join('')+'<p class="footer-note">重新擷取會更新來源工作區的待選稿素材。晨晚報在編輯與查證完成後另行發布。</p>';
}
function speedOptions(){return [0.8,1,1.25,1.5].map(n=>'<option value="'+n+'" '+(player.speed===n?'selected':'')+'>'+n+'×</option>').join('')}
function renderSettings(){ $('#body').innerHTML='<div class="settings"><div class="ribbon"><span class="symbol">▤</span><div><strong>繁中編輯版已開放</strong><p>先選稿、寫重點、核對來源，再編寫適合聆聽的口播稿。</p></div></div><h2>AI 語音播報</h2><p>'+esc(voiceNote())+'</p>'+editionVoiceButton(current())+'<p>產生音訊會使用網站金鑰所屬專案的 OpenAI API 額度。同一分頁會暫存最近播放的音訊，仍在暫存內時，重播可直接播放。</p><h2>裝置語音（試用）</h2><p>已發布新聞可直接播放，不需要先開啟文章或逐則確認。</p><p>首頁選擇期刊後可聽整期，新聞卡片可聽單則。只讀編輯過的口播稿，不照念 Markdown、網址或 commit 編號。</p><div class="player"><button class="secondary" data-action="speak">▶ 用裝置朗讀本期</button><button data-action="pause">暫停／繼續</button><button data-action="stop">停止</button><label>倍速 <select data-speed>'+speedOptions()+'</select></label><span class="player-label" data-player-status></span></div><p>使用裝置內建語音。背景、鎖屏及精準續播仍須真機驗證；目前沒有 MP3。會記住每則口播的句段位置，下次按播放可從該段開始。</p><h2>裝置資料</h2><p>收藏與已讀儲存在這個瀏覽器，清除網站資料後會移除；編輯版新聞由伺服器提供，不需自行匯入。</p><button class="secondary" data-action="export">匯出個人備份</button><p>還原個人備份（會取代本機收藏與閱讀狀態）</p><input type="file" id="restore" accept="application/json,.json"><details><summary>進階：匯入自行編輯的期刊</summary><p>匯入須有繁中標題、三至五項事實與逐項證據、AI 判讀、限制、口播稿。格式檢查不代表獨立查證。</p><button class="secondary" data-action="template">下載本期作為格式參考</button><input type="file" id="import" accept="application/json,.json"></details><h2>在 iPhone 加入主畫面</h2><p>Safari → 分享 → 加入主畫面。私人網站需要登入；目前不提供離線新聞。</p><h2>更新方式</h2><p>目前頁面版本：'+APP_RELEASE+' · <button class="secondary" data-action="reload-app">取得最新頁面</button></p><p>目前是編輯試刊，每份保留實際出版時間與資料截止時間。更新程式支援手動執行或由排程呼叫。目前尚未啟用每日定時觸發。</p></div>';updatePlayer() }
async function loadSources(){if(state.loading)return;state.loading=true;state.error='';render();try{const r=await fetch('/api/inbox');if(!r.ok)throw Error('服務回應 '+r.status);const data=await r.json();state.items=data.items;state.sources=data.sources;state.collectedAt=data.collected_at}catch(e){state.error='無法取得來源：'+e.message}finally{state.loading=false;render()}}
async function fetchEditionPage(before){
 const url='/api/editions'+(before?'?before='+encodeURIComponent(before):'');
 const response=await fetch(url,{cache:'no-store'});
 if(!response.ok)throw Error('服務回應 '+response.status);
 const page=await response.json();
 if(!Array.isArray(page.editions)||page.editions.some(edition=>!edition?.id||!Array.isArray(edition.articles)))throw Error('期刊資料格式錯誤');
 const cursor=page.next_before;
 if(cursor!=null&&(!/^\d{4}-\d{2}-\d{2}$/.test(cursor)||(before&&cursor>=before)))throw Error('歷史期刊分頁日期無效');
 return page;
}
async function loadEditions(){
 if(state.refreshingEdition)return;
 state.publicationLoading=true;state.publicationError='';
 try{
  const page=await fetchEditionPage();
  state.published=page.editions;state.nextBefore=page.next_before||null;
  if(page.archive_status==='unavailable')state.publicationError='目前無法讀取期刊庫，暫時顯示隨站保存的期刊。';
  if(!state.editionPicked){
   const latest=page.editions.filter(e=>Date.parse(e.published_at)<=Date.now()).sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
   if(latest)state.edition=latest.edition;
  }
 }catch(error){state.publicationError='編輯版讀取失敗：'+error.message}
 finally{state.publicationLoading=false;render()}
}
async function refreshEdition(){
 if(state.refreshingEdition||state.publicationLoading||state.archiveLoading)return;
 state.refreshingEdition=true;state.editionRefreshStatus='正在檢查最新一期並更新新聞…';render();
 try{
  const response=await fetch('/api/editions/refresh',{method:'POST',credentials:'same-origin',cache:'no-store'});
  const result=await response.json().catch(()=>({}));
  if(!response.ok){
   const known={sources_unavailable:'目前無法取得新聞來源，請稍後再更新。',edition_store_unavailable:'目前無法連上期刊庫，請稍後重試。'};
   throw Error(known[result.error]||(response.status===403?'目前沒有更新這個網站的權限。':'更新服務回應 '+response.status+'。'));
  }
  const slot=result.edition==='morning'?'晨報':result.edition==='evening'?'晚報':'';
  const label=[result.date,slot].filter(Boolean).join(' ');
  if(result.status==='published'||result.status==='already_published'){
   const page=await fetchEditionPage();
   if(page.archive_status==='unavailable')throw Error('目前無法讀取最新期刊，請稍後重試。');
   const matching=page.editions.filter(e=>Date.parse(e.published_at)<=Date.now()&&(
    result.edition_id?e.id===result.edition_id:e.date===result.date&&e.edition===result.edition
   ));
   const issue=matching.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
   if(!issue)throw Error('期刊庫尚未回傳這一期，請稍後再更新。');
   const previousId=current()?.id;
   const pageIds=new Set(page.editions.map(e=>e.id));
   if(!state.published.some(e=>pageIds.has(e.id)))state.nextBefore=page.next_before||null;
   state.published=[...page.editions,...state.published.filter(e=>!pageIds.has(e.id))];
   state.publicationError='';
   if(previousId!==issue.id){
    stopSpeech();stopNeuralPlayback();state.topic='全部';state.query='';
   }
   state.edition=issue.edition;state.selected=issue.id;state.editionPicked=true;
   state.editionRefreshStatus=label+(result.status==='published'?' 已發布':' 已是最新一期')+'，共 '+issue.articles.length+' 則。';
  }else if(result.status==='no_qualified_stories'){
   const count=Number.isInteger(result.unique_events)?'共收集 '+result.unique_events+' 則候選事件。':'';
   const pending=Number.isInteger(result.pending_review)&&result.pending_review>0?result.pending_review+' 則待核對。':'';
   const unchecked=result.unchecked_events>0?'另有 '+result.unchecked_events+' 則未能完成原文查核。':'';
   state.editionRefreshStatus=count+label+' 尚無符合出版條件的新聞。'+pending+unchecked;
  }else if(result.status==='sources_unavailable'){
   state.editionRefreshStatus='目前無法取得新聞來源，請稍後再更新。';
  }else if(result.status==='in_progress'){
   state.editionRefreshStatus=label+' 正在更新中，稍後可再按更新新聞查看結果。';
  }else throw Error('更新服務傳回未知狀態，請稍後重試。');
 }catch(error){state.editionRefreshStatus='更新未完成。'+error.message}
 finally{state.refreshingEdition=false;render()}
}
async function loadOlderEditions(){
 if(state.publicationLoading||state.archiveLoading||state.refreshingEdition||!state.nextBefore)return;
 const before=state.nextBefore;state.archiveLoading=true;state.archiveError='';render();
 try{
  const page=await fetchEditionPage(before);
  const known=new Set(state.published.map(edition=>edition.id));
  for(const edition of page.editions){
   if(known.has(edition.id))continue;
   state.published.push(edition);known.add(edition.id);
  }
  state.nextBefore=page.next_before||null;
 }catch(error){state.archiveError='較早期刊讀取失敗：'+error.message}
 finally{state.archiveLoading=false;render()}
}
function openItem(i){const r=items()[i];if(!r)return;const edited=isEdited(r);const next=[...new Set([...state.read,r.id])];if(write('read',next))state.read=next;
 $('#detail').innerHTML='<button class="close" data-action="close" aria-label="關閉">×</button><span class="badge">'+esc(r.topic)+'</span><h2>'+esc(r.title)+'</h2><div class="meta">'+esc(r.source)+' · '+esc(sourceDate(r))+'</div>'+(edited?productIntro(r,true)+'<p>'+esc(r.excerpt)+'</p><h3>發生什麼</h3><ol>'+r.facts.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ol><div class="why"><b>為何重要 · AI 判讀</b>'+esc(r.analysis)+'</div><h3>仍須留意</h3><p>'+esc(r.uncertainty)+'</p>'+articleVoiceButtons(r,i,true)+'<h3>逐項來源核對</h3>'+r.evidence.map((e,j)=>'<div class="evidence-row"><strong>事實 '+(e.fact?r.facts.indexOf(e.fact)+1:j+1)+'</strong> · '+esc(e.support)+'<br><a href="'+esc(safeLink(e.url)||'#')+'" target="_blank" rel="noopener noreferrer">'+esc(new URL(e.url).hostname)+' ↗</a></div>').join('')+'<p class="label">'+(r.verification_status==='official_statement'?'核對官方公告的內容，沒有把廠商或政府宣稱當成獨立證實。':r.verification_status==='attributed_report'?'已查閱具名媒體原文，事實仍以該報導歸屬為準。':'已比對多個來源；仍須留意來源是否相互獨立。')+'<br>核對時間：'+date(r.verified_at,true)+'（台北）</p><details><summary>為何入選／更正紀錄</summary><p>'+esc(r.selection_reason)+'</p><p>'+(r.correction_history?.length?esc(JSON.stringify(r.correction_history)):'尚無更正紀錄。')+'</p></details>':'<p class="notice">'+esc(r.reason||'這是尚未編輯的原始素材，不是正式新聞。')+'</p><p>請先查閱原始來源。此素材尚未有繁中摘要與口播稿。</p><details><summary>展開原始摘錄（未編輯）</summary><div class="raw">'+esc(r.excerpt||'來源未提供摘錄。')+'</div></details>')+'<h3>原始來源</h3>'+[...new Set(r.source_urls||r.evidence_candidates?.map(e=>e.url)||[r.url])].filter(safeLink).map(u=>'<a href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">'+esc(new URL(u).hostname)+' ↗</a><br>').join('');
 $('#detail').showModal();drawList();
}
const cloud={loading:true,ready:false,voice:'',error:'',active:false,pending:false,paused:false,mode:'single',next:null,articles:[],skipped:[],editionId:'',index:0,token:0,objectUrl:null,expires:0,cleanupTimer:null,controller:null,mediaSession:null,mediaActions:[]};
async function loadNeuralStatus(){
 try{
  const response=await fetch('/api/audio/status',{cache:'no-store'});
  if(!response.ok)throw Error();
  const status=await response.json();
  const voice=typeof status.voice==='string'?status.voice.trim():'';
  cloud.voice=voice.charAt(0).toUpperCase()+voice.slice(1);
  cloud.ready=status.ready===true&&!!voice;
 }catch{cloud.error='無法取得 AI 播音設定，可使用裝置朗讀。'}
 finally{cloud.loading=false;render()}
}
function detachNeuralTrack(){
 const node=$('#neural-audio');
 node.onended=node.onerror=node.ontimeupdate=node.onloadedmetadata=node.onpause=node.onplaying=null;
 clearTimeout(cloud.cleanupTimer);cloud.cleanupTimer=null;
 if(!cloud.objectUrl)return;
 const url=cloud.objectUrl;cloud.objectUrl=null;cloud.expires=0;
 node.pause();node.removeAttribute('src');node.load();URL.revokeObjectURL(url);
}
function releaseNeuralMediaSession(){
 const session=cloud.mediaSession;
 if(!session)return;
 cloud.mediaSession=null;
 for(const action of cloud.mediaActions){
  try{session.setActionHandler(action,null)}catch{}
 }
 cloud.mediaActions=[];
 try{session.playbackState='none'}catch{}
 try{session.metadata=null}catch{}
 try{session.setPositionState?.()}catch{}
}
function stopNeuralPlayback(message=''){
 cloud.token++;cloud.active=false;cloud.pending=false;cloud.paused=false;cloud.next=null;
 cloud.controller?.abort();cloud.controller=null;
 detachNeuralTrack();releaseNeuralMediaSession();
 cloud.articles=[];cloud.skipped=[];cloud.editionId='';cloud.index=0;
 $('#neural-audio').hidden=true;$('#neural-player').hidden=!message;
 if(message)$('#neural-state').textContent=message;
 updatePlayer();
}
function setNeuralMediaSession(token,node,title){
 const session=navigator.mediaSession;
 if(!session)return;
 if(!cloud.mediaSession){
  cloud.mediaSession=session;
  const handlers={
   play:()=>setNeuralPaused(false),
   pause:()=>setNeuralPaused(true),
   stop:()=>stopNeuralPlayback(),
   seekto:event=>{if(cloud.objectUrl&&Number.isFinite(event.seekTime))node.currentTime=event.seekTime},
  };
  for(const [action,handler] of Object.entries(handlers)){
   try{
    session.setActionHandler(action,event=>{if(token===cloud.token&&cloud.active)handler(event)});
    cloud.mediaActions.push(action);
   }catch{}
  }
 }
 try{
  if(typeof MediaMetadata!=='undefined')session.metadata=new MediaMetadata({title,artist:'News Station · '+cloud.voice+' 合成語音'});
 }catch{}
 try{session.playbackState='playing'}catch{}
}
async function startNeuralPlayback(articles,editionId,mode='single'){
 if(!cloud.ready)return toast('公司 AI 語音尚未接通，需要先設定後端 API 金鑰');
 if(cloud.pending)return toast('音訊正在準備中，請稍候');
 const queue=articles.filter(isEdited);
 if(!queue.length)return toast('沒有可播放的口播稿');
 stopSpeech();stopNeuralPlayback();cloud.active=true;cloud.controller=new AbortController();cloud.mode=mode;cloud.articles=queue;cloud.editionId=editionId;
 await playNeuralTrack(cloud.token);
}
// Blobs live only in this tab. Map order tracks the most recently played clips.
const recentAudio=new Map();
const RECENT_AUDIO_LIMIT=24*1024*1024;
function rememberAudioClip(key,clip){
 recentAudio.delete(key);
 if(clip.blob.size>RECENT_AUDIO_LIMIT||clip.expires<=Date.now())return;
 recentAudio.set(key,clip);
 let bytes=0;
 for(const {blob} of recentAudio.values())bytes+=blob.size;
 for(const [oldKey,oldClip] of recentAudio){
  if(bytes<=RECENT_AUDIO_LIMIT&&recentAudio.size<=64)break;
  recentAudio.delete(oldKey);bytes-=oldClip.blob.size;
 }
}
async function fetchAudioClip(requestBody,signal){
  const response=await fetch('/api/audio',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody)});
  if(!response.ok){const problem=await response.json().catch(()=>({}));const messages={not_configured:'網站尚未設定 OpenAI API 金鑰',provider_auth_failed:'OpenAI 拒絕了網站的 API 金鑰，請檢查金鑰狀態',provider_voice_unconfirmed:'OpenAI 未確認指定音色，請稍後再播',provider_quota_exceeded:'OpenAI API 額度或速率不足',provider_rate_limited:'OpenAI API 暫時達到速率上限，請稍後再播',provider_model_unavailable:'網站的 API 專案目前無法使用這個語音模型',model_not_found:'網站的 API 專案目前無法使用這個語音模型',provider_connection_failed:'網站暫時無法連上 OpenAI 語音服務',narration_mismatch:'生成語音與口播稿不一致，已停止播放，請重新檢查',provider_timeout:'語音生成逾時，請稍後再試',article_not_published:'這則稿件沒有伺服器語音版本'};const error=Error(messages[problem.error]||'AI 語音生成失敗，請稍後重試');error.code=problem.error;throw error}
  const responseVoice=response.headers.get('X-Audio-Voice');
  if(responseVoice?.toLowerCase()!==cloud.voice.toLowerCase())throw Error('回傳的音色與指定音色不符，請重新整理後再播');
  const blob=await response.blob();
  if(!blob.size||!blob.type.startsWith('audio/'))throw Error('收到的資料無法播放，請再試一次');
  const expires=Number(response.headers.get('X-Audio-Expires-At'));if(!Number.isFinite(expires)||expires<=Date.now())throw Error('音訊已到期，請重新生成');
  return {blob,expires};
}
function narrationTrack(index){
 const selected=cloud.articles[index];
 const edition=publishedEditionFor(selected,cloud.editionId);
 if(!edition)throw Error('這則是本機內容，尚未加入伺服器的語音稿');
 const ordinal=edition.articles.findIndex(article=>article.id===selected.id);
 const article=edition.articles[ordinal];
 const body={edition_id:edition.id,article_id:article.id};
 const format=[APP_RELEASE,cloud.mode];
 if(cloud.mode==='edition'){
  body.mode='edition';
  format.push(edition.date,edition.edition,ordinal,edition.articles.length);
 }
 const key=JSON.stringify([format,edition.id,article.id,article.speech_script,article.verified_at,article.correction_history,cloud.voice]);
 return {key,body,format};
}
async function loadTrackClip(track,signal){
 for(const [key,clip] of recentAudio){if(clip.expires<=Date.now())recentAudio.delete(key)}
 const cached=recentAudio.get(track.key);
 const clip=cached||await fetchAudioClip(track.body,signal);
 if(!signal.aborted)rememberAudioClip(track.key,clip);
 return {clip,cached:!!cached};
}
function prepareFollowingTrack(token){
 const index=cloud.index+1;
 if(token!==cloud.token||!cloud.active||cloud.paused||cloud.mode!=='edition'||index>=cloud.articles.length||cloud.next)return;
 // Resolve failures into the slot so a failed preload is handled only at its turn.
 try{
  const track=narrationTrack(index);
  const result=loadTrackClip(track,cloud.controller.signal).catch(error=>({error}));
  cloud.next={key:track.key,result};
 }catch{cloud.next=null}
}
function setNeuralPaused(paused){
 const node=$('#neural-audio');
 if(cloud.pending||!cloud.objectUrl){
  if(cloud.paused===paused)return;
  cloud.paused=paused;
  $('#neural-state').textContent=paused?'已暫停，按暫停／繼續可續播。':'正在準備音訊…';
  if(cloud.mediaSession){try{cloud.mediaSession.playbackState=paused?'paused':'playing'}catch{}}
  if(!paused&&!cloud.pending)playNeuralTrack(cloud.token);
 }else if(paused){
  if(!node.paused)node.pause();
 }else if(node.paused){
  const url=cloud.objectUrl;
  node.play().catch(()=>{if(cloud.active&&cloud.objectUrl===url)toast('請按播放器的播放鍵')});
 }
 updatePlayer();
}
function toggleNeuralPause(){
 const paused=cloud.pending||!cloud.objectUrl?cloud.paused:$('#neural-audio').paused;
 setNeuralPaused(!paused);
}
async function playNeuralTrack(token){
 if(token!==cloud.token||!cloud.active)return;
 const index=cloud.index;
 const article=cloud.articles[index];
 if(!article){
  const skipped=cloud.skipped;
  const message=skipped.length?'已播完 '+(cloud.articles.length-skipped.length)+' 則。'+skipped.length+' 則因口播與稿件不符略過：'+skipped.join('、'):'播報完畢';
  stopNeuralPlayback(message);return;
 }

 if(cloud.objectUrl)detachNeuralTrack();
 const node=$('#neural-audio');node.hidden=false;$('#neural-player').hidden=false;
 $('#neural-title').textContent=cloud.voice+' · '+article.title;
 if(cloud.paused){$('#neural-state').textContent='已暫停，按暫停／繼續可續播。';updatePlayer();return}
 $('#neural-state').textContent=cloud.index?'正在銜接第 '+(cloud.index+1)+' 則…':'正在準備音訊…';
 cloud.pending=true;updatePlayer();
 let advance=false;
 try{
  const track=narrationTrack(cloud.index);
  const next=cloud.next;
  cloud.next=null;
  let result=next?.key===track.key?await next.result:await loadTrackClip(track,cloud.controller.signal);
  if(token!==cloud.token)return;
  if(result.error)throw result.error;
  if(result.clip.expires<=Date.now()){
   result=await loadTrackClip(track,cloud.controller.signal);
   if(token!==cloud.token)return;
  }
  if(track.key!==narrationTrack(cloud.index).key)throw Error('口播稿已更新，請重新按播放。');
  const {clip,cached}=result;
  const {blob,expires}=clip;
  const url=URL.createObjectURL(blob);
  cloud.objectUrl=url;cloud.expires=expires;node.src=url;node.playbackRate=player.speed;
  const isCurrent=()=>cloud.active&&token===cloud.token&&cloud.objectUrl===url;
  const progressKey='neural-position:'+cloud.voice+':'+track.format.join('/')+':'+article.id;
  if(read(progressKey+':revision',null)!==track.key){
   write(progressKey,0);write(progressKey+':revision',track.key);
  }
  node.onloadedmetadata=()=>{if(!isCurrent())return;const saved=Number(read(progressKey,0));if(Number.isFinite(saved)&&saved>0&&saved<node.duration)node.currentTime=saved};
  node.ontimeupdate=()=>{if(!isCurrent())return;if(Date.now()>=cloud.expires){stopNeuralPlayback();return toast('音訊已到期')}write(progressKey,node.currentTime)};
  node.onended=()=>{if(!isCurrent())return;node.onended=null;write(progressKey,0);cloud.index++;playNeuralTrack(token)};
  const trackLabel=cloud.voice+' AI 合成語音 · '+(cloud.index+1)+' / '+cloud.articles.length+' 則'+(cached?' · 分頁暫存重播':'');
  $('#neural-state').textContent=trackLabel;
  node.onplaying=()=>{
   if(!isCurrent())return;
   cloud.paused=false;setNeuralMediaSession(token,node,article.title);
   $('#neural-state').textContent=trackLabel;updatePlayer();prepareFollowingTrack(token);
  };
  node.onpause=()=>{
   if(!isCurrent()||node.ended)return;
   cloud.paused=true;
   if(cloud.mediaSession){try{cloud.mediaSession.playbackState='paused'}catch{}}
   $('#neural-state').textContent=trackLabel+' · 已暫停';updatePlayer();
  };
  node.onerror=()=>{
   if(!isCurrent())return;
   recentAudio.delete(track.key);stopNeuralPlayback('音訊無法播放，請重試或閱讀文字');
  };
  cloud.cleanupTimer=setTimeout(()=>{if(isCurrent())stopNeuralPlayback('音訊已到期')},Math.min(expires-Date.now(),72*60*60*1000));
  cloud.pending=false;
  if(cloud.paused){$('#neural-state').textContent='音訊已就緒，按播放可續播。'}
  else try{await node.play()}catch(error){
   if(!isCurrent())return;
   if(error.name==='NotAllowedError')$('#neural-state').textContent='音訊已準備好，請按播放器的播放鍵';
   else if(error.name!=='AbortError'||!node.paused)stopNeuralPlayback('音訊無法播放，請重試或閱讀文字');
  }
 }catch(error){
  if(token!==cloud.token)return;
  if(error.code==='narration_mismatch'&&cloud.mode==='edition'){
   cloud.skipped.push(article.title);cloud.index++;advance=true;
   toast('口播與稿件不符，略過〈'+article.title+'〉');
  }else{
   stopNeuralPlayback(error.message);toast(error.message);
  }
 }finally{if(token===cloud.token&&(advance||cloud.index===index)){cloud.pending=false;updatePlayer()}}
 if(advance)await playNeuralTrack(token);
}
const player={queue:[],index:0,key:'',active:false,paused:false,speed:Number(read('speed',1))||1,generation:0,utterance:null};
function updatePlayer(){
 let status=voiceNote();
 if(cloud.active){
  const activity=cloud.paused?'已暫停':cloud.pending?'準備中':$('#neural-audio').paused?'已暫停':'播報中';
  status=cloud.voice+' '+activity+' · '+(cloud.index+1)+' / '+cloud.articles.length+' 則';
 }else if(player.active){
  status='裝置'+(player.paused?'已暫停':'朗讀中')+' · '+(player.index+1)+' / '+player.queue.length+' 段';
 }
 document.querySelectorAll('[data-player-status]').forEach(el=>{el.textContent=status;el.setAttribute('role','status')});
}
function stopSpeech(){player.generation++;if(player.active&&'speechSynthesis'in window)speechSynthesis.cancel();player.active=false;player.paused=false;updatePlayer()}
function beginSpeech(articles,key){if(cloud.active||cloud.pending)stopNeuralPlayback();if(!('speechSynthesis'in window))return toast('此瀏覽器未提供語音，請閱讀文字重點');const queue=[];for(const a of articles){if(!isEdited(a))continue;const text=plain(a.speech_script);for(const sentence of text.match(/[^。！？]+[。！？]?/g)||[]){for(let n=0;n<sentence.length;n+=120)queue.push(sentence.slice(n,n+120))}}if(!queue.length)return toast('本期尚無編輯完成的口播稿');stopSpeech();const signature=queue.join('').length+'-'+queue.join('').slice(-16);player.queue=queue;player.key=key+':'+signature;player.index=Math.min(Number(read('speech:'+player.key,0))||0,queue.length-1);player.active=true;player.paused=false;speakNext();toast('開始朗讀繁中重點')}
function speakNext(){if(!player.active)return;const generation=player.generation;const utterance=new SpeechSynthesisUtterance(player.queue[player.index]);player.utterance=utterance;utterance.lang='zh-TW';utterance.rate=player.speed;const voice=speechSynthesis.getVoices().find(v=>v.lang.toLowerCase()==='zh-tw');if(voice)utterance.voice=voice;utterance.onend=()=>{if(generation!==player.generation)return;player.index++;if(player.index>=player.queue.length){write('speech:'+player.key,0);player.active=false;toast('本次重點朗讀完畢');updatePlayer();return}write('speech:'+player.key,player.index);speakNext()};utterance.onerror=e=>{if(generation!==player.generation||e.error==='canceled'||e.error==='interrupted')return;player.active=false;toast('語音播放失敗，請按播放重試或閱讀文字');updatePlayer()};speechSynthesis.speak(utterance);updatePlayer()}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function validateImported(e){if(!e||!e.id||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||!['morning','evening'].includes(e.edition)||!Array.isArray(e.articles)||!e.articles.length||e.articles.length>(e.edition==='morning'?20:10)||!Number.isFinite(Date.parse(e.published_at))||!Number.isFinite(Date.parse(e.cutoff_at))||Date.parse(e.cutoff_at)>Date.parse(e.published_at)||Date.parse(e.published_at)>Date.now())throw Error('期刊格式或時間無效');const ids=new Set();for(const a of e.articles){if(!isEdited(a)||!a.event_id||ids.has(a.event_id)||!safeLink(a.url)||!a.source||!['AI','IT','資安','環境','綜合'].includes(a.topic)||!/[\u3400-\u9fff]/.test(a.title)||/^v?\d+\.\d+/.test(a.title)||!a.excerpt||!a.analysis||!a.uncertainty||!Array.isArray(a.evidence)||a.facts.length<3||a.facts.length>5||a.evidence.length<a.facts.length||!a.evidence.every(f=>safeLink(f.url)&&f.support&&a.source_urls?.includes(f.url))||!a.source_urls.every(safeLink)||!['official_statement','corroborated','attributed_report'].includes(a.verification_status)||plain(a.speech_script)!==a.speech_script.trim())throw Error('新聞須有繁中摘要、三至五項事實與引用、判讀、限制與乾淨口播稿');ids.add(a.event_id)}}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.view)return go(b.dataset.view);if(b.dataset.edition){stopSpeech();stopNeuralPlayback();state.editionPicked=true;state.edition=b.dataset.edition;state.selected='';render();return}if(b.dataset.topic){state.topic=b.dataset.topic;render();return}if(b.dataset.open!==undefined)return openItem(Number(b.dataset.open));if(b.dataset.neural!==undefined){const r=items()[Number(b.dataset.neural)];if($('#detail').open)$('#detail').close();return startNeuralPlayback([r],current()?.id)}if(b.dataset.speak!==undefined){const r=items()[Number(b.dataset.speak)];return beginSpeech([r],r.id)}if(b.dataset.save!==undefined){const r=items()[Number(b.dataset.save)];const saved=state.saved.some(s=>s.id===r.id)?state.saved.filter(s=>s.id!==r.id):[r,...state.saved];if(write('saved',saved)){state.saved=saved;drawList();toast('收藏已更新')}return}switch(b.dataset.action){case'neural-play':{const edition=current();if(!edition)return toast('這一期尚未發布');startNeuralPlayback(edition.articles,edition.id,'edition');break}case'neural-stop':stopNeuralPlayback();break;case'reload-app':{const url=new URL(window.location.href);url.searchParams.set('app_version',APP_RELEASE);window.location.replace(url.href);break}case'refresh':loadSources();break;case'refresh-edition':refreshEdition();break;case'retry-editions':loadEditions();break;case'older-editions':loadOlderEditions();break;case'close':$('#detail').close();break;case'export':download('news-station-backup.json',{version:2,saved:savedArticles(),read:state.read,editions:state.editions});break;case'template':if(current())download('edition-reference.json',current());else toast('目前沒有可下載的編輯版');break;case'speak':{const edition=current();if(!edition)return toast(state.publicationLoading?'新聞還在載入，完成後即可播放':state.publicationError?'新聞載入失敗，請按重新載入':(state.edition==='evening'?'晚報尚未發布，可切換晨報直接播放':'晨報尚未發布，可查看另一版'));beginSpeech(edition.articles,edition.id);break}case'pause':if(cloud.active){toggleNeuralPause();break}if(player.active){player.paused=!player.paused;if(player.paused)speechSynthesis.pause();else speechSynthesis.resume();updatePlayer()}break;case'stop':stopSpeech();stopNeuralPlayback();break}});
document.addEventListener('input',e=>{if(e.target.matches('.search')){state.query=e.target.value;drawList()}});
document.addEventListener('change',async e=>{if(e.target.matches('[data-speed]')){player.speed=Number(e.target.value);write('speed',player.speed);if(cloud.active)$('#neural-audio').playbackRate=player.speed;if(player.active){const queue=player.queue,index=player.index,key=player.key;stopSpeech();Object.assign(player,{queue,index,key,active:true});speakNext()}return}if(e.target.id==='technical'){state.showTechnical=e.target.checked;drawList();return}if(e.target.id==='edition-archive'){stopSpeech();stopNeuralPlayback();state.editionPicked=true;state.selected=e.target.value;render();return}if(!['import','restore'].includes(e.target.id))return;try{const f=e.target.files[0];if(!f)return;if(f.size>2000000)throw Error('檔案不可超過 2 MB');const data=JSON.parse(await f.text());if(e.target.id==='import'){validateImported(data);const next=[data,...state.editions.filter(x=>x.id!==data.id)];if(!write('editions',next))return;state.editions=next;toast('已匯入本機編輯版')}else{if(![1,2].includes(data.version)||!Array.isArray(data.saved)||!Array.isArray(data.read)||data.read.some(x=>typeof x!=='string')||!Array.isArray(data.editions))throw Error('備份格式無效');if(data.saved.some(a=>!a.id||!a.title||!safeLink(a.url)||!a.source||!['AI','IT','資安','環境','綜合'].includes(a.topic)))throw Error('收藏格式無效');const editions=data.editions.filter(e=>e.articles?.every(a=>a.status==='edited'));editions.forEach(validateImported);if(!write('saved',data.saved)||!write('read',data.read)||!write('editions',editions))return;Object.assign(state,{saved:data.saved,read:data.read,editions});toast('已還原備份；舊版未編輯期刊不會放入新聞重點')}render()}catch(err){toast('匯入失敗：'+err.message)}finally{e.target.value=''}});
state.editions=state.editions.filter(e=>e.articles?.every(a=>a.status==='edited'));
render();loadEditions();loadNeuralStatus();
window.addEventListener?.('pagehide',()=>{
 if(cloud.active||cloud.controller||cloud.objectUrl)stopNeuralPlayback();
 if(player.active)stopSpeech();
});
if('serviceWorker' in navigator){
 navigator.serviceWorker.addEventListener('message', event => {
  if(event.data?.type==='NEWS_VERSION_REQUEST')event.ports?.[0]?.postMessage({version:APP_RELEASE});
 });
 navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')navigator.serviceWorker.getRegistration().then(registration=>registration?.update()).catch(()=>{})});
}

