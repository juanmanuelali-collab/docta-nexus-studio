require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SUPA_URL        = process.env.SUPABASE_URL;
const SUPA_KEY        = process.env.SUPABASE_SERVICE_KEY;

const ASPECT_RATIOS = {
  instagram: '1:1', instagram_stories: '9:16',
  linkedin: '16:9', facebook: '4:5',
  feed_1x1: '1:1', feed_4x5: '4:5',
  stories: '9:16', carrusel: '3:4'
};

// ── SUPABASE ──────────────────────────────────────────────────
let supabase = null;
function getDB() {
  if (!supabase) {
    if (!SUPA_URL || !SUPA_KEY) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY');
    supabase = createClient(SUPA_URL, SUPA_KEY);
  }
  return supabase;
}

// ── CLIENTE MD ────────────────────────────────────────────────
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

// ── BILLING: PRECIOS ──────────────────────────────────────────
const MODEL_PRICES = {
  'claude-opus-4-5':           { input: 15.00/1e6, output: 75.00/1e6 },
  'claude-sonnet-4-20250514':  { input:  3.00/1e6, output: 15.00/1e6 },
  'claude-haiku-4-5-20251001': { input:  0.80/1e6, output:  4.00/1e6 },
};
const FLUX_COST_PER_SECOND = 0.0032;

function calcClaudeCost(model, inputTok, outputTok) {
  const p = MODEL_PRICES[model] || MODEL_PRICES['claude-sonnet-4-20250514'];
  return (inputTok * p.input) + (outputTok * p.output);
}

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

// ── BILLING: SUPABASE ─────────────────────────────────────────
async function loadBillingConfig() {
  try {
    const { data } = await getDB().from('studio_billing_config').select('data').eq('key','global').single();
    return data?.data || { admin_password:'docta2024', contact_phone:'351 6 886262', usd_to_ars:1200, usd_to_eur:0.92 };
  } catch { return { admin_password:'docta2024', contact_phone:'351 6 886262', usd_to_ars:1200, usd_to_eur:0.92 }; }
}

async function saveBillingConfig(cfg) {
  await getDB().from('studio_billing_config').upsert({ key:'global', data:cfg, updated_at: new Date().toISOString() }, { onConflict:'key' });
}

async function loadClientBilling(slug) {
  try {
    const { data } = await getDB().from('studio_billing').select('*').eq('slug', slug).single();
    return data || null;
  } catch { return null; }
}

async function loadCurrentMonth(slug) {
  try {
    const { data } = await getDB().from('studio_billing_current').select('*').eq('slug', slug).single();
    return data || null;
  } catch { return null; }
}

async function saveCurrentMonth(slug, monthData) {
  await getDB().from('studio_billing_current').upsert({
    slug,
    month:         monthData.month,
    graphics:      monthData.graphics,
    calls:         monthData.calls,
    real_cost_usd: monthData.real_cost_usd,
    charged_usd:   monthData.charged_usd,
    detail:        monthData.detail,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'slug' });
}

async function archiveMonth(slug, monthData) {
  await getDB().from('studio_billing_history').upsert({
    slug,
    month:         monthData.month,
    graphics:      monthData.graphics,
    calls:         monthData.calls,
    real_cost_usd: monthData.real_cost_usd,
    charged_usd:   monthData.charged_usd,
    detail:        monthData.detail,
  }, { onConflict: 'slug,month' });
}

function initMonthBlock() {
  return { month: currentMonth(), graphics: 0, calls: { claude_analysis:0, flux_image:0 }, real_cost_usd:0, charged_usd:0, detail:[] };
}

async function ensureCurrentMonthDB(slug) {
  const cm = currentMonth();
  let monthData = await loadCurrentMonth(slug);
  if (!monthData || monthData.month !== cm) {
    // Archivar mes anterior si tiene datos
    if (monthData && monthData.graphics > 0) await archiveMonth(slug, monthData);
    monthData = initMonthBlock();
    await saveCurrentMonth(slug, monthData);
  }
  return monthData;
}

async function checkBillingLimit(slug) {
  try {
    const billing = await loadClientBilling(slug);
    if (!billing) return { ok: true };
    if (billing.active === false) return { ok: false, reason: 'inactive', billing };
    const monthData = await ensureCurrentMonthDB(slug);
    if (billing.plan_monthly > 0 && monthData.graphics >= billing.plan_monthly)
      return { ok: false, reason: 'limit_reached', billing, monthData };
    return { ok: true };
  } catch(e) {
    console.error('[billing check]', e.message);
    return { ok: true }; // Si falla, no bloquear
  }
}

