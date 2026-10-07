# Radiolock

Web side of Radiolock, a fix for the Deadlock Radio mod after the City Never Sleeps update. Based on Deadlock Radio by BubbleGumXD.

## Why

Deadlock's in-game HTML panel now only loads URLs that start with `https://`. Anything else, including `javascript:` and `file:///`, is replaced with `about:blank`. The original mod depended on both.

Radiolock loads this site instead. The game sends commands by changing the URL fragment (`#s=<seq>&c=<commands>`) and the page replies through `document.title`.

## Contents

- `index.html`, `app.js`, `app.css`: the player page loaded by the mod.
- `probe/`: test page used to check what the in-game panel supports.

## Player sources

- YouTube through Radiolock Helper (ad-free audio, search, playlists, radio of similar songs).
- YouTube embed when the helper is not running (ads muted while they play).
- Local music folder through Radiolock Helper.

The helper listens on `127.0.0.1:47800` and only answers requests from this site.

## License

MIT
