// Everflow bridge inside OpenChamber's chat view (mini-chat.html) as the board frames it; chat-bridge.ts adds it to the page.
// A click on a file the chat names (a path link in its text, the file name on a tool row) goes to the board, which opens
// the file beside the chat; the pop-out button, which only works in OpenChamber's desktop shell, becomes a Close button
// for the board's dialog. Messages go to the board's origin only, taken from this script's address.
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.parent === window) return;
  var parentOrigin;
  try {
    parentOrigin = new URL(script.src).searchParams.get('parent') || '';
    if (new URL(parentOrigin).origin !== parentOrigin || !/^https?:$/.test(new URL(parentOrigin).protocol)) return;
  } catch (error) { return; }
  // Chromium names the framing page's origin: a frame that is not the board's stays as OpenChamber made it
  var ancestors = window.location.ancestorOrigins;
  if (ancestors && ancestors.length && ancestors[0] !== parentOrigin) return;

  function post(message) { window.parent.postMessage(message, parentOrigin); }

  var PATHLIKE = /^(?:~\/|\/)?[^\s:*?"<>|]+$/;
  function pathLike(text) {
    return !!text && text.length <= 4096 && text !== '.' && PATHLIKE.test(text) && !/^[a-z][\w+.-]*:\/\//i.test(text)
      && (text.indexOf('/') >= 0 || /\.[\w-]{1,10}$/.test(text));
  }

  // OpenChamber 2.7.2: a confirmed file reference in message text (inline code or a link) carries the resolved path;
  // a tool row shows its file as an element whose title is the path (relative to the session folder when inside it)
  // and whose text is that same path, after the file-type icon.
  function fileOf(target) {
    if (!(target instanceof Element)) return null;
    var link = target.closest('[data-openchamber-file-link="true"]');
    if (link) return link.getAttribute('data-openchamber-file-path') || link.getAttribute('data-openchamber-file-ref');
    if (target.closest('header')) return null;
    for (var node = target.closest('[title]'); node; node = node.parentElement && node.parentElement.closest('[title]')) {
      var title = node.getAttribute('title');
      if (pathLike(title) && (node.textContent || '').replace(/\s+/g, '') === title && node.querySelector('svg')) return title;
    }
    return null;
  }

  function open(event) {
    var path = fileOf(event.target);
    if (!path) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    post({ type: 'everflow:open-file', path: path });
  }
  document.addEventListener('click', open, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') open(event);
  }, true);
  // a middle click would otherwise open OpenChamber's own file route in a new tab
  document.addEventListener('auxclick', function (event) { if (fileOf(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);

  var CLOSE_ICON = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ready = false;
  // The pop-out button is the header button with the external-link icon (its label is translated, the icon is not)
  function apply() {
    var headers = document.querySelectorAll('header');
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      var icon = header.querySelector('button use[href="#oc-external-link"]');
      var popOut = icon && icon.closest('button');
      var mine = header.querySelector('button[data-everflow-close]');
      if (!popOut && !mine) continue;
      if (popOut && popOut.style.display !== 'none') popOut.style.display = 'none';
      if (!mine && popOut) {
        mine = document.createElement('button');
        mine.type = 'button';
        mine.className = popOut.className;
        mine.setAttribute('data-everflow-close', '');
        mine.setAttribute('aria-label', 'Close');
        mine.title = 'Close';
        var region = popOut.style.getPropertyValue('app-region');
        if (region) mine.style.setProperty('app-region', region);
        mine.innerHTML = CLOSE_ICON;
        mine.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); post({ type: 'everflow:close' }); });
        popOut.insertAdjacentElement('afterend', mine);
      }
      if (!ready) { ready = true; post({ type: 'everflow:ready' }); }
    }
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; apply(); });
  }
  function start() {
    apply();
    new MutationObserver(schedule).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
