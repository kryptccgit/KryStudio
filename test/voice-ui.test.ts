// Krypt Voice renderer logic (src/voice/logic.ts + src/voice/sing.ts): voice groups and blocks, the text box (tags at
// the cursor, tags stripped for local voices, limits), speed, placement, forms → SpeakRequest / SingRequest, stages,
// failures, the Fish key and own-voice checks, finding the recorded take, the Sing my notes labels (over the shared
// planner); plus the entry points, the mock, the guide article and its anchors being wired.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import { CONSENT_LINE, FISH_TAGS, type VoiceInfo, type VoiceState } from '@shared/voice/types';
import type { Project } from '@shared/schema/project';
import {
  DEFAULT_SING,
  DEFAULT_SPEAK,
  MAX_TEXT,
  NOT_AVAILABLE,
  audioClipIds,
  barAtTick,
  barError,
  barFraction,
  buildSingRequest,
  buildSpeakRequest,
  charCountLabel,
  clampSpeed,
  cloneNameError,
  engineOfId,
  failureMessage,
  fishKeyError,
  fmtSpeed,
  groupOf,
  groupVoices,
  hasTags,
  insertAtCursor,
  isCancelMessage,
  isCloudVoice,
  needsKey,
  needsModel,
  newAudioTakes,
  percentText,
  pickVoice,
  placementLine,
  recordingTooShort,
  singFormError,
  speakFormError,
  stageStates,
  stagesFor,
  stripTags,
  textError,
  voiceBlock,
  type SpeakForm,
} from '../src/voice/logic';
import { labelsFromOutcome, mapSyllables, mappingLine, melodyNotes, parseBarRange, parseLyrics, plannedRows } from '../src/voice/sing';
import { HOME_ACTION_IDS } from '../src/home/logic';
import { GUIDE_ANCHORS } from '../src/guides/anchors';
import { articleById } from '../src/guides/articles';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
      /* keep climbing */
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), 'utf8');

const V = (id: string, engine: 'local' | 'fish', mine = false): VoiceInfo => ({ id, engine, name: id.split(':')[1], description: '', language: 'en', ...(mine ? { mine: true } : {}) });
const VOICES = [V('local:af_heart', 'local'), V('local:am_michael', 'local'), V('fish:host', 'fish'), V('mine:abc', 'fish', true)];
const st = (installed: boolean, keySet: boolean, voices = VOICES): VoiceState => ({ local: { installed, modelId: installed ? 'kokoro' : null }, fish: { keySet }, voices });
const TS = { num: 4, den: 4 } as unknown as Parameters<typeof barAtTick>[1];

test('voices: groups, engines, blocks and the default pick', () => {
  assert.equal(groupOf(VOICES[0]), 'local');
  assert.equal(groupOf(VOICES[2]), 'cloud');
  assert.equal(groupOf(VOICES[3]), 'mine');
  assert.equal(groupOf({ id: 'mine:x', engine: 'fish' }), 'mine', 'the id prefix alone marks my voice');
  const g = groupVoices(VOICES);
  assert.deepEqual([g.local.length, g.cloud.length, g.mine.length], [2, 1, 1]);
  assert.equal(engineOfId('local:af_heart'), 'local');
  assert.equal(engineOfId('mine:abc'), 'fish');
  assert.ok(isCloudVoice('fish:host') && isCloudVoice('mine:abc') && !isCloudVoice('local:x') && !isCloudVoice(null));

  assert.equal(voiceBlock(st(false, false), 'local:af_heart')?.kind, 'needModel');
  assert.match(voiceBlock(st(false, false), 'local:af_heart')!.message, /Model Manager/);
  assert.equal(voiceBlock(st(true, false), 'fish:host')?.kind, 'needKey');
  assert.match(voiceBlock(st(true, false), 'mine:abc')!.message, /Settings ▸ Voice/);
  assert.equal(voiceBlock(st(true, true), 'fish:gone')?.kind, 'missing');
  assert.equal(voiceBlock(st(true, true), null)?.kind, 'missing');
  assert.equal(voiceBlock(st(true, true), 'fish:host'), null);
  assert.equal(voiceBlock(null, 'fish:host'), null, 'unknown state never blocks (the service decides)');
  // a message from main wins
  assert.equal(voiceBlock({ ...st(false, false), local: { installed: false, modelId: null, message: 'Kokoro is downloading' } }, 'local:af_heart')?.message, 'Kokoro is downloading');

  assert.equal(pickVoice(st(true, true), 'fish:host'), 'fish:host', 'remembered and still listed');
  assert.equal(pickVoice(st(true, true), 'fish:removed'), 'local:af_heart', 'gone → the first usable local');
  assert.equal(pickVoice(st(false, true), null), 'mine:abc', 'no Kokoro → my voice before stock cloud voices');
  assert.equal(pickVoice(st(false, false), null), 'local:af_heart', 'nothing usable → still pick something (the picker shows why)');
  assert.equal(pickVoice(st(true, true, []), null), null);
});

