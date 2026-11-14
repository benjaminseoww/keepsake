# Keepsake design

Direction comes from the team's landing mockup: calm, warm, editorial. It should feel like a handwritten note from family, not a medical dashboard. Built on shadcn/ui (new-york, Radix) with tokens in `client/app/globals.css`.

## Color

Light only. Warm cream canvas, plum-brown ink, one dusty-rose accent.

| Token | Value | Use |
|---|---|---|
| `--background` | cream `#FDFAF7` | page |
| `--foreground` | plum-brown `#3B2D2F` | text, headings |
| `--card` | white | cards, panels |
| `--primary` | dusty rose `#A04E66` | primary buttons, italic accent words, links |
| `--secondary` / `--accent` | blush `#F6E9EA` | soft panels, voice bubble, hover |
| `--muted-foreground` | `#76666A` | secondary text (4.5:1 on cream) |
| `--border` | `#ECE2DE` | hairlines |
| `--success` | sage `#4B7757` | "verified", live dot |
| `--destructive` | brick `#B4413A` | forget, errors |

## Type

- Display: **Instrument Serif** (regular + italic). Headlines, greetings, memory text on the talk screen. Italic rose for the one word that carries the feeling ("moments", "remembering").
- Body/UI: **Geist Sans**.
- Eyebrows: 11px uppercase, `tracking-[0.2em]`, rose or muted.

## Shape and depth

- Radius 14px on cards, fully rounded pill buttons for primary actions.
- Shadows are soft and warm (`shadow-[0_20px_60px_-30px_rgba(80,40,50,0.25)]`), used only on floating cards.
- Generous whitespace; content max width 72rem.

## Voice

Plain, gentle, second person. No clinical words ("patient", "cognitive decline") in UI copy. Never invent numbers, testimonials or logos.

## Accessibility

- Talk screen: 22px+ body, 56px+ hit targets, live captions in an `aria-live` region.
- Focus ring is the shadcn ring in rose at 50%.
- Every color pair above meets WCAG AA on its background.
