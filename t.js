/* 홍스랩 방문 통계 (자체 호스팅, 쿠키 없음). 관리자로 로그인한 브라우저에는 삽입되지 않는다. */
(function () {
  if (navigator.webdriver) return;
  function send(e) {
    try {
      var d = { p: location.pathname, r: document.referrer || '', q: location.search || '', s: screen.width + 'x' + screen.height, l: navigator.language || '' };
      if (e) d.e = e;
      var body = JSON.stringify(d);
      if (navigator.sendBeacon) navigator.sendBeacon('/api/t', new Blob([body], { type: 'application/json' }));
      else fetch('/api/t', { method: 'POST', body: body, headers: { 'content-type': 'application/json' }, keepalive: true });
    } catch (err) {}
  }
  send();
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var a = t && t.closest ? t.closest('a,button') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var name = '';
    if (href.indexOf('tel:') === 0) name = 'tel';
    else if (href.indexOf('mailto:') === 0) name = 'mail';
    else if (href.indexOf('pf.kakao.com') >= 0) name = 'kakao';
    else if (a.classList.contains('js-open-inquiry')) name = 'inquiry_open';
    else if (a.id === 'kakaoSend') name = 'inquiry_send';
    else if (a.id === 'mailSend') name = 'inquiry_mail';
    else if (a.id === 'submit' && location.pathname.indexOf('/seo-checker') === 0) name = 'seo_check';
    else if (href === '/inquiry' || href === 'inquiry') name = 'inquiry_page';
    if (name) send(name);
  }, true);
})();