test('text: tags at the cursor, tags stripped for local voices, count and limits', () => {
  assert.deepEqual(insertAtCursor('hello world', '[whisper]', 5), { text: 'hello [whisper] world', caret: 15 });
  assert.deepEqual(insertAtCursor('', '[excited]', 0), { text: '[excited] ', caret: 10 });
  assert.deepEqual(insertAtCursor('yo ', '[hype]', 3), { text: 'yo [hype] ', caret: 10 });
  assert.equal(insertAtCursor('say this loud', '[shouting]', 4, 8).text, 'say [shouting] loud', 'a selection is replaced');
  assert.equal(insertAtCursor('ab', '[sad]', 99).text, 'ab [sad] ', 'clamped to the end');
  assert.ok(hasTags('Yo [whisper] keep it quiet'));
  assert.ok(!hasTags('No tags here [1]'));
  assert.ok(hasTags('[laughing] ha'), 'hasTags is repeatable (no sticky regex state)');
  assert.ok(hasTags('[laughing] ha'));
  assert.equal(stripTags('Yo [whisper] keep it  quiet [excited] then drop it!'), 'Yo keep it quiet then drop it!');
  assert.equal(stripTags('[calm]\nline two [sad]'), 'line two');
  assert.equal(textError('  '), 'Type what the voice should say');
  assert.match(textError('[whisper] [sad]')!, /Only tags/);
  assert.match(textError('x'.repeat(MAX_TEXT + 1))!, /too long/);
  assert.equal(textError('Krypt on the beat'), null);
  assert.equal(charCountLabel('héllo'), `5 / ${MAX_TEXT.toLocaleString('en-US')}`);
  for (const t of FISH_TAGS) assert.match(t, /^\[[a-z]+\]$/, 'the chips are Fish tags');
});

test('speed and placement', () => {
  assert.equal(clampSpeed(3), 2);
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed(1.234), 1.25);
  assert.equal(clampSpeed(Number.NaN), 1);
  assert.equal(fmtSpeed(1), '1.0×');
  assert.equal(fmtSpeed(1.25), '1.25×');
  assert.equal(barError('9'), null);
  assert.equal(barError('9.3'), null);
  assert.match(barError('0')!, /start at 1/);
  assert.match(barError('9.0')!, /Beats start at 1/);
  assert.match(barError('nine')!, /like 9/);
  assert.equal(barAtTick(0, TS), '1');
  assert.equal(barAtTick(3840 * 8, TS), '9');
  assert.equal(barAtTick(3840 * 8 + 960 * 2 + 100, TS), '9.3');
  assert.equal(placementLine({ mode: 'playhead', bar: '1', trackId: '' }), 'At the playhead, on a new track');
  assert.equal(placementLine({ mode: 'bar', bar: ' 9.3 ', trackId: 't1' }, 'Vox'), 'At bar 9.3, on Vox');
});

