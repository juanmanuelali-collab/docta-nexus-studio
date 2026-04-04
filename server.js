require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

const ASPECT_RATIOS = {
  instagram: '1:1', instagram_stories: '9:16',
  linkedin:  '16:9', facebook: '4:5'
};

function loadClient(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  const fp = path.join(__dirname, 'clients', `${slug}.md`);
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
// Claude analiza las imagenes y genera el PROMPT para FLUX.
// La imagen de referencia SOLO la ve Claude para inspirarse — NO se pasa a FLUX.
// FLUX recibe la foto del producto como input_image y genera la pieza completa.

async function runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, refImageBase64, refImageMediaType, ctas, userPrompt, network }) {
  const md = loadClient(slug);
  if (!md) throw new Error('Cliente "' + slug + '" no encontrado.');

  const networkLabels = {
    instagram: 'Instagram Feed (1:1)', instagram_stories: 'Instagram Stories (9:16)',
    linkedin: 'LinkedIn (16:9)', facebook: 'Facebook (4:5)'
  };

  const hasRef = !!(refImageBase64 && refImageMediaType);

  const system = md + `

---

## Tu unico rol: generar el PROMPT para FLUX Kontext Pro

Sos un director de arte experto en ecommerce y paid media.
Tu tarea es analizar la foto del producto (y la referencia si hay) y generar un prompt creativo.

## Como funciona el pipeline

1. Vos (Claude) generates el prompt con descripcion de la escena
2. FLUX Kontext Pro recibe ese prompt + la foto del producto como input_image
3. FLUX integra el producto en la escena que describas — de forma natural y fotorrealista
4. El browser agrega logo y CTAs encima respetando las zonas seguras

Por eso tu prompt debe describir la ESCENA COMPLETA donde el producto va a quedar integrado.

## Imagen de referencia

Si hay imagen de referencia: ANALIZALA PROFUNDAMENTE.
Extrae su estilo visual, paleta, composicion, recursos graficos y mood.
Luego INSPIRA el prompt en esa estetica — crea algo ORIGINAL con ese look and feel.
NO menciones ni describas la imagen de referencia en el prompt — usala solo como inspiracion.

## Libertad creativa total

Tenes libertad TOTAL para elegir escena, ambiente, iluminacion y composicion.
Pensa como director de arte de agencia top: sorprendente, memorable, que convierta.

## Zonas seguras

Si el userPrompt define ZONAS SEGURAS, instruye a FLUX:
Menciona en el prompt que esas areas deben tener fondo oscuro neutro o gradiente suave
para que los textos que se superpondran sean perfectamente legibles.
Ejemplo: "leave bottom 25% with dark neutral gradient suitable for text overlay"

## Construccion del prompt para FLUX

- En ingles, descriptivo, rico en detalles visuales
- Incluir: estilo fotografico, camara, lente, ambiente, iluminacion, como se integra el producto
- Las zonas libres si aplica
- Terminar SIEMPRE con: "the product from the reference image naturally integrated in the scene, photorealistic, commercial photography quality, ultra high quality, 8K, no text, no logos, no watermarks"

Responde UNICAMENTE con JSON valido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripcion del producto",
    "style": "estilo detectado",
    "colors": "paleta del producto",
    "mood": "tono emocional sugerido",
    "lighting": "iluminacion del producto"
  },
  "background_prompt": "prompt completo en ingles para FLUX — escena + integracion del producto + zonas libres",
  "negative_prompt": "text, logos, watermarks, low quality, blur, distortion, duplicate product",
  "cta_style": {
    "style": "minimal|bold|elegant|playful",
    "position": "bottom|top|bottom-right|overlay",
    "color_primary": "#hex basado en la paleta de la marca",
    "color_text": "#hex para el texto del boton",
    "shape": "pill|rectangle|banner"
  },
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripcion de la composicion para entender donde van logo y CTAs"
}`;

  const msg = 'Descripcion del usuario: ' + (userPrompt || 'No especificada') + '\n' +
    'CTAs (contexto, NO van en el prompt de imagen): ' + ctas.join(' | ') + '\n' +
    'Red social: ' + (networkLabels[network] || 'Instagram Feed') + '\n' +
    'Logo incluido: ' + (logoBase64 ? 'Si' : 'No') + '\n' +
    'Imagen de referencia: ' + (hasRef ? 'Si — extraer estilo y mood' : 'No') + '\n\n' +
    'Imagenes:\n' +
    '- Img 1: FOTO DEL PRODUCTO — analizar producto, describir en analysis\n' +
    (logoBase64 ? '- Img 2: LOGO DEL CLIENTE — solo contexto visual\n' : '') +
    (hasRef ? '- Img ' + (logoBase64 ? '3' : '2') + ': REFERENCIA VISUAL — inspirarse en su estetica\n' : '');

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
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, system, messages: [{ role: 'user', content }] })
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
      system: 'Sos copywriter de esta marca:\n\n' + md + '\n\nRed: ' + (nets[network] || 'Instagram') + '.\nLos CTAs son INMUTABLES, usa el texto exacto.\nResponde UNICAMENTE con JSON valido, sin markdown.',
      messages: [{
        role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
          { type: 'text', text: 'Analisis: ' + analysis.subject + ' | ' + analysis.mood + '\nCTAs: ' + ctas.join(' | ') + '\n\nJSON:\n{"hook":"","caption":"","cta_recomendado":"","hashtags":[],"variacion_b":"","tip":""}' }
        ]
      }]
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

// FLUX Kontext Pro — recibe foto del producto como input_image
// La imagen de referencia NO se pasa aqui — solo Claude la vio para generar el prompt
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

    // Pasar la foto del producto a FLUX para que la integre en la escena
    if (imageBase64 && imageMediaType) {
      input.input_image = 'data:' + imageMediaType + ';base64,' + imageBase64;
    }

    if (negative_prompt) input.negative_prompt = negative_prompt;

    const r = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN, 'Content-Type': 'application/json', 'Prefer': 'wait=20' },
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

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients() }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio — http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
