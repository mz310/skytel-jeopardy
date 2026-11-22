# Skytel Jeopardy

Статик сайт. Build алхам байхгүй, `index.html` шууд ажиллана.

## Vercel рүү байршуулах

```bash
cd skytel-jeopardy
npx vercel --prod
```

Анхны удаа нэвтрэх болон төслийн тохиргоог асууна. Framework: Other, build command хоосон, output directory `./`.

## Файлууд

- `index.html` — тоглоом (асуулт, хариулт энд байгаа)
- `.image-slots.state.json` — логоны зургууд (цэгээр эхэлсэн нуугдмал файл, заавал хамт байршина)
- `support.js`, `image-slot.js`, `vendor/` — ажиллуулагч скриптүүд, React 18.3.1
- `uploads/` — Skytel лого

Оноо болон нээсэн асуултууд тухайн хөтчийн localStorage-д хадгалагдана.
