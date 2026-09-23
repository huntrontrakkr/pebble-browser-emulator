// PebbleKit JS for the network probe: the harness installs Clock's watch binary with
// this script in place of Clock's own, through the libpebble3 phone. Every check uses
// upstream's own XMLHttpRequest and WebSocket against the run's test server on another
// origin (__BASE__ is filled in by the harness), and logs "PROBE ok <name>" or
// "PROBE fail <name>: <why>". Then it sends the summary to the watch as an AppMessage.
var BASE = '__BASE__';
var WS_BASE = BASE.replace(/^http/, 'ws');
var passed = 0;
var failed = 0;

function ok(name) {
  passed++;
  console.log('PROBE ok ' + name);
}
function fail(name, why) {
  failed++;
  console.log('PROBE fail ' + name + ': ' + why);
}
function check(name, condition, detail) {
  if (condition) ok(name);
  else fail(name, detail);
}

function xhr(method, path, options, done) {
  var request = new XMLHttpRequest();
  var finished = false;
  var finish = function (outcome) {
    if (finished) return;
    finished = true;
    try {
      done(request, outcome);
    } catch (error) {
      // The check's watchdog in run() moves the probe on.
      fail(method + ' ' + path, 'check threw ' + error);
    }
  };
  request.open(method, path.indexOf('http') === 0 ? path : BASE + path);
  if (options.responseType) request.responseType = options.responseType;
  Object.keys(options.headers || {}).forEach(function (name) {
    request.setRequestHeader(name, options.headers[name]);
  });
  request.onload = function () {
    finish('load');
  };
  request.onerror = function () {
    finish('error');
  };
  request.onabort = function () {
    finish('abort');
  };
  request.send(options.body);
  return request;
}