async function recordGeneration(slug, costs) {
  try {
    const db = getDB();
    let billing = await loadClientBilling(slug);
    if (!billing) {
      // Auto-crear con defaults
      await db.from('studio_billing').upsert({
        slug, plan_monthly: 30, pricing_mode: 'markup', markup: 4,
        fixed_price: { ars:3000, usd:2.5, eur:2.3 }, currency_display: 'ars', active: true,
      }, { onConflict: 'slug' });
      billing = await loadClientBilling(slug);
    }

    const cfg = await loadBillingConfig();
    const monthData = await ensureCurrentMonthDB(slug);

    // Calcular costos reales
    const realCost = {
      claude_analysis: costs.claude_analysis ? calcClaudeCost(costs.claude_analysis.model, costs.claude_analysis.input_tokens||0, costs.claude_analysis.output_tokens||0) : 0,
      flux_image:      costs.flux            ? (costs.flux.seconds||15) * FLUX_COST_PER_SECOND : 0,
    };
    const totalReal = Object.values(realCost).reduce((a,v) => a+v, 0);

    let charged = 0;
    if      (billing.pricing_mode === 'markup') charged = totalReal * (billing.markup || 1);
    else if (billing.pricing_mode === 'fixed')  charged = billing.fixed_price?.usd || 0;

    // Actualizar mes actual
    monthData.graphics      += 1;
    monthData.calls.claude_analysis = (monthData.calls.claude_analysis||0) + (costs.claude_analysis ? 1 : 0);
    monthData.calls.flux_image      = (monthData.calls.flux_image||0)      + (costs.flux ? 1 : 0);
    monthData.real_cost_usd  = parseFloat(((monthData.real_cost_usd||0) + totalReal).toFixed(6));
    monthData.charged_usd    = parseFloat(((monthData.charged_usd||0) + charged).toFixed(6));

    monthData.detail = monthData.detail || [];
    monthData.detail.push({ date: new Date().toISOString(), real_cost_usd: parseFloat(totalReal.toFixed(6)), breakdown: realCost, charged_usd: parseFloat(charged.toFixed(6)) });
    if (monthData.detail.length > 200) monthData.detail = monthData.detail.slice(-200);

    await saveCurrentMonth(slug, monthData);

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

// ── CLIENT ENDPOINTS ──────────────────────────────────────────
app.get('/api/client/:slug', (req, res) => {
  const md = loadClient(req.params.slug);
  if (!md) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ slug: req.params.slug, ...parseMeta(md) });
});

app.get('/api/clients', (req, res) => {
  res.json(listClients().map(slug => ({ slug, ...parseMeta(loadClient(slug)) })));
});

