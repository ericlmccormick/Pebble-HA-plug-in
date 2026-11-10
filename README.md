# Home Assistant Bridge v1.0.1 — Pebble Plugin

## Developer audio integration

For Pebble apps that speak Home Assistant responses, use the **[Home Assistant Bridge Audio SDK](sdk/README.md)**. The shared files contain the tested streaming WAV and Gemini-compatible ADPCM transport, BLE pacing, sentence prefetch, dual watch PCM buffers, and telemetry. Developers can copy:

- **[Phone module — ha_audio.js](sdk/ha_audio.js)** (place at `src/pkjs/ha_audio.js`)
- **[Watch implementation — ha_audio.c](sdk/ha_audio.c)** (place at `src/c/ha_audio.c`)
- **[Watch header — ha_audio.h](sdk/ha_audio.h)** (place at `src/c/ha_audio.h`)

The **[SDK guide](sdk/README.md)** has the exact `require()`, `#include`, message keys, permissions, and callback wiring. It works with the existing plugin and does not require any app-specific HA URL or token. Native watch playback still requires these included C files; plugins cannot directly own a watch app's speaker.



Standalone, phone-side Pebble plugin for reusable access to a user's Home Assistant installation.

## Stable release downloads

**[Download Home Assistant Bridge v1.0.1 (.pbw)](https://github.com/ericlmccormick/Pebble-HA-plug-in/releases/download/v1.0.1/home-assistant-bridge-v1.0.1.pbw)**.

Previous stable release: **[Download previous v1.0.0 (.pbw)](https://github.com/ericlmccormick/Pebble-HA-plug-in/releases/download/v1.0.0/home-assistant-bridge-v1.0.0.pbw)**.

This is the stable plugin build. The [Home Assistant AI v1.0.0 watch app](https://github.com/ericlmccormick/Pebble-Home-Assistant-Bridge/releases/download/v1.0.0/home-assistant-ai-v1.0.0.pbw) depends on it. Install and configure the Bridge first; then install the watch app and grant plugin permissions.

The [reusable audio SDK](sdk/README.md) provides portable PebbleKit JavaScript and watch C playback sources for other developers.

## Local HTTP (opt-in, insecure)

HTTPS remains the default and is strongly recommended. To connect to a Home Assistant server over an unencrypted **local** connection, open the plugin settings, enable **Allow unsecured local HTTP**, and enter a private LAN URL such as `http://192.168.1.2:8123` or `http://homeassistant.local:8123`. Save and use **Test connection** while the phone is on the same local network.

The setting is deliberately restricted to RFC1918 private IPv4 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and `.local` mDNS hostnames. Public HTTP URLs, loopback addresses, paths, embedded credentials, and malformed ports are rejected. The plugin already requests Pebble's `LocalNetwork` permission. Voice provider discovery switches to `ws://` when this mode is enabled; HTTPS uses `wss://`.

**Security warning:** Plain HTTP and WebSocket traffic are unencrypted. Home Assistant long-lived access tokens, device data, and commands may be visible or alterable to others with network access. Use only on a trusted LAN, preferably with a limited Home Assistant account, and prefer HTTPS or a trusted private VPN where possible. This is not a remote-access feature. Re-disable the toggle when returning to HTTPS.

## Install

1. Enable **Settings → Plugins → Plugins / permissions preview** in the Pebble mobile app.
2. Build or download the GitHub Actions **Build Home Assistant Plugin** artifact.
3. Extract and sideload the plugin-only `.pbw`. It won't appear as a watchapp.
4. Open the **Home Assistant Bridge** plugin's settings page in Pebble.
5. Set your externally reachable **HTTPS** Home Assistant URL and a long-lived access token.
6. Grant the network permissions; tap **Test connection**.
7. Install an app using the plugin and grant its declared read/converse/control permissions.

Token storage uses `Pebble.secureStorage`, private to the plugin and backed by the phone keystore. A plugin-enabled watchapp doesn't receive the token.

## Public interface

Plugin UUID: `a74370b6-929c-4ec0-b7ee-2fc6fca8db57`.

Sources:

- `agent/configured`: whether a URL and token are configured.
- `agent/entity`: state, numeric/boolean readings, name, unit, domain and ID from HA states. The source may be bounded; use `get_state` for a specific entity.

Actions:

| Action | Arguments | Permission | Purpose |
| --- | --- | --- | --- |
| `get_state` | `{entity_id}` | HomeRead | Read one entity |
| `list_states` | `{domain?, limit?}` | HomeRead | List up to 100 entity states |
| `get_config` | `{}` | HomeRead | Read shared STT/TTS/agent/pipeline defaults (no credentials) |
| `read_api` | `{path}` | HomeRead | Allowlisted read-only HA API GET |
| `conversation` | `{text, agent_id?, conversation_id?}` | HomeConverse | Call HA conversation/process |
| `send_to_agent` | `{message, chat_id?}` | HomeConverse | Index 01 agent destination: send `message` to the default conversation agent. `text` is Assist's plain speech, not JSON (Index stores it but doesn't display it); an Assist error returns `ASSIST_ERROR`. `chat_id` is ignored |
| `tts_prepare` | `{text, engine_id?}` | HomeConverse | Request mono PCM16 WAV from HA, normalize to canonical 8kHz PCM16 WAV for consumer-side encoding; optional `test_tone`, `source_rate` and `diagnostic` options. Returns a session ID and audio metadata |
| `tts_chunk` | `{session_id, offset}` | HomeConverse | Return a base64 chunk of canonical 8kHz PCM16 WAV (up to 6000 bytes) |
| `tts_release` | `{session_id}` | HomeConverse | Free temporary speech data |
| `render_template` | `{template}` | HomeControl | Render a trusted HA Jinja template |
| `call_service` | `{domain,service,data?,target?}` | HomeControl | Invoke an arbitrary HA service |
| `fire_event` | `{event_type,event_data?}` | HomeControl | Fire an HA event |

The generic service and event operations can affect locks, alarms, garage doors or other sensitive entities. Use a dedicated least-privileged HA account, and grant `HomeControl` only to trusted apps. Plugin permissions are enforced by the Pebble host, not by these JavaScript handlers themselves.

Action success results use `{ok:true, text:"<JSON or text>", refreshed:[...]}`; parse `text` for returned structured data. Errors use Pebble standard error codes.

Example consumer (from PebbleKit JS):

```js
const PLUGIN = "a74370b6-929c-4ec0-b7ee-2fc6fca8db57";
const result = await Pebble.invokeAction({
  plugin: PLUGIN, action: "get_state", args: { entity_id: "sensor.outdoor_temperature" }
});
if (result.ok) {
  const entity = JSON.parse(result.text);
  console.log(entity.state);
}
```

Consumer manifests must declare `{ "name": "HomeRead", "plugin": "<UUID>" }` and `{ "name": "InvokeAction", "plugin": "<UUID>" }`. Add `HomeConverse` or `HomeControl` for the other actions as required.

## Shared voice and AI settings

Open the plugin settings and configure **Voice & AI defaults**. The plugin discovers available conversation agents and configured TTS entities through Home Assistant states and its conversation-agent WebSocket API. It also retrieves Assist pipelines and their STT/TTS engines through `assist_pipeline/pipeline/list`. Choose a conversation agent, STT engine, TTS engine, and pipeline; then save.

These choices are stored locally to the plugin, not written into Home Assistant's server settings. The list of STT/TTS engines is limited to engines exposed by current Assist pipelines and TTS entities; unavailable engines cannot be enumerated by this implementation. A selected STT engine does not reconfigure the chosen pipeline automatically. To actually run speech recognition with a particular STT engine, configure an Assist pipeline using that engine in Home Assistant.

The `get_config` action gives other Pebble apps a token-free JSON object with `stt_engine`, `tts_engine`, `agent_id`, and `pipeline_id`. The existing `conversation` action honors the selected `agent_id` unless the caller supplies an explicit override.

```js
const result = await Pebble.invokeAction({
  plugin: PLUGIN, action: 'get_config', args: {}
});
const preferences = JSON.parse(result.text);
```

The plugin exposes canonical 8 kHz mono PCM16 WAV audio through request-scoped, base64-encoded chunks. It validates the Home Assistant audio format and resamples when needed; the consuming phone app handles filtering and IMA ADPCM encoding, exactly as in Gemini.

## Index 01 ring

The `send_to_agent` action makes the Bridge an Index 01 agent destination. What you say goes straight to Home Assistant Assist, without the Index cloud or local agent.

1. Configure the Bridge (URL, token, **Test connection**). The plugin appears as a destination only while `agent/configured` reports `true`.
2. Optionally pick a **Conversation agent** under Voice & AI defaults. `send_to_agent` uses it; otherwise Home Assistant's default agent handles the request.
3. In the Pebble app's Index settings, open a recording gesture (for example **Double click & hold**), expand **Other agents**, and choose **Home Assistant Bridge**.

The Index feed shows your transcript as sent to Home Assistant Bridge; Assist's reply is not displayed there. If Assist can't handle the request (unknown device, not understood), the action fails with `ASSIST_ERROR` and Assist's message, and the feed entry is marked as failed. Each gesture starts a new Assist conversation. Only entities exposed to Assist are reachable.

**Watch replies (optional):** turn on **Show Home Assistant replies on the watch** in the plugin settings to mirror Assist's reply as a watch notification. This requires Pebble app 1.18.0 or later and the **Show notifications** permission, granted in the plugin's permissions. Earlier app versions ignore the option.

## Watchapp compatibility

Home Assistant AI v1.0.0 is **Bridge-only**: it no longer exposes a direct Home Assistant connection toggle or stores the user's Home Assistant credentials in the app. The Bridge provides conversation and TTS actions, and the consuming app uses the shared audio SDK to play the response.

**Limitation:** Continuous raw watch microphone streaming is not supported by this request-scoped plugin interface. Home Assistant AI v1.0.0 uses repeated system dictation for conversation mode, and one-shot dictation and responses use only the Bridge. Test plugin-owned audio sessions on a physical phone/watch.

## Build

GitHub Actions: `.github/workflows/build-ha-plugin.yml` packages the plugin with a pinned version of Pebble's official `pack-plugin-pbw.py`. No SDK or local installation is necessary for the plugin-only package.

The Pebble plugin API is still evolving. Test updates using the current Pebble mobile app, and verify store submission requirements before publishing.


## Gemini-matched audio contract (v0.2.8)

This version keeps the proven Gemini division of responsibilities and adds transport integrity diagnostics. The plugin requests mono 8 kHz 16-bit PCM WAV (Home Assistant may choose its own supported output rate), validates the actual WAV payload, resamples to 8 kHz when necessary, then emits a canonical 44-byte WAV header and little-endian 16-bit PCM data. `tts_prepare` returns `{session_id,length,chunk_bytes,format:"pcm_s16le_wav",sample_rate:8000,channels:1,bits_per_sample:16,sample_count}`. `tts_chunk` returns base64-encoded sections of that *complete WAV file*. The phone app reconstructs the WAV, parses signed PCM16, applies Gemini's three-sample moving-average filter, encodes 4-bit IMA ADPCM high nibble first while maintaining predictor state between sentences, and sends 700-byte `AUDIO_CHUNK` messages to the watch. Pebble decodes the stream into signed 8 kHz 16-bit PCM and plays it through `SpeakerPcmFormat_8kHz_16bit`.

**Compatibility:** v0.2.5 and v0.2.6 produced ADPCM chunks; these are deliberately incompatible with the v0.2.7 PCM WAV client. Rebuild and install both sides. Older plug-ins cause a specific actionable bridge-version error rather than falling through to static audio.

### Diagnosing static (v0.2.8)

The plugin computes a 32-bit FNV-1a checksum of the complete normalized PCM WAV and publishes `wav_checksum` in `tts_prepare`. The watchapp validates the checksum after retrieving and assembling all base64 WAV chunks, **before** decoding PCM or encoding ADPCM. A mismatch stops playback with a clear error instead of sending corrupted speech to the watch. The Home Assistant AI app also adds **Test watch audio (440 Hz tone)** in its settings: saving this option sends a known waveform through the Gemini-equivalent phone encoder, BLE packet queue, watch ADPCM decoder and speaker, without invoking Home Assistant. If this tone is clean but spoken TTS is static, investigate the bridge WAV/PCM or actual TTS source. If the tone itself is static, investigate Bluetooth packet integrity, decoder state and speaker buffering. The tone test is explicitly user-triggered; normal speech remains fully routed through the bridge.

### v0.2.9 audio isolation

The bridge supports `tts_prepare({test_tone:true})`, which produces a 7-second 440 Hz, 8 kHz PCM16 WAV through the exact same temporary session, base64 chunk, checksum and phone-side ADPCM encoder used for Home Assistant speech. This reference is deliberately longer than the watch's 16 KiB compressed ring buffer to exercise sustained playback. A separate phone-generated 1.5-second tone only exercises the phone encoder and watch. `tts_prepare` now includes `audio_diagnostics` with source/output RMS, peak, clipped sample counts, zero crossings, duration, and the input sample rate for Home Assistant speech. No raw speech content is logged. In Home Assistant AI v0.2.4 choose **Test audio through bridge (440 Hz)** in settings, save, and compare with normal speech. Bridge tone clean + TTS distorted isolates provider audio or normalization; bridge tone distorted isolates bridge session/chunk/phone path or long-duration watch handling.

### v0.2.10: Distorted Home Assistant speech diagnostics

A clean seven-second bridge-generated reference tone confirms the WAV session, base64 transfer, phone IMA ADPCM encoder and watch playback can reproduce a known waveform, albeit with possible buffer underruns. A distorted Home Assistant speech response is therefore investigated at the source. WAV parsing now respects valid finite `data` chunk lengths, excluding non-audio trailing metadata, while supporting streamed unknown-length data headers. `tts_prepare` accepts optional `source_rate:16000` and `diagnostic:true` (cache disabled) to compare HA's native 16 kHz WAV against normal 8 kHz synthesis requests; the bridge always emits the same 8 kHz signed PCM16 WAV for the existing Gemini-compatible decoder path. Home Assistant AI v0.2.5 adds **Test Home Assistant TTS (16 kHz source)** in settings. Source and output peak/RMS/clipping, declared/available PCM byte counts and actual sample rate are reported as `audio_diagnostics` to phone logs, without logging the speech samples themselves.

### v0.2.16: Fix TTS binary corruption at the source

Pebble's plugin `fetch()` is a restricted host-backed implementation, **not the browser Fetch API**. It requires `responseType: 'arraybuffer'` in the `fetch(url, options)` call to preserve HTTP response bytes. Calling `response.arrayBuffer()` alone on a default text response silently converts UTF-8 replacement characters into truncated bytes (e.g., a WAV streaming size marker becomes `0xFDFDFDFD` and the requested sample rate 16000 Hz can become 16125 Hz). The bridge now requests binary mode at the network boundary and then calls `response.arrayBuffer()` to read genuine PCM WAV data. The existing corruption guard stays in place and rejects altered WAVs. Regression tests require the binary request option for every TTS proxy download. The watch app needs no update. Source: `coredevices/mobileapp`, `libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/FetchJs.kt`.

### v0.2.19 progressive client delivery

The Home Assistant TTS action still downloads the full PCM WAV internally because the Pebble plugin host's `fetch()` provides no ReadableStream/body reader. After normalization, `tts_prepare` exposes `first_chunk` plus a new `first_chunk_checksum`, and `tts_chunk` returns a `checksum` for each stored WAV fragment (FNV-1a over the decoded bytes). This enables **client-side streaming**: Home Assistant AI v0.2.14 begins BLE playback from the first independently verified PCM chunks while requesting later fragments, without requiring full client-side WAV reconstruction first. The final full-file checksum is still validated. No plugin credentials or Home Assistant traffic are moved into the consuming app. The watch receives the same Gemini-compatible continuous ADPCM stream; transport fragment boundaries do not generate sentence-end events.