test('forms → SpeakRequest / SingRequest', () => {
  const f: SpeakForm = { ...DEFAULT_SPEAK, text: ' Yo [whisper] quiet ', voiceId: 'local:af_heart', speed: 1, tune: 'hard', placement: { mode: 'bar', bar: '9.3', trackId: 't2' } };
  assert.deepEqual(buildSpeakRequest(f, false), { text: 'Yo quiet', voiceId: 'local:af_heart', at: '9.3', track: 't2', tune: 'hard' }, 'local: tags stripped');
  assert.deepEqual(buildSpeakRequest({ ...f, voiceId: 'fish:host', speed: 1.5 }, false), { text: 'Yo [whisper] quiet', voiceId: 'fish:host', speed: 1.5, at: '9.3', track: 't2', tune: 'hard' }, 'cloud keeps the tags');
  assert.deepEqual(buildSpeakRequest({ ...f, tune: 'off', placement: { mode: 'playhead', bar: '', trackId: '' } }, false), { text: 'Yo quiet', voiceId: 'local:af_heart' }, 'the playhead on a new track = no at / track');
  assert.deepEqual(buildSpeakRequest(f, true), { text: 'Yo quiet', voiceId: 'local:af_heart', preview: true, tune: 'hard' }, 'a preview never places');
  assert.equal(buildSpeakRequest({ ...f, voiceId: null }, false), null);
  assert.equal(speakFormError(f, st(true, true), false), null);
  assert.match(speakFormError({ ...f, placement: { ...f.placement, bar: 'x' } }, st(true, true), false)!, /like 9/);
  assert.equal(speakFormError({ ...f, placement: { ...f.placement, bar: 'x' } }, st(true, true), true), null, 'a preview ignores the placement');
  assert.match(speakFormError({ ...f, voiceId: 'fish:host' }, st(true, false), true)!, /Fish Audio key/);

  const target = { patternId: 'p1', channelId: 'c1' };
  const s = { ...DEFAULT_SING, lyrics: ' hold me close ', voiceId: 'local:af_heart' };
  assert.equal(DEFAULT_SING.tune, 'hard', 'Sing my notes defaults to the tuned sound');
  assert.deepEqual(buildSingRequest(s, target, false), { patternId: 'p1', channelId: 'c1', lyrics: 'hold me close', voiceId: 'local:af_heart', tune: 'hard', vibrato: 0.2, glideMs: 40 });
  assert.deepEqual(buildSingRequest({ ...s, bars: '2-4', octave: -1, vibrato: 3, glideMs: 999 }, target, true), {
    patternId: 'p1',
    channelId: 'c1',
    lyrics: 'hold me close',
    voiceId: 'local:af_heart',
    tune: 'hard',
    vibrato: 1,
    glideMs: 400,
    bars: '2-4',
    octave: -1,
    preview: true,
  });
  assert.equal(buildSingRequest({ ...s, bars: '3-3' }, target, false)!.bars, '3');
  assert.match(singFormError({ ...s, lyrics: '' }, st(true, true), 4)!, /lyrics/);
  assert.match(singFormError(s, st(true, true), 0)!, /no notes/);
  assert.match(singFormError({ ...s, bars: '4-2' }, st(true, true), 4)!, /range like 1-4/);
  assert.equal(singFormError(s, st(true, true), 4), null);
});

