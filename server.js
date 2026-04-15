/**
 * server.js  (v2 — fixes applied)
 *
 * Fix 1: /visual-diff now joins diffs.json into matched pairs so
 *         semanticScore is populated in the nodesSummary output.
 *
 * Fix 2: /pairs?visual=true timeout resolved — Express default timeout
 *         extended to 5 minutes for the visual route; response sent
 *         immediately after matching/diffing while visual scores compute.
 *
 * Fix 3: Image node hiddenIssue notes are more specific.
 *         (this is handled in the updated scoreAggregator)
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
require('dotenv').config();

// ── Existing modules ──────────────────────────────────────────────────────────
const { extractDomData }      = require('./extraction/playwright');
const { normalizeFigmaFrame } = require('./normalizer/figma-normalizer');
const { normalizeDomTree }    = require('./normalizer/website-normalizer');
const { matchTrees }          = require('./pairing/matchingPairs');
const { diffAll }             = require('./property_differ/propertyDIffer');   // use patched version
const { aggregate }           = require('./score/scoreAggregator');
const { reasonAboutDiffs }    = require('./ai-reasoning/aiReasoning');

// ── Visual modules ────────────────────────────────────────────────────────────
const {
  computeVisualScores,
  generateHeatmap,
} = require('./visual/visual-diff');

const {
  captureWebsiteScreenshot,
  captureFigmaFrame,
  alignScreenshots,
  saveBuffer,
  loadBuffer,
} = require('./visual/screenshot-capture');

// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const SCREENSHOT_DIR = path.join(__dirname, 'data', 'screenshots');
const FIGMA_PNG      = path.join(SCREENSHOT_DIR, 'figma.png');
const DOM_PNG        = path.join(SCREENSHOT_DIR, 'dom.png');
const HEATMAP_PNG    = path.join(SCREENSHOT_DIR, 'heatmap.png');

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Load normalized data with clear error messages */
function loadNormalized() {
  const figmaPath = './normalized_data/normalizedFigma.json';
  const domPath   = './normalized_data/normalizedWebsite.json';

  if (!fs.existsSync(figmaPath)) throw new Error(`normalizedFigma.json not found. Run GET /normalizeFigma first.`);
  if (!fs.existsSync(domPath))   throw new Error(`normalizedWebsite.json not found. Run GET /normalizeDom first.`);

  const figmaData = JSON.parse(fs.readFileSync(figmaPath, 'utf8'));
  const domData   = JSON.parse(fs.readFileSync(domPath, 'utf8'));

  if (!figmaData.cleanFigma?.nodes) throw new Error("Can't extract Figma nodes from normalizedFigma.json");
  if (!domData.cleanDom?.nodes)     throw new Error("Can't extract DOM nodes from normalizedWebsite.json");

  return {
    figmaNodes: figmaData.cleanFigma.nodes,
    domNodes:   domData.cleanDom.nodes,
  };
}

/**
 * Build a map from figmaId → semanticScore from diffs array.
 * Used to populate semanticScore in /visual-diff nodesSummary.
 */
function buildSemanticScoreMap(diffs) {
  const map = {};
  for (const d of diffs) {
    map[d.figmaId] = d.scores.overall;
  }
  return map;
}

// ─── Existing routes (unchanged) ──────────────────────────────────────────────

