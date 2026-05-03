'use strict';

const express = require('express');

// Firestore cache is optional — if Firebase Admin can't initialize (e.g. project
// doesn't have Firestore enabled), the service runs fine without caching.
let db = null;
try {
  const admin = require('firebase-admin');
  admin.initializeApp();
  db = admin.firestore();
  console.log('[IGI] Firestore cache enabled');
} catch (e) {
  console.warn('[IGI] Firestore unavailable — running without cache:', e.message);
}

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Content library — loaded at startup
// ---------------------------------------------------------------------------
const contentVBR        = require('./content/vbr.json');
const contentObjections = require('./content/objections.json');
const contentScripts    = require('./content/call_scripts.json');
const contentStories    = require('./content/success_stories.json');
const contentProducts   = require('./content/products.json');
const contentDiscovery  = require('./content/discovery_questions.json');

// Flatten all products across every category into one lookup map by id
function buildProductMap() {
  const map = {};
  const sections = [
    contentProducts.search_products,
    contentProducts.ai_programmatic_products,
    contentProducts.social_media_products,
    contentProducts.streaming_tv_products,
    contentProducts.location_based_products,
    contentProducts.other_channels,
  ];
  for (const arr of sections) {
    if (Array.isArray(arr)) arr.forEach(p => { map[p.id] = p; });
  }
  // AMPED products stored under .amped_local_brands.products
  if (contentProducts.amped_local_brands && contentProducts.amped_local_brands.products) {
    contentProducts.amped_local_brands.products.forEach(p => { map[p.id] = p; });
  }
  return map;
}
const PRODUCT_MAP = buildProductMap();

// Map an industry string to a quick-reference category key
function inferCategory(industry) {
  if (!industry) return null;
  const lower = industry.toLowerCase();
  if (/hvac|heat|cool|plumb|electr|restor|handyman|home service|contractor|cleaning|maid/.test(lower)) return 'home_services';
  if (/beauty|salon|spa|nail|hair|estheti/.test(lower)) return 'beauty_salon';
  if (/auto|car|vehicle|truck|repair|mechanic|collision/.test(lower)) return 'automotive';
  if (/food|coffee|restaurant|cafe|bar|bakery|catering|beverage/.test(lower)) return 'food_beverage';
  if (/dry clean|laundry|retail|shop|store|boutique/.test(lower)) return 'retail_consumer';
  return null;
}

// Return the best-fit success story for an industry
function pickSuccessStory(industry) {
  const cat = inferCategory(industry);
  const ids  = cat ? contentStories.quick_reference_by_category[cat] : null;
  if (ids && ids.length) {
    const story = contentStories.case_studies.find(s => s.id === ids[0]);
    if (story) return story;
  }
  return contentStories.case_studies.find(s => s.id === 'tide_cleaners');
}

// Return 2 best-fit products for an industry using the full product map
function pickProducts(industry) {
  const lower = (industry || '').toLowerCase();
  let ids;
  // Check auto before HVAC — "auto repair" should not match the HVAC rule
  if (/auto|automotive|car |vehicle|mechanic|collision|dealership/.test(lower)) {
    ids = ['sem', 'facebook_social'];
  } else if (/hvac|heat|cool|plumb|electr|restor|handyman|home service|contractor|emergency/.test(lower)) {
    ids = ['sem', 'seo'];
  } else if (/beauty|salon|nail|restaurant|food|retail|fitness|spa/.test(lower)) {
    ids = ['facebook_social', 'sem'];
  } else if (/b2b|staffing|recrui|consulting|accounting|insur|financial/.test(lower)) {
    ids = ['linkedin', 'sem'];
  } else if (/legal|attorney|medical|doctor|dental/.test(lower)) {
    ids = ['sem', 'seo'];
  } else {
    ids = ['sem', 'facebook_social'];
  }
  return ids.map(id => PRODUCT_MAP[id]).filter(Boolean);
}

