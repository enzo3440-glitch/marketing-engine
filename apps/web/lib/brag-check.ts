import path from "node:path";
import { BRAND } from "./brand";

/**
 * The checks every /brag ad and every tweak runs before it hands back a cut: the drop lands on the
 * payoff, and someone watches the whole video and makes sure it reads right and makes sense.
 */
export const dropRule = (kit: string, ffmpeg: string) => `
The music drop makes one moment hit: the hook's turn, the line or image the hook builds to (usually 2.5-5 s in), not
the app screen later. Text-led ad: the drop lands the instant the turn line appears. Image-led ad: it lands on the cut
to the hero image. Hold the setup line about 2.5-3 s so it lands.
The dip before the drop is the song's own lead-in, not something you make: find_drop.py picks a drop whose lead-in (the
stretch that plays under the setup) is the song's quiet build, and the -ss it prints starts the song there. Play the
song straight from that point as one continuous piece: no volume automation that pulls it down to nothing, no jumps
in level, no second song or second start point, no cuts in the music. Only a short fade-in at the start (0.3 s) and a
fade-out over the end card. If it says no drop has a calm lead-in, use another track. After the drop the music
carries the rest.
Find the song's real drops with: python ${path.join(kit, "sound", "find_drop.py")} <song> <drop_moment_seconds>. It
prints the -ss to start the song at so its drop lands on that moment (ffmpeg is ${ffmpeg}). Prefer calm, inspirational
electronic tracks with a soft drop over rock.`;

export const wholeVideoCheck = (video: string, ask: string) => `
Before you finish, check the WHOLE video, start to end, as a viewer would:
1. Pull one frame every 0.5 s from ${video} (ffmpeg fps=2, scaled to 360 px wide, tiled into contact sheets) and read
   them all in order. Read every on-screen line in the order it appears.
2. Every on-screen line the ask below quotes as a line to use is there, word for word, in the order asked, and none
   was shortened, dropped or merged (lines it only describes as an angle may be rewritten in the brand voice):
   "${ask.replace(/"/g, "'").slice(0, 900)}"
3. The lines make sense one after another (a hook, then what follows from it). Nothing reads like a fragment.
4. Every line stays up at least 1.5 s plus about 0.3 s per word beyond four, and screens with something to read stay
   2.5-3 s. Nothing is cut off, off screen, overlapping, or covered by a card.
5. The drop: say which moment it hits (the hook's turn line or the hero image) and why that's the moment the ad is
   built around. Run find_drop.py on the song with the -ss you used and confirm the drop lands within 0.1 s of that
   line or cut, the setup before it holds about 2.5-3 s, and the music under the setup is the song's own quieter lead-in
   played straight (one continuous song, no volume dips or jumps, nothing that sounds spliced).
6. The end card is on screen long enough to read, and the video doesn't end on black or a half-faded frame.
7. Every shot fits the ${BRAND.niche} niche and the shot rules in brand-content.md / brand-voice.md: no workout or progress photo, no mirror selfie,
   no off-topic product shot, no personal photo, nothing about a body or an outfit instead of the subject. If a frame fails this,
   swap the shot for an on-topic shot and re-render.
8. The cinematic look (README.md). No photo pans, zooms or push-ins, and no added zoom on video.
   Every on-screen line sits around the middle or in the lower third, never in the top third. No map pin or location
   badge unless it marks a real, named place. Colour is natural and filmic, not oversaturated.
9. No clip appears twice: no source clip, and no moment of one, shows up twice in the video.
10. No on-screen word is an editing note, timestamp, file name or label (e.g. "Hook (0.0 s)", "IMG_0001", "[no text]").
   Also write script.txt as only the words that are actually on screen, first line = the hook as shown (or the place
   name if there's no text), with no notes.
If anything fails, fix it and re-render, then check again. Write what you checked and the result, one line per point,
to check.txt next to the video.`;
