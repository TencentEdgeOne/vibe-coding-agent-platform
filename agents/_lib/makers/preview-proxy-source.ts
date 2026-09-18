/** Generated Node proxy source. Keep in sync with the TS helpers in cli-dev.ts. */

export const PROXY_REVISION_PLACEHOLDER = '__PREVIEW_PROXY_REVISION__';

function normalizePreviewPrefix(value: string) {
  const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized === '/' ? '' : normalized;
}

export function buildPreviewProxyTemplate(
  listenPort: number,
  targetPort: number,
  prefix: string,
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  return `const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = ${listenPort};
const TARGET_PORT = ${targetPort};
const PREFIX = ${JSON.stringify(normalizedPrefix)};
const HEALTH_PATH = '/__edgeone_preview_proxy_health';

// Set once the upstream asks to be addressed with the prefix — see
// previewUpstreamClaimsPrefix in shared/makers-dev.ts. Until then the prefix is
// stripped, which is what makers dev and every framework with an asset-only
// prefix knob expect.
let prefixAware = false;

// The 404-shaped form of the same claim, tried once per proxy — see
// previewPrefixProbe. Once, because an upstream that really does serve at the
// root answers a genuinely missing page with a 404 too, and re-asking on every
// one of those would double the requests to re-learn what the first probe
// already established.
let prefixProbed = false;

function rewritePath(url) {
  if (!url) return '/';
  if (prefixAware) return url;
  if (
    PREFIX
    && (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?'))
  ) {
    const next = url.slice(PREFIX.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') ? next : '/' + next;
  }
  return url;
}

// Mirrors previewCanonicalRedirect in shared/makers-dev.ts.
function canonicalRedirect(url) {
  if (!PREFIX || !url) return null;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (path !== PREFIX) return null;
  return PREFIX + '/' + (queryStart === -1 ? '' : url.slice(queryStart));
}

function rewriteLocation(value) {
  if (!PREFIX || typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === PREFIX || value.startsWith(PREFIX + '/')) return value;
  return PREFIX + value;
}

// Mirrors previewUpstreamClaimsPrefix in shared/makers-dev.ts.
function claimsPrefix(statusCode, location) {
  if (!PREFIX) return false;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return false;
  if (typeof location !== 'string' || !location) return false;
  let path = location;
  const schemeEnd = location.indexOf('://');
  if (schemeEnd !== -1) {
    const afterHost = location.indexOf('/', schemeEnd + 3);
    path = afterHost === -1 ? '/' : location.slice(afterHost);
  } else if (location.charAt(0) !== '/') {
    return false;
  }
  path = path.split('?')[0];
  return path === PREFIX || path.indexOf(PREFIX + '/') === 0;
}

// Mirrors previewPrefixProbe in shared/makers-dev.ts.
function prefixProbe(requestUrl, forwardedPath, statusCode) {
  if (!PREFIX || !requestUrl || !forwardedPath) return null;
  if (statusCode !== 404) return null;
  if (forwardedPath === requestUrl) return null;
  const probePath = requestUrl.split('?')[0];
  if (probePath !== PREFIX && probePath.indexOf(PREFIX + '/') !== 0) return null;
  return requestUrl;
}

// Mirrors previewTrailingSlashFollow in shared/makers-dev.ts.
function trailingSlashFollow(forwardedPath, statusCode, location) {
  if (!forwardedPath) return null;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return null;
  if (typeof location !== 'string' || location.charAt(0) !== '/') return null;
  const from = forwardedPath.split('?')[0];
  const to = location.split('?')[0];
  if (from === to) return null;
  return withoutTrailingSlash(from) === withoutTrailingSlash(to) ? location : null;
}

function withoutTrailingSlash(value) {
  return value.length > 1 && value.charAt(value.length - 1) === '/'
    ? value.slice(0, -1)
    : value;
}

function rewriteSetCookie(value) {
  if (!PREFIX || typeof value !== 'string') return value;
  return value.replace(/;\\s*Path=\\//gi, '; Path=' + PREFIX + '/');
}

// makers dev reaches its function runtime through http-proxy with xfwd
// enabled, and xfwd APPENDS to x-forwarded-proto rather than replacing it. A
// value from the sandbox gateway therefore arrives at the runtime as
// "http,http", which it concatenates into a request URL and hands to new
// Request(): ERR_INVALID_URL. The failure is then swallowed by an error
// handler that throws on its own, so nothing ever writes a response and the
// browser spins until the user gives up. Dropping the header here leaves xfwd
// setting the single value it would have set anyway, which is also what makes
// a direct curl to the CLI work today.
// The parent workspace frames this preview cross-origin, so it cannot read the
// iframe's location to fill its address bar. Nothing else can report the route
// either: makers dev serves the application, and a proxy is the only layer left
// that sees every document. This posts the real path — prefix included, which is
// what the parent strips for display and reuses when deep-linking a copied URL.
const TRACKER = '<script data-edgeone-preview-tracker>'
  + '(function(){'
  + 'if(window.parent===window)return;'
  + 'var last="";'
  + 'function report(){'
  + 'var path=location.pathname+location.search+location.hash;'
  + 'if(path===last)return;'
  + 'last=path;'
  + 'try{window.parent.postMessage({__edgeonePreviewPath:path},"*");}catch(e){}'
  + '}'
  // Client-side routing changes the URL without any event of its own.
  + 'function wrap(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(){var r=original.apply(this,arguments);report();return r;};'
  + '}'
  + 'wrap("pushState");wrap("replaceState");'
  + 'addEventListener("popstate",report);'
  + 'addEventListener("hashchange",report);'
  + 'report();'
  + '})();'
  // Everything below restores what the prefix takes away, so the generated
  // project can be written the way the deployed site needs it. Mirrors
  // previewRestoredUrl in shared/makers-dev.ts; the tests pin both.
  + '(function(){'
  + 'var PREFIX=' + JSON.stringify(PREFIX) + ';'
  + 'if(!PREFIX)return;'
  + 'var KEY="__edgeone_preview_token";'
  + 'function token(){'
  + 'try{'
  + 'var found=new URLSearchParams(location.search).get("access_token");'
  + 'if(found){sessionStorage.setItem(KEY,found);return found;}'
  + 'return sessionStorage.getItem(KEY)||"";'
  + '}catch(e){return "";}'
  + '}'
  + 'function restore(raw){'
  + 'try{'
  + 'var page=new URL(location.href);'
  + 'var target=new URL(raw,location.href);'
  + 'if(target.origin!==page.origin)return null;'
  + 'if(!/^https?:$/.test(target.protocol))return null;'
  + 'var inside=target.pathname===PREFIX||target.pathname.indexOf(PREFIX+"/")===0;'
  + 'var t=token();'
  + 'var needsToken=!!t&&!target.searchParams.has("access_token");'
  + 'if(inside&&!needsToken)return null;'
  + 'if(!inside)target.pathname=PREFIX+target.pathname;'
  + 'if(needsToken)target.searchParams.set("access_token",t);'
  + 'return target.toString();'
  + '}catch(e){return null;}'
  + '}'
  // Bubble, not capture, and only if nothing has claimed the event. A client
  // router calls preventDefault on its own links, and hijacking those would
  // turn every in-app navigation into a full document load — which for a SPA
  // with no server-side routes is a 404 where the router had been working.
  // So this only rescues links the page left to the browser.
  + 'addEventListener("click",function(event){'
  + 'if(event.defaultPrevented||event.button!==0)return;'
  + 'if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;'
  + 'var anchor=event.target&&event.target.closest&&event.target.closest("a[href]");'
  + 'if(!anchor||anchor.target&&anchor.target!=="_self"||anchor.hasAttribute("download"))return;'
  + 'var fixed=restore(anchor.getAttribute("href"));'
  + 'if(!fixed)return;'
  + 'event.preventDefault();'
  + 'location.assign(fixed);'
  + '},false);'
  + 'addEventListener("submit",function(event){'
  + 'if(event.defaultPrevented)return;'
  + 'var form=event.target;'
  + 'if(!form||!form.getAttribute)return;'
  + 'var fixed=restore(form.getAttribute("action")||location.href);'
  + 'if(fixed)form.setAttribute("action",fixed);'
  + '},false);'
  // The other half of a client router: it pushes the path it believes it is on,
  // which is root-absolute and therefore outside the prefix. The app keeps
  // rendering from its own state, so nothing looks wrong until the reload that
  // asks the sandbox host for a path it does not publish.
  + 'function keepInside(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(state,title,url){'
  + 'var args=[].slice.call(arguments);'
  + 'if(typeof url==="string"){'
  + 'var fixed=restore(url);'
  + 'if(fixed)args[2]=fixed;'
  + '}'
  + 'return original.apply(this,args);'
  + '};'
  + '}'
  + 'keepInside("pushState");keepInside("replaceState");'
  // Wrapped in <head> so this runs before app code can hold its own reference.
  + 'var nativeFetch=window.fetch;'
  + 'if(typeof nativeFetch==="function"){'
  + 'window.fetch=function(input,init){'
  + 'try{'
  + 'if(typeof input==="string"){'
  + 'var fixed=restore(input);'
  + 'if(fixed)input=fixed;'
  + '}else if(input&&typeof input.url==="string"){'
  + 'var fixedRequest=restore(input.url);'
  + 'if(fixedRequest)input=new Request(fixedRequest,input);'
  + '}'
  + '}catch(e){}'
  + 'return nativeFetch.call(this,input,init);'
  + '};'
  + '}'
  + 'var open=window.XMLHttpRequest&&window.XMLHttpRequest.prototype.open;'
  + 'if(typeof open==="function"){'
  + 'window.XMLHttpRequest.prototype.open=function(method,url){'
  + 'var args=[].slice.call(arguments);'
  + 'try{var fixed=restore(url);if(fixed)args[1]=fixed;}catch(e){}'
  + 'return open.apply(this,args);'
  + '};'
  + '}'
  + '})();'
  + '</script>';

// Scanned as latin1 so one character is one byte and the match offset can index
// the buffer directly.
//
// <head> is only the preferred landing place. A hand-written index.html may not
// have one, and the script above is now what makes in-app navigation work, so
// skipping those pages would leave exactly the simplest generated sites broken.
// The fallbacks stay below the doctype: above it the page drops into quirks
// mode, which changes how the whole document lays out.
function headInsertionPoint(buffer) {
  const text = buffer.toString('latin1');
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(text);
    if (match) return match.index + match[0].length;
  }
  return -1;
}

function acceptsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function isHtmlResponse(headers) {
  const type = headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().includes('text/html');
}

function forwardHeaders(req) {
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
  delete headers['x-forwarded-proto'];
  // TRACKER can only be spliced into an unencoded body. Asking for identity on
  // navigations alone costs nothing on a loopback hop and leaves compression in
  // place for the assets, which are what the encoding is actually worth.
  if (acceptsHtml(req)) headers['accept-encoding'] = 'identity';
  return headers;
}

// Buffer only up to the opening <head>, then release and stream the rest
// untouched: a page that streams its body from a Suspense boundary has to keep
// arriving in pieces, and the shell carrying <head> is already in the first one.
function injectTracker(upstream, res) {
  const SCAN_LIMIT = 65536;
  let pending = [];
  let scanned = 0;
  let injected = false;

  function splice(buffer) {
    const at = headInsertionPoint(buffer);
    // No <head> to splice after. Prepending would land the script above the
    // doctype and drop the page into quirks mode, so leave the body alone and
    // let the address bar stay where it is.
    if (at === -1) {
      res.write(buffer);
      return;
    }
    res.write(buffer.subarray(0, at));
    res.write(TRACKER);
    res.write(buffer.subarray(at));
  }

  upstream.on('data', (chunk) => {
    if (injected) {
      res.write(chunk);
      return;
    }
    pending.push(chunk);
    scanned += chunk.length;
    const buffer = Buffer.concat(pending);
    if (headInsertionPoint(buffer) === -1 && scanned <= SCAN_LIMIT) return;
    injected = true;
    pending = [];
    splice(buffer);
  });
  upstream.on('end', () => {
    if (!injected && pending.length) splice(Buffer.concat(pending));
    res.end();
  });
  upstream.on('error', () => res.end());
}

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === HEALTH_PATH) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-edgeone-preview-proxy': '${PROXY_REVISION_PLACEHOLDER}',
    });
    res.end('ok');
    return;
  }

  const canonical = canonicalRedirect(req.url);
  if (canonical) {
    res.writeHead(308, { location: canonical });
    res.end();
    return;
  }

  forward(req, res, rewritePath(req.url), true, true, false);
});

function forward(req, res, path, mayRetry, mayFollow, probing) {
  const headers = forwardHeaders(req);
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path,
    method: req.method,
    headers,
  }, (upstream) => {
    // The probe's answer, which is the half of previewPrefixProbe that decides.
    // Anything but a second 404 means the prefixed path is a route the upstream
    // knows, so it keeps the prefix from here on. Read before the branches
    // below so a probe answered with a redirect still counts as knowing it.
    if (probing && upstream.statusCode !== 404) prefixAware = true;
    // The one response that means the prefix should not have been stripped.
    // Retried rather than passed on, because handing the browser a redirect to
    // a path this proxy still strips is the same request again: it would bounce
    // between the two until the browser gave up.
    if (
      mayRetry
      && !prefixAware
      && (req.method === 'GET' || req.method === 'HEAD')
      && claimsPrefix(upstream.statusCode, upstream.headers.location)
    ) {
      prefixAware = true;
      upstream.resume();
      forward(req, res, req.url || '/', false, true, false);
      return;
    }
    // The same claim made as a 404, which is how Astro states it. Asked rather
    // than concluded: the retry's status is what tells a base-mounted app apart
    // from a page that is simply not there.
    if (
      mayRetry
      && !prefixAware
      && !prefixProbed
      && (req.method === 'GET' || req.method === 'HEAD')
      && prefixProbe(req.url, path, upstream.statusCode)
    ) {
      prefixProbed = true;
      upstream.resume();
      forward(req, res, req.url, false, true, true);
      return;
    }
    // A redirect that only normalizes a trailing slash, settled here for the
    // same reason — see previewTrailingSlashFollow. Once, and never from a
    // follow of its own: an upstream that keeps normalizing is a loop this
    // proxy would be holding open instead of the browser.
    if (mayFollow && (req.method === 'GET' || req.method === 'HEAD')) {
      const follow = trailingSlashFollow(
        path,
        upstream.statusCode,
        upstream.headers.location,
      );
      if (follow) {
        upstream.resume();
        forward(req, res, follow, false, false, false);
        return;
      }
    }
    const responseHeaders = { ...upstream.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteLocation(responseHeaders.location);
    }
    if (Array.isArray(responseHeaders['set-cookie'])) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(rewriteSetCookie);
    }
    const injectable = isHtmlResponse(responseHeaders)
      && !responseHeaders['content-encoding'];
    // The body grows by TRACKER, so the declared length no longer holds.
    // Dropping it hands the response to chunked encoding.
    if (injectable) delete responseHeaders['content-length'];
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    if (injectable) injectTracker(upstream, res);
    else upstream.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('preview proxy error');
  });
  // Neither a retry nor a follow has a body left to send: both are reached
  // only for a GET or a HEAD, and the request stream is already consumed.
  if (mayRetry) req.pipe(proxy);
  else proxy.end();
}

server.on('upgrade', (req, socket, head) => {
  const path = rewritePath(req.url);
  const headers = forwardHeaders(req);
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const headerLines = Object.entries(headers).flatMap(([key, value]) => {
      if (value == null) return [];
      return [key + ': ' + (Array.isArray(value) ? value.join(', ') : value)];
    });
    target.write([
      (req.method || 'GET') + ' ' + path + ' HTTP/1.1',
      ...headerLines,
      '',
      '',
    ].join('\\r\\n'));
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0');
`;
}
