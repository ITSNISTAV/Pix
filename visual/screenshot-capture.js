/**
 * screenshot-capture.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilities to obtain screenshots from:
 *   A) Figma — via the Figma API /v1/images endpoint
 *   B) Website — via Playwright full-page screenshot
 *
 * Both outputs are PNG Buffers at 1440px width, ready to pass into visual-diff.js.
 *
 * Usage:
 *   const { captureFigmaFrame, captureWebsiteScreenshot, alignScreenshots } = require('./screenshot-capture');
 *
 *   const figmaBuf  = await captureFigmaFrame(fileKey, nodeId, figmaToken);
 *   const domBuf    = await captureWebsiteScreenshot('https://example.com');
 *   const { figma, dom } = await alignScreenshots(figmaBuf, domBuf);
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');

const VIEWPORT_WIDTH  = 1440;
const VIEWPORT_HEIGHT = 900;

// ─── A: Figma Frame Screenshot ────────────────────────────────────────────────

/**
 * Export a Figma frame as a PNG buffer using the Figma REST API.
 *
 * Steps:
 *  1. POST to /v1/images to get a signed S3 URL for the rendered frame
 *  2. Fetch the PNG from that URL
 *  3. Return as a Buffer
 *
 * @param {string} fileKey      - Figma file key (from the URL: figma.com/file/<KEY>/...)
 * @param {string} nodeId       - Figma node ID of the frame (e.g. "4:2")
 *                                Set to null to export the first frame automatically.
 * @param {string} figmaToken   - Figma personal access token (FIGMA_TOKEN env var)
 * @param {object} [options]
 * @param {number} [options.scale=1]     - Export scale (1 = 1440px for a 1440px frame)
 * @param {string} [options.format='png'] - 'png' | 'jpg' | 'svg'
 *
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function captureFigmaFrame(fileKey, nodeId, figmaToken, options = {}) {
  const { scale = 1, format = 'png' } = options;

  if (!figmaToken) throw new Error('captureFigmaFrame: FIGMA_TOKEN is required');
  if (!fileKey)    throw new Error('captureFigmaFrame: fileKey is required');

  // Step 1 — Request the image URL from Figma
  const ids = nodeId ?? await getFirstFrameId(fileKey, figmaToken);
  const apiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`;

  const apiRes = await fetch(apiUrl, {
    headers: { 'X-Figma-Token': figmaToken },
  });

  if (!apiRes.ok) {
    const err = await apiRes.text();
    throw new Error(`Figma API error ${apiRes.status}: ${err}`);
  }

  const apiData = await apiRes.json();

  if (apiData.err) {
    throw new Error(`Figma returned error: ${apiData.err}`);
  }

  const imageUrl = apiData.images?.[ids];
  if (!imageUrl) {
    throw new Error(`Figma API returned no image URL for node ${ids}`);
  }

  // Step 2 — Download the rendered PNG from S3
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download Figma image: ${imgRes.status}`);
  }

  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log(`[screenshot] Figma frame captured (${buffer.length} bytes)`);
  return buffer;
}

/**
 * Auto-detect the first FRAME node ID in a Figma file.
 * Used when the caller doesn't know the node ID.
 */
async function getFirstFrameId(fileKey, figmaToken) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': figmaToken },
  });

  if (!res.ok) throw new Error(`Figma files API error ${res.status}`);

  const data = await res.json();
  const pages = data.document?.children ?? [];

  for (const page of pages) {
    for (const child of page.children ?? []) {
      if (child.type === 'FRAME') {
        return child.id;
      }
    }
  }

  throw new Error('No FRAME found in Figma document');
}

// ─── B: Website Screenshot ────────────────────────────────────────────────────

/**
 * Capture a full-page screenshot of a website using Playwright.
 *
 * @param {string} url              - Website URL
 * @param {object} [options]
 * @param {number} [options.width=1440]   - Viewport width
 * @param {number} [options.height=900]   - Viewport height (for initial load; fullPage captures all)
 * @param {number} [options.waitMs=1000]  - Extra wait after networkidle (for lazy images)
 * @param {string} [options.outputPath]   - Optional: save PNG to disk as well
 *
 * @returns {Promise<Buffer>} PNG buffer of the full page
 */
