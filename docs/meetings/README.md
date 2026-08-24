# Meeting registers

Transcripts in, change registers out. One file per meeting,
`YYYY-MM-DD-<topic>.md`, containing every request made in the room with the
quote that generated it and the file it lands in.

Items are numbered `CR-01`, `CR-02`, … and keep those numbers forever — plans
and commit messages reference them.

## Getting the transcript

**Teams** — turn on *Record and transcribe* before the meeting starts. Afterwards:
the meeting chat → *Recap* / *Transcript* → **Download** → `.vtt` (preferred) or
`.docx`. `.vtt` keeps the speaker names and timestamps cleanly.

**Zoom** — *Record to the Cloud* with Audio Transcript enabled in settings, then
Recordings → **Audio Transcript** (`.vtt`). Local recordings do not transcribe.

**Meet** — *Activities → Transcripts → Start transcription*. Lands in the
organiser's Drive as a Doc; *File → Download → Plain text*.

Tell everyone it is being recorded before you start it.

## Then

```
/meeting <path to transcript>        # transcript  -> register
/meeting-plan docs/meetings/<file>   # register    -> docs/plans/<topic>.md
```

The register is a living file: mark items `done` as they ship, and append later
sessions to the same file if the same topic comes back.

## If the meeting is in Afrikaans

Teams does not transcribe Afrikaans — it is a supported *translation* target, not a
supported spoken language. Two things to do:

1. **Set the meeting's spoken language to Dutch** (More → Language and speech →
   Spoken language). Dutch is on the supported list and is close enough to Afrikaans
   that the transcript comes back mangled-but-readable, rather than the nonsense you
   get leaving it on English. English product terms survive intact either way.
2. **Turn on cloud recording as well as transcription.** The recording is the
   insurance: if the transcript is unusable, the audio can be re-transcribed properly
   afterwards with a model that does support Afrikaans (Whisper handles `af`).

`/meeting` expects this and reads around the damage — see the Afrikaans section in
[the command](../../.claude/commands/meeting.md). Quotes are kept verbatim in the
language spoken; everything else in the register is written in English.
