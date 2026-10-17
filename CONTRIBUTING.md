# Contributing to dlna-cast

Thanks for helping. Bug reports, device reports and pull requests are all welcome.

## Reporting a device

Every renderer implements DLNA a little differently, so reports from real devices are the most useful contribution. Please open an issue with:

- **The device:** its make and model, and the `manufacturer`/`modelName` printed by `node src/cli.mjs discover --json`
- **What happened:** what worked and what didn't (discovery, files, screen casting, pause/seek, volume)
- **Logs:** any errors, and for the app, the relevant lines of `%LOCALAPPDATA%\dlna-cast\app.log`

## Reporting a bug

Include your OS, Node.js version (`node -v`), ffmpeg version if you were screen casting (`ffmpeg -version`), the exact command or steps, and what you expected instead.

## Making changes

1. Fork the repository and create a branch from `main`.
2. Keep the project dependency-free; use Node.js built-ins.
3. Add or update tests in `test/`. The fake renderer in `fixtures/fake-renderer.mjs` can simulate device quirks, so extend it when you need a new one.
4. Run `npm test` and make sure everything passes.
5. Open a pull request that describes the problem, the change, and how you tested it, including any real devices you tried.

## Style

- ES modules (`.mjs`), two-space indentation, double quotes.
- Comments explain *why* (device quirks, protocol details), not what the code already says.
- User-facing messages say what happened and what to do next.

## Security

dlna-cast serves files on your local network and exposes a control API on loopback. If you find a way to read files that weren't cast, reach the control API from another origin, or make dlna-cast contact non-local hosts, please report it privately by email to karanksrk2000@outlook.com rather than in a public issue.
