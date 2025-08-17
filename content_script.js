const OVERLAY_ID = 'wr-timer-overlay';

const TICK_INTERVAL_MS = 250;
const SEARCH_CHECK_INTERVAL_MS = 1000;

let clickListenerAdded = false;
let tickIntervalId = null;
let searchCheckIntervalId = null;
let cachedEls = {};
let CONTEXT_ALIVE = true;
let CONTEXT_WARNED = false;

let searchBlock = {
  inputs: [],
  forms: [],
  listeners: new Map(),
  keyListener: null,
  blocked: false
};

/* ---------------------- guards for chrome APIs ---------------------- */
function isExtAlive(){
  return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}
function handleContextLost(err){
  if (!CONTEXT_ALIVE) return;
  CONTEXT_ALIVE = false;
  stopTicking();
  stopSearchChecker();
  try { enableSearchUI(); } catch(_) {}
  if (!CONTEXT_WARNED){
    CONTEXT_WARNED = true;
    try { showMessage('Контекст расширения потерян. Обновите страницу.'); } catch(_) {}
  }
  if (err) { try { console.warn('Extension context lost:', err); } catch(_) {} }
}
function storageGet(keys, cb){
  if (!isExtAlive()) return handleContextLost();
  try {
    chrome.storage.local.get(keys, (res) => {
      cb && cb(res || {});
    });
  } catch(e){ handleContextLost(e); }
}
function storageSet(obj, cb){
  if (!isExtAlive()) return handleContextLost();
  try {
    chrome.storage.local.set(obj, () => { cb && cb(); });
  } catch(e){ handleContextLost(e); }
}
function storageRemove(keys, cb){
  if (!isExtAlive()) return handleContextLost();
  try {
    chrome.storage.local.remove(keys, () => { cb && cb(); });
  } catch(e){ handleContextLost(e); }
}
function sendMessageSafe(msg, cb){
  if (!isExtAlive()) return handleContextLost();
  try {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime && chrome.runtime.lastError){
        showMessage('Ошибка: ' + chrome.runtime.lastError.message);
        cb && cb(null);
        return;
      }
      cb && cb(resp);
    });
  } catch(e){ handleContextLost(e); }
}

/* ---------------------- helpers ---------------------- */
function normalizeTitle(s){
  if(!s) return '';
  try { s = decodeURIComponent(s); } catch(e){}
  return s.replace(/_/g, ' ').replace(/\s+/g,' ').trim().toLowerCase();
}
function decodeTitleFromPath(path){
  try { return decodeURIComponent(path).replace(/_/g,' '); } catch(e){ return path.replace(/_/g,' '); }
}
function titleFromUrl(url){
  try {
    const u = new URL(url, location.href);
    if(u.pathname && u.pathname.includes('/wiki/')){
      return decodeTitleFromPath(u.pathname.split('/wiki/').slice(1).join('/'));
    }
  } catch(e){}
  return '';
}
function getCurrentArticleTitle(){
  const h = document.getElementById('firstHeading');
  if(h && h.innerText) return (h.innerText || '').trim();
  if(location.pathname.includes('/wiki/')){
    try { return decodeTitleFromPath(location.pathname.split('/wiki/').slice(1).join('/')); }
    catch(e){ return location.pathname.split('/wiki/').slice(1).join('/').replace(/_/g,' '); }
  }
  return '';
}
function formatMs(ms){
  const totalSec = Math.floor(ms/1000);
  const min = Math.floor(totalSec/60);
  const sec = totalSec % 60;
  const tenths = Math.floor((ms%1000)/100);
  return `${min}:${sec.toString().padStart(2,'0')}.${tenths}`;
}

/* ---------------------- search selectors ---------------------- */
function findSearchInputs(){
  const sel = ['#searchInput', "input[name='search']", "input[type='search']"];
  const found = [];
  for(const s of sel) document.querySelectorAll(s).forEach(el => {
    if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) found.push(el);
  });
  return Array.from(new Set(found));
}
function findSearchForms(){
  const sel = ['#searchform', "form[role='search']", 'form.search', '.vector-search-box form'];
  const found = [];
  for(const s of sel) document.querySelectorAll(s).forEach(f => {
    if(f instanceof HTMLFormElement) found.push(f);
  });
  return Array.from(new Set(found));
}

