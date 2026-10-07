# Radiolock

Web side of Radiolock, a fix for the Deadlock Radio mod after the City Never Sleeps update.

## Why

Deadlock's in-game HTML panel now only loads URLs that start with `https://`. Anything else, including `javascript:` and `file:///`, is replaced with `about:blank`. The original mod depended on both.

Radiolock loads a page from this site instead. The game sends commands by changing the URL fragment (`#...`) and the page replies through `document.title`.

## Contents

- `probe/` test page used to check what the in-game panel supports.

## License

MIT
