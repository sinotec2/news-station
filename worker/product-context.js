// Product documentation describes what the product does. The advisory remains the source of vulnerability facts.
import {PRODUCT_PROFILES} from './product-profiles.js';

const CVE = /\bCVE-\d{4}-\d{4,}\b/i;
const legacyTitle = /^(.+?) 漏洞列入美國已知遭利用目錄[（(](CVE-\d{4}-\d{4,})[)）]$/u;
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function productNames(names) {
  const aliases = [...new Set(names.filter(Boolean).map(normalize))].sort((a, b) => b.length - a.length);
  const alternatives = aliases.map(escapeRegex).join('|');
  return {aliases, inText:new RegExp('(^|[^a-z0-9_-])(' + alternatives + ')(?![a-z0-9_-])', 'iu')};
}
const profiles = PRODUCT_PROFILES.map(profile => ({profile, ...productNames(profile.names)}));
function exactProfile(name) {
  const alias = normalize(name);
  const matches = profiles.filter(entry => entry.aliases.includes(alias));
  return matches.length === 1 ? matches[0] : null;
}

function productFields(metadata) {
  const fields = [metadata?.vendor, metadata?.product];
  if (!fields.every(s => typeof s === 'string' && s.trim() && s.length <= 150 && !/[<>\r\n]/u.test(s))) return null;
  const [vendor, product] = fields.map(normalize);
  const full = product.startsWith(vendor + ' ') ? product : vendor + ' ' + product;
  return {vendor, product, full};
}
function structuredProfile({vendor, product, full}) {
  const entry = exactProfile(full) || exactProfile(product);
  return entry?.aliases.some(name => name.startsWith(vendor + ' ')) ? entry : null;
}

