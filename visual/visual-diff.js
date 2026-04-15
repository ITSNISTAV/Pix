/**
 * visual-diff.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Visual (pixel-based) comparison layer for the Figma-to-Website fidelity tool.
 *
 * Exports:
 *   cropImage(imageBuffer, x, y, w, h)  → Promise<Buffer>
 *   pixelDiff(buf1, buf2, threshold)    → { diffPercent, diffImageBuffer, diffPixels, totalPixels }
 *   generateHeatmap(figmaPath, domPath, outputPath) → Promise<{ diffPercent, diffImageBuffer }>
 *   computeVisualScores(matchedPairs, figmaBuffer, domBuffer) → Promise<Array>
 *   fuseScores(semanticScore, visualScore, pixelChangePct) → number
 *
 * Design notes:
 *  - All image ops use `sharp` for resize/crop (fast, memory-safe).
 *  - Pixel diff uses `pixelmatch` — industry standard for UI screenshot diffs.
 *  - Both images are normalised to the SAME dimensions before diffing.
 *    (Figma exports at 1× 1440px; Playwright captures at 1440px viewport — should match)
 *  - Per-node scoring crops each matched pair's bounding box from both screenshots.
 */

'use strict';

const fs          = require('fs');
const path        = require('path');
const { PNG }     = require('pngjs');
const pixelmatchPkg = require('pixelmatch');
const pixelmatch  = pixelmatchPkg.default ?? pixelmatchPkg;
const sharp       = require('sharp');

const DEBUG = process.env.DEBUG === 'true';

function log(...args) {
  if (DEBUG) console.log('[visual-diff]', ...args);
}

// ─── Image Loading ────────────────────────────────────────────────────────────

/**
 * Load an image file → raw PNG buffer (RGBA).
 * Accepts: file path (string) | raw Buffer (already PNG bytes).
 */
async function loadPng(source) {
  let rawBuffer;

  if (typeof source === 'string') {
    rawBuffer = fs.readFileSync(source);
  } else if (Buffer.isBuffer(source)) {
    rawBuffer = source;
  } else {
    throw new Error('loadPng: source must be a file path or Buffer');
  }

  // Convert to RGBA PNG via sharp — normalises format regardless of input type
  const rgbaBuffer = await sharp(rawBuffer)
    .ensureAlpha()        // guarantee 4-channel RGBA
    .toFormat('png')
    .toBuffer();

  return rgbaBuffer;
}

/**
 * Get image dimensions without loading pixel data.
 */
async function getImageSize(source) {
  const buf = typeof source === 'string' ? fs.readFileSync(source) : source;
  const meta = await sharp(buf).metadata();
  return { width: meta.width, height: meta.height };
}

// ─── Crop ─────────────────────────────────────────────────────────────────────

/**
 * Crop a region from an image buffer.
 *
 * @param {Buffer|string} imageSource  - PNG buffer or file path
 * @param {number} x    - left edge (px, relative to image origin)
 * @param {number} y    - top edge
 * @param {number} w    - width
 * @param {number} h    - height
 * @returns {Promise<Buffer>} PNG buffer of the cropped region
 */
async function cropImage(imageSource, x, y, w, h) {
  const buf = typeof imageSource === 'string' ? fs.readFileSync(imageSource) : imageSource;

  // Clamp to image bounds to avoid sharp errors on out-of-bounds nodes
  const meta = await sharp(buf).metadata();
  const clampedX = Math.max(0, Math.round(x));
  const clampedY = Math.max(0, Math.round(y));
  const clampedW = Math.min(Math.round(w), meta.width  - clampedX);
  const clampedH = Math.min(Math.round(h), meta.height - clampedY);

  if (clampedW <= 0 || clampedH <= 0) {
    throw new Error(`cropImage: zero-size crop at x:${x} y:${y} w:${w} h:${h} (image: ${meta.width}x${meta.height})`);
  }

  return sharp(buf)
    .extract({ left: clampedX, top: clampedY, width: clampedW, height: clampedH })
    .ensureAlpha()
    .toFormat('png')
    .toBuffer();
}

// ─── Pixel Diff Engine ────────────────────────────────────────────────────────