// Pick the best AMPED product for an industry
function pickAmpedProduct(industry) {
  const lower = (industry || '').toLowerCase();
  // High foot-traffic / promo businesses → First Impression or SSM
  if (/restaurant|food|retail|salon|nail|beauty|fitness|spa|gym/.test(lower)) {
    return PRODUCT_MAP['sponsored_social_mentions'];
  }
  // B2B / professional → Listen Live (at-work audience)
  if (/b2b|staffing|consulting|financial|insur|legal|attorney/.test(lower)) {
    return PRODUCT_MAP['listen_live'];
  }
  // Home services / seasonal → First Impression Takeover
  if (/hvac|plumb|restor|contractor|home service|cleaning|landscap/.test(lower)) {
    return PRODUCT_MAP['first_impression_takeover'];
  }
  // Default: Local Display Network (broadly useful)
  return PRODUCT_MAP['local_network'];
}

// Pick the best Ignite program for an industry/goal
function pickProgram(industry) {
  const lower = (industry || '').toLowerCase();
  if (/restaurant|retail|salon|nail|beauty|fitness|gym/.test(lower)) return contentProducts.ignite_programs.programs.find(p => p.id === 'brick_mortar_booster');
  if (/seasonal|event|holiday|promo/.test(lower)) return contentProducts.ignite_programs.programs.find(p => p.id === 'seasonal_spotlight');
  if (/b2b|consulting|staffing|financial/.test(lower)) return contentProducts.ignite_programs.programs.find(p => p.id === 'one_to_one_marketing');
  return contentProducts.ignite_programs.programs.find(p => p.id === 'brand_builder_pro');
}

// Build intel content block — compact product MENU (one-liners) + VBR triggers + 3 success stories.
// Industry unknown at this point; model uses the menu to orient itself, full detail comes in cadence.
function buildIntelContentBlock() {
  const menu = [
    'SEARCH: SEM (active demand/paid Google), SEO (long-term organic), Demand Gen (pre-search: YouTube/Gmail/Discover)',
    'AI/PROGRAMMATIC: SPARK AI (AI multi-platform targeting across Google network), Targeted Display & Video (programmatic web/apps/games), Retargeting (follow website visitors), CRM Matching / Look-Alike (upload customer list + find similar audiences), Native Advertising (in-content brand messaging), Social Display (social posts as web display ads)',
    'SOCIAL: Facebook/Instagram Marketing (awareness+conversion, demographic targeting), FB Lead Gen (in-platform lead forms), FB Conversions (drive site actions), TikTok (youth/video), LinkedIn (B2B/decision-makers), Nextdoor (hyper-local community), Pinterest (planners/visual), Snapchat (13-30), X/Twitter (news/current events)',
    'STREAMING TV: STV general (non-skip :30 ads on Sling/Pluto/Tubi/Roku/Fire), Audience Targeted STV (demographic+behavioral), STV Retargeted Display (follow STV viewers to their phones), Hulu (premium), YouTube TV (no ad-free tier), Netflix (limited inventory/prestige), Live Sports (appointment viewing)',
    'AMPED LOCAL BRANDS (Townsquare station-owned media): Mobile App Sponsorship (7-sec takeover on app open), Local Display (single-station site), Local Display Network (all stations in market), Ignite Display/Video Network (TSQ content network), First Impression Site Takeover (every site visitor sees your ad), Content Sponsorship (editorial adjacency), SSM / Sponsored Social Mentions (DJ-endorsed Facebook posts), Digital Endorsements (DJs experience your business), Listen Live 2.0 (pre-roll for at-work online radio), 360 Studio Sponsorship (full station co-brand)',
    'LOCATION: Geofencing + Foot Traffic Attribution (target by location, measure store visits), Addressable Geofencing (household-level targeting by address), DOOH (gas pumps, gyms, cafes, salons, medical)',
    'OTHER: YouTube TrueView (skippable pre-roll, research mindset), Email Marketing (inbox delivery to targeted list + match-back reporting), Programmatic Audio (Spotify/podcast non-skip audio), Add to Wallet (digital coupon + redemption tracking), Direct Match (direct mail + digital for homeowners), Radio (90%+ weekly reach; TSQ markets 70%+ with AMPED)',
    'IGNITE PROGRAMS (bundled): Site GrowthEngine ($3K — FB + SPARK AI), Seasonal Spotlight ($2.7K — SSM + FB + Email), Brick & Mortar Booster ($1.5K — Geofencing + Addressable), Brand Builder Pro ($2K — SSM + YouTube + Display), 1:1 Marketing ($1.75K — Email + multi-channel retargeting)',
  ].join('\n');

  const stories = [
    contentStories.case_studies.find(s => s.id === 'tide_cleaners'),
    contentStories.case_studies.find(s => s.id === 'americool_hvac'),
    contentStories.case_studies.find(s => s.id === 'christian_brothers_auto'),
  ].filter(Boolean).map(s =>
    `• ${s.client} (${s.industry}): ${s.talking_point}`
  ).join('\n');

  const vbrTriggers = contentVBR.vbr_triggers_by_situation.map(t =>
    `• "${t.trigger}" → ${t.vbr_angle}`
  ).join('\n');

  return [
    '\n===TSI PRODUCT MENU===',
    'Recommend the right mix from this catalog. Match products to the business\'s industry, funnel stage, and digital readiness.',
    menu,
    '',
    'SAMPLE SUCCESS STORIES (use talking_point in scripts):',
    stories,
    '',
    'VBR TRIGGERS BY SITUATION:',
    vbrTriggers,
    '===END TSI CONTEXT===\n',
  ].join('\n');
}