async function captureWebsiteScreenshot(url, options = {}) {
  const {
    width     = VIEWPORT_WIDTH,
    height    = VIEWPORT_HEIGHT,
    waitMs    = 1000,
    outputPath = null,
  } = options;

  // Lazy-load playwright — it's a large dependency and only needed when actually capturing
  const { chromium } = require('playwright');

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: 'networkidle' });

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  // fullPage: true captures everything below the fold
  const buffer = await page.screenshot({ fullPage: true, type: 'png' });

  await browser.close();

  if (outputPath) {
    fs.writeFileSync(outputPath, buffer);
    console.log(`[screenshot] Website screenshot saved → ${outputPath}`);
  }

  console.log(`[screenshot] Website captured: ${url} (${buffer.length} bytes)`);
  return buffer;
}

// ─── C: Alignment / Preprocessing ────────────────────────────────────────────

/**
 * Align two screenshots to the same dimensions for pixel comparison.
 *
 * Strategy:
 *  - Both images should be 1440px wide (Figma frame + DOM viewport both set to 1440).
 *  - Heights may differ — Figma frame is fixed height, DOM may be taller.
 *  - We crop/extend to the FIGMA height (it's the design source of truth).
 *
 * @param {Buffer} figmaBuffer  - Figma frame PNG
 * @param {Buffer} domBuffer    - Website full-page PNG
 * @param {object} [options]
 * @param {number} [options.cropToHeight]  - Force crop both images to this height.
 *                                           Defaults to Figma frame height.
 *
 * @returns {Promise<{ figma: Buffer, dom: Buffer, width: number, height: number }>}
 */
async function alignScreenshots(figmaBuffer, domBuffer, options = {}) {
  const figmaMeta = await sharp(figmaBuffer).metadata();
  const domMeta   = await sharp(domBuffer).metadata();

  const targetWidth  = figmaMeta.width;
  const targetHeight = options.cropToHeight ?? figmaMeta.height;

  console.log(`[screenshot] Aligning — Figma: ${figmaMeta.width}×${figmaMeta.height}, DOM: ${domMeta.width}×${domMeta.height}`);
  console.log(`[screenshot] Target: ${targetWidth}×${targetHeight}`);

  // Resize Figma to target (usually a no-op since it's already correct)
  const figmaAligned = await sharp(figmaBuffer)
    .resize(targetWidth, targetHeight, { fit: 'fill' })
    .toFormat('png')
    .toBuffer();

  // Resize DOM: first ensure width matches, then crop/pad to match height
  let domAligned = await sharp(domBuffer)
    .resize(targetWidth, null, { fit: 'inside' })    // scale to width, keep aspect
    .toFormat('png')
    .toBuffer();

  const domAfterResize = await sharp(domAligned).metadata();

  if (domAfterResize.height > targetHeight) {
    // DOM page is taller than Figma frame — crop from top
    domAligned = await sharp(domAligned)
      .extract({ left: 0, top: 0, width: targetWidth, height: targetHeight })
      .toFormat('png')
      .toBuffer();
  } else if (domAfterResize.height < targetHeight) {
    // DOM page is shorter — extend with white at bottom
    domAligned = await sharp(domAligned)
      .extend({
        bottom: targetHeight - domAfterResize.height,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toFormat('png')
      .toBuffer();
  }

  return {
    figma:  figmaAligned,
    dom:    domAligned,
    width:  targetWidth,
    height: targetHeight,
  };
}

/**
 * Helper: save a buffer to disk. Wraps writeFileSync for cleaner call sites.
 */
function saveBuffer(buffer, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buffer);
  console.log(`[screenshot] Saved → ${filePath}`);
}

/**
 * Helper: load a screenshot from disk into a Buffer.
 */
function loadBuffer(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return fs.readFileSync(filePath);
}

module.exports = {
  captureFigmaFrame,
  captureWebsiteScreenshot,
  alignScreenshots,
  saveBuffer,
  loadBuffer,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
};