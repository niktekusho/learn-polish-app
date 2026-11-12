# Browser audio capture for speech-to-text

Researched 2026-11-12 against faster-whisper 1.2.1 as installed in `sidecar/.venv`, and the `main` branches of Chromium, Firefox, WebRTC, openai/whisper and snakers4/silero-vad on that date.

Each claim names its source. "Inference" marks a conclusion I drew from a source. "Unverified" marks a claim with no primary source.

## Conclusion

- Google Cloud, Deepgram and AssemblyAI all tell clients to send speech recognizers audio with no noise suppression, and Google also says to turn off automatic gain control. The app turns both on. No Whisper or faster-whisper author states a position on browser constraints.
- The WebRTC noise suppressor that Chrome and Firefox use never attenuates below a gain of 0.125 at the level both browsers select, so by its source it cannot write digital silence. Firefox on macOS hands echo cancellation, gain control and noise suppression to the operating system instead. The digital silence in the clips from Nov 9 on most likely comes from processing outside the browser's own suppressor. No source confirms the cause, so it needs one experiment.
- The format is not the problem. Both browsers default `audioBitsPerSecond` to 128,000, which is three times the Opus RFC's range for fullband speech. faster-whisper decodes any container, downmixes to mono and resamples to 16 kHz.
- Whisper does not normalize level per clip. Silero VAD has no level normalization either, and its maintainer says very quiet audio may cause issues. faster-whisper's VAD defaults are `threshold=0.5`, `min_silence_duration_ms=2000`, `speech_pad_ms=400`, `min_speech_duration_ms=0`. No maintainer guidance for short clips exists.
- The Whisper paper lists dropped first or last words and hallucination as known failures. Every clip is padded to 30 seconds. With the default temperature list, a single word whose average log-probability falls below -1 is decoded again by random sampling, which is one documented source of unstable transcripts.
- The changes most likely to help are turning off the three capture constraints, normalizing level in the sidecar before the VAD, and decoding at temperature 0. The first two have source support. All three need a run on the saved clips.

## 1. Browser capture constraints

### What the spec says

The W3C spec defines the three constraints only by intent. For `noiseSuppression` it says "Noise suppression is often desirable on the input signal recorded by the microphone", and it uses the same wording for `autoGainControl`. `echoCancellation: false` means "no echo cancellation will take place". The spec sets no defaults and no algorithm. Source: [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/).

`sampleRate` is "The sample rate in samples per second for the audio data" and `channelCount` is the number of independent channels. Source: same spec.

