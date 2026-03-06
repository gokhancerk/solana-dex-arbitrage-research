const url = 'https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=30000000&slippageBps=20&dexes=Whirlpool&onlyDirectRoutes=true';

const r1 = await fetch(url).then(r => r.json());
console.log('Response structure:', Object.keys(r1));
console.log('Test 1:', r1.outAmount || r1.quoteResponse?.outAmount || JSON.stringify(r1).slice(0,200));

await new Promise(r => setTimeout(r, 200));

const r2 = await fetch(url).then(r => r.json());
console.log('Test 2 (200ms):', r2.outAmount);

await new Promise(r => setTimeout(r, 1000));

const r3 = await fetch(url).then(r => r.json());
console.log('Test 3 (1200ms):', r3.outAmount);

console.log('Same 1-2?', r1.outAmount === r2.outAmount);
console.log('Same 2-3?', r2.outAmount === r3.outAmount);
