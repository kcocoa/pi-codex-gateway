---
name: imagegen
description: Generate or edit raster images through the Codex Gateway provider's native OpenAI Responses image_generation tool. Use for AI-created photos, illustrations, textures, sprites, mockups, product imagery, and transparent-background cutouts. Do not use for repo-native SVG, HTML/CSS/canvas, or an established vector/icon system.
---

# Image Generation for Pi / Codex Gateway

Use Pi's `image_gen` tool for this skill. The tool is an extension wrapper around the
active `codex-gateway` GPT model's native OpenAI Responses `image_generation` tool;
it is **not** a Python/CLI fallback.

The tool is available only while the active model is a GPT model from the
`codex-gateway` provider. If the provider changes, run `/reload` to refresh the
provider-scoped skill discovery.

## Non-negotiable rules

- Use `image_gen` for normal image generation and editing. Do **not** create one-off
  API runners or invoke `scripts/image_gen.py`.
- This Pi migration deliberately has no CLI fallback. If native image generation fails,
  report the error and offer to refine the prompt or retry only when appropriate.
- Do not substitute SVG, HTML/CSS, canvas, or placeholders when the user asked for a
  raster visual. Conversely, prefer repo-native vector/code assets for an established
  icon set, logo system, diagram, or UI component.
- Do not overwrite an existing image unless the user explicitly requests replacement.
  `image_gen` defaults to a versioned sibling filename when needed.
- Report each final path and the prompt actually sent.

## Output locations

`image_gen` persists every result by default under:

```text
<current Pi session directory>/generated_images/
```

For normal persisted sessions, this is typically:

```text
~/.pi/agent/sessions/--<encoded-working-directory>--/generated_images/
```

This mirrors Pi's session layout instead of Codex's `$CODEX_HOME/generated_images`.

For ephemeral `pi --no-session` runs, `getSessionFile()` is undefined and the default
output directory is instead:

```text
/tmp/generated_images/
```

When the user requests a project asset or names a destination, pass an explicit
`output_path` relative to the project cwd (or absolute when requested), for example:

```text
assets/hero/coffee-mug.png
```

Never leave an asset referenced by project code only in the session image directory.
For preview or ideation work, keep the default session image path and let the tool
return the image inline.

## When to use

- Generate a new photo, illustration, texture, sprite, mockup, wireframe, product
  image, cover, ad creative, infographic, or visual variant.
- Edit an existing bitmap: replace/remove an object, change a background, transform
  lighting/weather, localize in-image text, composite references, or preserve identity.
- Generate multiple distinct assets: make one `image_gen` call per distinct prompt.
  Do not use a vague request for “variants” as a substitute for specifying each asset.

## When not to use

- Extend an existing SVG/vector icon, logo, or illustration system in the repository.
- Create simple deterministic diagrams, shapes, icons, or wireframes that are better
  built in SVG, HTML/CSS, or canvas.
- Modify an existing project asset whose editable source is already available in a
  native authoring format.

## Tool inputs

`image_gen` accepts these useful fields:

- `prompt` — required final image specification.
- `action` — `generate`, `edit`, or `auto`; use `edit` when preserving input content.
- `image_paths` — local image paths for edit targets or visual references, up to 16.
  Explicit paths take precedence over attached conversation images.
- `use_conversation_images` — defaults to true when `image_paths` is omitted. Set it
  false if an image attached to the latest user message is unrelated.
- `size`, `quality`, `background`, `output_format`, `output_compression` — native tool
  options. Only specify them when the user requires a constraint.
- `output_path` — explicit project or user-specified destination.
- `overwrite` — set true only when the user explicitly asks to replace that path.

Label the role of every input image in the prompt: `Image 1: edit target`,
`Image 2: style reference`, or `Image 3: subject to insert`. Treat a supplied image as
a reference unless the user clearly asks to alter it.

## Workflow

1. Determine whether this is a **generate** or **edit** request.
   - Existing image + preserve parts/invariants → edit.
   - Reference image used only for mood/style/composition → generate with reference.
   - No source image → generate.
