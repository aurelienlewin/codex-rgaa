import fs from 'node:fs/promises';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { rgb as contrastRgb } from 'wcag-contrast';
import Color from 'colorjs.io';
import { load as loadCheerio } from 'cheerio';

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseColor(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const color = new Color(raw);
    return color.to('srgb');
  } catch {
    return null;
  }
}

function colorToRgbArray(color) {
  if (!color) return null;
  const rgb = color.coords;
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  return rgb.slice(0, 3).map((c) => Math.max(0, Math.min(1, c)));
}

function isTransparentColor(color) {
  if (!color) return true;
  if (typeof color.alpha === 'number') return color.alpha === 0;
  return false;
}

function parseFontSizePx(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/([0-9.]+)/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

function isBold(fontWeight) {
  const raw = String(fontWeight || '').trim();
  if (!raw) return false;
  if (/bold/i.test(raw)) return true;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >= 700 : false;
}

function classifyContrast({ ratio, fontSizePx, fontWeight }) {
  if (!Number.isFinite(ratio)) return null;
  const size = Number.isFinite(fontSizePx) ? fontSizePx : null;
  const bold = isBold(fontWeight);
  const largeText = size !== null && (size >= 24 || (size >= 18.66 && bold));
  const aa = ratio >= (largeText ? 3 : 4.5);
  const aaa = ratio >= (largeText ? 4.5 : 7);
  return { aa, aaa, largeText };
}

async function loadPngBuffer(filePath, width = 900) {
  const buf = await sharp(filePath).resize({ width, withoutEnlargement: true }).png().toBuffer();
  return PNG.sync.read(buf);
}

export async function analyzeMotion({ screenshot1, screenshot2 }) {
  if (!screenshot1 || !screenshot2) return null;
  try {
    const img1 = await loadPngBuffer(screenshot1);
    const img2 = await loadPngBuffer(screenshot2);
    const width = Math.min(img1.width, img2.width);
    const height = Math.min(img1.height, img2.height);
    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 }
    );
    const total = width * height;
    const ratio = total ? diffPixels / total : 0;
    return {
      diffPixels,
      totalPixels: total,
      diffRatio: Number(ratio.toFixed(4)),
      motionLikely: ratio > 0.01
    };
  } catch {
    return null;
  }
}

export function analyzeContrast(styleSamples = []) {
  const results = [];
  for (const sample of styleSamples) {
    const fg = parseColor(sample.color);
    const bg = parseColor(sample.backgroundColor);
    const fgRgb = colorToRgbArray(fg);
    const bgRgb = colorToRgbArray(bg);
    if (!fgRgb || !bgRgb) continue;
    try {
      const fgScaled = fgRgb.map((c) => Math.round(c * 255));
      const bgScaled = bgRgb.map((c) => Math.round(c * 255));
      const ratio = contrastRgb(fgScaled, bgScaled);
      results.push({
        text: sample.text,
        selector: sample.selector,
        ratio: Number(ratio.toFixed(2)),
        color: sample.color,
        backgroundColor: sample.backgroundColor,
        fontSize: sample.fontSize,
        fontWeight: sample.fontWeight
      });
    } catch {}
  }
  const sorted = results.slice().sort((a, b) => a.ratio - b.ratio);
  const worst = sorted[0] || null;
  const worstClassification = worst
    ? classifyContrast({
        ratio: worst.ratio,
        fontSizePx: parseFontSizePx(worst.fontSize),
        fontWeight: worst.fontWeight
      })
    : null;
  const failing = results.filter((r) => r.ratio < 4.5).length;
  return {
    sampleCount: results.length,
    failingCount: failing,
    worstSample: worst,
    worstClassification
  };
}