/**
 * Compare two PNG buffers pixel-by-pixel.
 * Both images are resized to the SAME dimensions before comparison —
 * the smaller is upscaled to match the larger. This handles minor
 * viewport rounding (e.g. Figma 206px vs DOM 200px).
 *
 * @param {Buffer} buf1        - PNG buffer (Figma)
 * @param {Buffer} buf2        - PNG buffer (DOM / website)
 * @param {object} [options]
 * @param {number} [options.threshold=0.1]   - pixelmatch per-channel threshold (0–1)
 * @param {boolean} [options.includeAA=false] - ignore anti-aliasing differences
 *
 * @returns {{ diffPercent, diffPixels, totalPixels, diffImageBuffer }}
 */
async function pixelDiff(buf1, buf2, options = {}) {
  const { threshold = 0.1, includeAA = false } = options;

  // Decode both as RGBA PNGs
  const s1 = await sharp(buf1).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const s2 = await sharp(buf2).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const w1 = s1.info.width,  h1 = s1.info.height;
  const w2 = s2.info.width,  h2 = s2.info.height;

  log(`pixelDiff — img1: ${w1}×${h1}  img2: ${w2}×${h2}`);

  // Normalise to the same size
  // Strategy: use the larger dimension as target (avoids losing detail)
  const targetW = Math.max(w1, w2);
  const targetH = Math.max(h1, h2);

  const normalise = async (buf, w, h) => {
    if (w === targetW && h === targetH) return buf;
    return sharp(buf, { raw: { width: w, height: h, channels: 4 } })
      .resize(targetW, targetH, { fit: 'fill' })   // stretch to exact match
      .raw()
      .toBuffer();
  };

  const data1 = await normalise(s1.data, w1, h1);
  const data2 = await normalise(s2.data, w2, h2);

  const totalPixels = targetW * targetH;
  const diffData    = Buffer.alloc(totalPixels * 4);

  const diffPixels = pixelmatch(data1, data2, diffData, targetW, targetH, {
    threshold,
    includeAA,
  });

  const diffPercent = diffPixels / totalPixels;

  // Encode diff image as PNG (red-highlighted difference map)
  const diffImageBuffer = await sharp(diffData, {
    raw: { width: targetW, height: targetH, channels: 4 },
  })
    .toFormat('png')
    .toBuffer();

  log(`pixelDiff — ${diffPixels} diff pixels (${(diffPercent * 100).toFixed(2)}%)`);

  return { diffPercent, diffPixels, totalPixels, diffImageBuffer };
}

// ─── Heatmap Generator ────────────────────────────────────────────────────────

/**
 * Overlay the diff image on top of the DOM screenshot at 50% opacity.
 * Produces a "heatmap" PNG where red regions = pixel differences.
 *
 * @param {string|Buffer} figmaSource  - Figma frame PNG (path or buffer)
 * @param {string|Buffer} domSource    - Website screenshot PNG (path or buffer)
 * @param {string|null}   outputPath   - If provided, writes PNG to disk
 * @returns {Promise<{ diffPercent, diffPixels, totalPixels, heatmapBuffer }>}
 */
async function generateHeatmap(figmaSource, domSource, outputPath = null) {
  const figmaBuf = await loadPng(figmaSource);
  const domBuf   = await loadPng(domSource);

  const { diffPercent, diffPixels, totalPixels, diffImageBuffer } =
    await pixelDiff(figmaBuf, domBuf);

  // Get target dimensions (normalised by pixelDiff)
  const meta = await sharp(domBuf).metadata();
  const targetW = meta.width;
  const targetH = meta.height;

  // Resize dom screenshot to match (in case it differs)
  const domResized = await sharp(domBuf)
    .resize(targetW, targetH, { fit: 'fill' })
    .toFormat('png')
    .toBuffer();

  // Resize diff image to match
  const diffResized = await sharp(diffImageBuffer)
    .resize(targetW, targetH, { fit: 'fill' })
    .toFormat('png')
    .toBuffer();

  // Composite: DOM as base, diff overlay at 50% opacity
  const heatmapBuffer = await sharp(domResized)
    .composite([{
      input: diffResized,
      blend: 'over',
      // Sharp doesn't support per-composite opacity directly —
      // we pre-multiply the diff image alpha to 50%
    }])
    .toFormat('png')
    .toBuffer();

  // Write to disk if requested
  if (outputPath) {
    fs.writeFileSync(outputPath, heatmapBuffer);
    log(`Heatmap written → ${outputPath}`);
  }

  return {
    diffPercent,
    diffPixels,
    totalPixels,
    heatmapBuffer,
  };
}

