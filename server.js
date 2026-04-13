require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

const DIMS = {
  instagram:         { w: 1080, h: 1080 },
  instagram_stories: { w: 1080, h: 1920 },
  linkedin:          { w: 1920, h: 1080 },
  facebook:          { w: 1080, h: 1350 }
};

const ASPECT_RATIOS = {
  instagram: '1:1', instagram_stories: '9:16',
  linkedin: '16:9', facebook: '4:5'
};

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


// ── BILLING MENSUAL ──────────────────────────────────────────────────────────

// Precios reales de las APIs (USD por token / por segundo GPU)
const MODEL_PRICES = {
  'claude-opus-4-5':          { input: 15.00/1e6, output: 75.00/1e6 },
  'claude-sonnet-4-20250514': { input:  3.00/1e6, output: 15.00/1e6 },
  'claude-haiku-4-5-20251001':{ input:  0.80/1e6, output:  4.00/1e6 },
};
const FLUX_COST_PER_SECOND = 0.0032; // Replicate Flux 2 Pro

function calcClaudeCost(model, inputTok, outputTok) {
  const p = MODEL_PRICES[model] || MODEL_PRICES['claude-sonnet-4-20250514'];
  return (inputTok * p.input) + (outputTok * p.output);
}

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

// ── IO helpers con manejo de errores ──────────────────────────
function loadBillingConfig() {
  try {
    const fp = path.join(__dirname, 'clients', 'billing.json');
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch(e) { console.error('[billing] Error leyendo billing.json:', e.message); }
  return { admin_password: 'docta2024', contact_phone: '351 6 886262', usd_to_ars: 1200, usd_to_eur: 0.92 };
}

function saveBillingConfig(cfg) {
  try {
    const fp = path.join(__dirname, 'clients', 'billing.json');
    fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
    return true;
  } catch(e) { console.error('[billing] Error guardando billing.json:', e.message); return false; }
}

function loadClientBilling(slug) {
  try {
    const fp = path.join(__dirname, 'clients', `${slug}.billing.json`);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch(e) { console.error(`[billing] Error leyendo ${slug}.billing.json:`, e.message); }
  return null;
}
// ── BILLING EN MEMORIA (backup para Render ephemeral filesystem) ──
// En Render, el disco se resetea en cada deploy.
// Guardamos una copia en memoria para no perder datos entre requests.
// Para persistencia real, configurar un Disk en Render (ver README).
const billingCache = new Map();

function loadClientBillingWithCache(slug) {
  // Intentar desde archivo primero
  const fromFile = loadClientBilling(slug);
  if (fromFile) {
    // Actualizar cache con dato más reciente entre archivo y memoria
    const cached = billingCache.get(slug);
    if (cached && cached.current_month && fromFile.current_month) {
      // Usar el que tiene más gráficas (más actualizado)
      if (cached.current_month.graphics > fromFile.current_month.graphics) {
        return cached;
      }
    }
    billingCache.set(slug, fromFile);
    return fromFile;
  }
  // Si no hay archivo, intentar desde cache
  return billingCache.get(slug) || null;
}

function saveClientBillingWithCache(slug, data) {
  billingCache.set(slug, data); // Siempre guardar en memoria
  return saveClientBilling(slug, data); // Intentar guardar en disco
}



function saveClientBilling(slug, data) {
  try {
    const fp = path.join(__dirname, 'clients', `${slug}.billing.json`);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    console.log(`[billing] ✓ Guardado ${slug} — graphics:${data.current_month?.graphics} real_usd:${data.current_month?.real_cost_usd}`);
    return true;
  } catch(e) {
    console.error(`[billing] ✗ Error guardando ${slug}.billing.json:`, e.message);
    return false;
  }
}

function initMonthBlock() {
  return { month: currentMonth(), graphics: 0, calls: { claude_analysis:0, flux_image:0, claude_copy:0 }, real_cost_usd:0, charged_usd:0, detail:[] };
}

function initClientBilling(slug) {
  return { slug, plan_monthly:30, pricing_mode:'markup', markup:4, fixed_price:{ars:3000,usd:2.5,eur:2.3}, currency_display:'ars', active:true, current_month:initMonthBlock(), history:[] };
}

function ensureCurrentMonth(billing) {
  const cm = currentMonth();
  if (!billing.current_month || billing.current_month.month !== cm) {
    if (billing.current_month && billing.current_month.graphics > 0) {
      billing.history = billing.history || [];
      billing.history.push(billing.current_month);
    }
    billing.current_month = initMonthBlock();
  }
  return billing;
}

function checkBillingLimit(slug) {
  const billing = loadClientBillingWithCache(slug);
  if (!billing) return { ok: true }; // Sin billing configurado → permitir
  const b = ensureCurrentMonth({ ...billing });
  if (b.active === false) return { ok:false, reason:'inactive', billing:b };
  if (b.plan_monthly > 0 && b.current_month.graphics >= b.plan_monthly)
    return { ok:false, reason:'limit_reached', billing:b };
  return { ok:true };
}

function recordGeneration(slug, costs) {
  // costs = { claude_analysis:{model,input_tokens,output_tokens}, flux:{seconds}, claude_copy:{model,input_tokens,output_tokens} }
  let billing = loadClientBillingWithCache(slug);
  // Si no existe billing, crear uno con defaults — no bloquear el registro
  if (!billing) {
    console.log(`[billing] Auto-creando billing para ${slug}`);
    billing = initClientBilling(slug);
  }

  const b = ensureCurrentMonth(billing);
  const cfg = loadBillingConfig();

  // Calcular costo real
  const realCost = {
    claude_analysis: costs.claude_analysis ? calcClaudeCost(costs.claude_analysis.model, costs.claude_analysis.input_tokens||0, costs.claude_analysis.output_tokens||0) : 0,
    flux_image:      costs.flux            ? (costs.flux.seconds||15) * FLUX_COST_PER_SECOND : 0,
    claude_copy:     costs.claude_copy     ? calcClaudeCost(costs.claude_copy.model,    costs.claude_copy.input_tokens||0,    costs.claude_copy.output_tokens||0)    : 0,
  };
  const totalReal = Object.values(realCost).reduce((a,v)=>a+v,0);

  // Precio cobrado según modo
  let charged = 0;
  if      (b.pricing_mode === 'markup') charged = totalReal * (b.markup || 1);
  else if (b.pricing_mode === 'fixed')  charged = b.fixed_price?.usd || 0;

  // Actualizar mes actual
  const cm = b.current_month;
  cm.graphics += 1;
  cm.calls.claude_analysis += costs.claude_analysis ? 1 : 0;
  cm.calls.flux_image      += costs.flux            ? 1 : 0;
  cm.calls.claude_copy     += costs.claude_copy     ? 1 : 0;
  cm.real_cost_usd = parseFloat(((cm.real_cost_usd||0) + totalReal).toFixed(6));
  cm.charged_usd   = parseFloat(((cm.charged_usd||0)   + charged  ).toFixed(6));

  // Historial de esta generación (máx 200 por mes)
  cm.detail = cm.detail || [];
  cm.detail.push({ date: new Date().toISOString(), real_cost_usd: parseFloat(totalReal.toFixed(6)), breakdown: realCost, charged_usd: parseFloat(charged.toFixed(6)) });
  if (cm.detail.length > 200) cm.detail = cm.detail.slice(-200);

  saveClientBillingWithCache(slug, b);

  const rates = { ars: cfg.usd_to_ars||1200, eur: cfg.usd_to_eur||0.92 };
  return {
    graphics:  cm.graphics,
    remaining: b.plan_monthly > 0 ? Math.max(0, b.plan_monthly - cm.graphics) : null,
    real_cost_usd: parseFloat(totalReal.toFixed(6)),
    charged_usd:   parseFloat(charged.toFixed(4)),
    charged_ars:   Math.round(charged * rates.ars),
    charged_eur:   parseFloat((charged * rates.eur).toFixed(2)),
    breakdown:     realCost,
  };
}

// ── BILLING ENDPOINTS ─────────────────────────────────────────

// Cliente: estado de uso del mes actual
app.get('/api/billing/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    const billing = loadClientBillingWithCache(slug);
    if (!billing) return res.json({ enabled: false });
    const b = ensureCurrentMonth({ ...billing });
    if (b.current_month.month !== billing.current_month?.month) saveClientBillingWithCache(slug, b);
    const cfg = loadBillingConfig();
    const cm = b.current_month;
    res.json({
      enabled: true,
      active:  b.active !== false,
      plan_monthly: b.plan_monthly || 0,
      graphics:     cm.graphics || 0,
      remaining:    b.plan_monthly > 0 ? Math.max(0, b.plan_monthly - cm.graphics) : null,
      month:        cm.month,
      contact_phone: cfg.contact_phone || '351 6 886262',
    });
  } catch(e) {
    console.error('[billing GET]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Registrar gráfica completa con costos reales
app.post('/api/complete-graphic/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    const { costs } = req.body;
    console.log(`[complete-graphic] slug=${slug} costs=${JSON.stringify(costs||{}).slice(0,120)}`);
    const result = recordGeneration(slug, costs || {});
    if (!result) return res.json({ enabled: false });
    console.log(`[complete-graphic] OK → graphics=${result.graphics} real_usd=${result.real_cost_usd}`);
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('[complete-graphic]', e.message, e.stack);
    res.status(500).json({ error: 'Error registrando generación' });
  }
});

// Admin: ver todos los clientes
app.get('/api/admin/billing', (req, res) => {
  try {
    const { password } = req.query;
    const cfg = loadBillingConfig();
    if (!password || password !== cfg.admin_password)
      return res.status(401).json({ error: 'No autorizado' });

    const dir = path.join(__dirname, 'clients');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.billing.json') && f !== 'billing.json');
    const rates = { usd_to_ars: cfg.usd_to_ars||1200, usd_to_eur: cfg.usd_to_eur||0.92 };

    const clients = files.map(f => {
      try {
        const slug = f.replace('.billing.json','');
        const fileData = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
        const cached = billingCache.get(slug);
        // Usar el más reciente entre archivo y cache
        const billing = ensureCurrentMonth((cached?.current_month?.graphics||0) > (fileData.current_month?.graphics||0) ? cached : fileData);
        const md = loadClient(slug);
        const meta = md ? parseMeta(md) : { name: slug };
        const cm = billing.current_month;
        const allMonths = [...(billing.history||[]), cm];
        const totReal    = allMonths.reduce((s,m) => s+(m.real_cost_usd||0), 0);
        const totCharged = allMonths.reduce((s,m) => s+(m.charged_usd||0), 0);
        const totGraphics= allMonths.reduce((s,m) => s+(m.graphics||0), 0);
        return {
          slug, name: meta.name,
          active: billing.active !== false,
          plan_monthly: billing.plan_monthly,
          pricing_mode: billing.pricing_mode,
          markup: billing.markup,
          fixed_price: billing.fixed_price,
          currency_display: billing.currency_display,
          current_month: {
            ...cm,
            charged_ars: Math.round((cm.charged_usd||0) * rates.usd_to_ars),
            charged_eur: parseFloat(((cm.charged_usd||0) * rates.usd_to_eur).toFixed(2)),
            real_cost_ars: Math.round((cm.real_cost_usd||0) * rates.usd_to_ars),
          },
          history: (billing.history||[]).map(m=>({
            ...m,
            charged_ars: Math.round((m.charged_usd||0) * rates.usd_to_ars),
            charged_eur: parseFloat(((m.charged_usd||0) * rates.usd_to_eur).toFixed(2)),
            real_cost_ars: Math.round((m.real_cost_usd||0) * rates.usd_to_ars),
          })),
          totals: {
            graphics:    totGraphics,
            real_cost_usd:  parseFloat(totReal.toFixed(4)),
            real_cost_ars:  Math.round(totReal * rates.usd_to_ars),
            charged_usd:    parseFloat(totCharged.toFixed(4)),
            charged_ars:    Math.round(totCharged * rates.usd_to_ars),
            charged_eur:    parseFloat((totCharged * rates.usd_to_eur).toFixed(2)),
            margin_usd:     parseFloat((totCharged - totReal).toFixed(4)),
          },
        };
      } catch(e) {
        console.error('[admin] Error procesando', f, e.message);
        return null;
      }
    }).filter(Boolean);

    res.json({ clients, rates, model_prices: MODEL_PRICES });
  } catch(e) {
    console.error('[admin GET]', e.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Admin: actualizar config de un cliente
app.post('/api/admin/billing/:slug', (req, res) => {
  try {
    const cfg = loadBillingConfig();
    const { password, plan_monthly, pricing_mode, markup, fixed_price, currency_display, active, reset_month } = req.body;
    if (!password || password !== cfg.admin_password)
      return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    let billing = loadClientBilling(slug) || initClientBilling(slug);
    billing = ensureCurrentMonth(billing);
    if (plan_monthly     != null) billing.plan_monthly     = parseInt(plan_monthly) || 0;
    if (pricing_mode     != null) billing.pricing_mode     = pricing_mode;
    if (markup           != null) billing.markup           = parseFloat(markup) || 1;
    if (fixed_price      != null) billing.fixed_price      = fixed_price;
    if (currency_display != null) billing.currency_display = currency_display;
    if (active           != null) billing.active           = Boolean(active);
    if (reset_month) {
      if (billing.current_month.graphics > 0) {
        billing.history = billing.history || [];
        billing.history.push(billing.current_month);
      }
      billing.current_month = initMonthBlock();
    }
    if (!saveClientBilling(slug, billing))
      return res.status(500).json({ error: 'No se pudo guardar' });
    res.json({ ok: true, billing });
  } catch(e) {
    console.error('[admin POST slug]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Admin: config global (tipos de cambio, teléfono, contraseña)
app.post('/api/admin/config', (req, res) => {
  try {
    const cfg = loadBillingConfig();
    const { password, usd_to_ars, usd_to_eur, contact_phone, admin_password } = req.body;
    if (!password || password !== cfg.admin_password)
      return res.status(401).json({ error: 'No autorizado' });
    if (usd_to_ars)     cfg.usd_to_ars     = parseFloat(usd_to_ars);
    if (usd_to_eur)     cfg.usd_to_eur     = parseFloat(usd_to_eur);
    if (contact_phone)  cfg.contact_phone  = contact_phone;
    if (admin_password && admin_password.length >= 6) cfg.admin_password = admin_password;
    if (!saveBillingConfig(cfg))
      return res.status(500).json({ error: 'No se pudo guardar' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin config]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});


app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/api/client/:slug', (req, res) => {
  const md = loadClient(req.params.slug);
  if (!md) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ slug: req.params.slug, ...parseMeta(md) });
});

app.get('/api/clients', (req, res) => {
  res.json(listClients().map(slug => ({ slug, ...parseMeta(loadClient(slug)) })));
});


// ── CLAUDE FETCH CON RETRY ────────────────────────────────────
// Maneja errores 529 (Overloaded) con backoff exponencial
async function fetchClaude(payload, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(payload)
      });
      const data = await r.json();

      // Overloaded (529) o Too Many Requests (429) → retry con backoff
      if (r.status === 529 || r.status === 429 || data.error?.type === 'overloaded_error') {
        const waitMs = attempt * 8000; // 8s, 16s, 24s
        console.warn(`[Claude] Overloaded (intento ${attempt}/${maxRetries}), esperando ${waitMs/1000}s...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
        throw new Error('El servicio de IA está temporalmente saturado. Intentá en 1-2 minutos.');
      }

      if (!r.ok) {
        throw new Error(data.error?.message || `Error Claude (${r.status})`);
      }

      return data;
    } catch(e) {
      lastError = e;
      if (attempt < maxRetries && (e.message.includes('saturado') || e.message.includes('overload'))) {
        await new Promise(resolve => setTimeout(resolve, attempt * 8000));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ── AGENTE CLAUDE ─────────────────────────────────────────────────────────────
// Claude analiza la foto del producto (+ referencia si hay) y genera el prompt
// para FLUX.2 Pro que creara la pieza completa e integrada.

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

  const system = md + `

---

## Tu rol: Director de Arte — Flux 2 Pro Expert

Sos un director de arte especializado en publicidad digital y paid media.
Tu única tarea: analizar las fotos del producto y generar el prompt perfecto para FLUX.2 Pro.

## Cómo funciona FLUX.2 Pro (CRÍTICO — leer con atención)

FLUX.2 Pro usa un modelo de lenguaje visual (Mistral-3 24B) que entiende lenguaje natural descriptivo.
NO es como Stable Diffusion — el keyword stuffing y las listas de tags lo perjudican.

REGLAS DE PROMPTING PARA FLUX.2 PRO:
1. **Orden importa** — Lo que escribís primero tiene más peso. Empezá SIEMPRE con el sujeto principal.
2. **Lenguaje natural** — Escribí en prosa descriptiva, no en listas de palabras clave separadas por comas.
3. **Sweet spot: 40-80 palabras** — Prompts más largos no mejoran el resultado.
4. **NO soporta negative prompts** — Todo lo que no querés, no lo mencionés. El campo negative_prompt se ignora internamente pero devolvé una cadena vacía.
5. **Colores exactos con HEX** — Para precisión de marca, escribí: "background in deep navy color #0A1628" — siempre con la palabra "color" antes del HEX.
6. **Estilo fotográfico al FINAL** — "shot on Canon EOS R5, 85mm f/1.8, shallow depth of field" va al cierre.

## Estructura OBLIGATORIA del prompt (en inglés)

[SUJETO PRINCIPAL — el producto] + [cómo está en la escena] + [ambiente/entorno] + [iluminación] + [composición] + [textos MANDATORY] + [estilo fotográfico al final]

EJEMPLO CORRECTO:
"Premium skincare serum bottle centered on a marble surface, soft diffused studio lighting from the left, clean minimal background with subtle depth, elegant and luxurious mood. MANDATORY TEXT: render exact text "Ritual de Noche" as large bold white serif title, upper center area. MANDATORY TEXT: render exact text "30% OFF" as bold text in a gold rounded badge, lower right corner. Shot on Hasselblad X2D, 90mm macro lens, f/4, professional product photography."

EJEMPLO INCORRECTO (NO hacer esto):
"ultra realistic, 8k, masterpiece, product photo, serum bottle, marble, luxury, high quality, cinematic, detailed..."

## ${totalPhotos > 1 ? `Múltiples productos (${totalPhotos} fotos)` : 'Producto único'}

${totalPhotos > 1 ? `Tenés ${totalPhotos} fotos de productos. En el prompt describí EXACTAMENTE cómo aparecen juntos:
- Posición relativa: "side by side", "staggered at different heights", "grouped on a pedestal", etc.
- Cada producto debe ser claramente identificable en la composición final.` : 'Un solo producto. Describilo con precisión — forma, acabado, color, tamaño relativo en el encuadre.'}

## Imagen de referencia de estilo

${hasRef ? 'HAY imagen de referencia. Analizala profundamente. Extrae: paleta cromática exacta, tipo de iluminación, mood, estética general. Usá esos elementos como inspiración para la composición — creá algo original con ese mismo look and feel.' : 'No hay imagen de referencia. Creá el estilo basándote en el contexto del cliente y el brief del usuario.'}

## Textos en la pieza — REGLA ABSOLUTA

Los textos del usuario son SAGRADOS. JAMÁS modificar, corregir, traducir ni alterar ni un solo carácter.

Para cada texto del usuario, escribí en el prompt:
MANDATORY TEXT: render exact text "[texto]" as [estilo tipográfico], [posición]

Posiciones:
- Zona superior → "in the upper area"
- Zona inferior → "in the lower area"  
- Zona superior izquierda → "in the upper left area"
- Zona inferior centro → "in the lower center area"
- Sin zona → elegí la posición más armónica para la composición

Los MANDATORY TEXT van DESPUÉS de describir la escena y ANTES del cierre de estilo fotográfico.

## Logo

${logoBase64 ?
`El cliente tiene logo. Se superpone en post-proceso — el sistema lo agrega sobre la imagen generada.
❌ NO incluir ningún logo ni marca en el prompt.
❌ NO describir el logo en el prompt.
Solo indicá logo_position: top-left, top-right, bottom-left o bottom-right.` :
`Sin logo. No inventar ni incluir ninguna marca en la imagen.`}

## Zonas seguras para texto

Si el brief menciona zonas reservadas para textos, el fondo en esas áreas debe ser:
limpio, de bajo contraste, sin elementos que compitan con la tipografía.

Respondé ÚNICAMENTE con JSON válido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripción del producto/s en las fotos",
    "style": "estilo visual detectado",
    "colors": "paleta de colores del producto",
    "mood": "tono emocional",
    "lighting": "iluminación detectada"
  },
  "background_prompt": "prompt completo en inglés para FLUX.2 Pro — lenguaje natural descriptivo, 40-80 palabras, sujeto primero",
  "negative_prompt": "",
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripción breve de cómo está compuesta la imagen para entender la ubicación de cada elemento"
}`;

  const photoCount = totalPhotos + (hasRef ? 1 : 0);
  const msg = 'Descripcion del usuario: ' + (userPrompt || 'No especificada') + '\n' +
    'TEXTOS A INTEGRAR EN LA IMAGEN (exactos e inmutables):\n' +
    ctas.map((c, i) => '  - Texto ' + (i+1) + ': "' + c + '"').join('\n') + '\n' +
    'Red social: ' + (networkLabels[network] || 'Feed') + '\n' +
    'Cantidad de productos: ' + totalPhotos + '\n' +
    'Logo del cliente: ' + (logoBase64 ? 'SÍ tiene logo — se superpone en post-proceso, NO lo incluyas en el prompt de FLUX' : 'NO tiene logo — no inventar ni incluir ningún logo en la imagen') + '\n' +
    'Imagen de referencia de estilo: ' + (hasRef ? 'Si — extraer estilo y mood' : 'No') + '\n\n' +
    'Imagenes recibidas:\n' +
    '- Img 1: PRODUCTO PRINCIPAL\n' +
    (hasExtras ? extraPhotos.map((_, i) => '- Img ' + (i+2) + ': PRODUCTO ' + (i+2) + '\n').join('') : '') +
    (hasRef ? '- Img ' + (totalPhotos + 1) + ': REFERENCIA VISUAL — extraer estilo\n' : '') +
    (totalPhotos > 1 ? '\nIMPORTANTE: El prompt debe describir una composicion con los ' + totalPhotos + ' productos integrados juntos en la escena.' : '');

  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }
  ];
  if (hasExtras) {
    extraPhotos.forEach(p => {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
    });
  }
  // Logo NO se envía a Claude — solo se usa en post-proceso en el browser
  // Enviarlo causaba que Claude lo describiera en el prompt y FLUX lo duplicara
  if (hasRef) {
    content.push({ type: 'image', source: { type: 'base64', media_type: refImageMediaType, data: refImageBase64 } });
  }
  content.push({ type: 'text', text: msg });

  const data = await fetchClaude({ model: 'claude-opus-4-5', max_tokens: 2000, system, messages: [{ role: 'user', content }] });
  const text = data.content.map(b => b.text || '').join('');
  const usage = data.usage || {};
  try {
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    // Adjuntar tokens para billing
    result._tokens_analysis = { model: 'claude-opus-4-5', input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 };
    return result;
  }
  catch { throw new Error('El agente no devolvio JSON valido. Intenta de nuevo.'); }
}

// ── COPY ──────────────────────────────────────────────────────────────────────
async function generateCopy({ slug, imageBase64, imageMediaType, analysis, ctas, network }) {
  const md = loadClient(slug) || '';
  const nets = { instagram: 'Instagram Feed', instagram_stories: 'Instagram Stories', linkedin: 'LinkedIn', facebook: 'Facebook' };
  const data = await fetchClaude({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: 'Sos copywriter de esta marca:\n\n' + md + '\n\nRed: ' + (nets[network] || 'Instagram') + '.\nLos CTAs son INMUTABLES. Responde UNICAMENTE con JSON valido sin markdown.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
        { type: 'text', text: 'Analisis: ' + analysis.subject + ' | ' + analysis.mood + '\nCTAs exactos: ' + ctas.join(' | ') + '\n\nJSON:\n{"hook":"","caption":"","cta_recomendado":"","hashtags":[],"variacion_b":"","tip":""}' }
      ]}]
    });
  const text = data.content.map(b => b.text || '').join('');
  const usage = data.usage || {};
  const tokensCopy = { model: 'claude-sonnet-4-20250514', input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 };
  try {
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    result._tokens_copy = tokensCopy;
    return result;
  }
  catch { return { hook: '', caption: text, cta_recomendado: ctas[0] || '', hashtags: [], variacion_b: '', tip: '', _tokens_copy: tokensCopy }; }
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
            refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });

    // Verificar límite de billing
    const billingCheck = checkBillingLimit(slug);
    if (!billingCheck.ok) {
      const cfg = loadBillingConfig();
      return res.status(403).json({
        error: 'billing_limit',
        reason: billingCheck.reason,
        message: billingCheck.reason === 'limit_reached'
          ? `Alcanzaste el límite de ${billingCheck.billing.plan_monthly} gráficas de este mes. Contactanos para continuar.`
          : 'Tu cuenta está pausada. Contactanos para reactivarla.',
        plan_monthly: billingCheck.billing.plan_monthly,
        contact_phone: cfg.contact_phone || '351 6 886262',
      });
    }

    const result = await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
      refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// FLUX.2 Pro — genera la pieza completa usando la foto del producto como referencia
// El modelo crea la escena integrada, no compone sobre un fondo
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, negative_prompt, aspect_ratio, network, imageBase64, imageMediaType, extraPhotos } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });

    const ar = aspect_ratio || ASPECT_RATIOS[network] || '1:1';

    const input = {
      prompt,
      aspect_ratio: ar,
      output_format: 'jpg',
      output_quality: 95,
      safety_tolerance: 5,
    };

    // Pasar TODAS las fotos de productos como input_images (FLUX.2 Pro acepta hasta 8)
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
    if (negative_prompt) input.negative_prompt = negative_prompt;

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
    // Adjuntar tiempo de inicio para calcular duración en el poll
    data._flux_started_at = Date.now();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/poll/:id', async (req, res) => {
  try {
    const r = await fetch('https://api.replicate.com/v1/predictions/' + req.params.id, {
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-copy', async (req, res) => {
  try {
    const { slug, imageBase64, imageMediaType, analysis, ctas, network } = req.body;
    if (!imageBase64 || !analysis || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });
    res.json(await generateCopy({ slug, imageBase64, imageMediaType, analysis, ctas, network }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FETCH PRODUCTO ────────────────────────────────────────────
// Extrae nombre, precio y descripción de una URL de producto
app.post('/api/fetch-product', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Falta la URL.' });

    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DoctaNexusStudio/1.0)' },
      timeout: 8000
    });
    if (!r.ok) return res.status(r.status).json({ error: 'No se pudo acceder a la URL.' });
    const html = await r.text();

    // Extraer datos del HTML con Claude
    const prompt = `Analizá este HTML de una página de producto de ecommerce y extraé:
1. Nombre del producto
2. Precio (con moneda y cuotas si las hay)
3. Descripción breve (máximo 150 palabras)

HTML (truncado):
${html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)}

Respondé ÚNICAMENTE con JSON válido (sin markdown):
{"name":"","price":"","description":""}`;

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const ad = await ar.json();
    if (!ar.ok) throw new Error(ad.error?.message || 'Error Claude');
    const text = ad.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({ ...parsed, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), model: 'FLUX.2 Pro' }));

// ── VIDEO — imagen a video con Kling v2.1 ─────────────────────
app.post('/api/generate-video', async (req, res) => {
  try {
    const { imageBase64, imageUrl, prompt, duration } = req.body;
    if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'Falta la imagen.' });

    let finalImageUrl = imageUrl;

    // Si llega base64 (fallback), subirlo a Replicate Files API
    if (!finalImageUrl && imageBase64) {
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const uploadRes = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + REPLICATE_TOKEN,
          'Content-Type': 'image/jpeg',
          'Content-Length': imgBuffer.length,
        },
        body: imgBuffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) return res.status(uploadRes.status).json({ error: uploadData.detail || 'Error subiendo imagen' });
      finalImageUrl = uploadData.urls?.get || uploadData.url;
      if (!finalImageUrl) return res.status(500).json({ error: 'No se obtuvo URL de la imagen' });
    }

    const input = {
      prompt: prompt || 'cinematic product advertisement, smooth slow camera movement, professional commercial quality',
      start_image: finalImageUrl,
      duration: duration || 5,
      aspect_ratio: '1:1',
      negative_prompt: 'blur, distortion, watermark, low quality, shaking, fast movement',
      cfg_scale: 0.5,
    };

    const r = await fetch('https://api.replicate.com/v1/models/kwaivgi/kling-v2.1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_TOKEN,
        'Content-Type': 'application/json',
        'Prefer': 'wait=10'
      },
      body: JSON.stringify({ input })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail || 'Error Replicate video' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/poll-video/:id', async (req, res) => {
  try {
    const r = await fetch('https://api.replicate.com/v1/predictions/' + req.params.id, {
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio — FLUX.2 Pro');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