export function analyzeUiContrast(uiSamples = []) {
  const results = [];
  for (const sample of uiSamples) {
    const bg = parseColor(sample.backgroundColor);
    const border = parseColor(sample.borderColor);
    const text = parseColor(sample.color);
    const parentBg = parseColor(sample.parentBackgroundColor);
    let component = null;
    let source = '';
    if (bg && !isTransparentColor(bg)) {
      component = bg;
      source = 'background';
    } else if (border && !isTransparentColor(border)) {
      component = border;
      source = 'border';
    } else if (text && !isTransparentColor(text)) {
      component = text;
      source = 'text';
    }
    if (!component || !parentBg) continue;
    const compRgb = colorToRgbArray(component);
    const bgRgb = colorToRgbArray(parentBg);
    if (!compRgb || !bgRgb) continue;
    try {
      const compScaled = compRgb.map((c) => Math.round(c * 255));
      const bgScaled = bgRgb.map((c) => Math.round(c * 255));
      const ratio = contrastRgb(compScaled, bgScaled);
      results.push({
        text: sample.text,
        selector: sample.selector,
        role: sample.role,
        ratio: Number(ratio.toFixed(2)),
        source,
        color: sample.color,
        backgroundColor: sample.backgroundColor,
        borderColor: sample.borderColor,
        parentBackgroundColor: sample.parentBackgroundColor,
        fontSize: sample.fontSize,
        fontWeight: sample.fontWeight
      });
    } catch {}
  }
  const sorted = results.slice().sort((a, b) => a.ratio - b.ratio);
  const worst = sorted[0] || null;
  const failing = results.filter((r) => r.ratio < 3).length;
  return {
    sampleCount: results.length,
    failingCount: failing,
    worstSample: worst
  };
}

export function analyzeHtmlHints(htmlSnippet = '') {
  if (!htmlSnippet) return null;
  const $ = loadCheerio(htmlSnippet);
  const marqueeCount = $('marquee').length;
  const blinkCount = $('blink').length;
  const styleAnimCount = $('[style*="animation"],[style*="transition"]').length;
  const targetBlankLinks = $('a[target="_blank"]').length;
  const downloadLinks = $('a[download]').length;
  const autoplayMedia = $('video[autoplay], audio[autoplay]').length;
  return {
    marqueeCount,
    blinkCount,
    inlineAnimationCount: styleAnimCount,
    targetBlankLinks,
    downloadLinks,
    autoplayMedia
  };
}

function getText($el) {
  return ($el.text() || '').replace(/\s+/g, ' ').trim();
}

function normalizeLinkText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2019'".,:;!?()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_LINK_TEXTS = new Set([
  'cliquez ici',
  'ici',
  'lire la suite',
  'lire plus',
  'en savoir plus',
  'plus',
  'voir plus',
  'voir',
  'découvrir',
  'decouvrir',
  'suite',
  'details',
  'détails',
  'accéder',
  'acceder'
]);

