import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cargoCrates, classifyText, evaluateLicense, licenseFiles, npmShipped, root } from './lib/deps.mjs';

const OUT = path.join(root, 'THIRD-PARTY-NOTICES.md');
const check = process.argv.includes('--check');

function fail(msg) {
  console.error(`✖ gen-notices: ${msg}`);
  process.exit(1);
}

let npm;
let cargo;
try {
  npm = npmShipped();
  cargo = cargoCrates();
} catch (e) {
  fail(e.message);
}

const family = (id) => {
  const b = id.replace(/\s+WITH\s+.*$/i, '');
  if (/^BSD/.test(b) || b === '0BSD') return 'BSD';
  if (/^Unicode/.test(b)) return 'Unicode';
  if (b === 'MIT-0') return 'MIT';
  return b;
};

const canonical = {};

function textsFor(dir, chosen) {
  const files = licenseFiles(dir);
  const want = new Set(chosen.map(family));
  const texts = [];
  const notes = [];
  for (const f of files) {
    const kind = classifyText(f.text);
    if ((kind === 'Apache-2.0' && /^Apache License/i.test(f.text)) || (kind === 'MPL-2.0' && /^Mozilla Public License/i.test(f.text))) {
      if (!/Permission is hereby granted/i.test(f.text)) canonical[kind] ??= f.text;
    }
    const nameHint = /apache/i.test(f.name) ? 'Apache-2.0' : /mit/i.test(f.name) && !/submit/i.test(f.name) ? 'MIT' : /mpl/i.test(f.name) ? 'MPL-2.0' : /unicode/i.test(f.name) ? 'Unicode' : /zlib/i.test(f.name) ? 'Zlib' : /bsd/i.test(f.name) ? 'BSD' : /unlicense/i.test(f.name) ? 'Unlicense' : null;
    const isNotice = /^notice/i.test(f.name) || kind === 'NOTICE';
    if (isNotice) {
      texts.push(f);
      continue;
    }
    const k = kind !== 'other' ? kind : nameHint;
    if (k && !want.has(k)) continue;
    if (/^\s*GNU (LESSER |AFFERO )?GENERAL PUBLIC LICENSE\s+Version/i.test(f.text)) continue;
    if ((k === 'Apache-2.0' || k === 'MPL-2.0') && !/Permission is hereby granted/i.test(f.text)) {
      notes.push(`${k}: the full licence text is reproduced once under "Standard licence texts" below.`);
      continue;
    }
    texts.push(f);
  }
  return { texts, notes: [...new Set(notes)] };
}

const problems = [];
const entries = [];

for (const p of npm) {
  const ev = evaluateLicense(p.license);
  if (!ev.ok) problems.push(`npm ${p.name}@${p.version}: licence "${p.license}" is not on the allowlist (run npm run license:check)`);
  const chosen = ev.chosen ?? [p.license || 'unknown'];
  const { texts, notes } = textsFor(p.dir, chosen);
  entries.push({ group: 'npm', name: p.name, version: p.version, license: p.license, chosen, reason: p.reason, texts, notes, repository: p.repository });
}
for (const c of cargo.crates) {
  if (c.use === 'dev') continue;
  const ev = evaluateLicense(c.license);
  if (!ev.ok) problems.push(`crate ${c.name}@${c.version}: licence "${c.license}" is not on the allowlist (run npm run license:check)`);
  const chosen = ev.chosen ?? [c.license || 'unknown'];
  const { texts, notes } = textsFor(c.dir, chosen);
  entries.push({ group: 'cargo', name: c.name, version: c.version, license: c.license, chosen, use: c.use, usedBy: c.usedBy, texts, notes, repository: c.repository });
}
if (problems.length) fail(`unapproved licences:\n  ${problems.join('\n  ')}`);