/* ---------------------- disable/enable search ---------------------- */
function disableSearchUI(){
  if(searchBlock.blocked) return;
  const inputs = findSearchInputs();
  const forms = findSearchForms();

  inputs.forEach(inp => {
    try {
      inp.dataset.wrOldDisabled = inp.disabled ? '1' : '0';
      inp.disabled = true;
      inp.dataset.wrOldPlaceholder = inp.placeholder || '';
      inp.placeholder = 'Search disabled during a game';
    } catch(e){}
  });

  forms.forEach(form => {
    const listener = (ev) => {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      showMessage('Поиск отключён во время игры');
      return false;
    };
    form.addEventListener('submit', listener, true);
    searchBlock.listeners.set(form, listener);
  });

  const keyListener = (ev) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if(tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)) return;
    if(ev.key === '/'){
      storageGet(['running'], (res) => {
        if(res.running){
          ev.preventDefault();
          ev.stopImmediatePropagation();
          showMessage('Поиск временно отключён');
        }
      });
    }
  };
  document.addEventListener('keydown', keyListener, true);

  searchBlock.inputs = inputs;
  searchBlock.forms = forms;
  searchBlock.keyListener = keyListener;
  searchBlock.blocked = true;
}
function enableSearchUI(){
  if(!searchBlock.blocked) return;
  (searchBlock.inputs || []).forEach(inp => {
    try {
      inp.disabled = inp.dataset.wrOldDisabled === '1' ? true : false;
      if(inp.dataset.wrOldPlaceholder !== undefined) inp.placeholder = inp.dataset.wrOldPlaceholder;
      delete inp.dataset.wrOldDisabled;
      delete inp.dataset.wrOldPlaceholder;
    } catch(e){}
  });
  (searchBlock.forms || []).forEach(form => {
    const listener = searchBlock.listeners.get(form);
    if(listener) form.removeEventListener('submit', listener, true);
    searchBlock.listeners.delete(form);
  });
  if(searchBlock.keyListener) document.removeEventListener('keydown', searchBlock.keyListener, true);

  searchBlock.inputs = [];
  searchBlock.forms = [];
  searchBlock.listeners.clear();
  searchBlock.keyListener = null;
  searchBlock.blocked = false;
}

