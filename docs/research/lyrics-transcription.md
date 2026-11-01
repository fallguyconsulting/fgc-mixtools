# Lyrics transcription: research note

Status: research only, nothing is built yet. Written 2026-10-31.

## Goal

Transcribe a song's lyrics from its lead vocal track. Songs can be in English, in Thai, or in both, sometimes inside one line. Transcription does not need to run in real time, so mixtools can run several models over a song and merge what they produce.

## Cohere Transcribe is not enough on its own

We found Cohere Transcribe's English excellent on speech in another project. Its model card (`cohere-transcribe-03-2026`) gives three limits for this goal:

- It supports 14 languages, and Thai is not one of them: English, French, German, Italian, Spanish, Portuguese, Greek, Dutch, Polish, Mandarin, Japanese, Korean, Vietnamese, Arabic.
- It needs the language chosen before each run. The card says it "does not feature explicit, automatic language detection" and "exhibits inconsistent performance on code-switched audio."
- It gives no timestamps. The card says of timestamps and speaker labels: "The model does not feature either of these."

If Cohere added Thai, running one pass per language would work around the first two limits.

The open question is whether held vowels and pitch changes in singing confuse its English. Nothing published answers this, so only a test on real vocals will tell.

## Candidate models

| Model | Thai | Singing | Mixed Thai and English | Timestamps | Notes |
| --- | --- | --- | --- | --- | --- |
| Qwen3-ASR-1.7B (Alibaba, open, Apache 2.0) | Yes | Yes. It lists "Speech, Singing Voice, Songs with BGM". It scores 14.6% word error rate on full English songs with music. | Not mentioned. It detects the language on its own. | Through Qwen3-ForcedAligner, which supports 11 languages and not Thai | Its README shows only NVIDIA setups. Mac support is unknown. |
| Thai Whisper fine-tunes (Thonburian Whisper, whisper-th-large-v3) | Yes, made for Thai | LyricBridge, an open-source karaoke maker, uses it for Thai lyrics | Whisper handles mixed languages | Yes | Plain Whisper scores about 38% word error rate on the Jam-ALT English lyrics test set and invents words. |
| Gemini 3.5 Transcribe (Google, cloud) | Google calls Thai "Experimental" | Not tested on singing | Yes, inside one sentence, with no setup | Yes, but Google says word timestamps lower accuracy | Accepts up to 1,000 terms to listen for. |
| Cohere Transcribe | No | Not tested on singing | Weak, per its model card | No | Use it for English passes. |
| Typhoon ASR (SCB 10X, Thai) | Yes | Not tested on singing | Its authors call it "limited" | Yes | Built for speech that is mostly Thai. |
| MMS / wav2vec2 forced aligners (Meta) | Yes, after converting Thai to Latin letters with uroman | Lyric apps use it for word timing | Not applicable | Yes, this is its job | uroman drops Thai tones. The MMS weights are licensed CC BY-NC 4.0, non-commercial only. Torchaudio removed its aligner API in 2.9; `ctc-forced-aligner` is a maintained alternative. |

We have also had good results in another project extracting phonemes with wav2vec2 and having an LLM turn the phonemes into words.

## Suggested pipeline

1. Run Qwen3-ASR over the whole lead vocal as the first pass.
2. Run a Thai Whisper fine-tune and Cohere Transcribe as second opinions on the Thai lines and the English lines.
3. Have Claude merge the passes and mark each line where they disagree.
4. Recheck the lines that still disagree with wav2vec2 phonemes.
5. Time each word with a forced aligner.
6. Show the artist the marked lines to confirm.

Thai text has no spaces between words. Word-level timing needs a word splitter such as PyThaiNLP first.

## Open questions

- How does each model do on this artist's vocals, in English, in Thai, and in mixed lines? Test on a song with the lead vocal on its own track.
- Does Qwen3-ASR run on Apple Silicon?
- Does the clean lead vocal track help or hurt? Lyrics research found that vocals separated out of a full mix sometimes made Whisper worse and made it pick the wrong language. Our tracks are clean recordings, not separations, so the result may differ.
- Which models' licenses fit our use?

## Sources

- Cohere Transcribe model card: https://huggingface.co/CohereLabs/cohere-transcribe-03-2026
- Cohere Transcribe announcement: https://cohere.com/blog/transcribe
- Qwen3-ASR: https://github.com/QwenLM/Qwen3-ASR
- Qwen3-ASR blog: https://qwen.ai/blog?id=qwen3asr
- Qwen3-ASR technical report: https://arxiv.org/html/2601.21337v2
- whisper-th-large-v3-ct2 (LyricBridge): https://huggingface.co/Avocaduu14/whisper-th-large-v3-ct2
- Lyrics Transcription for Humans (Whisper on Jam-ALT): https://arxiv.org/pdf/2408.06370
- Exploiting Music Source Separation for Automatic Lyrics Transcription with Whisper: https://arxiv.org/abs/2506.15514
- Gemini 3.5 Transcribe: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe
- Gemini API audio transcription: https://ai.google.dev/gemini-api/docs/transcribe
- Typhoon ASR Real-time: https://opentyphoon.ai/blog/en/typhoon-asr-realtime-release
- Torchaudio multilingual forced alignment: https://docs.pytorch.org/audio/stable/tutorials/forced_alignment_for_multilingual_data_tutorial.html
- ctc-forced-aligner: https://www.github.com/MahmoudAshraf97/ctc-forced-aligner