var checks = [
  function text(next) {
    xhr('GET', '/net/text?q=pebble', { headers: { 'X-Probe': 'yes' } }, function (r, outcome) {
      check(
        'xhr text',
        outcome === 'load' && r.status === 200 && r.responseText === 'hello pebble, probe yes',
        outcome + ' ' + r.status + ' ' + JSON.stringify(r.responseText),
      );
      check(
        'xhr response header',
        r.getResponseHeader('X-Probe-Server') === 'libpebble3-probe',
        JSON.stringify(r.responseHeaders),
      );
      next();
    });
  },
  function post(next) {
    xhr(
      'POST',
      '/net/echo',
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: 'Zürich', n: 3 }),
      },
      function (r, outcome) {
        var body = {};
        try {
          body = JSON.parse(r.responseText);
        } catch (_) {}
        check(
          'xhr post body',
          body.method === 'POST' &&
            body.contentType === 'application/json' &&
            body.body === '{"city":"Zürich","n":3}',
          outcome + ' ' + r.responseText,
        );
        next();
      },
    );
  },
  function binaryBody(next) {
    // Bytes that are not UTF-8, as a typed array and as an ArrayBuffer.
    xhr(
      'POST',
      '/net/echo-bytes',
      { body: new Uint8Array([0, 255, 128, 10]) },
      function (r, outcome) {
        var body = {};
        try {
          body = JSON.parse(r.responseText);
        } catch (_) {}
        check(
          'xhr binary body',
          outcome === 'load' && body.hex === '00ff800a',
          outcome + ' ' + r.responseText,
        );
        xhr(
          'PUT',
          '/net/echo-bytes',
          { body: new Uint8Array([200, 1, 2]).buffer },
          function (r2, outcome2) {
            var body2 = {};
            try {
              body2 = JSON.parse(r2.responseText);
            } catch (_) {}
            check(
              'xhr ArrayBuffer body',
              outcome2 === 'load' && body2.hex === 'c80102',
              outcome2 + ' ' + r2.responseText,
            );
            next();
          },
        );
      },
    );
  },
  function json(next) {
    xhr('GET', '/net/json', { responseType: 'json' }, function (r, outcome) {
      check(
        'xhr json',
        outcome === 'load' &&
          r.response &&
          r.response.temperature === 21.5 &&
          r.response.conditions === 'Cloudy',
        outcome + ' ' + JSON.stringify(r.response),
      );
      next();
    });
  },
  function bytes(next) {
    xhr('GET', '/net/bytes', { responseType: 'arraybuffer' }, function (r, outcome) {
      var view = r.response ? new Uint8Array(r.response.buffer || r.response) : [];
      var exact = view.length === 256;
      for (var i = 0; exact && i < 256; i++) exact = view[i] === i;
      check('xhr arraybuffer', outcome === 'load' && exact, outcome + ' length ' + view.length);
      next();
    });
  },
  function status404(next) {
    xhr('GET', '/net/missing', {}, function (r, outcome) {
      check(
        'xhr 404 is a response',
        outcome === 'load' && r.status === 404,
        outcome + ' ' + r.status,
      );
      next();
    });
  },
  function refused(next) {
    xhr('GET', '/net/nocors', {}, function (r, outcome) {
      check('xhr without CORS fails', outcome === 'error', outcome + ' ' + r.status);
      next();
    });
  },
  function aborted(next) {
    var r = xhr('GET', '/net/slow', {}, function (_, outcome) {
      check('xhr abort', outcome === 'abort', outcome);
      next();
    });
    setTimeout(function () {
      r.abort();
    }, 100);
  },
  function synchronous(next) {
    // Upstream's manager blocks in send() until the response arrives, then delivers it
    // as events, as it does on iOS.
    var request = new XMLHttpRequest();
    var returned = false;
    request.onload = function () {
      check(
        'sync xhr',
        returned && request.status === 200 && request.responseText === 'hello sync, probe none',
        returned + ' ' + request.status + ' ' + JSON.stringify(request.responseText),
      );
      next();
    };
    request.onerror = function () {
      fail('sync xhr', 'error event');
      next();
    };
    request.open('GET', BASE + '/net/text?q=sync', false);
    try {
      request.send();
      returned = true;
    } catch (error) {
      fail('sync xhr', 'send threw ' + error);
      request.onload = request.onerror = null;
      next();
    }
  },
  function socket(next) {
    var events = [];
    var ws = new WebSocket(WS_BASE + '/net/socket', ['probe.v1', 'other']);
    ws.onopen = function () {
      events.push('open ' + ws.protocol);
      ws.send('ping');
    };
    ws.onmessage = function (event) {
      if (typeof event.data === 'string') {
        events.push('text ' + event.data);
        if (event.data === 'echo ping') ws.send(new Uint8Array([1, 2, 250]).buffer);
      } else {
        var view = new Uint8Array(event.data);
        events.push('bytes ' + Array.prototype.join.call(view, ','));
        ws.send('bye');
      }
    };
    ws.onerror = function () {
      events.push('error');
    };
    ws.onclose = function (event) {
      events.push('close ' + event.code + ' ' + event.reason);
      var expected = [
        'open probe.v1',
        'text echo ping',
        'bytes 250,2,1',
        'text echo bye',
        'close 4001 probe finished',
      ];
      check(
        'websocket',
        JSON.stringify(events) === JSON.stringify(expected),
        JSON.stringify(events),
      );
      next();
    };
  },
  function refusedSocket(next) {
    var events = [];
    var ws = new WebSocket(WS_BASE + '/net/no-socket');
    ws.onerror = function () {
      events.push('error');
    };
    ws.onclose = function (event) {
      events.push('close ' + event.code);
      check('websocket failure reported', events.join() === 'error,close 1006', events.join());
      next();
    };
  },
];

function run(index) {
  if (index < checks.length) {
    var moved = false;
    var advance = function () {
      if (moved) return;
      moved = true;
      clearTimeout(watchdog);
      run(index + 1);
    };
    // A check that never reports fails by name instead of stalling the probe.
    var watchdog = setTimeout(function () {
      fail(checks[index].name, 'no result within 20 s');
      advance();
    }, 20000);
    try {
      checks[index](advance);
    } catch (error) {
      fail(checks[index].name, 'threw ' + error);
      advance();
    }
    return;
  }
  console.log('PROBE done ' + passed + '/' + (passed + failed));
  Pebble.sendAppMessage(
    { DARK_MODE: failed ? 0 : 1, SHOW_DATE: 1, SHOW_BATTERY: passed },
    function () {
      console.log('Network probe acknowledged by watch');
    },
    function () {
      console.log('Network probe rejected by watch');
    },
  );
}

Pebble.addEventListener('ready', function () {
  run(0);
});
