/* ===== svgui.js — 立體 SVG 按鈕、標題 LOGO、背景裝飾 =====
 * 按鈕外觀是依元素實際尺寸即時畫出來的 SVG，所以縮放時不會被拉扁，
 * 也保證有「上層面 + 較深底座 + 高光」的區塊立體感。
 * 文字仍然是 HTML，不會烘焙進圖裡，方便本地化與螢幕閱讀器。
 */
(function (w) {
  'use strict';
  var INK = '#4A3B55';

  var PALETTE = {
    grape: ['#C9B6F5', '#A48FDB'],
    peach: ['#FFC2B4', '#E89C8B'],
    mint:  ['#A9E7D2', '#79C6AC'],
    sky:   ['#AED9F5', '#7FB4DA'],
    lemon: ['#FFE3A0', '#E7C263'],
    cream: ['#FFF0DE', '#E6D2B4'],
    rose:  ['#FFB8CF', '#E88CAA'],
    gray:  ['#E9E3EE', '#C8BFD1']
  };

  /* ---- 立體按鈕 ---- */
  function paint(el) {
    var wpx = el.offsetWidth, hpx = el.offsetHeight;
    if (!wpx || !hpx) return;
    var cs = getComputedStyle(el);
    var d = parseFloat(cs.getPropertyValue('--d')) || 8;
    var key = el.getAttribute('data-color') || 'cream';
    var c = PALETTE[key] || PALETTE.cream;
    var faceH = hpx - d - 4;
    if (faceH < 10) return;
    var r = Math.min(20, faceH / 2.2);
    var svg = el.querySelector('.b3-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'b3-svg');
      svg.setAttribute('aria-hidden', 'true');
      el.insertBefore(svg, el.firstChild);
    }
    svg.setAttribute('viewBox', '0 0 ' + wpx + ' ' + hpx);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<rect x="2" y="' + (2 + d) + '" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[1] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<g class="b3-face">' +
      '<rect x="2" y="2" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[0] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<rect x="' + (r * 0.55 + 4) + '" y="7" width="' + Math.max(4, wpx - 8 - r * 1.1) + '" height="' + Math.max(4, faceH * 0.36) + '" rx="' + (r * 0.5) + '" fill="#FFFFFF" opacity="0.45"/>' +
      '</g>';
  }

  var ro = w.ResizeObserver ? new ResizeObserver(function (list) {
    for (var i = 0; i < list.length; i++) paint(list[i].target);
  }) : null;

  function decorate(el) {
    if (el.dataset.b3) return;
    el.dataset.b3 = '1';
    var lbl = document.createElement('span');
    lbl.className = 'b3-lbl';
    lbl.innerHTML = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(lbl);
    paint(el);
    if (ro) ro.observe(el); else w.addEventListener('resize', function () { paint(el); });

    var press = function () { if (!el.disabled) el.classList.add('press'); };
    var release = function () { el.classList.remove('press'); };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
  }

  function decorateAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }
  function repaintAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) paint(list[i]);
  }

  function setLabel(el, html) {
    var lbl = el.querySelector('.b3-lbl');
    if (lbl) lbl.innerHTML = html; else el.innerHTML = html;
  }
  function setColor(el, key) {
    el.setAttribute('data-color', key);
    paint(el);
  }

  /* ---- 標題 LOGO：一隻抱著數獨盤的小貓 ---- */
  function logo() {
    return '<svg viewBox="0 0 560 210" role="img" aria-label="數獨小學堂">' +
      /* 左側小貓 */
      '<g transform="translate(20 44)">' +
        '<path d="M14 26 L10 4 L34 16 Z" fill="#FFD9C2" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
        '<path d="M78 26 L84 4 L58 16 Z" fill="#FFD9C2" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
        '<rect x="8" y="18" width="78" height="72" rx="30" fill="#FFE9D6" stroke="' + INK + '" stroke-width="5"/>' +
        '<circle cx="34" cy="50" r="5.5" fill="' + INK + '"/><circle cx="60" cy="50" r="5.5" fill="' + INK + '"/>' +
        '<path d="M40 64 Q47 71 54 64" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>' +
        '<ellipse cx="22" cy="62" rx="7" ry="4.5" fill="#FFB8CF" opacity="0.85"/>' +
        '<ellipse cx="72" cy="62" rx="7" ry="4.5" fill="#FFB8CF" opacity="0.85"/>' +
      '</g>' +
      /* 右側小數獨盤 */
      '<g transform="translate(452 42)">' +
        '<rect x="0" y="0" width="86" height="86" rx="14" fill="#FFFDF8" stroke="' + INK + '" stroke-width="5"/>' +
        '<path d="M29 4 V82 M57 4 V82 M4 29 H82 M4 57 H82" stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round" opacity="0.75"/>' +
        '<rect x="4" y="4" width="25" height="25" rx="6" fill="#C9B6F5"/>' +
        '<rect x="32" y="32" width="25" height="25" rx="6" fill="#A9E7D2"/>' +
        '<rect x="60" y="60" width="22" height="22" rx="6" fill="#FFE3A0"/>' +
      '</g>' +
      /* 標題文字：先描邊再填色，保持文字可讀且可本地化 */
      '<text x="280" y="92" text-anchor="middle" font-size="60" font-weight="900" letter-spacing="6" ' +
        'style="paint-order:stroke;stroke:' + INK + ';stroke-width:14px;stroke-linejoin:round" fill="#C9B6F5" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">數獨小學堂</text>' +
      '<text x="280" y="92" text-anchor="middle" font-size="60" font-weight="900" letter-spacing="6" fill="#F3ECFF" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">數獨小學堂</text>' +
      '<text x="280" y="134" text-anchor="middle" font-size="21" font-weight="800" letter-spacing="8" fill="#7A6A88" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">9 × 9 · 唯一解 · 慢慢想</text>' +
      '<path d="M160 158 h240" stroke="#C9B6F5" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.65"/>' +
      '</svg>';
  }

  /* ---- 勝利獎盃 ---- */
  function trophy() {
    return '<svg viewBox="0 0 120 120" role="img" aria-label="完成獎盃">' +
      '<path d="M30 20 h60 v22 a30 30 0 0 1 -60 0 Z" fill="#FFE3A0" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<path d="M30 26 h-14 a14 14 0 0 0 14 22" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M90 26 h14 a14 14 0 0 1 -14 22" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>' +
      '<rect x="52" y="70" width="16" height="16" fill="#E7C263" stroke="' + INK + '" stroke-width="5"/>' +
      '<rect x="34" y="86" width="52" height="16" rx="6" fill="#FFC2B4" stroke="' + INK + '" stroke-width="5"/>' +
      '<circle cx="60" cy="38" r="9" fill="#FFF6DC" stroke="' + INK + '" stroke-width="4"/>' +
      '</svg>';
  }

  /* ---- 背景漂浮裝飾（純視覺，pointer-events:none） ---- */
  function bgDeco(host) {
    var cols = ['#DCCFFA', '#C6EEE0', '#CFE6F8', '#FFEFC4', '#FFD5DF'];
    var html = '';
    for (var i = 0; i < 14; i++) {
      var s = 30 + Math.random() * 84;
      html += '<span style="width:' + s.toFixed(0) + 'px;height:' + s.toFixed(0) + 'px;left:' +
        (Math.random() * 100).toFixed(1) + '%;top:' + (Math.random() * 100).toFixed(1) + '%;background:' +
        cols[i % cols.length] + ';animation-duration:' + (8 + Math.random() * 8).toFixed(1) +
        's;animation-delay:-' + (Math.random() * 8).toFixed(1) + 's;opacity:' + (0.16 + Math.random() * 0.2).toFixed(2) + '"></span>';
    }
    host.innerHTML = html;
  }

  w.UI = {
    PALETTE: PALETTE,
    decorate: decorate, decorateAll: decorateAll, paint: paint, repaintAll: repaintAll,
    setLabel: setLabel, setColor: setColor,
    logo: logo, trophy: trophy, bgDeco: bgDeco
  };
})(window);