/* ---------------------- overlay UI ---------------------- */
function ensureOverlay(){
  if(document.getElementById(OVERLAY_ID)){
    cacheEls();
    return;
  }
  const div = document.createElement('div');
  div.id = OVERLAY_ID;
  div.innerHTML = `
  <div class="wr-panel">
    <div class="wr-title">WikiRace</div>
    <div class="wr-row"><strong>Target:</strong> <span id="wr-target">—</span></div>
    <div class="wr-row"><strong>Time:</strong> <span id="wr-time">0:00.0</span></div>
    <div class="wr-row"><strong>Clicks:</strong> <span id="wr-clicks">0</span></div>
    <div class="wr-buttons">
      <button id="wr-stop">Stop</button>
      <button id="wr-pause">Pause</button>
      <button id="wr-restart">Start</button>
    </div>
    <div id="wr-message" class="wr-message"></div>
  </div>

  <div id="wr-path-modal" style="display:none; position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); z-index:2147483650;
       background:#fff; border:1px solid #a2a9b1; padding:12px; border-radius:4px; max-width:90%; max-height:80%; overflow:auto; font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#202122;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid #a2a9b1; padding-bottom:4px;">
      <strong style="font-family:'Linux Libertine','Georgia','Times New Roman',serif; font-size:16px; font-weight:normal;">Path to target</strong>
      <button id="wr-path-close" style="margin-left:12px; background:#f8f9fa; border:1px solid #a2a9b1; padding:2px 6px; font-size:12px; cursor:pointer;">Close</button>
    </div>
    <ol id="wr-path-list" style="padding-left:20px;"></ol>
  </div>
`;
  document.body.appendChild(div);
  cacheEls();

  // Stop
  cachedEls.stopBtn.addEventListener('click', () => {
    storageGet(['running','startTime','pauseStart','clickCount'], (res) => {
      if(!res.running){ showMessage('Игра уже остановлена'); return; }
      const endMoment = res.pauseStart ? res.pauseStart : Date.now();
      const elapsed = endMoment - (res.startTime || Date.now());
      const clicks = res.clickCount || 0;
      storageSet({ running: false, lastResult: formatMs(elapsed), lastClicks: clicks }, () => {
        storageRemove(['pauseStart'], () => {
          showMessage('Stopped: ' + formatMs(elapsed) + ' — clicks: ' + clicks);
          updateOverlay();
        });
      });
    });
  });

  // Pause / Resume
  cachedEls.pauseBtn.addEventListener('click', () => {
    storageGet(['running','startTime','pauseStart'], (res) => {
      if(!res.running){ showMessage('Игра не запущена'); return; }
      const isPaused = !!res.pauseStart;
      if(!isPaused){
        storageSet({ pauseStart: Date.now() }, () => { showMessage('Пауза'); updateOverlay(); });
      } else {
        const pauseStart = res.pauseStart;
        if(!pauseStart){ updateOverlay(); return; }
        const pauseDuration = Date.now() - pauseStart;
        const newStart = (res.startTime || Date.now()) + pauseDuration;
        storageSet({ startTime: newStart }, () => {
          storageRemove(['pauseStart'], () => { showMessage('Продолжили'); updateOverlay(); });
        });
      }
    });
  });

 // Start / Restart
 cachedEls.restartBtn.addEventListener('click', () => {
  storageGet(['running'], (res) => {
    const running = !!res.running;
    const action = running ? 'restartRandom' : 'startRandom';
    const lang = detectWikiLangFromLocation() || 'en';

    sendMessageSafe({ action, lang }, (resp) => {
      if (!resp) return;

      storageSet({ clickCount: 0, path: [] }, () => {
        const tgt = resp.target || null;
        showMessage((running ? 'Restarted' : 'Started') + (tgt ? ' — цель: ' + tgt : '…'));
        updateOverlay();
      });
    });
  });
});

  const closeBtn = document.getElementById('wr-path-close');
  if(closeBtn){
    closeBtn.addEventListener('click', () => {
      const modal = document.getElementById('wr-path-modal');
      if(modal) modal.style.display = 'none';
    });
  }
}
function cacheEls(){
  cachedEls.targetEl = document.getElementById('wr-target');
  cachedEls.timeEl = document.getElementById('wr-time');
  cachedEls.clicksEl = document.getElementById('wr-clicks');
  cachedEls.stopBtn = document.getElementById('wr-stop');
  cachedEls.pauseBtn = document.getElementById('wr-pause');
  cachedEls.restartBtn = document.getElementById('wr-restart');
  cachedEls.msgEl = document.getElementById('wr-message');
  cachedEls.pathModal = document.getElementById('wr-path-modal');
  cachedEls.pathList = document.getElementById('wr-path-list');
}
function showMessage(txt){
  if(!cachedEls.msgEl) cachedEls.msgEl = document.getElementById('wr-message');
  if(!cachedEls.msgEl) return;
  cachedEls.msgEl.innerText = txt;
  setTimeout(()=>{ if(cachedEls.msgEl) cachedEls.msgEl.innerText=''; }, 4000);
}
function updateClicksDisplay(count){
  if(!cachedEls.clicksEl) cachedEls.clicksEl = document.getElementById('wr-clicks');
  if(cachedEls.clicksEl) cachedEls.clicksEl.innerText = String(count || 0);
}