/** The standard MIT permission text (taken from our own LICENSE) under a given copyright line. */
function mitText(copyright) {
  const own = readFileSync(path.join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
  const body = own.slice(own.indexOf('Permission is hereby granted')).trim();
  return `MIT License\n\n${copyright}\n\n${body}`;
}

function findDirs(base, re, depth = 4) {
  const out = [];
  const walk = (dir, d) => {
    if (d > depth) return;
    let list = [];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (!e.isDirectory() || e.name === 'target' || e.name.startsWith('target-') || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (re.test(e.name)) out.push(p);
      else walk(p, d + 1);
    }
  };
  walk(base, 0);
  return out;
}

const sdkSections = [];
{
  const vst3Crates = cargo.crates.filter((c) => /^vst3/.test(c.name) && c.use !== 'dev');
  const vst3Dirs = findDirs(path.join(root, 'engine'), /^(vst3sdk|vst3_sdk|VST3_SDK|vst3-sdk|pluginterfaces)$/i);
  const pluginCrates = cargo.members.filter((m) => /plug|host|vst/i.test(m.name));
  const vst3Source = [...vst3Dirs, ...pluginCrates.map((m) => m.dir)].some((d) => {
    try {
      return findDirs(d, /^(vst3sdk|pluginterfaces|vst3)$/i).length > 0 || /vst3/i.test(readFileSync(path.join(d, 'Cargo.toml'), 'utf8'));
    } catch {
      return false;
    }
  });
  if (vst3Crates.length || vst3Dirs.length || vst3Source) {
    let sdkLicense = null;
    for (const d of vst3Dirs) {
      for (const cand of [d, path.dirname(d)]) {
        const f = licenseFiles(cand).find((x) => /Permission is hereby granted/i.test(x.text) && /Steinberg/i.test(x.text));
        if (f) {
          sdkLicense = f.text;
          break;
        }
      }
      if (sdkLicense) break;
    }
    sdkSections.push(
      [
        '### Steinberg VST 3 SDK',
        '',
        'The plugin host uses interface definitions from the Steinberg VST 3 SDK, which Steinberg relicensed under the',
        'MIT License with VST 3.8 (October 2025). Source and licence: https://github.com/steinbergmedia/vst3sdk',
        '(`LICENSE.txt`). VST is a registered trademark of Steinberg Media Technologies GmbH. Krypt Studio is not',
        'affiliated with or endorsed by Steinberg, and "VST" is not part of any Krypt product or feature name.',
        '',
        ...(sdkLicense
          ? ['```text', sdkLicense, '```', '']
          : [
              'No copy of the SDK is vendored in this repository; the bindings are generated from its headers. The SDK\'s',
              'MIT terms, as they apply to those headers (the authoritative text is `LICENSE.txt` in the SDK repository):',
              '',
              '```text',
              mitText('Copyright (c) Steinberg Media Technologies GmbH'),
              '```',
              '',
            ]),
        ...(vst3Crates.length ? [`Binding crates: ${vst3Crates.map((c) => `\`${c.name}\` ${c.version} (${c.license})`).join(', ')}; their licence texts are listed with the Rust crates.`, ''] : []),
      ].join('\n'),
    );
  }
  const clap = cargo.crates.filter((c) => /^(clap-sys|clack)/.test(c.name) && c.use !== 'dev');
  if (clap.length) {
    sdkSections.push(
      [
        '### CLAP (CLever Audio Plugin API)',
        '',
        'The plugin host uses the CLAP API (MIT, https://github.com/free-audio/clap) through ' +
          clap.map((c) => `\`${c.name}\` ${c.version}`).join(', ') +
          '. Their licence texts are listed with the Rust crates.',
        '',
      ].join('\n'),
    );
  }
}

