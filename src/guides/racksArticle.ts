// The racks guide (Wave 12.2, research/16 §2.3; racks-app). Kept in its own file; articles.ts lists it after the
// Mixer guide. Pure data. Every label here matches src/panels/plugin/RackEditor.tsx and src/racks/actions.ts.

import type { GuideArticle } from './articles';

export const RACKS_ARTICLE: GuideArticle = {
  id: 'racks',
  title: 'Racks, macros and the drum rack',
  summary: 'Layer and split sounds, build drum kits on pads, run effects in parallel, and steer it all with 8 macro knobs.',
  group: 'Make music',
  icon: 'layers',
  body: `
A **rack** holds several sounds or effect chains side by side, with 8 **macro** knobs on top that each move as many inner knobs as you like. There are three kinds:

- **Instrument rack** (on a channel): each note plays every chain whose key and velocity zone contains it. Layer a pad under a piano, or split a bass below middle C from a lead above it.
- **Drum rack** (on a channel): one chain per pad note, from C2 up. Pads in the same **choke group** cut each other, like open and closed hats.
- **Effect rack** (in a mixer slot): the audio is split into every chain and the chains are summed. The slot's **Mix** is the rack's wet / dry.

Racks hold Krypt Studio's own instruments and effects. Third-party plugins and racks inside racks can't go in a rack yet.

{{video:racks}}

## Make a rack

- Right-click a channel in the Channel Rack ▸ **Wrap in rack** ▸ **Instrument rack** or **Drum rack**. Its sound becomes chain 1, so nothing changes until you add more. The plugin window also has a **Wrap in rack** button next to Reset.
- Right-click an effect in a mixer slot ▸ **Wrap in effect rack**.
- Or load a rack preset from the Browser: **Layered Keys Rack**, **Drum Kit Rack**, **Lo-fi Rack** or **Vocal Rack**.

Every change is one undo step, like any other edit.

## Chains

The chain list shows each chain's name, mute, solo, volume, pan and zone. [[show:rack.chains|Show me]]

- Click a chain to edit it below: its instrument (pick one from the list) and its devices (**Add device**). Every knob works like the ones in a normal plugin window.
- Click the zone to set its lowest and highest key and its velocity range. Chains with overlapping zones play together.
- **Solo** works inside the rack: any soloed chain mutes the others.
- Right-click a chain to rename it, move it or remove it.

## Macros

The 8 macro knobs sit at the top. [[show:rack.macros|Show me]]

1. Right-click any knob inside a chain (an instrument knob, a device knob, its mix, or a chain's volume or pan) and choose **Map to macro** ▸ **Map to Macro N**.
2. Turn the macro: the mapped knob sweeps from where it was to its maximum.
3. Under the knobs, each mapping shows its **Min** and **Max**. Drag them to change the range. Set Max below Min to turn the knob the other way.

Double-click a macro's name to rename it. Macros are normal parameters, so you can right-click one for **Create automation clip**, link it to a MIDI controller, or let an AI agent move it.

**Variations** store all 8 macro positions under a name. Click one to recall it; right-click it to delete it. **Randomize** gives the mapped macros new random positions; undo if you don't like it. [[show:rack.variations|Show me]]

## Automate any knob inside a rack

Every knob inside a rack is a full parameter, like the knobs in a normal plugin window. Right-click it (an instrument knob, a device knob, a device's mix, or a chain's volume or pan) for:

- **Create automation clip**: adds a clip on the first empty Playlist track. Draw the curve there; the knob follows it while the song plays, with a pink dot.
- **Link to controller…**: move a knob on your MIDI controller to take it over.
- **Copy ParamRef**: the knob's address for AI agents and scripts.

When a macro and an automation clip both move the same knob, **the automation wins** while its clip exists. Delete the clip and the macro takes the knob back.

Wrapping a channel or an effect in a rack keeps its automation: the clips now move the same knob inside the rack.

## The drum rack pads

A drum rack shows 16 pads, 4 by 4, with the lowest note at the bottom left. Use the arrows for the next 16 notes. [[show:rack.pads|Show me]]

- Drag a sample from the Browser (or from Explorer) onto a pad to load it. An empty pad gets a new sampler chain.
- Click a pad to hear it and to edit its chain below.
- Right-click a pad to set its **Choke group**, clear its sample, mute it or remove it.

Pad samplers play their sample at its own pitch, whatever note the pad is on. The Channel Rack's step buttons play the channel's root key, which is the first pad for a new drum rack.

## Slice a loop to pads

Right-click an audio clip on the Playlist, a sample in the Browser, or an audio clip channel ▸ **Slice to pads**:

- **At the hits** finds the drum hits with the audio analyzer and keeps the strongest 16 (or 8).
- **Every beat**, **Every 8th note** or **Every 16th note** cuts on an even grid at the loop's tempo.
- **Each cuts the last** puts every pad in choke group 1, so a new slice stops the one playing.

You get a new channel with a drum rack (one pad per slice) and a pattern that plays the slices in order, so it sounds like the loop. Rearrange the notes in the Piano Roll to make new grooves.

## Agents build racks too

AI agents use **build_rack** to build a whole rack in one step (chains, zones, chokes, devices and macro mappings), **set_macro** to move macros and recall variations, and **slice_to_pads** to chop a loop. **set_params** and **add_automation** reach any knob inside a rack by its chain (and device). As always, everything they do can be undone (see [[guide:ai-agents|AI agents]]).
`,
};