/* ---------------------- path helpers ---------------------- */
function appendToPath(title){
  if(!title) return;
  storageGet(['path'], (res) => {
    const p = Array.isArray(res.path) ? res.path.slice() : [];
    if(p.length === 0 || p[p.length-1] !== title){
      p.push(title);
      storageSet({ path: p });
    }
  });
}
function ensurePathInitialized(){
  storageGet(['running','path'], (res) => {
    if(!res.running) return;
    const p = Array.isArray(res.path) ? res.path : [];
    if(p.length === 0){
      const cur = getCurrentArticleTitle() || 'Unknown';
      storageSet({ path: [cur] });
    }
  });
}
function showPathModal(){
  storageGet(['path'], (res) => {
    const p = Array.isArray(res.path) ? res.path : [];
    if(!cachedEls.pathList) cachedEls.pathList = document.getElementById('wr-path-list');
    if(!cachedEls.pathList) return;
    cachedEls.pathList.innerHTML = '';
    p.forEach((t) => {
      const li = document.createElement('li'); li.innerText = t; cachedEls.pathList.appendChild(li);
    });
    if(cachedEls.pathModal) cachedEls.pathModal.style.display = 'block';
  });
}

/* ---------------------- click listener (path + clicks) ---------------------- */
function addLinkClickListenerOnce(){
  if(clickListenerAdded) return;
  clickListenerAdded = true;

  document.addEventListener('click', (e) => {
    try {
      if(e.button !== 0) return;
      if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a');
      if(!a) return;
      const href = a.getAttribute('href') || '';
      if(!href) return;

      let url; try { url = new URL(href, location.href); } catch(err) { return; }
      if(url.hostname !== location.hostname) return;
      if(!url.pathname.includes('/wiki/')) return;
      const after = decodeURIComponent(url.pathname.split('/wiki/').slice(1).join('/'));
      if(after.includes(':')) return;
      const targetAttr = a.getAttribute('target');
      if(targetAttr && targetAttr.toLowerCase() !== '_self') return;

      storageGet(['running','pauseStart','clickCount'], (res) => {
        if(!res.running || res.pauseStart) return;
        const prev = Number(res.clickCount || 0);
        const next = prev + 1;
        const title = titleFromUrl(url.href) || after.replace(/_/g,' ');
        storageSet({ clickCount: next }, () => {
          updateClicksDisplay(next);
          appendToPath(title);
        });
      });
    } catch(_) {}
  }, { capture: true });
}

/* ---------------------- ticker ---------------------- */
function startTicking(){
  if(tickIntervalId) return;
  tickIntervalId = setInterval(() => {
    if(!isExtAlive()) { handleContextLost(); return; }
    storageGet(['running','startTime','target','pauseStart','clickCount','lastResult','path'], (res) => {
      if(!CONTEXT_ALIVE) return;
      const running = !!res.running;
      const startTime = res.startTime || 0;
      const target = res.target || '';
      const pauseStart = res.pauseStart || null;
      const clicks = Number(res.clickCount || 0);
      const lastResult = res.lastResult || '0:00.0';
      const path = Array.isArray(res.path) ? res.path : [];

      if(cachedEls.targetEl) cachedEls.targetEl.innerText = target || '—';
      updateClicksDisplay(clicks);
      if(cachedEls.restartBtn) cachedEls.restartBtn.innerText = running ? 'Restart' : 'Start';

      if(running) disableSearchUI(); else enableSearchUI();

      if(running){
        if(cachedEls.pauseBtn) cachedEls.pauseBtn.disabled = false;
        if(pauseStart){
          const elapsed = pauseStart - startTime;
          if(cachedEls.timeEl) cachedEls.timeEl.innerText = formatMs(elapsed);
          if(cachedEls.pauseBtn) cachedEls.pauseBtn.innerText = 'Resume';
        } else {
          const ms = Date.now() - startTime;
          if(cachedEls.timeEl) cachedEls.timeEl.innerText = formatMs(ms);
          if(cachedEls.pauseBtn) cachedEls.pauseBtn.innerText = 'Pause';
        }
        ensurePathInitialized();
      } else {
        if(cachedEls.pauseBtn) cachedEls.pauseBtn.disabled = true;
        if(cachedEls.timeEl) cachedEls.timeEl.innerText = lastResult;
      }

      if(running && !pauseStart && target){
        const cur = normalizeTitle(getCurrentArticleTitle());
        const tgtNorm = normalizeTitle(target);
        if(cur && cur === tgtNorm){
          const finalClicks = clicks;
          const lastPathEntry = path.length ? normalizeTitle(path[path.length - 1]) : null;

          if(lastPathEntry && lastPathEntry === tgtNorm){
            const total = formatMs(Date.now() - startTime);
            storageSet({ running: false, lastResult: total, lastClicks: finalClicks }, () => {
              if(cachedEls.timeEl) cachedEls.timeEl.innerText = total;
              showMessage('Goal reached! Time: ' + total + ' — clicks: ' + finalClicks);
              enableSearchUI();
              addShowPathButtonIfNeeded();
              updateOverlay();
            });
          } else {
            storageSet({ running: false, lastResult: 'CHEATED', cheated: true, lastClicks: finalClicks }, () => {
              showMessage('Читерил! Победа не засчитана');
              enableSearchUI();
              addShowPathButtonIfNeeded();
              updateOverlay();
            });
          }
        }
      }
    });
  }, TICK_INTERVAL_MS);
}
function stopTicking(){
  if(tickIntervalId){ clearInterval(tickIntervalId); tickIntervalId = null; }
}