const nativeSections = [];
const VENDORED = {
  'signalsmith-stretch': 'Signalsmith Stretch (audio-clip time-stretch and pitch-shift)',
  'signalsmith-linear': 'Signalsmith Linear (FFT/STFT used by Signalsmith Stretch)',
};
for (const [dir, what] of Object.entries(VENDORED)) {
  const lic = path.join(root, 'engine', 'crates', 'stretch', 'vendor', dir, 'LICENSE.txt');
  if (!existsSync(lic)) fail(`engine/crates/stretch/vendor/${dir}/LICENSE.txt is missing. Vendored code must keep its licence.`);
  const text = readFileSync(lic, 'utf8').replace(/\r\n/g, '\n').trim();
  if (classifyText(text) !== 'MIT') fail(`engine/crates/stretch/vendor/${dir}/LICENSE.txt is not the MIT licence.`);
  nativeSections.push(
    [`### ${what}`, '', `Header-only C++ vendored in \`engine/crates/stretch/vendor/${dir}/\` and compiled into \`krypt-studio-engine.exe\`.`, '', '```text', text, '```', ''].join('\n'),
  );
}
nativeSections.push(
  [
    '### ONNX Runtime, DirectML and the Visual C++ runtime (stem separation)',
    '',
    '`krypt-studio-analyzer.exe` loads these DLLs from its own folder at run time; they are not linked into it, and',
    "nothing else in Krypt Studio needs them. Each package's licence and third-party notices ship next to the DLLs.",
    '',
    '- `onnxruntime.dll`: ONNX Runtime (Microsoft), MIT License. `onnxruntime-LICENSE.txt`,',
    '  `onnxruntime-ThirdPartyNotices.txt`.',
    '- `DirectML.dll`: DirectML (Microsoft), GPU acceleration for stem separation. Not open source: redistributed',
    '  under the Microsoft DirectML licence terms (`DirectML-LICENSE.txt`, `DirectML-ThirdPartyNotices.txt`). Optional;',
    '  without it, separation runs on the CPU.',
    '- `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`, `msvcp140_1.dll`: the Microsoft Visual C++ runtime,',
    '  needed by `onnxruntime.dll`, redistributed app-locally under the Visual Studio redistributable terms.',
    '',
    '### MP3 export (Windows Media Foundation)',
    '',
    "MP3 export uses Windows' built-in MP3 encoder through Media Foundation (the operating system's own codec, present",
    'since Windows 8; missing on Windows N editions without the Media Feature Pack). No MP3 encoder code ships with',
    'Krypt Studio: no LAME or other encoder is linked or bundled.',
    '',
    '### Downloadable models',
    '',
    "Models installed from the Model Manager (for example HT-Demucs) are not part of the installer. Each model's licence",
    'and any notice about its training data are shown before download; the list lives in `shared/analyzer/models.ts`.',
    '',
    '- **Kokoro-82M v1.0** (Krypt Voice, `kokoro`): weights and voices by hexgrad, Apache-2.0',
    '  (https://huggingface.co/hexgrad/Kokoro-82M); the ONNX export by onnx-community, Apache-2.0',
    '  (https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX, revision 1939ad2a8e416c0acfeecc08a694d14ef25f2231).',
    '  Downloaded unchanged and SHA-256 verified; the Apache License 2.0 text is reproduced under "Standard licence texts".',
    '',
  ].join('\n'),
);

{
  const lic = path.join(root, 'engine', 'crates', 'analyzer', 'data', 'CMUDICT-LICENSE.txt');
  if (!existsSync(lic)) fail('engine/crates/analyzer/data/CMUDICT-LICENSE.txt is missing. The CMU Pronouncing Dictionary must keep its licence.');
  const text = readFileSync(lic, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!/Carnegie Mellon University/.test(text) || !/Redistribution and use in source and binary forms/.test(text)) fail('engine/crates/analyzer/data/CMUDICT-LICENSE.txt is not the CMUdict BSD-style licence.');
  nativeSections.push(
    [
      '### CMU Pronouncing Dictionary (Krypt Voice pronunciation)',
      '',
      'Compiled into `krypt-studio-analyzer.exe` (compressed: `engine/crates/analyzer/data/cmudict.txt.deflate`, built',
      'by `scripts/models/cmudict.mjs` from https://github.com/cmusphinx/cmudict at commit',
      '74790861f652b15e4ac49015a90074ad62a27690; first pronunciation per word, comments removed). Used for English',
      "pronunciation in Krypt Voice's local text-to-speech.",
      '',
      '```text',
      text,
      '```',
      '',
    ].join('\n'),
  );
}