function getAccessibleName($, $el) {
    const ariaLabel = ($el.attr('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;
    const labelledBy = ($el.attr('aria-labelledby') || '').trim();
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const text = ids
        .map((id) => getText($(`[id="${id}"]`)))
        .join(' ')
        .trim();
      if (text) return text;
    }
  const text = getText($el);
  if (text) return text;
  const title = ($el.attr('title') || '').trim();
  if (title) return title;
  return '';
}

export function analyzeDomHints(htmlSnippet = '') {
  if (!htmlSnippet) return null;
  const $ = loadCheerio(htmlSnippet);
  const html = $('html').first();
  const title = getText($('title').first());
  const lang = (html.attr('lang') || '').trim();
  const dir = (html.attr('dir') || '').trim();

  const imageNodes = $('img, [role="img"]');
  let missingAltCount = 0;
  let roleImgMissingNameCount = 0;
  imageNodes.each((_, el) => {
    const $el = $(el);
    const tag = ($el.prop('tagName') || '').toLowerCase();
    const role = ($el.attr('role') || '').toLowerCase();
    const ariaHidden = ($el.attr('aria-hidden') || '').toLowerCase() === 'true';
    const alt = $el.attr('alt');
    if (tag === 'img' && alt == null && !ariaHidden) missingAltCount += 1;
    if (tag !== 'img' && role === 'img' && !getAccessibleName($, $el)) {
      roleImgMissingNameCount += 1;
    }
  });

  const frameNodes = $('iframe, frame');
  let missingTitleCount = 0;
  frameNodes.each((_, el) => {
    const $el = $(el);
    const title = ($el.attr('title') || '').trim();
    const ariaLabel = ($el.attr('aria-label') || '').trim();
    const ariaLabelledby = ($el.attr('aria-labelledby') || '').trim();
    if (!title && !ariaLabel && !ariaLabelledby) missingTitleCount += 1;
  });

  const linkNodes = $('a[href]');
  let missingNameCount = 0;
  let genericCount = 0;
  let skipLinkFound = false;
  linkNodes.each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    const name = getAccessibleName($, $el);
    if (!name) {
      missingNameCount += 1;
      return;
    }
    const normalized = normalizeLinkText(name);
    if (
      GENERIC_LINK_TEXTS.has(normalized) ||
      (normalized.length <= 3 && ['+','→','>>','>'].includes(normalized))
    ) {
      genericCount += 1;
    }
    if (href.startsWith('#')) {
      if (normalized.includes('contenu') || normalized.includes('skip') || normalized.includes('principal')) {
        skipLinkFound = true;
      }
    }
  });

  const headingNodes = $('h1, h2, h3, h4, h5, h6');
  let h1Count = 0;
  let hasLevelJumps = false;
  let prevLevel = null;
  headingNodes.each((_, el) => {
    const level = Number(String($(el).prop('tagName') || '').replace('H', ''));
    if (level === 1) h1Count += 1;
    if (prevLevel !== null && level - prevLevel > 1) hasLevelJumps = true;
    prevLevel = level;
  });

  const listNodes = $('li');
  let invalidListCount = 0;
  listNodes.each((_, el) => {
    const parent = (el.parentNode && el.parentNode.tagName) ? el.parentNode.tagName.toLowerCase() : '';
    if (!['ul', 'ol', 'menu'].includes(parent)) invalidListCount += 1;
  });

  const controlNodes = $('input, select, textarea').filter((_, el) => {
    const type = (($(el).attr('type') || '')).toLowerCase();
    return !['hidden', 'submit', 'reset', 'button'].includes(type);
  });
  let missingLabelCount = 0;
  controlNodes.each((_, el) => {
    const $el = $(el);
    const aria = ($el.attr('aria-label') || '').trim();
    const labelledby = ($el.attr('aria-labelledby') || '').trim();
    let labelText = '';
      if (labelledby) {
        const ids = labelledby.split(/\s+/).filter(Boolean);
        labelText = ids.map((id) => getText($(`[id="${id}"]`))).join(' ').trim();
      }
    if (!labelText) {
      const id = ($el.attr('id') || '').trim();
      if (id) labelText = getText($(`label[for="${id}"]`).first());
    }
    if (!labelText) {
      const parentLabel = $el.closest('label');
      if (parentLabel.length) labelText = getText(parentLabel);
    }
    if (!aria && !labelText) missingLabelCount += 1;
  });

  return {
    title,
    lang,
    dir,
    imageSummary: {
      total: imageNodes.length,
      missingAltCount,
      roleImgMissingNameCount
    },
    frameSummary: {
      total: frameNodes.length,
      missingTitleCount
    },
    linkSummary: {
      total: linkNodes.length,
      missingNameCount,
      genericCount,
      skipLinkFound
    },
    headingAnalysis: {
      h1Count,
      hasLevelJumps
    },
    listSummary: {
      total: listNodes.length,
      invalidCount: invalidListCount
    },
    formSummary: {
      controlsTotal: controlNodes.length,
      missingLabel: missingLabelCount
    }
  };
}

export async function buildEnrichment({
  screenshot1,
  screenshot2,
  styleSamples,
  uiSamples,
  htmlSnippet
}) {
  const motion = await analyzeMotion({ screenshot1, screenshot2 });
  const contrastSummary = analyzeContrast(styleSamples);
  const uiContrastSummary = analyzeUiContrast(uiSamples);
  const htmlHints = analyzeHtmlHints(htmlSnippet);
  const domHints = analyzeDomHints(htmlSnippet);
  return {
    motion,
    contrast: contrastSummary,
    uiContrast: uiContrastSummary,
    htmlHints,
    domHints
  };
}
