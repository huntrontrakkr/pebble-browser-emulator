// Shared with the PebbleKit JS companion; bundled entirely in the browser.
exports.format = function (position, temperature) {
  var location = position.coords.latitude.toFixed(2) + ', ' + position.coords.longitude.toFixed(2);
  return typeof temperature === 'number' ? temperature + 'C | ' + location : location;
};
