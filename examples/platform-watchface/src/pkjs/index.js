var status = require('../common/status');
var keys = require('message_keys');
var endpoint = require('./settings.json').weatherUrl;
var temperature;
var position;
function send() {
  if (!position) return;
  var payload = {};
  payload[keys.status] = status.format(position, temperature);
  Pebble.sendAppMessage(payload, function () {
    console.log('Watch acknowledged status');
  }, function () { console.log('Watch could not receive status'); });
}
Pebble.addEventListener('ready', function () {
  navigator.geolocation.watchPosition(function (next) { position = next; send(); });
  var request = new XMLHttpRequest();
  request.open('GET', endpoint);
  request.onload = function () {
    if (request.status === 200) {
      temperature = JSON.parse(request.responseText).temperature;
      send();
    }
  };
  request.onerror = function () { console.log('Weather unavailable; showing location'); };
  request.send();
});
