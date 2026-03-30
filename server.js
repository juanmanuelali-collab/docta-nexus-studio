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
    colorPrimary: get(/Principal:\s*(#[0-9A-Fa-f]{6})/) || '#c8f135',
    colorAccent:  get(/Acento:\s*(#[0-9A-Fa-f]{6})/)    || '#888888',
    colorBtnText: get(/Texto sobre botones:\s*(#[0-9A-Fa-f]{6})/) || '#ffffff',
  };
}

app.use(express.json({ limit: '30mb' }));

const publicPath = path.join(__dirname, 'public');
console.log('STATIC PATH:', publicPath);
app.use(express.static(publicPath));

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
  const system = `${md}\n\n---\n\n## Tu rol como agente de dirección de arte\n\nSos el agente visual de esta marca. Las instrucciones anteriores son tu identidad y criterio estético.\n\n### REGLA ABSOLUTA 1 — La foto NO se modifica jamás\nGenerás ÚNICAMENTE el fondo/ambiente. La foto original se superpone intacta en el browser.\n\n### REGLA ABSOLUTA 2 — Los CTAs son INMUTABLES\nLos textos de CTAs se usan EXACTAMENTE como el usuario los escribió.\n\nRespondé ÚNICAMENTE con este JSON válido (sin markdown, sin backticks):\n{\n  "analysis": {\n    "subject": "qué hay en la foto",\n    "style": "estilo fotográfico",\n    "colors": "paleta detectada",\n    "mood": "tono emocional",\n    "lighting": "tipo de iluminación"\n  },\n  "background_prompt": "prompt completo en inglés para el fondo. Incluir: background only, no people, no text, no watermarks, studio quality, 4K",\n  "negative_prompt": "no people, no faces, no text, no watermarks, blur, low quality",\n  "cta_style": {\n    "style": "minimal|bold|elegant|playful",\n    "position": "bottom|top|bottom-right|overlay",\n    "color_primary": "#hex de la paleta de la marca",\n    "color_text": "#hex para el texto del botón",\n    "shape": "pill|rectangle|banner"\n  },\n  "logo_position": "top-left|top-right|bottom-left|bottom-right",\n  "composition_note": "cómo componer la foto sobre el fondo"\n}`;
  const msg = `Descripción del usuario: ${userPrompt || 'No especificada'}\nCTAs EXACTOS (inmutables): ${ctas.join(' | ')}\nRed social: ${networkLabels[network] || 'Instagram Feed'}\nLogo incluido: ${logoBase64 ? 'Sí' : 'No'}`;
  const content = [{ type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }];
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
  catch { throw new Error('El agente no devolvió JSON válido.'); }
}

async function generateCopy({ slug, imageBase64, imageMediaType, analysis, ctas, network }) {
  const md = loadClient(slug) || '';
  const nets = { instagram: 'Instagram Feed', instagram_stories: 'Instagram Stories', linkedin: 'LinkedIn', facebook: 'Facebook' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: `Sos copywriter de esta marca:\n\n${md}\n\nRed: ${nets[network] || 'Instagram'}.\nLos CTAs son INMUTABLES. Respondé ÚNICAMENTE con JSON válido, sin markdown.`,
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
  console.log(`  Clientes: ${listClients().join(', ') || 'ninguno'}\n`);
});
```

**4.** Clic en **"Commit changes"**

**5.** Esperá que Render redeploya → revisá los logs, deberías ver:
```
STATIC PATH: /opt/render/project/src/public
