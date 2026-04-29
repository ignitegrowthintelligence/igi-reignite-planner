const fs = require('fs');
const c = fs.readFileSync('C:\\Users\\justi\\.openclaw\\workspace\\igi-reignite-planner\\index.html', 'utf8');

// Debug failing checks
console.log('--- parseClose score placeholder ---');
console.log('Has score: 0 (any):', c.includes('score: 0'));
// Find the deals.push block
const dealsPushIdx = c.indexOf('deals.push({');
if (dealsPushIdx !== -1) {
  console.log('deals.push content:', JSON.stringify(c.slice(dealsPushIdx, dealsPushIdx + 200)));
}

console.log('\n--- parseIgniteReport check ---');
console.log('reclaimAll.forEach count:', (c.match(/reclaimAll\.forEach/g)||[]).length);
// Find where it occurs
let idx = 0;
while ((idx = c.indexOf('reclaimAll.forEach', idx)) !== -1) {
  console.log('Found at idx', idx, ':', JSON.stringify(c.slice(Math.max(0,idx-50), idx+80)));
  idx++;
}

console.log('\n--- parseIgniteReport end ---');
const pIgnIdx = c.indexOf('function parseIgniteReport');
if (pIgnIdx !== -1) {
  // Find the closing brace of this function
  const segment = c.slice(pIgnIdx, pIgnIdx + 3000);
  console.log('parseIgniteReport last 500 chars:', JSON.stringify(segment.slice(-500)));
}
