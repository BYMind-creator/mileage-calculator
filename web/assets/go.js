/* 分享預覽頁轉址：/t/、/i/ 先給聊天 App 讀預覽卡片，真人打開時立刻轉到正式頁面（邀請碼在 # 後面，一起帶過去） */
(function () {
  var m = document.querySelector('meta[name="ts-go"]'); if (!m) return;
  var to = m.getAttribute('content') || '/';
  if (!/^\/(?!\/)/.test(to)) to = '/';                         // 只允許站內路徑
  if (m.getAttribute('data-keep-hash') === '1') to += location.hash;
  var a = document.getElementById('go'); if (a) a.setAttribute('href', to);
  location.replace(to);
})();