test('stages, progress and failures', () => {
  assert.deepEqual(stagesFor('speak', true).map((s) => s.id), ['phonemes', 'speaking']);
  assert.deepEqual(stagesFor('sing', false).map((s) => s.id), ['phonemes', 'speaking', 'syllables', 'singing', 'placing']);
  const stages = stagesFor('sing', false);
  assert.deepEqual(stageStates(stages, 'running', 'syllables'), ['done', 'done', 'active', 'pending', 'pending']);
  assert.deepEqual(stageStates(stages, 'running', null), ['active', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(stageStates(stages, 'failed', 'singing'), ['done', 'done', 'done', 'failed', 'pending']);
  assert.deepEqual(stageStates(stages, 'cancelled', 'speaking'), ['done', 'stopped', 'pending', 'pending', 'pending']);
  assert.ok(stageStates(stages, 'done', 'speaking').every((x) => x === 'done'));
  assert.equal(barFraction('running', null), -1);
  assert.equal(barFraction('running', { stage: 'speaking', fraction: 1.4, message: '' }), 1);
  assert.equal(barFraction('done', null), 1);
  assert.equal(percentText(0.426), '43 %');
  assert.equal(percentText(-1), '');
  assert.equal(failureMessage(new Error("Error invoking remote method 'voice:speak': Error: No handler registered for 'voice:speak'")), NOT_AVAILABLE);
  assert.equal(failureMessage("Error invoking remote method 'voice:speak': Error: Fish Audio quota used up"), 'Fish Audio quota used up');
  assert.equal(failureMessage(''), 'Krypt Voice failed without saying why');
  assert.ok(isCancelMessage('Cancelled by the user'));
  assert.ok(needsModel('Install Kokoro in the Model Manager first'));
  assert.ok(!needsModel('The text is empty'));
  assert.ok(needsKey('Fish Audio refused the key (401)'));
  assert.ok(needsKey('The Fish free tier has ended'));
  assert.ok(!needsKey('The text is empty'));
});

test('Fish key, own-voice checks and finding the recorded take', () => {
  assert.match(fishKeyError('')!, /Paste/);
  assert.match(fishKeyError('abc def ghi jkl mno')!, /spaces/);
  assert.match(fishKeyError('short')!, /too short/);
  assert.equal(fishKeyError('  0123456789abcdef0123  '), null);
  assert.match(cloneNameError(' ')!, /name/);
  assert.match(cloneNameError('x'.repeat(41))!, /40/);
  assert.equal(cloneNameError('My voice'), null);
  assert.ok(recordingTooShort(6) && !recordingTooShort(28));
  assert.match(CONSENT_LINE, /my own voice/);

  const p = {
    playlist: {
      clips: {
        old: { id: 'old', kind: 'audio', channelId: 'ch_old', trackId: 't', start: 0, length: 1, offset: 0, mute: false, color: null },
        pat: { id: 'pat', kind: 'pattern', patternId: 'p', trackId: 't', start: 0, length: 1, offset: 0, mute: false, color: null },
        take: { id: 'take', kind: 'audio', channelId: 'ch_take', trackId: 't', start: 0, length: 1, offset: 0, mute: false, color: null },
        stem: { id: 'stem', kind: 'audio', channelId: 'ch_stem', trackId: 't', start: 0, length: 1, offset: 0, mute: false, color: null },
      },
    },
    channels: { ch_old: { generator: { sampleId: 's_old' } }, ch_take: { generator: { sampleId: 's_take' } }, ch_stem: { generator: { sampleId: 's_stem' } } },
    samples: {
      s_old: { id: 's_old', name: 'old', path: 'C:/old.wav' },
      s_take: { id: 's_take', name: 'Recording 1', path: 'C:/rec/take.wav', frames: 48000 * 30, sampleRate: 48000 },
      s_stem: { id: 's_stem', name: 'vocals', path: 'C:/stems/vocals.wav', origin: { kind: 'stem' } },
    },
  } as unknown as Project;
  const before = new Set(['old']);
  assert.deepEqual(newAudioTakes(p, before), [{ clipId: 'take', channelId: 'ch_take', path: 'C:/rec/take.wav', seconds: 30 }], 'only a new recorded clip, never a separated / rendered file');
  assert.deepEqual([...audioClipIds(p)].sort(), ['old', 'stem', 'take']);
});

const NOTE = (tick: number, key: number, dur = 480, mute = false) => ({ tick, key, dur, mute });

test('Sing my notes: bar ranges and the melody follow the shared planner', () => {
  assert.equal(parseBarRange(''), null);
  assert.deepEqual(parseBarRange('2-4'), { from: 2, to: 4 });
  assert.deepEqual(parseBarRange(' 3 '), { from: 3, to: 3 });
  assert.equal(parseBarRange('4-2'), 'invalid');
  assert.equal(parseBarRange('0'), 'invalid');
  assert.equal(parseBarRange('one'), 'invalid');
  const notes = [NOTE(0, 60), NOTE(0, 64), NOTE(960, 62, 480, true), NOTE(3840, 65), NOTE(3840 * 2, 67)];
  const all = melodyNotes(notes, null, TS);
  assert.deepEqual(all.map((n) => n.key), [64, 65, 67], 'a chord sings its top note; muted notes are skipped');
  assert.deepEqual(melodyNotes(notes, { from: 2, to: 2 }, TS).map((n) => n.key), [65], 'only bar 2');
});

test('Sing my notes: syllable labels on the roll (holds, extra notes, extra syllables) and the rendered mapping', () => {
  const melody = melodyNotes([NOTE(0, 60), NOTE(480, 62), NOTE(960, 64), NOTE(1440, 65), NOTE(1920, 67)], null, TS);
  const m = mapSyllables(parseLyrics('hold to-night_'), melody);
  assert.deepEqual(
    m.labels.map((l) => [l.text, l.kind]),
    [
      ['hold', 'start'],
      ['to', 'start'],
      ['night', 'start'],
      ['', 'hold'],
      ['', 'hold'],
    ],
    '"-" splits by hand, "_" holds one more note, the leftover note holds the last syllable',
  );
  assert.equal(m.syllables, 3);
  assert.equal(m.notes, 5);
  assert.ok(m.messages.some((x) => /more note/.test(x)), 'the extra note is mentioned');
  assert.equal(mappingLine(m), '3 syllables on 5 notes');

  const squeezed = mapSyllables(parseLyrics('one two three four five six eight'), melody);
  const last = squeezed.labels[squeezed.labels.length - 1];
  assert.equal(last.kind, 'extra');
  assert.equal(last.text, 'five·six·eight');
  assert.ok(squeezed.messages.some((x) => /more syllable/.test(x)));
  assert.equal(squeezed.labels.length, melody.length, 'one label per note');

  assert.equal(mappingLine({ syllables: 0, notes: 0 }), 'No notes here: draw a melody first');
  assert.equal(mappingLine({ syllables: 0, notes: 4 }), 'Type the lyrics: 4 notes to sing');

  // A render's mapping (singplan.mappingRows: one row per note, "_" on held notes) → the same labels as the preview.
  const rows = plannedRows(parseLyrics('hold to-night_'), melody);
  assert.equal(rows.length, melody.length);
  const fromOutcome = labelsFromOutcome(rows, melody);
  assert.deepEqual(
    fromOutcome.map((l) => [l.text, l.kind, l.dur]),
    m.labels.map((l) => [l.text, l.kind, l.dur]),
    'the preview shows exactly where main will put the syllables',
  );
  assert.equal(labelsFromOutcome([{ syllable: 'la', noteTick: 99999, key: 70 }], melody)[0].dur, 240, 'a note that is gone still gets a label');
});

test('entry points are wired: Tools menu + command, Home card + action, piano roll button + menu + command, playlist menus, Settings, mock', () => {
  assert.match(read('src/app/TitleBar.tsx'), /cmd\('tools\.kryptVoice', 'Krypt Voice…'/);
  assert.match(read('src/app/actions.ts'), /id: 'tools\.kryptVoice'[^\n]*openKryptVoice\(/);
  assert.ok((HOME_ACTION_IDS as readonly string[]).includes('kryptVoice'));
  assert.match(read('src/home/actions.ts'), /kryptVoice:\s*\{[^}]*openKryptVoice\(\)/);
  const home = read('src/home/screens/AudioToolsScreen.tsx');
  assert.match(home, /<KryptVoiceCard \/>/);
  assert.match(home, /data-guide="home\.kryptVoice"/);
  assert.match(home, /runHomeAction\('kryptVoice'\)/);
  const pr = read('src/panels/pianoRoll/PianoRoll.tsx');
  assert.match(pr, /data-guide="voice\.sing"[^\n]*openSingDialog\(ctl\)/);
  assert.match(read('src/panels/pianoRoll/toolDialogs.tsx'), /label: 'Sing my notes…'[^\n]*openSingDialog\(ctl\)/);
  assert.match(read('src/panels/pianoRoll/commands.ts'), /id: 'pianoRoll\.sing'[^\n]*openSingDialog/);
  assert.match(read('src/panels/pianoRoll/controller.ts'), /showSyllables\(marks: SyllableMark\[\] \| null\)/);
  const pl = read('src/panels/playlist/Playlist.tsx');
  assert.match(pl, /Add a voice here…[^\n]*openKryptVoice\(\{ at: barAtTick\(tick, ts\)/, 'the ruler menu: at that bar');
  assert.match(pl, /'Add a voice here…'[^\n]*openKryptVoice\(\{ trackId: id/, 'the track menu: on that track');
  assert.match(read('src/panels/settings/SettingsPanel.tsx'), /data-guide="settings\.voice"[\s\S]{0,200}<VoiceSettings \/>/);
  assert.match(read('src/dev/mockKrypt.ts'), /voice: createMockVoice\(host\)/);
  const settings = read('src/voice/VoiceSettings.tsx');
  assert.match(settings, /type="password"/, 'the key is masked');
  assert.match(settings, /saveFishKey\(null\)|save\(null\)/, 'Remove');
  assert.match(read('src/voice/actions.ts'), /window\.krypt\.voice\.setFishKey\(/);
  assert.match(read('src/voice/actions.ts'), /window\.krypt\.engine\.previewFile\(path\)/, 'Preview plays the render through the engine');
});

test('own voice only: the Record dialog uses the live recorder, shows the consent line, and never offers an upload', () => {
  const rec = read('src/voice/RecordVoiceDialog.tsx');
  assert.match(rec, /CONSENT_LINE/);
  assert.match(rec, /window\.krypt\.record\.setArmed\(true\)/);
  assert.match(rec, /window\.krypt\.engine\.transport\('play'\)/);
  assert.match(rec, /cloneMyVoice\(\{ recordingPath: take\.path, name: name\.trim\(\), consent: true \}\)/);
  assert.ok(!/type="file"|showOpenDialog|pickFile|openFile/i.test(rec), 'no file upload path');
  assert.match(rec, /disabled=\{!consent/, 'Make my voice waits for the consent box');
});

test('guides: the Krypt Voice article, its anchors and openers; Krypt Tune, never Auto-Tune', () => {
  const art = articleById('krypt-voice');
  assert.ok(art, 'the article exists');
  assert.equal(art!.group, 'AI and audio');
  const ids = ['home.kryptVoice', 'voice.text', 'voice.voices', 'voice.tags', 'voice.preview', 'voice.add', 'voice.sing', 'sing.lyrics', 'sing.add', 'voice.record', 'settings.voice'];
  for (const id of ids) {
    assert.ok(id in GUIDE_ANCHORS, `${id} is an anchor`);
    assert.ok(art!.body.includes(`[[show:${id}`), `the article shows ${id}`);
  }
  assert.match(art!.body, /\[\[action:kryptVoice\|/);
  assert.match(art!.body, /Only ever record and clone your own voice/);
  assert.match(art!.body, /aren't trained singers/);
  assert.match(art!.body, /Fish Audio receives your text/);
  assert.match(art!.body, /`to-night`/);
  assert.match(art!.body, /`fly_`/);
  const show = read('src/guides/show.ts');
  for (const id of ['voice.text', 'voice.voices', 'voice.tags', 'voice.preview', 'voice.add']) assert.match(show, new RegExp(`'${id.replace('.', '\\.')}': openVoiceForm`));
  assert.match(show, /'sing\.lyrics': \(\) => runCommand\('pianoRoll\.sing'\)/);
  assert.match(show, /'home\.kryptVoice': \(\) => showHome\('audio'\)/);
  const files = ['src/voice/VoiceDialog.tsx', 'src/voice/SingDialog.tsx', 'src/voice/RecordVoiceDialog.tsx', 'src/voice/VoiceSettings.tsx', 'src/voice/parts.tsx', 'src/voice/logic.ts', 'src/guides/voiceArticle.ts'];
  for (const f of files) assert.ok(!/auto-?tune/i.test(read(f)), `${f}: Krypt Tune, never Auto-Tune`);
  const dialog = read('src/voice/VoiceDialog.tsx');
  for (const id of ['voice.text', 'voice.voices', 'voice.tags', 'voice.preview', 'voice.add']) assert.ok(dialog.includes(`data-guide="${id}"`), `the dialog sets ${id}`);
  assert.match(read('src/voice/parts.tsx'), /Cloud/, 'the Cloud badge');
});

void run('voice-ui');
