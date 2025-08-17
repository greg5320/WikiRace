function normalizeTitleFromInput(text) {
  text = text.trim();
  try {
    const u = new URL(text);
    if (u.pathname && u.pathname.includes('/wiki/')) {
      text = decodeURIComponent(u.pathname.split('/wiki/').slice(1).join('/'));
    }
  } catch (e) {}
  try { text = decodeURIComponent(text); } catch(e){}
  text = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return text;
}

function setStatus(text) {
  document.getElementById('status').innerText = text;
}

document.addEventListener('DOMContentLoaded', () => {
  const targetInput = document.getElementById('targetInput');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const randCheckbox = document.getElementById('randCheckbox');

  chrome.storage.local.get(['running','target','startTime','lastResult'], (res) => {
    if(res.target) targetInput.value = res.target;
    setStatus(res.running ? 'Running' : (res.lastResult ? `Last: ${res.lastResult}` : 'Stopped'));
  });

  startBtn.addEventListener('click', () => {
    const useRandom = randCheckbox.checked;
    const raw = targetInput.value;
    if(useRandom){
      chrome.runtime.sendMessage({ action: 'startRandom' }, (resp) => {
        if(chrome.runtime.lastError){
          alert('Ошибка: ' + chrome.runtime.lastError.message);
        } else {
          setStatus('Running (random)...');
          window.close();
        }
      });
      return;
    }

    if(!raw.trim()){ alert('Введите целевую статью или включите случайный режим.'); return; }
    const target = normalizeTitleFromInput(raw);
    const startTime = Date.now();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      let startUrl = null;
      if(tab && tab.url && tab.url.includes('.wikipedia.org')) {
        startUrl = tab.url;
        chrome.storage.local.set({ running: true, startTime, target }, () => {
          setStatus('Running');
          window.close();
        });
      } else {
        const lang = 'en';
        startUrl = `https://${lang}.wikipedia.org/wiki/Special:Random`;
        chrome.tabs.create({ url: startUrl, active: true }, (newTab) => {
          chrome.storage.local.set({ running: true, startTime, target }, () => {
            setStatus('Running');
            window.close();
          });
        });
      }
    });
  });

  stopBtn.addEventListener('click', () => {
    chrome.storage.local.get(['running','startTime'], (res) => {
      if(!res.running){ setStatus('Already stopped'); return; }
      const elapsed = Date.now() - (res.startTime || Date.now());
      const ms = Math.round(elapsed);
      chrome.storage.local.set({ running: false, lastResult: formatMs(ms) }, () => {
        setStatus('Stopped. Result: ' + formatMs(ms));
      });
    });
  });

  resetBtn.addEventListener('click', () => {
    chrome.storage.local.remove(['running','startTime','target','lastResult'], () => {
      setStatus('Reset');
      targetInput.value = '';
    });
  });
});

function formatMs(ms){
  const totalSec = Math.floor(ms/1000);
  const min = Math.floor(totalSec/60);
  const sec = totalSec%60;
  const tenths = Math.floor((ms%1000)/100);
  return `${min}:${sec.toString().padStart(2,'0')}.${tenths}`;
}
