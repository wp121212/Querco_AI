import { IncomingForm } from 'formidable';
import fs from 'fs';

export const config = {
  api: { bodyParser: false },
};

const PROMPT_TEMPLATE = `
Jesteś ekspertem CRE w Polsce. Analizujesz tekst oferty sprzedażowej nieruchomości magazynowej / produkcyjnej.

Zwróć TYLKO czysty JSON. Bez markdown, bez komentarzy, bez backticków.

Zasady:
- Nie wymyślaj danych.
- Jeśli informacji nie ma w materiale, zwróć pusty string "".
- Krótkie wartości tekstowe pisz CAPSLOCKIEM.
- Description pisz normalnym zdaniem.
- Ceny podawaj jako samą liczbę, bez waluty, np. "12 000 000".
- Walutę podawaj osobno jako "PLN" albo "EUR".
- Powierzchnie podawaj jako samą liczbę, bez m².
- Procenty podawaj ze znakiem %, np. "98%".
- Jeśli cena dla slajdu 3 nie jest osobno podana, przepisz asking_price do asking_price_building.

Zwróć JSON dokładnie w tym schemacie:
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
`;

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

function cleanJsonText(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

async function extractTextFromPdfBuffer(buffer) {
  try {
    let pdfParse;

    try {
      const mod = await import('pdf-parse/lib/pdf-parse.js');
      pdfParse = mod.default || mod;
    } catch (e1) {
      const mod = await import('pdf-parse');
      pdfParse = mod.default || mod;
    }

    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    console.error('[PDF PARSE ERROR]', e.message);
    return '';
  }
}

function getExt(filename) {
  return String(filename || '').toLowerCase().split('.').pop();
}

function normalizeFiles(files) {
  let list = [];

  for (const key of Object.keys(files || {})) {
    const value = files[key];

    if (Array.isArray(value)) {
      list = list.concat(value);
    } else if (value && value.filepath) {
      list.push(value);
    }
  }

  return list;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is missing in Vercel' });
  }

  try {
    const { fields, files } = await parseForm(req);

    const textField = fields.text;
    let textContent = Array.isArray(textField) ? textField[0] || '' : textField || '';

    const fileList = normalizeFiles(files);

    for (const file of fileList) {
      const filename = file.originalFilename || file.newFilename || '';
      const ext = getExt(filename);

      if (ext === 'pdf') {
        try {
          const buffer = fs.readFileSync(file.filepath);
          const pdfText = await extractTextFromPdfBuffer(buffer);

          if (pdfText && pdfText.trim()) {
            textContent += '\n\n--- TEKST Z PDF: ' + filename + ' ---\n' + pdfText;
          }
        } catch (e) {
          console.error('[PDF READ ERROR]', e.message);
        }
      }

      if (ext === 'txt') {
        try {
          const txt = fs.readFileSync(file.filepath, 'utf-8');
          textContent += '\n\n--- TEKST Z TXT: ' + filename + ' ---\n' + txt;
        } catch (e) {
          console.error('[TXT READ ERROR]', e.message);
        }
      }

      try {
        fs.unlinkSync(file.filepath);
      } catch (e) {}
    }

    if (!textContent.trim()) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const fullPrompt =
      PROMPT_TEMPLATE +
      '\n\nMateriał do analizy:\n' +
      textContent.slice(0, 90000);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 2500,
        messages: [
          {
            role: 'system',
            content: 'Zwracasz wyłącznie poprawny JSON. Nie dodajesz markdown ani komentarzy.',
          },
          {
            role: 'user',
            content: fullPrompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[OPENAI ERROR]', response.status, errText);

      return res.status(502).json({
        error: 'OpenAI API error',
        details: errText,
      });
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '';

    let parsed;

    try {
      parsed = JSON.parse(cleanJsonText(raw));
    } catch (e) {
      console.error('[JSON PARSE ERROR]', e.message, raw);

      return res.status(500).json({
        error: 'AI returned invalid JSON',
        raw: raw,
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('[SERVER ERROR]', err);

    return res.status(500).json({
      error: err.message || 'Server error',
    });
  }
}