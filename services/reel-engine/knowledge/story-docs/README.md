# Story docs: narrated place mini-docs

A story doc is a short vertical video where one voice tells the most compelling story of a place, the way a good
travel-show cold open does. Archive pictures, maps and graphics go over the narration. The renderer is
`engine/storydoc.py`.

No scripts ship with this repo. To add your own:

1. Write the narration as a plain `.txt` file here (for example `knowledge/story-docs/my-place.txt`). Blank lines
   separate paragraphs. Write numbers out as words and leave out stage directions. The last paragraph is your call to
   action. `captions.json` is an optional per-story caption map and may stay `{}`.
2. Record or synthesize the narration. For local synthesis set `NARRATION_VOICE` to a Piper `.onnx` voice model you
   have the rights to use, then run `python -m engine.narrate --script knowledge/story-docs/my-place.txt --out narration.wav`.
3. Put pictures and clips in `reel-data/story-docs/<place>/` with a `beats.json` (one beat per paragraph, the call to
   action excluded) and `credits.json`. See the docstring at the top of `engine/storydoc.py` for the format.
4. Render with `python -m engine.storydoc --story reel-data/story-docs/<place> --script knowledge/story-docs/my-place.txt --audio narration.wav --out <dir>`.

**The narration is the truth.** The `.txt` must match the audio word for word, because subtitles and every cut are
timed to the spoken words (word timings aligned to the script).

## How the writing works

- **Cold open on the cliche, then knock it down.** Open with the postcard version a viewer already believes, then turn
  it with a short line.
- **Spoken, not written.** Short fragments, lists of three, second person. Each sentence is one breath.
- **History told as people, with dates as hard facts.** One named person or group per era. One concrete detail beats
  a summary.
- **Don't edit the dark out.** Name hard history plainly, without wallowing, then move on.
- **End on a turn, not a summary.** The last line reframes what came before. Read the call to action flat and warm.
- Write original lines. Never quote or imitate a real person's voice or likeness.

## Look of the cut

- **Hook:** the opening statement is big serif text in the middle of the frame. Each word arrives as it's said.
- **Subtitles:** lower third, with key names in gold.
- **Pictures:** full-frame slow pans aimed at what the line is about; maps and documents sit whole on a blurred fill.
  About one shot every 3-5 s, cut on the spoken noun (`"on": "phrase"`). Archive pictures get a warm, faded film look;
  modern ones stay clean.
- **Footage:** Wikimedia Commons archive film and modern open-licence video (`engine/commons.py` searches it, makes
  contact sheets and cuts clips; public domain, CC0, CC BY and CC BY-SA only), plus your own clips from the place.
- **Graphics** stay pinned to the picture as it pans: a self-drawing circle, a highlight box, an arrow, a pulsing pin, a
  route across a map, a label chip with a leader line.
- **Era and emphasis:** a typewriter date stamp at each era, a big gold emphasis title on the key line, dips to black
  between eras.
- **Sound:** a few low kit sounds (whoosh, thump), never sparkles.
- **Ending:** the end card credits Wikimedia Commons, and the caption names the CC BY / BY-SA authors.

Labels only say what is verifiably true of that picture ("AS IT STOOD IN 1915"). Never invent a caption for a photo.
Fact-check every claim, and hedge lore and disputed figures on air ("depending on who's telling it").

## Images

Use public-domain and freely licensed archive images from Wikimedia Commons, kept in `reel-data/story-docs/<place>/`
with `credits.json`. CC BY / BY-SA images need the credit in the caption.
