// SPDX-License-Identifier: GPL-3.0-only
const url = new URL(location.href);
const session = url.searchParams.get('session');
const marker = location.href.indexOf('#');
if (session && /^[\da-f-]{36}$/.test(session) && marker >= 0) {
  const data = {
    kind: 'pebble-config-navigation',
    session,
    url: 'pebblejs://close' + location.href.slice(marker + 1),
  };
  if (parent !== window) parent.postMessage(data, location.origin);
  try {
    const channel = new BroadcastChannel('pebble-config-' + session);
    const timer = setTimeout(() => {
      document.querySelector('p').textContent =
        'The settings session did not respond. Return to the watch preview and reopen App settings.';
      channel.close();
    }, 4000);
    channel.onmessage = ({ data }) => {
      if (data?.kind !== 'pebble-config-complete' || data.session !== session) return;
      clearTimeout(timer);
      channel.close();
      document.querySelector('p').textContent =
        'Settings returned. You can return to the watch preview.';
    };
    channel.postMessage(data);
  } catch {}
} else
  document.querySelector('p').textContent = 'This configuration return has expired or is invalid.';
