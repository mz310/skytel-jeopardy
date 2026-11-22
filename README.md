# Skytel Jeopardy

Статик сайт. Build алхам байхгүй, `index.html` шууд ажиллана.

## Байршуулалт

Vercel төсөл `skytel-jeopardy` энэ repo-той холбогдсон. `main` рүү push хийх бүрд production дахин deploy хийгдэнэ.

Гараар байршуулах бол:

```bash
npx vercel --prod
```

Framework: Other, build command хоосон, output directory `./`.

## Canvas-аас шинэчлэх

Тоглоомын эх нь Claude дээрх "Skytel Jeopardy v2" хуудас. Тэндээс татсан файлуудаас сайтыг дахин угсрахдаа:

```bash
python3 -I tools/sync_from_canvas.py --repo . \
  "project/Skytel Jeopardy v2.dc.html=<татсан хуудас>" \
  "project/support.js=<татсан файл>" \
  "project/image-slot.js=<татсан файл>" \
  "project/.image-slots.state.json=<татсан файл>" \
  "project/uploads/skytel-colored.png=<татсан файл>"
```

Скрипт зөвхөн өөрчлөгдсөн файлыг бичиж, `CHANGED: ...` эсвэл `NO CHANGES` гэж хэвлэнэ. `index.html` дотор шууд засвар хийвэл дараагийн шинэчлэлээр дарагдана: асуулт, хариултыг canvas дээр засна.

## Файлууд

- `index.html` — тоглоом (canvas хуудас + гарчиг, локал React-ийн script tag)
- `.image-slots.state.json` — логоны зургууд (цэгээр эхэлсэн нуугдмал файл, заавал хамт байршина)
- `support.js`, `image-slot.js` — ажиллуулагч скриптүүд (canvas-аас хуулсан, гараар засахгүй)
- `vendor/` — React 18.3.1
- `uploads/` — Skytel лого
- `tools/sync_from_canvas.py` — canvas-аас шинэчлэх скрипт (Vercel рүү байршихгүй)

Оноо болон нээсэн асуултууд тухайн хөтчийн localStorage-д хадгалагдана.