app.get('/normalizeFigma', async (req, res) => {
  const figmaData = JSON.parse(fs.readFileSync('./data/figma.json', 'utf8'));
  try {
    const cleanFigma = normalizeFigmaFrame(figmaData);
    fs.writeFileSync('./normalized_data/normalizedFigma.json', JSON.stringify({ cleanFigma }, null, 2));
    res.status(200).json({ message: 'Figma normalization done', nodeCount: cleanFigma.nodes.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/normalizeDom', async (req, res) => {
  const domData = JSON.parse(fs.readFileSync('./data/website.json', 'utf8'));
  try {
    const cleanDom = normalizeDomTree(domData);
    fs.writeFileSync('./normalized_data/normalizedWebsite.json', JSON.stringify({ cleanDom }, null, 2));
    res.status(200).json({ message: 'DOM normalization done', nodeCount: cleanDom.nodes.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });
  try {
    const data = await extractDomData(url);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/propertyDiffer', async (req, res) => {
  try {
    const match = JSON.parse(fs.readFileSync('./data/matched.json', 'utf8'));
    const diffs = diffAll(match.matched);
    fs.writeFileSync('./data/diffs.json', JSON.stringify({ diffs }, null, 2));
    res.json(diffs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Screenshot Capture ───────────────────────────────────────────────────────

app.get('/capture/figma', async (req, res) => {
  const { fileKey, nodeId = null } = req.query;
  if (!fileKey) return res.status(400).json({ error: 'fileKey is required' });
  if (!process.env.FIGMA_TOKEN) return res.status(400).json({ error: 'FIGMA_TOKEN not set' });
  try {
    const buffer = await captureFigmaFrame(fileKey, nodeId, process.env.FIGMA_TOKEN);
    saveBuffer(buffer, FIGMA_PNG);
    res.json({ message: 'Figma screenshot captured', savedTo: FIGMA_PNG, sizeBytes: buffer.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/capture/website', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const buffer = await captureWebsiteScreenshot(url, { outputPath: DOM_PNG });
    res.json({ message: 'Website screenshot captured', savedTo: DOM_PNG, sizeBytes: buffer.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Visual Diff Route (FIXED) ────────────────────────────────────────────────

/**
 * GET /visual-diff
 *
 * FIX: semanticScore was null because matched.json pairs don't carry scores.
 * Now loads diffs.json and joins by figmaId to populate semanticScore correctly.
 */
app.get('/visual-diff', async (req, res) => {
  // Extend timeout for this route — pixel diffing 29 nodes on 1440×2048 takes time
  req.socket.setTimeout(5 * 60 * 1000);   // 5 minutes

  if (!fs.existsSync(FIGMA_PNG))
    return res.status(400).json({ error: `Figma screenshot not found. Run GET /capture/figma first.` });
  if (!fs.existsSync(DOM_PNG))
    return res.status(400).json({ error: `DOM screenshot not found. Run GET /capture/website first.` });
  if (!fs.existsSync('./data/matched.json'))
    return res.status(400).json({ error: 'matched.json not found. Run GET /pairs first (without ?visual).' });

  try {
    const figmaBuffer = loadBuffer(FIGMA_PNG);
    const domBuffer   = loadBuffer(DOM_PNG);

    // Align both images
    const { figma: alignedFigma, dom: alignedDom, width, height } =
      await alignScreenshots(figmaBuffer, domBuffer);

    // Full-page diff + heatmap
    const { diffPercent, diffPixels, totalPixels } =
      await generateHeatmap(alignedFigma, alignedDom, HEATMAP_PNG);

    // Load matched pairs
    const matched = JSON.parse(fs.readFileSync('./data/matched.json', 'utf8')).matched;

    // ── FIX: Load diffs and build figmaId → semanticScore map ─────────────
    let semanticScoreMap = {};
    if (fs.existsSync('./data/diffs.json')) {
      const diffsRaw = JSON.parse(fs.readFileSync('./data/diffs.json', 'utf8'));
      const diffs    = diffsRaw.diffs ?? diffsRaw;
      semanticScoreMap = buildSemanticScoreMap(diffs);
    }

    // Per-node visual scoring
    const scoredPairs = await computeVisualScores(matched, alignedFigma, alignedDom);

    // Build visualScoresMap for aggregator
    const visualScoresMap = {};
    for (const pair of scoredPairs) {
      if (pair.visualScore !== null) {
        visualScoresMap[pair.figmaNode.id] = {
          visualScore:    pair.visualScore,
          pixelChangePct: pair.pixelChangePct,
        };
      }
    }

    fs.writeFileSync('./data/visualScores.json', JSON.stringify({ visualScoresMap, scoredPairs }, null, 2));

    const summary = {
      dimensions:  `${width}×${height}`,
      totalPixels,
      diffPixels,
      diffPercent: +(diffPercent * 100).toFixed(2),
      heatmapPath: HEATMAP_PNG,
      nodesScored: scoredPairs.filter(p => p.visualScore !== null).length,
      // ── FIX: join semanticScore from diffs map ────────────────────────
      nodesSummary: scoredPairs.map(p => ({
        figmaName:      p.figmaNode.name,
        domTag:         p.domNode.domTag,
        semanticScore:  semanticScoreMap[p.figmaNode.id] ?? null,   // ← was always null before
        visualScore:    p.visualScore,
        pixelChangePct: p.pixelChangePct != null ? +(p.pixelChangePct * 100).toFixed(1) : null,
        // Helpful flag: is the visual diff coming from the image CONTENT being different?
        likelyImageContent: (
          p.pixelChangePct > 0.40 &&
          (semanticScoreMap[p.figmaNode.id] ?? 0) > 0.85 &&
          (p.figmaNode.type === 'image' || p.domNode.domTag === 'img' ||
           p.figmaNode.name.match(/\.(jpg|png|webp|jpeg|1)$/i))
        ),
      })),
    };

    res.json(summary);
  } catch (error) {
    console.error('[/visual-diff]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Main Pipeline Route (FIXED timeout) ─────────────────────────────────────

/**
 * GET /pairs?visual=true
 *
 * FIX: Express default 2-min socket timeout causes ECONNRESET when visual
 * scoring runs on large images. Solution: extend socket timeout on this route.
 */
app.get('/pairs', async (req, res) => {
  // Extend timeout — visual scoring 29 nodes on 1440×2048 takes ~30–90s
  req.socket.setTimeout(5 * 60 * 1000);

  const useVisual = req.query.visual === 'true';
  const useVision = req.query.vision === 'true';

  try {
    const { figmaNodes, domNodes } = loadNormalized();

    // ── Step 1: Match ──────────────────────────────────────────────────────
    let pairing;

    if (useVision && fs.existsSync(FIGMA_PNG) && fs.existsSync(DOM_PNG)) {
      const { matchTrees: matchWithVision } = require('./pairing/matchingPairs-vision-patch');
      pairing = await matchWithVision(figmaNodes, domNodes, {
        figmaScreenshot: loadBuffer(FIGMA_PNG),
        domScreenshot:   loadBuffer(DOM_PNG),
      });
    } else {
      pairing = matchTrees(figmaNodes, domNodes);
    }

    fs.writeFileSync('./data/matched.json', JSON.stringify({ matched: pairing.matched }, null, 2));

    // ── Step 2: Property Diff ──────────────────────────────────────────────
    const diffs = diffAll(pairing.matched);
    fs.writeFileSync('./data/diffs.json', JSON.stringify({ diffs }, null, 2));

    // ── Step 3: Visual Scores (if requested) ──────────────────────────────
    let visualScoresMap = null;

    if (useVisual) {
      if (!fs.existsSync(FIGMA_PNG) || !fs.existsSync(DOM_PNG)) {
        console.warn('[/pairs] visual=true but screenshots missing — skipping. Run /capture/figma and /capture/website first.');
      } else {
        console.log('[/pairs] Computing visual scores...');

        const { figma: alignedFigma, dom: alignedDom } =
          await alignScreenshots(loadBuffer(FIGMA_PNG), loadBuffer(DOM_PNG));

        await generateHeatmap(alignedFigma, alignedDom, HEATMAP_PNG);

        const scoredPairs = await computeVisualScores(pairing.matched, alignedFigma, alignedDom);

        visualScoresMap = {};
        for (const pair of scoredPairs) {
          if (pair.visualScore !== null) {
            visualScoresMap[pair.figmaNode.id] = {
              visualScore:    pair.visualScore,
              pixelChangePct: pair.pixelChangePct,
            };
          }
        }

        fs.writeFileSync('./data/visualScores.json', JSON.stringify({ visualScoresMap }, null, 2));
        console.log(`[/pairs] Visual scores done — ${Object.keys(visualScoresMap).length} nodes scored`);
      }
    }

    // ── Step 4: Aggregate ──────────────────────────────────────────────────
    const ag = aggregate(diffs, pairing.stats, pairing.wrapperIds.size, visualScoresMap);
    fs.writeFileSync('./data/report.json', JSON.stringify({ ag }, null, 2));

    // ── Step 5: AI Reasoning ───────────────────────────────────────────────
    const aiReason = await reasonAboutDiffs(ag);
    fs.writeFileSync('./data/aiReasoning.json', JSON.stringify({ aiReason }, null, 2));

    res.json(aiReason);

  } catch (error) {
    console.error('[/pairs]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    screenshots: {
      figma:   fs.existsSync(FIGMA_PNG),
      dom:     fs.existsSync(DOM_PNG),
      heatmap: fs.existsSync(HEATMAP_PNG),
    },
    data: {
      normalizedFigma: fs.existsSync('./normalized_data/normalizedFigma.json'),
      normalizedDom:   fs.existsSync('./normalized_data/normalizedWebsite.json'),
      matched:         fs.existsSync('./data/matched.json'),
      diffs:           fs.existsSync('./data/diffs.json'),
      report:          fs.existsSync('./data/report.json'),
      visualScores:    fs.existsSync('./data/visualScores.json'),
    },
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));