2. Determine whether the result is preview-only or a project asset.
3. Collect critical constraints: intended use, exact in-image text, requested size,
   required invariants, avoid list, and image roles.
4. Shape the user request into a clear production prompt. Preserve a detailed user
   prompt; add restrained composition/detail only when the original is generic.
5. Call `image_gen` directly. For project-bound output, pass `output_path` before
   generating; do not generate into the session directory and move it later unless a
   destination is still unknown.
6. Inspect the returned image and validate subject, style, composition, exact text,
   constraints, and unwanted artifacts.
7. Iterate with a single targeted change. Repeat edit invariants on every iteration.
8. State the final output path(s), whether this was generation or editing, and the
   final prompt.

## Transparent backgrounds

Use the native tool first; never switch to a CLI path.

### Simple opaque subject: chroma-key workflow

For simple opaque subjects, request a flat removable background in the `prompt`:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background
for background removal. The background must be one uniform color with no shadows,
gradients, texture, reflections, floor plane, or lighting variation. Keep the subject
fully separated with crisp edges and generous padding. Do not use #00ff00 in the
subject. No cast shadow, contact shadow, reflection, watermark, or text unless
explicitly requested.
```

Then remove it with the helper bundled beside this Skill. Resolve `<skill-dir>` as the
directory containing this `SKILL.md`:

```bash
python <skill-dir>/scripts/remove_chroma_key.py \
  --input <source.png> \
  --out <final.png> \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

Validate alpha output: transparent corners, an alpha channel, no obvious halo/key-color
fringe, and plausible subject coverage. Retry once with `--edge-contract 1` only for a
thin fringe.

### Native transparency

When the user explicitly requests true/native transparency, call `image_gen` with
`background: "transparent"` and PNG or WebP output. Some hosted image models may reject
that option. If so, explain the limitation and offer the chroma-key workflow above; do
not fall back to the bundled CLI.

For hair, fur, feathers, smoke, glass, liquids, translucent materials, reflective
objects, or soft shadows, explain that chroma-key removal may have imperfect edges and
ask whether a simplified cutout is acceptable before proceeding.

## Prompt construction

Use this concise scaffold only where it improves the result:

```text
Use case: <taxonomy slug>
Asset type: <landing-page hero / game sprite / product photo / etc.>
Primary request: <user's request>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo / illustration / 3D / etc.>
Composition/framing: <wide / close / top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep / must avoid>
Avoid: <negative constraints>
```

Guidance:

- Keep detailed user prompts detailed; normalize rather than inventing requirements.
- For generic prompts, augment only with useful framing, polish, or layout direction.
- Do not invent extra characters, props, brand names, slogans, palettes, narrative
  beats, or arbitrary left/right placement.
- Quote literal in-image text, specify typography and placement, and require verbatim
  rendering. Spell difficult words letter-by-letter when accuracy matters.
- For edits, say `change only X; keep Y unchanged` and restate invariants each turn.
- Use camera, lighting, and material language for photorealism. Include realistic
  texture when it matters.

## Use-case taxonomy

Generate: `photorealistic-natural`, `product-mockup`, `ui-mockup`,
`infographic-diagram`, `scientific-educational`, `ads-marketing`,
`productivity-visual`, `logo-brand`, `illustration-story`, `stylized-concept`,
`historical-scene`.

Edit: `text-localization`, `identity-preserve`, `precise-object-edit`,
`lighting-weather`, `background-extraction`, `style-transfer`, `compositing`,
`sketch-to-render`.

## Reference material

- Read `references/prompting.md` for additional composition, text, reference-image,
  and iteration guidance.
- Read `references/sample-prompts.md` for copy/paste prompt recipes.
- `references/cli.md`, `references/image-api.md`, `references/codex-network.md`, and
  `scripts/image_gen.py` are retained upstream material only. They are **not part of
  this Pi implementation** and must not be used.
