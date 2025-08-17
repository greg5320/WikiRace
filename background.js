
function deriveLangFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = host.split('.');
    if (parts.length < 3) return null;
    if (parts.slice(-2).join('.') !== 'wikipedia.org') return null;
    const candidates = parts.slice(0, -2).filter(p => p !== 'www' && p !== 'm');
    return candidates[0] || null;
  } catch (e) { return null; }
}

async function pickLang(preferred, senderTabUrl) {
  if (preferred && typeof preferred === 'string') return preferred.toLowerCase();
  const fromSender = deriveLangFromUrl(senderTabUrl || '');
  if (fromSender) return fromSender;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const fromActive = deriveLangFromUrl(tab?.url || '');
    if (fromActive) return fromActive;
  } catch (_) {}
  return 'en';
}

async function fetchRandomTitle(lang) {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=random&grnnamespace=0&grnlimit=1&grnfilterredir=nonredirects&prop=info`;
  try {
    const r = await fetch(api);
    const data = await r.json();
    const pages = data?.query?.pages || {};
    const first = Object.values(pages)[0];
    return first?.title || null;
  } catch (_) {
    return null;
  }
}

async function startOrRestartGame(lang, tabIdFallback) {
  const base = `https://${lang}.wikipedia.org`;
  const startUrl = `${base}/wiki/Special:Random`;
  let targetTitle = await fetchRandomTitle(lang);
  if (!targetTitle) targetTitle = 'Main Page';

  await chrome.storage.local.set({
    running: true,
    pauseStart: null,
    startTime: Date.now(),
    target: targetTitle,
    clickCount: 0,
    path: [],
    cheated: false,
    lang,
    startUrl,
    targetUrl: `${base}/wiki/${encodeURIComponent(targetTitle.replace(/ /g, '_'))}`,
  });

  try {
    if (typeof tabIdFallback === 'number') {
      await chrome.tabs.update(tabIdFallback, { url: startUrl });
    } else {
      await chrome.tabs.create({ url: startUrl, active: true });
    }
  } catch (_) {}

  return { target: targetTitle, lang };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'startRandom' || msg?.action === 'restartRandom') {
    (async () => {
      const lang = await pickLang(msg.lang, sender?.tab?.url);
      const res = await startOrRestartGame(lang, sender?.tab?.id);
      sendResponse({ ok: true, ...res });
    })();
    return true;
  }
});
