# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-17

### Added
- Desktop app (`dlna-cast gui`): renderer list, a goggles-shaped now-playing view, file and screen casting, transport and volume controls, throughput readout and activity log.
- Desktop shortcut with the goggles icon that opens the app with no console window (`tools/install-shortcut.ps1`).
- `pause`, `resume`, `seek`, `volume`, `mute`, `unmute` and `status` commands, plus keyboard controls while casting.
- Volume, mute and pause are confirmed by reading the renderer's state back, and ignored commands are reported.

## [0.2.0] - 2026-10-17

### Added
- Live screen casting with ffmpeg: GPU capture and encoding with software fallback, low-latency MPEG-TS.
- System audio in screen casts through WASAPI loopback.
- Passive SSDP `NOTIFY` discovery for renderers that don't answer searches, repeated searches, a remembered last device and an interactive picker.
- MIME types matched to the renderer's advertised formats.

## [0.1.0] - 2026-10-17

### Added
- SSDP discovery, a range-capable HTTP media server, and `SetAVTransportURI`/`Play` over SOAP.
