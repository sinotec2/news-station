const TOPICS = ['AI','IT','資安','環境'];
export function plainText(value) {
 return String(value || '').replace(/```[\s\S]*?```/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/(?:^|\n)\s{0,3}#{1,6}\s*/g,'').replace(/\s+/g,' ').trim();
}
export function candidateDecision(item) {
 const title=String(item.title||'');
 const text=title+' '+String(item.excerpt||'');
 if (/\b(sponsored|advertorial|affiliate)\b|廣編|業配|贊助內容/i.test(text)) return {lane:'excluded',reason:'明示贊助或導購，不作一般新聞'};
 if (/github\.com\/[^/]+\/[^/]+\/releases\//.test(item.url||'') || /^v?\d+\.\d+\.\d+/.test(title)) {
  if (/security|vulnerab|CVE-\d{4}|安全漏洞|資安漏洞/i.test(text)) return {lane:'review',reason:'涉及安全修補，須核對影響範圍後再決定入選'};
  return {lane:'technical',reason:'例行軟體或 SDK 版本紀錄，預設移出新聞選稿'};
 }
 return {lane:'review',reason:'待評估公共或專業影響；尚未編輯與核對'};
}
function requireField(condition,message){if(!condition)throw Error(message)}
function isTime(s){return typeof s==='string'&&/T.*(Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s))}
function isHttps(s){try{return new URL(s).protocol==='https:'}catch{return false}}
function isChinese(s){return typeof s==='string'&&/[\u3400-\u9fff]/.test(s)}
function isProse(s){return typeof s==='string'&&!/https?:\/\/|\[[^\]]+\]\(|(?:^|\n)\s*#{1,6}\s|```/.test(s)}
export function validateBriefing(edition,{now=Date.now()}={}) {
 requireField(edition&&/^\d{4}-\d{2}-\d{2}$/.test(edition.date),'期刊日期無效');
 requireField(['morning','evening'].includes(edition.edition),'晨晚報類型無效');
 requireField(isTime(edition.published_at)&&isTime(edition.cutoff_at)&&Date.parse(edition.cutoff_at)<=Date.parse(edition.published_at)&&Date.parse(edition.published_at)<=now,'發布與截止時間無效');
 requireField(edition.timezone==='Asia/Taipei'&&typeof edition.id==='string'&&edition.id,'期刊須有 ID 與台北時區');
 requireField(Array.isArray(edition.articles)&&edition.articles.length>0&&edition.articles.length<=(edition.edition==='morning'?20:10),'期刊篇數無效');
 const events=new Set();
 for(const a of edition.articles){
  requireField(a&&typeof a.id==='string'&&a.id&&typeof a.event_id==='string'&&a.event_id&&!events.has(a.event_id),'事件 ID 缺失或重複');events.add(a.event_id);
  requireField(TOPICS.includes(a.topic)&&isChinese(a.title)&&isProse(a.title)&&a.title.length>=10&&!/^v?\d+\.\d+/.test(a.title),'標題必須是有意義的繁中新聞標題');
  requireField(isChinese(a.excerpt)&&isProse(a.excerpt)&&a.excerpt.length>=25,'必須有獨立撰寫的繁中重點摘要');
  requireField(Array.isArray(a.facts)&&a.facts.length>=3&&a.facts.length<=5&&a.facts.every(f=>isChinese(f)&&isProse(f)),'須有三至五項繁中事實');
  requireField(Array.isArray(a.evidence)&&a.evidence.length===a.facts.length&&a.evidence.every(e=>isHttps(e.url)&&typeof e.support==='string'&&e.support.length>=8),'每項事實都須有來源與證據說明');
  requireField(a.evidence.every(e=>a.source_urls?.includes(e.url))&&a.source_urls.every(isHttps)&&a.source_urls.includes(a.url),'事實引用須對應原始來源');
  requireField(typeof a.source==='string'&&isTime(a.verified_at)&&Date.parse(a.verified_at)<=Date.parse(edition.cutoff_at)&&isTime(a.date)&&Date.parse(a.date)<=Date.parse(edition.cutoff_at),'來源名稱、來源日期或核對時間無效');
  requireField(['official_statement','corroborated'].includes(a.verification_status),'必須清楚標記官方聲明或交叉核對');
  requireField(a.verification_status!=='corroborated'||new Set(a.source_urls.map(u=>new URL(u).hostname)).size>=2,'交叉核對至少需要兩個來源網域（仍需人工判斷獨立性）');
  requireField(a.status==='edited'&&isChinese(a.analysis)&&isChinese(a.uncertainty)&&isChinese(a.selection_reason),'缺少判讀、不確定性或入選理由');
  requireField(a.editorial_kind!=='routine_release'&&typeof a.newsworthiness==='string'&&a.newsworthiness.length>=10,'例行版本更新不得直接入選');
  requireField(isChinese(a.speech_script)&&isProse(a.speech_script)&&a.speech_script.length>=50,'須有不含網址或 Markdown 的繁中口播稿');
  requireField(Array.isArray(a.correction_history),'缺少更正紀錄');
 }
 return edition;
}
export function speechSegments(articles) {
 const out=[];
 for(const a of articles){if(a.status!=='edited')continue;const text=plainText(a.speech_script);if(!text)continue;const sentences=text.match(/[^。！？]+[。！？]?/g)||[text];for(const s of sentences){for(let i=0;i<s.length;i+=120)out.push({article_id:a.id,text:s.slice(i,i+120)})}}
 return out;
}
