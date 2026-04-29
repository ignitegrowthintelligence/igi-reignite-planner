const fs = require('fs');
let content = fs.readFileSync('C:\\Users\\justi\\.openclaw\\workspace\\igi-reignite-planner\\index.html', 'utf8');

// Check if the scoring block exists
const checkLine = 'var sc=c._scoreComponents||{};';
if (!content.includes(checkLine)) {
  console.log('Block already removed or not found');
  process.exit(0);
}

// Find and remove the inline scoring block in renderProtect map function
// Match from "var act=" line through "c.score=liveScore;" line
// File uses CRLF, try both
const startMarker = '      var act=c.score>=7?';
const endMarkers = ['      c.score=liveScore;\r\n', '      c.score=liveScore;\n'];

const startIdx = content.indexOf(startMarker);
let endIdx = -1;
let endMarker = '';
for (const em of endMarkers) {
  const idx = content.indexOf(em, startIdx);
  if (idx !== -1) { endIdx = idx; endMarker = em; break; }
}

if (startIdx === -1 || endIdx === -1) {
  console.log('Could not find markers. startIdx=' + startIdx + ' endIdx=' + endIdx);
  // Debug: show what's around startMarker
  if (startIdx !== -1) {
    console.log('Content around start (200 chars):', JSON.stringify(content.slice(startIdx, startIdx + 200)));
  }
  process.exit(1);
}

const blockToRemove = content.slice(startIdx, endIdx + endMarker.length);
console.log('Block found, length:', blockToRemove.length);
console.log('Last 100 chars of block:', JSON.stringify(blockToRemove.slice(-100)));

content = content.slice(0, startIdx) + content.slice(startIdx + blockToRemove.length);
console.log('Block removed');

// Fix score badge: scoreBadge(liveScore,_sd) -> scoreBadge(c.score,c._scoreData)
if (content.includes('scoreBadge(liveScore,_sd)')) {
  content = content.replace('scoreBadge(liveScore,_sd)', 'scoreBadge(c.score,c._scoreData)');
  console.log('Fixed scoreBadge call');
} else {
  console.log('scoreBadge(liveScore,_sd) not found!');
}

// Remove action column from row - find the act cell in the table row
// The row ends with: +"<td class=\"text-right hide-mobile\">"+ti+"</td><td class=\"hide-mobile\">"+act+"</td></tr>";
const actSearch = '"</td><td class=\\"hide-mobile\\">"+act+"</td></tr>";';
const actIdx = content.indexOf(actSearch);
if (actIdx !== -1) {
  content = content.slice(0, actIdx) + '"</td></tr>";' + content.slice(actIdx + actSearch.length);
  console.log('Removed act column from row (method 1)');
} else {
  // Try without escaped quotes
  const actSearch2 = '+"</td><td class=';
  const nearTi = content.indexOf('"+ti+"</td>');
  if (nearTi !== -1) {
    const lineStart = content.lastIndexOf('\n', nearTi);
    const lineEnd = content.indexOf('\n', nearTi);
    const line = content.slice(lineStart, lineEnd);
    console.log('Line with ti:', JSON.stringify(line));
  }
}

fs.writeFileSync('C:\\Users\\justi\\.openclaw\\workspace\\igi-reignite-planner\\index.html', content, 'utf8');
console.log('Done');
