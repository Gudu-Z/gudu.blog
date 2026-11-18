(() => {
  'use strict';

  const article = document.querySelector('.article-body');
  const progress = document.querySelector('[data-reading-progress]');
  const nav = document.querySelector('.article-toc nav');
  const links = Array.from(document.querySelectorAll('[data-toc-link]'));
  const headingIds = links.map(link => decodeURIComponent(link.hash.slice(1)));
  const headings = headingIds.map(id => document.getElementById(id)).filter(Boolean);
  // A heading counts as reached once it passes this line below the top edge.
  const readingLine = 160;
  let scheduled = false;
  let cursor = null;
  let readout = null;

  // The contents rail: an orange cursor between the section stations, and a
  // readout of how much has been read. Both hide where the contents fold into
  // a row (css/blog.css).
  if (article && nav && headings.length === links.length) {
    cursor = document.createElement('span');
    cursor.className = 'toc-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    nav.append(cursor);
    const row = document.createElement('p');
    row.className = 'toc-readout';
    row.setAttribute('aria-hidden', 'true');
    row.innerHTML = '<span>READ</span><output>0%</output>';
    nav.after(row);
    readout = row.querySelector('output');
  }

  // The rail stands for the article: its top for the start, each station for
  // a heading, its foot for the end of reading. Between two of them the cursor
  // moves in proportion to the text read.
  function railOffset(bounds, viewport, atEnd) {
    const knots = [[bounds.top, 0]];
    for (const [index, heading] of headings.entries()) {
      const item = links[index].parentElement;
      const tick = parseFloat(getComputedStyle(item, '::before').top) || 0;
      knots.push([heading.getBoundingClientRect().top, item.offsetTop + tick]);
    }
    knots.push([bounds.bottom - viewport + readingLine, nav.clientHeight]);
    if (atEnd) return knots[knots.length - 1][1];
    for (let i = 1; i < knots.length; i++) knots[i][0] = Math.max(knots[i][0], knots[i - 1][0]);
    if (readingLine < knots[0][0]) return 0;
    for (let i = 0; i < knots.length - 1; i++) {
      const [from, a] = knots[i];
      const [to, b] = knots[i + 1];
      if (readingLine < to) return a + (b - a) * (readingLine - from) / Math.max(1, to - from);
    }
    return knots[knots.length - 1][1];
  }

  function updateReadingState() {
    scheduled = false;
    if (!article) return;
    const bounds = article.getBoundingClientRect();
    const viewport = window.innerHeight;
    const available = bounds.height - viewport + 120;
    const ratio = available > 0 ? Math.min(1, Math.max(0, (120 - bounds.top) / available)) : (bounds.bottom <= viewport ? 1 : 0);
    if (progress) progress.style.width = `${ratio * 100}%`;
    const atEnd = window.scrollY + viewport >= document.documentElement.scrollHeight - 2;
    let current = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= readingLine) current = heading;
    }
    if (headings.length && atEnd) current = headings[headings.length - 1];
    for (const [index, link] of links.entries()) {
      const selected = current && headingIds[index] === current.id;
      link.classList.toggle('is-active', Boolean(selected));
      if (selected) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    // A folded row hides the rail, so it needs no layout reads.
    if (cursor?.offsetParent) {
      cursor.style.setProperty('--toc-y', `${railOffset(bounds, viewport, atEnd).toFixed(1)}px`);
      const percent = `${Math.round(ratio * 100)}%`;
      if (readout.textContent !== percent) readout.textContent = percent;
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
    // Figures that load later (a replay, an image) move the headings below them.
    if ('ResizeObserver' in window) new ResizeObserver(scheduleUpdate).observe(article);
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

  // Each code block gets a copy button in its language strip. If the
  // clipboard refuses, the code is selected for copying by hand.
  for (const block of document.querySelectorAll('.article-body .code-block')) {
    const code = block.querySelector('pre > code');
    if (!code) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制这段代码');
    let timer = 0;
    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = '已复制';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = '已选中，请手动复制';
      }
      button.classList.add('is-done');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('is-done');
      }, 1800);
    });
    block.classList.add('has-copy');
    block.append(button);
  }
})();
