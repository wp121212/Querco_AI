import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import pdfParse from "pdf-parse";

export const config = {
  api: {
    bodyParser: false,
  },
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function fileToBase64(path) {
  const buffer = fs.readFileSync(path);
  return buffer.toString("base64");
}

async function parsePdfText(path) {
  try {
    const dataBuffer = fs.readFileSync(path);
    const parsed = await pdfParse(dataBuffer);

    return parsed.text || "";
  } catch (err) {
    console.error("PDF parse error:", err);
    return "";
  }
}

const EXTRACTION_PROMPT = `
Jesteś ekspertem rynku nieruchomości komercyjnych CRE.

Analizujesz:
- oferty PDF,
- prezentacje,
- screeny maili,
- notatki brokerskie,
- zdjęcia ofert.

Zwróć WYŁĄCZNIE poprawny JSON.

Zasady:
- nie wymyślaj danych,
- jeśli brak informacji → pusty string "",
- wszystkie krótkie pola CAPSLOCK,
- opisy nieruchomości normalnym tekstem,
- rozpoznawaj EUR / PLN,
- liczby zwracaj bez waluty,
- walutę zwracaj osobno,
- nie dodawaj komentarzy.

Szukaj szczególnie:
- miasta,
- ulicy,
- powierzchni,
- NOI,
- ceny,
- liczby najemców,
- occupancy,
- wysokości hal,
- parkingów,
- MPZP,
- odległości od dróg,
- magazynu / biur.

JSON:
{
  "city": "",
  "street": "",
  "land_area": "",
  "asking_price": "",
  "asking_price_currency": "",
  "warehouse_area": "",
  "office_area": "",
  "parking_spots": "",
  "noi": "",
  "noi_currency": "",
  "occupancy": "",
  "tenants_count": "",
  "description": "",
  "expressway_distance": "",
  "highway_distance": "",
  "ownership": ""
}
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const form = formidable({
      multiples: true,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const textInput = fields.text?.[0] || "";

    let combinedText = textInput;

    const uploadedFiles = files.files || [];

    const imageInputs = [];

    for (const file of uploadedFiles) {
      const mimetype = file.mimetype || "";

      // PDF
      if (mimetype.includes("pdf")) {
        const pdfText = await parsePdfText(file.filepath);

        combinedText += `\n\nPDF CONTENT:\n${pdfText}\n\n`;

        console.log("PDF TEXT LENGTH:", pdfText.length);
      }

      // Images
      if (mimetype.includes("image")) {
        const base64 = fileToBase64(file.filepath);

        imageInputs.push({
          type: "input_image",
          image_url: `data:${mimetype};base64,${base64}`,
        });
      }
    }

    console.log("FINAL TEXT LENGTH:", combinedText.length);

    const response = await client.responses.create({
      model: "gpt-4.1-mini",

      response_format: {
        type: "json_object",
      },

      input: [
        {
          role: "system",
          content: EXTRACTION_PROMPT,
        },

        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: combinedText,
            },

            ...imageInputs,
          ],
        },
      ],
    });

    const raw = response.output_text;

    console.log("AI RAW:", raw);

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("JSON parse error:", e);

      return res.status(500).json({
        error: "Invalid AI JSON",
        raw,
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
}