# Querco — AI Generator Ofert

## Struktura projektu

```
querco-generator/
├── public/
│   └── index.html          ← frontend (formularz + PPTX generator)
├── api/
│   └── extract.js          ← serverless endpoint (OpenAI extraction)
├── package.json
└── README.md
```

## Deploy na Vercel (15 minut)

### 1. Zainstaluj Vercel CLI (jeśli nie masz)
```bash
npm install -g vercel
```

### 2. Klucz API OpenAI
- Wejdź na https://platform.openai.com/api-keys
- Utwórz nowy klucz
- Skopiuj go

### 3. Deploy
```bash
cd querco-generator
vercel
```
Vercel zapyta o konfigurację — na wszystko klikaj Enter (domyślne).

### 4. Dodaj klucz API
```bash
vercel env add OPENAI_API_KEY
```
Wklej swój klucz OpenAI. Wybierz: Production, Preview, Development.

### 5. Redeploy z kluczem
```bash
vercel --prod
```

### 6. Gotowe!
Dostaniesz link np. `querco-generator.vercel.app` — wyślij go brokerom.

## Koszt
- Vercel hosting: $0 (darmowy plan)
- OpenAI API (gpt-4o-mini): ~$0.01 za ofertę → ~$1-3/miesiąc

## Jak działa
1. Broker otwiera stronę
2. Wrzuca szablon PPTX (raz)
3. Wkleja tekst oferty / maila
4. Klik "AI uzupełnij pola" → backend woła OpenAI → wypełnia formularz
5. Broker sprawdza, poprawia
6. Klik "Generuj PPTX" → pobiera gotowy plik
