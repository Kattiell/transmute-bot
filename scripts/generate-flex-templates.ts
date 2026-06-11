/**
 * One-time generator for the 5 flexcard background templates via Venice AI.
 *
 *   VENICE_API_KEY=... npm run flex:templates
 *
 * Writes assets/flex-templates/template-{1..5}.png (1280x720 landscape).
 * Re-running overwrites — curate the outputs and commit the ones you like.
 * Until templates exist, /flex falls back to procedural gradient backgrounds.
 *
 * Prompts deliberately ask for NO text and leave the left side calm: the
 * runtime renderer (src/flex/image.ts) composites the call data there as
 * crisp vector type.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { generateVeniceImage } from '../src/flex/venice';

const BASE_STYLE =
  'dark cyber-esoteric alchemical aesthetic, deep blacks, cinematic volumetric lighting, ' +
  'high detail digital art, landscape composition, left third of the frame calm and dark ' +
  'as empty copy space, no text, no letters, no watermark, no logo';

const NEGATIVE =
  'text, letters, words, numbers, typography, watermark, logo, caption, signature, ' +
  'low quality, blurry, oversaturated, human faces';

const PROMPTS = [
  `Egyptian eye of Horus glyph glowing gold above a dark obsidian altar, faint emerald circuit lines, mystic fog, ${BASE_STYLE}`,
  `Alchemical transmutation circle in luminous violet, floating golden particles, dark marble temple interior, ${BASE_STYLE}`,
  `Cosmic serpent of liquid chrome coiling through a neon-lit void, teal and magenta rim light, ${BASE_STYLE}`,
  `Ancient stone pyramid wired with glowing fiber optics, electric blue energy rising, starfield sky, ${BASE_STYLE}`,
  `Molten gold pouring through a black geometric monolith, ember sparks, smoke, crimson accent light, ${BASE_STYLE}`,
];

async function main(): Promise<void> {
  const outDir = path.join(process.cwd(), 'assets', 'flex-templates');
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < PROMPTS.length; i++) {
    const file = path.join(outDir, `template-${i + 1}.png`);
    process.stdout.write(`[${i + 1}/${PROMPTS.length}] generating ${path.basename(file)}... `);
    try {
      const png = await generateVeniceImage({
        prompt: PROMPTS[i],
        negativePrompt: NEGATIVE,
        width: 1280,
        height: 720,
      });
      fs.writeFileSync(file, png);
      console.log(`ok (${(png.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log('FAILED');
      console.error(err);
      process.exitCode = 1;
    }
  }

  console.log(`\nDone. Templates in ${outDir} — review them, regenerate any you dislike, then commit.`);
}

main();
