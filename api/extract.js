import { IncomingForm } from 'formidable';
import fs from 'fs';

export const config = {
  api: { bodyParser: false },
};

const PROMPT_TEMPLATE = `Jesteś ekspertem CRE (commercial real estate) w Polsce. Przeanalizuj CAŁY dostarczony materiał (tekst + obrazy + dokumenty) i wyciągnij dane do oferty sprzedażowej magazynu.

Zwróć TYLKO czysty JSON bez żadnego tekstu, komentarzy, markdown ani backtick. Format:
{
  "broker_name": "",
  "broker_email": "",
  "broker_phone": "",
  "city": "",
  "street": "",
  "land_area": "",
  "plot_number": "",
  "precinct": "",
  "commune": "",
  "county": "",
  "ownership": "",
  "asking_price": "",
  "asking_price_currency": "",
  "dist_airport": "",
  "dist_expressway": "",
  "dist_port": "",
  "dist_highway": "",
  "dist_railway": "",
  "dist_transit": "",
  "description": "",
  "building_footprint": "",
  "total_area": "",
  "parking_spots": "",
  "warehouse_area": "",
  "office_area": "",
  "year_modernization": "",
  "asking_price_building": "",
  "asking_price_building_currency": "",
  "num_tenants": "",
  "occupancy": "",
  "noi": "",
  "noi_currency": "",
  "yield_pct": "",
  "price_sale": "",
  "price_sale_currency": "",
  "rent_income": "",
  "rent_income_currency": "",
  "service_charge": "",
  "service_charge_currency": "",
  "gross_income": "",
  "gross_income_currency": "",
  "eur_pln_rate": "",
  "mpzp_resolution": "",
  "terrain_card": "",
  "terrain_function": "",
  "excluded_functions": "",
  "building_area_min": "",
  "building_area_max": "",
  "intensity_min": "",
  "intensity_max": "",
  "height_max": "",
  "bio_surface_min": ""
}

ZASADY KRYTYCZNE:
- Wyciągaj TYLKO informacje obecne w dostarczonych materiałach. NIE wymyślaj danych. Jeśli brak → "".
- Analizuj WSZYSTKIE dostarczone źródła (tekst, obrazy, dokumenty) i połącz dane.
- Jeśli te same dane pojawiają się w wielu źródłach, użyj najdokładniejszej wersji.
- Wartości tekstowe (city, street, commune, county, precinct, plot_number, terrain_card, terrain_function, excluded_functions) pisz WIELKĄ LITERĄ (CAPSLOCK).
- WYJĄTEK: pole "description" pisz normalnym zdaniem, NIE capslockiem.
- Ceny/NOI/przychody: TYLKO liczba z spacjami co 3 cyfry, np. "48 500 000". BEZ waluty w wartości.
- Walutę zwracaj OSOBNO w polach *_currency: "PLN" lub "EUR".
- Powierzchnie: liczby z spacjami, np. "12 500". Bez jednostek.
- Odległości: same liczby, np. "15".
- Procenty: z przecinkiem jako separatorem dziesiętnym i znakiem %, np. "7,05%".

OWNERSHIP:
- "pełna własność", "prawo własności", "freehold" → "WŁASNOŚĆ"
- "użytkowanie wieczyste", "perpetual usufruct" → "UŻYTKOWANIE WIECZYSTE"
- Jeśli brak → ""

MPZP:
- "mpzp_resolution": TYLKO realny numer uchwały. Jeśli brak → "".
- "terrain_card": oznaczenie terenu, np. "P/U", "7U". NIE opis funkcji.
- "terrain_function": opis funkcji terenu.
- "excluded_functions": TYLKO jeśli wprost podane.
- Parametry zabudowy: TYLKO jeśli wprost podane.

DESCRIPTION: 3 akapity oddzielone \\n (działki/ha, lokalizacja, zabudowa). Normalnym zdaniem.
PRICE BUILDING: jeśli brak osobnej ceny, przepisz z asking_price/asking_price_currency.`;

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      maxFileSize: 25 * 1024 * 1024,
      maxFiles: 10,
      keepExtensions: true,
      multiples: true,
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function extractTextFromPdf(buffer) {
  try {
    // Dynamic import to handle different module formats
    let pdfParse;
    try {
      pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    } catch (e1) {
      try {
        pdfParse = (await import('pdf-parse')).default;
      } catch (e2) {
        const mod = await import('pdf-parse');
        pdfParse = mod.default || mod;
      }
    }
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    console.error('[PDF PARSE ERROR]', e.message, e.stack?.split('\n')[1]);
    return '';
  }
}