/* ---------------------- show-path button ---------------------- */
function addShowPathButtonIfNeeded(){
  if(document.getElementById('wr-showpath')) return;
  const container = document.querySelector('#' + OVERLAY_ID + ' .wr-buttons');
  if(!container) return;
  const btn = document.createElement('button');
  btn.id = 'wr-showpath';
  btn.innerText = 'Show path';
  btn.style.marginLeft = '6px';
  btn.addEventListener('click', () => showPathModal());
  container.appendChild(btn);
}

/* ---------------------- overlay update ---------------------- */
function updateOverlay(){
  storageGet(['running','startTime','target','lastResult','pauseStart','clickCount','lastClicks','path','cheated'], (res) => {
    if(!CONTEXT_ALIVE) return;
    if(cachedEls.targetEl) cachedEls.targetEl.innerText = res.target || '—';
    updateClicksDisplay(Number(res.clickCount || 0));

    if(res.running){
      if(cachedEls.pauseBtn) cachedEls.pauseBtn.disabled = false;
      if(res.pauseStart){ if(cachedEls.pauseBtn) cachedEls.pauseBtn.innerText = 'Resume'; }
      else { if(cachedEls.pauseBtn) cachedEls.pauseBtn.innerText = 'Pause'; }
      if(cachedEls.restartBtn) cachedEls.restartBtn.innerText = 'Restart';
      startTicking();
      ensurePathInitialized();
    } else {
      stopTicking();
      if(cachedEls.pauseBtn) cachedEls.pauseBtn.disabled = true;
      if(cachedEls.restartBtn) cachedEls.restartBtn.innerText = 'Start';
      if(cachedEls.timeEl) cachedEls.timeEl.innerText = res.lastResult || '0:00.0';
      enableSearchUI();
      if(Array.isArray(res.path) && res.path.length > 0 && (res.lastResult || res.cheated)){
        addShowPathButtonIfNeeded();
      }
    }
  });
}

/* ---------------------- periodic search check ---------------------- */
function startSearchChecker(){
  if(searchCheckIntervalId) return;
  searchCheckIntervalId = setInterval(() => {
    if(!isExtAlive()) { handleContextLost(); return; }
    storageGet(['running'], (res) => {
      if(res.running) disableSearchUI(); else enableSearchUI();
    });
  }, SEARCH_CHECK_INTERVAL_MS);
}
function stopSearchChecker(){
  if(searchCheckIntervalId){ clearInterval(searchCheckIntervalId); searchCheckIntervalId = null; }
}

function detectWikiLangFromLocation() {
  try {
    const host = location.hostname.toLowerCase();
    const parts = host.split('.');
    if (parts.slice(-2).join('.') !== 'wikipedia.org') return null;
    const candidates = parts.slice(0, -2).filter(p => p !== 'www' && p !== 'm');
    return candidates[0] || null;
  } catch (e) { return null; }
}

/* ---------------------- init ---------------------- */
ensureOverlay();
addLinkClickListenerOnce();
updateOverlay();
startTicking();
startSearchChecker();

const heading = document.getElementById('firstHeading');
if(heading){
  const obs = new MutationObserver(() => updateOverlay());
  obs.observe(heading, { childList: true, characterData: true, subtree: true });
}
window.addEventListener('popstate', () => { updateOverlay(); });


