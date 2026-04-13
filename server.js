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


// ── BILLING ──────────────────────────────────────────────────────────────────

function loadBillingConfig() {
  const fp = path.join(__dirname, 'clients', 'billing.json');
  if (!fs.existsSync(fp)) return {
    contact_phone: '351 6 886262',
    costs_usd: { claude_analysis: 0.008, flux_image: 0.055, claude_copy: 0.004 },
    usd_to_ars: 1200, usd_to_eur: 0.92
  };
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function loadClientBilling(slug) {
  const fp = path.join(__dirname, 'clients', slug + '.billing.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function saveClientBilling(slug, data) {
  const fp = path.join(__dirname, 'clients', slug + '.billing.json');
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function initClientBilling(slug) {
  return {
    slug,
    plan_limit: 50,
    price_per_graphic: { ars: 3000, usd: 2.5, eur: 2.3 },
    currency_display: 'ars',
    active: true,
    usage: {
      total_graphics: 0,
      calls: { claude_analysis: 0, flux_image: 0, claude_copy: 0 },
      total_cost_usd: 0,
      history: []
    }
  };
}

function checkBillingLimit(slug) {
  const billing = loadClientBilling(slug);
  if (!billing) return { ok: true, billing: null };
  if (!billing.active) return { ok: false, reason: 'inactive', billing };
  if (billing.plan_limit > 0 && billing.usage.total_graphics >= billing.plan_limit) {
    return { ok: false, reason: 'limit_reached', billing };
  }
  return { ok: true, billing };
}

function recordGeneration(slug, callsUsed) {
  let billing = loadClientBilling(slug);
  if (!billing) return; // Si no tiene billing configurado, no registrar
  const cfg = loadBillingConfig();
  const costs = cfg.costs_usd || {};

  // Calcular costo de esta generación
  const costBreakdown = {
    claude_analysis: callsUsed.claude_analysis ? (costs.claude_analysis || 0) : 0,
    flux_image:      callsUsed.flux_image      ? (costs.flux_image      || 0) : 0,
    claude_copy:     callsUsed.claude_copy     ? (costs.claude_copy     || 0) : 0,
  };
  const totalCostUsd = Object.values(costBreakdown).reduce((a, b) => a + b, 0);

  // Actualizar contadores
  billing.usage.total_graphics += 1;
  billing.usage.calls.claude_analysis += callsUsed.claude_analysis ? 1 : 0;
  billing.usage.calls.flux_image      += callsUsed.flux_image      ? 1 : 0;
  billing.usage.calls.claude_copy     += callsUsed.claude_copy     ? 1 : 0;
  billing.usage.total_cost_usd = (billing.usage.total_cost_usd || 0) + totalCostUsd;

  // Guardar en historial (máximo 500 entradas)
  const entry = {
    date: new Date().toISOString(),
    calls: { ...callsUsed },
    cost_usd: totalCostUsd,
    cost_breakdown: costBreakdown,
  };
  if (!billing.usage.history) billing.usage.history = [];
  billing.usage.history.push(entry);
  if (billing.usage.history.length > 500) billing.usage.history = billing.usage.history.slice(-500);

  saveClientBilling(slug, billing);
  return { entry, totalCostUsd };
}

// Endpoint: obtener estado de billing del cliente
app.get('/api/billing/:slug', (req, res) => {
  const { slug } = req.params;
  const billing = loadClientBilling(slug);
  if (!billing) return res.json({ enabled: false });
  const cfg = loadBillingConfig();
  const costs = cfg.costs_usd || {};
  const rates = { usd_to_ars: cfg.usd_to_ars || 1200, usd_to_eur: cfg.usd_to_eur || 0.92 };
  const totalUsd = billing.usage.total_cost_usd || 0;

  res.json({
    enabled: true,
    active: billing.active !== false,
    plan_limit: billing.plan_limit || 0,
    total_graphics: billing.usage.total_graphics || 0,
    remaining: billing.plan_limit > 0 ? Math.max(0, billing.plan_limit - billing.usage.total_graphics) : null,
    calls: billing.usage.calls || {},
    cost_usd: parseFloat(totalUsd.toFixed(4)),
    cost_ars: parseFloat((totalUsd * rates.usd_to_ars).toFixed(0)),
    cost_eur: parseFloat((totalUsd * rates.usd_to_eur).toFixed(2)),
    price_per_graphic: billing.price_per_graphic || {},
    currency_display: billing.currency_display || 'usd',
    costs_per_call: costs,
    contact_phone: cfg.contact_phone || '351 6 886262',
    last_graphic: billing.usage.history?.slice(-1)[0] || null,
  });
});

// Endpoint: admin — obtener billing de todos los clientes
app.get('/api/admin/billing', (req, res) => {
  const { password } = req.query;
  const cfg = loadBillingConfig();
  if (password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });

  const dir = path.join(__dirname, 'clients');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.billing.json'));
  const all = files.map(f => {
    const slug = f.replace('.billing.json', '');
    const billing = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const md = loadClient(slug);
    const meta = md ? parseMeta(md) : { name: slug };
    const totalUsd = billing.usage?.total_cost_usd || 0;
    return {
      slug, name: meta.name,
      plan_limit: billing.plan_limit,
      total_graphics: billing.usage?.total_graphics || 0,
      remaining: billing.plan_limit > 0 ? Math.max(0, billing.plan_limit - (billing.usage?.total_graphics||0)) : null,
      total_cost_usd: parseFloat(totalUsd.toFixed(4)),
      total_cost_ars: parseFloat((totalUsd * (cfg.usd_to_ars||1200)).toFixed(0)),
      total_cost_eur: parseFloat((totalUsd * (cfg.usd_to_eur||0.92)).toFixed(2)),
      calls: billing.usage?.calls || {},
      active: billing.active !== false,
      price_per_graphic: billing.price_per_graphic || {},
      currency_display: billing.currency_display || 'usd',
    };
  });
  res.json({ clients: all, costs_usd: cfg.costs_usd, rates: { usd_to_ars: cfg.usd_to_ars, usd_to_eur: cfg.usd_to_eur } });
});

// Endpoint: admin — actualizar config de un cliente
app.post('/api/admin/billing/:slug', (req, res) => {
  const cfg = loadBillingConfig();
  const { password, plan_limit, price_per_graphic, currency_display, active, reset_usage } = req.body;
  if (password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });
  const { slug } = req.params;
  let billing = loadClientBilling(slug) || initClientBilling(slug);
  if (plan_limit !== undefined)        billing.plan_limit = parseInt(plan_limit);
  if (price_per_graphic !== undefined) billing.price_per_graphic = price_per_graphic;
  if (currency_display !== undefined)  billing.currency_display = currency_display;
  if (active !== undefined)            billing.active = active;
  if (reset_usage) {
    billing.usage = { total_graphics: 0, calls: { claude_analysis: 0, flux_image: 0, claude_copy: 0 }, total_cost_usd: 0, history: [] };
  }
  saveClientBilling(slug, billing);
  res.json({ ok: true, billing });
});

// Endpoint: admin — actualizar billing.json global
app.post('/api/admin/config', (req, res) => {
  const cfg = loadBillingConfig();
  const { password, costs_usd, usd_to_ars, usd_to_eur, contact_phone } = req.body;
  if (password !== cfg.admin_password) return res.status(401).json({ error: 'No autorizado' });
  if (costs_usd)      cfg.costs_usd = costs_usd;
  if (usd_to_ars)     cfg.usd_to_ars = parseFloat(usd_to_ars);
  if (usd_to_eur)     cfg.usd_to_eur = parseFloat(usd_to_eur);
  if (contact_phone)  cfg.contact_phone = contact_phone;
  fs.writeFileSync(path.join(__dirname, 'clients', 'billing.json'), JSON.stringify(cfg, null, 2));
  res.json({ ok: true, config: cfg });
});

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
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
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { hook: '', caption: text, cta_recomendado: ctas[0] || '', hashtags: [], variacion_b: '', tip: '' }; }
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
          ? `Alcanzaste el límite de ${billingCheck.billing.plan_limit} gráficas de tu plan. Contactanos para continuar.`
          : 'Tu cuenta está pausada. Contactanos para reactivarla.',
        contact: cfg.contact_phone || '351 6 886262',
        usage: billingCheck.billing?.usage || {}
      });
    }

    const result = await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
      refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network });

    // Registrar llamada a Claude (análisis) — la gráfica completa se registra al finalizar
    // Se registra aquí con flag parcial, se completa en /api/complete-graphic
    res.json({ ...result, _billing_started: true });
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

// Registrar gráfica completa — se llama desde el front cuando termina todo el pipeline
app.post('/api/complete-graphic/:slug', (req, res) => {
  const { slug } = req.params;
  const { calls_used } = req.body; // { claude_analysis, flux_image, claude_copy }
  const record = recordGeneration(slug, calls_used || { claude_analysis: true, flux_image: true, claude_copy: false });
  const billing = loadClientBilling(slug);
  if (!billing) return res.json({ enabled: false });
  const cfg = loadBillingConfig();
  const totalUsd = billing.usage.total_cost_usd || 0;
  res.json({
    ok: true,
    total_graphics: billing.usage.total_graphics,
    remaining: billing.plan_limit > 0 ? Math.max(0, billing.plan_limit - billing.usage.total_graphics) : null,
    cost_usd: parseFloat(totalUsd.toFixed(4)),
    cost_ars: parseFloat((totalUsd * (cfg.usd_to_ars||1200)).toFixed(0)),
    cost_eur: parseFloat((totalUsd * (cfg.usd_to_eur||0.92)).toFixed(2)),
    last_cost_usd: record?.totalCostUsd || 0,
  });
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio — FLUX.2 Pro');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