const KNOWN_FONTS = {
  'Chakra Petch': 'Copyright 2018 The Chakra Petch Project Authors (https://github.com/cadsondemak/Chakra-Petch)',
  'JetBrains Mono': 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)',
  'Press Start 2P': 'Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name "Press Start 2P"',
};
const fontsCss = path.join(root, 'public', 'fonts', 'fonts.css');
const fontFamilies = existsSync(fontsCss) ? [...new Set([...readFileSync(fontsCss, 'utf8').matchAll(/font-family:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))].sort() : [];
for (const f of fontFamilies) if (!KNOWN_FONTS[f]) fail(`public/fonts/fonts.css uses "${f}" but scripts/gen-notices.mjs has no licence entry for it. Add it to KNOWN_FONTS.`);
const oflPath = path.join(root, 'public', 'fonts', 'OFL.txt');
if (fontFamilies.length && !existsSync(oflPath)) fail('public/fonts/OFL.txt is missing (the OFL must travel with the fonts).');
const oflText = existsSync(oflPath) ? readFileSync(oflPath, 'utf8').replace(/\r\n/g, '\n').trim() : '';
const oflBody = oflText.slice(Math.max(0, oflText.indexOf('-----------------------------------------------------------')));

const modelsRoot = path.join(root, 'resources', 'models');
const modelIds = existsSync(modelsRoot)
  ? readdirSync(modelsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];
const modelSections = [];
for (const id of modelIds) {
  const dir = path.join(modelsRoot, id);
  const entries = readdirSync(dir).sort();
  const files = entries.filter((f) => !/^(LICEN[CS]E|NOTICE)/i.test(f));
  const licName = entries.find((f) => /^LICEN[CS]E/i.test(f));
  if (!licName) fail(`resources/models/${id}/ has no LICENSE file. Every bundled model must ship its licence.`);
  const readText = (name) => readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim();
  const licText = readText(licName);
  const kind = classifyText(licText);
  if (kind !== 'MIT' && kind !== 'Apache-2.0' && kind !== 'BSD' && kind !== 'ISC') fail(`resources/models/${id}/${licName} is not a recognised permissive licence (got "${kind}").`);
  const lines = [`### \`${id}\``, '', `Files: ${files.map((f) => `\`${f}\``).join(', ')}. Licence: ${kind}.`, ''];
  const at = licText.search(/^\s*Apache License\s*$/m);
  if (kind === 'Apache-2.0' && at >= 0) {
    // Copyright preamble here; the Apache text itself is printed once under "Standard licence texts".
    const pre = licText.slice(0, at).trim();
    canonical['Apache-2.0'] ??= licText.slice(at).trim();
    if (pre) lines.push('```text', pre, '```', '');
    lines.push('Apache License 2.0: the full text is reproduced under "Standard licence texts".', '');
  } else {
    lines.push('```text', licText, '```', '');
  }
  const noticeName = entries.find((f) => /^NOTICE/i.test(f));
  if (noticeName) lines.push(`${noticeName} (reproduced as Apache-2.0 §4(d) requires):`, '', '```text', readText(noticeName), '```', '');
  modelSections.push(lines.join('\n'));
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const link = (u) => (u ? (/^https?:\/\//.test(u) ? u : esc(u)) : '');
const shortMember = (n) => n.replace(/^krypt-studio-/, '').replace(/^mcp$/, 'mcp-shim');

const DATASETS = [
  {
    name: 'Groove MIDI Dataset (GMD)',
    file: 'shared/grooves/templates.gen.ts',
    attribution: 'Derived from the Groove MIDI Dataset by Google LLC (Magenta), CC BY 4.0',
    by: 'Google LLC (Magenta)',
    license: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    url: 'https://magenta.tensorflow.org/datasets/groove',
    citation:
      'Jon Gillick, Adam Roberts, Jesse Engel, Douglas Eck, and David Bamman. "Learning to Groove with Inverse Sequence Transformations." International Conference on Machine Learning (ICML), 2019.',
    describe: (src) => {
      const perfs = [...src.matchAll(/^\s+performances: (\d+),$/gm)].map((m) => Number(m[1]));
      return `${perfs.length} groove templates (piano roll Tools ▸ Groove, the \`notes.groove\` command and the \`transform_notes\` "groove" op), measured from ${perfs.reduce((a, b) => a + b, 0)} of the dataset's 4/4 beat performances.`;
    },
    changes:
      'Only aggregated per-style statistics are kept: mean and spread of the timing per 16th step, relative velocity, hit probability and swing. No MIDI file or performance is reproduced. Generated by `scripts/grooves/extract.mjs`.',
  },
];
const datasetSections = [];
for (const d of DATASETS) {
  const p = path.join(root, d.file);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  if (!src.includes(d.attribution)) fail(`${d.file} lost its attribution line ("${d.attribution}"): regenerate it`);
  datasetSections.push(
    [
      `### ${d.name}`,
      '',
      `- **By:** ${d.by}. ${d.url}`,
      `- **Licence:** ${d.license}, ${d.licenseUrl}`,
      `- **Used for:** ${d.describe(src)} Shipped in \`${d.file}\`.`,
      `- **Changes:** ${d.changes}`,
      `- **Citation:** ${d.citation}`,
      '',
    ].join('\n'),
  );
}

