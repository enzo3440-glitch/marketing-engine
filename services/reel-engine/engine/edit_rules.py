"""Editing rules + the trend template library the director builds from.

Sources: your style references (montage + film look, one-shots with song and text, grid/mask edits, call-out ad,
cinematic memory, reveals), what's trending in travel short-form (sound-driven city walks, slow-travel diaries,
photo-dump slideshows, transition chains, "we can't all be in..." humor), and standard reel-editing craft.

RULES are applied by the director and planner; TEMPLATES are copies of trend / reference structures with
slots measured in beats so any sound of the same vibe fits them.
"""

from .common import BRAND_NAME, BRAND_TAGLINE

RULES = {
    "audio": [
        "One soundtrack per reel. Never cut a song in and out with clips' own music.",
        "If a clip carries real music (a quartet, a street musician), that music can BE the soundtrack: "
        "it runs continuously and the edit keeps returning to its source, in sync.",
        "Trending sound drives a template: cuts land on its beats, the hook sits before its first strong beat.",
        "A strong single shot can stand alone with its own sound or one calm trending sound and a line of text.",
        "Sound effects stay under the music (shutter on stills, soft tap into a phone, faint air on reveals).",
    ],
    "cuts": [
        "Cut on beats; long holds (3-6 beats) on hero shots, 1-2 beats on detail and motion shots.",
        "Open on the strongest image, not the first clip. The first 1.5s decides the scroll.",
        "Never the same clip twice in a row; return to a motif clip only on purpose (score source, hero).",
        "Order by energy: establish -> details -> people/motion -> payoff -> resolve on a held hero.",
        "Shaky clips only in short slots; steady clips get the long holds.",
        "Reveal transitions (mask, squares, wipe) only on a change of place or a payoff, at most 3 per reel.",
    ],
    "text": [
        "Hook in the first 1.5s, max 8 words, sentence case, top third (clear of UI and captions).",
        "One line per 2-3 shots at most; every line readable for 1.2s+ (about 3 words per second).",
        "Text appears on a beat and leaves on a cut.",
        "Cinematic / nostalgic: serif italic, few words. Montage: bold caption. Call-out / funny: stamp.",
        "Never invent facts, places or numbers. Place names only when you give them.",
    ],
    "look": [
        "Your references favour film color + grain for montages and golden for one-shots.",
        "One grade per reel. Letterbox only for slow cinematic edits.",
        "Every template has its own look: grade, hook font and end card. Two templates never share a grade and a hook font.",
    ],
    "variance": [
        "Slow templates count every other beat on fast songs (half-time), so a 5-beat hold stays a real hold.",
        "An edit that runs out of music drops shots from the middle, never its ending.",
        "Test versions: B changes the opening shot and the shot order, C changes the hook, its text style and the order.",
        "Clips are spread across a batch: a clip used by earlier versions costs more next time; shaky clips go in quick cuts.",
        "A version too close to one already in the batch is recast, and dropped if it still is.",
    ],
}

VIBES = ["cinematic", "nostalgic", "hype", "calm", "funny"]

