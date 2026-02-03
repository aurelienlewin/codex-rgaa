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
  const failing = results.filter((r) => r.ratio < 4.5).length;
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

export async function buildEnrichment({ screenshot1, screenshot2, styleSamples, htmlSnippet }) {
  const motion = await analyzeMotion({ screenshot1, screenshot2 });
  const contrastSummary = analyzeContrast(styleSamples);
  const htmlHints = analyzeHtmlHints(htmlSnippet);
  return {
    motion,
    contrast: contrastSummary,
    htmlHints
  };
}
