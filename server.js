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

## Textos en la pieza

Los CTAs deben aparecer integrados en la imagen generada por FLUX.
Si hay zonas seguras definidas: colocar los textos exactamente en esas zonas.
Si no hay zonas: decidir la mejor ubicacion segun la composicion.

## Zonas seguras

Si el userPrompt define ZONAS SEGURAS, respetarlas en el prompt.
Indicar a FLUX que esas areas tengan fondo neutro adecuado para los textos.

## Construccion del prompt

En ingles, descriptivo, rico en detalles:
1. ESCENA: Ambiente, iluminacion, hora, mood
2. PRODUCTOS: Como aparece cada producto (con sus caracteristicas exactas de las fotos)
3. COMPOSICION: Disposicion de los productos en la escena
4. TEXTOS: Cada CTA con estilo tipografico y ubicacion
5. ESTILO: Camara, lente, profundidad de campo
6. CIERRE: "ultra photorealistic, commercial advertising photography, 8K resolution, no watermarks"

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

  const photoCount = totalPhotos + (hasRef ? 1 : 0) + (logoBase64 ? 1 : 0);
  const msg = 'Descripcion del usuario: ' + (userPrompt || 'No especificada') + '\n' +
    'TEXTOS A INTEGRAR EN LA IMAGEN (exactos e inmutables):\n' +
    ctas.map((c, i) => '  - Texto ' + (i+1) + ': "' + c + '"').join('\n') + '\n' +
    'Red social: ' + (networkLabels[network] || 'Feed') + '\n' +
    'Cantidad de productos: ' + totalPhotos + '\n' +
    'Logo incluido: ' + (logoBase64 ? 'Si (se agrega en el browser, NO en el prompt)' : 'No') + '\n' +
    'Imagen de referencia de estilo: ' + (hasRef ? 'Si — extraer estilo y mood' : 'No') + '\n\n' +
    'Imagenes recibidas:\n' +
    '- Img 1: PRODUCTO PRINCIPAL\n' +
    (hasExtras ? extraPhotos.map((_, i) => '- Img ' + (i+2) + ': PRODUCTO ' + (i+2) + '\n').join('') : '') +
    (logoBase64 ? '- Img ' + (1 + (hasExtras?extraPhotos.length:0) + 1) + ': LOGO — solo contexto\n' : '') +
    (hasRef ? '- Img ' + photoCount + ': REFERENCIA VISUAL — extraer estilo\n' : '') +
    (totalPhotos > 1 ? '\nIMPORTANTE: El prompt debe describir una composicion con los ' + totalPhotos + ' productos integrados juntos en la escena.' : '');

  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } }
  ];
  if (hasExtras) {
    extraPhotos.forEach(p => {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
    });
  }
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
    const { slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
            refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network } = req.body;
    if (!slug || !imageBase64 || !ctas?.length) return res.status(400).json({ error: 'Faltan campos.' });
    res.json(await runAgent({ slug, imageBase64, imageMediaType, logoBase64, logoMediaType,
      refImageBase64, refImageMediaType, extraPhotos, ctas, userPrompt, network }));
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

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), model: 'FLUX.2 Pro' }));

// ── VIDEO — imagen a video con Kling v2.1 ─────────────────────
app.post('/api/generate-video', async (req, res) => {
  try {
    const { imageBase64, prompt, duration } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Falta la imagen.' });

    // Paso 1: subir la imagen a Replicate para obtener una URL publica
    // Kling no acepta base64 directo — necesita una URL o un file upload
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

    const imageUrl = uploadData.urls?.get || uploadData.url;
    if (!imageUrl) return res.status(500).json({ error: 'No se obtuvo URL de la imagen' });

    // Paso 2: llamar a Kling con la URL de la imagen
    const input = {
      prompt: prompt || 'cinematic product advertisement, smooth slow camera movement, professional commercial quality',
      start_image: imageUrl,
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Docta Nexus Studio — FLUX.2 Pro');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
