'use strict';

const express = require('express');
const admin   = require('firebase-admin');

admin.initializeApp();
const db  = admin.firestore();
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS – allow all origins (GitHub Pages calls this from the browser)
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

// ---------------------------------------------------------------------------
// Website fetcher  (parallel – caps total wait at ~8 s instead of 36 s)
// ---------------------------------------------------------------------------
async function fetchWebsite(domain) {
  const candidates = [
    'https://'     + domain,
    'https://www.' + domain,
  ];

  const attempts = candidates.map(async (url) => {
    const res = await fetch(url, {
      headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; IGI-Intel/1.0)' },
      signal:   AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return text.slice(0, 50000);
  });

  // Return the first successful response; ignore individual failures
  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    if (r.status === 'fulfilled') return r.value;
  }
  console.log('[IGI] fetchWebsite: both candidates failed for', domain);
  return null;
}

// ---------------------------------------------------------------------------
// Pixel detection
// ---------------------------------------------------------------------------
function detectPixels(html) {
  if (!html) {
    return {
      gtm: false, gtmId: null,
      googleAnalytics: false, gaId: null,
      googleAds: false, adsId: null,
      remarketing: false,
      sitemap: false,
    };
  }

  const gtmMatch  = html.match(/GTM-([A-Z0-9]+)/);
  const gaMatch   = html.match(/['"]G-([A-Z0-9]+)['"]/);
  const adsMatch  = html.match(/AW-(\d+)/);

  return {
    gtm:             !!gtmMatch,
    gtmId:           gtmMatch  ? gtmMatch[0]               : null,
    googleAnalytics: !!gaMatch || /UA-\d+-\d+/.test(html),
    gaId:            gaMatch   ? gaMatch[0].replace(/['"]/g, '') : null,
    googleAds:       !!adsMatch,
    adsId:           adsMatch  ? adsMatch[0]               : null,
    remarketing:     /remarketing_only|google_remarketing_only|REMARKETING_DETECTED/.test(html),
    sitemap:         /sitemap\.xml/i.test(html),
  };
}

function calcDigitalReadiness(pixels) {
  let score = 0;
  if (pixels.gtm)             score += 3;
  if (pixels.googleAnalytics) score += 2;
  if (pixels.googleAds)       score += 3;
  if (pixels.remarketing)     score += 2;

  let label;
  if      (score === 0) label = 'No digital tracking detected';
  else if (score <= 2)  label = 'Minimal tracking only';
  else if (score <= 5)  label = 'Basic analytics setup';
  else if (score <= 7)  label = 'Active tracking - possible paid search';
  else if (score <= 9)  label = 'Advanced tracking stack';
  else                  label = 'Full digital marketing stack';

  return { score, label };
}

// ---------------------------------------------------------------------------
// Claude system prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a pre-call sales intelligence analyst for a digital advertising sales team. Given website HTML and pixel detection results, extract and infer information to help a sales rep prepare for an outreach call to pitch digital advertising.

Return ONLY a valid JSON object. No markdown fences, no explanation, no extra text - just the raw JSON.

Use this exact schema:

{
  "businessName": "string",
  "industry": "string - specific industry or business category",
  "contact": {
    "phone": "string or null",
    "email": "string or null",
    "address": "string or null"
  },
  "marketingObjective": {
    "overview": "2-3 sentences: what they do, who they serve, how they position",
    "primaryCTAs": ["main calls to action found on the site"],
    "inferredGoal": "1 sentence - the marketing outcome they are trying to achieve"
  },
  "messagingIdeas": {
    "keyThemes": ["4-6 core themes from their website messaging"],
    "tone": "brief description of brand tone",
    "competitorComparisons": ["ways they differentiate or could differentiate from competitors"]
  },
  "advertisingWindows": {
    "seasonal": ["seasonal or timing opportunities specific to this industry"],
    "campaignStrategy": ["3-4 recommended campaign types for this business"]
  },
  "targetAudience": {
    "demographics": "age range, income level, customer profile",
    "psychographics": "values, concerns, motivations of their ideal customer",
    "behavioral": "how they search and make purchase decisions",
    "type": "B2B or B2C or Both",
    "reach": "geographic service area based on site content"
  },
  "customerValue": {
    "estimatedLTV": "lifetime value range for a typical customer in this industry",
    "industryExamples": ["3-4 specific revenue or deal size examples for this industry"]
  },
  "adBenchmarks": {
    "metaCPL": "typical Meta cost per lead range for this industry",
    "googleCPC": "typical Google Ads cost per click range for this industry",
    "googleCPA": "typical Google Ads cost per acquisition range for this industry"
  },
  "bullets": [
    "bullet 1",
    "bullet 2",
    "bullet 3",
    "bullet 4",
    "bullet 5"
  ]
}

For the bullets array, write exactly 5 talking points a sales rep can use when calling to pitch digital advertising. Cover these five angles in order:
1. Who they are and what they do - brief, specific, shows you did your homework
2. Their current digital advertising posture - what tracking or ads are or are not present
3. The biggest opportunity or gap in their marketing based on what you see on the site
4. A timing or seasonal hook relevant to their industry right now
5. A ROI anchor - reference their estimated customer lifetime value or a relevant ad benchmark

Write bullets in plain conversational English. No jargon. No bullet symbols or dashes. Each bullet is 1-2 sentences. Reference specifics from the site where possible.

If a field cannot be determined from the content, use null for that field.`;

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------
async function callClaude(html, domain, pixels, apiKey) {
  const userContent =
    'Domain: ' + domain + '\n\n' +
    'Pixel detection results:\n' +
    '- Google Tag Manager: '  + (pixels.gtm             ? 'YES (' + pixels.gtmId + ')' : 'NOT DETECTED') + '\n' +
    '- Google Analytics: '    + (pixels.googleAnalytics  ? 'YES (' + (pixels.gaId || 'UA format') + ')' : 'NOT DETECTED') + '\n' +
    '- Google Ads pixel: '    + (pixels.googleAds        ? 'YES (' + pixels.adsId + ')' : 'NOT DETECTED') + '\n' +
    '- Remarketing: '         + (pixels.remarketing      ? 'YES' : 'NOT DETECTED') + '\n\n' +
    'Website HTML (truncated to 30,000 characters):\n' +
    (html ? html.slice(0, 30000) : 'Website could not be fetched. Generate intel based on the domain name and industry inference only.');

  console.log('[IGI] Calling Claude API for domain:', domain);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('[IGI] Claude API HTTP error', response.status, body.slice(0, 300));
    throw new Error('Claude API error ' + response.status + ': ' + body.slice(0, 200));
  }

  const data = await response.json();
  const text = data.content[0].text;

  // Strip any accidental markdown fences before parsing
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude response did not contain valid JSON');

  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// POST /  –  main handler
// ---------------------------------------------------------------------------
app.post('/', async (req, res) => {
  const { domain, profileKey } = req.body || {};

  if (!domain || !profileKey) {
    return res.status(400).json({ error: 'domain and profileKey are required' });
  }

  const safeKey = profileKey.replace(/[^a-z0-9\-_]/gi, '-').slice(0, 80);

  try {
    // Check Firestore cache first
    const cached = await db.collection('prospectIntel').doc(safeKey).get();
    if (cached.exists) {
      console.log('[IGI] Cache hit:', safeKey);
      return res.json({ success: true, data: cached.data(), cached: true });
    }

    console.log('[IGI] Generating intel for:', domain);

    // Fetch website + detect pixels
    const html   = await fetchWebsite(domain);
    const pixels = detectPixels(html);
    const dr     = calcDigitalReadiness(pixels);

    // Call Claude
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret not configured');
    console.log('[IGI] API key present, length:', apiKey.length, '| prefix:', apiKey.slice(0, 10));

    const intel = await callClaude(html, domain, pixels, apiKey);

    // Attach computed fields
    intel.digitalReadiness = Object.assign({}, pixels, dr);
    intel.domain           = domain;
    intel.generatedAt      = new Date().toISOString();

    // Save to Firestore
    await db.collection('prospectIntel').doc(safeKey).set(intel);
    console.log('[IGI] Intel saved:', safeKey);

    return res.json({ success: true, data: intel, cached: false });

  } catch (err) {
    console.error('[IGI] Error for', domain, '-', err.message);
    return res.status(500).json({ error: err.message || 'Intel generation failed' });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'IGI Intel Engine running' }));

// ---------------------------------------------------------------------------
// Start server (Cloud Run injects PORT)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`IGI Intel Engine listening on port ${PORT}`);
});
