import OpenAI from "openai";
import { basePrompt, buildExtractionPrompt } from "./prompts/base.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Uwaga: jeśli frontend NIE wyśle templateId, backend nie wie, jaki szablon jest wybrany.
// Domyślnie ustawiamy magazyn-wynajem, bo nad tym template teraz pracujesz.
const DEFAULT_TEMPLATE_ID = "magazyn-wynajem";

const MAX_SOURCE_CHARS = 90000;

const TEMPLATE_REGISTRY = {
  "magazyn-wynajem": {
    label: "Magazyn — wynajem",
    file: "magazyn-wynajem.js",
  },
  "magazyn-sprzedaz": {
    label: "Magazyn — sprzedaż",
    file: "magazyn-sprzedaz.js",
  },
  "biurowiec-sprzedaz": {
    label: "Biurowiec — sprzedaż",
    file: "biurowiec-sprzedaz.js",
  },
  "grunt-sprzedaz": {
    label: "Grunt — sprzedaż",
    file: "grunt-sprzedaz.js",
  },
  "hotel-sprzedaz": {
    label: "Hotel — sprzedaż",
    file: "hotel-sprzedaz.js",
  },

  // Możesz dodać później, gdy powstanie taki szablon:
  // "biuro-wynajem": {
  //   label: "Biuro — wynajem",
  //   file: "biuro-wynajem.js",
  // },
};

const TEMPLATE_ALIASES = {
  "warehouse-rent": "magazyn-wynajem",
  "warehouse_rent": "magazyn-wynajem",
  "template-warehouse-rent": "magazyn-wynajem",
  "rent-warehouse": "magazyn-wynajem",
  "magazyn_wynajem": "magazyn-wynajem",

  "warehouse-sale": "magazyn-sprzedaz",
  "warehouse_sale": "magazyn-sprzedaz",
  "template-sale": "magazyn-sprzedaz",
  "template-warehouse-sale": "magazyn-sprzedaz",
  "magazyn_sprzedaz": "magazyn-sprzedaz",

  "office-sale": "biurowiec-sprzedaz",
  "office_sale": "biurowiec-sprzedaz",
  "biuro-sprzedaz": "biurowiec-sprzedaz",
  "biurowiec_sprzedaz": "biurowiec-sprzedaz",

  "land-sale": "grunt-sprzedaz",
  "land_sale": "grunt-sprzedaz",
  "grunt_sprzedaz": "grunt-sprzedaz",

  "hotel-sale": "hotel-sprzedaz",
  "hotel_sale": "hotel-sprzedaz",
  "hotel_sprzedaz": "hotel-sprzedaz",
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function getBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? match[1] || match[2] : "";
}

function parseMultipartFields(buffer, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) return {};

  const body = buffer.toString("utf8");
  const parts = body.split(`--${boundary}`);
  const fields = {};

  for (const part of parts) {
    if (!part || part === "--" || part === "--\r\n") continue;

    const separator = part.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const splitIndex = part.indexOf(separator);
    if (splitIndex === -1) continue;

    const rawHeaders = part.slice(0, splitIndex);
    let value = part.slice(splitIndex + separator.length);

    const nameMatch = rawHeaders.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];

    // Ten parser jest celowo prosty:
    // frontend wysyła do backendu głównie tekst po OCR/PDF extraction.
    value = value
      .replace(/\r\n--$/g, "")
      .replace(/\n--$/g, "")
      .replace(/\r\n$/g, "")
      .replace(/\n$/g, "");

    fields[fieldName] = value;
  }

  return fields;
}

function parseUrlEncoded(buffer) {
  const params = new URLSearchParams(buffer.toString("utf8"));
  const fields = {};

  for (const [key, value] of params.entries()) {
    fields[key] = value;
  }

  return fields;
}