const PACK_CREDITS = [
  {
    id: 'grand-piano',
    name: 'Grand Piano',
    work: 'Salamander Grand Piano V3',
    by: 'Alexander Holm',
    license: 'Public domain (the author dedicated it on 4 March 2022: "As of 4.3.2022, this is now public domain!")',
    source: 'https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/ (statement archived at https://web.archive.org/web/20261009164910/https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/); files from https://github.com/sfzinstruments/SalamanderGrandPiano at commit 3382bf9',
    attribution: 'Salamander Grand Piano V3 by Alexander Holm (public domain since 4 March 2022).',
  },
  {
    id: 'live-drums',
    name: 'Live Drum Kit',
    work: 'Virtuosity Drums',
    by: 'Versilian Studios and Karoryfer Samples; performed by Austin McMahon at Virtuosity Musical Instruments, Boston',
    license: 'CC0 1.0 Universal (LICENSE at the pinned commit)',
    source: 'https://github.com/sfzinstruments/virtuosity_drums at commit 9f04cf9',
    attribution: 'Virtuosity Drums by Versilian Studios and Karoryfer Samples, performed by Austin McMahon, recorded at Virtuosity Musical Instruments, Boston (CC0 1.0).',
  },
  {
    id: 'upright-piano',
    name: 'Upright Piano',
    work: 'Upright piano from VS Chamber Orchestra 2: Community Edition',
    by: 'Simon Dalzell (Ivy Audio) for Versilian Studios',
    license: 'CC0 1.0 Universal (LICENSE at the pinned commit)',
    source: 'https://github.com/sgossner/VSCO-2-CE at commit 4403009',
    attribution: 'Upright piano sampled by Simon Dalzell (Ivy Audio), from VS Chamber Orchestra 2: Community Edition by Versilian Studios (CC0 1.0).',
  },
  {
    id: 'keys-mallets',
    name: 'Keys & Mallets',
    work: 'Versilian Community Sample Library (VCSL): vibraphone, marimba, glockenspiel, kalimba',
    by: 'Versilian Studios',
    license: 'CC0 1.0 Universal (LICENSE at the pinned commit)',
    source: 'https://github.com/sgossner/VCSL at commit c1ea7bc',
    attribution: 'Versilian Community Sample Library (VCSL) by Versilian Studios (CC0 1.0).',
  },
  {
    id: 'orchestral',
    name: 'Orchestral Essentials',
    work: 'VS Chamber Orchestra 2: Community Edition: string sections, trumpet, horn, trombone, flute, harp',
    by: 'Versilian Studios (Sam Gossner) with Ivy Audio (Simon Dalzell)',
    license: 'CC0 1.0 Universal (LICENSE at the pinned commit)',
    source: 'https://github.com/sgossner/VSCO-2-CE at commit 4403009',
    attribution: 'VS Chamber Orchestra 2: Community Edition by Versilian Studios (Sam Gossner) with Ivy Audio (Simon Dalzell) (CC0 1.0).',
  },
  {
    id: 'perc-extras',
    name: 'Percussion Extras',
    work: 'Versilian Community Sample Library (VCSL): hand and world percussion, concert snare rolls and whistles',
    by: 'Versilian Studios',
    license: 'CC0 1.0 Universal (LICENSE at the pinned commit)',
    source: 'https://github.com/sgossner/VCSL at commit c1ea7bc',
    attribution: 'Percussion from the Versilian Community Sample Library (VCSL) by Versilian Studios (CC0 1.0).',
  },
  {
    id: 'hits-whooshes',
    name: 'Hits & Whooshes',
    work: 'VCSL cymbals, gongs, bass drums, anvil, chimes and whistles; Kenney Sci-Fi Sounds and Impact Sounds; Swishes Sound Pack; Muffled Distant Explosion',
    by: 'Versilian Studios; Kenney (kenney.nl); artisticdude; Nenad Simic',
    license: 'CC0 1.0 Universal (every source; quotes and dates read in the pack licence and research/14 §5)',
    source: 'https://github.com/sgossner/VCSL at commit c1ea7bc; https://kenney.nl/assets/sci-fi-sounds; https://kenney.nl/assets/impact-sounds; https://opengameart.org/content/swishes-sound-pack; https://opengameart.org/content/muffled-distant-explosion',
    attribution: 'Hits & Whooshes: VCSL by Versilian Studios, Sci-Fi Sounds and Impact Sounds by Kenney (kenney.nl), Swishes by artisticdude and Muffled Distant Explosion by Nenad Simic (all CC0 1.0).',
  },
  {
    id: 'foley-field',
    name: 'Foley & Field Recordings',
    work: 'Kenney Casino Audio, RPG Audio, Impact Sounds and UI Audio; CC0 foley and field recordings from OpenGameArt.org',
    by: 'Kenney (kenney.nl) and the OpenGameArt.org authors named in the credit',
    license: 'CC0 1.0 Universal (every source; quotes and dates read in the pack licence and research/14 §5)',
    source: 'https://kenney.nl/assets (casino-audio, rpg-audio, impact-sounds, ui-audio) and the OpenGameArt.org pages listed in research/14 §5',
    attribution: 'Foley & Field Recordings: Casino Audio, RPG Audio, Impact Sounds and UI Audio by Kenney (kenney.nl), and CC0 recordings from OpenGameArt.org by unicaegames, OwlishMedia, Luckius, StarNinjas, bart, Ylmir, LEGIT Audio, Spring Spring, BMacZero, Till Behrend, Vinrax, scorcher24, Iochi Glaucus, PagDev, Kresiek The Furry, WuxiaScrub, IgnasD and eXpl0it3r (all CC0 1.0).',
  },
  {
    id: 'retro-game',
    name: 'Retro Game FX',
    work: 'The Essential Retro Video Game Sound Effects Collection [512 sounds]; Kenney Digital Audio, Voiceover Pack and Voiceover Pack: Fighter',
    by: 'Juhani Junkala; Kenney (kenney.nl)',
    license: 'CC0 1.0 Universal (every source; quotes and dates read in the pack licence and research/14 §5)',
    source: 'https://opengameart.org/content/512-sound-effects-8-bit-style; https://kenney.nl/assets/digital-audio; https://kenney.nl/assets/voiceover-pack; https://kenney.nl/assets/voiceover-pack-fighter',
    attribution: 'Retro Game FX: The Essential Retro Video Game Sound Effects Collection by Juhani Junkala, and Digital Audio, Voiceover Pack and Voiceover Pack: Fighter by Kenney (kenney.nl) (all CC0 1.0).',
  },
];
const packSections = [];
{
  const catalogFile = path.join(root, 'shared', 'packs', 'catalog.ts');
  const catalogSrc = existsSync(catalogFile) ? readFileSync(catalogFile, 'utf8') : '';
  const ids = [...catalogSrc.matchAll(/^\s+id: '([a-z0-9][a-z0-9-]*)',$/gm)].map((m) => m[1]);
  for (const id of ids) if (!PACK_CREDITS.some((c) => c.id === id)) fail(`shared/packs/catalog.ts has pack "${id}" but scripts/gen-notices.mjs has no credit for it (PACK_CREDITS)`);
  for (const c of PACK_CREDITS) {
    if (!ids.includes(c.id)) continue;
    if (!catalogSrc.includes(c.attribution)) fail(`shared/packs/catalog.ts lost the attribution of pack "${c.id}" ("${c.attribution}")`);
    packSections.push(
      [
        `### ${c.name} (\`${c.id}\`)`,
        '',
        `- **Recording:** ${c.work}, by ${c.by}.`,
        `- **Licence:** ${c.license}.`,
        `- **Source:** ${c.source}.`,
        `- **Credit:** ${c.attribution}`,
        '',
      ].join('\n'),
    );
  }
}

