// SPDX-License-Identifier: GPL-3.0-only
import {
  configurationPage,
  navigationResult,
  validStorage,
  CONFIGURATION_LIMIT,
} from './configuration-page.mjs';
const frame = document.getElementById('configuration-page');
const status = document.getElementById('status');
const externalButton = document.getElementById('open-external');
const token = new URL(location.href).searchParams.get('session');
const origin = location.origin;
let request,
  open,
  navigate,
  completed = false,
  channel,
  pageTimeout;
const reply = (type, extra = {}) => parent.postMessage({ type, session: token, ...extra }, origin);
const setError = (message) => {
  status.textContent = message;
  status.style.display = 'block';
};
function receiveReturn(data) {
  try {
    const url = navigationResult(data, token);
    if (url && !completed) navigate?.(url);
  } catch (error) {
    setError(error.message);
  }
}
addEventListener('message', ({ source, origin: senderOrigin, data }) => {
  if (
    source === parent &&
    senderOrigin === origin &&
    data?.session === token &&
    data.type === 'configure'
  ) {
    if (
      request ||
      typeof data.url !== 'string' ||
      typeof data.appId !== 'string' ||
      typeof data.title !== 'string'
    )
      return;
    request = data;
    if (open) open(data.url, data.title);
    return;
  }
  if (source !== frame.contentWindow || data?.session !== token || completed) return;
  if (data.kind === 'pebble-config-navigation') receiveReturn(data);
  if (data.kind === 'pebble-config-loaded') {
    clearTimeout(pageTimeout);
    status.textContent = '';
  }
  if (data.kind === 'pebble-config-error')
    setError('The configuration page reported an error. You can close it and try again.');
  if (data.kind === 'pebble-config-storage' && request && validStorage(data.storage)) {
    try {
      localStorage.setItem('pebble.webview.' + request.appId, JSON.stringify(data.storage));
    } catch {
      setError('This browser could not save configuration-page storage.');
    }
  }
});
window.phonePort = {
  bind(openPage, intercept) {
    open = openPage;
    navigate = intercept;
    if (request) open(request.url, request.title);
    reply('phone-app-ready');
  },
  showPage(url) {
    if (!request || completed) return;
    try {
      const callback = new URL('return.html', location.href);
      callback.searchParams.set('session', token);
      let storage = {};
      try {
        storage = JSON.parse(localStorage.getItem('pebble.webview.' + request.appId) ?? '{}');
      } catch {}
      if (!validStorage(storage)) storage = {};
      // Keep all response data in the fragment, including legacy /? and / close forms.
      // Only the session nonce reaches the static server in the callback request.
      const page = configurationPage(url, callback.href + '#', token, storage);
      frame.removeAttribute('src');
      frame.removeAttribute('srcdoc');
      if (page.external) frame.src = page.url;
      else frame.srcdoc = page.html;
      frame.style.display = 'block';
      status.textContent = 'Opening configuration…';
      externalButton.style.display = page.external ? 'block' : 'none';
      externalButton.onclick = () => window.open(page.url, '_blank', 'noopener,noreferrer');
      clearTimeout(pageTimeout);
      pageTimeout = setTimeout(() => {
        if (page.external)
          setError(
            'If this page is blank or cannot save, open it in a new tab. Some sites block embedded pages.',
          );
      }, 8000);
      frame.onload = () => {
        status.textContent = '';
        if (!page.external) clearTimeout(pageTimeout);
      };
      reply('phone-page-opened', { external: page.external });
    } catch (error) {
      setError(error.message);
      reply('phone-app-error', { message: error.message });
    }
  },
  resize(x, y, width, height) {
    // The native app's WebView occupies a separate surface. Keep the web canvas above it,
    // avoiding Chromium's occlusion of a WebGL canvas underneath an opaque child frame.
    document.getElementById('phone-screen').style.height = y + 'px';
    Object.assign(frame.style, {
      left: x + 'px',
      top: y + 'px',
      width: width + 'px',
      height: `calc(100% - ${y}px)`,
    });
  },
  close(response) {
    if (!request || completed) return;
    if (
      response !== null &&
      (typeof response !== 'string' ||
        new TextEncoder().encode(response).length > CONFIGURATION_LIMIT)
    )
      return setError('Configuration return exceeds 512 KiB.');
    completed = true;
    clearTimeout(pageTimeout);
    channel?.postMessage({ kind: 'pebble-config-complete', session: token });
    channel?.close();
    frame.removeAttribute('srcdoc');
    frame.src = 'about:blank';
    reply('configuration-result', { response });
  },
  error: setError,
};
try {
  channel = new BroadcastChannel('pebble-config-' + token);
  channel.onmessage = ({ data }) => receiveReturn(data);
} catch {}
const script = document.createElement('script');
script.src = 'pebble-phone.js';
script.onerror = () => {
  setError('The Pebble app module could not load. Close settings and try again.');
  reply('phone-app-error', { message: status.textContent });
};
document.body.append(script);
addEventListener('pagehide', () => {
  clearTimeout(pageTimeout);
  channel?.close();
});