async function parseRequestBody(req) {
  const contentType = String(req.headers["content-type"] || "");

  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = await readRawBody(req);

  if (!raw || raw.length === 0) {
    return {};
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(raw.toString("utf8"));
  }

  if (contentType.includes("multipart/form-data")) {
    return parseMultipartFields(raw, contentType);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseUrlEncoded(raw);
  }

  const text = raw.toString("utf8").trim();

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function cleanAiJson(rawText) {
  if (!rawText) {
    throw new Error("AI returned an empty response.");
  }

  return String(rawText)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function safeJsonParse(rawText) {
  const cleaned = cleanAiJson(rawText);

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Could not parse AI JSON response: ${error.message}`);
  }
}

function normalizeTemplateId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[ą]/g, "a")
    .replace(/[ć]/g, "c")
    .replace(/[ę]/g, "e")
    .replace(/[ł]/g, "l")
    .replace(/[ń]/g, "n")
    .replace(/[ó]/g, "o")
    .replace(/[ś]/g, "s")
    .replace(/[żź]/g, "z");

  return TEMPLATE_ALIASES[normalized] || normalized;
}

function trimSource(text) {
  const value = String(text || "").trim();

  if (value.length <= MAX_SOURCE_CHARS) {
    return value;
  }

  return [
    value.slice(0, MAX_SOURCE_CHARS),
    "",
    "[SYSTEM NOTE: Source text was truncated because it exceeded MAX_SOURCE_CHARS.]",
  ].join("\n");
}

function buildSourceText(body) {
  const manualText = body.manualText || body.manual_text || "";
  const extractedText = body.extractedText || body.extracted_text || "";
  const text = body.text || "";
  const fileNames = body.fileNames || body.file_names || "";

  const parts = [];

  if (manualText) {
    parts.push(`[MANUAL_TEXT]\n${manualText}`);
  }

  if (extractedText) {
    parts.push(`[EXTRACTED_TEXT]\n${extractedText}`);
  }

  if (text) {
    parts.push(`[TEXT]\n${text}`);
  }

  if (Array.isArray(fileNames) && fileNames.length) {
    parts.push(`[FILES]\n${fileNames.join("\n")}`);
  } else if (typeof fileNames === "string" && fileNames.trim()) {
    parts.push(`[FILES]\n${fileNames}`);
  }

  return trimSource(parts.join("\n\n"));
}

function detectTemplateId(body, sourceText) {
  const explicit =
    body.templateId ||
    body.template_id ||
    body.currentTemplateKey ||
    body.current_template_key ||
    body.selectedTemplate ||
    body.selected_template ||
    body.template ||
    body.offerType ||
    body.offer_type;

  if (explicit) {
    return normalizeTemplateId(explicit);
  }

  // Obecna funkcja MPZP w Twoim froncie wysyła specjalny tekst, ale nie wysyła templateId.
  if (String(sourceText || "").includes("TRYB ANALIZY MPZP")) {
    return "mpzp";
  }

  return DEFAULT_TEMPLATE_ID;
}

async function loadTemplatePrompt(templateId) {
  if (templateId === "mpzp") {
    return {
      templateId: "mpzp",
      label: "MPZP / uchwała planistyczna",
      prompt: `
TYP ANALIZY: MPZP / UCHWAŁA PLANISTYCZNA.

Użytkownik przekazuje w materiale źródłowym konkretną kartę terenu do analizy.
Analizuj wyłącznie tę kartę terenu. Nie mieszaj parametrów z innych kart.

Zwróć JSON dokładnie z tymi polami:
{
  "mpzp_resolution": "",
  "mpzp_resolution_date": "",
  "terrain_function": "",
  "excluded_functions": "",
  "building_area_min": "",
  "building_area_max": "",
  "intensity_min": "",
  "intensity_max": "",
  "height_max": "",
  "bio_surface_min": ""
}
`.trim(),
    };
  }

  const config = TEMPLATE_REGISTRY[templateId];

  if (!config) {
    const supported = Object.keys(TEMPLATE_REGISTRY).join(", ");

    throw new Error(
      `Unknown templateId "${templateId}". Supported templateIds: ${supported}.`
    );
  }

  try {
    const module = await import(`./prompts/${config.file}`);

    const prompt =
      module.default ||
      module.templatePrompt ||
      module.prompt ||
      module.magazynWynajemPrompt ||
      module.magazynSprzedazPrompt ||
      module.biurowiecSprzedazPrompt ||
      module.gruntSprzedazPrompt ||
      module.hotelSprzedazPrompt;

    if (!prompt || typeof prompt !== "string") {
      throw new Error(
        `Prompt file "${config.file}" must export a string as default, templatePrompt or prompt.`
      );
    }

    return {
      templateId,
      label: config.label,
      prompt,
    };
  } catch (error) {
    throw new Error(
      `Could not load prompt for templateId "${templateId}" from api/prompts/${config.file}. ${error.message}`
    );
  }
}

function normalizeCurrency(value) {
  const raw = String(value || "").trim().toUpperCase();

  if (!raw) return "";
  if (raw.includes("EUR") || raw.includes("EURO")) return "EUR";
  if (raw.includes("PLN") || raw.includes("ZŁ") || raw.includes("ZL")) return "PLN";

  return raw;
}

function normalizeResultForFrontend(parsed, templateId) {
  const result = { ...(parsed || {}) };

  // Lekka normalizacja pod obecne pola w HTML.
  // Docelowo konkretne nazwy pól powinny wynikać z prompta danego template'u.
  const currencyKeys = [
    "asking_price_currency",
    "asking_price_building_currency",
    "noi_currency",
    "price_sale_currency",
    "rent_income_currency",
    "service_charge_currency",
    "gross_income_currency",
    "wr_warehouse_base_rent_currency",
    "wr_warehouse_effective_rent_currency",
    "wr_office_base_rent_currency",
    "wr_service_charge_currency",
  ];

  for (const key of currencyKeys) {
    if (result[key]) {
      result[key] = normalizeCurrency(result[key]);
    }
  }

  const warnings = Array.isArray(result._warnings) ? [...result._warnings] : [];

  const serviceCharge = Number(
    String(result.wr_service_charge || result.service_charge || "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "")
  );

  const serviceCurrency = normalizeCurrency(
    result.wr_service_charge_currency || result.service_charge_currency
  );

  if (serviceCharge && serviceCurrency === "EUR" && serviceCharge > 20) {
    warnings.push(
      "Opłata eksploatacyjna wygląda podejrzanie wysoko jak na EUR/m². Sprawdź, czy to nie PLN/m²."
    );
  }

  const warehouseRent = Number(
    String(result.wr_warehouse_base_rent || result.warehouse_base_rent || "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "")
  );

  const warehouseRentCurrency = normalizeCurrency(
    result.wr_warehouse_base_rent_currency || result.rent_currency
  );

  if (warehouseRent && warehouseRentCurrency === "EUR" && warehouseRent > 20) {
    warnings.push(
      "Czynsz bazowy magazynu wygląda podejrzanie wysoko jak na EUR/m². Sprawdź jednostkę i walutę."
    );
  }

  const clearHeight = Number(
    String(result.wr_clear_height || result.clear_height || "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "")
  );

  if (clearHeight && clearHeight > 25) {
    warnings.push(
      "Wysokość magazynu wygląda podejrzanie wysoko. Sprawdź, czy OCR nie pomylił wartości."
    );
  }

  result._warnings = warnings;
  result._templateId = templateId;

  return result;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY in environment variables.",
      });
    }

    const body = await parseRequestBody(req);
    const sourceText = buildSourceText(body);

    if (!sourceText || sourceText.length < 20) {
      return res.status(400).json({
        error: "No source text provided for AI extraction.",
      });
    }

    const templateId = detectTemplateId(body, sourceText);
    const selected = await loadTemplatePrompt(templateId);

    const finalPrompt = buildExtractionPrompt({
      basePrompt,
      templateLabel: selected.label,
      templatePrompt: selected.prompt,
      sourceText,
    });

    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.05,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content:
            "Jesteś precyzyjnym ekstraktorem danych CRE. Zwracasz wyłącznie poprawny JSON zgodny z instrukcją.",
        },
        {
          role: "user",
          content: finalPrompt,
        },
      ],
    });

    const rawAiText = completion.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(rawAiText);
    const normalized = normalizeResultForFrontend(parsed, selected.templateId);

    // Obecny frontend oczekuje płaskiego JSON-a, np. data.city, data.street itd.
    // Dlatego zwracamy bez wrappera { ok, data }.
    return res.status(200).json(normalized);
  } catch (error) {
    console.error("AI extraction error:", error);

    return res.status(500).json({
      error: error.message || "AI extraction failed.",
    });
  }
}
