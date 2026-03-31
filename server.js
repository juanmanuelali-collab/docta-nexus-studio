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

async function runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, cta4, precio, userPrompt, network }) {
  const md = loadClient(slug);
  if (!md) throw new Error(`Cliente "${slug}" no encontrado.`);

  const networkLabels = {
    instagram: 'Instagram Feed (1:1)', instagram_stories: 'Instagram Stories (9:16)',
    linkedin: 'LinkedIn (16:9)', facebook: 'Facebook (4:5)'
  };

  const system = `${md}

---

## Tu rol como director de arte

Sos un director de arte experto en campañas de ecommerce y paid media para redes sociales.
Trabajas para esta marca y usas sus instrucciones como tu criterio estetico y creativo.

## Modelo de generacion: FLUX.1 Kontext Pro

Este modelo recibe la foto del producto y la preserva EXACTAMENTE mientras genera la escena.
Es un modelo de edicion contextual — entiende el producto y lo coloca en la escena sin modificarlo.

## Las 3 reglas inquebrantables

1. El producto/foto adjunto debe aparecer IDENTICO en la pieza final. Kontext lo preserva.
2. Los logos NO se modifican. Se agregan en el browser despues.
3. Los CTAs son EXACTOS e INMUTABLES. Se agregan en el browser con el texto exacto.

## Como construir el prompt para FLUX Kontext — PATRON DE 3 CAPAS

Kontext funciona mejor con prompts estructurados en 3 capas:

CAPA 1 — ACCION: Que hacer con el producto (colocarlo en una escena, cambiar el fondo, etc.)
CAPA 2 — CONTEXTO: Descripcion detallada de la escena, ambiente, iluminacion, personas si aplica
CAPA 3 — PRESERVACION: Que debe mantenerse exacto del producto original

Ejemplo de prompt bien estructurado:
"Place this exact shoe product in a warm autumn coffee shop scene [ACCION],
with wooden floors, warm Edison bulb lighting, fallen leaves visible through the window,
a woman in background reading a book [CONTEXTO],
while keeping the shoe's exact shape, color, texture, sole design and all details perfectly preserved,
product in sharp focus in the foreground [PRESERVACION].
Photorealistic, commercial product photography quality, 8K.
Leave the bottom 25% of the image clean with minimal visual elements for text overlay."

## Regla critica sobre la zona inferior

SIEMPRE terminar el prompt con instruccion de dejar zona inferior libre:
"Leave the bottom 25% of the image as a clean, dark or neutral area with minimal visual elements,
suitable for text overlays. Do not place faces, the product, or important visual elements in the bottom 25%."

## Interpreta el brief con libertad

- Si pide persona: incluila en la escena segun el tipo de calzado y ambiente
- Si pide solo producto: genera fondo de studio premium o ambiente limpio
- Si especifica ambiente: ejecutalo exactamente
- Si no especifica: decides vos segun el producto y temporada

Responde UNICAMENTE con este JSON valido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "descripcion exacta del producto en la foto",
    "style": "estilo fotografico del producto",
    "colors": "colores exactos del producto",
    "mood": "tono emocional sugerido",
    "lighting": "tipo de iluminacion del producto"
  },
  "background_prompt": "prompt completo en ingles con las 3 capas: accion + contexto + preservacion. Incluir instruccion de zona inferior libre.",
  "negative_prompt": "text, logos, watermarks, low quality, blur, distorted product, modified product, different product, changed colors",
  "cta_style": {
    "style": "minimal|bold|elegant|playful",
    "position": "bottom",
    "color_primary": "#hex basado en la paleta de la marca",
    "color_text": "#hex para el texto del boton",
    "shape": "pill|rectangle|banner"
  },
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "descripcion de la composicion para entender donde agregar logo y CTAs"
}`;

  const msg = `Descripcion del usuario: ${userPrompt || 'No especificada'}
Titulo de la pieza: ${ctas[0] || 'No especificado'}
Promocion: ${ctas[1] || 'No especificada'}
Boton CTA: ${ctas[2] || 'No especificado'}
Texto extra: ${cta4 || 'No'}
Precio: ${precio || 'No'}
Red social: ${networkLabels[network] || 'Instagram Feed'}
Logo incluido: ${logoBase64 ? 'Si (PNG transparente — posicion amena segun composicion)' : 'No'}

Si hay precio, incluirlo en la composicion de forma armonica (badge o texto flotante).
Todos los textos se agregan en el browser — dejar zona inferior limpia para los textos.`;

  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }
  ];
  if (logoBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: logoMediaType, data: logoBase64 } });
    content.push({ type: 'text', text: '(Segunda imagen: logo del cliente.)\n\n' + msg });
  } else {
    content.push({ type: 'text', text: msg });
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, system, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Error en agente Claude');
  const text = data.content.map(b => b.text || '').join('');
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { throw new Error('El agente no devolvió JSON válido. Intentá de nuevo.'); }
}

async function generateCopy({ slug, imageBase64, imageMediaType, analysis, ctas, network }) {
  const md = loadClient(slug) || '';
  const nets = { instagram: 'Instagram Feed', instagram_stories: 'Instagram Stories', linkedin: 'LinkedIn', facebook: 'Facebook' };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: `Sos copywriter de esta marca:\n\n${md}\n\nRed: ${nets[network] || 'Instagram'}.\nLos CTAs son INMUTABLES, usá el texto exacto.\nRespondé ÚNICAMENTE con JSON válido, sin markdown.`,
      messages: [{
        role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
          { type: 'text', text: `Análisis: ${analysis.subject} | ${analysis.mood}\nCTAs: ${ctas.join(' | ')}\n\nJSON:\n{"hook":"","caption":"","cta_recomendado":"","hashtags":[],"variacion_b":"","tip":""}` }
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

app.post('/api/analyze', async (req, res) => {
  try {
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, cta4, precio, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });
    res.json(await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, cta4, precio, userPrompt, network }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, negative_prompt, network, imageBase64, imageMediaType } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });

    const input = {
      prompt,
      aspect_ratio: ASPECT_RATIOS[network] || '1:1',
      output_format: 'jpg',
      output_quality: 95,
      safety_tolerance: 2,
      ...(negative_prompt && { negative_prompt })
    };

    // FLUX Kontext recibe la foto del producto y la preserva exactamente
    if (imageBase64 && imageMediaType) {
      input.input_image = `data:${imageMediaType};base64,${imageBase64}`;
    }

    const r = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=20'
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
    const r = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` }
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

// Catch-all: cualquier ruta que no sea /api/* devuelve el frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n✦ Docta Nexus Studio — http://localhost:${PORT}`);
  console.log(`  Clientes: ${listClients().join(', ') || 'ninguno aún'}\n`);
});