const L = [];
const out = (...lines) => L.push(...lines);

const runtimeCrates = entries.filter((e) => e.group === 'cargo' && e.use === 'runtime');
const buildCrates = entries.filter((e) => e.group === 'cargo' && e.use === 'build');
const npmEntries = entries.filter((e) => e.group === 'npm');
const mpl = entries.filter((e) => e.chosen.some((id) => family(id) === 'MPL-2.0'));

out(
  '# Third-party notices',
  '',
  'Krypt Studio is MIT-licensed (see `LICENSE`). The installer ships, or was built with, the third-party',
  'components below, each under its own licence. Only permissive, MIT-compatible licences are accepted',
  '(`npm run license:check` enforces this in CI); the one file-level copyleft component, Symphonia (MPL-2.0),',
  'is called out explicitly.',
  '',
  '> Generated by `scripts/gen-notices.mjs` from `package-lock.json` and `cargo metadata`. Do not edit by hand:',
  '> run `npm run notices` after changing dependencies. CI fails if this file is stale.',
  '',
  'The Electron runtime also ships Chromium\'s own notices as `LICENSES.chromium.html` next to `Krypt Studio.exe`.',
  '',
  '## Contents',
  '',
  `- MPL-2.0 components (${mpl.length})`,
  ...(sdkSections.length ? ['- Plugin SDKs'] : []),
  '- Native libraries (vendored C++, run-time DLLs)',
  `- npm packages (${npmEntries.length})`,
  `- Rust crates (${runtimeCrates.length} linked into the engine, MCP shim and plugin binaries, ${buildCrates.length} build-time only)`,
  `- Fonts (${fontFamilies.length})`,
  '- Factory content and demo project',
  ...(datasetSections.length ? [`- Datasets (${datasetSections.length})`] : []),
  ...(packSections.length ? [`- Sound packs (${packSections.length}, optional downloads)`] : []),
  ...(modelSections.length ? [`- Bundled models (${modelSections.length})`] : []),
  '- Licence texts',
  '',
  '## MPL-2.0 components (Symphonia)',
  '',
  'The audio engine (`krypt-studio-engine.exe`) links the Symphonia audio decoders, which are licensed under the',
  'Mozilla Public License 2.0. MPL-2.0 is a file-level copyleft: Krypt Studio uses these crates **unmodified**, and',
  'their complete source code is available from the upstream repository and from crates.io at the exact versions below.',
  'If Krypt Studio ever modifies an MPL-2.0 file, that file will be published under MPL-2.0. The full MPL-2.0 text is',
  'reproduced under "Standard licence texts".',
  '',
  '| Crate | Version | Source code |',
  '|---|---|---|',
  ...mpl.map((e) => `| ${e.name} | ${e.version} | ${link(e.repository)} · https://crates.io/crates/${e.name}/${e.version} |`),
  '',
);

