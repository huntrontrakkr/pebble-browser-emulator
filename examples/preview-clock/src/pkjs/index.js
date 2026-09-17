// SPDX-License-Identifier: Apache-2.0
var defaults = { DARK_MODE: 0, SHOW_DATE: 1, SHOW_BATTERY: 1 };
function settings() {
  try {
    return JSON.parse(localStorage.getItem('settings')) || defaults;
  } catch (_) {
    return defaults;
  }
}
function send(values) {
  Pebble.sendAppMessage(
    values,
    function () {
      console.log('Clock settings acknowledged by watch');
    },
    function () {
      console.log('Clock settings rejected by watch');
    },
  );
}
Pebble.addEventListener('ready', function () {
  if (localStorage.getItem('settings')) send(settings());
});
Pebble.addEventListener('showConfiguration', function () {
  var html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Clock settings</title>' +
    '<style>body{font:16px/1.5 system-ui;margin:0;color:#20242a;background:#fff}main{padding:24px}' +
    'h1{font-size:22px;margin:0 0 24px}label{display:flex;justify-content:space-between;gap:12px;padding:18px 0;border-bottom:1px solid #e4e6e8}' +
    'input{width:22px;height:22px;accent-color:#275dc4}button{font:inherit;padding:12px;border-radius:8px;border:1px solid #d4d8dd;background:white;cursor:pointer}' +
    '.actions{display:flex;gap:12px;margin-top:28px}.actions button{flex:1}button[type=submit]{background:#275dc4;color:white;border-color:#275dc4}</style></head>' +
    '<body><main><h1>Clock</h1><form><label>Dark background<input id="DARK_MODE" type="checkbox"></label>' +
    '<label>Show date<input id="SHOW_DATE" type="checkbox"></label><label>Show battery<input id="SHOW_BATTERY" type="checkbox"></label>' +
    '<div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">Save</button></div></form></main>' +
    '<script>var values=' +
    JSON.stringify(settings()) +
    ';Object.keys(values).forEach(function(key){document.getElementById(key).checked=!!values[key]});' +
    'document.querySelector("form").onsubmit=function(e){e.preventDefault();Object.keys(values).forEach(function(key){values[key]=+document.getElementById(key).checked});' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(values))};' +
    'document.getElementById("cancel").onclick=function(){location.href="pebblejs://close"};<\/script></body></html>';
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});
Pebble.addEventListener('webviewclosed', function (event) {
  if (!event.response) return;
  var values;
  // Current companion decodes once; historical hosts may deliver the encoded fragment.
  try {
    values = JSON.parse(event.response);
  } catch (_) {
    values = JSON.parse(decodeURIComponent(event.response));
  }
  var next = {};
  Object.keys(defaults).forEach(function (key) {
    next[key] = values[key] ? 1 : 0;
  });
  localStorage.setItem('settings', JSON.stringify(next));
  send(next);
});
