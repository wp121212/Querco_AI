export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const prompt = `Jesteś ekspertem CRE (commercial real estate) w Polsce. Przeanalizuj poniższy materiał i wyciągnij dane do oferty sprzedażowej magazynu.

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
  "price_pln": "",
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
  "price_pln_building": "",
  "num_tenants": "",
  "occupancy": "",
  "noi_eur": "",
  "yield_pct": "",
  "price_eur": "",
  "rent_income_pln": "",
  "service_charge_eur": "",
  "gross_income_eur": "",
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

ZASADY:
- Wyciągaj TYLKO informacje obecne w tekście. NIE wymyślaj danych.
- Jeśli danej informacji nie ma w tekście, zostaw puste "" — nie zgaduj.
- Ceny formatuj z spacjami co 3 cyfry, np. "28 000 000 PLN"
- Powierzchnie jako liczby z spacjami, np. "12 500"
- Odległości jako same liczby, np. "15"
- description: 3 akapity oddzielone \\n — akapit 1: działki i powierzchnia, akapit 2: lokalizacja, akapit 3: zabudowa. Generuj na podstawie dostępnych danych.
- price_pln_building: jeśli nie ma osobnej ceny dla zabudowy, przepisz z price_pln
- Nie dodawaj żadnego tekstu poza JSON

Materiał do analizy:
${text}`;

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
        messages: [
          { role: 'system', content: 'Jesteś asystentem CRE. Zwracasz TYLKO czysty JSON. Bez markdown, bez backtick, bez komentarzy.' },
          { role: 'user', content: prompt },
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