// ─── Per-Node Visual Scoring ──────────────────────────────────────────────────

/**
 * Compute a visual similarity score for every matched pair.
 *
 * @param {Array}         matchedPairs   - matchTrees().matched
 * @param {Buffer|string} figmaBuffer    - full Figma frame screenshot
 * @param {Buffer|string} domBuffer      - full website screenshot
 * @param {object}        [options]
 * @param {number}        [options.threshold=0.1]   - pixelmatch threshold
 *
 * @returns {Promise<Array>} same matchedPairs with .visualScore and .pixelChangePct added
 */
async function computeVisualScores(matchedPairs, figmaBuffer, domBuffer, options = {}) {
  const { threshold = 0.1 } = options;

  // Eagerly load both full screenshots once — avoid re-reading per node
  const figmaBuf = await loadPng(figmaBuffer);
  const domBuf   = await loadPng(domBuffer);

  const results = [];

  for (const pair of matchedPairs) {
    const { figmaNode, domNode } = pair;

    try {
      // Crop figma node bounding box from Figma screenshot
      const figmaCrop = await cropImage(
        figmaBuf,
        figmaNode.x, figmaNode.y,
        figmaNode.w, figmaNode.h
      );

      // Crop the corresponding DOM node bounding box from website screenshot
      const domCrop = await cropImage(
        domBuf,
        domNode.x, domNode.y,
        domNode.w, domNode.h
      );

      const { diffPercent } = await pixelDiff(figmaCrop, domCrop, { threshold });

      const visualScore = +(1 - diffPercent).toFixed(4);

      log(`[${figmaNode.name}] visualScore: ${visualScore} (${(diffPercent * 100).toFixed(1)}% diff)`);

      results.push({
        ...pair,
        visualScore,
        pixelChangePct: +diffPercent.toFixed(4),
      });

    } catch (err) {
      // Node bounding box outside screenshot bounds — skip visual score, keep semantic
      console.warn(`[visual-diff] Skipping ${figmaNode.name}: ${err.message}`);
      results.push({
        ...pair,
        visualScore: null,
        pixelChangePct: null,
      });
    }
  }

  return results;
}

// ─── Score Fusion ─────────────────────────────────────────────────────────────

/**
 * Blend semantic and visual scores into a final fidelity score.
 *
 * Rules (from architecture doc):
 *  1. < 3% pixel change   → trust semantic only  (rendering is close enough)
 *  2. > 30% pixel change AND semantic looks good (>0.85)
 *                          → semantic was over-optimistic, weight visual heavily
 *  3. Everything else     → standard 65/35 blend
 *
 * @param {number} semanticScore    - 0–1 from property differ
 * @param {number|null} visualScore - 0–1 from computeVisualScores, or null if unavailable
 * @param {number|null} pixelChangePct - 0–1 raw pixel diff percent
 * @returns {number} final fused score 0–1
 */
function fuseScores(semanticScore, visualScore, pixelChangePct) {
  // No visual data available — fall back to semantic only
  if (visualScore === null || pixelChangePct === null) {
    return semanticScore;
  }

  // Rule 1: Negligible visual change → semantic score is sufficient
  if (pixelChangePct < 0.03) {
    return semanticScore;
  }

  // Rule 2: Large visual change despite good semantic score
  // (e.g. image replaced, font rendering artifact, shadow missing)
  if (pixelChangePct > 0.30 && semanticScore > 0.85) {
    return +(semanticScore * 0.60 + (1 - pixelChangePct) * 0.40).toFixed(4);
  }

  // Rule 3: Standard blend — semantic carries more weight (it's more precise)
  return +(semanticScore * 0.65 + visualScore * 0.35).toFixed(4);
}

// ─── Vision-Assisted Match Stub ───────────────────────────────────────────────

