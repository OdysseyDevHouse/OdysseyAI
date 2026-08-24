---
description: Turn a meeting recording transcript into a structured change register mapped onto this codebase
---

Turn a meeting transcript into a change register: every request, complaint, decision
and open question that came out of the meeting, attributed and mapped onto the real
files in this repo.

Arguments the user gave: $ARGUMENTS

Usually a path to a transcript. If they gave nothing, look in `docs/meetings/` and the
usual download spots for the newest transcript file and confirm which one you found
before parsing it.

## 1. Get the text out

| Source | How to read it |
| --- | --- |
| `.vtt` / `.srt` (Teams, Zoom, Meet) | Plain text. Strip the `WEBVTT` header, cue numbers and `-->` timing lines; keep the speaker labels. |
| `.docx` (Teams "Download transcript") | It is a zip: `unzip -p file.docx word/document.xml` then strip tags — `sed -e 's/<\/w:p>/\n/g' -e 's/<[^>]*>//g'`. |
| `.txt` / `.md` / pasted notes | Use as is. |
| Anything audio (`.m4a`, `.mp3`, `.wav`) | Stop. You cannot transcribe audio. Say so and ask for the text transcript. |

## 1a. Afrikaans, and mangled Afrikaans

Meetings here are often held in Afrikaans, or in Afrikaans code-switched with English
product terms. Teams cannot transcribe Afrikaans as a spoken language, so a transcript
may arrive as Afrikaans run through a Dutch or English recogniser: real words, wrong
ones. Expect `lisensie` as `licentie`, screen names garbled, English tech terms
surviving intact in an otherwise broken sentence.

Read it anyway — the meaning is usually recoverable, because the English product nouns
come through clean and they are the load-bearing part. Where a sentence is beyond
rescue, say so in the item's notes rather than guessing at it; the user was in the room
and can fill it in.

If a cleaner re-transcription of the same meeting turns up later, prefer it and rebuild
the register from it, keeping the `CR-` numbers already assigned.

**Language of the register:** quotes stay verbatim in whatever was said — never
translate a quote, it is the evidence. Everything else you write (titles, notes,
summary, questions) is English, to match the rest of `docs/`. Where a verbatim quote is
Afrikaans, follow it with a one-line English gloss in brackets.

Long transcripts: read the whole thing before writing anything. Do not summarise as
you skim — a request made once in passing counts as much as one argued for ten minutes.

## 2. Pull out every actionable item

An item is anything that implies the software should be different, or that a decision
was taken. Capture the small stuff — "the button should be on the right" is exactly
what this file exists for. Also capture:

- Disagreements between attendees, with both positions.
- Things that were asked for and **rejected** in the room (status `parked`, with why).
- Questions nobody could answer (status `question`).
- Praise or explicit approval of existing behaviour — it stops it being "improved" later.

Do not invent, merge or tidy requests into what you think they meant. If two people
asked for contradictory things, that is two rows and a flagged conflict, not one
reconciled row.

## 3. Map each item onto the codebase

For every UI or behaviour item, actually find where it lives — grep for the label
text, the screen name, the component. Cite the file as a markdown link, e.g.
`[LicencesPanel.tsx](src/app/(app)/setup/terminals/LicencesPanel.tsx)`. If you cannot
find it, write `unknown — needs a look` rather than guessing a path.

Flag anything that touches:

- the control DB (`odyssey_tickets`) vs a per-site trading DB — say which,
- licensing / device registration,
- shared UI in `src/components/ui/` (a change there restyles the whole product),
- printing, numbering, or anything with an audit trail.

## 4. Write the register

Write to `docs/meetings/YYYY-MM-DD-<short-topic>.md` (use the meeting's date, not
today's, if the transcript says otherwise). If a file for that date already exists,
append a new session section rather than overwriting.

```markdown
# <Topic> — <date>

**Attendees:** …
**Transcript:** <path to source file>

## Summary

Three to six sentences: what the meeting was for, what was actually decided, and the
single biggest thing that changes as a result.

## Change register

### CR-01 — <one line, imperative: "Move licence actions to the right of the panel">

- **Who:** <name>
- **Said:** "<verbatim quote — the sentence that generated this item>"
- **Type:** UI tweak | behaviour change | new feature | bug | decision | question
- **Where:** [File.tsx](src/…/File.tsx)
- **Size:** trivial | small | needs design
- **Status:** open | decided | parked | question
- **Notes:** context, conflicts with CR-0N, what it depends on

### CR-02 — …

## Open questions

Numbered, each with who needs to answer it.

## Conflicts

Where two attendees asked for incompatible things — both positions, no adjudication.
```

Number items `CR-01`, `CR-02`, … and never renumber them afterwards; other documents
and commits will reference them.

## 5. Report back

Tell the user the file path and a short readout: how many items, the split by type,
anything that is bigger than it sounds, and any conflict that needs a human decision
before work can start. Do not start implementing anything.

Then mention that `/meeting-plan <this file>` turns the register into a sequenced
implementation plan.
