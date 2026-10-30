require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY      = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o';
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const ASPECT_RATIOS = {
  instagram: '1:1', instagram_stories: '9:16',
  linkedin: '16:9', facebook: '4:5',
  feed_1x1: '1:1', feed_4x5: '4:5',
  stories: '9:16', carrusel: '3:4'
};

// ── CLIENTES (solo .md files) ────────────────────────────────

function loadClient(slug) {
  if (!slug || !/^[a-z0-9_-]+$/.test(slug)) return null;
  const fp = path.join(__dirname, 'clients', slug + '.md');
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

function listClients() {
  const dir = path.join(__dirname, 'clients');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => f.replace('.md', ''));
}

function listClientsAll() {
  return listClients();
}

function parseMeta(md) {
  const get = (re) => { const m = md.match(re); return m ? m[1].trim() : null; };
  return {
    name:         get(/\*\*Nombre\*\*:\s*(.+)/)         || 'Cliente',
    rubro:        get(/\*\*Rubro\*\*:\s*(.+)/)           || '',
    colorPrimary: get(/Principal:\s*(#[0-9A-Fa-f]{6})/) || '#c8f135',
    colorAccent:  get(/Acento:\s*(#[0-9A-Fa-f]{6})/)    || '#888888',
    colorBtnText: get(/Texto sobre botones:\s*(#[0-9A-Fa-f]{6})/) || '#ffffff',
  };
}

// Carga cliente desde .md
function resolveClient(slug) {
  const md = loadClient(slug);
  if (!md) return null;
  return { slug, ...parseMeta(md), mdContent: md };
}

// ── BILLING: PRECIOS ──────────────────────────────────────────
const MODEL_PRICES = {
  'claude-opus-4-5':           { input: 15.00/1e6, output: 75.00/1e6 },
  'claude-opus-4-6':           { input: 15.00/1e6, output: 75.00/1e6 },
  'claude-sonnet-4-6':         { input:  3.00/1e6, output: 15.00/1e6 },
  'claude-sonnet-4-20250514':  { input:  3.00/1e6, output: 15.00/1e6 },
  'claude-haiku-4-5-20251001': { input:  0.80/1e6, output:  4.00/1e6 },
};
const FLUX_COST_PER_SECOND = 0.0032;

// ── MODELOS DE IMAGEN (Replicate) ─────────────────────────────
// Para sumar un modelo nuevo: agregarlo acá + su rama en buildImageInput() y en imageModelPromptGuide().
const IMAGE_MODELS = {
  'flux-2-pro': {
    label:       'Flux 2 Pro',
    vendor:      'Black Forest Labs',
    replicate:   'black-forest-labs/flux-2-pro',
    pricing:     'per_second',
    cost:        FLUX_COST_PER_SECOND,                         // USD por segundo de GPU
    billing_key: 'flux_image',
    tagline:     'Fotografía publicitaria realista, rápido',
  },
  'nano-banana-pro': {
    label:       'Nano Banana Pro',
    vendor:      'Google',
    replicate:   'google/nano-banana-pro',
    pricing:     'per_image',
    cost:        parseFloat(process.env.NANO_BANANA_PRO_COST || '0.15'), // USD por imagen (1K/2K) — verificar en Replicate
    billing_key: 'nano_banana_image',
    tagline:     'Mejor con textos en la imagen y fidelidad de producto',
  },
};
const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[process.env.DEFAULT_IMAGE_MODEL] ? process.env.DEFAULT_IMAGE_MODEL : 'flux-2-pro';
const FLUX_MAX_INPUT_IMAGES = parseInt(process.env.FLUX_MAX_INPUT_IMAGES || '8', 10); // Flux 2 Pro: imágenes de referencia por pedido
const NANO_BANANA_RESOLUTION = process.env.NANO_BANANA_RESOLUTION || '2K'; // 1K | 2K | 4K (4K cuesta el doble)

function resolveImageModel(key) {
  return IMAGE_MODELS[key] ? key : DEFAULT_IMAGE_MODEL;
}

// Costo de UNA imagen. seconds = predict_time real de Replicate (si lo tenemos)
function calcImageCost(modelKey, seconds) {
  const m = IMAGE_MODELS[resolveImageModel(modelKey)];
  if (m.pricing === 'per_image') return m.cost;
  return (seconds || 15) * m.cost;
}

function buildImageInput(modelKey, prompt, aspectRatio, inputImages) {
  if (modelKey === 'nano-banana-pro') {
    const input = {
      prompt,
      aspect_ratio: aspectRatio,
      resolution: NANO_BANANA_RESOLUTION,
      output_format: 'jpg',
      safety_filter_level: 'block_only_high',
    };
    if (inputImages.length) input.image_input = inputImages.slice(0, 14);
    return input;
  }
  // flux-2-pro
  const input = {
    prompt,
    aspect_ratio: aspectRatio,
    output_format: 'jpg',
    output_quality: 95,
    safety_tolerance: 5,
  };
  if (inputImages.length) input.input_images = inputImages.slice(0, FLUX_MAX_INPUT_IMAGES);
  return input;
}

function calcClaudeCost(model, inputTok, outputTok) {
  const p = MODEL_PRICES[model] || MODEL_PRICES['claude-sonnet-4-6'];
  return (inputTok * p.input) + (outputTok * p.output);
}

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

// ── BILLING: JSON FILES ──────────────────────────────────────
const BILLING_CONFIG_FILE = path.join(__dirname, 'clients', 'billing.json');
const BILLING_DEFAULT_CFG = { admin_password:'docta2024', contact_phone:'351 6 886262', usd_to_ars:1200, usd_to_eur:0.92 };

function loadBillingConfig() {
  try {
    if (!fs.existsSync(BILLING_CONFIG_FILE)) return { ...BILLING_DEFAULT_CFG };
    return { ...BILLING_DEFAULT_CFG, ...JSON.parse(fs.readFileSync(BILLING_CONFIG_FILE, 'utf8')) };
  } catch { return { ...BILLING_DEFAULT_CFG }; }
}

function saveBillingConfig(cfg) {
  fs.writeFileSync(BILLING_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function billingFilePath(slug) {
  return path.join(__dirname, 'clients', slug + '.billing.json');
}

function loadClientBilling(slug) {
  try {
    const fp = billingFilePath(slug);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

function saveClientBilling(slug, data) {
  fs.writeFileSync(billingFilePath(slug), JSON.stringify(data, null, 2));
}

function initMonthBlock() {
  return { month: currentMonth(), graphics: 0, calls: { director_ia:0, claude_analysis:0, flux_image:0, nano_banana_image:0 }, real_cost_usd:0, charged_usd:0, detail:[] };
}

function ensureCurrentMonth(billing) {
  const cm = currentMonth();
  if (!billing.current_month || billing.current_month.month !== cm) {
    // Archivar mes anterior si tiene datos
    if (billing.current_month && billing.current_month.graphics > 0) {
      billing.history = billing.history || [];
      billing.history.unshift(billing.current_month);
      billing.history = billing.history.slice(0, 24); // max 24 meses
    }
    billing.current_month = initMonthBlock();
  }
  return billing;
}

function checkBillingLimit(slug) {
  try {
    const billing = loadClientBilling(slug);
    if (!billing) return { ok: true };
    if (billing.active === false) return { ok: false, reason: 'inactive', billing };
    const cm = (billing.current_month && billing.current_month.month === currentMonth()) ? billing.current_month : initMonthBlock();
    if (billing.plan_monthly > 0 && cm.graphics >= billing.plan_monthly)
      return { ok: false, reason: 'limit_reached', billing, monthData: cm };
    return { ok: true };
  } catch(e) {
    console.error('[billing check]', e.message);
    return { ok: true };
  }
}

function recordGeneration(slug, costs) {
  try {
    let billing = loadClientBilling(slug);
    if (!billing) {
      billing = {
        slug, plan_monthly: 30, pricing_mode: 'markup', markup: 4,
        fixed_price: { ars:3000, usd:2.5, eur:2.3 }, currency_display: 'ars', active: true,
        current_month: initMonthBlock(), history: [],
      };
    }

    const cfg = loadBillingConfig();
    billing = ensureCurrentMonth(billing);
    const monthData = billing.current_month;

    // Imagen: formato nuevo costs.image = { model, count, seconds } — compat con formato viejo costs.flux = { seconds }
    const img = costs.image || (costs.flux ? { model: 'flux-2-pro', count: 1, seconds: costs.flux.seconds } : null);
    const imgModelKey = img ? resolveImageModel(img.model) : null;
    const imgModel    = imgModelKey ? IMAGE_MODELS[imgModelKey] : null;
    const imgCount    = img ? Math.max(1, parseInt(img.count) || 1) : 0;
    // seconds = suma de predict_time de todas las imágenes generadas (para modelos por segundo)
    const imgCost = img
      ? (imgModel.pricing === 'per_image' ? imgModel.cost * imgCount : (img.seconds || 15 * imgCount) * imgModel.cost)
      : 0;

    // Calcular costos reales — Director IA (OpenAI) + Claude + modelo de imagen
    // Formatos entregados en esta generación (Pack Meta = 3). Cada formato cuenta como una gráfica del plan.
    const formats = Math.max(1, Math.min(10, parseInt(costs.formats) || 1));
    const realCost = {
      director_ia:     costs.director_ia     ? (costs.director_ia.cost_usd || 0) : 0,
      claude_analysis: (costs.claude_analysis ? calcClaudeCost(costs.claude_analysis.model, costs.claude_analysis.input_tokens||0, costs.claude_analysis.output_tokens||0) : 0) + (parseFloat(costs.extra_claude_usd) || 0),
      flux_image:        imgModel?.billing_key === 'flux_image'        ? imgCost : 0,
      nano_banana_image: imgModel?.billing_key === 'nano_banana_image' ? imgCost : 0,
    };
    Object.keys(realCost).forEach(k => { realCost[k] = parseFloat(realCost[k].toFixed(6)); });
    const totalReal = Object.values(realCost).reduce((a,v) => a+v, 0);

    let charged = 0;
    if      (billing.pricing_mode === 'markup') charged = totalReal * (billing.markup || 1);
    else if (billing.pricing_mode === 'fixed')  charged = (billing.fixed_price?.usd || 0) * formats;

    monthData.graphics      += formats;
    monthData.calls = monthData.calls || {};
    monthData.calls.director_ia     = (monthData.calls.director_ia||0)     + (costs.director_ia ? 1 : 0);
    monthData.calls.claude_analysis = (monthData.calls.claude_analysis||0) + (costs.claude_analysis ? 1 : 0);
    monthData.calls.flux_image        = (monthData.calls.flux_image||0)        + (imgModel?.billing_key === 'flux_image'        ? imgCount : 0);
    monthData.calls.nano_banana_image = (monthData.calls.nano_banana_image||0) + (imgModel?.billing_key === 'nano_banana_image' ? imgCount : 0);
    monthData.real_cost_usd  = parseFloat(((monthData.real_cost_usd||0) + totalReal).toFixed(6));
    monthData.charged_usd    = parseFloat(((monthData.charged_usd||0) + charged).toFixed(6));

    monthData.detail = monthData.detail || [];
    monthData.detail.push({
      date: new Date().toISOString(),
      real_cost_usd: parseFloat(totalReal.toFixed(6)),
      breakdown: realCost,
      charged_usd: parseFloat(charged.toFixed(6)),
      model_claude: costs.claude_analysis?.model || null,
      model_image:  imgModelKey,
      images:       imgCount,
      mode:         ['product','background','ai'].includes(costs.mode) ? costs.mode : 'product',
      formats,
    });
    if (monthData.detail.length > 200) monthData.detail = monthData.detail.slice(-200);

    billing.current_month = monthData;
    saveClientBilling(slug, billing);

    const rates = { ars: cfg.usd_to_ars||1200, eur: cfg.usd_to_eur||0.92 };
    return {
      graphics:      monthData.graphics,
      remaining:     billing.plan_monthly > 0 ? Math.max(0, billing.plan_monthly - monthData.graphics) : null,
      real_cost_usd: parseFloat(totalReal.toFixed(6)),
      charged_usd:   parseFloat(charged.toFixed(4)),
      charged_ars:   Math.round(charged * rates.ars),
      charged_eur:   parseFloat((charged * rates.eur).toFixed(2)),
      breakdown:     realCost,
    };
  } catch(e) {
    console.error('[recordGeneration]', e.message);
    return null;
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── AUTH HELPER ──────────────────────────────────────────────
function checkAdminAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const headerPass = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryPass  = req.query.password || req.body?.password || null;
  const provided   = headerPass || queryPass;
  const cfg = loadBillingConfig();
  return provided && provided === cfg.admin_password;
}

// ── CLIENT ENDPOINTS ──────────────────────────────────────────
app.get('/api/client/:slug', async (req, res) => {
  const client = await resolveClient(req.params.slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json(client);
});

app.get('/api/clients', async (req, res) => {
  const slugs = await listClientsAll();
  const clients = await Promise.all(slugs.map(async s => {
    const c = await resolveClient(s);
    return c || { slug: s, name: s };
  }));
  res.json(clients);
});

// (CRUD clientes via .md files — no requiere endpoints)

// ── MODELOS DE IMAGEN DISPONIBLES (para el selector del front) ──
app.get('/api/image-models', (req, res) => {
  res.json({
    default: DEFAULT_IMAGE_MODEL,
    models: Object.entries(IMAGE_MODELS).map(([key, m]) => ({
      key, label: m.label, vendor: m.vendor, pricing: m.pricing, cost: m.cost, tagline: m.tagline,
    })),
  });
});

// ── BILLING ENDPOINTS ─────────────────────────────────────────
app.get('/api/billing/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    const billing = loadClientBilling(slug);
    if (!billing) return res.json({ enabled: false });
    const cm = (billing.current_month?.month === currentMonth()) ? billing.current_month : initMonthBlock();
    const cfg = loadBillingConfig();
    res.json({
      enabled: true,
      active:  billing.active !== false,
      plan_monthly:  billing.plan_monthly || 0,
      graphics:      cm.graphics || 0,
      remaining:     billing.plan_monthly > 0 ? Math.max(0, billing.plan_monthly - cm.graphics) : null,
      month:         cm.month,
      contact_phone: cfg.contact_phone || '351 6 886262',
    });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/complete-graphic/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    const { costs } = req.body;
    const result = await recordGeneration(slug, costs || {});
    if (!result) return res.json({ enabled: false });
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: 'Error registrando generación' }); }
});

app.get('/api/admin/billing', (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'No autorizado' });

    const cfg   = loadBillingConfig();
    const rates = { usd_to_ars: cfg.usd_to_ars||1200, usd_to_eur: cfg.usd_to_eur||0.92 };
    const slugs = listClients();

    const clients = slugs.map(slug => {
      const billing = loadClientBilling(slug) || { slug, plan_monthly:30, pricing_mode:'markup', markup:4, fixed_price:{ars:3000,usd:2.5,eur:2.3}, currency_display:'ars', active:true, current_month:initMonthBlock(), history:[] };
      const md   = loadClient(slug);
      const meta = md ? parseMeta(md) : { name: slug };
      const billingM = ensureCurrentMonth({...billing});
      const cm   = billingM.current_month;
      const hist = billing.history || [];
      const allMonths = [...hist, cm];
      const totReal    = allMonths.reduce((s,m) => s+(parseFloat(m.real_cost_usd)||0), 0);
      const totCharged = allMonths.reduce((s,m) => s+(parseFloat(m.charged_usd)||0), 0);
      const totGraphics= allMonths.reduce((s,m) => s+(m.graphics||0), 0);
      return {
        slug: billing.slug, name: meta.name,
        active: billing.active !== false,
        plan_monthly: billing.plan_monthly,
        pricing_mode: billing.pricing_mode,
        markup: billing.markup,
        fixed_price: billing.fixed_price,
        currency_display: billing.currency_display,
        sale_price_usd: billing.sale_price_usd || 0,
        current_month: {
          ...cm,
          charged_ars:   Math.round((parseFloat(cm.charged_usd)||0) * rates.usd_to_ars),
          charged_eur:   parseFloat(((parseFloat(cm.charged_usd)||0) * rates.usd_to_eur).toFixed(2)),
          real_cost_ars: Math.round((parseFloat(cm.real_cost_usd)||0) * rates.usd_to_ars),
        },
        history: hist.map(m => ({
          ...m,
          charged_ars:   Math.round((parseFloat(m.charged_usd)||0) * rates.usd_to_ars),
          charged_eur:   parseFloat(((parseFloat(m.charged_usd)||0) * rates.usd_to_eur).toFixed(2)),
          real_cost_ars: Math.round((parseFloat(m.real_cost_usd)||0) * rates.usd_to_ars),
        })),
        totals: {
          graphics:       totGraphics,
          real_cost_usd:  parseFloat(totReal.toFixed(4)),
          real_cost_ars:  Math.round(totReal * rates.usd_to_ars),
          charged_usd:    parseFloat(totCharged.toFixed(4)),
          charged_ars:    Math.round(totCharged * rates.usd_to_ars),
          charged_eur:    parseFloat((totCharged * rates.usd_to_eur).toFixed(2)),
          margin_usd:     parseFloat((totCharged - totReal).toFixed(4)),
        },
      };
    });

    res.json({ clients, rates, model_prices: MODEL_PRICES, claude_model: CLAUDE_MODEL, image_models: IMAGE_MODELS });
  } catch(e) { console.error('[admin GET]', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/billing/:slug', (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { plan_monthly, pricing_mode, markup, fixed_price, currency_display, active, reset_month, sale_price_usd } = req.body;
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });

    let billing = loadClientBilling(slug) || { slug, plan_monthly:30, pricing_mode:'markup', markup:4, fixed_price:{ars:3000,usd:2.5,eur:2.3}, currency_display:'ars', active:true, current_month:initMonthBlock(), history:[] };
    billing = ensureCurrentMonth(billing);

    if (plan_monthly     != null) billing.plan_monthly     = parseInt(plan_monthly) || 0;
    if (pricing_mode     != null) billing.pricing_mode     = pricing_mode;
    if (markup           != null) billing.markup           = parseFloat(markup) || 1;
    if (fixed_price      != null) billing.fixed_price      = fixed_price;
    if (currency_display != null) billing.currency_display = currency_display;
    if (active           != null) billing.active           = Boolean(active);
    if (sale_price_usd   != null) billing.sale_price_usd   = parseFloat(sale_price_usd) || 0;

    if (reset_month) {
      if (billing.current_month && billing.current_month.graphics > 0) {
        billing.history = billing.history || [];
        billing.history.unshift(billing.current_month);
        billing.history = billing.history.slice(0, 24);
      }
      billing.current_month = initMonthBlock();
    }

    saveClientBilling(slug, billing);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/config', (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const cfg = loadBillingConfig();
    const { usd_to_ars, usd_to_eur, contact_phone, admin_password } = req.body;
    if (usd_to_ars)    cfg.usd_to_ars    = parseFloat(usd_to_ars);
    if (usd_to_eur)    cfg.usd_to_eur    = parseFloat(usd_to_eur);
    if (contact_phone) cfg.contact_phone = contact_phone;
    if (admin_password && admin_password.length >= 6) cfg.admin_password = admin_password;
    saveBillingConfig(cfg);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── CLAUDE CON RETRY ──────────────────────────────────────────
async function fetchClaude(payload, maxRetries = 3) {
  // Usar modelo configurado si no se especifica uno
  if (!payload.model) payload.model = CLAUDE_MODEL;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (r.status === 529 || r.status === 429 || data.error?.type === 'overloaded_error') {
        const waitMs = attempt * 8000;
        console.warn(`[Claude] Overloaded (intento ${attempt}/${maxRetries}), esperando ${waitMs/1000}s...`);
        if (attempt < maxRetries) { await new Promise(res => setTimeout(res, waitMs)); continue; }
        throw new Error('El servicio de IA está temporalmente saturado. Intentá en 1-2 minutos.');
      }
      if (!r.ok) throw new Error(data.error?.message || `Error Claude (${r.status})`);
      return data;
    } catch(e) {
      lastError = e;
      if (attempt < maxRetries) { await new Promise(res => setTimeout(res, attempt * 8000)); continue; }
      throw e;
    }
  }
  throw lastError;
}

// ── VALIDACIÓN DE TEXTOS ──────────────────────────────────────
function validateTextsInPrompt(ctas, fluxPrompt) {
  const missing = [];
  for (const cta of ctas) {
    const inSingleQuotes = fluxPrompt.includes(`'${cta}'`);
    const inDoubleQuotes = fluxPrompt.includes(`"${cta}"`);
    if (!inSingleQuotes && !inDoubleQuotes) missing.push(cta);
  }
  return missing;
}

// ── DIRECTOR IA (OpenAI Responses API) ────────────────────────
const CREATIVE_DIRECTOR_INSTRUCTIONS = `You are Docta Nexus Creative Director AI.
Your role is to transform commercial briefs into highly detailed visual specifications for downstream Prompt Engineering systems.
You are NOT an image generator.
You are NOT an image-model prompt generator.
You are a Creative Director, Art Director, Commercial Photographer, Paid Media Specialist and Visual Composition Architect.
Your output will be consumed by another AI system that creates the final prompt for the image generation model (Flux 2 Pro or Nano Banana Pro).
PRIMARY OBJECTIVE
Generate the richest possible visual specification.
Maximize:
* Conversion potential
* CTR
* Visual clarity
* Commercial effectiveness
* Brand consistency
* Composition quality
* Readability for future text overlays
Never prioritize artistic creativity over commercial performance.
DOCTA NEXUS STUDIO WORKFLOW
The final image will be composed using a custom rendering engine.
Elements that may be added later:
* Titles
* Headlines
* Subtitles
* Promotions
* CTA buttons
* Logos
* Product PNGs
* Decorative overlays
Therefore your responsibility is primarily:
* Environment
* Background
* Lighting
* Atmosphere
* Mood
* Depth
* Composition
* Spatial balance
* Commercial storytelling
IMAGE MODEL OPTIMIZATION RULES
Image generation models understand positive descriptions better than prohibitions.
Never describe what should NOT exist.
Always describe what SHOULD exist.
Do not use: avoid, don't, no, exclude, prevent.
Instead define desired visual conditions.
VISUAL THINKING PROCESS
Before responding internally analyze:
1. Marketing objective
2. Product category
3. Audience
4. Purchase motivation
5. Emotional triggers
6. Visual hierarchy
7. Brand perception
8. Composition requirements
9. Text safe areas
10. Conversion intent
OUTPUT FORMAT
Return valid JSON only. No explanations. No markdown. No commentary.
OUTPUT STRUCTURE
{ "marketing_objective": "", "campaign_type": "", "audience": { "demographics": "", "psychographics": "", "purchase_motivations": [] }, "creative_strategy": { "core_message": "", "emotional_trigger": "", "conversion_goal": "" }, "visual_concept": { "name": "", "description": "" }, "scene": { "environment": "", "background": "", "atmosphere": "", "storytelling": "" }, "lighting": { "style": "", "intensity": "", "direction": "", "mood": "" }, "camera": { "angle": "", "distance": "", "focal_length": "", "depth_of_field": "" }, "style": { "photography_type": "", "realism_level": "", "commercial_reference": "" }, "color_palette": { "primary": [], "secondary": [], "accent": [], "background": [] }, "composition": { "primary_focus": "", "secondary_focus": "", "visual_flow": "", "negative_space_strategy": "" }, "safe_areas": [], "background_generation": { "complexity": "", "texture_level": "", "visual_noise": "", "contrast": "" }, "brand_alignment": { "perception": "", "tone": "", "positioning": "" }, "flux_guidance": { "subject_priority": [], "scene_priority": [], "rendering_priority": [], "commercial_priority": [] } }`;

async function callCreativeDirector(briefText, textPositions, extra = {}) {
  if (!OPENAI_KEY) throw new Error('Falta OPENAI_API_KEY en las variables de entorno.');
  if (!briefText || !briefText.trim()) throw new Error('Falta el brief de texto.');

  const hasPositions = Array.isArray(textPositions) && textPositions.length > 0;
  const positionsBlock = hasPositions
    ? '\n\nFIXED TEXT ZONES (already placed by the user on the canvas — these are facts, not suggestions. ' +
      'Design environment, lighting and composition so these exact zones stay visually clean and readable; ' +
      'reflect them in "safe_areas" and in "composition.negative_space_strategy"):\n' +
      textPositions.map((tp, i) => `${i+1}. '${tp.text}' (${tp.type || 'text'}) → ${tp.position}`).join('\n')
    : '\n\nNo text zones have been placed on the canvas yet — propose sensible safe_areas based on standard ad composition best practices.';

  // Contexto del modo de diseño (qué tipo de pieza es y qué fotos hay)
  const modeBlock = buildDirectorModeBlock(extra);
  const images = Array.isArray(extra.images) ? extra.images.filter(i => i && i.data && i.mime).slice(0, 6) : [];
  const inputText = briefText.trim() + modeBlock + positionsBlock + '\n\nRespond only with a valid JSON object following the OUTPUT STRUCTURE.';
  const input = images.length
    ? [{ role: 'user', content: [{ type: 'input_text', text: inputText }, ...images.map(i => ({ type: 'input_image', image_url: 'data:' + i.mime + ';base64,' + i.data, detail: 'low' }))] }]
    : inputText;

  const startTime = Date.now();
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_KEY,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: CREATIVE_DIRECTOR_INSTRUCTIONS,
      input,
      text: { format: { type: 'json_object' } },
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Error en OpenAI Responses API');

  const outputText = (data.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => (item.content || []).filter(c => c.type === 'output_text').map(c => c.text))
    .join('');

  if (!outputText) throw new Error('El Director Creativo IA no devolvió contenido.');

  let parsed;
  try {
    parsed = JSON.parse(outputText.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error('El Director Creativo IA no devolvió JSON válido.');
  }

  // Estimar costo OpenAI (gpt-4o: $2.5/1M input, $10/1M output)
  const usage = data.usage || {};
  const costUsd = ((usage.input_tokens||0) * 2.5/1e6) + ((usage.output_tokens||0) * 10/1e6);
  const elapsedMs = Date.now() - startTime;

  return {
    json: parsed,
    usage,
    cost_usd: parseFloat(costUsd.toFixed(6)),
    elapsed_ms: elapsedMs,
    model: OPENAI_MODEL,
  };
}

function buildDirectorModeBlock(extra) {
  const mode = extra.mode || 'product';
  const n = parseInt(extra.productCount) || 0;
  if (mode === 'background') return '\n\nPIECE TYPE: the attached photo IS the final background of the ad and will NOT be regenerated. Analyze it and focus your specification on typography placement, safe areas over the photo, color treatment and overlay needs.';
  if (mode === 'ai') return '\n\nPIECE TYPE: the image will be generated 100% by AI from scratch (no product photos). Describe the full scene, subjects and atmosphere.' + (extra.subject ? '\nWHAT TO SHOW: ' + extra.subject : '');
  if (n > 1) return `\n\nPIECE TYPE: product advertisement with ${n} products (photos attached in order: product 1 … product ${n}). ALL ${n} products are the protagonists and must appear prominently with equal visual weight; design the scene, surfaces and composition to showcase all of them together.` + (extra.productLayout ? '\nPRODUCT LAYOUT FIXED BY THE USER: ' + extra.productLayout : '');
  return '\n\nPIECE TYPE: product advertisement with a single hero product (photo attached).' + (extra.productLayout ? '\nPRODUCT LAYOUT FIXED BY THE USER: ' + extra.productLayout : '');
}

// ── ENDPOINT DIRECTOR IA ──────────────────────────────────────
app.post('/api/creative-brief', async (req, res) => {
  try {
    const { brief, textPositions, mode, images, productCount, productLayout, subject } = req.body;
    const result = await callCreativeDirector(brief, textPositions, { mode, images, productCount, productLayout, subject });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GUÍA DE PROMPT SEGÚN MODELO DE IMAGEN ─────────────────────
function imageModelPromptGuide(modelKey) {
  if (modelKey === 'nano-banana-pro') return `## Your role: Art Director — Nano Banana Pro Expert

You are a specialist in digital advertising and paid media.
Your only task: analyze the inputs and generate the perfect prompt for NANO BANANA PRO (Google Gemini 3 Pro Image).

## How Nano Banana Pro works

Nano Banana Pro is a reasoning image model: it understands full natural-language instructions, not keyword lists.
When there are input photos, they are passed to it as input images, in the same order as the image index below.
- Write ONE rich descriptive paragraph, like a creative brief to a photographer: subject, scene, lighting, lens/camera, mood, composition.
- Refer to products explicitly by index: "the product shown in image 1". Instruct it to keep each product IDENTICAL to its photo (shape, label, colors, proportions) — only the scene around it changes.
- It can also EDIT an input photo: when told to keep the photo exactly as it is and only add typography, it preserves the original.
- It renders text in images with high accuracy. Describe each text with its typography (weight, case, font style, color) and exact position.

CRITICAL RULES FOR TEXT:
1. Text content goes in SINGLE QUOTES inside the sentence
2. Write the entire prompt in English — only the quoted text stays in the user's language
3. The text content itself stays EXACTLY as the user typed it — character by character, no exceptions
4. Place all text descriptions at the END of the prompt, after all visual/scene description
5. NEVER translate, paraphrase, correct spelling, change capitalization, or alter any character of user text
6. If user wrote "6 CUOTAS SIN INTERÉS · ENVÍO GRATIS" → write exactly '6 CUOTAS SIN INTERÉS · ENVÍO GRATIS'
7. If user wrote "comprá ahora" → write exactly 'comprá ahora' (preserve lowercase, accents, everything)
8. State that each text must appear once, spelled exactly as quoted, and that no other text, watermark or logo appears in the image`;

  return `## Your role: Art Director — Flux 2 Pro Expert

You are a specialist in digital advertising and paid media.
Your only task: analyze the inputs and generate the perfect prompt for FLUX 2 Pro.
When there are input photos, Flux 2 Pro receives them as reference images in the order of the image index below — refer to them as "the product from image 1", etc.

## How FLUX 2 Pro handles text in images

FLUX 2 Pro uses Mistral-3 24B as its vision-language model.
The ONLY reliable format for exact text rendering is integrating the text naturally into the scene description using SINGLE QUOTES:

  Example: "a product advertisement featuring the text 'NUEVA TEMPORADA' in bold white uppercase sans-serif at the top center"

CRITICAL RULES FOR TEXT:
1. Text content goes in SINGLE QUOTES inside the sentence — this is the native Flux 2 format
2. Write the entire prompt in English — this maximizes training data coverage
3. The text content itself stays EXACTLY as the user typed it — character by character, no exceptions
4. Place all text descriptions at the END of the prompt, after all visual/scene description
5. NEVER translate, paraphrase, correct spelling, change capitalization, or alter any character of user text
6. If user wrote "6 CUOTAS SIN INTERÉS · ENVÍO GRATIS" → write exactly '6 CUOTAS SIN INTERÉS · ENVÍO GRATIS'
7. If user wrote "comprá ahora" → write exactly 'comprá ahora' (preserve lowercase, accents, everything)`;
}

// ── COLORES PEDIDOS POR EL USUARIO ───────────────────────────
// Detecta códigos HEX en el brief/dirección creativa y arma una instrucción literal para el modelo de imagen.
function extractColorRequest(text, mode) {
  if (!text) return null;
  const hexes = [...new Set((text.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) || []).map(h => {
    h = h.toUpperCase(); return h.length === 4 ? '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h;
  }))];
  if (!hexes.length) return null;
  const quote = text.split(/(?<=[.!?\n])\s*/).filter(x => /#[0-9a-f]{3,6}/i.test(x)).join(' ').trim().slice(0, 400);
  const gradient = /degrad|gradient|gradiente|difuminad/i.test(text);
  const isBg = /fondo|background|backdrop/i.test(text) && mode !== 'background';
  let sentence;
  if (isBg && gradient && hexes.length > 1) sentence = `The entire background is a smooth gradient from ${hexes.join(' to ')}, with these exact colors clearly visible.`;
  else if (isBg) sentence = `The background color is ${hexes.join(' combined with ')}, using these exact colors.`;
  else sentence = `The color palette uses exactly ${hexes.join(' and ')} as dominant colors${gradient ? ', blended in a smooth gradient' : ''}.`;
  return { hexes, quote, sentence };
}

// ── SANEAMIENTO DEL PROMPT DE IMAGEN ─────────────────────────
// Evita textos/CTAs inventados: quita oraciones que piden texto que el usuario no escribió.
const NO_TEXT_CLAUSE = 'Clean photographic image with no lettering, buttons, badges, banners or graphic overlays anywhere in the frame.';
const TEXTISH_RE = /\b(text|texts|typography|typeface|fonts?|headlines?|titles?|subtitles?|buttons?|cta|ctas|call[ -]to[ -]action|captions?|slogans?|taglines?|lettering|wording|copy ?space|copy|banners?|signage|watermarks?|overlays?|overlaid|shop now|buy now|order now|learn more|sale|discount|price tags?|ui)\b/i;
const BUTTON_RE = /\b(buttons?|cta|ctas|call[ -]to[ -]action|shop now|buy now|order now|learn more)\b/i;
function sanitizeImagePrompt(prompt, aiTexts) {
  if (!prompt) return prompt;
  const allowed = (aiTexts || []).map(t => t.text);
  const hasButton = (aiTexts || []).some(t => t.type === 'boton');
  const sentences = String(prompt).split(/(?<=[.!?])\s+/);
  const quotedOk = sen => {
    const q = [...sen.matchAll(/'([^']{2,})'|"([^"]{2,})"/g)].map(m => m[1] || m[2]);
    return q.every(x => allowed.includes(x));
  };
  let kept;
  if (!allowed.length) {
    kept = sentences.filter(sen => !TEXTISH_RE.test(sen) && !/'[^']{2,}'|"[^"]{2,}"/.test(sen))
      .map(sen => sen.replace(/\badvertisements?\b/gi, 'commercial photograph').replace(/\ban ad\b/gi, 'a commercial photograph').replace(/\bad\b/gi, 'photograph'));
    if (kept.join(' ').length < prompt.length * 0.35) kept = sentences.filter(sen => !BUTTON_RE.test(sen) && !/'[^']{2,}'|"[^"]{2,}"/.test(sen));
    let out = kept.join(' ').trim();
    if (!out.includes(NO_TEXT_CLAUSE)) out += ' ' + NO_TEXT_CLAUSE;
    return out;
  }
  // Con textos de IA: se conservan solo los textos del usuario; fuera botones si no hay "Botón CTA"
  kept = sentences.filter(sen => {
    const mentionsAllowed = allowed.some(a => sen.includes(`'${a}'`) || sen.includes(`"${a}"`));
    if (!quotedOk(sen)) return false;
    if (!hasButton && BUTTON_RE.test(sen) && !mentionsAllowed) return false;
    return true;
  });
  let out = kept.join(' ').trim();
  out += ` The only text in the image is ${allowed.map(a => `'${a}'`).join(', ')}${hasButton ? '' : ', with no buttons'}; no other words, buttons or badges appear.`;
  return out;
}

// ── AGENTE CLAUDE ─────────────────────────────────────────────
// Tres modos de pieza:
//   product    → fotos de producto (1 a 5) integradas en una escena generada
//   background → la foto del usuario ES el fondo (solo llega acá si los textos los integra la IA)
//   ai         → imagen 100% generada, sin fotos
// targets: uno o varios formatos (Pack Meta) con sus zonas: textos, productos, espacios vacíos y logo.
const NETWORK_LABELS = {
  instagram: 'Instagram Feed (1:1)', feed_1x1: 'Square feed (1:1)',
  feed_4x5: 'Portrait feed (4:5)', stories: 'Vertical Stories/Reels (9:16)', carrusel: 'Carousel (3:4)'
};
const TEXT_LABELS = { titulo: 'Title', promo: 'Promo line', boton: 'CTA button', extra: 'Extra text' };
const WEIGHT_WORDS = { 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extra-bold', 900: 'black' };
const FONT_CATEGORY_WORDS = { sans: 'sans-serif', serif: 'serif', display: 'condensed display', script: 'script', slab: 'slab-serif', mono: 'monospace', handwriting: 'hand-drawn' };

function typographyDescription(type, st) {
  if (!st) return type === 'boton' ? 'bold sans-serif inside a rounded button' : 'bold sans-serif';
  const parts = [WEIGHT_WORDS[st.weight] || 'bold', `${st.font || 'sans-serif'}-style`, FONT_CATEGORY_WORDS[st.cat] || 'sans-serif', 'typeface'];
  if (st.upper) parts.push('in uppercase');
  if (st.color) parts.push(`colored ${st.color}`);
  let d = parts.join(' ');
  if (type === 'boton') d += `, inside a ${st.radius >= 40 ? 'pill-shaped' : st.radius > 5 ? 'rounded' : 'rectangular'} button with background ${st.btnBg || '#000000'}`;
  return d;
}

function zoneText(z) {
  if (!z) return '';
  const box = z.box ? ` (x ${z.box.x1}–${z.box.x2}%, y ${z.box.y1}–${z.box.y2}% of the frame)` : '';
  return `${z.position || 'center'}${box}`;
}

async function runAgent(opts) {
  const {
    slug, mode = 'product', logoBase64, refImageBase64, refImageMediaType,
    texts = [], textMode = 'ai', textStyles = {}, targets: rawTargets, subject = '',
    userPrompt, directorContext, imageModel, userBrief = '',
  } = opts;
  const modelKey   = resolveImageModel(imageModel);
  const modelLabel = IMAGE_MODELS[modelKey].label;
  const client = await resolveClient(slug);
  if (!client) throw new Error('Cliente ' + slug + ' no encontrado.');
  const md = client.mdContent || `# Cliente ${client.name}\n**Nombre**: ${client.name}\n**Rubro**: ${client.rubro}`;

  // Imágenes de entrada (mismo orden que recibe el modelo de imagen)
  const productPhotos = mode === 'product' ? (opts.productPhotos || []).filter(p => p && p.data && p.mime) : [];
  const bgPhoto = mode === 'background' && opts.bgPhoto && opts.bgPhoto.data ? opts.bgPhoto : null;
  const N = productPhotos.length;
  const hasRef = !!(refImageBase64 && refImageMediaType);
  const inputCount = N + (bgPhoto ? 1 : 0);

  // Textos: la IA solo los escribe si textMode === 'ai'
  const aiTexts = textMode === 'ai' ? texts.filter(t => t && t.text) : [];
  const targets = (Array.isArray(rawTargets) && rawTargets.length ? rawTargets : [{ network: opts.network || 'feed_1x1' }])
    .map(t => ({ network: NETWORK_LABELS[t.network] ? t.network : 'feed_1x1', textZones: t.textZones || [], productZones: t.productZones || [], emptyZones: t.emptyZones || [], logoZone: t.logoZone || null }));

  let imageIndexGuide = '';
  if (mode === 'product') productPhotos.forEach((_, i) => { imageIndexGuide += `- Image ${i + 1}: PRODUCT ${i + 1}\n`; });
  if (bgPhoto) imageIndexGuide += '- Image 1: BACKGROUND PHOTO (final background — keep it exactly as it is)\n';
  if (hasRef) imageIndexGuide += `- Image ${inputCount + 1}: STYLE REFERENCE — extract mood, lighting and palette (Claude only; not sent to the image model)\n`;
  if (!imageIndexGuide) imageIndexGuide = '- No input images: the scene is created from scratch.\n';

  // ── Bloque de modo ──
  let modeBlock;
  if (mode === 'product' && N === 0) {
    modeBlock = `## PRODUCT SET (products composited later)
- The real product photos will be pasted afterwards in the areas listed per format. Do NOT draw any product.
- Build the scene, surfaces, pedestals and lighting so those areas look like natural, empty places where products belong.`;
  } else if (mode === 'product') {
    modeBlock = N > 1
      ? `## PRODUCT PRIORITY RULES (${N} products — mandatory)
- ALL ${N} products are the protagonists. Every one of them must appear in the image — never omit, merge or replace any product.
- Each product is fully visible, in sharp focus, in the foreground, never cropped by the frame and never hidden behind another object.
- Each product stays IDENTICAL to its photo: same shape, proportions, colors, materials, label and printed details. Only the scene around them changes.
- Give the ${N} products equal visual weight (similar size and prominence) unless the zones below say otherwise.
- Keep the order of the photos: product 1, product 2, … (left to right, or as the zones indicate).
- Do not add extra products, duplicates or variations of them.
- Brand marks printed on the products stay as they are in the photos; do not add separate logos.`
      : `## PRODUCT RULES (single hero product)
- The product from image 1 is the hero: fully visible, in sharp focus, prominent and never cropped.
- It stays IDENTICAL to its photo: same shape, proportions, colors, label and details. Only the scene around it changes.
- Do not add extra products or duplicates. Brand marks printed on the product stay as in the photo; do not add separate logos.`;
  } else if (mode === 'background') {
    modeBlock = `## BACKGROUND PHOTO EDIT (mandatory)
- Image 1 is the FINAL photograph. The output must reproduce it exactly: same framing, people, objects, colors and lighting.
- Do not restyle, regenerate, re-light or crop the photo. The only change is adding the typography described below over it.`;
  } else {
    modeBlock = `## 100% AI IMAGE
- There are no input photos. Create the complete scene from the description below and the brand file.
- WHAT TO SHOW: ${subject || '(use the creative direction)'}`;
  }

  // ── Bloque de textos ──
  let textBlock;
  if (aiTexts.length) {
    textBlock = `## TEXTS (render inside the image)
Copy each text character by character inside single quotes. Never translate, paraphrase, fix spelling or change capitalization.
Typography for each text:
${aiTexts.map(t => `- ${TEXT_LABELS[t.type] || 'Text'} '${t.text}': ${typographyDescription(t.type, textStyles[t.type])}`).join('\n')}
The background behind each text must be calm enough for the text to be perfectly readable. No other text, watermark or logo appears in the image.`;
  } else {
    textBlock = `## NO TEXT IN THE IMAGE (strict)
The generated image is a clean photograph/illustration with zero graphic design elements: no letters, words, numbers, headlines, buttons, call-to-action, badges, banners, price tags, stickers, UI elements, signs or watermarks.
${textMode === 'app' ? 'The design tool adds all typography later. In the calm areas listed per format, describe only smooth, low-detail background (sky, wall, soft gradient, out-of-focus surface).' : ''}
PROMPT WRITING RULES FOR THIS CASE (mandatory):
- Never mention text, typography, titles, headlines, copy, buttons, CTA, call to action, banners, overlays or "space for text" in the prompt — image models draw whatever they read.
- Never call the image an "ad" or "advertisement"; describe it as a commercial/product photograph.
- If the Creative Director specification mentions CTAs, copy, headlines or text overlays, ignore those parts.
- End every prompt with this exact sentence: "${NO_TEXT_CLAUSE}"`;
  }

  // ── Composición por formato ──
  const compBlock = targets.map(t => {
    const lines = [`### ${t.network} — ${NETWORK_LABELS[t.network]}`];
    t.productZones.forEach(z => {
      if (z.mode === 'paste') lines.push(`- Product ${z.index} will be composited later at ${zoneText(z)}: leave that area as an EMPTY clean surface/pedestal that fits the scene (do NOT draw product ${z.index} anywhere).`);
      else lines.push(`- Product ${z.index} (from image ${z.index}) placed at ${zoneText(z)}, filling most of that area.`);
    });
    if (mode === 'product' && N > 0) {
      const placed = new Set(t.productZones.map(z => z.index));
      const free = productPhotos.map((_, i) => i + 1).filter(i => !placed.has(i));
      if (free.length && t.productZones.length) lines.push(`- Products ${free.join(', ')}: place them prominently in the remaining main area, with the same weight as the others.`);
    }
    if (aiTexts.length) {
      aiTexts.forEach(tx => {
        const z = t.textZones.find(q => q.type === tx.type);
        lines.push(`- Text '${tx.text}' at ${zoneText(z) || 'a readable position'}.`);
      });
    } else if (t.textZones.length) {
      lines.push(`- Keep these areas visually calm and low-detail (plain background, nothing important there): ${t.textZones.map(zoneText).join('; ')}.`);
    }
    t.emptyZones.forEach(z => lines.push(`- Keep ${zoneText(z)} EMPTY: plain background only, no objects or products.`));
    if (t.logoZone) lines.push(`- Keep ${zoneText(t.logoZone)} calm and low-detail.`);
    if (t.network === 'stories') lines.push('- Vertical 9:16: the top 14% and bottom 20% are covered by the app interface — keep important elements in the middle band.');
    return lines.join('\n');
  }).join('\n\n');

  // Pedidos literales del usuario (colores HEX, etc.) — mandan sobre la ficha de marca y el Director
  const colorReq = extractColorRequest([userBrief, userPrompt, subject].filter(Boolean).join('\n'), mode);
  const userBlock = (userBrief ? `\n\n## Original user brief (its explicit requests are MANDATORY)\n"${userBrief}"` : '') +
    (colorReq ? `\n\n## USER COLOR REQUIREMENTS — highest priority (override the brand file and the Creative Director palette)
The user explicitly asked: "${colorReq.quote}"
- Use exactly these colors: ${colorReq.hexes.join(', ')}. Write each HEX code literally in EVERY prompt.
- ${colorReq.sentence}
- Do not replace them with brand colors or with other hues.` : '');
  const directorBlock = directorContext
    ? `\n\n## Creative Director AI Specification (USE THIS AS YOUR PRIMARY VISUAL GUIDE)\n\n${JSON.stringify(directorContext, null, 2)}\n`
    : '';

  const promptKeys = targets.map(t => `"${t.network}": "THE COMPLETE PROMPT FOR ${modelLabel.toUpperCase()} IN THIS FORMAT"`).join(', ');
  const system = md + directorBlock + `

---

${imageModelPromptGuide(modelKey)}

## Image reference index
${imageIndexGuide}
${hasRef ? `The style reference image: extract its color palette, lighting mood and aesthetic and apply them to the scene.` : ''}

${modeBlock}

${textBlock}

## Logo rule
${logoBase64 ? `A logo will be composited AFTER ${modelLabel} generates the image — never mention it in the prompt. Only choose logo_position.` : 'No separate logo is added.'}
${userBlock}
${userPrompt ? `\n## User creative direction\nIntegrate this naturally into the scene: "${userPrompt}"` : ''}

## Output format
Write one prompt per format (they share the same scene, light and products; only the composition adapts to each aspect ratio).
Each prompt: one coherent paragraph in English — subject + scene + lighting + photography style + camera + composition for that format${aiTexts.length ? ", then one sentence per text at the end: featuring the text 'EXACT TEXT' in [typography] at [position]" : ''}.
Respond ONLY with valid JSON (no markdown, no backticks):
{
  "analysis": { "subject": "", "style": "", "colors": "", "mood": "", "lighting": "" },
  "image_prompts": { ${promptKeys} },
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "brief composition description"
}`;

  const msg =
    `AD BRIEF\n` +
    `Mode: ${mode}\n` +
    `Formats: ${targets.map(t => t.network).join(', ')}\n` +
    (mode === 'product' ? `Products in shoot: ${N} (ALL must appear)\n` : '') +
    `Image model: ${modelLabel}\n` +
    `Texts inside the image: ${aiTexts.length ? aiTexts.map(t => `'${t.text}'`).join(', ') : 'NONE'}\n` +
    `\nCOMPOSITION PER FORMAT:\n${compBlock}\n` +
    `\nImage index:\n${imageIndexGuide}` +
    (directorContext ? `\nIMPORTANT: every prompt MUST reflect the Creative Director AI visual direction.` : '') +
    (userPrompt ? `\n\nCreative direction from user: ${userPrompt}` : '');

  const content = [];
  productPhotos.forEach(p => content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
  if (bgPhoto) content.push({ type: 'image', source: { type: 'base64', media_type: bgPhoto.mime, data: bgPhoto.data } });
  if (hasRef) content.push({ type: 'image', source: { type: 'base64', media_type: refImageMediaType, data: refImageBase64 } });
  content.push({ type: 'text', text: msg });

  const ctas = aiTexts.map(t => t.text);
  let lastResult = null;
  let tokensIn = 0, tokensOut = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const warningPrefix = attempt > 1
      ? `⚠ ATTEMPT ${attempt}/3: in the previous attempt these texts were missing or altered in some prompt: ${JSON.stringify(lastResult?._missing || [])}. Rebuild every prompt placing each text VERBATIM inside single quotes at the end.\n\n`
      : '';
    const data = await fetchClaude({
      model: CLAUDE_MODEL,
      max_tokens: 1200 + 900 * targets.length,
      system,
      messages: [{ role: 'user', content: attempt > 1 ? [...content.slice(0, -1), { type: 'text', text: warningPrefix + msg }] : content }]
    });
    const usage = data.usage || {};
    tokensIn += usage.input_tokens || 0; tokensOut += usage.output_tokens || 0;
    const text = data.content.map(b => b.text || '').join('');
    let result;
    try { result = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { throw new Error('El agente no devolvió JSON válido. Intentá de nuevo.'); }

    // Normalizar: un prompt por formato
    let prompts = result.image_prompts && typeof result.image_prompts === 'object' ? result.image_prompts : {};
    const single = result.image_prompt || result.flux_prompt;
    targets.forEach(t => { if (!prompts[t.network]) prompts[t.network] = single || Object.values(prompts)[0] || ''; });
    // Red de seguridad: el modelo de imagen dibuja todo lo que lee (p. ej. inventa un botón "Shop Now")
    targets.forEach(t => { prompts[t.network] = sanitizeImagePrompt(prompts[t.network], aiTexts); });
    // Garantía: si el prompt perdió algún color pedido, se agrega la instrucción literal
    if (colorReq) targets.forEach(t => {
      const pr = prompts[t.network] || '';
      if (colorReq.hexes.some(h => !pr.toUpperCase().includes(h))) prompts[t.network] = pr.replace(/\s*$/, ' ') + colorReq.sentence;
    });
    result.image_prompts = prompts;
    result.image_prompt = prompts[targets[0].network];
    result.flux_prompt = result.image_prompt; // compat
    result.image_model = modelKey;
    result._tokens_analysis = { model: CLAUDE_MODEL, input_tokens: tokensIn, output_tokens: tokensOut };

    const missing = [...new Set(targets.flatMap(t => validateTextsInPrompt(ctas, prompts[t.network] || '')))];
    if (missing.length === 0) return result;
    console.warn(`[agent] Intento ${attempt} — textos faltantes/alterados: ${JSON.stringify(missing)}`);
    result._missing = missing;
    lastResult = result;
  }
  return lastResult;
}

function billingBlockedResponse(res, billingCheck) {
  const cfg = loadBillingConfig();
  return res.status(403).json({
    error: 'billing_limit',
    reason: billingCheck.reason,
    message: billingCheck.reason === 'limit_reached'
      ? `Alcanzaste el límite de ${billingCheck.billing.plan_monthly} gráficas de este mes. Contactanos para continuar.`
      : 'Tu cuenta está pausada. Contactanos para reactivarla.',
    plan_monthly: billingCheck.billing?.plan_monthly,
    contact_phone: cfg.contact_phone || '351 6 886262',
  });
}

// ── ENDPOINT ANALIZAR ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const b = req.body || {};
    const mode = ['product', 'background', 'ai'].includes(b.mode) ? b.mode : 'product';
    if (!b.slug) return res.status(400).json({ error: 'Falta el cliente.' });
    // Compatibilidad con el front anterior (imageBase64 + extraPhotos)
    let productPhotos = Array.isArray(b.productPhotos) ? b.productPhotos : [];
    if (!productPhotos.length && b.imageBase64) productPhotos = [{ data: b.imageBase64, mime: b.imageMediaType || 'image/jpeg' }, ...(b.extraPhotos || [])];
    const hasPaste = (b.targets || []).some(t => (t.productZones || []).some(z => z.mode === 'paste'));
    if (mode === 'product' && !productPhotos.length && !hasPaste) return res.status(400).json({ error: 'Subí al menos una foto de producto.' });
    if (mode === 'background' && !b.bgPhoto?.data) return res.status(400).json({ error: 'Subí la foto de fondo.' });
    let texts = Array.isArray(b.texts) ? b.texts : [];
    if (!texts.length && Array.isArray(b.ctas)) texts = b.ctas.map((t, i) => ({ type: ['titulo', 'promo', 'boton'][i] || 'extra', text: t }));

    const billingCheck = checkBillingLimit(b.slug);
    if (!billingCheck.ok) return billingBlockedResponse(res, billingCheck);

    const result = await runAgent({ ...b, mode, productPhotos, texts });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPLICATE: creación en cola con reintento por límite de uso (429) ──
// Con poco crédito Replicate permite ~6 creaciones por minuto y de a una (burst 1).
// Las creaciones van de a una y, si Replicate responde 429, se espera lo que indica y se reintenta.
let replicateQueue = Promise.resolve();
function createPrediction(modelPath, input) {
  const job = replicateQueue.then(async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const r = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input })
      });
      const data = await r.json().catch(() => ({}));
      if (r.status !== 429 || attempt === 10) return { r, data };
      const hdr = parseFloat(r.headers?.get?.('retry-after'));
      const m = /~?(\d+(?:\.\d+)?)\s*s/.exec(String(data.detail || ''));
      const waitS = (hdr > 0 ? hdr : m ? parseFloat(m[1]) : 10) + 1;
      console.warn(`[replicate] 429 límite de uso — reintento ${attempt} en ${waitS}s`);
      await new Promise(res => setTimeout(res, waitS * 1000));
    }
  });
  replicateQueue = job.catch(() => {});
  return job;
}

// ── ENDPOINT GENERAR IMAGEN ───────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, aspect_ratio, network, imageBase64, imageMediaType, extraPhotos, inputImages: inImgs, imageModel } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });
    const modelKey = resolveImageModel(imageModel);
    const model    = IMAGE_MODELS[modelKey];
    const ar = aspect_ratio || ASPECT_RATIOS[network] || '1:1';

    let finalPrompt = prompt;
    try {
      const parsed = JSON.parse(prompt);
      if (parsed.image_prompt || parsed.flux_prompt) finalPrompt = parsed.image_prompt || parsed.flux_prompt;
    } catch { /* prompt en texto plano */ }

    // Imágenes de entrada, en el mismo orden que el índice del agente
    const inputImages = [];
    if (Array.isArray(inImgs)) inImgs.forEach(p => { if (p && p.data && p.mime) inputImages.push('data:' + p.mime + ';base64,' + p.data); });
    else {
      if (imageBase64 && imageMediaType) inputImages.push('data:' + imageMediaType + ';base64,' + imageBase64);
      if (Array.isArray(extraPhotos)) extraPhotos.forEach(p => { if (p.data && p.mime) inputImages.push('data:' + p.mime + ';base64,' + p.data); });
    }
    const input = buildImageInput(modelKey, finalPrompt, ar, inputImages);
    console.log(`[image:${modelKey}] ${ar} · ${inputImages.length} img · prompt:`, finalPrompt.slice(0, 160));

    const { r, data } = await createPrediction(model.replicate, input);
    if (!r.ok) return res.status(r.status).json({ error: data.detail || `Error Replicate (${model.label})` });
    data._image_model = modelKey;
    data._image_model_label = model.label;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUGERIR UBICACIÓN Y COLORES DE TEXTOS (modo foto de fondo) ──
app.post('/api/suggest-layout', async (req, res) => {
  try {
    const { slug, image, network, texts } = req.body || {};
    if (!image?.data) return res.status(400).json({ error: 'Falta la imagen.' });
    const client = slug ? resolveClient(slug) : null;
    const fields = (Array.isArray(texts) ? texts : []).filter(t => t && t.type);
    const prompt = `You are an art director laying out a social media ad over the attached photo (format ${NETWORK_LABELS[network] || network}).
Brand: ${client?.name || ''}. Brand colors: primary ${client?.colorPrimary || ''}, accent ${client?.colorAccent || ''}.
Text fields to place: ${fields.map(t => `${t.type}${t.text ? ` ("${t.text}")` : ''}`).join(', ') || 'titulo, promo, boton'}.
Find the calmest areas of the photo (sky, walls, plain surfaces, out-of-focus zones) and place each field there without covering faces, people or the main subject.
${network === 'stories' ? 'Vertical 9:16: keep all boxes between y=0.14 and y=0.80.' : ''}
Typical sizes: titulo wide and tall enough for 1–2 big lines; promo one line under the title; boton a compact button; extra a thin line.
Pick text colors with strong contrast against the area behind each box, using brand colors when they work.
Respond ONLY with JSON (no markdown):
{"zones":{"titulo":{"x":0.08,"y":0.06,"w":0.84,"h":0.15},"promo":{...},"boton":{...},"extra":{...}},"colors":{"titulo":"#ffffff","promo":"#ffffff","boton_bg":"#000000","boton_text":"#ffffff","extra":"#ffffff"},"overlay":0,"note":"one short sentence in Spanish"}
All coordinates are fractions 0–1 of the frame (x,y = top-left). overlay = darkening % (0–60) needed for readability. Only include zones for the requested fields.`;
    const data = await fetchClaude({
      model: CLAUDE_MODEL, max_tokens: 700,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.mime || 'image/jpeg', data: image.data } }, { type: 'text', text: prompt }] }]
    });
    const txt = data.content.map(b => b.text || '').join('');
    const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    const usage = data.usage || {};
    out.cost_usd = parseFloat(calcClaudeCost(CLAUDE_MODEL, usage.input_tokens || 0, usage.output_tokens || 0).toFixed(6));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIPOGRAFÍA POR CLIENTE ─────────────────────────────────────
// clients/<slug>.styles.json = { fields: { titulo:{...}, ... }, fonts: [{ id, name, file }] }
const FONT_EXTS = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const validSlug = s => !!s && /^[a-z0-9_-]+$/i.test(s);
function stylesPath(slug) { return path.join(__dirname, 'clients', slug + '.styles.json'); }
function loadClientStyles(slug) {
  try { return fs.existsSync(stylesPath(slug)) ? JSON.parse(fs.readFileSync(stylesPath(slug), 'utf8')) : { fields: null, fonts: [] }; }
  catch { return { fields: null, fonts: [] }; }
}
function saveClientStyles(slug, data) { fs.writeFileSync(stylesPath(slug), JSON.stringify(data, null, 2)); }

app.get('/api/client-style/:slug', (req, res) => {
  const { slug } = req.params;
  if (!validSlug(slug)) return res.status(400).json({ error: 'Slug inválido' });
  const st = loadClientStyles(slug);
  res.json({ fields: st.fields || null, fonts: (st.fonts || []).map(f => ({ id: f.id, name: f.name, url: `/api/client-font/${slug}/${f.id}` })) });
});

app.post('/api/client-style/:slug', (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Contraseña de administrador incorrecta.' });
    const { slug } = req.params;
    if (!validSlug(slug) || !loadClient(slug)) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const fields = req.body?.fields;
    if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'Faltan los estilos.' });
    const st = loadClientStyles(slug);
    st.fields = fields;
    saveClientStyles(slug, st);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client-font/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!validSlug(slug) || !loadClient(slug)) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const { name, filename, data } = req.body || {};
    const ext = String(filename || '').split('.').pop().toLowerCase();
    if (!FONT_EXTS[ext]) return res.status(400).json({ error: 'Formato no admitido. Usá TTF, OTF, WOFF o WOFF2.' });
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length || buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'La fuente debe pesar menos de 3 MB.' });
    const cleanName = String(name || filename).replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Fuente de marca';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = path.join(__dirname, 'clients', 'fonts', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.' + ext), buf);
    const st = loadClientStyles(slug);
    st.fonts = (st.fonts || []).filter(f => f.name !== cleanName);
    st.fonts.push({ id, name: cleanName, file: id + '.' + ext });
    saveClientStyles(slug, st);
    res.json({ ok: true, font: { id, name: cleanName, url: `/api/client-font/${slug}/${id}` } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/client-font/:slug/:id', (req, res) => {
  const { slug, id } = req.params;
  if (!validSlug(slug) || !/^[a-z0-9]+$/i.test(id)) return res.status(400).end();
  const f = (loadClientStyles(slug).fonts || []).find(x => x.id === id);
  if (!f) return res.status(404).end();
  const fp = path.join(__dirname, 'clients', 'fonts', slug, f.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.type(FONT_EXTS[f.file.split('.').pop()] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(fp);
});

app.get('/api/poll/:id', async (req, res) => {
  try {
    const r = await fetch('https://api.replicate.com/v1/predictions/' + req.params.id, {
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FETCH PRODUCTO ────────────────────────────────────────────
app.post('/api/fetch-product', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Falta la URL.' });
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DoctaNexusStudio/1.0)' } });
    if (!r.ok) return res.status(r.status).json({ error: 'No se pudo acceder a la URL.' });
    const html = await r.text();
    const prompt = `Analizá este HTML de una página de producto de ecommerce y extraé:\n1. Nombre del producto\n2. Precio (con moneda y cuotas si las hay)\n3. Descripción breve (máximo 150 palabras)\n\nHTML:\n${html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,4000)}\n\nRespondé ÚNICAMENTE con JSON válido (sin markdown):\n{"name":"","price":"","description":""}`;
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const ad = await ar.json();
    if (!ar.ok) throw new Error(ad.error?.message || 'Error Claude');
    const parsed = JSON.parse(ad.content.map(b => b.text||'').join('').replace(/```json|```/g,'').trim());
    res.json({ ...parsed, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VIDEO ─────────────────────────────────────────────────────
app.post('/api/generate-video', async (req, res) => {
  try {
    const { imageBase64, imageUrl, prompt, duration } = req.body;
    if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'Falta la imagen.' });
    let finalImageUrl = imageUrl;
    if (!finalImageUrl && imageBase64) {
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const uploadRes = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN, 'Content-Type': 'image/jpeg', 'Content-Length': imgBuffer.length },
        body: imgBuffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) return res.status(uploadRes.status).json({ error: uploadData.detail || 'Error subiendo imagen' });
      finalImageUrl = uploadData.urls?.get || uploadData.url;
      if (!finalImageUrl) return res.status(500).json({ error: 'No se obtuvo URL de la imagen' });
    }
    const r = await fetch('https://api.replicate.com/v1/models/kwaivgi/kling-v2.1/predictions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN, 'Content-Type': 'application/json', 'Prefer': 'wait=10' },
      body: JSON.stringify({ input: {
        prompt: prompt || 'cinematic product advertisement, smooth slow camera movement, professional commercial quality',
        start_image: finalImageUrl, duration: duration || 5, aspect_ratio: '1:1',
        negative_prompt: 'blur, distortion, watermark, low quality',
        cfg_scale: 0.5,
      }})
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail || 'Error Replicate video' });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/poll-video/:id', async (req, res) => {
  try {
    const r = await fetch('https://api.replicate.com/v1/predictions/' + req.params.id, { headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), model_claude: CLAUDE_MODEL, model_openai: OPENAI_MODEL, image_models: Object.keys(IMAGE_MODELS), default_image_model: DEFAULT_IMAGE_MODEL, version: '4.0.0' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio v4 — Foto producto / Foto de fondo / 100% IA · Pack Meta');
  console.log('  Modelo de imagen por defecto: ' + IMAGE_MODELS[DEFAULT_IMAGE_MODEL].label);
  console.log('  http://localhost:' + PORT);
  console.log('  Modelo Claude: ' + CLAUDE_MODEL);
  console.log('  Modelo OpenAI: ' + OPENAI_MODEL);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
