// ui.js - Bundled UI script with Pretext
import {
  prepareWithSegments,
  layout,
  measureLineStats,
  measureNaturalWidth,
  layoutNextLineRange,
  materializeLineRange,
} from '@chenglou/pretext';

console.log('✅ Pretext loaded successfully!', { prepareWithSegments, layout });

// Fit into slightly less than the full box so small measurement/render
// differences (Auto line height, font substitution) never overflow.
const SAFETY = 0.94;
// Horizontal breathing room when fitting inside a curved/angled boundary.
const CIRCLE_PAD = 0.94;
// Longest side (px) of the rasterized shape mask — caps cost, plenty precise.
const MASK_MAX = 320;
const START_CURSOR = { segmentIndex: 0, graphemeIndex: 0 };

document.addEventListener('DOMContentLoaded', () => {
  const measureButton = document.getElementById('measure-button');
  const errorMessage = document.getElementById('error-message');
  const resultsDiv = document.getElementById('results');
  const textListDiv = document.getElementById('text-list');
  const applyButton = document.getElementById('apply-button');
  const hintDiv = document.getElementById('hint');
  const settingsDiv = document.getElementById('settings');
  const padSlider = document.getElementById('pad-slider');
  const fillSlider = document.getElementById('fill-slider');
  const padVal = document.getElementById('pad-val');
  const fillVal = document.getElementById('fill-val');

  let measuredTexts = [];
  // Last analysed input, so we can re-fit when the settings sliders change.
  let lastData = null;
  // User-tunable fit settings (percentages). Defaults reproduce prior behavior.
  const settings = { padding: 5, widthFill: 98 };

  // --- Helpers ---

  function showError(msg) {
    errorMessage.style.display = 'block';
    errorMessage.textContent = '⚠️ ' + msg;
  }
  function hideError() {
    errorMessage.style.display = 'none';
  }
  function setLoading(isLoading) {
    measureButton.disabled = isLoading;
    measureButton.textContent = isLoading ? '⏳ Analysing…' : 'Analyse selection';
  }
  function fontStr(fs, family) {
    return `${fs}px "${family}"`;
  }
  // Round DOWN to nearest 0.5px so we never tip over the fitting edge.
  function roundFont(fs) {
    return Math.max(1, Math.floor(fs * 2) / 2);
  }

  // Correction factor between Figma's real rendered width and Pretext's canvas
  // measurement. k > 1 means Figma renders WIDER than Pretext measured (the
  // font isn't available to the plugin canvas), so we must feed Pretext
  // narrower widths (slotWidth / k) to break lines where Figma actually will.
  function widthFactor(data) {
    if (!data.sample || !(data.sampleWidth > 0) || !(data.sampleFontSize > 0)) return 1;
    const prepared = prepareWithSegments(data.sample, fontStr(data.sampleFontSize, data.fontFamily));
    const pretextW = measureNaturalWidth(prepared);
    if (!(pretextW > 0)) return 1;
    // Clamp so a bad measurement can never wreck the layout.
    return Math.min(2, Math.max(0.5, data.sampleWidth / pretextW));
  }

  // --- Fit: largest font size that fits inside a rectangular box ---

  function fitFontToBox(data) {
    const { fontFamily: family, characters: text, currentWidth: boxW, currentHeight: boxH } = data;
    const ratio = data.fontSize > 0 ? data.lineHeight / data.fontSize : 1.25;
    const targetH = boxH * SAFETY;
    // Wrap at the corrected width so Pretext's line count / height match how
    // Figma will actually wrap the real font at boxW.
    const effW = boxW / widthFactor(data);

    const fits = (fs) => {
      const prepared = prepareWithSegments(text, fontStr(fs, family));
      const { height } = layout(prepared, effW, fs * ratio);
      const { maxLineWidth } = measureLineStats(prepared, effW);
      return height <= targetH && maxLineWidth <= effW;
    };

    let lo = 1;
    let hi = Math.max(2, boxH / ratio);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    const newFontSize = roundFont(lo);

    const prepared = prepareWithSegments(text, fontStr(newFontSize, family));
    const { height, lineCount } = layout(prepared, effW, newFontSize * ratio);

    return {
      mode: 'box',
      newFontSize,
      // Pin line height so a fixed-pixel line height left over from a previous
      // apply can't stay small and make the bigger text overlap itself.
      lineHeight: newFontSize * ratio,
      lineCount,
      newHeight: Math.ceil(height),
      boxHeight: Math.round(boxH),
      fitsBox: fits(newFontSize),
    };
  }

  // --- Rasterize a shape's outline into a per-row "inside span" mask ---

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function buildMask(shape) {
    const scale = Math.min(1, MASK_MAX / Math.max(shape.width, shape.height));
    const W = Math.max(1, Math.round(shape.width * scale));
    const H = Math.max(1, Math.round(shape.height * scale));

    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.save();
    ctx.scale(scale, scale);
    for (const p of shape.paths) {
      ctx.fill(new Path2D(p.data), p.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero');
    }
    ctx.restore();

    const data = ctx.getImageData(0, 0, W, H).data;
    // Precompute the widest "inside" run per pixel row, and how much of the
    // bounding box the shape fills (~1.0 rectangle, ~0.79 circle).
    const runs = new Array(H);
    let insideCount = 0;
    for (let r = 0; r < H; r++) {
      const base = r * W * 4;
      let bestLo = -1, bestHi = -1, lo = -1;
      for (let x = 0; x <= W; x++) {
        const inside = x < W && data[base + x * 4 + 3] > 10;
        if (inside) { insideCount++; if (lo < 0) lo = x; }
        else if (lo >= 0) { if (x - lo > bestHi - bestLo) { bestLo = lo; bestHi = x; } lo = -1; }
      }
      runs[r] = bestLo < 0 ? null : [bestLo, bestHi];
    }
    return { W, H, scale, runs, fillRatio: insideCount / (W * H) };
  }

  // Widest span (in shape units) that fits inside the shape across a whole
  // vertical band — intersection of the per-row runs guarantees the line fits.
  function widthAtBand(mask, yTop, yBot) {
    const r0 = Math.max(0, Math.floor(yTop * mask.scale));
    const r1 = Math.min(mask.H - 1, Math.ceil(yBot * mask.scale));
    let lo = -Infinity, hi = Infinity;
    for (let r = r0; r <= Math.max(r0, r1); r++) {
      const run = mask.runs[r];
      if (!run) return 0;
      if (run[0] > lo) lo = run[0];
      if (run[1] < hi) hi = run[1];
    }
    const w = hi - lo;
    return w > 0 ? w / mask.scale : 0;
  }

  // --- Fit: largest font size + line breaks that fit inside any shape ---

  function fitFontToShape(data) {
    const { fontFamily: family, shape } = data;
    // Flatten any line breaks we inserted on a previous apply so re-applying
    // re-flows the paragraph fresh instead of compounding old breaks.
    const text = data.characters.replace(/[\r\n]+/g, ' ');
    const mask = buildMask(shape);
    const H = shape.height;
    const cy = H / 2; // matches Figma's vertical-center alignment in the bbox
    const ratio = data.fontSize > 0 ? data.lineHeight / data.fontSize : 1.25;
    const k = widthFactor(data); // Pretext-vs-Figma width correction

    // Rectangle-like shapes read as a normal text box: filled, LEFT-aligned,
    // with padding. We still insert our OWN (corrected) line breaks so Figma
    // renders them verbatim instead of re-wrapping at different points.
    if (mask.fillRatio >= 0.90) {
      const padPct = settings.padding / 100;
      const fill = settings.widthFill / 100;
      const padX = Math.round(shape.width * padPct);
      const padY = Math.round(shape.height * padPct);
      const innerW = Math.max(1, shape.width - 2 * padX);
      const innerH = Math.max(1, shape.height - 2 * padY);

      const wrapAt = (fs) => {
        const prepared = prepareWithSegments(text, fontStr(fs, family));
        // Cushion below innerW so per-line kerning variance can't tip a line
        // over the edge and make Figma soft-wrap it into an orphan word.
        const eff = (innerW * fill) / k;
        let cursor = START_CURSOR;
        const lines = [];
        for (let guard = 0; guard < 4000; guard++) {
          const range = layoutNextLineRange(prepared, cursor, eff);
          if (!range) break;
          if (range.width > eff + 0.5) return { ok: false, lines }; // word too wide
          lines.push(materializeLineRange(prepared, range).text);
          cursor = range.end;
        }
        return { ok: lines.length * fs * ratio <= innerH * SAFETY, lines };
      };

      let rlo = 1, rhi = Math.max(2, innerH / ratio);
      for (let i = 0; i < 40; i++) {
        const mid = (rlo + rhi) / 2;
        if (wrapAt(mid).ok) rlo = mid; else rhi = mid;
      }
      const rFont = roundFont(rlo);
      const res = wrapAt(rFont);
      const lines = res.ok ? res.lines.map(l => l.replace(/\s+$/, '')) : [text];
      return {
        mode: 'shape',
        isRect: true,
        align: 'LEFT',
        newFontSize: rFont,
        lineHeight: rFont * ratio,
        lineCount: lines.length,
        brokenText: lines.join('\n'),
        box: { x: shape.x + padX, y: shape.y + padY, width: innerW, height: innerH },
        fitsBox: res.ok,
      };
    }

    // Lay all text into a vertically-centered block of `nSlots` lines,
    // giving each line the width available inside the shape at its band.
    function layoutInSlots(prepared, fs, nSlots) {
      const lineH = fs * ratio;
      const blockTop = cy - (nSlots * lineH) / 2;
      let cursor = START_CURSOR;
      const lines = [];
      for (let i = 0; i < nSlots; i++) {
        const yCenter = blockTop + (i + 0.5) * lineH;
        const slotWidth = widthAtBand(mask, yCenter - lineH / 2, yCenter + lineH / 2) * CIRCLE_PAD;
        if (slotWidth <= 0) { lines.push({ text: '', empty: true }); continue; }

        // Break at the corrected width so the line fits Figma's real rendering.
        const effSlot = slotWidth / k;
        const range = layoutNextLineRange(prepared, cursor, effSlot);
        if (!range) return { ok: true, lines, usedLines: i };
        if (range.width > effSlot + 0.5) return { ok: false }; // word too wide for this slot
        lines.push({ text: materializeLineRange(prepared, range).text });
        cursor = range.end;
      }
      const more = layoutNextLineRange(prepared, cursor, (shape.width * CIRCLE_PAD) / k);
      return { ok: !more, lines, usedLines: nSlots };
    }

    function fits(fs) {
      const prepared = prepareWithSegments(text, fontStr(fs, family));
      const lineH = fs * ratio;
      let n = Math.floor((H * SAFETY) / lineH);
      if (n < 1) return { ok: false };
      // Re-center around the number of lines actually used until stable.
      for (let iter = 0; iter < 5; iter++) {
        const res = layoutInSlots(prepared, fs, n);
        if (!res.ok) return { ok: false };
        const used = Math.max(1, res.usedLines || n);
        if (used === n) {
          return { ok: true, lines: res.lines.filter(l => !l.empty && l.text.trim()) };
        }
        n = used;
      }
      return { ok: false };
    }

    let lo = 0, hi = Math.max(2, H / ratio);
    for (let i = 0; i < 36; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid).ok) lo = mid; else hi = mid;
    }
    const newFontSize = roundFont(lo);
    const final = fits(newFontSize);
    const lines = final.ok ? final.lines.map(l => l.text.replace(/\s+$/, '')) : [text];

    return {
      mode: 'shape',
      isRect: false,
      align: 'CENTER', // centered lines form the tapered silhouette
      newFontSize,
      // Pin this exact line height on apply, otherwise Figma's AUTO line height
      // renders taller than we planned and the text overflows the shape.
      lineHeight: newFontSize * ratio,
      lineCount: lines.length,
      brokenText: lines.join('\n'),
      box: { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
      fitsBox: !!final.ok && lo >= 1,
    };
  }

  function measureTexts(list) {
    return list.map(data => {
      const fit = data.shape ? fitFontToShape(data) : fitFontToBox(data);
      const preview = data.characters.length > 50
        ? data.characters.substring(0, 47) + '...'
        : data.characters;
      return Object.assign({
        id: data.id,
        preview,
        currentFontSize: data.fontSize,
        fontFamily: data.fontFamily,
      }, fit);
    });
  }

  // --- Render ---

  function renderResults(texts) {
    if (texts.length === 0) { resultsDiv.style.display = 'none'; return; }
    resultsDiv.style.display = 'block';

    // Padding / width-fill only affect rectangle fits — show the sliders then.
    settingsDiv.style.display = texts.some(t => t.isRect) ? 'block' : 'none';

    textListDiv.innerHTML = texts.map((t) => {
      const changed = t.newFontSize !== t.currentFontSize;
      const size = changed
        ? `${t.currentFontSize}px → <span class="value highlight">${t.newFontSize}px</span>`
        : `${t.newFontSize}px <span class="value">(no change)</span>`;
      const fillOrShape = t.mode === 'shape'
        ? ''
        : `<span class="detail"><span class="label">Fills:</span><span class="value">${t.newHeight}px / ${t.boxHeight}px</span></span>`;
      const warn = t.fitsBox ? '' :
        `<div class="text-preview" style="color:#d32f2f">⚠️ Can't fully fit — shape is too small for this text.</div>`;
      return `
      <div class="text-item">
        <div class="text-preview">
          <span class="label">Text:</span>
          <span class="value">"${t.preview}"</span>
        </div>
        <div class="text-details">
          <span class="detail"><span class="label">Font:</span><span class="value">${t.fontFamily}</span></span>
          <span class="detail"><span class="label">Size:</span><span class="value">${size}</span></span>
          <span class="detail"><span class="label">Lines:</span><span class="value">${t.lineCount}</span></span>
          ${fillOrShape}
        </div>
        ${warn}
      </div>`;
    }).join('');

    measuredTexts = texts;
  }

  // --- Messages from Figma ---

  window.onmessage = (event) => {
    const msg = event.data.pluginMessage;
    if (!msg) return;
    console.log('📨 Message received from Figma:', msg);

    if (msg.type === 'text-data') {
      setLoading(false);
      hideError();
      hintDiv.style.display = 'none';
      try {
        lastData = msg.data;
        renderResults(measureTexts(msg.data));
      } catch (err) {
        console.error(err);
        showError('Measurement failed: ' + err.message);
        resultsDiv.style.display = 'none';
      }
    }

    if (msg.type === 'error') {
      setLoading(false);
      showError(msg.message);
      resultsDiv.style.display = 'none';
    }

    if (msg.type === 'settings' && msg.data
        && typeof msg.data.padding === 'number'
        && typeof msg.data.widthFill === 'number') {
      settings.padding = msg.data.padding;
      settings.widthFill = msg.data.widthFill;
      padSlider.value = settings.padding;
      fillSlider.value = settings.widthFill;
      padVal.textContent = settings.padding + '%';
      fillVal.textContent = settings.widthFill + '%';
      if (lastData) recompute(); // reflect restored settings if already analysed
    }
  };

  // --- UI events ---

  measureButton.addEventListener('click', () => {
    console.log('🔘 Measure button clicked');
    setLoading(true);
    hideError();
    resultsDiv.style.display = 'none';
    parent.postMessage({ pluginMessage: { type: 'get-selected-text' } }, '*');
  });

  function applyToFigma() {
    if (measuredTexts.length === 0) return;
    measuredTexts.forEach(t => {
      parent.postMessage({
        pluginMessage: {
          type: 'apply-font-size',
          data: {
            id: t.id,
            fontSize: t.newFontSize,
            mode: t.mode,
            text: t.mode === 'shape' ? t.brokenText : undefined,
            box: t.mode === 'shape' ? t.box : undefined,
            lineHeight: t.lineHeight,
            align: t.mode === 'shape' ? t.align : undefined,
          },
        },
      }, '*');
    });
  }
  applyButton.addEventListener('click', applyToFigma);

  // Re-fit the panel numbers from the last analysed data with current settings.
  function recompute() {
    if (!lastData) return;
    renderResults(measureTexts(lastData));
  }

  // Slider drag: update the value + re-fit live in the panel (no canvas write).
  // Slider release ('change'): apply the new fit to the canvas (Option B).
  function bindSlider(slider, valEl, key, suffix) {
    slider.addEventListener('input', () => {
      settings[key] = Number(slider.value);
      valEl.textContent = slider.value + suffix;
      recompute();
    });
    slider.addEventListener('change', () => {
      applyToFigma();
      parent.postMessage({ pluginMessage: { type: 'save-settings', settings } }, '*');
    });
  }
  bindSlider(padSlider, padVal, 'padding', '%');
  bindSlider(fillSlider, fillVal, 'widthFill', '%');

  // --- Onboarding demo carousel (autoplay + loop) ---
  const demoSlides = Array.from(document.querySelectorAll('.demo-slide'));
  const demoDots = Array.from(document.querySelectorAll('.demo-dots .dot'));
  if (demoSlides.length) {
    let di = 0;
    const showSlide = (n) => {
      demoSlides.forEach((s, i) => s.classList.toggle('active', i === n));
      demoDots.forEach((d, i) => d.classList.toggle('active', i === n));
    };
    showSlide(0);
    setInterval(() => {
      di = (di + 1) % demoSlides.length;
      showSlide(di);
    }, 2800);
  }

  // Restore any saved slider settings from a previous session.
  parent.postMessage({ pluginMessage: { type: 'load-settings' } }, '*');

  setLoading(false);
  console.log('✅ Plugin UI ready!');
});
