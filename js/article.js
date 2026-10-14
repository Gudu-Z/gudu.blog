(() => {
  'use strict';

  const article = document.querySelector('.article-body');
  const progress = document.querySelector('[data-reading-progress]');
  const links = Array.from(document.querySelectorAll('[data-toc-link]'));
  const headings = links.map(link => document.getElementById(link.hash.slice(1))).filter(Boolean);
  let scheduled = false;

  function updateReadingState() {
    scheduled = false;
    if (!article) return;
    const bounds = article.getBoundingClientRect();
    const viewport = window.innerHeight;
    const available = bounds.height - viewport + 120;
    const ratio = available > 0 ? Math.min(1, Math.max(0, (120 - bounds.top) / available)) : (bounds.bottom <= viewport ? 1 : 0);
    if (progress) progress.style.width = `${ratio * 100}%`;
    let current = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 160) current = heading;
    }
    const pageHeight = document.documentElement.scrollHeight;
    if (headings.length && window.scrollY + viewport >= pageHeight - 2) {
      current = headings[headings.length - 1];
    }
    for (const link of links) {
      const selected = current && link.hash === `#${current.id}`;
      link.classList.toggle('is-active', Boolean(selected));
      if (selected) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(updateReadingState);
  }

  if (article) {
    const track = document.querySelector('.reading-progress');
    if (track) track.hidden = false;
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    window.addEventListener('load', scheduleUpdate, { once: true });
    if (document.fonts?.ready) document.fonts.ready.then(scheduleUpdate);
    updateReadingState();
  }

  const copyButton = document.querySelector('.copy-link');
  const copyStatus = document.querySelector('.copy-status');
  if (copyButton && copyStatus) {
    copyButton.hidden = false;
    copyButton.addEventListener('click', async () => {
      const address = new URL(window.location.href);
      address.hash = '';
      address.search = '';
      copyStatus.textContent = '';
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(address.href);
        copyStatus.textContent = '文章链接已复制。';
      } catch {
        copyStatus.textContent = '未能自动复制，请从浏览器地址栏复制文章链接。';
      }
    });
  }
})();