// ── BILLING ENDPOINTS ─────────────────────────────────────────
app.get('/api/billing/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    const billing = await loadClientBilling(slug);
    if (!billing) return res.json({ enabled: false });
    const monthData = await ensureCurrentMonthDB(slug);
    const cfg = await loadBillingConfig();
    res.json({
      enabled: true,
      active:  billing.active !== false,
      plan_monthly:  billing.plan_monthly || 0,
      graphics:      monthData.graphics || 0,
      remaining:     billing.plan_monthly > 0 ? Math.max(0, billing.plan_monthly - monthData.graphics) : null,
      month:         monthData.month,
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

app.get('/api/admin/billing', async (req, res) => {
  try {
    const { password } = req.query;
    const cfg = await loadBillingConfig();
    if (!password || password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });

    const { data: billings } = await getDB().from('studio_billing').select('*');
    const { data: currents } = await getDB().from('studio_billing_current').select('*');
    const { data: histories } = await getDB().from('studio_billing_history').select('*');
    const rates = { usd_to_ars: cfg.usd_to_ars||1200, usd_to_eur: cfg.usd_to_eur||0.92 };

    const clients = (billings || []).map(billing => {
      const md = loadClient(billing.slug);
      const meta = md ? parseMeta(md) : { name: billing.slug };
      const cm = currents?.find(c => c.slug === billing.slug) || initMonthBlock();
      const hist = (histories || []).filter(h => h.slug === billing.slug);
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

    res.json({ clients, rates, model_prices: MODEL_PRICES });
  } catch(e) { console.error('[admin GET]', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/billing/:slug', async (req, res) => {
  try {
    const cfg = await loadBillingConfig();
    const { password, plan_monthly, pricing_mode, markup, fixed_price, currency_display, active, reset_month } = req.body;
    if (!password || password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });

    const update = {};
    if (plan_monthly     != null) update.plan_monthly     = parseInt(plan_monthly) || 0;
    if (pricing_mode     != null) update.pricing_mode     = pricing_mode;
    if (markup           != null) update.markup           = parseFloat(markup) || 1;
    if (fixed_price      != null) update.fixed_price      = fixed_price;
    if (currency_display != null) update.currency_display = currency_display;
    if (active           != null) update.active           = Boolean(active);
    update.updated_at = new Date().toISOString();

    await getDB().from('studio_billing').upsert({ slug, ...update }, { onConflict: 'slug' });

    if (reset_month) {
      const monthData = await loadCurrentMonth(slug);
      if (monthData && monthData.graphics > 0) await archiveMonth(slug, monthData);
      await saveCurrentMonth(slug, initMonthBlock());
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/config', async (req, res) => {
  try {
    const cfg = await loadBillingConfig();
    const { password, usd_to_ars, usd_to_eur, contact_phone, admin_password } = req.body;
    if (!password || password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });
    if (usd_to_ars)    cfg.usd_to_ars    = parseFloat(usd_to_ars);
    if (usd_to_eur)    cfg.usd_to_eur    = parseFloat(usd_to_eur);
    if (contact_phone) cfg.contact_phone = contact_phone;
    if (admin_password && admin_password.length >= 6) cfg.admin_password = admin_password;
    await saveBillingConfig(cfg);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── CLAUDE CON RETRY ──────────────────────────────────────────
async function fetchClaude(payload, maxRetries = 3) {
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
// Cambio 8: verifica que cada texto del usuario esté intacto en el prompt generado
function validateTextsInPrompt(ctas, backgroundPrompt) {
  const missing = [];
  for (const cta of ctas) {
    // Busca el texto exacto dentro de comillas en el prompt
    if (!backgroundPrompt.includes(`"${cta}"`)) {
      missing.push(cta);
    }
  }
  return missing;
}

// ── AGENTE CLAUDE ─────────────────────────────────────────────
async function runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network }) {
  const md = loadClient(slug);
  if (!md) throw new Error('Cliente ' + slug + ' no encontrado.');

  const networkLabels = {
    instagram: 'Instagram Feed (1:1)', feed_1x1: 'Instagram/Facebook Feed Cuadrado (1:1)',
    feed_4x5: 'Feed Vertical (4:5)', stories: 'Stories/Reels (9:16)', carrusel: 'Carrusel (3:4)'
  };

  const hasRef    = !!(refImageBase64 && refImageMediaType);
  const hasExtras = Array.isArray(extraPhotos) && extraPhotos.length > 0;
  const totalPhotos = 1 + (hasExtras ? extraPhotos.length : 0);

  // Construir lista de índices de imágenes para que Claude pueda referenciarlas
  let imageIndexGuide = '- Image 1: MAIN PRODUCT\n';
  if (hasExtras) extraPhotos.forEach((_, i) => { imageIndexGuide += `- Image ${i+2}: PRODUCT ${i+2}\n`; });
  if (hasRef)    imageIndexGuide += `- Image ${totalPhotos + 1}: STYLE REFERENCE — extract mood, lighting and palette\n`;

  const system = md + `

---

## Tu rol: Director de Arte — Flux 2 Pro Expert

Sos un director de arte especializado en publicidad digital y paid media.
Tu única tarea: analizar las fotos del producto y generar el prompt perfecto para FLUX.2 Pro en formato JSON estructurado.

## Cómo funciona FLUX.2 Pro

Flux 2 Pro usa un modelo de lenguaje visual (Mistral-3 24B). Acepta prompts en formato JSON estructurado para máximo control sobre la composición.

### Referencia de imágenes por índice
Cuando tenés múltiples imágenes, podés referenciarlas por número:
- "Use the product from image 1 as the main subject"
- "Apply the lighting style from image ${totalPhotos + 1}"
- "Place product from image 2 to the right of image 1"

Imágenes disponibles en esta generación:
${imageIndexGuide}

## Formato JSON del prompt (OBLIGATORIO)

El campo background_prompt debe ser un JSON stringificado con esta estructura:

{
  "scene": "descripción del ambiente y entorno donde está el producto",
  "subjects": "descripción exacta del/los producto/s — forma, acabado, color, posición relativa. Si hay múltiples, usá referencias por índice: 'product from image 1 centered, product from image 2 to the right'",
  "style": "estilo fotográfico o artístico — ej: editorial product photography, minimalist lifestyle, etc.",
  "lighting": "tipo de iluminación — ej: soft diffused studio light from left, warm golden hour, rim lighting",
  "camera": "especificaciones de cámara — ej: shot on Hasselblad X2D, 85mm f/1.8, shallow depth of field",
  "color_palette": "colores exactos con HEX — ej: deep navy #0A1628 background, warm gold #C9A84C accents",
  "user_intent": "instrucción creativa del usuario integrada aquí — RESPETAR LITERALMENTE",
  "texts": [
    { "content": "texto exacto 1", "style": "bold white serif title", "position": "upper center area" },
    { "content": "texto exacto 2", "style": "gold rounded badge", "position": "lower right corner" }
  ]
}

## REGLA ABSOLUTA — TEXTOS SAGRADOS

Los textos del usuario son INMUTABLES. JAMÁS modificar, corregir, traducir ni alterar ni un solo carácter.
Cada texto debe aparecer EXACTAMENTE entre comillas dobles en el campo "content".

Los MANDATORY TEXT en el prompt final de Flux deben seguir este formato:
MANDATORY TEXT: render exact text "[texto exacto]" as [estilo], [posición]

## Instrucción creativa del usuario

${userPrompt ? `El usuario agregó esta instrucción creativa: "${userPrompt}"
Esta instrucción va en el campo "user_intent" del JSON y debe integrarse naturalmente en la composición.
NO ignorarla — tiene el mismo peso que los campos estructurados.` : 'No hay instrucción creativa adicional del usuario.'}

## Múltiples productos

${totalPhotos > 1 ? `Tenés ${totalPhotos} productos. Referencialos por índice ("product from image 1", "product from image 2") y describí cómo aparecen juntos en la escena.` : 'Un solo producto. Describilo con precisión.'}

## Imagen de referencia de estilo

${hasRef ? `HAY imagen de referencia (image ${totalPhotos + 1}). Extraé paleta cromática, tipo de iluminación, mood y estética. Integralo en el JSON.` : 'Sin imagen de referencia.'}

## Logo

${logoBase64 ?
`El logo se superpone en post-proceso. NO incluirlo en el prompt de Flux.
Solo indicá logo_position: top-left, top-right, bottom-left o bottom-right.` :
`Sin logo configurado.`}

Respondé ÚNICAMENTE con JSON válido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripción del producto/s",
    "style": "estilo visual detectado",
    "colors": "paleta de colores",
    "mood": "tono emocional",
    "lighting": "iluminación detectada"
  },
  "background_prompt": "{JSON stringificado con la estructura definida arriba}",
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripción de la composición final"
}`;

  const msg = 'Instrucción creativa del usuario: ' + (userPrompt || 'No especificada') + '\n' +
    'TEXTOS A INTEGRAR — EXACTOS E INMUTABLES — JAMÁS ALTERAR NI UN CARÁCTER:\n' +
    ctas.map((c, i) => `  - Texto ${i+1}: "${c}"`).join('\n') + '\n' +
    'Red social: ' + (networkLabels[network] || 'Feed') + '\n' +
    'Cantidad de productos: ' + totalPhotos + '\n' +
    'Logo del cliente: ' + (logoBase64 ? 'SÍ — se superpone en post-proceso, NO incluir en prompt de Flux' : 'NO') + '\n' +
    'Imagen de referencia: ' + (hasRef ? 'Sí' : 'No') + '\n\n' +
    'Índice de imágenes adjuntas:\n' + imageIndexGuide;

  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }
  ];
  if (hasExtras) extraPhotos.forEach(p => content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
  if (hasRef)    content.push({ type: 'image', source: { type: 'base64', media_type: refImageMediaType, data: refImageBase64 } });
  content.push({ type: 'text', text: msg });

  // Cambio 8: hasta 2 reintentos si los textos no están intactos
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const warningPrefix = attempt > 1
      ? `⚠ INTENTO ${attempt}/3: En el intento anterior los siguientes textos fueron alterados o están faltantes: ${JSON.stringify(lastResult?._missing || [])}. REPETÍ el prompt RESPETANDO EXACTAMENTE cada texto entre comillas dobles.\n\n`
      : '';

    const msgWithWarning = attempt > 1
      ? [{ type: 'text', text: warningPrefix }, ...content.slice(-1)]
      : content;

    const data = await fetchClaude({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: attempt > 1 ? [{ type: 'text', text: warningPrefix + msg }] : content }]
    });

    const text = data.content.map(b => b.text || '').join('');
    const usage = data.usage || {};

    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch { throw new Error('El agente no devolvió JSON válido. Intentá de nuevo.'); }

    result._tokens_analysis = { model: 'claude-opus-4-5', input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 };

    // Validar textos
    const missing = validateTextsInPrompt(ctas, result.background_prompt || '');
    if (missing.length === 0) return result; // Todo OK

    console.warn(`[agent] Intento ${attempt} — textos faltantes/alterados: ${JSON.stringify(missing)}`);
    result._missing = missing;
    lastResult = result;

    if (attempt === 3) {
      // En el último intento devolvemos igual pero logueamos el problema
      console.error('[agent] No se pudo garantizar integridad de textos después de 3 intentos');
      return result;
    }
  }

  return lastResult;
}

// ── ENDPOINT ANALIZAR ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
            refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });

    const billingCheck = await checkBillingLimit(slug);
    if (!billingCheck.ok) {
      const cfg = await loadBillingConfig();
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

    const result = await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
      refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENDPOINT GENERAR IMAGEN ───────────────────────────────────
// Cambios 1, 2, 3, 4: JSON prompting, sin negative_prompt, índices, compresión
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, aspect_ratio, network, imageBase64, imageMediaType, extraPhotos } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });

    const ar = aspect_ratio || ASPECT_RATIOS[network] || '1:1';

    // Cambio 1: el prompt puede venir como JSON stringificado — si es así, lo convertimos
    // a prosa estructurada que Flux entiende mejor
    let finalPrompt = prompt;
    try {
      const parsed = JSON.parse(prompt);
      // Construir prompt desde JSON estructurado
      const parts = [];
      if (parsed.subjects) parts.push(parsed.subjects);
      if (parsed.scene)    parts.push(`set in ${parsed.scene}`);
      if (parsed.user_intent) parts.push(parsed.user_intent);
      if (parsed.lighting) parts.push(parsed.lighting);
      if (parsed.color_palette) parts.push(`color palette: ${parsed.color_palette}`);
      // Textos MANDATORY
      if (parsed.texts?.length) {
        parsed.texts.forEach(t => {
          parts.push(`MANDATORY TEXT: render exact text "${t.content}" as ${t.style}, ${t.position}`);
        });
      }
      if (parsed.style)  parts.push(parsed.style);
      if (parsed.camera) parts.push(parsed.camera);
      finalPrompt = parts.join('. ');
    } catch { /* prompt ya es prosa — usarlo directo */ }

    const input = {
      prompt: finalPrompt,
      aspect_ratio: ar,
      output_format: 'jpg',
      output_quality: 95,
      safety_tolerance: 5,
      // Cambio 2: sin negative_prompt — Flux no lo entiende y puede hacer el efecto contrario
    };

    // Cambio 3 + 4: imágenes comprimidas y referenciadas por índice
    const inputImages = [];
    if (imageBase64 && imageMediaType) {
      inputImages.push('data:' + imageMediaType + ';base64,' + imageBase64);
    }
    if (Array.isArray(extraPhotos)) {
      extraPhotos.forEach(p => {
        if (p.data && p.mime) inputImages.push('data:' + p.mime + ';base64,' + p.data);
      });
    }
    if (inputImages.length > 0) input.input_images = inputImages;

    const r = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_TOKEN,
        'Content-Type': 'application/json',
        'Prefer': 'wait=30'
      },
      body: JSON.stringify({ input })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail || 'Error Replicate' });
    data._flux_started_at = Date.now();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
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

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), model: 'FLUX.2 Pro', version: '2.0.0' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio v2 — FLUX.2 Pro');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