# role keys the director assigns to clips: score, hero, establish, detail, people, motion, any
TEMPLATES = [
    dict(id="natural-score", name="Live music score", vibe="cinematic",
         trend="Your references: cinematic edits that let a place's own sound carry the film.",
         audio="clip_music", pacing="cinematic", grade="moody", grain=True, letterbox=True, fx="clean",
         slots=[("score", 6), ("establish", 4), ("detail", 3), ("score", 4), ("people", 3), ("hero", 4), ("detail", 3), ("score", 6)],
         text=[dict(slot=0, kind="hook", style="hook_serif", pos="top"), dict(slot=7, kind="line", style="hook_serif", pos="center")],
         alt_style="serif", hook_pos="upper", endcard=f"{BRAND_NAME}|Listen closer.", endcard_style="serif",
         hooks=["Some places you hear before you see.", "Listen to this place.", "The soundtrack was already playing."]),
    dict(id="hero-oneshot", name="One shot, one line", vibe="calm",
         trend="Your references: one great shot, a song, one line of text.",
         audio="own_or_trending", format="oneshot", pacing="cinematic", grade="golden", grain=True, fx="clean",
         slots=[("hero", 0)], text=[dict(slot=0, kind="hook", style="serif", pos="center")],
         alt_style="hook_serif", hook_pos="center", endcard=f"{BRAND_NAME}|Stay longer.", endcard_style="endcard",
         hooks=["The best part was never on the itinerary.", "Stay a little longer.", "This is the part I'd go back for."]),
    dict(id="city-walk-sound", name="Sound-driven city walk", vibe="calm",
         trend="TikTok, Oct 2026: a walk through a city on nothing but good footage and the right track.",
         audio="trending", pacing="cinematic", grade="clean", grain=True, fx="clean",
         slots=[("motion", 6), ("establish", 6), ("motion", 6), ("hero", 8)],
         text=[dict(slot=0, kind="hook", style="caption", pos="top")],
         alt_style="kicker", hook_pos="upper", endcard=f"{BRAND_NAME}|Just walk.", endcard_style="list",
         hooks=["Just walking.", "No plan, just this.", "Walk first, plan later."]),
    dict(id="slow-travel-diary", name="Slow travel diary", vibe="nostalgic",
         trend="2026: audiences favour slow travel, weeks in one place over fast multi-country trips.",
         audio="trending", pacing="cinematic", grade="golden", grain=True, letterbox=True, fx="clean",
         slots=[("establish", 5), ("detail", 4), ("people", 4), ("detail", 4), ("hero", 6)],
         text=[dict(slot=0, kind="hook", style="hook_serif", pos="top"), dict(slot=4, kind="line", style="hook_serif", pos="center")],
         alt_style="caption", hook_pos="upper", endcard=f"{BRAND_NAME}|Go slower.", endcard_style="endcard",
         hooks=["Slow mornings, no itinerary.", "I stayed longer than planned.", "The days I didn't plan."]),
    dict(id="beat-photo-dump", name="Beat-sync photo dump", vibe="hype",
         trend="Photo carousels / slideshows are favoured right now; cut one shot per beat.",
         audio="trending", pacing="fast", grade="tropical", grain=True, fx="clean",
         slots=[("hero", 4)] + [("any", 1)] * 12 + [("hero", 4)],
         text=[dict(slot=0, kind="hook", style="list", pos="top")],
         alt_style="caption", hook_pos="upper", endcard=f"{BRAND_NAME}|{BRAND_TAGLINE}", endcard_style="list",
         hooks=["Camera roll from this trip.", "Every photo from one weekend.", "Proof I actually went outside."]),
    dict(id="transition-chain", name="Transition chain", vibe="hype",
         trend="Travel transition clips (motion-matched cuts, reveals) keep trending.",
         audio="trending", pacing="fast", grade="teal_orange", grain=True, fx="playful",
         slots=[("motion", 3), ("motion", 2), ("establish", 2), ("motion", 2), ("people", 2), ("motion", 2), ("hero", 4)],
         text=[dict(slot=0, kind="hook", style="hook", pos="top")],
         alt_style="list", hook_pos="center", endcard=f"{BRAND_NAME}|{BRAND_TAGLINE}", endcard_style="list",
         hooks=["Blink and you're somewhere else.", "Same trip, different worlds.", "One trip in fast forward."]),
    dict(id="grid-mask", name="Grid & mask edit", vibe="cinematic",
         trend="Your references: grid / mask editing technique on cinematic travel cuts.",
         audio="trending", pacing="medium", grade="mono", grain=True, fx="playful",
         slots=[("hero", 4), ("detail", 2), ("establish", 2), ("people", 2), ("detail", 2), ("motion", 2), ("hero", 4)],
         text=[dict(slot=0, kind="hook", style="caption", pos="top"), dict(slot=3, kind="line", style="caption", pos="top")],
         alt_style="kicker", hook_pos="top", endcard=f"{BRAND_NAME}|Look closer.", endcard_style="serif",
         hooks=["Places that look edited but aren't.", "You walked past it. Here's what I saw."]),
    dict(id="quiet-drop", name="Quiet start, then the drop", vibe="hype",
         trend="Your Alright nerd ad: call-out over a quiet start, the drop on the reveal.",
         audio="trending", pacing="fast", grade="film", grain=True, fx="clean", build_drop=True,
         slots=[("detail", 6), ("hero", 2), ("motion", 1), ("people", 1), ("motion", 1), ("establish", 2), ("any", 1), ("any", 1), ("hero", 4)],
         text=[dict(slot=0, kind="hook", style="stamp", pos="center"), dict(slot=1, kind="line", style="caption", pos="top")],
         alt_style="hook", hook_pos="center", endcard=f"{BRAND_NAME}|{BRAND_TAGLINE}", endcard_style="endcard",
         hooks=["Do you plan every second of a trip?", "Still planning? Just go."]),
    dict(id="cant-all-be-in", name="We can't all be in...", vibe="funny",
         trend="TikTok, Oct 2026: 'We can't all be in...' humor about picture-perfect destinations.",
         audio="trending", pacing="medium", grade="clean", grain=False, fx="clean",
         slots=[("hero", 4), ("people", 2), ("detail", 2), ("motion", 2), ("hero", 4)],
         text=[dict(slot=0, kind="hook", style="stamp", pos="top")],
         alt_style="caption", hook_pos="top", endcard=f"{BRAND_NAME}|Oh wait.", endcard_style="list",
         hooks=["We can't all be in {place}... oh wait.", "Not everyone gets this view. Sorry."]),
    dict(id="memory-film", name="Cinematic memory", vibe="nostalgic",
         trend="Your references: memory-led cinematic travel edits, film look, long holds.",
         audio="trending", pacing="cinematic", grade="film", grain=True, letterbox=True, fx="clean",
         slots=[("establish", 5), ("people", 4), ("detail", 3), ("motion", 4), ("hero", 6)],
         text=[dict(slot=4, kind="hook", style="serif", pos="center")],
         alt_style="hook_serif", hook_pos="center", endcard=f"{BRAND_NAME}|Go back.", endcard_style="serif",
         hooks=["I'd go back just for this.", "Some places stay with you."]),
]

TEMPLATE_BY_ID = {t["id"]: t for t in TEMPLATES}

# no two templates may look alike: (grade, hook font) is unique per template
_looks = [(t["grade"], t["text"][0]["style"] if t["text"] else None) for t in TEMPLATES]
assert len(set(_looks)) == len(_looks), "two templates share a grade and hook font"


def public_templates():
    """For the desk: everything but internals, plus whether a trending sound is needed."""
    return [dict({k: v for k, v in t.items() if k != "slots"}, shots=len(t["slots"]),
                 needs_sound=t["audio"] == "trending") for t in TEMPLATES]