function isImage(mime) {
  return (mime || '').startsWith('image/');
}

function getExt(filename) {
  return (filename || '').toLowerCase().split('.').pop();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  let textContent = '';
  let imageContents = [];
  let warnings = [];
  let debugInfo = { filesReceived: 0, fileDetails: [] };

  const contentType = req.headers['content-type'] || '';
  console.log('[EXTRACT] Content-Type:', contentType);

  if (contentType.includes('multipart/form-data')) {
    const { fields, files } = await parseForm(req);

    // Debug: log raw structure
    console.log('[EXTRACT] Fields keys:', Object.keys(fields));
    console.log('[EXTRACT] Files keys:', Object.keys(files));
    console.log('[EXTRACT] Files structure:', JSON.stringify(Object.keys(files).map(k => {
      const v = files[k];
      if (Array.isArray(v)) return { key: k, count: v.length, names: v.map(f => f?.originalFilename) };
      return { key: k, name: v?.originalFilename };
    })));

    // Get text field - formidable v3 returns arrays for fields
    const textField = fields.text;
    textContent = Array.isArray(textField) ? (textField[0] || '') : (textField || '');
    console.log('[EXTRACT] Text from textarea:', textContent.length, 'chars');

    // Normalize file list - formidable v3 always returns arrays
    // But files might be under 'files' key or other keys
    let fileList = [];
    for (const key of Object.keys(files)) {
      const val = files[key];
      if (Array.isArray(val)) {
        fileList = fileList.concat(val);
      } else if (val && val.filepath) {
        fileList.push(val);
      }
    }

    debugInfo.filesReceived = fileList.length;
    console.log('[EXTRACT] Total files found:', fileList.length);

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file || !file.filepath) {
        console.log('[EXTRACT] File', i, ': INVALID (no filepath)');
        continue;
      }

      const filename = file.originalFilename || file.newFilename || 'unknown';
      const mime = file.mimetype || '';
      const ext = getExt(filename);
      let fileSize = 0;
      try { fileSize = fs.statSync(file.filepath).size; } catch (e) {}

      console.log('[EXTRACT] File', i, ':', {
        name: filename,
        mime: mime,
        ext: ext,
        size: fileSize,
        filepath: file.filepath,
      });

      const fileDebug = { name: filename, mime, size: fileSize, type: '', textLength: 0 };

      // Determine type by extension (more reliable than MIME on some systems)
      const isPdf = ext === 'pdf' || mime === 'application/pdf';
      const isImg = isImage(mime) || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
      const isTxt = ext === 'txt' || mime === 'text/plain';

      if (isPdf) {
        fileDebug.type = 'pdf';
        console.log('[EXTRACT] Processing PDF:', filename);

        try {
          const buf = fs.readFileSync(file.filepath);
          console.log('[EXTRACT] PDF buffer size:', buf.length, 'bytes');

          const pdfText = await extractTextFromPdf(buf);
          fileDebug.textLength = pdfText.length;

          console.log('[EXTRACT] PDF extracted text length:', pdfText.length, 'chars');
          if (pdfText.length > 0) {
            console.log('[EXTRACT] PDF first 500 chars:', pdfText.substring(0, 500));
            textContent += '\n\n--- DOKUMENT PDF: ' + filename + ' ---\n' + pdfText;
          } else {
            console.log('[EXTRACT] PDF: NO TEXT EXTRACTED');
            warnings.push('PDF "' + filename + '" nie zawiera tekstu możliwego do odczytu — spróbuj wkleić tekst ręcznie.');
            textContent += '\n\n--- PDF BEZ TEKSTU: ' + filename + ' (skan — brak tekstu do ekstrakcji) ---';
          }
        } catch (e) {
          console.error('[EXTRACT] PDF processing error:', e.message);
          warnings.push('Błąd przetwarzania PDF "' + filename + '": ' + e.message);
        }
      } else if (isImg) {
        fileDebug.type = 'image';
        console.log('[EXTRACT] Processing image:', filename);
        try {
          const buf = fs.readFileSync(file.filepath);
          const b64 = buf.toString('base64');
          const imgMime = mime.startsWith('image/') ? mime : ('image/' + (ext === 'jpg' ? 'jpeg' : ext));
          imageContents.push({ base64: b64, mime: imgMime, name: filename });
          console.log('[EXTRACT] Image added, base64 length:', b64.length);
        } catch (e) {
          console.error('[EXTRACT] Image read error:', e.message);
        }
      } else if (isTxt) {
        fileDebug.type = 'txt';
        try {
          const txt = fs.readFileSync(file.filepath, 'utf-8');
          fileDebug.textLength = txt.length;
          textContent += '\n\n--- PLIK TXT: ' + filename + ' ---\n' + txt;
          console.log('[EXTRACT] TXT:', txt.length, 'chars');
        } catch (e) {
          console.error('[EXTRACT] TXT read error:', e.message);
        }
      } else {
        fileDebug.type = 'unknown';
        console.log('[EXTRACT] Skipping unknown file type:', filename, mime);
        warnings.push('Pominięto plik "' + filename + '" — nieobsługiwany format.');
      }

      debugInfo.fileDetails.push(fileDebug);

      // Clean up temp file
      try { fs.unlinkSync(file.filepath); } catch (e) {}
    }
  } else {
    // JSON body (backward compatible)
    console.log('[EXTRACT] JSON body mode');
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      textContent = body.text || '';
    } catch (e) {
      console.error('[EXTRACT] JSON parse error:', e.message);
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  console.log('[EXTRACT] Final text content length:', textContent.length, 'chars');
  console.log('[EXTRACT] Images count:', imageContents.length);
  console.log('[EXTRACT] Warnings:', warnings);

  if (!textContent.trim() && imageContents.length === 0) {
    return res.status(400).json({
      error: 'No content provided',
      warnings: warnings,
      debug: debugInfo,
    });
  }

  // Build OpenAI message
  const userContent = [];
  let fullPrompt = PROMPT_TEMPLATE;
  if (textContent.trim()) {
    fullPrompt += '\n\nMateriał tekstowy do analizy:\n' + textContent;
  }
  if (imageContents.length > 0) {
    fullPrompt += '\n\nDodatkowo załączono ' + imageContents.length + ' obraz(ów) — przeanalizuj je (OCR + ekstrakcja danych).';
  }

  console.log('[EXTRACT] Final prompt length:', fullPrompt.length, 'chars');

  userContent.push({ type: 'text', text: fullPrompt });

  for (const img of imageContents) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: 'data:' + img.mime + ';base64,' + img.base64,
        detail: 'high',
      },
    });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: 'Jesteś asystentem CRE. Zwracasz TYLKO czysty JSON. Bez markdown, bez backtick, bez komentarzy. Analizujesz tekst I obrazy.' },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[EXTRACT] OpenAI error:', response.status, errText.substring(0, 500));
      return res.status(502).json({ error: 'OpenAI API error', details: errText, warnings });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('[EXTRACT] JSON parse failed:', clean.substring(0, 200));
      return res.status(502).json({ error: 'Failed to parse AI response', raw: clean, warnings });
    }

    // Add warnings to response
    if (warnings.length > 0) {
      parsed._warnings = warnings;
    }

    console.log('[EXTRACT] Success! Fields filled:', Object.values(parsed).filter(v => v && v !== '').length);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('[EXTRACT] Server error:', err.message, err.stack);
    return res.status(500).json({ error: 'Server error', message: err.message, warnings });
  }
}
