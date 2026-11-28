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
  // readout of how much has been read. The page brings both, so they show
  // from its first paint; older pages without them get them here. Both hide
  // where the contents fold into a row (css/blog.css). The rail also answers
  // the pointer (setupRail).
  if (article && nav && headings.length === links.length) {
    cursor = nav.querySelector('.toc-cursor');
    if (!cursor) {
      cursor = document.createElement('span');
      cursor.className = 'toc-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      nav.append(cursor);
    }
    readout = nav.parentElement.querySelector('.toc-readout output');
    if (!readout) {
      const row = document.createElement('p');
      row.className = 'toc-readout';
      row.setAttribute('aria-hidden', 'true');
      row.innerHTML = '<span>READ</span><output>0%</output>';
      nav.after(row);
      readout = row.querySelector('output');
    }
    setupRail();
  }

  // The contents and the article index start level with the top of the
  // article's frame, beside the title, rather than beside the body. The lift
  // is the header's height and gaps: the page measures it into --side-lift on
  // the shell as soon as the header is parsed, and this keeps it current as
  // the header reflows (from layout, not from the moving boxes). Without
  // scripts they start beside the body (css/blog.css).
  const layout = document.querySelector('.article-layout');
  const header = document.querySelector('.article-header');
  if (layout && header && layout.querySelector(':scope > :is(.article-toc, .article-index)')) {
    const lift = () => {
      const frameGap = parseFloat(getComputedStyle(layout).getPropertyValue('--rail-gap')) || 0;
      const distance = layout.offsetTop - header.offsetTop + frameGap;
      header.parentElement.style.setProperty('--side-lift', `${Math.max(0, Math.round(distance))}px`);
    };
    lift();
    if ('ResizeObserver' in window) new ResizeObserver(lift).observe(header);
    else window.addEventListener('resize', lift, { passive: true });
  }

  // The article index scrolls on its own when it is taller than the window.
  // It opens with this article in the middle of its view, and fades at its
  // foot while more of it lies below (css/blog.css).
  const indexScroll = document.querySelector('.index-scroll');
  if (indexScroll) {
    const markEnds = () => {
      const overflowing = indexScroll.scrollHeight - indexScroll.clientHeight > 1;
      indexScroll.classList.toggle('is-overflowing', overflowing);
      indexScroll.classList.toggle('is-at-end', overflowing && indexScroll.scrollTop + indexScroll.clientHeight >= indexScroll.scrollHeight - 1);
    };
    const here = indexScroll.querySelector('[aria-current="page"]');
    if (here && indexScroll.scrollHeight > indexScroll.clientHeight) {
      const offset = here.getBoundingClientRect().top - indexScroll.getBoundingClientRect().top;
      indexScroll.scrollTop = Math.max(0, offset - (indexScroll.clientHeight - here.offsetHeight) / 2);
    }
    markEnds();
    indexScroll.addEventListener('scroll', markEnds, { passive: true });
    // The window and the arriving fonts change both heights.
    if ('ResizeObserver' in window) {
      const watch = new ResizeObserver(markEnds);
      watch.observe(indexScroll);
      if (indexScroll.firstElementChild) watch.observe(indexScroll.firstElementChild);
    } else window.addEventListener('resize', markEnds, { passive: true });
  }

  // The rail stands for the article: its top for the start, each station for
  // a heading, its foot for the end of reading. Knots pair a place of the
  // reading line in the document with a height on the rail; between two of
  // them the cursor moves in proportion to the text read.
  function stationOffset(index) {
    const item = links[index].parentElement;
    return item.offsetTop + (parseFloat(getComputedStyle(item, '::before').top) || 0);
  }

  function railKnots() {
    const scroll = window.scrollY;
    const bounds = article.getBoundingClientRect();
    const knots = [[bounds.top + scroll, 0]];
    for (const [index, heading] of headings.entries()) knots.push([heading.getBoundingClientRect().top + scroll, stationOffset(index)]);
    knots.push([bounds.bottom + scroll - window.innerHeight + readingLine, nav.clientHeight]);
    for (let i = 1; i < knots.length; i++) knots[i][0] = Math.max(knots[i][0], knots[i - 1][0]);
    return knots;
  }

  function railOffset(atEnd) {
    const knots = railKnots();
    if (atEnd) return knots[knots.length - 1][1];
    const line = window.scrollY + readingLine;
    if (line < knots[0][0]) return 0;
    for (let i = 0; i < knots.length - 1; i++) {
      const [from, a] = knots[i];
      const [to, b] = knots[i + 1];
      if (line < to) return a + (b - a) * (line - from) / Math.max(1, to - from);
    }
    return knots[knots.length - 1][1];
  }

  // The inverse: the scroll that brings the reading line to a rail height.
  function scrollForRail(height) {
    const knots = railKnots();
    const last = document.documentElement.scrollHeight - window.innerHeight;
    const y = Math.min(Math.max(height, 0), knots[knots.length - 1][1]);
    for (let i = 0; i < knots.length - 1; i++) {
      const [from, a] = knots[i];
      const [to, b] = knots[i + 1];
      if (y <= b || i === knots.length - 2) {
        const t = b > a ? Math.min(1, Math.max(0, (y - a) / (b - a))) : 1;
        return Math.min(Math.max(0, from + (to - from) * t - readingLine), last);
      }
    }
    return 0;
  }

  // The share of the article read at a scroll, as the readout counts it.
  function shareAt(scroll) {
    const bounds = article.getBoundingClientRect();
    const top = bounds.top + window.scrollY - scroll;
    const available = bounds.height - window.innerHeight + 120;
    return available > 0 ? Math.min(1, Math.max(0, (120 - top) / available)) : 1;
  }

  // The rail as an instrument. Near the pointer the fine ticks swell and
  // brighten, and a probe line shows the share of the article read at that
  // height; a click goes there and a drag scrubs through the article, the
  // cursor following. Pointing at or focusing an entry lights the span of its
  // section on the rail: a heading's runs to the next heading of its rank or
  // above, or to the end.
  function setupRail() {
    const STEP = 8;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const band = document.createElement('div');
    band.className = 'toc-rail';
    band.setAttribute('aria-hidden', 'true');
    band.innerHTML = '<span class="toc-ticks"></span><span class="toc-span"></span><span class="toc-probe"><output></output></span>';
    nav.prepend(band);
    nav.classList.add('has-rail');
    const ticks = band.querySelector('.toc-ticks');
    const span = band.querySelector('.toc-span');
    const probe = band.querySelector('.toc-probe');
    const label = probe.querySelector('output');

    // The fine ticks stand every STEP pixels down the rail, as marks the
    // pointer can swell one by one.
    let marks = [];
    function lay() {
      const count = Math.floor(nav.clientHeight / STEP) + 1;
      if (count === marks.length) return;
      marks = Array.from({ length: count }, (_, i) => {
        const mark = document.createElement('i');
        mark.style.top = `${i * STEP}px`;
        return mark;
      });
      ticks.replaceChildren(...marks);
    }
    lay();
    if ('ResizeObserver' in window) new ResizeObserver(lay).observe(nav);

    let pointer = null, frame = 0, press = null;
    function draw() {
      frame = 0;
      for (const [i, mark] of marks.entries()) {
        const zoom = pointer === null ? 0 : Math.exp(-(((i * STEP - pointer) / 18) ** 2));
        const value = zoom < 0.02 ? '' : zoom.toFixed(2);
        if (mark.style.getPropertyValue('--zoom') === value) continue;
        if (value) mark.style.setProperty('--zoom', value);
        else mark.style.removeProperty('--zoom');
      }
      band.classList.toggle('is-probing', pointer !== null);
      if (pointer === null) return;
      probe.style.setProperty('--probe-y', `${pointer.toFixed(1)}px`);
      label.textContent = `${Math.round(shareAt(scrollForRail(pointer)) * 100)}%`;
    }
    const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const heightAt = event => Math.min(Math.max(event.clientY - nav.getBoundingClientRect().top, 0), nav.clientHeight);

    band.addEventListener('pointerenter', event => { pointer = heightAt(event); redraw(); });
    band.addEventListener('pointermove', event => {
      pointer = heightAt(event);
      redraw();
      if (!press) return;
      if (!press.dragging && Math.abs(event.clientY - press.y) < 3) return;
      press.dragging = true;
      band.classList.add('is-scrubbing');
      window.scrollTo({ top: scrollForRail(pointer), behavior: 'instant' });
    });
    band.addEventListener('pointerleave', () => {
      if (press) return;
      pointer = null;
      redraw();
    });
    band.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      press = { y: event.clientY, dragging: false };
      band.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    function release(event) {
      if (!press) return;
      const { dragging } = press;
      press = null;
      band.classList.remove('is-scrubbing');
      if (!dragging && event.type === 'pointerup') window.scrollTo({ top: scrollForRail(heightAt(event)), behavior: still.matches ? 'instant' : 'smooth' });
      if (event.type === 'pointercancel' || !band.matches(':hover')) {
        pointer = null;
        redraw();
      }
    }
    band.addEventListener('pointerup', release);
    band.addEventListener('pointercancel', release);

    const minor = index => links[index].parentElement.classList.contains('toc-subheading');
    function light(index) {
      let next = index + 1;
      while (next < links.length && !minor(index) && minor(next)) next++;
      const top = stationOffset(index);
      const end = next < links.length ? stationOffset(next) : nav.clientHeight;
      span.style.setProperty('--span-top', `${top.toFixed(1)}px`);
      span.style.setProperty('--span-height', `${Math.max(0, end - top).toFixed(1)}px`);
      band.classList.add('is-spanning');
    }
    const dim = () => band.classList.remove('is-spanning');
    for (const [index, link] of links.entries()) {
      link.addEventListener('pointerenter', () => light(index));
      link.addEventListener('focus', () => light(index));
      link.addEventListener('pointerleave', dim);
      link.addEventListener('blur', dim);
    }
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
      cursor.style.setProperty('--toc-y', `${railOffset(atEnd).toFixed(1)}px`);
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