`voiceIsolation` is defined in the extensions draft as "Attempting to remove all parts of an audio track that do not correspond to a human voice". The draft calls it "a stronger version of noise suppression" and says it does not affect `echoCancellation`. Source: [Media Capture Extensions](https://w3c.github.io/mediacapture-extensions/). The app should not request it, because it removes more of the signal than `noiseSuppression` does (inference).

### What Chrome does

Chrome applies the WebRTC audio processing module. All three effects default to on: `echo_cancellation = true`, `noise_suppression = true`, `automatic_gain_control = true`. Source: [`media/base/audio_processing.h`](https://github.com/chromium/chromium/blob/main/media/base/audio_processing.h).

Chrome sets noise suppression to level `kHigh`. Source: [`media/webrtc/helpers.cc`](https://github.com/chromium/chromium/blob/main/media/webrtc/helpers.cc).

Chrome's gain control differs by platform. On Windows, macOS and Linux it enables the AGC2 adaptive digital controller and, behind a feature flag, an input volume controller that changes the microphone volume of the operating system. On Android it disables the adaptive controller and applies a fixed 6 dB digital gain. Source: `ConfigAutomaticGainControl` in the same `helpers.cc`.

I did not trace whether Chrome on macOS or Android replaces these software effects with system ones. The header says "If system / hardware effects replace effects in this struct, then the corresponding parameters in the struct should be disabled", so the path exists.

### What Firefox does

Firefox uses the same WebRTC module with these defaults: echo cancellation on, noise suppression on at level 2 (`kHigh`), gain control on with AGC2 forced, plus a high-pass filter and transient suppression. Source: [`modules/libpref/init/all.js`](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js), prefs `media.getusermedia.audio.processing.*`.

On macOS only, `media.getusermedia.audio.processing.platform.enabled` is `true`. Firefox then asks the operating system for the effects the page requested, and turns off its own noise suppressor and gain controller when the system applies them. A source comment names the system component: "Platform processing (VPIO on macOS)". Source: `ConfigForPrefs` and `RequestedInputProcessingParams` in [`MediaEngineWebRTCAudio.cpp`](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webrtc/MediaEngineWebRTCAudio.cpp).

On other platforms, Android included, that pref is `false` and Firefox runs the WebRTC module itself. The cubeb AAudio backend opens a voice input with the `VOICE_RECOGNITION` preset. Source: [`cubeb_aaudio.cpp`](https://github.com/mozilla/cubeb/blob/master/src/cubeb_aaudio.cpp). I did not trace whether Firefox for Android marks getUserMedia streams as voice input, or what a given phone does with that preset.

### What the WebRTC module does to the signal

The noise suppressor is a Wiener filter with a gain floor. Level `kHigh` maps to 18 dB with `minimum_attenuating_gain = 0.125`, and `kVeryHigh` maps to 0.09. The filter clamps every gain to that floor. Sources: [`suppression_params.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/ns/suppression_params.cc), [`wiener_filter.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/ns/wiener_filter.cc), and the level mapping in [`audio_processing_impl.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/audio_processing_impl.cc).

Inference: a floor of 0.125 attenuates noise by 18 dB at most. It cannot produce runs of exact zeros from a live microphone signal.

The AGC2 adaptive digital controller has these defaults: 5 dB headroom, 15 dB initial gain, 50 dB maximum gain, and a maximum gain change of 6 dB per second. Source: `GainController2::AdaptiveDigital` in [`api/audio/audio_processing.h`](https://webrtc.googlesource.com/src/+/refs/heads/main/api/audio/audio_processing.h).

Inference: at 6 dB per second, a gain controller cannot correct a level error inside a 1 to 2 second word. The level of a short clip depends on the gain the controller reached before the press.

### Does noise suppression produce digital silence, and does it hurt recognition

No primary source says that browser noise suppression writes digital silence. The WebRTC source points the other way, as shown above. The cause of the gated frames in the clips from Nov 9 on is unverified. Candidates are the macOS voice processing unit that Firefox enables, a phone's hardware processing, or a headset. One recording per device with all three constraints off, checked for zero-valued frames, would settle it.

Vendors state that suppression in general hurts recognition:

- Google: "All noise reduction processing should be disabled" and "Don't use automatic gain control (AGC)". Google also says "The recognizer is designed to ignore background voices and noise without additional noise-canceling". Source: [Cloud Speech-to-Text best practices](https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data).
- Deepgram: noise suppression "inevitably removes some speech components alongside noise, especially for soft or quiet speakers" and "clips the first words of utterances and disproportionately affects short responses". For transcription, "we recommend skipping noise suppression entirely". Deepgram's browser example sets `noiseSuppression: false`, `echoCancellation: true`, `channelCount: 1`. Source: [Audio preprocessing and barge-in](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in).
- AssemblyAI: "Avoid adding noise cancellation as a preprocessing step. The artifacts it introduces typically cause more harm than the background noise itself." Source: [Voice agent best practices](https://www.assemblyai.com/docs/voice-agents/best-practices).

These vendors describe their own models. None of them is a statement about Whisper. The Whisper paper reports that Whisper degrades less than LibriSpeech-trained models under added pub noise below 10 dB SNR, which supports sending it unsuppressed audio. Source: [Whisper paper](https://arxiv.org/abs/2212.04356), section 3.7.

Neither the openai/whisper repo nor the faster-whisper repo documents a recommendation about `echoCancellation`, `noiseSuppression` or `autoGainControl`. I found none in their READMEs or source.

## 2. Format

### What Whisper needs

Whisper resamples all audio to 16,000 Hz and computes an 80-channel log-mel spectrogram on 25 ms windows with a 10 ms stride. Source: Whisper paper, section 2.2. The constants are `SAMPLE_RATE = 16000`, `N_FFT = 400`, `HOP_LENGTH = 160`, `CHUNK_LENGTH = 30`. Source: [`whisper/audio.py`](https://github.com/openai/whisper/blob/main/whisper/audio.py).

faster-whisper decodes the upload with PyAV and resamples it to signed 16-bit mono at 16,000 Hz, then converts to float32. Source: `decode_audio` in `sidecar/.venv/lib/python3.13/site-packages/faster_whisper/audio.py`.

Inference: content above 8 kHz and a second channel never reach the model. Requesting a `sampleRate` in getUserMedia changes nothing the model sees. `channelCount: 1` matches what the decoder produces anyway.

### What MediaRecorder sends by default

The spec leaves the default to the browser: "choose a target value the User Agent deems reasonable for audio". Source: [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/).

Chrome sets `kDefaultAudioBitRate = 128e3` and uses it when `audioBitsPerSecond` is absent. Source: [`media_recorder.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/media_recorder.cc). Its Opus encoder runs at 48 kHz with the `OPUS_APPLICATION_AUDIO` profile. Source: [`audio_track_opus_encoder.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/audio_track_opus_encoder.cc).

Firefox sets `DEFAULT_AUDIO_BITRATE_BPS = 128e3`. Source: [`MediaRecorder.cpp`](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/MediaRecorder.cpp). Its Opus encoder also uses `OPUS_APPLICATION_AUDIO` and resamples to 48 kHz when the track rate is not an Opus rate. Source: [`OpusTrackEncoder.cpp`](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/encoder/OpusTrackEncoder.cpp).

MDN says "The audio default is adaptive, depending upon the sample rate and the number of channels". Source: [MDN MediaRecorder constructor](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/MediaRecorder). The source code of both browsers shows a fixed 128 kbit/s, so I trust the code over MDN here.

### Does Opus at that bitrate lose anything

The Opus RFC lists 28 to 40 kbit/s as the range for fullband speech and 16 to 20 kbit/s for wideband speech. Source: [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716), section 2.1.1.

Vendors prefer lossless input. Google: "Use a lossless codec to record and transmit audio. FLAC or LINEAR16 is recommended", and lossy codecs "may reduce accuracy". Where bandwidth forces a lossy codec, Google lists `OGG_OPUS` among its recommended ones. AWS: "For best results, use a lossless format, such as FLAC or WAV with PCM 16-bit encoding". Sources: [Google best practices](https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data), [AWS Transcribe data input](https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html).

No primary source measures Whisper accuracy on Opus against WAV. Inference: at 128 kbit/s, several times the RFC's speech range, the codec is unlikely to explain errors on these clips. Decoding one clip, encoding it to WAV and comparing transcripts would confirm that.

Deepgram and AssemblyAI both say 16 kHz is enough and that higher rates do not improve accuracy. Sources: the Deepgram and AssemblyAI pages cited in section 1.

## 3. Level

### Recommended input level

No vendor I read gives a target level in dBFS. Google says only "Avoid audio clipping". Azure's hardware guidance asks for a microphone SNR of at least 65 dB and an output sensitivity of -26 dBFS/Pa at 1 kHz, which is a device specification and not a recording level. Sources: [Google best practices](https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data), [Azure microphone array recommendations](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-sdk-microphone). A recommended speech level for recognition is unverified.

### Whether Whisper normalizes level

The paper says "we globally scale the input to be between -1 and 1 with approximately zero mean across the pre-training dataset". The scaling is global, not per clip. Source: Whisper paper, section 2.2.

The code computes `log10` of the mel power clamped at `1e-10`, raises everything to at least the clip's maximum minus 8.0, then applies `(log_spec + 4.0) / 4.0`. Sources: [`whisper/audio.py`](https://github.com/openai/whisper/blob/main/whisper/audio.py), and the same three lines in `faster_whisper/feature_extractor.py`.

Inference: only the floor is relative to the clip. A clip that is 10 dB quieter has every feature above the floor shifted down by 0.25. The model sees level, and nothing in the front end removes it. This agrees with the measurement that peak normalization did not move the average log-probability much, since the model was trained on audio at many levels.

Inference: frames of digital silence compute to the `1e-10` clamp and then sit exactly at the floor, 8.0 below the clip maximum in log10 power. A real noise floor seldom reaches that low.

### Silero VAD on quiet input

Silero VAD takes 16 kHz audio in windows of 512 samples and returns a speech probability per window. Source: `get_speech_timestamps` in `faster_whisper/vad.py`. faster-whisper 1.2.1 ships `silero_vad_v6.onnx`.

Neither faster-whisper nor Silero normalizes amplitude before the model. Sources: `faster_whisper/vad.py`, [`utils_vad.py`](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py).

The Silero maintainer wrote "There may be some issues with very loud or very quiet audios" and that the training pre-processing "tried to avoid extremes". Source: [silero-vad discussion 349](https://github.com/snakers4/silero-vad/discussions/349). This matches the one quiet clip that the VAD dropped and that normalization recovered.

### faster-whisper VAD defaults

From `VadOptions` in `faster_whisper/vad.py` (1.2.1):

| Parameter | Default | Meaning in the docstring |
|---|---|---|
| `threshold` | 0.5 | Probabilities above this value count as speech. |
| `neg_threshold` | `None`, computed as `max(threshold - 0.15, 0.01)` | Below this value a window is always silence. |
| `min_speech_duration_ms` | 0 | Shorter speech chunks are thrown out. |
| `max_speech_duration_s` | infinity | Longer chunks are split. |
| `min_silence_duration_ms` | 2000 | Silence must last this long before a chunk ends. |
| `speech_pad_ms` | 400 | Padding added to each side of a chunk. |

Silero's own defaults differ: `min_speech_duration_ms=250`, `min_silence_duration_ms=100`, `speech_pad_ms=30`. Source: [`utils_vad.py`](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py).

The README says "The default behavior is conservative and only removes silence longer than 2 seconds". Source: [faster-whisper README](https://github.com/SYSTRAN/faster-whisper/blob/master/README.md). A collaborator confirmed in [issue 859](https://github.com/SYSTRAN/faster-whisper/issues/859) that the description and defaults are as intended.

When `vad_filter=True`, `transcribe` keeps only the detected chunks and concatenates them. If no window reaches the threshold, the audio is empty and the result has no segments. Source: `WhisperModel.transcribe` in `faster_whisper/transcribe.py`.

Inference for this app: on a clip of 1 to 14 seconds with these defaults, the VAD trims leading and trailing silence beyond 400 ms and otherwise does one thing, which is to drop the whole clip when no window scores 0.5. The docstring says of the threshold "It is better to tune this parameter for each dataset separately".

I found no statement from faster-whisper maintainers on VAD settings for short clips. The only thread I found is a third-party one where a user fixed blank transcripts for one-word clips by turning the VAD off. Source: [whisper-standalone-win discussion 231](https://github.com/Purfview/whisper-standalone-win/discussions/231). That is a user report, not maintainer guidance.

## 4. Very short utterances

### Known behaviour

Whisper is trained on 30-second segments. Source: Whisper paper, section 2.1. faster-whisper pads the mel features of a shorter clip with zeros to 3000 frames. Source: `pad_or_trim` in `faster_whisper/audio.py`. A 1.5 second word fills 5% of the encoder input.

The paper lists these failures: "getting stuck in repeat loops, not transcribing the first or last few words of an audio segment, or complete hallucination where the model will output a transcript entirely unrelated to the actual audio". Source: Whisper paper, section 6.

A user reported much higher error rates on clips under 2 seconds on an Arabic dataset, with every short clip transcribed as the same word. No OpenAI maintainer replied. Source: [openai/whisper discussion 1447](https://github.com/openai/whisper/discussions/1447). This is a user report. I found no author statement that quantifies accuracy on single words.

`suppress_blank=True` sets the logits of the space token and the end-of-text token to minus infinity at the first sampled position. Source: `SuppressBlank` in [`whisper/decoding.py`](https://github.com/openai/whisper/blob/main/whisper/decoding.py). Inference: the decoder must emit at least one text token for any input, silence included, unless the no-speech rule below discards the segment.

### Parameters, as the code defines them

All defaults below are from `WhisperModel.transcribe` in faster-whisper 1.2.1.

- `beam_size=5`. Beam search runs only at temperature 0. At any temperature above 0 the code forces `beam_size=1` and samples `best_of=5` candidates. The paper introduced beam search "to reduce repetition looping which happens more frequently in greedy decoding". openai/whisper defaults to greedy decoding, faster-whisper to 5 beams. Sources: `generate_with_fallback` in `transcribe.py`, paper section 4.5, [faster-whisper README](https://github.com/SYSTRAN/faster-whisper/blob/master/README.md).
- `temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]`. The code decodes at each temperature in turn and stops at the first result that passes the two checks below. If all fail, it returns the result with the highest average log-probability.
- `log_prob_threshold=-1.0`. A result whose average log-probability is below this value fails and triggers the next temperature.
- `compression_ratio_threshold=2.4`. A result whose text compresses by more than this ratio fails as too repetitive.
- `no_speech_threshold=0.6`. The segment is skipped only if the no-speech probability is above 0.6 and the average log-probability is at or below `log_prob_threshold`. The paper explains that the no-speech token alone "is not sufficient to distinguish a segment with no speech".
- `condition_on_previous_text`. It feeds the previous window's text as a prompt to the next window. A clip under 30 seconds has one window, so the setting has no effect on these clips (inference from `generate_segments`).
- `initial_prompt`. The text is tokenized and placed in the previous-text position for the first window. openai/whisper documents it as a way "to provide, or 'prompt-engineer' a context for transcription, e.g. custom vocabularies or proper nouns to make it more likely to predict those word correctly". Sources: `generate_segments` in `transcribe.py`, [`whisper/transcribe.py`](https://github.com/openai/whisper/blob/main/whisper/transcribe.py).
- `hotwords`. "Hotwords/hint phrases to provide the model with. Has no effect if prefix is not None." `get_prompt` inserts the tokens after the start-of-previous token and before any previous text, on every window, and truncates them to half the model's maximum length.
- `word_timestamps=False`. "Extract word-level timestamps using the cross-attention pattern and dynamic time warping". It also gives each word a probability, and it is required for `hallucination_silence_threshold`, which skips silent periods "when a possible hallucination is detected".
- `max_initial_timestamp=1.0`. "The initial timestamp cannot be later than this." The paper added it "to avoid a failure mode where the model ignores the first few words in the input".
- `without_timestamps=False`. When `True` the decoder samples text tokens only.

### What follows for single words

Inference: the average log-probability of a one-word result is an average over very few tokens, so one uncertain token can push it below -1. The fallback then decodes by random sampling at temperature 0.2 and above, and sampled output is not repeatable. The observed flips on 10 to 22 of 69 clips after tiny audio changes are consistent with clips that sit near this threshold, or near a tie between two beams. Logging `temperature` from each returned segment would show how many clips took the fallback.

Inference: `max_initial_timestamp=1.0` forbids the model from placing the first word later than 1 second. Lead-in silence must stay under 1 second for that reason.

A prompt can bias a short clip toward expected vocabulary. I found no maintainer guidance on prompt content for single words. Third-party reports say a prompt can be echoed back on near-silent audio. That risk is unverified against primary sources.

## 5. Push-to-talk specifics

### Start latency

The spec makes `start()` asynchronous. It sets the state to `recording` and then runs the gathering steps "in parallel", and it fires the `start` event from a queued task. Source: [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/). The spec gives no bound on the delay between the call and the first captured sample.

I found no Chromium or Firefox bug, and no documentation, that quantifies this delay. The size of the gap is unverified. It can be measured by subscribing to the `start` event and comparing its time with the pointer event time.

The app already opens the microphone stream on mount, which removes the larger getUserMedia delay from the first press. The app creates a new `MediaRecorder` on each press, so encoder setup happens after the press.

Chrome's encoder buffers audio in 60 ms frames. Source: `kOpusPreferredBufferDurationMs = 60` in [`audio_track_opus_encoder.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/audio_track_opus_encoder.cc).

### Clipped onsets

Deepgram states that noise suppression "clips the first words of utterances". Source: the Deepgram guide cited in section 1. Inference: an adaptive suppressor or gate needs time to open, and with push-to-talk the user speaks right after pressing. This is a second reason to turn suppression off.

Whisper itself tends to drop first and last words, per the paper's limitations section. The paper's remedy is the initial timestamp constraint, which is already on by default.

### Lead-in and tail padding

No primary source recommends a lead-in or tail duration for push-to-talk. The numbers in use, a 250 ms tail and none for lead-in, are unverified by any source.

The VAD's `speech_pad_ms=400` keeps up to 400 ms on each side of detected speech, so it does not cut into a 250 ms tail. Source: `faster_whisper/vad.py`.

On `stop()`, the recorder delivers "the Blob of collected data so far" in a `dataavailable` event before the `stop` event. Source: [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/). The current code handles that order.

The earlier measurement found that 0.5 seconds of added silence did not improve the average log-probability. That measurement added silence after capture. It does not test whether the onset was lost before capture.

## 6. Microphone and environment

- Distance. Google: "Position the microphone as close as possible to the person that is speaking, particularly when background noise is present." Source: [Google best practices](https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data).
- Clipping and a listening check. Google: "Avoid audio clipping" and "Listen to some sample audio. It should sound clear, without distortion or unexpected noise." Source: same page.
- Bluetooth headsets. On Windows, a Bluetooth Classic headset microphone is reachable only through the Hands-Free Profile, which carries mono audio at 8 kHz in narrowband mode or 16 kHz in wideband mode with the mSBC codec. A2DP "only supports audio output". Some wideband headsets fall back to narrowband on certain radios. Source: [Windows Bluetooth Classic audio](https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio). The profile is the same on macOS and Android, but I did not find an Apple or Android page that states the rates, so the claim is unverified for those systems. Inference: wideband mode still delivers the 8 kHz bandwidth Whisper uses, and narrowband mode halves it.
- Built-in microphone against headset. No vendor page I read compares the two. Azure's hardware guidance asks for at least 65 dB SNR and a flat response from 200 to 8000 Hz. Source: [Azure microphone array recommendations](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-sdk-microphone). A recommendation for one over the other is unverified. Google's distance rule favors a wired headset microphone near the mouth (inference).
- Environment. Google: "Multiple people talking at the same time, or at different volumes may be interpreted as background noise and ignored." Source: Google best practices.

## What this means for this app

Candidate changes, ordered by expected effect. "Supported" means a primary source recommends the change. "Experiment" means the saved clips, or one new recording, must show the effect first.

1. Turn off `noiseSuppression` and `autoGainControl` in `recorder.tsx`, and try `echoCancellation: false` as well. Supported for the first two by Google, Deepgram and AssemblyAI (section 1). Turning all three off is also the only way to keep Firefox on macOS from routing capture through the system voice processing unit, which can write digital silence. The 69 measured clips carry Chrome's encoder tag, so that Firefox path does not explain them, and their cause is still open. Experiment needed: record the same words with the constraints on and off on each device in use, count zero-valued frames, and compare transcripts. Echo cancellation only matters if the app plays audio while the button is held.

2. Normalize level in `sidecar/main.py` before the VAD. Decode with `faster_whisper.audio.decode_audio`, scale the array to a fixed peak, and pass the array to `transcribe`, which accepts a waveform. Supported by the Silero maintainer's remark on quiet audio and by the existing measurement that normalization recovered the dropped clip (section 3). This change becomes necessary if change 1 removes gain control, because levels will then vary more.

3. Retune the client "too quiet" gate after change 1. The gate rejects clips whose loudest frame stays under RMS 0.02, about -34 dBFS. Speech already fell to about -27 dBFS, and without gain control it can fall further. With change 2 in place the gate can drop to the level that separates silence from quiet speech. Experiment needed: measure peak frame RMS on new clips recorded with the constraints off.

4. Decode at `temperature=0.0` in `sidecar/main.py`, or keep the list and log each segment's `temperature`. Supported by the code only as a description of behaviour: any fallback step samples at random (section 4). Expected effect is small: only 1 of the 69 clips scored below the -1 fallback threshold in prod, and the measured flips came from changes to the audio, not from repeated runs. Experiment needed: rerun the 69 clips twice with the default list and twice with `0.0`, and count how many transcripts differ between runs and how many are correct.

5. Return `avg_logprob` and `no_speech_prob` from `/transcribe` and let the app ask for a repeat when confidence is low, instead of grading an unstable transcript. Supported in the sense that faster-whisper exposes both values per segment and the sidecar already logs them. Experiment needed: pick the threshold from the saved clips by comparing the values on correct and wrong transcripts. This follows the project's deterministic-first rule, because a number decides and no model is asked.

6. Lower the VAD `threshold` through `vad_parameters`, or turn `vad_filter` off for clips under a few seconds. The docstring recommends tuning the threshold per dataset (section 3). The client gate already blocks silent clips, which is the case the VAD was added for. Experiment needed, and partly done: disabling the VAD did not change the average log-probability, so the gain is limited to clips the VAD drops. Change 2 may make this unnecessary.

7. Give the decoder context with `hotwords` or `initial_prompt` in `sidecar/main.py`. Both are documented ways to bias vocabulary (section 4). Experiment needed, with two risks to measure: the prompt can pull a wrong pronunciation toward the expected word and hide the learner's error, and third-party reports say a prompt can be echoed on near-silent audio. Any word list must come from the dictionary, not from a hand-made list.

8. Measure onset loss before changing capture timing. Log the time between the pointer event and the recorder's `start` event, and check whether speech energy is present in the first 50 ms of saved clips. No source quantifies the delay (section 5). If onsets are lost, the fix is to keep audio flowing before the press, for example with a recorder started on mount or a short PCM buffer, and that needs its own design.

9. Leave the format alone. `audioBitsPerSecond`, `sampleRate` and a WAV upload have no source-backed benefit at the current 128 kbit/s default (section 2). Adding `channelCount: 1` is harmless and matches the decoder. An experiment that transcribes one clip as Opus and as WAV would close the question.

10. Add a one-line microphone tip in the app only if the experiments in change 1 show a device-specific problem. Google's distance rule is supported. The Bluetooth narrowband risk is supported for Windows and unverified elsewhere (section 6).

## Open questions

- What writes digital silence into the clips from Nov 9 on. No primary source ties it to browser noise suppression, and the WebRTC source argues against that.
- Whether Chrome on macOS or Android, and Firefox on Android, replace the WebRTC effects with system or hardware ones for getUserMedia. I read the configuration code but did not trace the platform capture paths.
- A recommended speech level in dBFS for recognition. No vendor page gives one.
- Whisper or faster-whisper author guidance on single-word clips, on prompt content for them, and on VAD settings for short audio. I found user reports only.
- The delay between `MediaRecorder.start()` and the first captured sample in Chrome and Firefox.
- Bluetooth headset microphone rates on macOS and Android from an Apple or Android source.
