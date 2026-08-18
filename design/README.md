# design/ — your design goes here

This folder was created for you. It is where your app's design lives, and it is
the first thing to fill in after you clone this repo.

There are two folders, and the difference between them matters:

```
design/reference/   what your app should LOOK like  — never shipped
design/assets/      files your app SERVES at runtime — uploaded to your storage
```

## `design/reference/` — the brief

Anything that describes the design. Put in whatever you actually have:

- HTML/CSS mockups, or a page exported from Figma, Framer, Webflow, v0…
- a `spec.md` describing screens, copy, colours, fonts, behaviour
- screenshots or photos of a whiteboard
- a moodboard, a competitor's page you like, a colour palette

None of this is deployed. It exists so that you — and your AI assistant — can
read it while building. Your assistant is told to read this folder before
writing UI code, so the more that is in here, the closer the first attempt lands.

Messy is fine. A rough sketch and three sentences beats an empty folder.

## `design/assets/` — the files your app serves

Images, video, audio, fonts and PDFs that the **running app** needs: a logo, a
hero video, product photos, an icon.

Add a file here, then:

```bash
npm run assets     # updates src/assets.ts
git add design/assets src/assets.ts
git commit -m "Add hero video"
git push
```

On push, these files are uploaded to your project's file storage automatically.
You never upload anything by hand and you never need a storage password.

### Using an asset in your code

Import `asset` from `src/assets.ts` — do not type the path as a bare string:

```ts
import { asset } from "./assets";

app.get("/", (c) => c.html(`
  <img src="${asset("logo.svg")}" alt="Our logo" />
  <video src="${asset("hero.mp4")}" autoplay muted loop></video>
`));
```

`asset()` is typed from the real contents of this folder, so a typo is a
`npm run typecheck` failure on your machine instead of a broken image in your
demo. Subfolders work too: `design/assets/icons/cart.svg` → `asset("icons/cart.svg")`.

### Seeing them locally

`npm run dev` uses a local copy of your storage, which starts out empty. Fill it
with what is in this folder:

```bash
npm run assets:local     # copy design/assets into your LOCAL storage
npm run dev
```

### Rules

- **Nothing bigger than 50 MB, and 500 MB in total.** `npm run assets` fails and
  tells you which file if you go over. Compress the video — a 6-second hero loop
  does not need to be 200 MB.
- **Only real assets.** Source files (`.psd`, `.fig`, `.ai`) and mockups belong
  in `design/reference/`, not here — everything in this folder is uploaded and
  published on the internet at `/assets/...`.
- **Don't edit `src/assets.ts` by hand.** `npm run assets` generates it.
- **Don't rename `.gitattributes`.** It is what stops large media from bloating
  the repo (Git LFS — [INSTALL.md](../INSTALL.md) sets it up).
