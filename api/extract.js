import { IncomingForm } from 'formidable';
import fs from 'fs';
import pdf from 'pdf-parse/lib/pdf-parse.js';

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
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function extractTextFromPdf(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text || '';
  } catch (e) {
    console.error('PDF parse error:', e.message);
    return '';
  }
}

function fileToBase64(filepath) {
  const buf = fs.readFileSync(filepath);
  return buf.toString('base64');
}

function getMimeType(filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
    txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

function isImage(mime) {
  return mime.startsWith('image/');
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
  let imageContents = []; // { base64, mime }

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    // Multipart: text + files
    const { fields, files } = await parseForm(req);
    textContent = (Array.isArray(fields.text) ? fields.text[0] : fields.text) || '';

    // files can be { files: [File, File] } or { files: File }
    let fileList = files.files || [];
    if (!Array.isArray(fileList)) fileList = [fileList];

    for (const file of fileList) {
      if (!file || !file.filepath) continue;
      const mime = file.mimetype || getMimeType(file.originalFilename);

      if (mime === 'application/pdf') {
        const buf = fs.readFileSync(file.filepath);
        const pdfText = await extractTextFromPdf(buf);
        if (pdfText.trim()) {
          textContent += '\n\n--- DOKUMENT PDF: ' + (file.originalFilename || 'plik.pdf') + ' ---\n' + pdfText;
        } else {
          // PDF with no extractable text — might be scanned, send as images would need pdf-to-image
          // For now, note it
          textContent += '\n\n--- PDF BEZ TEKSTU: ' + (file.originalFilename || 'plik.pdf') + ' (skan — brak tekstu do ekstrakcji) ---';
        }
      } else if (isImage(mime)) {
        const b64 = fileToBase64(file.filepath);
        imageContents.push({ base64: b64, mime: mime, name: file.originalFilename || 'image' });
      } else if (mime === 'text/plain') {
        const txt = fs.readFileSync(file.filepath, 'utf-8');
        textContent += '\n\n--- PLIK TXT: ' + (file.originalFilename || 'plik.txt') + ' ---\n' + txt;
      }
      // Clean up temp file
      try { fs.unlinkSync(file.filepath); } catch (e) {}
    }
  } else {
    // JSON body (backward compatible)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    textContent = body.text || '';
  }

  if (!textContent.trim() && imageContents.length === 0) {
    return res.status(400).json({ error: 'No content provided' });
  }

  // Build OpenAI message content array
  const userContent = [];

  // Text prompt + extracted text
  let fullPrompt = PROMPT_TEMPLATE;
  if (textContent.trim()) {
    fullPrompt += '\n\nMateriał tekstowy do analizy:\n' + textContent;
  }
  if (imageContents.length > 0) {
    fullPrompt += '\n\nDodatkowo załączono ' + imageContents.length + ' obraz(ów) — przeanalizuj je (OCR + ekstrakcja danych).';
  }

  userContent.push({ type: 'text', text: fullPrompt });

  // Add images for vision
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
    // Use gpt-4o-mini for vision + text (supports images natively)
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
      const err = await response.text();
      return res.status(502).json({ error: 'OpenAI API error', details: err });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to parse AI response', raw: clean });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}
