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

function saveClientBilling(slug, data) {
  try {
    const fp = path.join(__dirname, 'clients', `${slug}.billing.json`);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    return true;
  } catch(e) { console.error(`[billing] Error guardando ${slug}.billing.json:`, e.message); return false; }
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
  const billing = loadClientBilling(slug);
  if (!billing) return { ok: true }; // Sin billing configurado → permitir
  const b = ensureCurrentMonth({ ...billing });
  if (b.active === false) return { ok:false, reason:'inactive', billing:b };
  if (b.plan_monthly > 0 && b.current_month.graphics >= b.plan_monthly)
    return { ok:false, reason:'limit_reached', billing:b };
  return { ok:true };
}

function recordGeneration(slug, costs) {
  // costs = { claude_analysis:{model,input_tokens,output_tokens}, flux:{seconds}, claude_copy:{model,input_tokens,output_tokens} }
  const billing = loadClientBilling(slug);
  if (!billing) return null;

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

  saveClientBilling(slug, b);

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
    const billing = loadClientBilling(slug);
    if (!billing) return res.json({ enabled: false });
    const b = ensureCurrentMonth({ ...billing });
    saveClientBilling(slug, b);
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
    const result = recordGeneration(slug, costs || {});
    if (!result) return res.json({ enabled: false });
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('[complete-graphic]', e.message);
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
        const billing = ensureCurrentMonth(JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));
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

## Tu rol: Director de Arte para FLUX.2 Pro

Sos un director de arte experto en ecommerce y paid media.
Tu tarea es generar un prompt maestro para FLUX.2 Pro que cree la pieza publicitaria COMPLETA,
incluyendo los textos de los CTAs integrados visualmente en la composicion.

## Como funciona FLUX.2 Pro

FLUX.2 Pro recibe:
1. Tu prompt (descripcion completa de la pieza — escena + textos integrados)
2. Las fotos de los productos como imagenes de referencia (hasta 5)

El modelo genera UNA sola imagen — no compone, no pega, CREA todo integrado.
Los productos aparecen en la escena porque FLUX los toma de las referencias.

## Multiples productos (si hay mas de 1 foto)

Si hay ${totalPhotos} foto(s) de producto:
- Describir en el prompt COMO aparecen juntos los productos en la composicion
- Especificar si van side by side, escalonados, en podios, agrupados, etc.
- Cada producto debe ser identificable y visible en la pieza final
- La composicion debe ser balanceada y visualmente atractiva

## Imagen de referencia de estilo

Si hay imagen de referencia: analizarla profundamente y extraer estilo, paleta y mood.
Inspirarse en esa estetica para crear algo original con ese look and feel.

## Textos en la pieza — ABSOLUTAMENTE OBLIGATORIO

Los textos del usuario son SAGRADOS e INMUTABLES. Son el activo más importante de la pieza.

⚠️ PROHIBICIÓN ABSOLUTA: JAMÁS modificar, corregir, traducir, parafrasear, reordenar ni alterar un solo carácter de los textos del usuario. Si el usuario escribe "Borcego", el prompt debe decir "Borcego". Si escribe "6 Cutas", el prompt dice "6 Cutas". Tu trabajo NO es corregir — es copiar con fidelidad quirúrgica.

FLUX.2 Pro puede renderizar texto — usá esta capacidad siempre.

Para cada texto, incluí en el prompt una instrucción con este formato IMPERATIVO:

  MANDATORY TEXT: render exact text "[texto]" as [estilo], [zona de la imagen]

El texto entre comillas debe ser copiado CHARACTER BY CHARACTER desde el input del usuario. Cualquier diferencia es un error crítico.

Zona se traduce según lo que el usuario marcó en el canvas:
- Zona superior → "in the upper area of the image"
- Zona inferior → "in the lower area of the image"
- Zona superior izquierda → "in the upper left area"
- Zona inferior centro → "in the lower center area"
- Sin zona definida → elegir la zona más adecuada para la composición

