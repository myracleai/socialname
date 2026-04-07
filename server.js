const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_HOST = process.env.PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '12321');
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── DIRECT FETCH ──────────────────────────────────────────────────────────────
function fetchDirect(url, opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve({ status: null, body: '' }); }, 9000);
    var parsed;
    try { parsed = new URL(url); } catch(e) { clearTimeout(timer); resolve({ status: null, body: '' }); return; }
    var lib = url.startsWith('https') ? https : http;
    var body = '';
    var req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: (parsed.pathname || '/') + (parsed.search || ''),
      method: 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }, opts.headers || {}),
      timeout: 8000
    }, function(res) {
      var status = res.statusCode;
      var loc = res.headers['location'] || '';
      if ([301,302,303,307,308].indexOf(status) !== -1 && loc && !opts.noRedirect) {
        clearTimeout(timer);
        var next = loc.startsWith('http') ? loc : ('https://' + parsed.hostname + loc);
        fetchDirect(next, Object.assign({}, opts, { noRedirect: true })).then(resolve).catch(function() { resolve({ status: status, body: '' }); });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', function(c) { if (body.length < 100000) body += c; });
      res.on('end', function() { clearTimeout(timer); resolve({ status: status, body: body }); });
    });
    req.on('error', function() { clearTimeout(timer); resolve({ status: null, body: '' }); });
    req.on('timeout', function() { clearTimeout(timer); req.destroy(); resolve({ status: null, body: '' }); });
    req.end();
  });
}

// ── PROXY FETCH ───────────────────────────────────────────────────────────────
function fetchProxy(targetUrl, opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var done = false;
    function finish(r) { if (!done) { done = true; clearTimeout(timer); resolve(r); } }
    var timer = setTimeout(function() {
      console.log('PROXY TIMEOUT:', targetUrl.substring(0, 60));
      finish({ status: null, body: '' });
    }, 12000);

    var parsed;
    try { parsed = new URL(targetUrl); } catch(e) { finish({ status: null, body: '' }); return; }

    var auth = 'Basic ' + Buffer.from(PROXY_USER + ':' + PROXY_PASS).toString('base64');
    var targetHost = parsed.hostname;
    var targetPort = 443;
    var urlPath = (parsed.pathname || '/') + (parsed.search || '');

    var reqHeaders = Object.assign({
      'Host': targetHost,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Connection': 'close'
    }, opts.headers || {});

    var socket = net.createConnection(PROXY_PORT, PROXY_HOST);
    socket.setTimeout(10000);
    socket.on('timeout', function() { socket.destroy(); finish({ status: null, body: '' }); });
    socket.on('error', function(e) {
      console.log('PROXY SOCK ERR:', e.message);
      finish({ status: null, body: '' });
    });

    socket.on('connect', function() {
      var auth_header = 'Basic ' + Buffer.from(PROXY_USER + ':' + PROXY_PASS).toString('base64');
      socket.write(
        'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\n' +
        'Host: ' + targetHost + ':' + targetPort + '\r\n' +
        'Proxy-Authorization: ' + auth_header + '\r\n' +
        '\r\n'
      );

      var respBuf = Buffer.alloc(0);
      socket.on('data', function onData(chunk) {
        respBuf = Buffer.concat([respBuf, chunk]);
        var str = respBuf.toString('utf8');
        var endIdx = str.indexOf('\r\n\r\n');
        if (endIdx === -1) return;

        socket.removeListener('data', onData);
        var firstLine = str.split('\r\n')[0];
        var m = firstLine.match(/HTTP\/[\d.]+ (\d+)/);
        var code = m ? parseInt(m[1]) : 0;
        console.log('PROXY CONNECT:', code, targetHost);

        if (code !== 200) {
          socket.destroy();
          finish({ status: null, body: '' });
          return;
        }

        var tlsSock = tls.connect({
          socket: socket,
          host: targetHost,
          servername: targetHost,
          rejectUnauthorized: false
        });
        tlsSock.on('error', function(e) {
          console.log('TLS ERR:', e.message);
          finish({ status: null, body: '' });
        });
        tlsSock.on('secureConnect', function() {
          var lines = ['GET ' + urlPath + ' HTTP/1.1'];
          Object.keys(reqHeaders).forEach(function(k) { lines.push(k + ': ' + reqHeaders[k]); });
          lines.push('', '');
          tlsSock.write(lines.join('\r\n'));

          var bufs = [];
          tlsSock.on('data', function(d) {
            bufs.push(d);
            var tot = bufs.reduce(function(a, b) { return a + b.length; }, 0);
            if (tot > 500000) tlsSock.destroy();
          });

          function onEnd() {
            if (bufs.length === 0) { finish({ status: null, body: '' }); return; }
            var full = Buffer.concat(bufs).toString('utf8');
            var sep = full.indexOf('\r\n\r\n');
            if (sep === -1) { finish({ status: null, body: '' }); return; }
            var hdr = full.substring(0, sep);
            var body = full.substring(sep + 4);
            var sm = hdr.match(/HTTP\/[\d.]+ (\d+)/);
            var status = sm ? parseInt(sm[1]) : null;
            var lm = hdr.match(/[Ll]ocation: ?([^\r\n]+)/);
            var loc = lm ? lm[1].trim() : '';
            console.log('PROXY RESULT:', status, targetUrl.substring(0, 60));

            if ([301,302,307,308].indexOf(status) !== -1 && loc && !opts.noRedirect) {
              var next = loc.startsWith('http') ? loc : ('https://' + targetHost + loc);
              fetchProxy(next, Object.assign({}, opts, { noRedirect: true })).then(finish).catch(function() { finish({ status: status, body: '' }); });
            } else {
              finish({ status: status, body: body });
            }
          }

          var ended = false;
          tlsSock.on('end', function() { if (!ended) { ended = true; onEnd(); } });
          tlsSock.on('close', function() { if (!ended) { ended = true; onEnd(); } });
          tlsSock.on('error', function(e) { console.log('REQ ERR:', e.message); finish({ status: null, body: '' }); });
        });
      });
    });
  });
}

