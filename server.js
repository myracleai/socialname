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

function fetchProxy(targetUrl, opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var done = false;
    function finish(r) { if (!done) { done = true; clearTimeout(timer); resolve(r); } }
    var timer = setTimeout(function() { finish({ status: null, body: '' }); }, 12000);
    var parsed;
    try { parsed = new URL(targetUrl); } catch(e) { finish({ status: null, body: '' }); return; }
    var auth = 'Basic ' + Buffer.from(PROXY_USER + ':' + PROXY_PASS).toString('base64');
    var targetHost = parsed.hostname;
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
    socket.on('error', function(e) { console.log('SOCK ERR:', e.message); finish({ status: null, body: '' }); });
    socket.on('connect', function() {
      socket.write('CONNECT ' + targetHost + ':443 HTTP/1.1\r\nHost: ' + targetHost + ':443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
      var respBuf = Buffer.alloc(0);
      socket.on('data', function onData(chunk) {
        respBuf = Buffer.concat([respBuf, chunk]);
        var str = respBuf.toString('utf8');
        if (str.indexOf('\r\n\r\n') === -1) return;
        socket.removeListener('data', onData);
        var firstLine = str.split('\r\n')[0];
        var m = firstLine.match(/HTTP\/[\d.]+ (\d+)/);
        var code = m ? parseInt(m[1]) : 0;
        if (code !== 200) { socket.destroy(); finish({ status: null, body: '' }); return; }
        var tlsSock = tls.connect({ socket: socket, host: targetHost, servername: targetHost, rejectUnauthorized: false });
        tlsSock.on('error', function(e) { finish({ status: null, body: '' }); });
        tlsSock.on('secureConnect', function() {
          var lines = ['GET ' + urlPath + ' HTTP/1.1'];
          Object.keys(reqHeaders).forEach(function(k) { lines.push(k + ': ' + reqHeaders[k]); });
          lines.push('', '');
          tlsSock.write(lines.join('\r\n'));
          var bufs = [];
          tlsSock.on('data', function(d) { bufs.push(d); if (bufs.reduce(function(a,b){return a+b.length;},0) > 600000) tlsSock.destroy(); });
          function onEnd() {
            if (!bufs.length) { finish({ status: null, body: '' }); return; }
            var full = Buffer.concat(bufs).toString('utf8');
            var sep = full.indexOf('\r\n\r\n');
            if (sep === -1) { finish({ status: null, body: '' }); return; }
            var hdr = full.substring(0, sep);
            var body = full.substring(sep + 4);
            var sm = hdr.match(/HTTP\/[\d.]+ (\d+)/);
            var status = sm ? parseInt(sm[1]) : null;
            var lm = hdr.match(/[Ll]ocation: ?([^\r\n]+)/);
            var loc = lm ? lm[1].trim() : '';
            if ([301,302,307,308].indexOf(status) !== -1 && loc && !opts.noRedirect) {
              var next = loc.startsWith('http') ? loc : ('https://' + targetHost + loc);
              fetchProxy(next, Object.assign({}, opts, { noRedirect: true })).then(finish).catch(function() { finish({ status: status, body: '' }); });
            } else { finish({ status: status, body: body }); }
          }
          var ended = false;
          tlsSock.on('end', function() { if (!ended) { ended = true; onEnd(); } });
          tlsSock.on('close', function() { if (!ended) { ended = true; onEnd(); } });
          tlsSock.on('error', function() { finish({ status: null, body: '' }); });
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

var CHECKERS = {

  // ── CONFIRMED WORKING VIA PROXY ───────────────────────────────────────────

  // TikTok: oEmbed 400=available, 200+author_name=taken — CONFIRMED
  tiktok: async function(u) {
    var r = await fetchProxy('https://www.tiktok.com/oembed?url=https://www.tiktok.com/@' + u, {
      headers: { 'Accept': 'application/json' }
    });
    if (r.status === 200) { try { var d = JSON.parse(r.body); if (d.author_name) return 'tk'; } catch(e) {} }
    if (r.status === 400 || r.status === 404) return 'av';
    return 'un';
  },

  // Threads: both 200, but missing has error text in body — CONFIRMED
  threads: async function(u) {
    var r = await fetchProxy('https://www.threads.net/@' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) {
      // Missing: hasError=true (contains 'not found' or 'errorTitle')
      // Taken: hasError=false, larger body
      if (has(r.body, ['not found', 'errorTitle', 'Page Not Found', '"errorCode"'])) return 'av';
      if (r.body.length > 200000) return 'tk'; // Real profiles have large bodies
      return 'un';
    }
    return 'un';
  },

  // ProductHunt: 404=available, 200=taken — CONFIRMED
  producthunt: async function(u) {
    var r = await fetchProxy('https://www.producthunt.com/@' + u);
    return byStatus(r.status, [200], [404]);
  },

  // Tumblr: 404=available — CONFIRMED
  tumblr: async function(u) {
    var r = await fetchProxy('https://' + u + '.tumblr.com');
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ["There's nothing here", 'not found'])) return 'av'; return 'tk'; }
    return 'un';
  },

  // YouTube: 404=available, 200=taken — CONFIRMED from earlier test
  youtube: async function(u) {
    var r = await fetchProxy('https://www.youtube.com/@' + u);
    return byStatus(r.status, [200], [404]);
  },

  // Snapchat: 404=available, 200=taken — CONFIRMED from earlier test
  snapchat: async function(u) {
    var r = await fetchProxy('https://www.snapchat.com/add/' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) {
      // Snapchat 404 page sometimes returns 200 - check body
      if (has(r.body, ["doesn't exist", 'not found', 'no longer active', 'This link has expired'])) return 'av';
      if (has(r.body, ['snapcode', 'bitmoji', 'sc-landing', 'snapchat.com/add/' + u])) return 'tk';
      if (r.body.length > 50000) return 'tk';
      return 'un';
    }
    return 'un';
  },

  // Pinterest: 404=available, 200=taken
  pinterest: async function(u) {
    var r = await fetchProxy('https://www.pinterest.com/' + u + '/');
    return byStatus(r.status, [200], [404]);
  },

  // ── INSTAGRAM — proxy returns same 498KB shell for both, use direct ────────
  // Direct test showed: taken=200 status, missing=200 status
  // BUT Instagram's signup check endpoint (no proxy) returns proper JSON
  // when not rate limited. Use it with retry logic.
  instagram: async function(u) {
    // Try direct signup check (works when not rate limited)
    var r = await fetchDirect('https://www.instagram.com/api/v1/users/check_username/?username=' + u, {
      headers: {
        'X-CSRFToken': 'missing',
        'X-IG-App-ID': '936619743392459',
        'Accept': 'application/json',
        'Referer': 'https://www.instagram.com/'
      }
    });
    if (r.status === 200) {
      try {
        var d = JSON.parse(r.body);
        if (d.available === true) return 'av';
        if (d.available === false) return 'tk';
      } catch(e) {}
    }
    // Fallback: direct profile page (Netlify can reach Instagram directly)
    var r2 = await fetchDirect('https://www.instagram.com/' + u + '/');
    if (r2.status === 404) return 'av';
    if (r2.status === 200) {
      if (has(r2.body, ["Sorry, this page isn't available", '"pageType":"ErrorPage"'])) return 'av';
      if (r2.body.length > 100000) return 'tk'; // Large body = real profile loaded
      return 'un';
    }
    return 'un';
  },

  // ── FACEBOOK — proxy returns 400 always, direct works partially ────────────
  facebook: async function(u) {
    // Facebook returns 400 for all requests from servers (both taken and missing)
    // Use Facebook's public search API which is more permissive
    var r = await fetchProxy('https://www.facebook.com/search/top?q=' + encodeURIComponent(u));
    if (r.status === 200 && r.body.length > 50000) {
      if (has(r.body, ['"profile_url":"https://www.facebook.com/' + u + '"', '"vanity":"' + u + '"'])) return 'tk';
    }
    // Try graph API without token (works for public pages)
    var r2 = await fetchProxy('https://graph.facebook.com/' + u + '?fields=id,name');
    if (r2.status === 200) {
      try { var d = JSON.parse(r2.body); if (d.id) return 'tk'; } catch(e) {}
    }
    if (r2.status === 404) return 'av';
    return 'un';
  },

  // ── TWITTER — both return hasNotFound:true (it's in the JS bundle)
  // Use proxy with different endpoint: Twitter card API
  twitter: async function(u) {
    // X serves same JS shell for both taken and missing
    // Use Nitter instance as proxy-friendly alternative
    var r = await fetchProxy('https://nitter.poast.org/' + u);
    if (r.status === 200) {
      if (has(r.body, ['User not found', 'user not found', 'No results', 'could not be found'])) return 'av';
      if (has(r.body, ['timeline', 'tweet', '@' + u])) return 'tk';
    }
    if (r.status === 404) return 'av';
    // Fallback: try Twitter's own endpoint that returns user data without auth
    var r2 = await fetchProxy('https://x.com/i/api/graphql/SAMkL5y_N9pmahSw8yy6bg/UserByScreenName?variables=%7B%22screen_name%22%3A%22' + u + '%22%7D');
    if (r2.status === 200) {
      if (has(r2.body, ['"rest_id"', '"name"'])) return 'tk';
      if (has(r2.body, ['"User_unavailable"', 'user not found'])) return 'av';
    }
    return 'un';
  },

  // ── TELEGRAM — both return 200 with similar size, use direct which works
  telegram: async function(u) {
    var r = await fetchDirect('https://t.me/' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) {
      if (has(r.body, ['tgme_page_title', 'View in Telegram', 'tg://resolve'])) return 'tk';
      if (has(r.body, ['If you have Telegram', 'tgme_page_description'])) return 'av';
      // Both return similar JS redirect pages - check title
      if (r.body.indexOf('tgme_page') !== -1) return 'tk';
      return 'un';
    }
    return 'un';
  },

  // ── LINKEDIN — proxy drops, direct returns 999, cannot check reliably ──────
  linkedin: async function(u) {
    // LinkedIn returns 999 for bots and null for proxy - try their public API
    var r = await fetchProxy('https://www.linkedin.com/voyager/api/identity/profiles/' + u);
    if (r.status === 200) return 'tk';
    if (r.status === 404) return 'av';
    // Try public profile URL with different user agent
    var r2 = await fetchProxy('https://www.linkedin.com/in/' + u + '/', {
      headers: {
        'User-Agent': 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient/4.5.4 +http://www.linkedin.com)',
        'Accept': 'text/html'
      }
    });
    if (r2.status === 404) return 'av';
    if (r2.status === 200) {
      if (has(r2.body, ['Page not found', 'profile is not available'])) return 'av';
      if (r2.body.length > 50000) return 'tk';
    }
    return 'un';
  },

  // ── QUORA — Cloudflare blocks proxy (403), direct also blocked ─────────────
  quora: async function(u) {
    // Quora uses Cloudflare which returns 403 for all server requests
    // Try their mobile API which is less protected
    var r = await fetchProxy('https://www.quora.com/_/api/mobile_api_gateway?queries=[{"query":"UserFollowerCount","variables":{"uid":"' + u + '"}}]', {
      headers: { 'Accept': 'application/json', 'quora-page-creation-time': '0' }
    });
    if (r.status === 200) {
      if (has(r.body, ['"error"', 'not found'])) return 'av';
      return 'tk';
    }
    // Fallback: try quora profile with googlebot UA
    var r2 = await fetchProxy('https://www.quora.com/profile/' + u, {
      headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
    });
    if (r2.status === 404) return 'av';
    if (r2.status === 200) {
      if (has(r2.body, ['Page Not Found', "doesn't exist", 'not found'])) return 'av';
      if (r2.body.length > 50000) return 'tk';
    }
    return 'un';
  },

  // ── DIRECT API CHECKS (reliable, no proxy needed) ─────────────────────────
  reddit: async function(u) {
    var r = await fetchDirect('https://www.reddit.com/user/' + u + '/about.json', { headers: { 'Accept': 'application/json' } });
    if (r.status === 200) { if (has(r.body, ['"error": 404', '"error":404'])) return 'av'; return 'tk'; }
    return byStatus(r.status, [200], [404]);
  },

  github: async function(u) {
    var r = await fetchDirect('https://api.github.com/users/' + u, { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'socialname-checker' } });
    return byStatus(r.status, [200], [404]);
  },
  reddit: async function(u) {
    var r = await fetchDirect('https://www.reddit.com/user/' + u + '/about.json', { headers: { 'Accept': 'application/json' } });
    if (r.status === 200) { if (has(r.body, ['"error": 404', '"error":404'])) return 'av'; return 'tk'; }
    return byStatus(r.status, [200], [404]);
  },
  mastodon: async function(u) {
    var r = await fetchDirect('https://mastodon.social/api/v1/accounts/lookup?acct=' + u, { headers: { 'Accept': 'application/json' } });
    return byStatus(r.status, [200], [404, 422]);
  },
  bluesky: async function(u) {
    var r = await fetchDirect('https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=' + u + '.bsky.social');
    return byStatus(r.status, [200], [400, 404]);
  },
  hackernews: async function(u) {
    var r = await fetchDirect('https://hacker-news.firebaseio.com/v0/user/' + u + '.json');
    if (!r.status) return 'un';
    if (r.status === 200) { var b = (r.body || '').trim(); return (b === 'null' || b === '') ? 'av' : 'tk'; }
    return 'un';
  },
  devto: async function(u) {
    var r = await fetchDirect('https://dev.to/api/users/by_username?url=' + u);
    return byStatus(r.status, [200], [404]);
  },
  gitlab: async function(u) {
    var r = await fetchDirect('https://gitlab.com/api/v4/users?username=' + u);
    if (r.status === 200) { try { var a = JSON.parse(r.body); return (Array.isArray(a) && a.length > 0) ? 'tk' : 'av'; } catch(e) {} }
    return 'un';
  },
  stackoverflow: async function(u) {
    var r = await fetchDirect('https://api.stackexchange.com/2.3/users?inname=' + encodeURIComponent(u) + '&site=stackoverflow');
    if (r.status === 200) { try { var d = JSON.parse(r.body || '{}'); var ex = (d.items || []).filter(function(i) { return (i.display_name || '').toLowerCase() === u.toLowerCase(); }); return ex.length > 0 ? 'tk' : 'av'; } catch(e) {} }
    return 'un';
  },
  discord: async function(u) {
    var r = await fetchDirect('https://discord.com/api/v9/invites/' + u);
    if (r.status === 200) return 'tk'; if (r.status === 404) return 'av'; return 'un';
  },
  twitch: async function(u) {
    var r = await fetchDirect('https://www.twitch.tv/' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ["Sorry. Unless you've got a time machine"])) return 'av'; return 'tk'; }
    return 'un';
  },
  spotify: async function(u) {
    var r = await fetchDirect('https://open.spotify.com/user/' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ['Page not found'])) return 'av'; return 'tk'; }
    return 'un';
  },
  soundcloud: async function(u) {
    var r = await fetchDirect('https://soundcloud.com/oembed?format=json&url=https://soundcloud.com/' + u);
    if (r.status === 200) return 'tk'; if (r.status === 404) return 'av'; return 'un';
  },
  medium: async function(u) {
    var r = await fetchDirect('https://medium.com/oembed?url=https://medium.com/@' + u + '&format=json');
    if (r.status === 200) return 'tk'; if (r.status === 404) return 'av'; return 'un';
  },
  vimeo: async function(u) {
    var r = await fetchDirect('https://vimeo.com/api/oembed.json?url=https://vimeo.com/' + u);
    if (r.status === 200) return 'tk'; if (r.status === 404) return 'av'; return 'un';
  },
  substack: async function(u) {
    var r = await fetchDirect('https://' + u + '.substack.com');
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ['not found', 'does not exist'])) return 'av'; return 'tk'; }
    return 'un';
  },
  patreon: async function(u) {
    // CONFIRMED: 302 redirect to /profile/creators = taken, 404 = available
    var r = await fetchProxy('https://www.patreon.com/' + u);
    if (r.status === 302 || r.status === 301) return 'tk';
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ['page not found', "doesn't exist"])) return 'av'; return 'tk'; }
    // Fallback direct
    var r2 = await fetchDirect('https://www.patreon.com/' + u);
    if (r2.status === 302 || r2.status === 301) return 'tk';
    if (r2.status === 404) return 'av';
    return 'un';
  },
  goodreads: async function(u) {
    var r = await fetchDirect('https://www.goodreads.com/' + u);
    return byStatus(r.status, [200], [404]);
  },
  vk: async function(u) {
    var r = await fetchDirect('https://vk.com/' + u);
    if (r.status === 404) return 'av';
    if (r.status === 200) { if (has(r.body, ['page not found', 'is not available'])) return 'av'; return 'tk'; }
    return 'un';
  },
  behance: async function(u) {
    var r = await fetchDirect('https://www.behance.net/' + u);
    return byStatus(r.status, [200], [404]);
  },
  dribbble: async function(u) {
    var r = await fetchDirect('https://dribbble.com/' + u);
    if (r.status === 404) return 'av'; if (r.status === 200) { if (has(r.body, ['not found'])) return 'av'; return 'tk'; } return 'un';
  },
  codepen: async function(u) {
    var r = await fetchDirect('https://codepen.io/' + u);
    if (r.status === 404) return 'av'; if (r.status === 200) { if (has(r.body, ['not found'])) return 'av'; return 'tk'; } return 'un';
  },
  whatsapp: async function(u) { return 'na'; },
};

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
});app.get('/test', async function(req, res) {
  var u = req.query.u || 'nike';
  var logs = [];

  // Twitter via nitter
  var tw1 = await fetchProxy('https://nitter.poast.org/' + u);
  logs.push({ p:'nitter', status:tw1.status, len:tw1.body.length, snippet:tw1.body.substring(0,300) });

  // Twitter graphql
  var tw2 = await fetchProxy('https://x.com/i/api/graphql/SAMkL5y_N9pmahSw8yy6bg/UserByScreenName?variables=%7B%22screen_name%22%3A%22' + u + '%22%7D');
  logs.push({ p:'twitter_graphql', status:tw2.status, len:tw2.body.length, snippet:tw2.body.substring(0,200) });

  // Patreon
  var pa = await fetchProxy('https://www.patreon.com/' + u);
  logs.push({ p:'patreon', status:pa.status, len:pa.body.length, snippet:pa.body.substring(0,200) });

  // Facebook graph
  var fb = await fetchProxy('https://graph.facebook.com/' + u + '?fields=id,name');
  logs.push({ p:'facebook_graph', status:fb.status, len:fb.body.length, body:fb.body.substring(0,300) });

  // LinkedIn voyager
  var li = await fetchProxy('https://www.linkedin.com/voyager/api/identity/profiles/' + u);
  logs.push({ p:'linkedin_voyager', status:li.status, len:li.body.length, snippet:li.body.substring(0,200) });

  // Quora googlebot
  var qr = await fetchProxy('https://www.quora.com/profile/' + u, {
    headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
  });
  logs.push({ p:'quora_googlebot', status:qr.status, len:qr.body.length, snippet:qr.body.substring(0,300) });

  // ProductHunt
  var ph = await fetchProxy('https://www.producthunt.com/@' + u);
  logs.push({ p:'producthunt', status:ph.status, len:ph.body.length, snippet:ph.body.substring(0,200) });

  res.json({ username: u, results: logs });
});


