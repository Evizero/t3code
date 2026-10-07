# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iOS transcribes on the device. Desktop and web transcribe on the environment
running on the user's own machine.

## iOS

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Desktop and web

Dictation is a property of the client, not of the thread's environment. Audio only
goes to the client's own local environment, the desktop app's server or one on
loopback, so speech never reaches a remote machine and every environment the client
connects to uses the same model. Clients without a local environment hide the
feature. The [Dictation service](../../apps/server/src/dictation/Dictation.ts) owns
model files and the single active session; models live in the Hugging Face cache,
and downloads belong to the service rather than the request, so they outlive the
client that started them.

The transcript shows as a decoration at the cursor and enters the draft only when
inserted, so edits made while dictating are never overwritten. The
[streaming client](../../packages/client-runtime/src/voice-input/streaming.ts) keeps
one feed in flight and folds audio captured meanwhile into the next, so a slow link
sends fewer, larger requests instead of queueing them.
