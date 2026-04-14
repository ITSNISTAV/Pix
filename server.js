const express = require('express');
const fs = require('fs');
require('dotenv').config();
const { extractDomData } = require("./extraction/playwright");
const { normalizeFigmaFrame } = require("./normalizer/figma-normalizer");
const { normalizeDomTree } = require("./normalizer/website-normalizer");
const { matchTrees, computeIoU, computeMatchScore } = require("./pairing/matchingPairs");
const { diffAll, diffPair } = require("./property_differ/propertyDIffer");
const { aggregate} = require("./score/scoreAggregator");
const { reasonAboutDiffs }= require("./ai-reasoning/aiReasoning");
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
        // await fs.writeFileSync('./data/matched.json', JSON.stringify({matched}, null, 2));
        // await fs.writeFileSync('./data/unmatchedfigma.json', JSON.stringify({unmatchedfigma}, null, 2));
        // await fs.writeFileSync('./data/unmatchedDom.json', JSON.stringify({unmatchedDom}, null, 2));
        
        const diffs= diffAll(matched);
        const ag= aggregate(diffs,pairing.stats,pairing.wrapperIds.size);

        // await fs.writeFileSync('./data/report.json',JSON.stringify({ag},null,2))
        const aiReason= await reasonAboutDiffs(ag);
        await fs.writeFileSync('./data/aiReasoning.json',JSON.stringify({aiReason}, null, 2));
        // console.log(pairing.stats)
        res.json(aiReason);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }

})

app.get("/propertyDiffer",async(req,res)=>{
    try{
        const match=await JSON.parse(fs.readFileSync('./data/matched.json', 'utf8'));
        const diffs = diffAll(match.matched);
        if(!diffs){
            console.log("matched.matched not found");
        }
        await fs.writeFileSync('./data/diffs.json', JSON.stringify({diffs}, null, 2));
        res.json(diffs);
    }catch(error){
        res.status(500).json({error:error.message});
    }

})



app.listen(4000, () => console.log("Server running on http://localhost:4000"));