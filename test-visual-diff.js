/**
 * test-visual-diff.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Test scaffold for the visual pipeline.
 * Runs on the existing cake shop semantic data without needing real screenshots.
 *
 * What it tests:
 *  1. cropImage()         — basic crop math
 *  2. pixelDiff()         — identical images score 0%, different score >0%
 *  3. generateHeatmap()   — produces a valid PNG
 *  4. computeVisualScores() — runs per-node scoring on mock matched pairs
 *  5. fuseScores()        — all three blending rules
 *  6. scoreAggregator     — aggregate() with visual data attached
 *
 * Run:
 *   node test-visual-diff.js
 * 
 * Set DEBUG=true for verbose per-node logs:
 *   DEBUG=true node test-visual-diff.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Colours ──────────────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}`);
    failed++;
  }
}

async function assertThrows(fn, label) {
  try {
    await fn();
    console.log(`  ${RED}✗${RESET} ${label} (expected throw, got none)`);
    failed++;
  } catch {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  }
}

function section(title) {
  console.log(`\n${BOLD}${BLUE}── ${title} ──${RESET}`);
}

// ─── Mock PNG Generator ───────────────────────────────────────────────────────
// Creates a minimal valid PNG buffer filled with a solid color.
// sharp accepts this, so it's a realistic stand-in for real screenshots.

async function createMockPng(width, height, r, g, b) {
  const sharp = require('sharp');
  // Create a buffer filled with RGBA pixel data
  const channels = 4;
  const pixelData = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    pixelData[i * channels + 0] = r;
    pixelData[i * channels + 1] = g;
    pixelData[i * channels + 2] = b;
    pixelData[i * channels + 3] = 255;  // fully opaque
  }

  return sharp(pixelData, { raw: { width, height, channels } })
    .toFormat('png')
    .toBuffer();
}

async function createMockPngWithRegion(width, height, bgR, bgG, bgB, region) {
  // region: { x, y, w, h, r, g, b } — a colored rectangle on a solid background
  const sharp = require('sharp');
  const channels = 4;
  const pixelData = Buffer.alloc(width * height * channels);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const inRegion = region &&
        px >= region.x && px < region.x + region.w &&
        py >= region.y && py < region.y + region.h;

      const pr = inRegion ? region.r : bgR;
      const pg = inRegion ? region.g : bgG;
      const pb = inRegion ? region.b : bgB;

      const idx = (py * width + px) * channels;
      pixelData[idx + 0] = pr;
      pixelData[idx + 1] = pg;
      pixelData[idx + 2] = pb;
      pixelData[idx + 3] = 255;
    }
  }

  return sharp(pixelData, { raw: { width, height, channels } })
    .toFormat('png')
    .toBuffer();
}

// ─── Mock Matched Pairs ───────────────────────────────────────────────────────
// Minimal structure matching what matchTrees() returns, enough for computeVisualScores()

function buildMockPairs() {
  return [
    {
      figmaNode: { id: 'fig-1', name: 'Hero Button',  x: 10, y: 10, w: 100, h: 40, type: 'composite' },
      domNode:   { id: 'dom-1', name: 'button#dom-1', x: 10, y: 10, w: 100, h: 40, domTag: 'button' },
      iou: 0.91, score: 0.88, matchedBy: 'iou',
    },
    {
      figmaNode: { id: 'fig-2', name: 'Hero Title', x: 10, y: 60, w: 200, h: 30, type: 'text' },
      domNode:   { id: 'dom-2', name: 'h1#dom-2',   x: 10, y: 65, w: 180, h: 28, domTag: 'h1' },
      iou: 0.78, score: 0.82, matchedBy: 'iou',
    },
    {
      figmaNode: { id: 'fig-3', name: 'Card Image', x: 220, y: 10, w: 160, h: 120, type: 'image' },
      domNode:   { id: 'dom-3', name: 'img#dom-3',  x: 220, y: 10, w: 160, h: 120, domTag: 'img' },
      iou: 0.99, score: 0.95, matchedBy: 'iou',
    },
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n${BOLD}Visual Diff Test Suite${RESET}`);
  console.log('Testing: visual-diff.js  +  scoreAggregator (visual layer)\n');

  const {
    cropImage,
    pixelDiff,
    generateHeatmap,
    computeVisualScores,
    fuseScores,
    loadPng,
    getImageSize,
  } = require('./visual/visual-diff');

  // ── 1. loadPng and getImageSize ───────────────────────────────────────────
  section('1. Image Loading');

  const img400x300 = await createMockPng(400, 300, 255, 255, 255);  // white
  const img400x300_red = await createMockPng(400, 300, 255, 0, 0);  // red

  const loaded = await loadPng(img400x300);
  assert(Buffer.isBuffer(loaded), 'loadPng returns a Buffer');

  const size = await getImageSize(img400x300);
  assert(size.width === 400 && size.height === 300, `getImageSize: ${size.width}×${size.height} (expected 400×300)`);

  // ── 2. cropImage ──────────────────────────────────────────────────────────
  section('2. cropImage');

  const cropped = await cropImage(img400x300, 10, 10, 50, 30);
  assert(Buffer.isBuffer(cropped), 'cropImage returns a Buffer');

  const croppedSize = await getImageSize(cropped);
  assert(croppedSize.width === 50 && croppedSize.height === 30,
    `Crop dimensions: ${croppedSize.width}×${croppedSize.height} (expected 50×30)`);

  // Clamping — crop extending past edge should clamp, not throw
  const clampedCrop = await cropImage(img400x300, 380, 280, 100, 100);
  const clampedSize = await getImageSize(clampedCrop);
  assert(clampedSize.width <= 20 && clampedSize.height <= 20,
    `Clamp works: ${clampedSize.width}×${clampedSize.height} (expected ≤20×20)`);

  // Zero-size crop should throw
  await assertThrows(
    () => cropImage(img400x300, 400, 300, 100, 100),
    'Zero-size crop throws'
  );

  // ── 3. pixelDiff — identical images ──────────────────────────────────────
  section('3. pixelDiff — Identical Images');

  const { diffPercent: diffIdentical, diffPixels: dpIdentical } =
    await pixelDiff(img400x300, img400x300);

  assert(diffIdentical === 0, `Identical images: 0% diff (got ${(diffIdentical * 100).toFixed(2)}%)`);
  assert(dpIdentical === 0, `Diff pixels = 0 (got ${dpIdentical})`);

  // ── 4. pixelDiff — completely different images ────────────────────────────
  section('4. pixelDiff — Different Images');

  const { diffPercent: diffDifferent, diffPixels: dpDifferent, diffImageBuffer } =
    await pixelDiff(img400x300, img400x300_red);

  assert(diffDifferent > 0, `Different images: ${(diffDifferent * 100).toFixed(1)}% diff > 0%`);
  assert(diffDifferent > 0.50, `Completely different images: ${(diffDifferent * 100).toFixed(0)}% > 50%`);
  assert(Buffer.isBuffer(diffImageBuffer), 'pixelDiff returns diffImageBuffer');

  const diffImgSize = await getImageSize(diffImageBuffer);
  assert(diffImgSize.width === 400, `Diff image width: ${diffImgSize.width} (expected 400)`);

  // ── 5. pixelDiff — different sizes (normalised) ───────────────────────────
  section('5. pixelDiff — Different Dimensions (normalisation)');

  const img500x400 = await createMockPng(500, 400, 255, 255, 255);  // same color, diff size
  const { diffPercent: diffResized } = await pixelDiff(img400x300, img500x400);
  assert(diffResized < 0.1, `Resized same-color images: ${(diffResized * 100).toFixed(1)}% diff (expected <10%)`);

  // ── 6. generateHeatmap ────────────────────────────────────────────────────
  section('6. generateHeatmap');

  const heatmapOutPath = './data/screenshots/heatmap.png';
  const { diffPercent: heatDiff, heatmapBuffer } =
    await generateHeatmap(img400x300, img400x300_red, heatmapOutPath);

  assert(Buffer.isBuffer(heatmapBuffer), 'generateHeatmap returns heatmapBuffer');
  assert(fs.existsSync(heatmapOutPath), `Heatmap written to ${heatmapOutPath}`);
  assert(heatDiff > 0, `Heatmap diff > 0%: ${(heatDiff * 100).toFixed(1)}%`);

  const heatmapSize = await getImageSize(heatmapBuffer);
  assert(heatmapSize.width === 400, `Heatmap dimensions: ${heatmapSize.width}×${heatmapSize.height}`);

  // ── 7. computeVisualScores ────────────────────────────────────────────────
  section('7. computeVisualScores — Mock Pairs');

  // Create a 400×400 mock screenshot with colored regions
  // figma: white background
  // dom: mostly white but the "card image" region (220,10,160,120) is red → pixel diff there
  const figmaScreenshot = await createMockPng(400, 400, 255, 255, 255);
  const domScreenshot   = await createMockPngWithRegion(400, 400, 255, 255, 255, {
    x: 220, y: 10, w: 160, h: 120,
    r: 255, g: 0, b: 0,   // red region where "Card Image" is
  });

  const pairs = buildMockPairs();
  const scored = await computeVisualScores(pairs, figmaScreenshot, domScreenshot);

  assert(Array.isArray(scored), 'computeVisualScores returns array');
  assert(scored.length === pairs.length, `All ${pairs.length} pairs scored`);

  const buttonPair = scored.find(p => p.figmaNode.name === 'Hero Button');
  const imagePair  = scored.find(p => p.figmaNode.name === 'Card Image');

  assert(buttonPair?.visualScore != null, 'Hero Button has visualScore');
  assert(buttonPair?.visualScore > 0.90,
    `Hero Button (identical region) visualScore = ${buttonPair?.visualScore} (expected >0.90)`);

  assert(imagePair?.visualScore != null, 'Card Image has visualScore');
  assert(imagePair?.visualScore < 0.50,
    `Card Image (red vs white) visualScore = ${imagePair?.visualScore?.toFixed(3)} (expected <0.50)`);
  assert(imagePair?.pixelChangePct > 0.50,
    `Card Image pixelChangePct = ${imagePair?.pixelChangePct} (expected >0.50)`);

  // ── 8. fuseScores ─────────────────────────────────────────────────────────
  section('8. fuseScores — Three Blending Rules');

  // Rule 1: pixelChange < 3% → use semantic only
  const fused1 = fuseScores(0.90, 0.85, 0.02);
  assert(fused1 === 0.90, `Rule 1 (negligible change): fused=${fused1} (expected 0.90)`);

  // Rule 2: pixelChange > 30% AND semantic > 0.85
  const fused2 = fuseScores(0.92, 0.55, 0.40);
  const expected2 = +(0.92 * 0.60 + (1 - 0.40) * 0.40).toFixed(4);
  assert(Math.abs(fused2 - expected2) < 0.001,
    `Rule 2 (visual-semantic mismatch): fused=${fused2} (expected ${expected2})`);

  // Rule 3: standard blend
  const fused3 = fuseScores(0.80, 0.70, 0.15);
  const expected3 = +(0.80 * 0.65 + 0.70 * 0.35).toFixed(4);
  assert(Math.abs(fused3 - expected3) < 0.001,
    `Rule 3 (standard blend): fused=${fused3} (expected ${expected3})`);

  // Null visual → semantic only
  const fused4 = fuseScores(0.75, null, null);
  assert(fused4 === 0.75, `Null visual: fused=${fused4} (expected 0.75)`);

  // ── 9. Score Aggregator with visual data ──────────────────────────────────
  section('9. Score Aggregator — Visual Data Integration');

  // Load real diff data from the cake shop project
  let realDiffs = null;
  const diffsPath = path.join(__dirname, '..', 'data', 'diffs.json');  // relative to test location
  
  if (fs.existsSync(diffsPath)) {
    const raw = JSON.parse(fs.readFileSync(diffsPath, 'utf8'));
    realDiffs = raw.diffs ?? raw;
    console.log(`  ${YELLOW}ℹ${RESET}  Loaded ${realDiffs.length} real diffs from diffs.json`);
  } else {
    console.log(`  ${YELLOW}ℹ${RESET}  diffs.json not found — using synthetic diffs for aggregator test`);
    realDiffs = buildSyntheticDiffs();
  }

  try {
    const { aggregate } = require('./score/scoreAggregator');

    // Mock stats
    const mockStats = {
      figmaTotal: 34, domTotal: 47,
      matchedCount: 29, unmatchedFigmaCount: 3, unmatchedDomCount: 18,
    };

    // Test 1: aggregate without visual data (backward compat)
    const reportNoVisual = aggregate(realDiffs, mockStats, 1, null);
    assert(reportNoVisual.grade != null, `Semantic-only report grade: ${reportNoVisual.grade}`);
    assert(reportNoVisual.visualDrift?.available === false, 'visualDrift.available = false when no visual data');
    assert(reportNoVisual.scores.visualEnabled === false, 'visualEnabled = false');

    // Test 2: aggregate WITH visual data
    const mockVisualData = {};
    for (const d of realDiffs.slice(0, 5)) {
      mockVisualData[d.figmaId] = {
        visualScore:    0.80 + Math.random() * 0.15,
        pixelChangePct: 0.05 + Math.random() * 0.20,
      };
    }

    const reportWithVisual = aggregate(realDiffs, mockStats, 1, mockVisualData);
    assert(reportWithVisual.grade != null, `Visual-fused report grade: ${reportWithVisual.grade}`);
    assert(reportWithVisual.visualDrift?.available === true, 'visualDrift.available = true when visual data present');
    assert(reportWithVisual.scores.visualEnabled === true, 'visualEnabled = true');
    assert(reportWithVisual.diffsForAI[0].visualScore !== undefined, 'diffsForAI includes visualScore');

    console.log(`\n  ${YELLOW}Sample fused report:${RESET}`);
    console.log(`    Grade: ${reportWithVisual.grade} | Fidelity: ${(reportWithVisual.scores.pageFidelity * 100).toFixed(1)}%`);
    console.log(`    Visual drift nodes scored: ${reportWithVisual.visualDrift.summary?.nodesScored ?? 0}`);
    if (reportWithVisual.visualDrift.hiddenIssues?.length > 0) {
      console.log(`    Hidden issues detected: ${reportWithVisual.visualDrift.hiddenIssues.length}`);
    }

  } catch (err) {
    console.log(`  ${RED}✗${RESET}  Aggregator test failed: ${err.message}`);
    failed++;
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${passed}/${total} tests passed ✓${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failed}/${total} tests failed${RESET}  |  ${GREEN}${passed} passed${RESET}`);
  }

  // Cleanup
  if (fs.existsSync(heatmapOutPath)) fs.unlinkSync(heatmapOutPath);

  process.exit(failed > 0 ? 1 : 0);
}

// ─── Synthetic Diffs ──────────────────────────────────────────────────────────
// Used when real diffs.json is not available

function buildSyntheticDiffs() {
  return [
    {
      figmaId: 'fig-1', domId: 'dom-1',
      figmaName: 'Hero Button', domTag: 'button',
      matchedBy: 'iou', isComposite: true,
      scores: { overall: 0.47, geometry: 0.49, typography: 0.58, color: 0.15, spacing: 0.70 },
      issues: [
        { property: 'width',     figmaVal: 154, domVal: 212, delta: -58, severity: 'critical' },
        { property: 'textColor', figmaVal: '#000000', domVal: '#ffffff', delta: null, severity: 'critical' },
      ],
      issueCount: 2,
    },
    {
      figmaId: 'fig-2', domId: 'dom-2',
      figmaName: 'Hero Title', domTag: 'h1',
      matchedBy: 'iou', isComposite: false,
      scores: { overall: 0.82, geometry: 0.92, typography: 0.73, color: 0.88, spacing: null },
      issues: [
        { property: 'fontSize', figmaVal: '27px', domVal: '20px', delta: 7, severity: 'critical' },
      ],
      issueCount: 1,
    },
    {
      figmaId: 'fig-3', domId: 'dom-3',
      figmaName: 'Card Image', domTag: 'img',
      matchedBy: 'iou', isComposite: false,
      scores: { overall: 0.91, geometry: 0.95, typography: null, color: 0.80, spacing: null },
      issues: [],
      issueCount: 0,
    },
  ];
}

// ─── Run ──────────────────────────────────────────────────────────────────────

runTests().catch(err => {
  console.error('\nTest suite crashed:', err);
  process.exit(1);
});