'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function parseBudgetUsd(text) {
  const src = lower(text);
  if (!src) return null;
  const k = src.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/);
  if (k) return Math.round(Number(k[1]) * 1000);
  const plain = src.match(/\$?\s*(\d{3,6})(?:\s*usd)?\b/);
  if (plain) return Math.round(Number(plain[1]));
  const under = src.match(/\b(?:under|below|max|budget)\s+\$?\s*(\d{3,6})\b/);
  if (under) return Math.round(Number(under[1]));
  return null;
}

function parseMonitorCount(text) {
  const src = lower(text);
  const m = src.match(/\b(\d)\s*(?:monitors?|screens?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFormFactor(text) {
  const src = lower(text);
  if (/\b(laptop|notebook|portable)\b/.test(src)) return 'laptop';
  if (/\b(desktop|tower|workstation)\b/.test(src)) return 'desktop';
  return null;
}

function parsePrimaryUse(text) {
  const src = lower(text);
  if (/\b(trad(?:e|ing)|futures|topstep|mnq)\b/.test(src)) return 'trading';
  if (/\b(gam(?:e|ing))\b/.test(src)) return 'gaming';
  if (/\b(video|editing|render|3d|cad)\b/.test(src)) return 'content_creation';
  return null;
}

function parseProjectBusiness(text) {
  const src = normalizeText(text);
  const m = src.match(/\b(?:for|my)\s+([a-z0-9][a-z0-9\s-]{2,40})\s+business\b/i);
  if (m) return normalizeText(m[1]);
  if (/\bt[-\s]?shirt\b/i.test(src)) return 't-shirt';
  return null;
}

function parseAudience(text) {
  const src = lower(text);
  if (/\b(traders?|investors?)\b/.test(src)) return 'traders';
  if (/\b(local|community|nearby)\b/.test(src)) return 'local customers';
  if (/\b(teens?|students?)\b/.test(src)) return 'students';
  if (/\b(enterprise|businesses|b2b)\b/.test(src)) return 'business buyers';
  return null;
}

function parseBrandTone(text) {
  const src = lower(text);
  if (/\b(futuristic|modern|clean|minimal)\b/.test(src)) return 'modern';
  if (/\b(luxury|premium|high end)\b/.test(src)) return 'premium';
  if (/\b(playful|fun|bold)\b/.test(src)) return 'playful';
  if (/\b(corporate|professional)\b/.test(src)) return 'professional';
  return null;
}

function parsePrimaryGoal(text) {
  const src = lower(text);
  if (/\b(sales|sell|checkout|orders?)\b/.test(src)) return 'sales';
  if (/\b(leads?|bookings?|appointments?)\b/.test(src)) return 'lead_generation';
  if (/\b(signups?|newsletter|community)\b/.test(src)) return 'signups';
  return null;
}

function parsePages(text) {
  const src = lower(text);
  const pages = [];
  if (/\b(home|homepage|landing)\b/.test(src)) pages.push('home');
  if (/\b(shop|store|products?)\b/.test(src)) pages.push('shop');
  if (/\b(about)\b/.test(src)) pages.push('about');
  if (/\b(contact|support)\b/.test(src)) pages.push('contact');
  if (/\b(faq)\b/.test(src)) pages.push('faq');
  if (/\b(blog|articles?)\b/.test(src)) pages.push('blog');
  return Array.from(new Set(pages));
}

function collectShoppingProfile(existing = {}, message = '') {
  const next = {
    budgetUsd: existing.budgetUsd ?? null,
    formFactor: existing.formFactor || null,
    monitorCount: existing.monitorCount ?? null,
    primaryUse: existing.primaryUse || null,
    priorities: Array.isArray(existing.priorities) ? existing.priorities.slice() : [],
  };
  const budget = parseBudgetUsd(message);
  if (budget) next.budgetUsd = budget;
  const form = parseFormFactor(message);
  if (form) next.formFactor = form;
  const monitorCount = parseMonitorCount(message);
  if (monitorCount) next.monitorCount = monitorCount;
  const use = parsePrimaryUse(message);
  if (use) next.primaryUse = use;
  const src = lower(message);
  const prioritySignals = [
    { key: 'low_noise', re: /\b(quiet|silent|low noise)\b/ },
    { key: 'future_proof', re: /\b(future proof|upgradeable)\b/ },
    { key: 'low_latency', re: /\b(low latency|execution speed|fast)\b/ },
    { key: 'portability', re: /\b(portable|travel|lightweight)\b/ },
  ];
  for (const row of prioritySignals) {
    if (row.re.test(src) && !next.priorities.includes(row.key)) next.priorities.push(row.key);
  }
  return next;
}

function collectProjectProfile(existing = {}, message = '') {
  const next = {
    businessType: existing.businessType || null,
    audience: existing.audience || null,
    brandTone: existing.brandTone || null,
    primaryGoal: existing.primaryGoal || null,
    pages: Array.isArray(existing.pages) ? existing.pages.slice() : [],
  };
  const businessType = parseProjectBusiness(message);
  if (businessType) next.businessType = businessType;
  const audience = parseAudience(message);
  if (audience) next.audience = audience;
  const brandTone = parseBrandTone(message);
  if (brandTone) next.brandTone = brandTone;
  const primaryGoal = parsePrimaryGoal(message);
  if (primaryGoal) next.primaryGoal = primaryGoal;
  const pages = parsePages(message);
  if (pages.length > 0) {
    next.pages = Array.from(new Set([...(next.pages || []), ...pages]));
  }
  return next;
}

function nextShoppingQuestion(profile = {}) {
  if (!profile.budgetUsd) return 'What budget should I target for this trading PC in USD?';
  if (!profile.formFactor) return 'Do you want a desktop or laptop?';
  if (!profile.monitorCount) return 'How many monitors will you run daily?';
  return null;
}

function nextProjectQuestion(profile = {}) {
  if (!profile.businessType) return 'What business is this website for?';
  if (!profile.audience) return 'Who is the main audience you want to attract?';
  if (!profile.primaryGoal) return 'What is the main goal: sales, leads, or signups?';
  return null;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function buildShoppingRecommendations(profile = {}) {
  const budget = Number(profile.budgetUsd || 0);
  const form = profile.formFactor || 'desktop';
  const useLabel = profile.primaryUse || 'trading';
  const monitorCount = Number(profile.monitorCount || 2);
  const tier = budget <= 1600 ? 'entry' : (budget <= 2600 ? 'performance' : 'elite');
  const baseQuery = `${form} ${useLabel} pc ${monitorCount} monitor`;
  const suggestions = {
    entry: [
      {
        name: 'Balanced Entry Build (Ryzen 7 / 32GB / RTX 4060)',
        why: 'Solid charting and execution speed with controlled cost.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' Ryzen 7 32GB RTX 4060')}`,
      },
      {
        name: 'Intel Entry Build (i7 / 32GB / RTX 4060)',
        why: 'Strong single-core responsiveness for active order flow.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' i7 32GB RTX 4060')}`,
      },
    ],
    performance: [
      {
        name: 'Performance Build (i7 / 64GB / RTX 4070)',
        why: 'More headroom for multiple platforms, DOM, and browser tabs.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' i7 64GB RTX 4070')}`,
      },
      {
        name: 'Performance AMD Build (Ryzen 9 / 64GB / RTX 4070)',
        why: 'High thread count and memory capacity for heavy multitasking.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' Ryzen 9 64GB RTX 4070')}`,
      },
    ],
    elite: [
      {
        name: 'Elite Build (i9 / 64GB / RTX 4080)',
        why: 'Maximum smoothness for multi-display and low-latency workflows.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' i9 64GB RTX 4080')}`,
      },
      {
        name: 'Elite Workstation (Ryzen 9 / 96GB / RTX 4080)',
        why: 'Future-proof capacity for advanced analytics and streaming.',
        link: `https://www.newegg.com/p/pl?d=${encodeURIComponent(baseQuery + ' Ryzen 9 96GB RTX 4080')}`,
      },
    ],
  };
  return {
    budgetTier: tier,
    recommendations: suggestions[tier].slice(0, 2),
  };
}

function renderShoppingReply(profile = {}, result = {}) {
  const lines = [];
  lines.push(`Based on your target of ${formatUsd(profile.budgetUsd)} for a ${profile.formFactor} trading setup, here are my best options.`);
  for (const [idx, row] of (result.recommendations || []).entries()) {
    lines.push(`${idx + 1}) ${row.name} — ${row.why} ${row.link}`);
  }
  lines.push('If you want, I can tighten this to one final pick with exact parts and tradeoffs.');
  return lines.join(' ');
}

function buildProjectPlan(profile = {}) {
  const pages = Array.isArray(profile.pages) && profile.pages.length > 0
    ? profile.pages
    : ['home', 'shop', 'about', 'contact'];
  const designBrief = [
    `Brand: ${profile.businessType || 'business'} (${profile.brandTone || 'modern'} tone).`,
    `Audience: ${profile.audience || 'target buyers'}.`,
    `Primary goal: ${profile.primaryGoal || 'sales'}.`,
    `Core pages: ${pages.join(', ')}.`,
  ];
  const buildPlan = [
    'Phase 1: Information architecture and wireframes for core pages.',
    'Phase 2: Design system (type, color, components) and high-fidelity screens.',
    'Phase 3: Build frontend with responsive layout and checkout/contact flow.',
    'Phase 4: QA, analytics hooks, and launch checklist.',
  ];
  return {
    designBrief,
    buildPlan,
  };
}

function renderProjectReply(profile = {}, plan = {}) {
  return [
    'Project brief ready.',
    ...plan.designBrief.map((row, idx) => `${idx + 1}. ${row}`),
    'Build plan:',
    ...plan.buildPlan.map((row, idx) => `${idx + 1}. ${row}`),
  ].join(' ');
}

function startShoppingFlow(message = '', existing = {}) {
  const profile = collectShoppingProfile(existing, message);
  const missing = nextShoppingQuestion(profile);
  if (missing) {
    return {
      complete: false,
      profile,
      reply: missing,
      pendingType: 'shopping_intake',
    };
  }
  const result = buildShoppingRecommendations(profile);
  return {
    complete: true,
    profile,
    result,
    reply: renderShoppingReply(profile, result),
    pendingType: null,
  };
}

function startProjectFlow(message = '', existing = {}) {
  const profile = collectProjectProfile(existing, message);
  const missing = nextProjectQuestion(profile);
  if (missing) {
    return {
      complete: false,
      profile,
      reply: missing,
      pendingType: 'project_intake',
    };
  }
  const result = buildProjectPlan(profile);
  return {
    complete: true,
    profile,
    result,
    reply: renderProjectReply(profile, result),
    pendingType: null,
  };
}

module.exports = {
  parseBudgetUsd,
  collectShoppingProfile,
  collectProjectProfile,
  startShoppingFlow,
  startProjectFlow,
  buildShoppingRecommendations,
  buildProjectPlan,
};

