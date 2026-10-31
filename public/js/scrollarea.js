/* 共用捲動區：保留觸控／滾輪，提供可拖曳與鍵盤操作的自訂捲軸。 */
(function () {
  'use strict';
  var areas = new Map();
  var pending = false;
  var nextId = 0;
  var selector = '.screen,.settings-body,.game-dialog-body,.padwrap';

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }

  function attach(area) {
    var rail = document.createElement('div');
    var thumb = document.createElement('div');
    rail.className = 'custom-scrollbar';
    thumb.className = 'custom-scrollbar-thumb';
    rail.appendChild(thumb);
    rail.setAttribute('role', 'scrollbar');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.tabIndex = 0;
    if (!area.id) area.id = 'scroll-area-' + (++nextId);
    rail.setAttribute('aria-controls', area.id);
    document.body.appendChild(rail);
    area.classList.add('custom-scroll-area');
    var entry = { rail: rail, thumb: thumb, travel: 0 };
    areas.set(area, entry);
    rail.addEventListener('keydown', function (event) {
      var amounts = { ArrowDown: 40, ArrowUp: -40, PageDown: area.clientHeight, PageUp: -area.clientHeight };
      if (event.key === 'Home') area.scrollTop = 0;
      else if (event.key === 'End') area.scrollTop = area.scrollHeight;
      else if (amounts[event.key]) area.scrollTop += amounts[event.key];
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    rail.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      rail.focus({ preventScroll: true });
      if (event.target !== thumb) {
        area.scrollTop += (event.clientY < thumb.getBoundingClientRect().top ? -1 : 1) * area.clientHeight;
      }
      var startY = event.clientY;
      var startScroll = area.scrollTop;
      rail.setPointerCapture(event.pointerId);
      function move(e) {
        if (entry.travel > 0) area.scrollTop = startScroll + (e.clientY - startY) *
          (area.scrollHeight - area.clientHeight) / entry.travel;
      }
      function stop() {
        rail.removeEventListener('pointermove', move);
        rail.removeEventListener('lostpointercapture', stop);
      }
      rail.addEventListener('pointermove', move);
      rail.addEventListener('lostpointercapture', stop);
    });
    observer.observe(area);
  }

  function update() {
    pending = false;
    document.querySelectorAll(selector).forEach(function (area) {
      if (!areas.has(area)) attach(area);
    });
    var modal = document.querySelector('.settings-modal.open,.game-dialog-modal.open');
    areas.forEach(function (entry, area) {
      if (!area.isConnected) {
        observer.unobserve(area);
        entry.rail.remove();
        areas.delete(area);
        return;
      }
      var rect = area.getBoundingClientRect();
      var overflow = getComputedStyle(area).overflowY;
      var visible = rect.width > 0 && rect.height > 0 && area.scrollHeight > area.clientHeight + 1 &&
        /auto|scroll/.test(overflow) && (!modal || modal.contains(area));
      entry.rail.hidden = !visible;
      if (!visible) return;
      var top = Math.max(4, rect.top + 4);
      var bottom = Math.min(window.innerHeight - 4, rect.bottom - 4);
      var height = Math.max(0, bottom - top);
      var thumbHeight = Math.min(height, Math.max(28, height * area.clientHeight / area.scrollHeight));
      entry.travel = height - thumbHeight;
      entry.rail.style.cssText = 'top:' + top + 'px;left:' + Math.min(window.innerWidth - 12, rect.right - 12) +
        'px;height:' + height + 'px';
      entry.thumb.style.height = thumbHeight + 'px';
      entry.thumb.style.transform = 'translateY(' + entry.travel * area.scrollTop / (area.scrollHeight - area.clientHeight) + 'px)';
      entry.rail.setAttribute('aria-label', area.getAttribute('aria-label') || document.title);
      entry.rail.setAttribute('aria-valuemin', '0');
      entry.rail.setAttribute('aria-valuemax', String(area.scrollHeight - area.clientHeight));
      entry.rail.setAttribute('aria-valuenow', String(Math.round(area.scrollTop)));
    });
  }

  var observer = new ResizeObserver(schedule);
  new MutationObserver(function (records) {
    if (records.some(function (record) {
      return !record.target.closest || !record.target.closest('.custom-scrollbar');
    })) schedule();
  }).observe(document.getElementById('app'), { childList: true, subtree: true, attributes: true, characterData: true });
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  schedule();
})();