// Build a targeted content block injected into cadence user messages.
// Industry is known here — inject full detail only for the 2 matched products,
// 1 AMPED pick, 1 Ignite program, call scripts, and the relevant success story.
function buildCadenceContentBlock(industry) {
  const story          = pickSuccessStory(industry);
  const products       = pickProducts(industry);       // 2 industry-matched products, full detail
  const ampedProduct   = pickAmpedProduct(industry);   // 1 best-fit AMPED product
  const program        = pickProgram(industry);        // 1 best-fit Ignite program

  const vbr1          = contentVBR.email_vbr_structure.sample_vbr_email;
  const vm1           = contentScripts.voicemail_templates.first_voicemail;
  const vm2           = contentScripts.voicemail_templates.second_voicemail;
  const vmF           = contentScripts.voicemail_templates.final_voicemail;
  const phoneScript   = contentScripts.phone_script_templates.standard_cold_call;
  const followUp      = contentScripts.phone_script_templates.follow_up_call_after_email;
  const breakupCall   = contentScripts.phone_script_templates.breakup_call;
  const fearOfLoss    = contentScripts.fear_of_loss_language[0];
  const miniClose     = contentScripts.demo_meeting_commitment.before_presenting;
  const step3         = contentScripts.email_sequence_cadence.step_3_day_3.guidance;
  const step6         = contentScripts.email_sequence_cadence.step_6_day_9.guidance;
  const step7         = contentScripts.email_sequence_cadence.step_7_day_10.guidance;

  const objPast   = contentObjections.common_objections.find(o => o.category === 'Past experience');
  const objBudget = contentObjections.common_objections.find(o => o.category === 'Budget');
  const objStall  = contentObjections.common_objections.find(o => o.category === 'Stall');

  const discoveryOpener = contentDiscovery.opening_the_discovery_meeting.step_0_strong_opener.sample_opener;
  const a1Questions     = contentDiscovery.a1_assessment_questions.slice(0, 3).join(' | ');

  // Format product detail block
  const productDetail = products.map(p => [
    `${p.name} — ${p.positioning}`,
    `Best for: ${p.best_for[0]}`,
    p.seller_language ? `Sell with: ${p.seller_language.use} | Avoid: ${p.seller_language.avoid}` : '',
    `Trigger phrase: "${p.trigger_phrases[0]}"`,
  ].filter(Boolean).join('\n')).join('\n\n');

  return [
    '\n===TSI SALES CONTENT===',
    'PRODUCTS MATCHED TO THIS INDUSTRY:',
    productDetail,
    '',
    `AMPED LOCAL BRAND RECOMMENDATION: ${ampedProduct.name}`,
    ampedProduct.description.slice(0, 120),
    '',
    `IGNITE PROGRAM RECOMMENDATION: ${program.name} (${program.monthly_investment}/mo)`,
    program.description.slice(0, 120),
    '',
    'VBR EMAIL TEMPLATE:',
    `Subject: ${vbr1.subject}`,
    `Body:\n${vbr1.body}`,
    '',
    'PHONE SCRIPT TEMPLATE:',
    phoneScript,
    '',
    'VOICEMAIL TEMPLATES:',
    `VM1: ${vm1}`,
    `VM2: ${vm2}`,
    `Final: ${vmF}`,
    '',
    'FOLLOW-UP SCRIPT:', followUp,
    'BREAK-UP CALL:', breakupCall,
    '',
    'EMAIL #2 (Success Story step):', step3,
    'EMAIL #3 (Value + Referral step):', step6,
    'FINAL STEP:', step7,
    '',
    'FEAR-OF-LOSS:', fearOfLoss,
    'MINI-CLOSE:', miniClose,
    '',
    `SUCCESS STORY — ${(industry || 'this category').toUpperCase()}:`,
    `${story.client} (${story.industry}) — ${story.talking_point}`,
    `"${story.testimonial.quote.slice(0, 180)}" — ${story.testimonial.contact}`,
    '',
    'LIKELY OBJECTIONS:',
    objPast   ? `"${objPast.objection}" → ${objPast.overcome.slice(0, 110)}` : '',
    objBudget ? `"${objBudget.objection}" → ${objBudget.overcome.slice(0, 110)}` : '',
    objStall  ? `"${objStall.objection}" → ${objStall.overcome.slice(0, 110)}` : '',
    '',
    'DISCOVERY OPENER:', discoveryOpener,
    'A1 QUESTIONS:', a1Questions,
    '===END TSI CONTENT===\n',
  ].filter(line => line !== null && line !== undefined).join('\n');
}

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
    "Short phrase reason 1 — max 40 characters, specific to this business",
    "Short phrase reason 2 — max 40 characters",
    "Short phrase reason 3 — max 40 characters",
    "Short phrase reason 4 — max 40 characters",
    "Short phrase reason 5 — max 40 characters"
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

  "categoryLanguage": {
    "context": "One sentence: why does language discipline matter when selling digital advertising to this specific category? What would make a seller sound careless or uninformed?",
    "swaps": [
      { "use": "phrase the seller should say", "avoid": "phrase to avoid" },
      { "use": "...", "avoid": "..." }
    ]
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
- When writing phone and walk-in scripts, follow the VBR structure from TSI PRODUCT & SALES CONTEXT: Hook → VBR → Credibility → Ask (25-35 sec total for phone)
- Use the VBR TRIGGERS BY SITUATION to inform the bestMeetingAngle and meetingHook — pick the trigger that best matches what you observe about this business
- categoryLanguage.swaps must align with seller_language guidance from the matching product in TSI PRODUCT & SALES CONTEXT — use its "use" terms as the foundation
- conversationStarters must open natural business conversations, not interrogations
- If website could not be fetched, infer everything from domain name and industry — still generate all fields
- marketSummary.headline must be specific to THIS business — never generic. Reference actual content from the site.
- marketSummary.activeCTAs should reflect real button/link text found on the site (e.g. "Shop Mattresses", "Schedule a Consultation", "Get a Free Quote"). Max 6. If site can't be fetched, return empty array.
- marketSummary.gaps should be concrete, seller-relevant observations (e.g. "No email capture or lead form detected", "No promotional pricing or seasonal offers visible", "No customer reviews or social proof on homepage"). Max 3. Never mention pixels, GTM, or tracking tech.
- categoryLanguage.swaps: generate 5-7 pairs specific to this business's exact industry. Simple, concrete vocabulary a seller would actually say out loud. Focus on what sounds credible vs. generic in this category. Examples: { "use": "booked consultations", "avoid": "leads" } for med spa; { "use": "loan application volume", "avoid": "website clicks" } for a bank.
- categoryLanguage.context: one sentence on why language discipline matters for this specific category — especially important in medical, legal, financial, and regulated industries.
- CRITICAL — GTM rule: If Google Tag Manager is detected, NEVER mention missing pixels, missing tracking, pixel gaps, or tracking setup as a gap, insight, or opportunity anywhere in the response — not in gaps, not in meetingHook, not in whatToSay, not in bestMeetingAngle, not in coachingNote. GTM is a container that can silently fire any pixel. Flagging missing pixels when GTM is present is factually wrong and will mislead sellers.`;

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------
async function callClaude(html, domain, pixels, apiKey, businessName, context) {
  // When GTM is present, individual pixel detection is unreliable — pixels may be
  // firing through the container without appearing in raw HTML. Only pass GTM status.
  const pixelSummary = pixels.gtm
    ? '- Google Tag Manager: YES (' + pixels.gtmId + ')\n' +
      '- NOTE: GTM container present. Individual pixel presence cannot be determined from HTML source — do NOT infer missing pixels.'
    : '- Google Tag Manager: NOT DETECTED\n' +
      '- Google Analytics: '  + (pixels.googleAnalytics ? 'YES (' + (pixels.gaId || 'UA format') + ')' : 'NOT DETECTED') + '\n' +
      '- Google Ads pixel: '  + (pixels.googleAds       ? 'YES (' + pixels.adsId + ')'             : 'NOT DETECTED') + '\n' +
      '- Remarketing: '       + (pixels.remarketing     ? 'YES'                                     : 'NOT DETECTED');

  const userContent =
    'Business name: ' + (businessName || '(extract from website)') + '\n' +
    'Domain: ' + domain + '\n\n' +
    'Pixel detection results:\n' +
    pixelSummary + '\n\n' +
    (context ? '\n===SALES REP PERSONALIZATION===\n' +
      context + '\n' +
      'IMPORTANT: You MUST incorporate the above personalization into bestMeetingAngle and both whatToSay scripts (phone and walkin). The sales rep typed this instruction specifically so it appears in the output they will use. Do not ignore it.\n\n' : '') +
    buildIntelContentBlock() +
    'Website HTML (truncated to 30,000 characters):\n' +
    (html ? html.slice(0, 15000) : 'Website could not be fetched. Generate intel based on the domain name and industry inference only.');

  console.log('[IGI] Calling Claude API for domain:', domain);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages:   [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(55000),
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
// Cadence prompt + API call
// ---------------------------------------------------------------------------
const CADENCE_PROMPT = `You are a sales cadence writer for a local digital advertising sales team at Townsquare Ignite.

Given prospect intel and any prior step notes, write the outreach content for the specific step requested.

The 7-step cadence spans 10 business days:
- Step 1 (Day 1): Introductory Email — Lead with a Valid Business Reason (VBR). Reference something specific and real about their business. End with a clear ask for 20 minutes.
- Step 2 (Day 2): Phone Call — Reference the Day 1 email by name. Keep it under 30 seconds.
- Step 3 (Day 3): Email #2 — Include a brief success story relevant to their industry or category. One specific example.
- Step 4 (Day 5): LinkedIn — Brief connection message or comment. Under 150 characters. Casual and human.
- Step 5 (Day 7): Phone Call #2 — Reiterate insights, VBR, and urgency. Reference any prior interaction.
- Step 6 (Day 9): Email #3 — Highlight key value and include a referral or reference if possible.
- Step 7 (Day 10): Final Phone Call + Break-up Email — State this is the last attempt. Break-up email should be warm, slightly humorous, specific to this business, and leave the door open.

Critical rules:
- NEVER mention pixels, GTM, tracking tags, remarketing, or ad tech in any customer-facing content
- Sound like you know the business — not like you audited their website
- Use the prospect's actual business name, services, and real details from the intel
- If prior step notes are provided, reference them naturally — build on what happened
- Emails: short paragraphs, conversational tone, clear single ask, 3-4 paragraphs max
- Phone scripts: 20-30 seconds spoken naturally, no bullet points, natural language
- Voicemails: 15-20 seconds, name + one specific business detail + callback ask
- LinkedIn: under 150 characters, casual and direct
- Break-up email: warm tone, light humor, specific to this business, leaves door open
- Use [Your Name] as placeholder for the rep's name
- Use [Your Phone] as placeholder for the callback number
- The user message includes a TSI SALES CONTENT block — use it as follows:
  • Step 1 email: follow VBR EMAIL TEMPLATE structure; use subject formula; reference the RELEVANT SUCCESS STORY talking_point if natural
  • Step 2/5 phone: adapt the PHONE SCRIPT TEMPLATE with this prospect's details; use voicemail templates verbatim with prospect details filled in
  • Step 3 email: open with the RELEVANT SUCCESS STORY — quote or paraphrase the testimonial; follow EMAIL #2 GUIDANCE
  • Step 4 LinkedIn: keep under 150 characters, casual; do NOT pitch — just connect
  • Step 6 email: use EMAIL #3 GUIDANCE; include the FEAR-OF-LOSS LANGUAGE if timing is relevant
  • Step 7: use BREAK-UP CALL SCRIPT as a structural guide; keep break-up email specific to this business and warm
  • Phone steps: always provide BOTH a live script AND a voicemail version

Return ONLY valid JSON. No markdown fences, no explanation.

Email steps (1, 3, 6): {"type":"email","subject":"...","body":"..."}
Phone steps (2, 5): {"type":"phone","script":"...","voicemail":"..."}
LinkedIn step (4): {"type":"linkedin","message":"..."}
Final step (7): {"type":"phone_and_email","script":"...","voicemail":"...","breakupSubject":"...","breakupBody":"..."}`;

const CADENCE_STEPS_META = [
  { day:1,  label:'Introductory Email' },
  { day:2,  label:'Follow-Up Phone Call' },
  { day:3,  label:'Email #2 — Success Story' },
  { day:5,  label:'LinkedIn Engage' },
  { day:7,  label:'Follow-Up Phone Call #2' },
  { day:9,  label:'Email #3 — Value + Referral' },
  { day:10, label:'Final Call + Break-up Email' },
];

async function callClaudeCadence(stepIndex, intel, priorSteps, apiKey) {
  const step = CADENCE_STEPS_META[stepIndex];

  const priorContext = priorSteps.length
    ? 'Prior outreach steps:\n' + priorSteps.map(s =>
        `Step ${s.stepNum} (Day ${s.day}, ${s.type}): ${s.label}` +
        (s.notes ? `\n  Rep notes: ${s.notes}` : ' — no notes recorded') +
        (s.status === 'completed' ? ' [COMPLETED]' : '')
      ).join('\n')
    : 'This is the first step — no prior outreach yet.';

  const userContent =
    `Business: ${intel.businessName || '(unknown)'}\n` +
    `Industry: ${intel.industry || ''}\n` +
    `Domain: ${intel.domain || ''}\n` +
    `Best meeting angle: ${intel.bestMeetingAngle || ''}\n` +
    `Meeting hook: ${intel.meetingHook || ''}\n` +
    `Why worth calling:\n${(intel.whyWorthCalling || []).map(w => `- ${w.label||''}: ${w.detail||''}`).join('\n')}\n\n` +
    `Market summary: ${(intel.marketSummary && intel.marketSummary.headline) || ''}\n\n` +
    priorContext + '\n\n' +
    buildCadenceContentBlock(intel.industry) +
    `Generate content for: Step ${stepIndex + 1} — Day ${step.day} — ${step.label}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [{ type: 'text', text: CADENCE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error('Claude API error ' + response.status + ': ' + body.slice(0, 200));
  }

  const data = await response.json();
  const text = data.content[0].text;
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in cadence response');
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// POST /  –  main handler
// ---------------------------------------------------------------------------
app.post('/', async (req, res) => {
  const { domain, profileKey, businessName, context } = req.body || {};

  if (!domain || !profileKey) {
    return res.status(400).json({ error: 'domain and profileKey are required' });
  }

  const safeKey = profileKey.replace(/[^a-z0-9\-_]/gi, '-').slice(0, 80);

  try {
    // Check Firestore cache first (if available)
    if (db) {
      try {
        const cached = await db.collection('prospectIntel').doc(safeKey).get();
        if (cached.exists) {
          console.log('[IGI] Cache hit:', safeKey);
          return res.json({ success: true, data: cached.data(), cached: true });
        }
      } catch (cacheErr) {
        console.warn('[IGI] Cache read failed, continuing without cache:', cacheErr.message);
      }
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

    const intel = await callClaude(html, domain, pixels, apiKey, businessName, context);

    // Attach computed fields
    intel.digitalReadiness = Object.assign({}, pixels, dr);
    intel.domain           = domain;
    intel.generatedAt      = new Date().toISOString();

    // Build human-readable adPixels list from detected tracking tags.
    // When GTM is present, only show GTM — individual pixels may be firing
    // through the container and are not reliably detectable from HTML source.
    var detectedPixels = [];
    if (pixels.gtm) {
      detectedPixels.push('Google Tag Manager' + (pixels.gtmId ? ' (' + pixels.gtmId + ')' : ''));
    } else {
      if (pixels.googleAnalytics) detectedPixels.push('Google Analytics' + (pixels.gaId  ? ' (' + pixels.gaId  + ')' : ''));
      if (pixels.googleAds)       detectedPixels.push('Google Ads'       + (pixels.adsId ? ' (' + pixels.adsId + ')' : ''));
      if (pixels.remarketing)     detectedPixels.push('Remarketing tag');
    }
    if (!intel.supportingIntel) intel.supportingIntel = {};
    intel.supportingIntel.adPixels = { detected: detectedPixels, hasGTM: pixels.gtm };

    // Save to Firestore (if available)
    if (db) {
      try {
        await db.collection('prospectIntel').doc(safeKey).set(intel);
        console.log('[IGI] Intel saved:', safeKey);
      } catch (saveErr) {
        console.warn('[IGI] Cache write failed, result still returned:', saveErr.message);
      }
    }

    return res.json({ success: true, data: intel, cached: false });

  } catch (err) {
    console.error('[IGI] Error for', domain, '-', err.message);
    return res.status(500).json({ error: err.message || 'Intel generation failed' });
  }
});


// ---------------------------------------------------------------------------
// POST /cadence  –  generate one cadence step
// ---------------------------------------------------------------------------
app.post('/cadence', async (req, res) => {
  const { stepIndex, intel, priorSteps, profileKey } = req.body || {};

  if (typeof stepIndex !== 'number' || stepIndex < 0 || stepIndex > 6) {
    return res.status(400).json({ error: 'stepIndex must be 0-6' });
  }
  if (!intel || !intel.businessName) {
    return res.status(400).json({ error: 'intel.businessName is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    console.log('[CAD] Step', stepIndex, 'for:', intel.businessName);
    const content = await callClaudeCadence(stepIndex, intel, priorSteps || [], apiKey);
    return res.json({ success: true, content });
  } catch (err) {
    console.error('[CAD] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Cadence generation failed' });
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
