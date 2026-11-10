// ==UserScript==
// @name         Netflix 中英悬浮双字幕
// @namespace    zhenghao.netflix.dualsubs
// @version      1.3.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/netflix-dual-subtitles/main/netflix-dual-subtitles.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/netflix-dual-subtitles/main/netflix-dual-subtitles.user.js
// @description  把 Netflix 英文字幕翻译成中文，中英悬浮双字幕；支持全屏和官方中文字幕。
// @match        https://www.netflix.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      nflxvideo.net
// @connect      nflximg.net
// @connect      netflix.com
// @connect      api.mymemory.translated.net
// @sandbox      JavaScript
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  const KEY = 'zh-netflix-dualsubs-v1';
  const defaults = {enabled: true, enSize: 30, zhSize: 25, bottom: 13, bg: 0.5, delay: 0, zhPref: 'hans', zhMode: 'auto'};
  let cfg = {...defaults};
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) {}
  for (const [key, min, max] of [['enSize',16,60],['zhSize',16,60],['bottom',3,45],['bg',0,1],['delay',-20,20]]) {
    cfg[key] = Math.min(max, Math.max(min, (Number.isFinite(Number(cfg[key])) ? Number(cfg[key]) : defaults[key])));
  }
  if (!['auto','translate','official'].includes(cfg.zhMode)) cfg.zhMode = 'translate';
  const originalParse = page.JSON.parse;
  const originalStringify = page.JSON.stringify;
  const manifests = new Map();
  const state = {id: '', tracks: [], en: [], zh: [], enStatus: '等待字幕清单', zhStatus: '等待字幕清单', enGen: 0, zhGen: 0, signature: '', zhPending: false, local: {en:false,zh:false}};
  let host, root, overlay, panel, enLine, zhLine, nativeStyle, video;
  let lastText = '', lastLayout = '', pendingManifest = false;
  const watchID = () => location.pathname.match(/^\/watch\/(\d+)/)?.[1] || '';
  const save = () => { try { localStorage.setItem(KEY, originalStringify(cfg)); } catch (_) {} };
  const status = (lang, text) => { state[lang + 'Status'] = text; updateStatus(); };

  // Hooks are installed before Netflix starts. Only manifest-shaped requests are adjusted.
  function patchManifest(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return value;
    let copy = value;
    for (const key of Object.keys(value)) {
      const child = value[key];
      let next = child;
      if (key === 'profiles' && Array.isArray(child)) {
        next = [...new Set(['webvtt-lssdh-ios8', 'dfxp-ls-sdh', ...child])];
      } else if (key === 'showAllSubDubTracks') next = true;
      else if (child && typeof child === 'object' && !Array.isArray(child)) next = patchManifest(child, depth + 1);
      if (next !== child) {
        if (copy === value) copy = Array.isArray(value) ? [...value] : {...value};
        copy[key] = next;
      }
    }
    return copy;
  }
  page.JSON.stringify = function(value, ...rest) {
    let candidate = value;
    try {
      if (value && typeof value.url === 'string' && /manifest/i.test(value.url)) candidate = patchManifest(value);
    } catch (_) { candidate = value; }
    return originalStringify.call(this, candidate, ...rest);
  };
  page.JSON.parse = function(text, ...rest) {
    const result = originalParse.call(this, text, ...rest);
    try {
      if (typeof text === 'string' && /"(?:textTracks|timedtexttracks)"/.test(text)) {
        let budget = 800;
        const seen = new WeakSet();
        const walk = (obj, depth) => {
          if (!obj || typeof obj !== 'object' || depth > 7 || --budget < 0 || seen.has(obj)) return;
          seen.add(obj);
          const tracks = obj.textTracks || obj.timedtexttracks;
          if (Array.isArray(tracks) && obj.movieId != null) {
            const id = String(obj.movieId);
            manifests.delete(id);
            manifests.set(id, tracks);
            if (manifests.size > 6) manifests.delete(manifests.keys().next().value);
            if (id === watchID() && !pendingManifest) {
              pendingManifest = true;
              queueMicrotask(() => { pendingManifest = false; syncRoute(); applyManifest(); });
            }
            return;
          }
          for (const key of Object.keys(obj)) walk(obj[key], depth + 1);
        };
        walk(result, 0);
      }
    } catch (_) { /* Never interrupt Netflix JSON parsing. */ }
    return result;
  };

  function clock(s, rates = {frame:30,tick:1}) {
    if (!s) return NaN;
    s = String(s).trim().replace(',', '.');
    const units = s.match(/^([\d.]+)(ms|h|m|s|f|t)$/);
    if (units) return Number(units[1]) * ({ms:0.001,h:3600,m:60,s:1,f:1/rates.frame,t:1/rates.tick}[units[2]]);
    const parts = s.split(':').map(Number);
    if (parts.some(x => !Number.isFinite(x))) return NaN;
    if (parts.length === 4) return parts[0]*3600 + parts[1]*60 + parts[2] + parts[3]/rates.frame;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  function plain(s) {
    const doc = new DOMParser().parseFromString('<body>' + s.replace(/<br\s*\/?\s*>/gi, '\n') + '</body>', 'text/html');
    return doc.body.textContent.trim();
  }
  function parseSubtitles(text) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    if (/^\s*</.test(text)) {
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.querySelector('parsererror')) throw Error('XML 字幕格式无效');
      const attr = (node, name) => [...node.attributes].find(a => a.localName === name)?.value;
      const tt = xml.documentElement;
      let frame = Number(attr(tt,'frameRate')) || 30;
      const multiplier = (attr(tt,'frameRateMultiplier') || '1 1').split(/\s+/).map(Number);
      frame *= (multiplier[0] || 1)/(multiplier[1] || 1);
      const rates = {frame, tick: Number(attr(tt,'tickRate')) || (attr(tt,'frameRate') ? frame*(Number(attr(tt,'subFrameRate')) || 1) : 1)};
      const content = node => [...node.childNodes].map(n => n.nodeType === 3 ? n.nodeValue : n.localName === 'br' ? '\n' : content(n)).join('');
      // Resolve relative timing on body/div/p. Timed spans are flattened to their cue.
      const visit = (node, parentStart = 0, parentEnd = Infinity) => {
        if (node.nodeType !== 1) return;
        const begin = attr(node,'begin');
        const start = parentStart + (begin ? clock(begin,rates) : 0);
        const endAttr = attr(node,'end'), dur = attr(node,'dur');
        const end = Math.min(parentEnd, endAttr ? parentStart + clock(endAttr,rates) : dur ? start + clock(dur,rates) : parentEnd);
        if (node.localName === 'p') {
          cues.push({start,end,text:content(node).replace(/[ \t]+/g,' ').trim()});
          return;
        }
        for (const child of node.children) visit(child,start,end);
      };
      visit(tt);
    } else {
      for (const block of text.split(/\n\s*\n/)) {
        const lines = block.trim().split('\n');
        if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
        const idx = lines.findIndex(l => l.includes('-->'));
        if (idx < 0) continue;
        const match = lines[idx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
        if (match) cues.push({start:clock(match[1]),end:clock(match[2]),text:plain(lines.slice(idx+1).join('\n'))});
      }
    }
    const sorted = cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text).sort((a,b)=>a.start-b.start);
    if (!sorted.length) throw Error('未读到文字字幕（图片/加密字幕不支持）');
    let maxEnd = -Infinity;
    return sorted.map(c => ({...c, maxEnd:maxEnd=Math.max(maxEnd,c.end)}));
  }
  function activeCues(cues, time) {
    let low = 0, high = cues.length;
    while (low < high) { const mid = (low+high)>>>1; if (cues[mid].start <= time) low=mid+1; else high=mid; }
    const active = [];
    for (let i=low-1;i>=0 && cues[i].maxEnd>time;i--) if (cues[i].end>time) active.unshift(cues[i]);
    return active;
  }
  const at = (cues,time) => [...new Set(activeCues(cues,time).map(c=>c.text))].join('\n');

  // Translate one cue at a time, with a bounded look-ahead queue and in-memory cache.
  // MyMemory anonymous translation has a daily quota; errors suspend retries after backoff.
  const translated = new Map();
  let translating = false, nextTranslationAt = 0, translationFailures = 0, translationEpoch = 0;
  let liveTranslationRequest = null, translationNote = '';
  const targetLanguage = () => cfg.zhPref === 'hant' ? 'zh-TW' : 'zh-CN';
  const cacheKey = text => targetLanguage() + '\u0000' + text;
  const wantsTranslation = () => Boolean(state.id && cfg.enabled && state.en.length && !state.local.zh &&
    (cfg.zhMode === 'translate' || (cfg.zhMode === 'auto' && !state.zh.length && !state.zhPending)));
  function cancelTranslation() {
    translationEpoch++;
    // GM abort is optional in some managers; epoch checks also reject late responses.
    if (liveTranslationRequest) liveTranslationRequest.cancel();
    translationFailures = 0; nextTranslationAt = 0; translationNote = '';
  }
  function translationStatus(message) {
    if (translationNote === message) return;
    translationNote = message;
    if (wantsTranslation()) status('zh',message);
  }
  function translateOne(text,target) {
    if (new TextEncoder().encode(text).length > 500) return Promise.reject(Error('单句超过翻译服务的 500 字节限制'));
    const query = new URLSearchParams({q:text,langpair:'en|'+(target==='zh-TW'?'zh-TW':'zh-CN')});
    return new Promise((resolve,reject)=>{
      let handle,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;if(liveTranslationRequest===token)liveTranslationRequest=null;error?reject(error):resolve(value);};
      const token={cancel(){finish(Error('cancelled'));try{handle?.abort?.();}catch(_){}}};
      liveTranslationRequest=token;
      handle=GM_xmlhttpRequest({method:'GET',url:'https://api.mymemory.translated.net/get?'+query,anonymous:true,timeout:12000,
        onload:r=>{try{
          if(r.status<200||r.status>=300)throw Error('HTTP '+r.status);
          if(r.finalUrl && new URL(r.finalUrl).hostname!=='api.mymemory.translated.net')throw Error('请求被拦截');
          const data=originalParse(r.responseText);
          if(data.quotaFinished || Number(data.responseStatus)===429)throw Error('免费翻译额度已用完，请稍后再试');
          if(Number(data.responseStatus)!==200)throw Error('翻译服务错误 '+(data.responseStatus||'未知'));
          const result=typeof data.responseData?.translatedText==='string'?data.responseData.translatedText.trim():'';
          if(!result)throw Error('翻译服务返回内容为空');finish(null,result);
        }catch(error){finish(error);}},onerror:()=>finish(Error('翻译服务网络错误')),ontimeout:()=>finish(Error('翻译请求超时')),onabort:()=>finish(Error('cancelled'))});
    });
  }
  async function pumpTranslation() {
    if (!wantsTranslation() || !video || translating || translationFailures >= 3) return;
    const now=Date.now();
    if (now < nextTranslationAt) return;
    const time=video.currentTime-cfg.delay;
    // Active cues take priority after seeking. Only translate the next 45 seconds.
    const upcoming=[...activeCues(state.en,time), ...state.en.filter(c=>c.start>=time && c.start<time+45).slice(0,12)];
    const cue=upcoming.find(c=>!translated.has(cacheKey(c.text)));
    if(!cue){translationStatus('机器翻译 · 当前片段已缓存');return;}
    if(cue.text.length>1800){translationStatus('单句过长，无法翻译');return;}
    translating=true;
    const epoch=translationEpoch,id=state.id,enGen=state.enGen,target=targetLanguage(),key=cacheKey(cue.text);
    translationStatus('机器翻译 · 正在翻译英文字幕…');
    try {
      const result=await translateOne(cue.text,target);
      if(epoch!==translationEpoch||id!==state.id||enGen!==state.enGen||target!==targetLanguage()||!wantsTranslation()) return;
      translated.set(key,result);
      if(translated.size>2500)translated.delete(translated.keys().next().value);
      translationFailures=0;
      translationStatus('机器翻译 · 已缓存 '+translated.size+' 句');
      nextTranslationAt=Date.now()+1200;
    }catch(error){
      if(epoch!==translationEpoch||error.message==='cancelled')return;
      translationFailures++;
      nextTranslationAt=Date.now()+15000*translationFailures;
      translationStatus((translationFailures>=3?'翻译已暂停：':'翻译失败：') + error.message + (translationFailures>=3?'；点击“重试翻译”':''));
    }finally{translating=false;}
  }
  function translatedAt(time) {
    return [...new Set(activeCues(state.en,time).map(c=>translated.get(cacheKey(c.text)) ||
      (translationFailures ? '翻译暂不可用，请查看设置面板' : '正在翻译…')))].join('\n');
  }
  function safeURL(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)(nflxvideo\.net|nflximg\.net|netflix\.com)$/.test(u.hostname); } catch (_) { return false; }
  }
  function sources(track) {
    const data = track.ttDownloadables || track.downloadables || {};
    const formats = Object.keys(data).filter(k=>/vtt|dfxp|imsc|simplesdh/i.test(k)).sort((a,b)=>Number(!/vtt/i.test(a))-Number(!/vtt/i.test(b)));
    const urls = [];
    for (const fmt of formats) {
      const d = data[fmt];
      for (const item of [...Object.values(d.downloadUrls || {}), ...(d.urls || [])]) {
        const url = typeof item === 'string' ? item : item?.url;
        if (safeURL(url) && !urls.includes(url)) urls.push(url);
      }
    }
    return urls.slice(0,6);
  }
  function request(url) {
    return new Promise((resolve,reject) => {
      GM_xmlhttpRequest({method:'GET',url,timeout:18000,anonymous:true,
        onload:r => r.status>=200 && r.status<300 && (!r.finalUrl || safeURL(r.finalUrl)) ? resolve(r.responseText) : reject(Error('字幕请求失败')),
        onerror:()=>reject(Error('网络错误')),ontimeout:()=>reject(Error('字幕请求超时'))});
    });
  }
  const langOf = t => String(t.language || t.bcp47 || '').toLowerCase();
  const isLanguage = (t,lang) => lang === 'en' ? /^en(?:-|$)/.test(langOf(t)) : /^(zh|cmn|yue)(?:-|$)/.test(langOf(t));
  const label = t => `${t.languageDescription || t.displayName || t.language || '未知语言'}${/closed|assistive/i.test(t.rawTrackType || t.trackType || '')?' [CC]':''}${t.isForcedNarrative?' [仅外语片段]':''}`;
  const rank = t => (t.isForcedNarrative?100:0) + (/closed|assistive/i.test(t.rawTrackType || t.trackType || '')?5:0) + (cfg.zhPref === 'hans' && /hant|tw|hk|yue/.test(langOf(t)) ? 2 : cfg.zhPref === 'hant' && !/hant|tw|hk|yue/.test(langOf(t)) && isLanguage(t,'zh') ? 2 : 0);
  async function loadTrack(lang, index) {
    const gen = ++state[lang+'Gen'];
    state.local[lang] = false;
    state[lang] = [];
    if(lang==='en')cancelTranslation();
    if(lang==='zh')state.zhPending=false;
    const t = state.tracks[index];
    if (!t) { status(lang,'未提供此语言，可导入本地字幕'); return; }
    if(lang==='zh')state.zhPending=true;
    status(lang,'正在加载…');
    for (const url of sources(t)) {
      try {
        const text = await request(url);
        if (gen !== state[lang+'Gen']) return;
        const cues = parseSubtitles(text);
        state[lang] = cues;
        if(lang==='zh')state.zhPending=false;
        status(lang,`已就绪 · ${cues.length} 条`);
        return;
      } catch (_) { if (gen !== state[lang+'Gen']) return; }
    }
    if(lang==='zh')state.zhPending=false;
    status(lang,'加载失败：重新读取或导入本地字幕');
  }
  function updateStatus() {
    if (!root) return;
    for (const lang of ['en','zh']) root.getElementById(lang+'Status').textContent = state[lang+'Status'];
  }
  function fillOptions(lang) {
    if (!root) return;
    const select = root.getElementById(lang+'Track');
    select.replaceChildren();
    const tracks = state.tracks.map((t,i)=>({t,i})).filter(({t})=>isLanguage(t,lang)).sort((a,b)=>rank(a.t)-rank(b.t));
    select.add(new Option(tracks.length?'自动选择（推荐）':'无可用字幕', 'auto'));
    for (const {t,i} of tracks) select.add(new Option(label(t),String(i)));
    return tracks[0]?.i;
  }
  function applyManifest(force = false) {
    if (!state.id || !manifests.has(state.id)) return;
    const tracks = manifests.get(state.id).filter(t=>!t.isNoneTrack);
    const signature = originalStringify(tracks.map(t=>[t.new_track_id || t.id,t.language,sources(t)]));
    if (!force && state.signature === signature) return;
    state.signature = signature;
    state.tracks = tracks;
    for (const lang of ['en','zh']) {
      const index = fillOptions(lang);
      if(lang==='zh' && cfg.zhMode==='translate' && !state.local.zh){state.zhGen++;state.zh=[];state.zhPending=false;status('zh','机器翻译 · 等待英文字幕');continue;}
      if (!state.local[lang]) loadTrack(lang,index);
    }
  }
  function syncRoute() {
    const id = watchID();
    if (id === state.id) return;
    cancelTranslation();
    state.zhPending=false;
    state.id = id;
    state.signature = '';
    state.tracks = [];
    for (const lang of ['en','zh']) { state[lang+'Gen']++; state[lang]=[]; state.local[lang]=false; status(lang,'等待字幕清单；未出现请刷新播放页'); fillOptions(lang); }
    if (overlay) overlay.hidden = true;
    if(enLine){enLine.textContent='';zhLine.textContent='';lastText='';}
    document.documentElement?.classList.remove('zh-dualsubs-active');
    applyManifest();
  }

  function mount() {
    host = document.createElement('div');
    host.id = 'zh-netflix-dualsubs';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
    root = host.attachShadow({mode:'open'});
    root.innerHTML = `
      <style>
      :host{font-family:system-ui,-apple-system,"Microsoft Yahei",sans-serif;color:#fff;color-scheme:dark}*{box-sizing:border-box} [hidden]{display:none!important}
      #subtitles{position:absolute;left:0;top:0;pointer-events:none;text-align:center;display:flex;align-items:center;justify-content:flex-end;flex-direction:column;padding:0 5%;overflow:hidden}
      .line{display:table;max-width:100%;white-space:pre-line;overflow-wrap:anywhere;line-height:1.35;font-weight:600;text-shadow:0 2px 3px #000,1px 0 2px #000;margin:3px auto;padding:2px 9px;border-radius:5px;background:rgba(0,0,0,var(--bg,.5))}.line:empty{display:none}
      #enLine{font-size:clamp(16px,3vw,var(--en,30px));color:#fff}#zhLine{font-size:clamp(16px,2.5vw,var(--zh,25px));color:#ffe9ad}
      #tools{position:absolute;right:18px;top:18px;pointer-events:auto}button,select,input{font:inherit}button{cursor:pointer;border:1px solid #ffffff35;background:#222c;color:#fff;border-radius:8px;padding:8px 12px}button:hover{background:#454550}#toggle{font-size:13px;opacity:.55}#toggle:hover,#toggle:focus-visible{opacity:1}
      #panel{position:absolute;right:0;top:44px;width:330px;max-width:90vw;max-height:78vh;overflow:auto;padding:18px;background:#17171ff5;border:1px solid #ffffff25;border-radius:14px;box-shadow:0 8px 35px #0008;font-size:13px;line-height:1.6}h2{font-size:17px;margin:0 0 12px}label{display:block;margin:12px 0 4px}select{width:100%;padding:7px;background:#30303a;color:#fff;border:1px solid #ffffff35;border-radius:6px}input[type=range]{width:100%;accent-color:#9d91ff}input[type=number]{width:75px;background:#30303a;border:1px solid #ffffff35;color:#fff;padding:5px;border-radius:4px}.hint{color:#bcbcc9;font-size:12px;margin:5px 0}.row{display:flex;gap:7px;align-items:center;justify-content:space-between}.small{font-size:12px;padding:5px 8px}footer{margin-top:14px;color:#aaa;font-size:11px}
      </style>
      <div id="subtitles" hidden aria-live="off"><div id="enLine" class="line" lang="en"></div><div id="zhLine" class="line" lang="zh"></div></div>
      <div id="tools"><button id="toggle" aria-expanded="false" aria-controls="panel">中 / EN</button><section id="panel" hidden>
      <h2>中英悬浮双字幕 · 1.3</h2><div class="row"><label style="margin:0"><input id="enabled" type="checkbox"> 开启双字幕</label><button id="close" class="small">收起</button></div>
      <label for="enTrack">英文字幕</label><select id="enTrack"></select><div class="row"><span class="hint" id="enStatus"></span><button class="small" id="enImport">导入</button></div>
      <label for="zhMode">中文来源</label><select id="zhMode"><option value="translate">英文 → 中文（免密钥翻译）</option><option value="auto">优先官方中文，没有则机器翻译</option><option value="official">只用官方 / 本地中文字幕</option></select><p class="hint">机器翻译会把英文字幕发送给 MyMemory，无需密钥；免费额度有限。</p>
      <label for="zhTrack">官方中文字幕（可选）</label><select id="zhTrack"></select><div class="row"><span class="hint" id="zhStatus"></span><button class="small" id="zhImport">导入</button></div>
      <label for="zhPref">中文优先</label><select id="zhPref"><option value="hans">简体中文</option><option value="hant">繁體中文</option></select>
      <label for="enSize">英文字号 <output id="enSizeVal"></output></label><input id="enSize" type="range" min="16" max="60">
      <label for="zhSize">中文字号 <output id="zhSizeVal"></output></label><input id="zhSize" type="range" min="16" max="60">
      <label for="bottom">距画面底部 <output id="bottomVal"></output></label><input id="bottom" type="range" min="3" max="45">
      <label for="bg">背景深度 <output id="bgVal"></output></label><input id="bg" type="range" min="0" max="1" step="0.05">
      <label for="delay">字幕延迟（秒，正数表示晚显示）</label><input id="delay" type="number" min="-20" max="20" step="0.1">
      <div class="row" style="margin-top:15px"><button id="retry" class="small">重新读取</button><button id="reload" class="small">刷新播放页</button><button id="reset" class="small">重置样式</button></div>
      <button id="retryTranslation" class="small" style="margin-top:12px">重试翻译</button><p class="hint">英文在上、中文译文在下，均悬浮在画面内。全屏请使用 Netflix 播放器的全屏按钮。也可导入本地 SRT / VTT / TTML 字幕；切集后需重新导入。</p><footer>开启机器翻译时，官方或导入的英文字幕会发给 MyMemory；导入的中文字幕不上传。</footer>
      <input id="file" type="file" accept=".srt,.vtt,.xml,.ttml,.dfxp" hidden>
      </section></div>`;
    document.documentElement.appendChild(host);
    overlay = root.getElementById('subtitles');
    panel = root.getElementById('panel');
    enLine = root.getElementById('enLine'); zhLine = root.getElementById('zhLine');
    nativeStyle = document.createElement('style');
    nativeStyle.textContent = 'html.zh-dualsubs-active .player-timedtext,html.zh-dualsubs-active .player-timedtext-text-container{visibility:hidden!important}';
    document.documentElement.appendChild(nativeStyle);
    const toggle = open => { panel.hidden = !open; root.getElementById('toggle').setAttribute('aria-expanded',String(open)); };
    root.getElementById('toggle').onclick = () => toggle(panel.hidden);
    root.getElementById('close').onclick = () => toggle(false);
    for (const event of ['keydown','keyup','click','dblclick','pointerdown','pointerup']) root.getElementById('tools').addEventListener(event,e=>e.stopPropagation());
    root.getElementById('enabled').onchange = e => {cfg.enabled=e.target.checked;cancelTranslation();save();};
    root.getElementById('zhMode').onchange = e => {
      cfg.zhMode=e.target.value;state.local.zh=false;cancelTranslation();save();
      if(!state.local.zh){if(cfg.zhMode==='translate'){state.zhGen++;state.zh=[];state.zhPending=false;status('zh','机器翻译 · 等待翻译');}else loadTrack('zh',fillOptions('zh'));}
    };
    root.getElementById('retryTranslation').onclick = () => {cancelTranslation();status('zh','正在重试机器翻译…');pumpTranslation();};
    root.getElementById('zhPref').onchange = e => { cfg.zhPref=e.target.value;cancelTranslation();save();if(cfg.zhMode!=='translate'&&!state.local.zh) loadTrack('zh',fillOptions('zh')); };
    for (const key of ['enSize','zhSize','bottom','bg','delay']) root.getElementById(key).oninput = e => {
      const n=Number(e.target.value);if(!Number.isFinite(n)) return;
      cfg[key]=Math.min(Number(e.target.max),Math.max(Number(e.target.min),n));save();paintConfig();
    };
    root.getElementById('retry').onclick = () => {state.local.en=state.local.zh=false;state.signature='';applyManifest(true);};
    root.getElementById('reload').onclick = () => location.reload();
    root.getElementById('reset').onclick = () => {cfg={...defaults};cancelTranslation();save();paintConfig();};
    for (const lang of ['en','zh']) {
      root.getElementById(lang+'Track').onchange = e => {
        if(lang==='zh'){cfg.zhMode='official';cancelTranslation();save();paintConfig();}
        const candidates=state.tracks.map((t,i)=>({t,i})).filter(({t})=>isLanguage(t,lang)).sort((a,b)=>rank(a.t)-rank(b.t));
        loadTrack(lang,e.target.value==='auto'?candidates[0]?.i:Number(e.target.value));
      };
      root.getElementById(lang+'Import').onclick = () => {
        const file=root.getElementById('file');file.value='';
        file.onchange=async()=>{
          const f=file.files[0];if(!f)return;
          if(f.size>5*1024*1024){status(lang,'文件大于 5 MB');return;}
          const id=state.id,gen=++state[lang+'Gen'];
          try{const cues=parseSubtitles(await f.text());if(state.id!==id||state[lang+'Gen']!==gen)return;state[lang]=cues;state.local[lang]=true;cancelTranslation();if(lang==='zh'){state.zhPending=false;cfg.zhMode='official';save();paintConfig();}status(lang,`本地 · ${cues.length} 条`);}
          catch(_){if(state.id===id&&state[lang+'Gen']===gen)status(lang,'导入失败：请使用 UTF-8 的文字字幕');}
        };file.click();
      };
      fillOptions(lang);
    }
    paintConfig();updateStatus();
  }
  function paintConfig() {
    if (!root) return;
    root.getElementById('enabled').checked=cfg.enabled;
    root.getElementById('zhPref').value=cfg.zhPref;
    root.getElementById('zhMode').value=cfg.zhMode;
    for (const key of ['enSize','zhSize','bottom','bg','delay']) {
      root.getElementById(key).value=cfg[key];
      const out=root.getElementById(key+'Val');if(out)out.textContent=cfg[key]+(key==='bottom'?'%':key==='bg'?'':'px');
    }
    overlay.style.setProperty('--en',cfg.enSize+'px');overlay.style.setProperty('--zh',cfg.zhSize+'px');
    overlay.style.setProperty('--bg',cfg.bg);if(video)layout();
  }
  function layout() {
    syncRoute();
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    // Append INSIDE the active fullscreen element. A sibling outside it disappears in fullscreen.
    const parent = fs && !['VIDEO','IFRAME'].includes(fs.tagName) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    host.hidden = !state.id;
    const videos = [...document.querySelectorAll('video')].filter(v=>v.getBoundingClientRect().width>0).sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height);
    video = videos[0];
    if (!video) {overlay.hidden=true;document.documentElement.classList.remove('zh-dualsubs-active');return;}
    const r=video.getBoundingClientRect();
    // Fit to the actual picture rather than the page or letterbox bars.
    let x=r.left,y=r.top,w=r.width,h=r.height;
    if(video.videoWidth&&video.videoHeight&&getComputedStyle(video).objectFit!=='cover'){
      const scale=Math.min(w/video.videoWidth,h/video.videoHeight);
      const pw=video.videoWidth*scale,ph=video.videoHeight*scale;x+=(w-pw)/2;y+=(h-ph)/2;w=pw;h=ph;
    }
    overlay.style.paddingBottom=(h*cfg.bottom/100)+'px';
    const hr=host.getBoundingClientRect();
    const position=[Math.round(x-hr.left),Math.round(y-hr.top),Math.round(w),Math.round(h)].join(',');
    if(position!==lastLayout){lastLayout=position;overlay.style.left=(x-hr.left)+'px';overlay.style.top=(y-hr.top)+'px';overlay.style.width=w+'px';overlay.style.height=h+'px';}
  }
  function tick() {
    const ready = Boolean(state.id && cfg.enabled && state.en.length && (state.zh.length || wantsTranslation()) && video && video.isConnected && !video.ended);
    overlay.hidden=!ready;
    document.documentElement.classList.toggle('zh-dualsubs-active',ready);
    const time=video ? video.currentTime-cfg.delay : 0;
    const en=ready?at(state.en,time):'',zh=ready?(wantsTranslation()?translatedAt(time):at(state.zh,time)):'';
    const next=en+'\u0000'+zh;
    if(next!==lastText){lastText=next;enLine.textContent=en;zhLine.textContent=zh;}
  }
  function boot(){mount();syncRoute();applyManifest(true);layout();setInterval(layout,350);setInterval(tick,80);setInterval(pumpTranslation,500);document.addEventListener('fullscreenchange',layout);window.addEventListener('resize',layout);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