EJEMPLO DE PROMPT BIEN CONSTRUIDO:
  MANDATORY TEXT: render exact text "Temporada Otoño Invierno" as large bold white sans-serif uppercase title, in the upper center area of the image
  MANDATORY TEXT: render exact text "6 Cuotas Sin Interés" as medium white sans-serif subtitle, in the lower left area
  MANDATORY TEXT: render exact text "Comprar Ahora" as bold white text inside a rounded pill-shaped button with solid color background, in the lower center area

REGLAS ABSOLUTAS:
- Cada texto va en su propia línea MANDATORY TEXT en el prompt
- El texto entre comillas = copia EXACTA, CHARACTER BY CHARACTER, de lo que escribió el usuario
- NUNCA autocorregir ortografía — si hay un error en el texto del usuario, se replica tal cual
- Los textos van SIEMPRE al final del prompt, antes del cierre técnico
- El cierre del prompt NO debe incluir "no text" ni "no watermarks" — los textos DEBEN aparecer
- Usar como cierre: "ultra photorealistic, commercial advertising photography, 8K resolution"

## Logo — REGLA CRÍTICA

${logoBase64 ? `El cliente tiene logo. El logo SE AGREGA EN POST-PROCESO sobre la imagen final — el sistema lo superpone automáticamente en el browser DESPUÉS de que FLUX genera la imagen.

PROHIBICIONES ABSOLUTAS relacionadas al logo:
❌ NO incluir ningún logo, marca, isotipo ni logotipo en el background_prompt
❌ NO describir el logo del cliente en el prompt
❌ NO sugerir que FLUX dibuje ningún logo
❌ NO mencionar ninguna marca en el prompt

El logo_position que indiques es solo para que el sistema sepa dónde superponerlo. Nada más.
Agregá "no logos, no brand marks, no watermarks, no text overlays" al negative_prompt.` :
`El cliente NO tiene logo. NO inventar, NO sugerir, NO incluir ningún logo, marca ni isotipo en la imagen.
Agregá "no logos, no brand marks, no watermarks, no text overlays" al negative_prompt.`}

## Zonas seguras

Si el userPrompt define ZONAS SEGURAS para textos, el fondo en esas zonas debe ser:
- Oscuro suave, gradiente negro, o superficie con suficiente contraste para que el texto sea legible
- Sin elementos visuales llamativos que compitan con el texto

## Construccion del prompt

En ingles, descriptivo, rico en detalles, en este orden ESTRICTO:
1. ESCENA: Ambiente, iluminacion, hora, mood
2. PRODUCTOS: Como aparece cada producto con sus caracteristicas exactas
3. COMPOSICION: Disposicion de los productos en la escena
4. ESTILO: Camara, lente, profundidad de campo
5. TEXTOS OBLIGATORIOS: Una linea MANDATORY TEXT por cada CTA del usuario
6. CIERRE: "ultra photorealistic, commercial advertising photography, 8K resolution"

Responde UNICAMENTE con JSON valido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripcion de los productos en las fotos",
    "style": "estilo detectado",
    "colors": "paleta de colores de los productos",
    "mood": "tono emocional sugerido",
    "lighting": "iluminacion detectada"
  },
  "background_prompt": "prompt completo en ingles para FLUX.2 Pro",
  "negative_prompt": "blurry, low quality, distorted, extra products, duplicate items, watermark",
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripcion de la composicion para entender la ubicacion de cada elemento"
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

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 2000, system, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Error en agente Claude');
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
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: 'Sos copywriter de esta marca:\n\n' + md + '\n\nRed: ' + (nets[network] || 'Instagram') + '.\nLos CTAs son INMUTABLES. Responde UNICAMENTE con JSON valido sin markdown.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
        { type: 'text', text: 'Analisis: ' + analysis.subject + ' | ' + analysis.mood + '\nCTAs exactos: ' + ctas.join(' | ') + '\n\nJSON:\n{"hook":"","caption":"","cta_recomendado":"","hashtags":[],"variacion_b":"","tip":""}' }
      ]}]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Error copy');
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
