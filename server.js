const express = require('express');
const fs = require('fs');
const { extractDomData } = require("./extraction/playwright");
const { normalizeFigmaFrame } = require("./normalizer/figma-normalizer");
const { normalizeDomTree } = require("./normalizer/website-normalizer");
const { matchTrees, computeIoU, computeMatchScore } = require("./pairing/matchingPairs");
const { match } = require('assert');
const app = express();

app.get('/normalizeFigma', async (req, res) => {

    const figmaData = JSON.parse(fs.readFileSync('./data/figma.json', 'utf8'))
    try {
        const cleanFigma = await normalizeFigmaFrame(figmaData);
        // const cleanDom=await normalizeDomTree(domData);
       await fs.writeFileSync('./normalized_data/normalizedFigma.json', JSON.stringify({ cleanFigma }, null, 2));
        // await fs.writeFileSync('./normalized_data/normalizedWebsite.json', JSON.stringify({ cleanDom}, null, 2));
        res.status(200).json({ "message": "process went smooD" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
})
app.get('/normalizeDom', async (req, res) => {

    // const figmaData=JSON.parse(fs.readFileSync('./data/figma.json', 'utf8'))
    const domData = JSON.parse(fs.readFileSync('./data/website.json', 'utf8'))

    try {
        // const cleanFigma=await normalizeFigmaFrame(figmaData);
        const cleanDom = await normalizeDomTree(domData);
        // await fs.writeFileSync('./normalized_data/normalizedFigma.json', JSON.stringify({ cleanFigma}, null, 2));
        await fs.writeFileSync('./normalized_data/normalizedWebsite.json', JSON.stringify({ cleanDom }, null, 2));
        res.status(200).json({ "message": "process went smooD" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
})

app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    try {
        const data = await extractDomData(url);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/pairs", async (req, res) => {

    const normalizedFigma = await JSON.parse(fs.readFileSync('./normalized_data/normalizedFigma.json', 'utf8'));
    if (!normalizedFigma.cleanFigma.nodes) {
        // console.log("can't extract figma nodes")
        res.status(400).json({ "message": "can't extract figma nodes" });
    }
    const normalizedDom = await JSON.parse(fs.readFileSync('./normalized_data/normalizedWebsite.json', 'utf8'));
    if (!normalizedDom.cleanDom.nodes) {
        return res.status(400).json({ "message": "can't extract dom nodes" });
    }

    try {

        const pairing = await matchTrees(normalizedFigma.cleanFigma.nodes, normalizedDom.cleanDom.nodes);
        const matched=pairing.matched;
        const unmatchedfigma=pairing.unmatchedFigma;
        const unmatchedDom=pairing.unmatchedDom
        await fs.writeFileSync('./data/matched.json', JSON.stringify({matched}, null, 2));
        await fs.writeFileSync('./data/unmatchedfigma.json', JSON.stringify({unmatchedfigma}, null, 2));
        await fs.writeFileSync('./data/unmatchedDom.json', JSON.stringify({unmatchedDom}, null, 2));
        // Add this temporarily after matchTrees() in your code
        // console.log('\n--- Unmatched Figma nodes ---');
        // pairing.unmatchedFigma.forEach(n => {
        //     console.log(`  [${n.type}] "${n.name}" x:${n.x} y:${n.y} w:${n.w} h:${n.h}`);
        // });

        // console.log('\n--- Unmatched DOM nodes ---');
        // pairing.unmatchedDom.forEach(n => {
        //     console.log(`  [${n.type}] <${n.domTag}> x:${n.x} y:${n.y} w:${n.w} h:${n.h} "${n.text}"`);
        // });
        console.log(pairing.stats)
        res.json(pairing);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }

})

app.listen(4000, () => console.log("Server running on http://localhost:4000"));