function has(b, terms) {
  var s = (b || '').toLowerCase();
  return terms.some(function(t) { return s.indexOf(t.toLowerCase()) !== -1; });
}
function byStatus(s, tk, av) {
  if (!s) return 'un';
  if ((av || [404]).indexOf(s) !== -1) return 'av';
  if ((tk || [200]).indexOf(s) !== -1) return 'tk';
  return 'un';
}

// ── TEST ENDPOINT ─────────────────────────────────────────────────────────────
app.get('/test', async function(req, res) {
  var u = req.query.u || 'xkqz9mw2randomtest999';
  var logs = [];

  // Test TikTok
  var tt = await fetchProxy('https://www.tiktok.com/oembed?url=https://www.tiktok.com/@' + u, { headers: { 'Accept': 'application/json' } });
  logs.push({ p: 'tiktok_oembed', status: tt.status, body: tt.body.substring(0, 200) });

  // Test Threads
  var th = await fetchProxy('https://www.threads.net/@' + u);
  logs.push({ p: 'threads', status: th.status, len: th.body.length,
    hasUser: th.body.indexOf('"username":"' + u + '"') !== -1,
    hasError: th.body.indexOf('not found') !== -1 || th.body.indexOf('errorTitle') !== -1,
    snippet: th.body.substring(50000, 50300)
  });

  // Test Twitter/X
  var tw = await fetchProxy('https://x.com/' + u);
  logs.push({ p: 'twitter', status: tw.status, len: tw.body.length,
    hasNotExist: tw.body.indexOf("doesn't exist") !== -1,
    hasNotFound: tw.body.indexOf('not_found') !== -1,
    snippet: tw.body.substring(0, 300)
  });

  // Test Telegram
  var tg = await fetchProxy('https://t.me/' + u);
  logs.push({ p: 'telegram', status: tg.status, len: tg.body.length,
    hasPageTitle: tg.body.indexOf('tgme_page_title') !== -1,
    hasIfYouHave: tg.body.indexOf('If you have Telegram') !== -1,
    snippet: tg.body.substring(0, 400)
  });

  // Test LinkedIn
  var li = await fetchProxy('https://www.linkedin.com/in/' + u + '/');
  logs.push({ p: 'linkedin', status: li.status, len: li.body.length, snippet: li.body.substring(0, 200) });

  // Test Quora
  var qr = await fetchProxy('https://www.quora.com/profile/' + u);
  logs.push({ p: 'quora', status: qr.status, len: qr.body.length,
    hasNotFound: qr.body.indexOf('Page Not Found') !== -1 || qr.body.indexOf("doesn't exist") !== -1,
    snippet: qr.body.substring(0, 300)
  });

  // Test ProductHunt
  var ph = await fetchProxy('https://www.producthunt.com/@' + u);
  logs.push({ p: 'producthunt', status: ph.status, len: ph.body.length, snippet: ph.body.substring(0, 200) });

  // Test Tumblr
  var tu = await fetchProxy('https://' + u + '.tumblr.com');
  logs.push({ p: 'tumblr', status: tu.status, len: tu.body.length,
    hasNothing: tu.body.indexOf("There's nothing here") !== -1,
    snippet: tu.body.substring(0, 200)
  });

  res.json({ username: u, results: logs });
});


app.get('/check', async function(req, res) {
  var u = (req.query.username || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  var pl = (req.query.platform || '').toLowerCase();
  if (!u || !pl) { res.json({ result: 'un' }); return; }
  var checker = CHECKERS[pl];
  if (!checker) { res.json({ result: 'un' }); return; }
  try {
    var result = await checker(u);
    console.log(pl, u, '->', result);
    res.json({ result: result });
  } catch(e) {
    console.log('Error:', pl, u, e.message);
    res.json({ result: 'un' });
  }
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', proxy: PROXY_HOST + ':' + PROXY_PORT, user: PROXY_USER ? 'set' : 'NOT SET' });
});

app.listen(PORT, function() {
  console.log('Checker API on port', PORT);
});
