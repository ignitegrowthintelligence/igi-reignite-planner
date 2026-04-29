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
const SYSTEM_PROMPT = `You are a meeting coach for a local digital advertising sales team. Your job is NOT to audit a business — it is to help a sales rep walk in or call and book a 20-minute meeting.

Given website HTML and pixel detection results, answer four questions:
1. Why is this business worth calling?
2. What is the single best angle for the meeting conversation?
3. What should the rep say in the first 20 seconds?
4. How should they ask for the meeting?

Write everything in plain spoken English. Never mention pixels, GTM, tracking tags, remarketing, conversion tracking, or any ad tech in any customer-facing script. Sound like you understand the business, not like you audited their website.

Return ONLY a valid JSON object. No markdown fences, no explanation, no extra text.

{
  "businessName": "string",
  "industry": "string - specific business type",

  "meetingStrengthScore": 8,
  "meetingStrengthReasons": [
    "Short phrase reason 1 — specific to this business",
    "Short phrase reason 2",
    "Short phrase reason 3",
    "Short phrase reason 4",
    "Short phrase reason 5"
  ],

  "whyWorthCalling": [
    { "label": "3-5 word label", "detail": "One sentence specific to this business and why it makes them a strong advertising prospect." },
    { "label": "3-5 word label", "detail": "One sentence." },
    { "label": "3-5 word label", "detail": "One sentence." }
  ],

  "bestMeetingAngle": "One sentence. The single clearest reason a digital advertising conversation makes sense for this business right now. Focus on a business outcome they care about — not ad products.",

  "meetingHook": "2-3 sentences. Primary reason to call or stop in. Reference something specific — their reputation, services, seasonal timing, or a visible opportunity. Do NOT mention pixels, tracking, or ad tech.",

  "whatToSay": {
    "phone": "A natural 25-35 second phone script. Start with your name and Townsquare Ignite. Reference something specific about their business that shows you did research. End with a clear ask for 20 minutes. Write it how a real person talks.",
    "walkin": "A natural 15-20 second walk-in script. Shorter, more casual. Mention you were doing local research and they stood out. Ask for whoever handles marketing or the owner."
  },

  "conversationStarters": [
    "Natural question 1 — opens genuine curiosity about their business, not a technical audit",
    "Natural question 2 — about their growth focus or what is working",
    "Natural question 3 — about seasonality or timing relevant to their business",
    "Natural question 4 — about where new customers come from"
  ],

  "meetingAsk": {
    "soft": "Low-pressure ask. Position it as sharing a few ideas or comparing notes. One or two sentences.",
    "strong": "More direct ask. Reference a specific opportunity. Give two day options. Two sentences."
  },

  "coachingNote": "Only populate this field if meetingStrengthScore is 6 or below. 2-3 sentences of direct coaching for the sales rep: explain specifically WHY this one is harder (competitive category, established business, thin digital gaps, low transaction value, etc.), what they should do differently on this call vs. a high-score prospect, and what a realistic win looks like here. Leave this field null if score is 7 or above.",

  "marketSummary": {
    "headline": "2-3 sentence plain-English summary of the business's website messaging and current marketing focus. What is the site trying to do? What's the main offer or value prop? What tone and audience does it speak to?",
    "activeCTAs": ["CTA text as it appears on the site", "CTA text 2", "CTA text 3"],
    "gaps": ["One specific gap or missed opportunity visible from the site", "Gap 2"]
  },

  "contact": {
    "phone": "string or null",
    "email": "string or null",
    "address": "string or null"
  },

  "supportingIntel": {
    "targetAudience": {
      "demographics": "age range, income, customer profile",
      "type": "B2B or B2C or Both",
      "reach": "geographic service area"
    },
    "customerValue": {
      "estimatedLTV": "lifetime value range",
      "industryExamples": ["example 1", "example 2"]
    },
    "adBenchmarks": {
      "metaCPL": "typical Meta cost per lead for this industry",
      "googleCPC": "typical Google Ads CPC for this industry",
      "googleCPA": "typical Google Ads CPA for this industry"
    },
    "advertisingWindows": {
      "seasonal": ["opportunity 1", "opportunity 2", "opportunity 3", "opportunity 4"]
    }
  }
}

Scoring guide for meetingStrengthScore (1-10):
9-10: Clear local brand, high-LTV category, obvious digital opportunity, easy conversation angle
7-8: Good prospect with a clear angle but less urgency
5-6: Decent prospect, harder conversation or less obvious gap
3-4: Weak prospect — low LTV, saturated, or hard to pitch digital
1-2: Poor meeting candidate

Critical rules:
- NEVER use the words pixels, GTM, tracking tags, remarketing, or conversion tracking in whatToSay, meetingHook, or bestMeetingAngle
- whatToSay scripts must feel specific to THIS business — reference their actual services, location, reviews, or promotions from the site
- conversationStarters must open natural business conversations, not interrogations
- If website could not be fetched, infer everything from domain name and industry — still generate all fields
- marketSummary.headline must be specific to THIS business — never generic. Reference actual content from the site.
- marketSummary.activeCTAs should reflect real button/link text found on the site (e.g. "Shop Mattresses", "Schedule a Consultation", "Get a Free Quote"). Max 6. If site can't be fetched, return empty array.
- marketSummary.gaps should be concrete, seller-relevant observations (e.g. "No email capture or lead form detected", "No promotional pricing or seasonal offers visible", "No customer reviews or social proof on homepage"). Max 3. Never mention pixels, GTM, or tracking tech.`;

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------
async function callClaude(html, domain, pixels, apiKey, businessName) {
  const userContent =
    'Business name: ' + (businessName || '(extract from website)') + '\n' +
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
      max_tokens: 4096,
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
  const { domain, profileKey, businessName } = req.body || {};

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

    const intel = await callClaude(html, domain, pixels, apiKey, businessName);

    // Attach computed fields
    intel.digitalReadiness = Object.assign({}, pixels, dr);
    intel.domain           = domain;
    intel.generatedAt      = new Date().toISOString();

    // Build human-readable adPixels list from detected tracking tags
    var detectedPixels = [];
    if (pixels.gtm)             detectedPixels.push('Google Tag Manager' + (pixels.gtmId ? ' (' + pixels.gtmId + ')' : ''));
    if (pixels.googleAnalytics) detectedPixels.push('Google Analytics'   + (pixels.gaId  ? ' (' + pixels.gaId  + ')' : ''));
    if (pixels.googleAds)       detectedPixels.push('Google Ads'         + (pixels.adsId ? ' (' + pixels.adsId + ')' : ''));
    if (pixels.remarketing)     detectedPixels.push('Remarketing tag');
    if (!intel.supportingIntel) intel.supportingIntel = {};
    intel.supportingIntel.adPixels = { detected: detectedPixels };

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