// Look for the subject of a vulnerability or remediation, not a product mentioned in passing.
function isSubject(text, match) {
  const before = text.slice(0, match.index + match[1].length).trimEnd();
  const after = text.slice(match.index + match[0].length).trimStart();
  const clause = after.split(/[。，；,;：（(]/u, 1)[0];
  if (/(?:和|與|及|、|\/|&|\band)\s*$/iu.test(before) ||
      /外掛|插件|掃描器|偵測工具|掃描工具|第三方|\b(?:plugin|plug-in|scanner|connector|add-on)\b/iu.test(clause)) return false;
  const problem = /^(?:的|存在|出現|曝出|揭露|爆出|傳出|修補|修正|修復|有)?\s*(?:(?:多個|高風險|高危|重大|嚴重|安全|資安|零時差|零日|已知遭利用|已遭利用|critical|security|zero-day)\s*){0,4}(?:漏洞|弱點|安全缺陷|vulnerabilit(?:y|ies)\b)/iu;
  const patch = /^(?:修補|修正|修復|patched|fixes)\s*(?:了\s*)?CVE-\d{4}-\d{4,}\b/iu;
  // An unexpected brand or product name immediately before an alias makes this mention ambiguous.
  if (/[a-z][a-z0-9_-]*$/iu.test(before) && !/\b(?:in|for|affects|patches|fixes)$/iu.test(before)) return false;
  if (problem.test(after) || patch.test(after)) return true;
  const direct = /cve-\d{4}-\d{4,}\s*(?:可能|亦|也|直接)?(?:影響|affects)\s*$/iu.test(before);
  return direct && /^(?:$|[.。,，;；)：:）(（!！]|(?:的)?(?:使用者|用戶))/.test(after);
}
function headlineProfile(title) {
  const text = normalize(title);
  const mentions = profiles.map(entry => ({entry, match:text.match(entry.inText)})).filter(hit => hit.match);
  return mentions.length === 1 && isSubject(text, mentions[0].match) ? mentions[0].entry : null;
}

function safeContext(context) {
  const text = (value, cap) => typeof value === 'string' && value.trim().length > 0 && value.length <= cap &&
    !/[<>`{}\[\]\\\p{Cc}\p{Cf}]|(?:[a-z]+:\/\/|www\.)/iu.test(value);
  if (!text(context?.intro, 240) || !/\p{Script=Han}/u.test(context.intro) || !text(context.source_label, 80) ||
      typeof context.source_url !== 'string' || context.source_url.length > 2048) return false;
  try {
    const url = new URL(context.source_url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {return false;}
}

function introSubject(intro) {
  return intro.match(/^([\p{L}\p{N}][\p{L}\p{N} ._-]{1,79}?)\s*(?:是|由|用於|可讓|可用來|主要用於|用來)/u)?.[1]?.trim();
}
function contextMatchesTitle(title, names, legacy) {
  if (legacy) return names.aliases.includes(normalize(legacy[1]));
  const text = normalize(title), match = text.match(names.inText);
  return match && isSubject(text, match);
}

function narration(article, context, names, legacy, authored) {
  const intro = /[。！？!?]$/u.test(context.intro.trim()) ? context.intro.trim() : context.intro.trim() + '。';
  let script = article.speech_script;
  if (script.includes(context.intro.trim())) return script;
  // An editor may have used the first sentence of the sourced intro already.
  const sentences = intro.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
  for (let n = sentences.length - 1; n > 0; n--) {
    const prefix = sentences.slice(0, n).join('');
    if (script.startsWith(prefix)) return intro + script.slice(prefix.length);
  }

  const opening = script.match(/^[^。！？!?]+[。！？!?]/u)?.[0] ?? '';
  const match = normalize(opening).match(names.inText);
  if (match) {
    const rest = normalize(opening).slice(match.index + match[0].length).trimStart();
    // Replace only a bare definition, never dates, applicability or editorial facts.
    if (match.index === 0 && /^是(?:一[款套種項個])?(?:軟體|工具|平台|系統|產品|服務)[。.!！?？]$/u.test(rest)) {
      script = script.slice(opening.length);
    } else if (!authored && /^(?:是|用於|讓|可用來|主要用來)/u.test(rest) && /用來|用於|讓.{2,18}(?:管理|使用|建立|架設|連線|發表)|可(?:以)?(?:管理|使用|建立|架設|連線|發表)/u.test(rest)) {
      return script;
    }
  }
  if (legacy) {
    const repeated = '美國資安主管機關將 ' + legacy[1] + ' 的 ';
    if (script.startsWith(repeated + legacy[2] + ' 列入已知遭利用漏洞目錄。')) {
      script = '美國資安主管機關將這項產品的 ' + script.slice(repeated.length);
    }
  }
  return intro + script;
}

export function enrichCveArticle(article, productName) {
  if (article?.status !== 'edited' || typeof article.title !== 'string' || !CVE.test(article.title) ||
      typeof article.speech_script !== 'string' || !article.speech_script.trim()) return article;
  const legacy = article.title.match(legacyTitle);
  const fields = productFields(article.affected_product);
  const titleEntry = legacy ? exactProfile(legacy[1]) : headlineProfile(article.title);
  let entry = titleEntry;
  if (article.affected_product !== undefined) entry = fields && structuredProfile(fields);
  else if (typeof productName === 'string') entry = exactProfile(productName);
  if (titleEntry && titleEntry !== entry) return article;
  if (entry && !contextMatchesTitle(article.title, entry, legacy)) return article;

  const authored = safeContext(article.product_context) ? article.product_context : null;
  if (!entry && !authored) return article;
  let names = entry;
  if (!entry) {
    const introduced = introSubject(authored.intro);
    const aliases = fields ? [fields.full, fields.product] : [introduced];
    if (!aliases.some(Boolean)) return article;
    names = productNames(aliases);
    if (!contextMatchesTitle(article.title, names, legacy)) return article;
  }
  const {intro, source_label, source_url} = authored || entry.profile;
  const context = authored || {intro, source_label, source_url};
  const script = narration(article, context, names, legacy, Boolean(authored && authored.intro !== entry?.profile.intro));
  if (script === article.speech_script && authored) return article;
  return {...article, speech_script:script, product_context:context};
}

export function enrichEdition(edition) {
  if (!Array.isArray(edition?.articles)) return edition;
  const articles = edition.articles.map(article => enrichCveArticle(article));
  return articles.some((article, i) => article !== edition.articles[i]) ? {...edition, articles} : edition;
}
