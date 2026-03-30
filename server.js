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

async function runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, userPrompt, network }) {
  const md = loadClient(slug);
  if (!md) throw new Error(`Cliente "${slug}" no encontrado.`);

  const networkLabels = {
    instagram: 'Instagram Feed (1:1)', instagram_stories: 'Instagram Stories (9:16)',
    linkedin: 'LinkedIn (16:9)', facebook: 'Facebook (4:5)'
  };

  const system = `${md}

---

## Tu rol como director de arte

Sos un director de arte experto en campañas de ecommerce y marketing visual para redes sociales.
Trabajas para esta marca y usas sus instrucciones como tu criterio estetico y creativo.

## Las 3 reglas inquebrantables

1. El producto/foto adjunto NO se modifica. Se superpone intacto en el browser. Generates SOLO el fondo/escena.
2. Los logos NO se modifican. Se usan tal cual.
3. Los CTAs son EXACTOS e INMUTABLES. El texto es intocable. Solo decides el estilo visual del boton.

## Tu libertad creativa

Dentro de esas 3 reglas, tenes libertad total para:
- Crear escenas fotorrealistas con personas en ambientes lifestyle (cafeteria, calle, parque, interior)
- Usar iluminacion cinematografica, bokeh, texturas, profundidad de campo
- Proponer composiciones en dos planos: escena de fondo con persona + espacio para producto adelante
- Interpretar la descripcion del usuario con imaginacion y vuelo creativo
- Elegir el ambiente que mejor potencie el producto segun su categoria y temporada

El objetivo es que la escena ELEVE el producto adjunto. Piensa como director de arte de una agencia top.

## Como construir el prompt de fondo para Gemini

- En ingles, descriptivo y evocador, rico en detalles visuales
- Podes incluir personas en la escena de fondo (son parte del ambiente, no del producto)
- Deja espacio natural en primer plano para que el producto adjunto se componga adelante
- Siempre terminar con: "photorealistic, natural lighting, shallow depth of field, ultra high quality, 8K, no text, no logos, no watermarks"

Responde UNICAMENTE con este JSON valido (sin markdown, sin backticks):
{
  "analysis": {
    "subject": "que hay en la foto",
    "style": "estilo fotografico detectado",
    "colors": "paleta detectada",
    "mood": "tono emocional",
    "lighting": "tipo de iluminacion"
  },
  "background_prompt": "prompt creativo y detallado en ingles para la escena de fondo",
  "negative_prompt": "text, logos, watermarks, low quality, blur, distortion, extra limbs",
  "cta_style": {
    "style": "minimal|bold|elegant|playful",
    "position": "bottom|top|bottom-right|overlay",
    "color_primary": "#hex basado en la paleta de la marca",
    "color_text": "#hex para el texto del boton",
    "shape": "pill|rectangle|banner"
  },
  "logo_position": "top-left|top-right|bottom-left|bottom-right",
  "composition_note": "como componer el producto sobre el fondo para maximo impacto"
}`;

  const msg = `Descripción del usuario: ${userPrompt || 'No especificada'}
CTAs EXACTOS (inmutables): ${ctas.join(' | ')}
Red social: ${networkLabels[network] || 'Instagram Feed'}
Logo incluido: ${logoBase64 ? 'Sí' : 'No'}`;

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
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });
    res.json(await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType, ctas, userPrompt, network }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, negative_prompt, network } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });
    const r = await fetch('https://api.replicate.com/v1/models/google/gemini-2.5-flash-image/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json', 'Prefer': 'wait=20' },
      body: JSON.stringify({ input: { prompt, aspect_ratio: ASPECT_RATIOS[network] || '1:1', output_format: 'jpg', output_quality: 95, ...(negative_prompt && { negative_prompt }) } })
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

app.listen(PORT, () => {
  console.log(`\n✦ Docta Nexus Studio — http://localhost:${PORT}`);
  console.log(`  Clientes: ${listClients().join(', ') || 'ninguno aún'}\n`);
});
