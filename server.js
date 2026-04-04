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
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
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

async function runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, refImageBase64, refImageMediaType, ctas, userPrompt, network }) {
  const md = loadClient(slug);
  if (!md) throw new Error('Cliente ' + slug + ' no encontrado.');

  const networkLabels = {
    instagram: 'Instagram Feed (1:1)', instagram_stories: 'Instagram Stories (9:16)',
    linkedin: 'LinkedIn (16:9)', facebook: 'Facebook (4:5)'
  };

  const hasRef = !!(refImageBase64 && refImageMediaType);

  const system = md + `

---

## Tu rol: Director de Arte para FLUX.2 Pro

Sos un director de arte experto en ecommerce y paid media.
Tu tarea es generar un prompt maestro para FLUX.2 Pro que cree la pieza publicitaria completa.

## Como funciona FLUX.2 Pro

FLUX.2 Pro recibe:
1. Tu prompt (descripcion completa de la pieza)
2. La foto del producto como imagen de referencia

El modelo genera UNA sola imagen integrada — no compone, no pega, CREA la pieza entera.
El calzado aparecera naturalmente en la escena porque FLUX lo toma de la referencia.

## Tu trabajo con la imagen de referencia

Si hay imagen de referencia de estilo, analizala y extrae:
- Paleta de colores, mood, estilo fotografico, recursos graficos
- Incorpora esa estetica en el prompt de forma organica

## Como construir el prompt para FLUX.2 Pro

Estructura tu prompt en este orden:

1. ESCENA: Describe el ambiente completo (locacion, iluminacion, hora del dia, mood)
2. PRODUCTO: Describe exactamente como aparece el calzado en la escena
   - Usa: "the black leather ankle boot with studs shown in the reference image"
   - Especifica posicion, angulo, tamanio en el encuadre
3. SI HAY PERSONA: Descripcion detallada (edad aproximada, ropa, pose, lo que hace)
4. ESTILO: Tipo de fotografia, camara, lente, profundidad de campo
5. ZONAS LIBRES: Si hay zonas seguras, especifica que esas areas tienen fondo oscuro/neutro
6. CIERRE: Terminar SIEMPRE con "ultra photorealistic, commercial photography, 8K resolution, no text, no logos, no watermarks"

El prompt debe ser en INGLES, descriptivo, cinematografico y especifico.
Cuanto mas detallado, mejor resultado.

Responde UNICAMENTE con JSON valido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripcion exacta del calzado en la foto",
    "style": "estilo fotografico del producto",
    "colors": "colores exactos del producto",
    "mood": "tono emocional sugerido para la pieza",
    "lighting": "iluminacion detectada"
  },
  "background_prompt": "prompt completo en ingles para FLUX.2 Pro",
  "negative_prompt": "blurry, low quality, distorted, watermark, text, logo, extra shoes, duplicate product, deformed",
  "cta_style": {
    "style": "minimal|bold|elegant|playful",
    "position": "bottom",
    "color_primary": "#hex de la paleta de la marca",
    "color_text": "#hex para el texto del boton",
    "shape": "pill|rectangle|banner"
  },
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripcion de la composicion para entender donde van logo y CTAs"
}`;

  const msg = 'Descripcion del usuario: ' + (userPrompt || 'No especificada') + '\n' +
    'CTAs (solo contexto — NO incluir en el prompt de imagen): ' + ctas.join(' | ') + '\n' +
    'Red social: ' + (networkLabels[network] || 'Instagram Feed') + '\n' +
    'Logo incluido: ' + (logoBase64 ? 'Si' : 'No') + '\n' +
    'Imagen de referencia de estilo: ' + (hasRef ? 'Si — analizar y extraer estetica' : 'No') + '\n\n' +
    'Imagen 1: FOTO DEL PRODUCTO — describir el calzado con precision para el prompt\n' +
    (logoBase64 ? 'Imagen 2: LOGO — solo contexto visual\n' : '') +
    (hasRef ? 'Imagen ' + (logoBase64 ? '3' : '2') + ': REFERENCIA VISUAL — extraer estilo, paleta y mood\n' : '') +
    '\nIMPORTANTE: El prompt debe referenciar el calzado con sus caracteristicas exactas para que FLUX lo reproduzca fielmente.';

  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }
  ];
  if (logoBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: logoMediaType, data: logoBase64 } });
  }
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
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType, refImageBase64, refImageMediaType, ctas, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });
    res.json(await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, refImageBase64, refImageMediaType, ctas, userPrompt, network }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// FLUX.2 Pro — genera la pieza completa usando la foto del producto como referencia
// El modelo crea la escena integrada, no compone sobre un fondo
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, negative_prompt, network, imageBase64, imageMediaType } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });

    const input = {
      prompt,
      aspect_ratio: ASPECT_RATIOS[network] || '1:1',
      output_format: 'jpg',
      output_quality: 95,
      safety_tolerance: 5,
    };

    // Pasar la foto del producto como imagen de referencia para FLUX.2 Pro
    // El modelo la usa para reproducir el calzado fielmente en la escena generada
    if (imageBase64 && imageMediaType) {
      input.input_images = ['data:' + imageMediaType + ';base64,' + imageBase64];
    }

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

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), model: 'FLUX.2 Pro' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio — FLUX.2 Pro');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