if (sdkSections.length) out('## Plugin SDKs', '', ...sdkSections);
out('## Native libraries', '', ...nativeSections);

out(
  '## npm packages',
  '',
  'Production dependencies (packed into `app.asar` or bundled into the main-process code), the packages Vite',
  'bundles into the renderer, and the Electron runtime.',
  '',
  '| Package | Version | Licence | Ships as | Source |',
  '|---|---|---|---|---|',
  ...npmEntries.map((e) => `| ${esc(e.name)} | ${e.version} | ${esc(e.license)} | ${e.reason} | ${link(e.repository)} |`),
  '',
  '## Rust crates',
  '',
  'Every crate in the engine workspace\'s dependency graph for `x86_64-pc-windows-msvc`. Where a crate offers a',
  'choice of licences, Krypt Studio elects the one in the "Elected" column. "Used by" names the workspace crates',
  'that pull it in: `engine` builds `krypt-studio-engine.exe` (with `dsp` linked in), `mcp-shim` builds',
  '`krypt-studio-mcp.exe`, `analyzer` builds `krypt-studio-analyzer.exe` (the on-device audio ML sidecar), and the',
  'plugin crates build the sandboxed plugin host and its client.',
  '',
  '### Linked into the shipped binaries',
  '',
  '| Crate | Version | Licence | Elected | Used by | Source |',
  '|---|---|---|---|---|---|',
  ...runtimeCrates.map((e) => `| ${e.name} | ${e.version} | ${esc(e.license)} | ${esc(e.chosen.join(' AND '))} | ${e.usedBy.map(shortMember).join(', ')} | ${link(e.repository)} |`),
  '',
  '### Build-time only (build scripts and procedural macros; not in the binaries)',
  '',
  '| Crate | Version | Licence | Elected | Source |',
  '|---|---|---|---|---|',
  ...buildCrates.map((e) => `| ${e.name} | ${e.version} | ${esc(e.license)} | ${esc(e.chosen.join(' AND '))} | ${link(e.repository)} |`),
  '',
  '## Fonts',
  '',
  'Bundled as WOFF2 subsets in `dist/fonts/`, with the full licence in `fonts/OFL.txt` next to them.',
  '',
  '| Font | Licence | Copyright |',
  '|---|---|---|',
  ...fontFamilies.map((f) => `| ${f} | SIL Open Font License 1.1 | ${esc(KNOWN_FONTS[f])} |`),
  '',
  'OFL-1.1 text: reproduced under "Standard licence texts" and at https://openfontlicense.org/open-font-license-official-text/',
  '',
  '## Factory content and demo project',
  '',
  '- **Factory drum kit** (`resources/factory/`): Krypt-original. Every sample is synthesized procedurally at build',
  '  time by the engine\'s own DSP (`krypt-studio-engine --gen-factory`). It contains no recorded or third-party',
  '  samples. Algorithm credits are in `engine/crates/dsp/THIRD-PARTY.md`.',
  '- **Demo project** (`resources/demos/`): Krypt-original, built by `scripts/make-demo.ts` through Krypt Studio\'s',
  '  own command layer from the factory kit and the stock plugins.',
  '- **Stock instruments and effects** (`krypt.*`): Krypt-original code, written from published papers (see',
  '  `engine/crates/dsp/THIRD-PARTY.md`). No GPL or proprietary DSP code was used.',
  '',
  'The factory kit, the demo project and their renders are released under the same MIT licence as Krypt Studio.',
  'Use them in your own music, commercial or not, without attribution.',
  '',
  ...(packSections.length
    ? [
        '## Sound packs (optional downloads)',
        '',
        'Real recorded instruments and sample packs the user can download in Home ▸ Sounds ▸ Sound packs. They are not in',
        'the installer: Krypt Studio lists every file (and every file it extracts from a source ZIP) with its URL, size and',
        'SHA-256 (`shared/packs/catalog.ts`), downloads it from the upstream repository at a pinned commit or from the',
        "source's own site, and shows each pack's licence before download. The SFZ mappings written next to the samples are",
        "Krypt Studio's own work (MIT). Each pack is credited even where its licence does not ask for it.",
        '',
        ...packSections,
      ]
    : []),
  ...(datasetSections.length
    ? [
        '## Datasets',
        '',
        'Data derived from third-party datasets that ships inside Krypt Studio. The datasets themselves are not',
        'bundled; only what is listed here.',
        '',
        ...datasetSections,
      ]
    : []),
  ...(modelSections.length
    ? [
        '## Bundled models',
        '',
        'On-device ML models shipped in `resources/models/<id>/` and run by `krypt-studio-analyzer.exe`. Code and',
        'weights are under the licences below; each licence file ships next to its model.',
        '',
        ...modelSections,
      ]
    : []),
  '## Licence texts',
  '',
  'Identical texts are printed once and list every package they apply to.',
  '',
);