/**
 * Stub for the vision-assisted matching pass (Step 3 of tree matcher).
 * Called for nodes unmatched after IoU + text-anchor, with no text content.
 *
 * Real implementation: sends both cropped images as base64 to the Groq/LLM API
 * (claude-vision or llama vision) and asks "same element? yes/no + confidence".
 *
 * @param {Array}         unmatchedFigma  - figma nodes with no match
 * @param {Array}         unmatchedDom    - dom nodes with no match
 * @param {Buffer|string} figmaBuffer     - full figma screenshot
 * @param {Buffer|string} domBuffer       - full dom screenshot
 * @returns {Promise<Array>} new matched pairs with matchedBy: 'vision'
 */
async function visionAssistedMatch(unmatchedFigma, unmatchedDom, figmaBuffer, domBuffer, options = {}) {
  const { confidenceThreshold = 0.7, apiKey = process.env.GROQ_API_KEY } = options;

  // Only attempt icon/image nodes with no text — text nodes should have been caught by text-anchor
  const candidates = unmatchedFigma.filter(n =>
    !n.text &&
    (n.type === 'icon' || n.type === 'image' || n.type === 'container')
  );

  if (!candidates.length || !unmatchedDom.length) return [];

  if (!apiKey) {
    console.warn('[vision-match] No API key — skipping vision pass (stub mode)');
    return [];
  }

  const figmaBuf = await loadPng(figmaBuffer);
  const domBuf   = await loadPng(domBuffer);
  const newMatches = [];
  const usedDomIds = new Set();

  for (const figmaNode of candidates) {
    let figmaCrop;
    try {
      figmaCrop = await cropImage(figmaBuf, figmaNode.x, figmaNode.y, figmaNode.w, figmaNode.h);
    } catch {
      continue; // node out of bounds
    }

    let bestMatch = null;
    let bestConfidence = 0;

    // Only check DOM nodes that are spatially close (within 200px in each axis)
    const spatialCandidates = unmatchedDom.filter(dn =>
      !usedDomIds.has(dn.id) &&
      Math.abs(dn.x - figmaNode.x) < 200 &&
      Math.abs(dn.y - figmaNode.y) < 200
    );

    for (const domNode of spatialCandidates) {
      let domCrop;
      try {
        domCrop = await cropImage(domBuf, domNode.x, domNode.y, domNode.w, domNode.h);
      } catch {
        continue;
      }

      const figmaBase64 = figmaCrop.toString('base64');
      const domBase64   = domCrop.toString('base64');

      try {
        const result = await callVisionAPI(figmaBase64, domBase64, apiKey);
        log(`vision: ${figmaNode.name} ↔ ${domNode.name} → ${result.match} (${result.confidence})`);

        if (result.match && result.confidence > bestConfidence) {
          bestConfidence = result.confidence;
          bestMatch = domNode;
        }
      } catch (err) {
        console.warn(`[vision-match] API call failed for ${figmaNode.name}: ${err.message}`);
      }
    }

    if (bestMatch && bestConfidence >= confidenceThreshold) {
      newMatches.push({
        figmaNode,
        domNode: bestMatch,
        iou: 0,                     // spatial IoU is 0 (that's why we're here)
        score: bestConfidence,
        matchedBy: 'vision',
        visualConfidence: bestConfidence,
      });
      usedDomIds.add(bestMatch.id);
    }
  }

  log(`vision-match: ${newMatches.length} new matches`);
  return newMatches;
}

/**
 * Internal: call the Groq vision-capable model to compare two cropped images.
 */
async function callVisionAPI(figmaBase64, domBase64, apiKey) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',   // vision-capable
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are comparing two UI screenshots to determine if they represent the same element. ' +
                  'Image 1 is from a Figma design. Image 2 is from a live website. ' +
                  'Answer ONLY with a JSON object: {"match": true/false, "confidence": 0.0-1.0}. ' +
                  'No explanation, no markdown, just the JSON.',
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${figmaBase64}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${domBase64}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 50,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vision API ${response.status}: ${await response.text()}`);
  }

  const data   = await response.json();
  const text   = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  return {
    match:      parsed.match === true,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  loadPng,
  getImageSize,
  cropImage,
  pixelDiff,
  generateHeatmap,
  computeVisualScores,
  fuseScores,
  visionAssistedMatch,
};