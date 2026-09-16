Pebble.addEventListener('ready', function () {
  Pebble.sendAppMessage({status: 'Browser phone connected'});
});