const groups = new Map();
const noText = [];
for (const e of entries) {
  const owner = `${e.group === 'npm' ? 'npm' : 'crate'} ${e.name} ${e.version}`;
  if (!e.texts.length) {
    noText.push({ owner, e });
    continue;
  }
  for (const t of e.texts) {
    const key = t.text.replace(/\s+/g, ' ').trim();
    const g = groups.get(key) ?? { text: t.text, owners: [] };
    g.owners.push(owner);
    groups.set(key, g);
  }
}
const sortedGroups = [...groups.values()].sort((a, b) => a.owners[0].localeCompare(b.owners[0]));
for (const g of sortedGroups) {
  out(`### ${g.owners.length > 3 ? `${g.owners.slice(0, 3).join(', ')} and ${g.owners.length - 3} more` : g.owners.join(', ')}`, '');
  if (g.owners.length > 3) out(`Applies to: ${g.owners.join(', ')}.`, '');
  out('```text', g.text, '```', '');
}
const noteOnly = entries.filter((e) => e.notes.length);
if (noText.length || noteOnly.length) {
  out('### Packages without a separate licence file', '');
  for (const { owner, e } of noText) {
    out(
      `- **${owner}** (${e.license}): ${e.notes.length ? e.notes.join(' ') : `the published package contains no licence file; it is licensed under ${e.chosen.join(' AND ')} per its manifest${e.chosen.some((id) => ['Apache-2.0', 'MPL-2.0'].includes(family(id))) ? ' (full text under "Standard licence texts")' : ''}. See ${e.repository || 'its repository'}.`}`,
    );
  }
  for (const e of noteOnly.filter((x) => x.texts.length)) out(`- **${e.group === 'npm' ? 'npm' : 'crate'} ${e.name} ${e.version}** (${e.license}): ${e.notes.join(' ')}`);
  out('');
}

out('## Standard licence texts', '');
if (canonical['Apache-2.0']) out('### Apache License 2.0', '', '```text', canonical['Apache-2.0'], '```', '');
if (canonical['MPL-2.0']) out('### Mozilla Public License 2.0', '', '```text', canonical['MPL-2.0'], '```', '');
if (oflBody) out('### SIL Open Font License 1.1', '', '```text', oflBody, '```', '');

const text = `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('✖ THIRD-PARTY-NOTICES.md is out of date. Run `npm run notices` and commit the result.');
    process.exit(1);
  }
  console.log(`✔ THIRD-PARTY-NOTICES.md is up to date (${npmEntries.length} npm packages, ${runtimeCrates.length + buildCrates.length} crates).`);
} else {
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, OUT);
  console.log(
    `✔ wrote THIRD-PARTY-NOTICES.md: ${npmEntries.length} npm packages, ${runtimeCrates.length} runtime + ${buildCrates.length} build-time crates, ${fontFamilies.length} fonts, ${groups.size} licence texts (${(text.length / 1024).toFixed(0)} KB)`,
  );
}
